import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scramVerifier } from './sandbox-db-role';

interface Migration {
  version: string;
  source: string;
  checksum: string;
  transactional: boolean;
}

// Split only nontransactional files. SQL strings, identifiers, nested comments and
// dollar-quoted function bodies must remain intact; transactional files use one query.
export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote = '';
  let escapedString = false;
  let dollar = '';
  let commentDepth = 0;
  let lineComment = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (commentDepth) {
      if (char === '/' && next === '*') {
        commentDepth++;
        index++;
      } else if (char === '*' && next === '/') {
        commentDepth--;
        index++;
      }
      continue;
    }
    if (dollar) {
      if (source.startsWith(dollar, index)) {
        index += dollar.length - 1;
        dollar = '';
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) index++;
        else quote = '';
      } else if (char === '\\' && escapedString) {
        index++;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      commentDepth = 1;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      escapedString =
        char === "'" &&
        /[eE]/.test(source[index - 1] ?? '') &&
        !/[A-Za-z_0-9$]/.test(source[index - 2] ?? '');
      quote = char;
      continue;
    }
    if (char === '$' && !/[A-Za-z_0-9$\u0080-\uFFFF]/.test(source[index - 1] ?? '')) {
      const match = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*)?\$/.exec(
        source.slice(index),
      );
      if (match) {
        dollar = match[0];
        index += dollar.length - 1;
        continue;
      }
    }
    if (char === ';') {
      statements.push(source.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (quote || dollar || commentDepth) throw new Error('Unterminated migration SQL');
  if (source.slice(start).trim()) statements.push(source.slice(start));
  if (!statements.length) throw new Error('Empty migration');
  return statements;
}

export async function runMigrations({
  client,
  directory = 'apps/api/prisma/migrations',
}: {
  client: Client;
  directory?: string;
}): Promise<void> {
  const migrations: Migration[] = readdirSync(directory)
    .filter((folder) => /^\d{3}_[a-z0-9_]+$/.test(folder))
    .sort()
    .map((folder) => {
      const source = readFileSync(join(directory, folder, 'migration.sql'), 'utf8');
      return {
        version: folder.slice(0, 3),
        source,
        checksum: createHash('sha256').update(source).digest('hex'),
        transactional: !/^-- regi:transaction=false(?:\r?\n|$)/.test(source),
      };
    });
  if (!migrations.length || new Set(migrations.map((m) => m.version)).size !== migrations.length)
    throw new Error('Migration versions must be present and unique');
  await client.query("SELECT pg_advisory_lock(hashtext('regi-migrations'))");
  try {
    const { rows: applicationRoles } = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='regi_app'",
    );
    const applicationRole = applicationRoles[0];
    if (
      applicationRole &&
      (!applicationRole.rolcanlogin ||
        applicationRole.rolsuper ||
        applicationRole.rolbypassrls ||
        applicationRole.rolcreatedb ||
        applicationRole.rolcreaterole ||
        applicationRole.rolreplication)
    )
      throw new Error('REGI_APP_ROLE_UNSAFE');
    await client.query(
      'CREATE TABLE IF NOT EXISTS regi_migrations (version text PRIMARY KEY, checksum text)',
    );
    await client.query('ALTER TABLE regi_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const { rows } = await client.query<{ version: string; checksum: string | null }>(
      'SELECT version,checksum FROM regi_migrations',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    // Validate every previously applied file before running any pending migration.
    for (const row of rows) {
      const migration = migrations.find((item) => item.version === row.version);
      if (!migration) throw new Error('Applied migration file missing: ' + row.version);
      if (row.checksum && row.checksum !== migration.checksum)
        throw new Error('Migration checksum mismatch: ' + row.version);
    }
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        // One-time adoption of the original version-only ledger. Never overwrite a hash.
        if (applied.get(migration.version) === null)
          await client.query(
            'UPDATE regi_migrations SET checksum=$1 WHERE version=$2 AND checksum IS NULL',
            [migration.checksum, migration.version],
          );
        continue;
      }
      if (migration.transactional) await client.query('BEGIN');
      try {
        if (migration.transactional) {
          // No parameters: node-postgres uses simple query protocol, one whole-file query.
          await client.query(migration.source);
        } else {
          for (const statement of splitStatements(migration.source)) await client.query(statement);
        }
        await client.query('INSERT INTO regi_migrations (version,checksum) VALUES ($1,$2)', [
          migration.version,
          migration.checksum,
        ]);
        if (migration.transactional) await client.query('COMMIT');
      } catch (error) {
        if (migration.transactional) await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query('ALTER TABLE regi_migrations ALTER COLUMN checksum SET NOT NULL');
    const { rows: roles } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT FROM pg_roles WHERE rolname='regi_app') AS exists",
    );
    if (roles[0]?.exists) {
      await client.query('REVOKE ALL ON regi_migrations FROM regi_app');
      await client.query('GRANT SELECT ON regi_migrations TO regi_app');
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('regi-migrations'))");
  }
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const appUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
    if (appUrl) {
      if (decodeURIComponent(appUrl.username) !== 'regi_app')
        throw new Error('Application database role must be regi_app');
      const password = decodeURIComponent(appUrl.password);
      if (password)
        await client.query("SELECT set_config('regi.app_scram',$1,false)", [
          scramVerifier(password),
        ]);
    }
    await runMigrations({ client, directory: process.env.REGI_MIGRATIONS_DIR });
    console.log('Migrations verified and applied with SHA-256 checksums');
  } finally {
    await client.end();
  }
}

if (require.main === module)
  void main().catch(() => {
    console.error('Migration verification or application failed; no credentials logged');
    process.exitCode = 1;
  });
