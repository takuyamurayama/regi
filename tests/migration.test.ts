import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import { runMigrations } from '../scripts/migrate';
import { scramVerifier } from '../scripts/sandbox-db-role';

function connection(database: string, application = false): string {
  const value = process.env[application ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL'];
  assert.ok(value, 'README local database setup is required');
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Migration tests are local only');
  url.pathname = '/' + database;
  url.searchParams.delete('connection_limit');
  url.searchParams.delete('pool_timeout');
  return url.toString();
}

function administratorConnection(database = 'postgres'): string {
  const fallback = new URL(connection('postgres'));
  fallback.username = 'postgres';
  fallback.password = '';
  const adminUrl = new URL(process.env.SANDBOX_TEST_ADMIN_DATABASE_URL ?? fallback.toString());
  assert.ok(['localhost', '127.0.0.1'].includes(adminUrl.hostname));
  adminUrl.pathname = '/' + database;
  return adminUrl.toString();
}

async function temporaryDatabase(
  callback: (owner: Client, database: string, admin: Client) => Promise<void>,
): Promise<void> {
  const admin = new Client({ connectionString: administratorConnection() });
  const database = 'regi_migration_' + randomUUID().replaceAll('-', '');
  const owner = new Client({ connectionString: connection(database) });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" OWNER regi_owner`);
    await owner.connect();
    try {
      await callback(owner, database, admin);
    } finally {
      await owner.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
}

function migrationDirectory(files: Record<string, string>): string {
  mkdirSync('.context', { recursive: true });
  const directory = mkdtempSync(resolve('.context/migration-fixture-'));
  for (const [folder, sql] of Object.entries(files)) {
    mkdirSync(resolve(directory, folder));
    writeFileSync(resolve(directory, folder, 'migration.sql'), sql);
  }
  return directory;
}

void test('migration runner preserves tagged dollar quotes and semicolons in complete SQL files', async () => {
  await temporaryDatabase(async (client) => {
    const directory = migrationDirectory({
      '001_complete': `CREATE TABLE runner_facts (value text NOT NULL);
CREATE FUNCTION runner_value() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM length('inside;quoted'); -- another ; is not a statement
  RETURN 'a;b';
END;
$body$;
INSERT INTO runner_facts VALUES (runner_value()), ('tail;value');
/* final ; comment */`,
    });
    await runMigrations({ client, directory });
    const result = await client.query<{ value: string }>(
      'SELECT value FROM runner_facts ORDER BY value',
    );
    assert.deepEqual(
      result.rows.map((row) => row.value),
      ['a;b', 'tail;value'],
    );
  });
});

void test('migration failure rolls back all statements and does not record an applied version', async () => {
  await temporaryDatabase(async (client) => {
    const directory = migrationDirectory({
      '001_atomic': 'CREATE TABLE rolled_back(id integer); INSERT INTO missing_table VALUES (1);',
    });
    await assert.rejects(() => runMigrations({ client, directory }));
    const tables = await client.query<{ name: string | null }>(
      "SELECT to_regclass('public.rolled_back')::text AS name",
    );
    assert.equal(tables.rows[0].name, null);
    const versions = await client.query<{ count: string }>('SELECT count(*) FROM regi_migrations');
    assert.equal(versions.rows[0].count, '0');
  });
});

void test('migration SHA-256 is exact, rerun is idempotent and tampered files refuse startup', async () => {
  await temporaryDatabase(async (client) => {
    const contents =
      'CREATE TABLE checksum_facts(id integer PRIMARY KEY); INSERT INTO checksum_facts VALUES (1);\n';
    const directory = migrationDirectory({ '001_checksum': contents });
    await runMigrations({ client, directory });
    await runMigrations({ client, directory });
    const versions = await client.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM regi_migrations',
    );
    assert.equal(versions.rows.length, 1);
    assert.equal(versions.rows[0].version, '001');
    assert.equal(versions.rows[0].checksum, createHash('sha256').update(contents).digest('hex'));
    writeFileSync(
      resolve(directory, '001_checksum/migration.sql'),
      contents + 'INSERT INTO checksum_facts VALUES (2);\n',
    );
    await assert.rejects(() => runMigrations({ client, directory }), /checksum|modified|tamper/i);
    const facts = await client.query<{ id: number }>('SELECT id FROM checksum_facts');
    assert.deepEqual(facts.rows, [{ id: 1 }]);
  });
});

void test('nontransaction header permits concurrent indexes while keeping quoted statements intact', async () => {
  await temporaryDatabase(async (client) => {
    const directory = migrationDirectory({
      '001_base': 'CREATE TABLE concurrent_facts(id integer PRIMARY KEY,value text);',
      '002_index': String.raw`-- regi:transaction=false
/* comment containing ; and a nested /* ; */ comment */
CREATE FUNCTION concurrent_value() RETURNS text LANGUAGE sql AS $quoted$ SELECT 'x;y' $quoted$;
CREATE FUNCTION unicode_value() RETURNS text LANGUAGE plpgsql AS $日本語$
BEGIN
  RETURN 'unicode;value';
END;
$日本語$;
CREATE INDEX CONCURRENTLY runner_concurrent_index ON concurrent_facts(value);
INSERT INTO concurrent_facts VALUES (1, concurrent_value()), (2, E'quote\';semicolon'), (3, 'double''quote;semicolon'), (4, unicode_value());
CREATE TABLE "quoted;table"("quoted;column" text);
INSERT INTO "quoted;table" VALUES ('identifier;value');
CREATE TABLE dollars$in$name(id integer);`,
    });
    await runMigrations({ client, directory });
    const indexes = await client.query<{ indisvalid: boolean }>(
      "SELECT indisvalid FROM pg_index WHERE indexrelid='runner_concurrent_index'::regclass",
    );
    assert.equal(indexes.rows[0].indisvalid, true);
    const facts = await client.query<{ value: string }>(
      'SELECT value FROM concurrent_facts ORDER BY id',
    );
    assert.deepEqual(facts.rows, [
      { value: 'x;y' },
      { value: "quote';semicolon" },
      { value: "double'quote;semicolon" },
      { value: 'unicode;value' },
    ]);
    const identifiers = await client.query<{ value: string }>(
      'SELECT "quoted;column" AS value FROM "quoted;table"',
    );
    assert.deepEqual(identifiers.rows, [{ value: 'identifier;value' }]);
    await client.query('INSERT INTO dollars$in$name VALUES (7)');
    const dollarNames = await client.query<{ id: number }>('SELECT id FROM dollars$in$name');
    assert.deepEqual(dollarNames.rows, [{ id: 7 }]);
    const versions = await client.query<{ count: string }>('SELECT count(*) FROM regi_migrations');
    assert.equal(versions.rows[0].count, '2');
  });
});

void test('empty database applies 000 through 007 with matching checksums and safe SCRAM app role', async () => {
  await temporaryDatabase(async (client, _database, admin) => {
    await runMigrations({ client });
    const versions = await client.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM regi_migrations ORDER BY version',
    );
    assert.deepEqual(
      versions.rows.map((row) => row.version),
      ['000', '001', '002', '003', '004', '005', '006', '007'],
    );
    const directory = resolve('apps/api/prisma/migrations');
    for (const row of versions.rows) {
      const folder = readdirSync(directory).find((name) => name.startsWith(row.version + '_'));
      assert.ok(folder);
      const expected = createHash('sha256')
        .update(readFileSync(resolve(directory, folder, 'migration.sql')))
        .digest('hex');
      assert.equal(row.checksum, expected);
    }
    const roles = await admin.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolpassword: string;
    }>(
      "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolpassword FROM pg_authid WHERE rolname='regi_app'",
    );
    assert.equal(roles.rows.length, 1);
    const role = roles.rows[0];
    assert.equal(
      role.rolsuper ||
        role.rolbypassrls ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication,
      false,
    );
    assert.match(role.rolpassword, /^SCRAM-SHA-256\$/);
  });
});

