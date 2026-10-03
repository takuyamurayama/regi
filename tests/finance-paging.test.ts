import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';

void test('HTTP fifty-one payable invoices use returned default asOf on page two and exclude later recorded backdated payments', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    for (let i = 0; i < 50; i++) {
      const created = await f.request('/v1/purchase-invoices', {
        operationId: randomUUID(),
        storeId: f.store,
        supplierId: supplier.id,
        predecessorInvoiceId: null,
        draft: {
          ...invoice.content,
          sourceKind: 'buyer-statement',
          sourceIdentity: { kind: 'numbered', invoiceNumber: '合成ページ試験-' + String(i) },
          sourceEvidenceId: null,
          taxTreatment: { mode: 'computed' },
        },
      });
      assert.equal(created.status, 201);
      const draft = F.InvoiceDtoSchema.parse(await created.json());
      const posted = await f.request('/v1/purchase-invoices/' + draft.id + '/post', {
        operationId: randomUUID(),
        storeId: f.store,
        expectedInvoiceVersion: draft.version,
        effectiveAt: new Date().toISOString(),
        reason: null,
        taxVarianceAcceptance: null,
      });
      assert.equal(posted.status, 201);
    }
    const first = await f.request('/v1/payables?storeId=' + f.store);
    assert.equal(first.status, 200);
    const page = F.PayablesPageDtoSchema.parse(await first.json());
    assert.equal(page.items.length, 50);
    assert.equal(page.totals.invoiceCount, 51);
    assert.equal(page.totals.payableAmount, '5508');
    assert.ok(page.nextCursor);
    const paid = await f.request('/v1/purchase-payments', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '50',
      paidAt: invoice.ledger[0].occurredAt,
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '観測後に記録した実日時を持つ合成決済',
    });
    assert.equal(paid.status, 201);
    const second = await f.request(
      '/v1/payables?storeId=' +
        f.store +
        '&asOf=' +
        encodeURIComponent(page.asOf) +
        '&cursor=' +
        encodeURIComponent(page.nextCursor),
    );
    assert.equal(second.status, 200, await second.clone().text());
    const end = F.PayablesPageDtoSchema.parse(await second.json());
    assert.equal(end.items.length, 1);
    assert.equal(end.nextCursor, null);
    assert.equal(end.asOf, page.asOf);
    assert.equal(end.observedAt, page.observedAt);
    assert.equal(end.totals.payableAmount, '5508');
    assert.equal(new Set([...page.items, ...end.items].map((i) => i.invoiceId)).size, 51);
    const altered = await f.request(
      '/v1/payables?storeId=' +
        f.store +
        '&asOf=' +
        encodeURIComponent(new Date().toISOString()) +
        '&cursor=' +
        encodeURIComponent(page.nextCursor),
    );
    assert.equal(altered.status, 400);
    const fresh = F.PayablesPageDtoSchema.parse(
      await (await f.request('/v1/payables?storeId=' + f.store)).json(),
    );
    assert.equal(fresh.totals.payableAmount, '5458');
  } finally {
    await f.close();
  }
});

void test('HTTP mutable supplier pages reject changed membership instead of silently skipping offsets', async () => {
  const f = await financeFixture();
  try {
    const suppliers: F.SupplierDto[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await f.request('/v1/suppliers', {
        operationId: randomUUID(),
        code: 'PAGE-' + String(i),
        name: '合成仕入先' + String(i),
        address: '',
        registered: false,
        registrationNumber: null,
        defaultDueDays: 30,
        active: true,
      });
      assert.equal(r.status, 201);
      suppliers.push(F.SupplierDtoSchema.parse(await r.json()));
    }
    const first = F.financePageSchema(F.SupplierDtoSchema).parse(
      await (await f.request('/v1/suppliers?active=true&pageSize=1')).json(),
    );
    assert.ok(first.nextCursor);
    const chosen = suppliers.find((s) => s.id === first.items[0].id);
    assert.ok(chosen);
    const edit = await f.request(
      '/v1/suppliers/' + chosen.id,
      {
        operationId: randomUUID(),
        version: chosen.version,
        code: chosen.code,
        name: chosen.name,
        address: chosen.address,
        registered: chosen.registered,
        registrationNumber: chosen.registrationNumber,
        defaultDueDays: chosen.defaultDueDays,
        active: false,
      },
      'PATCH',
    );
    assert.equal(edit.status, 200);
    const page = await f.request(
      '/v1/suppliers?active=true&pageSize=1&cursor=' + encodeURIComponent(first.nextCursor),
    );
    assert.equal(page.status, 400, await page.clone().text());
    assert.equal(((await page.json()) as { code: string }).code, 'INVALID_CURSOR');
  } finally {
    await f.close();
  }
});
