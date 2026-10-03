import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Database } from '../apps/api/src/db';
import { seedSandbox } from './sandbox-seed';
import { businessDate } from '../packages/core/src';
async function main() {
  if (
    process.env.NODE_ENV !== 'test' ||
    !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
  )
    throw new Error('Web sandbox fixture is local test only');
  const tenantId = randomUUID(),
    adminSubject = randomUUID(),
    database = new Database();
  try {
    const result = await seedSandbox(database, {
      tenantId,
      confirmTenant: tenantId,
      adminSubject,
      adminPin: String(randomInt(200000, 999999)),
      endDay: businessDate(new Date(Date.now() - 86400000).toISOString()),
      optIn: 'synthetic-only',
    });
    for (const storeId of result.storeIds)
      execFileSync(
        process.env.PYTHON_EXECUTABLE ?? '.context/venv311/bin/python',
        ['forecast/regi_forecast.py', '--tenant', tenantId, '--store', storeId],
        { stdio: 'pipe' },
      );
    console.log(JSON.stringify({ ...result, adminSubject }));
  } finally {
    await database.client.$disconnect();
  }
}
main().catch(() => {
  console.error('Local synthetic web fixture failed; no credentials logged');
  process.exitCode = 1;
});