void test('migration 007 permits waiting and dismissed, retains quarantine RLS and active subject uniqueness', async () => {
  await temporaryDatabase(async (owner, database) => {
    await runMigrations({ client: owner });
    const app = new Client({ connectionString: connection(database, true) });
    await app.connect();
    const tenant = randomUUID(),
      otherTenant = randomUUID(),
      store = randomUUID(),
      staff = randomUUID(),
      device = randomUUID();
    try {
      await app.query(
        "SELECT set_config('regi.tenant',$1,false),set_config('regi.stores',$2,false),set_config('regi.all_stores','true',false)",
        [tenant, store],
      );
      await app.query(
        "INSERT INTO tenants(id,name,price_mode,starts_at,ends_at) VALUES($1,'migration fixture','inclusive',now(),now()+interval '1 year')",
        [tenant],
      );
      await app.query("INSERT INTO stores VALUES($1,$2,'migration store')", [store, tenant]);
      const insertStaff =
        "INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash,active) VALUES($1,$2,$3,'staff','admin',ARRAY[$4::uuid],'fixture',$5)";
      await app.query(insertStaff, [staff, tenant, 'subject-reuse', store, true]);
      await app.query(insertStaff, [randomUUID(), tenant, 'subject-reuse', store, false]);
      await assert.rejects(
        () => app.query(insertStaff, [randomUUID(), tenant, 'subject-reuse', store, true]),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '23505',
      );
      await app.query('UPDATE staff SET active=false WHERE id=$1', [staff]);
      await app.query(insertStaff, [randomUUID(), tenant, 'subject-reuse', store, true]);
      await app.query(
        "INSERT INTO devices(id,tenant_id,store_id,name) VALUES($1,$2,$3,'migration device')",
        [device, tenant, store],
      );
      const eventSql =
        "INSERT INTO device_events(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES($1,$2,$3,$4,$5,'hash',$6,'{}','{}')";
      await app.query(eventSql, [tenant, randomUUID(), store, device, 1, 'waiting']);
      const dismissed = randomUUID();
      await app.query(
        "INSERT INTO device_events(tenant_id,id,store_id,device_id,sequence,hash,status,result,body,dismissed_by,dismiss_reason) VALUES($1,$2,$3,$4,2,'hash','dismissed','{}','{}',$5,'original paper reviewed')",
        [tenant, dismissed, store, device, staff],
      );
      await assert.rejects(
        () => app.query(eventSql, [tenant, randomUUID(), store, device, 3, 'dismissed']),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '23514',
      );
      await assert.rejects(
        () => app.query(eventSql, [tenant, randomUUID(), store, device, 3, 'unknown']),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '23514',
      );
      const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='device_event_quarantine'::regclass",
      );
      assert.deepEqual(rls.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
      // Quarantine must keep the same source fields so an event with a colliding sequence remains recoverable.
      await app.query(
        "INSERT INTO device_event_quarantine(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES($1,$2,$3,$4,1,'hash','waiting','{}','{}')",
        [tenant, randomUUID(), store, device],
      );
      const visible = await app.query<{ count: string }>(
        'SELECT count(*) FROM device_event_quarantine',
      );
      assert.equal(visible.rows[0].count, '1');
      await app.query(
        "SELECT set_config('regi.all_stores','false',false),set_config('regi.stores',$1,false)",
        [randomUUID()],
      );
      const outsideStore = await app.query<{ count: string }>(
        'SELECT count(*) FROM device_event_quarantine',
      );
      assert.equal(outsideStore.rows[0].count, '0');
      await app.query("SELECT set_config('regi.stores',$1,false)", [store]);
      await app.query("SELECT set_config('regi.tenant',$1,false)", [otherTenant]);
      const hidden = await app.query<{ count: string }>(
        'SELECT count(*) FROM device_event_quarantine',
      );
      assert.equal(hidden.rows[0].count, '0');
      await assert.rejects(
        () =>
          app.query(
            "INSERT INTO device_event_quarantine(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES($1,$2,$3,$4,2,'hash','waiting','{}','{}')",
            [tenant, randomUUID(), store, device],
          ),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      );
      await assert.rejects(
        () => app.query('DELETE FROM regi_migrations'),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      );
    } finally {
      await app.end();
    }
  });
});

