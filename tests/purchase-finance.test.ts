import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PaymentActionDtoSchema,
  PayablesPageDtoSchema,
  SupplierDtoSchema,
  InvoiceDtoSchema,
} from '../packages/core/src/finance';
import { rows, sql } from '../apps/api/src/db';
import { apiFixture } from './api-fixture';
import { financeFixture, postedInvoice } from './finance-fixture';

void test('HTTP original-evidence invoice posts once and partial payment reversal preserves original snapshots audit and signed payable balance', async () => {
  const fixture = await financeFixture();
  try {
    const { supplier, supplierBody, invoice } = await postedInvoice(fixture);
    assert.equal(invoice.state, 'posted');
    assert.equal(invoice.balance.signedBalance, '108');
    assert.equal(invoice.ledger.length, 1);
    assert.equal(invoice.ledger[0].kind, 'invoice-debit');
    assert.equal(invoice.ledger[0].signedAmount, '108');
    const changed = await fixture.request(
      '/v1/suppliers/' + supplier.id,
      {
        ...supplierBody,
        operationId: randomUUID(),
        version: supplier.version,
        name: '変更後の架空仕入先',
        active: false,
      },
      'PATCH',
    );
    assert.equal(changed.status, 200);
    assert.equal(SupplierDtoSchema.parse(await changed.json()).active, false);
    const paymentInput = {
      operationId: randomUUID(),
      storeId: fixture.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '50',
      paidAt: new Date().toISOString(),
      method: 'bank-transfer',
      reference: '実銀行実行ではない合成試験参照',
      evidenceId: null,
      note: '銀行実行はREGIで行わない',
    };
    const response = await fixture.request('/v1/purchase-payments', paymentInput);
    assert.equal(response.status, 201, await response.clone().text());
    const paid = PaymentActionDtoSchema.parse(await response.json());
    assert.equal(paid.invoice.balance.signedBalance, '58');
    assert.equal(paid.invoice.balance.status, 'partially-paid');
    assert.deepEqual(
      await (await fixture.request('/v1/purchase-payments', paymentInput)).json(),
      paid,
    );
    const excessive = await fixture.request('/v1/purchase-payments', {
      ...paymentInput,
      operationId: randomUUID(),
      expectedInvoiceVersion: paid.invoice.version,
      amount: '59',
    });
    assert.equal(excessive.status, 409);
    const reverse = await fixture.request('/v1/purchase-payments/' + paid.record.id + '/reverse', {
      operationId: randomUUID(),
      storeId: fixture.store,
      expectedInvoiceVersion: paid.invoice.version,
      effectiveAt: new Date().toISOString(),
      reason: '実銀行実行とは無関係の逆記録試験',
      evidenceId: null,
    });
    assert.equal(reverse.status, 201, await reverse.clone().text());
    const reversed = PaymentActionDtoSchema.parse(await reverse.json());
    assert.equal(reversed.invoice.balance.signedBalance, '108');
    const read = await fixture.request(
      '/v1/purchase-invoices/' + invoice.id + '?storeId=' + fixture.store,
    );
    assert.equal(read.status, 200);
    const original = InvoiceDtoSchema.parse(await read.json());
    assert.deepEqual(original.content, invoice.content);
    assert.equal(original.postedSnapshotSha256, invoice.postedSnapshotSha256);
    assert.equal(original.ledger.length, 3);
    assert.deepEqual(
      original.ledger.map((entry) => entry.signedAmount),
      ['108', '-50', '50'],
    );
    const payables = await fixture.request('/v1/payables?storeId=' + fixture.store);
    assert.equal(payables.status, 200);
    const page = PayablesPageDtoSchema.parse(await payables.json());
    assert.equal(page.totals.payableAmount, '108');
    assert.equal(page.totals.refundDueAmount, '0');
    assert.equal(page.items[0].supplierName, supplier.name);
    const [facts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ debit: number; payments: number }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM purchase_ledger WHERE invoice_id=${invoice.id}::uuid AND kind='invoice-debit') AS debit,(SELECT count(*)::int FROM purchase_finance_facts WHERE invoice_id=${invoice.id}::uuid AND kind='payment') AS payments`,
      ),
    );
    assert.deepEqual(facts, { debit: 1, payments: 2 });
  } finally {
    await fixture.close();
  }
});

void test('two real API database connections serialize stale-version payments without double payment or lost evidence', async () => {
  const fixture = await financeFixture();
  const second = await apiFixture();
  try {
    const { invoice, evidence, originalBytes } = await postedInvoice(fixture);
    const input = {
      storeId: fixture.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '80',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '二接続の合成試験',
    };
    const responses = await Promise.all([
      fixture.request('/v1/purchase-payments', { ...input, operationId: randomUUID() }),
      fixture.request(
        '/v1/purchase-payments',
        { ...input, operationId: randomUUID() },
        'POST',
        second.base,
      ),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const accepted = responses.find((response) => response.status === 201);
    assert.ok(accepted);
    assert.equal(
      PaymentActionDtoSchema.parse(await accepted.json()).invoice.balance.signedBalance,
      '28',
    );
    const download = await fixture.request(
      evidence.evidence.downloadPath + '?storeId=' + fixture.store,
    );
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalBytes);
    const read = await fixture.request(
      '/v1/purchase-invoices/' + invoice.id + '?storeId=' + fixture.store,
    );
    const actual = InvoiceDtoSchema.parse(await read.json());
    assert.equal(actual.balance.payments, '80');
    assert.equal(actual.ledger.length, 2);
  } finally {
    await second.close();
    await fixture.close();
  }
});
