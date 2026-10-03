import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { runMigrations } from '../scripts/migrate';
import { retireTenant } from '../scripts/retention';

void test('isolated real PostgreSQL retirement deletes every finance child and inverse fact then restores FORCE RLS and immutable triggers', async () => {
  const database = 'regi_finance_retention_' + randomUUID().replaceAll('-', '');
  const configured = process.env.MIGRATION_DATABASE_URL;
  assert.ok(configured);
  const ownerUrl = new URL(configured);
  assert.ok(['localhost', '127.0.0.1'].includes(ownerUrl.hostname));
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.username = 'postgres';
  adminUrl.password = '';
  ownerUrl.pathname = '/' + database;
  ownerUrl.searchParams.delete('connection_limit');
  ownerUrl.searchParams.delete('pool_timeout');
  const admin = new Client({
      connectionString: process.env.SANDBOX_TEST_ADMIN_DATABASE_URL ?? adminUrl.toString(),
    }),
    owner = new Client({ connectionString: ownerUrl.toString() });
  const prisma = new PrismaClient({ datasourceUrl: ownerUrl.toString() });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '" OWNER regi_owner');
    await owner.connect();
    await runMigrations({ client: owner });
    const tenant = randomUUID(),
      store = randomUUID(),
      staff = randomUUID(),
      supplier = randomUUID(),
      invoice = randomUUID(),
      product = randomUUID(),
      order = randomUUID(),
      receipt = randomUUID(),
      evidence = randomUUID(),
      debit = randomUUID(),
      payment = randomUUID(),
      paymentLedger = randomUUID(),
      inverseLedger = randomUUID(),
      returned = randomUUID(),
      returnInverse = randomUUID();
    await owner.query(
      "SELECT set_config('regi.tenant',$1,false),set_config('regi.stores',$2,false),set_config('regi.all_stores','true',false),set_config('regi.role','admin',false)",
      [tenant, store],
    );
    await owner.query(
      "INSERT INTO tenants(id,name,price_mode,starts_at,ends_at) VALUES($1,'isolated retirement fixture','inclusive',now()-interval '2 years',now()-interval '91 days')",
      [tenant],
    );
    await owner.query("INSERT INTO stores VALUES($1,$2,'isolated expired store')", [store, tenant]);
    await owner.query(
      "INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash) VALUES($1,$2,$1::uuid::text,'expired fixture','admin',ARRAY[$3::uuid],'fixture')",
      [staff, tenant, store],
    );
    await owner.query(
      "INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES($1,$2,'EXPIRED','expired fixture',true,50)",
      [product, tenant],
    );
    for (const [id, kind] of [
      [order, 'purchase-order'],
      [receipt, 'receipt'],
    ])
      await owner.query(
        "INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id) VALUES($1,$2,$3,$4,'confirmed','{}',$5)",
        [id, tenant, store, kind, staff],
      );
    await owner.query(
      "INSERT INTO purchase_suppliers(id,tenant_id,code,body,active) VALUES($1,$2,'EXPIRED','{}',false)",
      [supplier, tenant],
    );
    await owner.query(
      "INSERT INTO purchase_invoices(id,tenant_id,store_id,supplier_id,state,draft,supplier_snapshot,internal_reference) VALUES($1,$2,$3,$4,'draft','{}','{}',$1::uuid::text)",
      [invoice, tenant, store, supplier],
    );
    await owner.query(
      "INSERT INTO purchase_supplier_links(id,tenant_id,store_id,order_id,supplier_id,body,actor_id) VALUES($1,$2,$3,$4,$5,'{}',$6)",
      [randomUUID(), tenant, store, order, supplier, staff],
    );
    await owner.query(
      "INSERT INTO purchase_invoice_identity(tenant_id,store_id,supplier_id,identity_key,revision,invoice_id) VALUES($1,$2,$3,'fixture',1,$4)",
      [tenant, store, supplier, invoice],
    );
    await owner.query(
      "INSERT INTO purchase_invoice_snapshots(invoice_id,tenant_id,store_id,version,sha256,content,preview,supplier_snapshot,effective_at,actor_id) VALUES($1,$2,$3,2,$4,'{}','{}','{}',now()-interval '1 year',$5)",
      [invoice, tenant, store, 'a'.repeat(64), staff],
    );
    await owner.query(
      'INSERT INTO purchase_invoice_allocations(id,tenant_id,store_id,invoice_id,invoice_line_no,receipt_id,receipt_line_index,quantity) VALUES($1,$2,$3,$4,1,$5,0,1)',
      [randomUUID(), tenant, store, invoice, receipt],
    );
    for (const [id, kind, factId, inverse] of [
      [debit, 'invoice-debit', invoice, null],
      [paymentLedger, 'payment', payment, null],
      [inverseLedger, 'payment-reversal', randomUUID(), paymentLedger],
    ])
      await owner.query(
        "INSERT INTO purchase_ledger(id,tenant_id,store_id,invoice_id,kind,amount,fact_id,reversal_of,occurred_at,actor_id) VALUES($1,$2,$3,$4,$5,108,$6,$7,now()-interval '1 year',$8)",
        [id, tenant, store, invoice, kind, factId, inverse, staff],
      );
    await owner.query(
      "INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,occurred_at,actor_id) VALUES($1,$2,$3,$4,$5,'payment',108,'{}',$6,now()-interval '1 year',$7)",
      [payment, tenant, store, invoice, supplier, paymentLedger, staff],
    );
    await owner.query(
      "INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,reversal_of,occurred_at,actor_id) VALUES($1,$2,$3,$4,$5,'payment',108,'{}',$6,$7,now()-interval '1 year',$8)",
      [randomUUID(), tenant, store, invoice, supplier, inverseLedger, payment, staff],
    );
    for (const [id, inverse] of [
      [returned, null],
      [returnInverse, returned],
    ]) {
      await owner.query(
        "INSERT INTO purchase_returns(id,tenant_id,store_id,invoice_id,supplier_id,body,reversal_of,occurred_at,actor_id,reason) VALUES($1,$2,$3,$4,$5,'{}',$6,now()-interval '1 year',$7,'synthetic expired fixture')",
        [id, tenant, store, invoice, supplier, inverse, staff],
      );
      await owner.query(
        'INSERT INTO purchase_return_lines(return_id,tenant_id,store_id,line_no,receipt_id,receipt_line_index,product_id,quantity) VALUES($1,$2,$3,1,$4,0,$5,1)',
        [id, tenant, store, receipt, product],
      );
    }
    await owner.query(
      "INSERT INTO purchase_evidence(id,tenant_id,store_id,invoice_id,object_key,bytes,sha256,body,actor_id) VALUES($1,$2,$3,$4,$5,10,$6,'{}',$7)",
      [
        evidence,
        tenant,
        store,
        invoice,
        tenant + '/finance/evidence/' + evidence,
        'b'.repeat(64),
        staff,
      ],
    );
    await owner.query(
      "INSERT INTO purchase_supplier_confirmations(id,tenant_id,store_id,invoice_id,snapshot_sha256,evidence_id,body,actor_id) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)",
      [randomUUID(), tenant, store, invoice, 'a'.repeat(64), evidence, staff],
    );
    await owner.query(
      "INSERT INTO purchase_export_snapshots(id,tenant_id,store_id,format,status,source,source_sha256,as_of,observed_at,body,actor_id) VALUES($1,$2,$3,'purchase-finance-bundle','queued','{}',$4,now(),now(),'{}',$5)",
      [randomUUID(), tenant, store, 'c'.repeat(64), staff],
    );
    const dry = await retireTenant(prisma, tenant);
    assert.equal(dry.mode, 'dry-run');
    for (const [name, count] of Object.entries(dry.counts).filter(([name]) =>
      name.startsWith('purchase_'),
    ))
      assert.ok(count > 0, name);
    assert.equal(dry.counts.purchase_ledger, 3);
    assert.equal(dry.counts.purchase_finance_facts, 2);
    assert.equal(dry.counts.purchase_returns, 2);
    const retired = await retireTenant(prisma, tenant, true);
    assert.equal(retired.mode, 'deleted');
    assert.equal(retired.backupExpiresAfterDays, 70);
    assert.equal(retired.backupExpiryIsEstimate, true);
    assert.equal(retired.backupReplicationCanExtend, true);
    const remaining = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tenants WHERE id=$1',
      [tenant],
    );
    assert.equal(remaining.rows[0].count, 0);
    const security = await owner.query<{ count: number; forced: boolean }>(
      "SELECT count(*)::int AS count,bool_and(relforcerowsecurity) AS forced FROM pg_class WHERE relname LIKE 'purchase_%' AND relkind='r'",
    );
    assert.deepEqual(security.rows, [{ count: 13, forced: true }]);
    const triggers = await owner.query<{ count: number; enabled: boolean }>(
      "SELECT count(*)::int AS count,bool_and(tgenabled='O') AS enabled FROM pg_trigger WHERE tgname IN ('purchase_fact_immutable','purchase_invoice_guard','purchase_export_guard')",
    );
    assert.deepEqual(triggers.rows, [{ count: 12, enabled: true }]);
    const versions = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM regi_migrations',
    );
    assert.equal(versions.rows[0].count, 9);
  } finally {
    await prisma.$disconnect();
    await owner.end();
    await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
    await admin.end();
  }
});