void test('legacy version-only migration metadata adopts approved checksums without replaying facts', async () => {
  await temporaryDatabase(async (client) => {
    const contents =
      'CREATE TABLE adopted_facts(id integer PRIMARY KEY); INSERT INTO adopted_facts VALUES (41);\n';
    const directory = migrationDirectory({ '001_adopted': contents });
    await client.query(contents);
    await client.query(
      "CREATE TABLE regi_migrations(version text PRIMARY KEY); INSERT INTO regi_migrations VALUES ('001');",
    );
    await runMigrations({ client, directory });
    await runMigrations({ client, directory });
    const versions = await client.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM regi_migrations',
    );
    assert.deepEqual(versions.rows, [
      { version: '001', checksum: createHash('sha256').update(contents).digest('hex') },
    ]);
    const facts = await client.query<{ id: number }>('SELECT id FROM adopted_facts');
    assert.deepEqual(facts.rows, [{ id: 41 }]);
  });
});

void test('000 role bootstrap requires a verifier, creates safe SCRAM login and rejects an unsafe existing role', async () => {
  await temporaryDatabase(async (_owner, database, admin) => {
    // Roles are cluster-wide: use a generated role name and leave regi_app untouched.
    const role = 'regi_migration_role_' + randomUUID().replaceAll('-', '');
    const sql = readFileSync(
      'apps/api/prisma/migrations/000_roles/migration.sql',
      'utf8',
    ).replaceAll('regi_app', role);
    const directory = migrationDirectory({ '000_roles': sql });
    const bootstrap = new Client({ connectionString: administratorConnection(database) });
    await bootstrap.connect();
    try {
      await assert.rejects(
        () => runMigrations({ client: bootstrap, directory }),
        /PASSWORD_REQUIRED/,
      );
      const password = randomUUID() + randomUUID();
      await bootstrap.query("SELECT set_config('regi.app_scram',$1,false)", [
        scramVerifier(password),
      ]);
      await runMigrations({ client: bootstrap, directory });
      const roles = await admin.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolpassword: string;
      }>(
        'SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolpassword FROM pg_authid WHERE rolname=$1',
        [role],
      );
      assert.equal(roles.rows[0].rolcanlogin, true);
      assert.equal(
        roles.rows[0].rolsuper ||
          roles.rows[0].rolbypassrls ||
          roles.rows[0].rolcreatedb ||
          roles.rows[0].rolcreaterole ||
          roles.rows[0].rolreplication,
        false,
      );
      assert.match(roles.rows[0].rolpassword, /^SCRAM-SHA-256\$/);
      assert.ok(!roles.rows[0].rolpassword.includes(password));
      await admin.query(`ALTER ROLE "${role}" CREATEDB`);
      await bootstrap.query('DROP TABLE regi_migrations');
      await assert.rejects(() => runMigrations({ client: bootstrap, directory }), /ROLE_UNSAFE/);
    } finally {
      await bootstrap.end();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
});
