import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Database, Actor, sql, rows } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';
const database = new Database(),
  tenant = randomUUID(),
  store = randomUUID(),
  staff = randomUUID(),
  product = randomUUID(),
  business = new Business(database),
  actor: Actor = { tenantId: tenant, staffId: staff, role: 'admin', stores: [store], mfa: true };
after(() => database.client.$disconnect());
test('real PostgreSQL forecast reads only complete days, persists seven days and rejects another store', async () => {
  const python = process.env.PYTHON_EXECUTABLE ?? '.context/venv311/bin/python';
  assert.ok(existsSync(python), 'READMEのPython依存導入を先に実行してください');
  await database.transaction(actor, async (transaction) => {
    await transaction.$executeRaw(
      sql`INSERT INTO tenants VALUES(${tenant}::uuid,'予測DB試験','inclusive',now()-interval '1 year',now()+interval '1 year',1)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'予測店')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${tenant},'予測管理者','admin',ARRAY[${store}::uuid],${pinHash('1234', tenant)},true)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'FORECAST','予測商品',true,10)`,
    );
    for (let index = 0; index < 70; index++) {
      const date = new Date(Date.now() - (70 - index) * 86400000).toISOString().slice(0, 10);
      await business.createDocument(
        transaction,
        actor,
        'day-close',
        'confirmed',
        { day: date },
        store,
      );
      await business.createDocument(
        transaction,
        actor,
        'sale',
        'confirmed',
        { businessDate: date, lines: [{ productId: product, quantity: 10 + index }] },
        store,
      );
    }
  });
  const output = JSON.parse(
    execFileSync(python, ['forecast/regi_forecast.py', '--tenant', tenant, '--store', store], {
      encoding: 'utf8',
    }),
  );
  assert.equal(output.complete_days, 70);
  assert.equal(output.products, 1);
  const forecasts = await database.transaction(actor, (transaction) =>
    rows(transaction, sql`SELECT * FROM forecasts WHERE store_id=${store}::uuid ORDER BY day`),
  );
  assert.equal(forecasts.length, 7);
  assert.ok(
    forecasts.every(
      (row) => row.quantity >= 0 && row.model_version && row.trained_from && row.trained_to,
    ),
  );
  assert.throws(
    () =>
      execFileSync(
        python,
        ['forecast/regi_forecast.py', '--tenant', tenant, '--store', randomUUID()],
        { stdio: 'pipe' },
      ),
    /failed/,
  );
});
