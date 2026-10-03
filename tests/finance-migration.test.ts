import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { runMigrations } from '../scripts/migrate';

const d0Checksums = [
  'e47d9d650db6008cc9bd8a2885df131184bdce8fe707dddd4af37699cd184770',
  '4eeca4e176f81ccabff810513fad47d195a45867147bebf7d5bce246f8dd87d3',
  '86a2651fb5c2cdd72dce2d1d1ea2c9234adf040d5a73a8855156d8dc9b01d247',
  'f0098ccb7f9dd67ef5caf79ff98a867b9daccb3a09e4c562aa0725fe6df70e09',
  '90016eeeb5dcd928187064f322b593866b82f0b01859dc68b7837637dc99cca2',
  'a82376385dddd1afde46a54eec2af3d29b2a3eacfd75cc035d4c7592f30d508c',
  '47209ed32f4310e5f8a5488f6f53bd191b2dc77ea4759bbebc011a1f8ae2bb01',
  '9a0c3e0e1f602974853a34b5fa38cfc76a418dbc0039adaabc827ca8c5467800',
];
function connection(database: string, app = false) {
  const configured = process.env[app ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL'];
  assert.ok(configured);
  const url = new URL(configured);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(url.hostname),
    'Local isolated migration tests only',
  );
  url.pathname = '/' + database;
  url.searchParams.delete('connection_limit');
  url.searchParams.delete('pool_timeout');
  return url.toString();
}
function directory(last = '008') {
  const result = mkdtempSync(resolve('.context/finance-migrations-'));
  const original = resolve('apps/api/prisma/migrations');
  for (const name of readdirSync(original).filter(
    (name) => /^\d{3}_/.test(name) && name.slice(0, 3) <= last,
  )) {
    mkdirSync(resolve(result, name));
    writeFileSync(
      resolve(result, name, 'migration.sql'),
      readFileSync(resolve(original, name, 'migration.sql')),
    );
  }
  return result;
}
async function isolated(callback: (owner: Client, app: Client) => Promise<void>) {
  const database = 'regi_finance_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(connection('postgres'));
  adminUrl.username = 'postgres';
  adminUrl.password = '';
  const admin = new Client({
    connectionString: process.env.SANDBOX_TEST_ADMIN_DATABASE_URL ?? adminUrl.toString(),
  });
  const owner = new Client({ connectionString: connection(database) });
  const app = new Client({ connectionString: connection(database, true) });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '" OWNER regi_owner');
    await owner.connect();
    await app.connect();
    await callback(owner, app);
  } finally {
    await app.end();
    await owner.end();
    await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
    await admin.end();
  }
}
async function scope(client: Client, tenant: string, store: string, role = 'admin', all = true) {
  await client.query(
    "SELECT set_config('regi.tenant',$1,false),set_config('regi.stores',$2,false),set_config('regi.role',$3,false),set_config('regi.all_stores',$4,false)",
    [tenant, store, role, String(all)],
  );
}
async function seed(app: Client) {
  const tenant = randomUUID(),
    store = randomUUID(),
    staff = randomUUID(),
    supplier = randomUUID(),
    invoice = randomUUID();
  await scope(app, tenant, store);
  await app.query(
    "INSERT INTO tenants(id,name,price_mode,starts_at,ends_at) VALUES($1,'isolated finance fixture','inclusive',now()-interval '1 day',now()+interval '1 year')",
    [tenant],
  );
  await app.query("INSERT INTO stores VALUES($1,$2,'isolated store')", [store, tenant]);
  await app.query(
    "INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash) VALUES($1,$2,$1::uuid::text,'isolated staff','admin',ARRAY[$3::uuid],'fixture')",
    [staff, tenant, store],
  );
  await app.query(
    "INSERT INTO purchase_suppliers(id,tenant_id,code,body,active) VALUES($1,$2,'ISOLATED','{}',true)",
    [supplier, tenant],
  );
  await app.query(
    "INSERT INTO purchase_invoices(id,tenant_id,store_id,supplier_id,state,draft,supplier_snapshot,internal_reference) VALUES($1,$2,$3,$4,'draft','{}','{}',$1::uuid::text)",
    [invoice, tenant, store, supplier],
  );
  return { tenant, store, staff, supplier, invoice };
}
const sqlCode = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

