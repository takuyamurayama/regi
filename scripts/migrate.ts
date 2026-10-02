import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
async function main() {
  const client = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  try {
    await client.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS regi_migrations (version text PRIMARY KEY)',
    );
    for (const [version, folder] of [
      ['001', '001_init'],
      ['002', '002_leases'],
      ['003', '003_transfer_changes'],
      ['004', '004_money_snapshots'],
      ['005', '005_snapshot_backfill'],
      ['006', '006_receipt_profile'],
    ]) {
      const sql = readFileSync(`apps/api/prisma/migrations/${folder}/migration.sql`, 'utf8');
      const prior = await client.$queryRawUnsafe<any[]>(
        'SELECT version FROM regi_migrations WHERE version=$1',
        version,
      );
      if (!prior.length)
        await client.$transaction(async (transaction) => {
          const statements = sql.match(/(?:[^;$]|\$(?!\$))+?(?:\$\$[\s\S]*?\$\$(?:[^;]*))?;/g);
          if (!statements) throw new Error('Empty migration');
          for (const statement of statements) await transaction.$executeRawUnsafe(statement);
          await transaction.$executeRawUnsafe('INSERT INTO regi_migrations VALUES ($1)', version);
        });
      console.log(`Migration ${version} applied`);
    }
  } finally {
    await client.$disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
