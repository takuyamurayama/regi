import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';
import { apiFixture } from './api-fixture';
import { pinHash } from '../apps/api/src/service';
import { rows, sql } from '../apps/api/src/db';

void test('two HTTP connections create only one active correction draft and cancelled correction permits a new draft without original source rewriting', async () => {
  const f = await financeFixture(),
    other = await apiFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    const voided = await f.request('/v1/purchase-invoices/' + invoice.id + '/void', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: new Date().toISOString(),
      reason: '訂正下書きの競合試験',
    });
    assert.equal(voided.status, 201);
    const input = {
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: invoice.id,
      draft: {
        ...invoice.content,
        sourceEvidenceId: null,
        taxTreatment: { ...invoice.content.taxTreatment, evidenceId: null },
      },
    };
    const responses = await Promise.all([
      f.request('/v1/purchase-invoices', { ...input, operationId: randomUUID() }),
      f.request(
        '/v1/purchase-invoices',
        { ...input, operationId: randomUUID() },
        'POST',
        other.base,
      ),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const accepted = responses.find((r) => r.status === 201);
    assert.ok(accepted);
    const correction = F.InvoiceDtoSchema.parse(await accepted.json());
    const original = F.InvoiceDtoSchema.parse(
      await (await f.request('/v1/purchase-invoices/' + invoice.id + '?storeId=' + f.store)).json(),
    );
    assert.equal(original.replacementInvoiceId, correction.id);
    assert.deepEqual(original.content, invoice.content);
    const cancelled = await f.request('/v1/purchase-invoices/' + correction.id + '/cancel', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: correction.version,
      reason: '試験下書き取消',
    });
    assert.equal(cancelled.status, 201);
    const next = await f.request('/v1/purchase-invoices', { ...input, operationId: randomUUID() });
    assert.equal(next.status, 201);
    const again = F.InvoiceDtoSchema.parse(await next.json());
    assert.notEqual(again.id, correction.id);
    assert.equal(again.predecessorInvoiceId, invoice.id);
    assert.equal(again.content.sourceEvidenceId, null);
    const [count] = await f.database.transaction(f.admin, (tx) =>
      rows<{ count: number }>(
        tx,
        sql`SELECT count(*)::int AS count FROM purchase_invoices WHERE predecessor_invoice_id=${invoice.id}::uuid AND state='draft'`,
      ),
    );
    assert.equal(count.count, 1);
  } finally {
    await other.close();
    await f.close();
  }
});

void test('HTTP manager can create ordinary incomplete invoice draft but cannot create a financial correction from a voided invoice', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    const voided = await f.request('/v1/purchase-invoices/' + invoice.id + '/void', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: new Date().toISOString(),
      reason: '店長権限の訂正拒否試験',
    });
    assert.equal(voided.status, 201);
    const subject = randomUUID(),
      staffId = randomUUID();
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(
        sql`INSERT INTO staff VALUES(${staffId}::uuid,${f.admin.tenantId}::uuid,${subject},'試験店長','manager',ARRAY[${f.store}::uuid],${pinHash('1234', subject)},true)`,
      ),
    );
    const input = {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: invoice.id,
      draft: {
        ...invoice.content,
        sourceEvidenceId: null,
        taxTreatment: { ...invoice.content.taxTreatment, evidenceId: null },
      },
    };
    const corrected = await fetch(f.api.base + '/v1/purchase-invoices', {
      method: 'POST',
      headers: { ...f.headers, 'x-staff-subject': subject, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(corrected.status, 403, await corrected.clone().text());
    const ordinary = await fetch(f.api.base + '/v1/purchase-invoices', {
      method: 'POST',
      headers: { ...f.headers, 'x-staff-subject': subject, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        operationId: randomUUID(),
        predecessorInvoiceId: null,
        draft: { ...input.draft, sourceIdentity: null, invoiceDate: null },
      }),
    });
    assert.equal(ordinary.status, 201);
    assert.equal(F.InvoiceDtoSchema.parse(await ordinary.json()).state, 'draft');
  } finally {
    await f.close();
  }
});
