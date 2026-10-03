import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { recoveryToken } from '../apps/api/src/auth';
import { rows, sql } from '../apps/api/src/db';
import { pinHash } from '../apps/api/src/service';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';

void test('HTTP operation status resolves committed financial response loss without exposing saved results and survives invoice version changes', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplierBody } = await postedInvoice(f);
    const operationId = randomUUID();
    const paid = await f.request('/v1/purchase-payments', {
      operationId,
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '50',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '操作状態の合成照合',
    });
    assert.equal(paid.status, 201);
    // Deliberately discard the committed response body, as a reload after response loss does.
    await paid.body?.cancel();
    for (const id of [operationId, supplierBody.operationId]) {
      const response = await f.request('/v1/operations/' + id + '/status?storeId=' + f.store);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { operationId: id, status: 'committed' });
    }
    const current = F.InvoiceDtoSchema.parse(
      await (await f.request('/v1/purchase-invoices/' + invoice.id + '?storeId=' + f.store)).json(),
    );
    assert.equal(current.version, invoice.version + 1);
    assert.equal(current.balance.signedBalance, '58');
    const [counts] = await f.database.transaction(f.admin, (tx) =>
      rows<{ payments: number; operations: number }>(
        tx,
        sql`SELECT (SELECT count(*)::int FROM purchase_finance_facts WHERE invoice_id=${invoice.id}::uuid) AS payments,(SELECT count(*)::int FROM operations WHERE id=${operationId}::uuid) AS operations`,
      ),
    );
    assert.deepEqual(counts, { payments: 1, operations: 1 });
  } finally {
    await f.close();
  }
});

void test('HTTP operation status conceals other actors stores tenants and demoted financial roles and requires a matching audit record', async () => {
  const f = await financeFixture();
  const foreign = await financeFixture();
  try {
    const { supplierBody } = await postedInvoice(f);
    const ownOperation = randomUUID();
    await f.business.mutation(f.admin, { operationId: ownOperation }, 'cash.record', f.store, () =>
      Promise.resolve({ private: 'not returned' }),
    );
    const otherStaff = randomUUID(),
      otherStore = randomUUID(),
      unaudited = randomUUID();
    await f.database.transaction(f.admin, async (tx) => {
      await tx.$executeRaw(
        sql`INSERT INTO stores VALUES(${otherStore}::uuid,${f.admin.tenantId}::uuid,'別店舗照合')`,
      );
      await tx.$executeRaw(
        sql`INSERT INTO staff VALUES(${otherStaff}::uuid,${f.admin.tenantId}::uuid,${otherStaff},'別操作担当','admin',ARRAY[${f.store}::uuid],${pinHash('1234', otherStaff)},true)`,
      );
      await tx.$executeRaw(
        sql`INSERT INTO operations(tenant_id,id,store_id,hash,result) VALUES(${f.admin.tenantId}::uuid,${unaudited}::uuid,${f.store}::uuid,'not-audit-backed','{"pin":"secret"}'::jsonb)`,
      );
    });
    const cases = [
      () => f.request('/v1/operations/' + ownOperation + '/status?storeId=' + otherStore),
      () =>
        f.request(
          '/v1/operations/' + supplierBody.operationId + '/status?storeId=' + foreign.store,
        ),
      () => f.request('/v1/operations/' + unaudited + '/status?storeId=' + f.store),
      () => f.request('/v1/operations/' + randomUUID() + '/status?storeId=' + f.store),
      () => foreign.request('/v1/operations/' + ownOperation + '/status?storeId=' + foreign.store),
      () =>
        fetch(f.api.base + '/v1/operations/' + ownOperation + '/status?storeId=' + f.store, {
          headers: { ...f.headers, 'x-staff-subject': otherStaff },
        }),
    ];
    for (const request of cases) {
      const response = await request();
      assert.equal(response.status, 404, await response.clone().text());
      assert.equal(F.ApiErrorDtoSchema.parse(await response.json()).code, 'NOT_FOUND');
    }
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(sql`UPDATE staff SET role='cashier' WHERE id=${f.admin.staffId}::uuid`),
    );
    const denied = await f.request(
      '/v1/operations/' + supplierBody.operationId + '/status?storeId=' + f.store,
    );
    assert.equal(denied.status, 404);
    const ownCash = await f.request(
      '/v1/operations/' + ownOperation + '/status?storeId=' + f.store,
    );
    assert.equal(ownCash.status, 200);
    assert.deepEqual(await ownCash.json(), { operationId: ownOperation, status: 'committed' });
  } finally {
    await foreign.close();
    await f.close();
  }
});

void test('HTTP operation status validates identifiers denies recovery credentials and observes the contract read grace period', async () => {
  const f = await financeFixture();
  try {
    const { supplierBody } = await postedInvoice(f);
    for (const query of ['', '?storeId=', '?storeId=not-a-uuid']) {
      const response = await f.request(
        '/v1/operations/' + supplierBody.operationId + '/status' + query,
      );
      assert.equal(response.status, 400, await response.clone().text());
    }
    const invalid = await f.request('/v1/operations/not-a-uuid/status?storeId=' + f.store);
    assert.equal(invalid.status, 400);
    const token = await recoveryToken(
      f.admin,
      f.device,
      f.sale.leaseId,
      new Date(Date.now() + 3600000),
    );
    const recovery = await fetch(f.api.base + '/v1/sync/events', {
      method: 'POST',
      headers: { 'x-recovery-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(recovery.status, 201, await recovery.clone().text());
    const response = await fetch(
      f.api.base + '/v1/operations/' + supplierBody.operationId + '/status?storeId=' + f.store,
      {
        headers: {
          'x-recovery-token': token,
        },
      },
    );
    assert.equal(response.status, 401, await response.clone().text());
    await assert.rejects(
      f.business.operationStatus({ ...f.admin, deviceId: f.device }, supplierBody.operationId, {
        storeId: f.store,
      }),
      { code: 'ROLE_FORBIDDEN', status: 403 },
    );
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(
        sql`UPDATE tenants SET starts_at=now()-interval '1 year',ends_at=now()-interval '1 day'`,
      ),
    );
    const grace = await f.request(
      '/v1/operations/' + supplierBody.operationId + '/status?storeId=' + f.store,
    );
    assert.equal(grace.status, 200);
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(sql`UPDATE tenants SET ends_at=now()-interval '31 days'`),
    );
    const expired = await f.request(
      '/v1/operations/' + supplierBody.operationId + '/status?storeId=' + f.store,
    );
    assert.equal(expired.status, 403);
    assert.equal(F.ApiErrorDtoSchema.parse(await expired.json()).code, 'CONTRACT_EXPIRED');
  } finally {
    await f.close();
  }
});