void test('finance empty database applies 000 through 008 once while every D0 migration byte checksum remains frozen', async () => {
  await isolated(async (owner) => {
    const files = directory();
    await runMigrations({ client: owner, directory: files });
    await runMigrations({ client: owner, directory: files });
    const versions = await owner.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM regi_migrations ORDER BY version',
    );
    assert.deepEqual(
      versions.rows.map((row) => row.version),
      ['000', '001', '002', '003', '004', '005', '006', '007', '008'],
    );
    assert.deepEqual(
      versions.rows.slice(0, 8).map((row) => row.checksum),
      d0Checksums,
    );
    const source = readFileSync(resolve(files, '008_purchase_finance/migration.sql'));
    assert.equal(versions.rows[8].checksum, createHash('sha256').update(source).digest('hex'));
    const rows = await owner.query<{ count: number; enabled: boolean; forced: boolean }>(
      "SELECT count(*)::int AS count,bool_and(relrowsecurity) AS enabled,bool_and(relforcerowsecurity) AS forced FROM pg_class WHERE relkind='r' AND relname LIKE 'purchase_%'",
    );
    assert.deepEqual(rows.rows, [{ count: 13, enabled: true, forced: true }]);
  });
});
void test('finance 007 upgrade preserves confirmed sale bytes and inventory while app role cannot mutate migration metadata', async () => {
  await isolated(async (owner, app) => {
    await runMigrations({ client: owner, directory: directory('007') });
    const tenant = randomUUID(),
      store = randomUUID(),
      staff = randomUUID(),
      sale = randomUUID(),
      product = randomUUID();
    await scope(app, tenant, store);
    await app.query(
      "INSERT INTO tenants(id,name,price_mode,starts_at,ends_at) VALUES($1,'upgrade fixture','inclusive',now()-interval '1 day',now()+interval '1 year')",
      [tenant],
    );
    await app.query("INSERT INTO stores VALUES($1,$2,'upgrade store')", [store, tenant]);
    await app.query(
      "INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash) VALUES($1,$2,$1::uuid::text,'staff','admin',ARRAY[$3::uuid],'fixture')",
      [staff, tenant, store],
    );
    await app.query(
      "INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES($1,$2,'UPGRADE','original product',true,50)",
      [product, tenant],
    );
    const body = {
      total: '101',
      receipt: { sellerName: 'immutable original', registered: false },
      lines: [{ rateBps: 1000, paid: '101' }],
    };
    await app.query(
      "INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id) VALUES($1,$2,$3,'sale','confirmed',$4,$5)",
      [sale, tenant, store, JSON.stringify(body), staff],
    );
    await app.query(
      "INSERT INTO inventory(id,tenant_id,store_id,product_id,quantity,source_id,source_line,reason) VALUES($1,$2,$3,$4,-1,$5,'0','sale')",
      [randomUUID(), tenant, store, product, sale],
    );
    const inventory = (
      await app.query<{ quantity: number; source_id: string }>(
        'SELECT quantity,source_id FROM inventory',
      )
    ).rows;
    const before = await app.query<{ bytes: string }>(
      'SELECT body::text AS bytes FROM documents WHERE id=$1',
      [sale],
    );
    await runMigrations({ client: owner, directory: directory() });
    assert.deepEqual(
      (
        await app.query<{ bytes: string }>(
          'SELECT body::text AS bytes FROM documents WHERE id=$1',
          [sale],
        )
      ).rows,
      before.rows,
    );
    assert.deepEqual(
      (
        await app.query<{ quantity: number; source_id: string }>(
          'SELECT quantity,source_id FROM inventory',
        )
      ).rows,
      inventory,
    );
    await assert.rejects(
      () => app.query("UPDATE documents SET body='{}' WHERE id=$1", [sale]),
      /immutable/,
    );
    await assert.rejects(() => app.query('DELETE FROM regi_migrations'), sqlCode('42501'));
    assert.equal(
      (await app.query<{ count: number }>('SELECT count(*)::int AS count FROM regi_migrations'))
        .rows[0].count,
      9,
    );
  });
});
void test('finance FORCE RLS denies cashier and unclassified sessions then isolates manager tenant and store', async () => {
  await isolated(async (owner, app) => {
    await runMigrations({ client: owner, directory: directory() });
    const data = await seed(app);
    for (const role of ['cashier', '', 'unrecognized']) {
      await scope(app, data.tenant, data.store, role);
      assert.equal(
        (await app.query<{ count: number }>('SELECT count(*)::int AS count FROM purchase_invoices'))
          .rows[0].count,
        0,
      );
      assert.equal(
        (
          await app.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM purchase_suppliers',
          )
        ).rows[0].count,
        0,
      );
      await assert.rejects(
        () =>
          app.query(
            "INSERT INTO purchase_suppliers(id,tenant_id,code,body,active) VALUES($1,$2,$1::uuid::text,'{}',true)",
            [randomUUID(), data.tenant],
          ),
        sqlCode('42501'),
      );
    }
    await scope(app, data.tenant, data.store, 'manager', false);
    assert.equal(
      (await app.query<{ count: number }>('SELECT count(*)::int AS count FROM purchase_invoices'))
        .rows[0].count,
      1,
    );
    await scope(app, data.tenant, randomUUID(), 'manager', false);
    assert.equal(
      (await app.query<{ count: number }>('SELECT count(*)::int AS count FROM purchase_invoices'))
        .rows[0].count,
      0,
    );
    await scope(app, randomUUID(), data.store, 'headquarters');
    assert.equal(
      (await app.query<{ count: number }>('SELECT count(*)::int AS count FROM purchase_suppliers'))
        .rows[0].count,
      0,
    );
  });
});
void test('finance posted sources ledger signs reversals and tenant-store foreign keys reject direct corruption', async () => {
  await isolated(async (owner, app) => {
    await runMigrations({ client: owner, directory: directory() });
    const data = await seed(app);
    const sha = 'a'.repeat(64);
    await app.query(
      "UPDATE purchase_invoices SET state='posted',version=2,posted_snapshot_sha256=$2,posted_snapshot_version=2 WHERE id=$1",
      [data.invoice, sha],
    );
    const debit = randomUUID();
    await app.query(
      "INSERT INTO purchase_ledger(id,tenant_id,store_id,invoice_id,kind,amount,fact_id,occurred_at,actor_id) VALUES($1,$2,$3,$4,'invoice-debit',108,$4,now(),$5)",
      [debit, data.tenant, data.store, data.invoice, data.staff],
    );
    assert.equal(
      (
        await app.query<{ signed: string }>(
          'SELECT signed_amount::text AS signed FROM purchase_ledger',
        )
      ).rows[0].signed,
      '108',
    );
    await assert.rejects(() => app.query('UPDATE purchase_ledger SET amount=0'), sqlCode('42501'));
    await assert.rejects(() => app.query('DELETE FROM purchase_ledger'), sqlCode('42501'));
    await scope(owner, data.tenant, data.store);
    await assert.rejects(() => owner.query('UPDATE purchase_ledger SET amount=0'), /immutable/);
    await assert.rejects(
      () =>
        owner.query(
          "UPDATE purchase_invoices SET draft='{}'::jsonb || '{\"changed\":true}',version=version+1 WHERE id=$1",
          [data.invoice],
        ),
      /immutable posted/,
    );
    await assert.rejects(
      () =>
        app.query(
          "INSERT INTO purchase_ledger(id,tenant_id,store_id,invoice_id,kind,amount,fact_id,occurred_at,actor_id) VALUES($1,$2,$3,$4,'payment-reversal',1,$1,now(),$5)",
          [randomUUID(), data.tenant, data.store, data.invoice, data.staff],
        ),
      sqlCode('23514'),
    );
    await assert.rejects(
      () =>
        app.query(
          "INSERT INTO purchase_invoices(id,tenant_id,store_id,supplier_id,state,draft,supplier_snapshot,internal_reference) VALUES($1,$2,$3,$4,'draft','{}','{}',$1::uuid::text)",
          [randomUUID(), data.tenant, randomUUID(), data.supplier],
        ),
      sqlCode('23503'),
    );
  });
});
