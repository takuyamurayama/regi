import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as F from '../packages/core/src/finance';
import { rows, sql } from '../apps/api/src/db';
import { z } from 'zod';
import { financeFixture, postedInvoice } from './finance-fixture';

void test('HTTP credit uses original line tax allocations and supplier refund reversal preserves every immutable signed fact', async () => {
  const f = await financeFixture();
  try {
    const { invoice } = await postedInvoice(f);
    const payment = await f.request('/v1/purchase-payments', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '108',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '合成決済記録',
    });
    assert.equal(payment.status, 201);
    let latest = F.PaymentActionDtoSchema.parse(await payment.json()).invoice;
    const proofBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const proof = await fetch(f.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence', {
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'image/png',
        'x-regi-operation-id': randomUUID(),
        'x-regi-store-id': f.store,
        'x-regi-invoice-version': String(latest.version),
        'x-regi-evidence-name': 'synthetic-credit.png',
        'x-regi-evidence-role': 'supplier-credit',
        'x-regi-evidence-method': 'email-copy',
      },
      body: proofBytes,
    });
    assert.equal(proof.status, 201);
    const evidence = F.EvidenceActionDtoSchema.parse(await proof.json());
    const input = {
      storeId: f.store,
      expectedInvoiceVersion: evidence.invoiceVersion,
      credit: { mode: 'quantity', lines: [{ invoiceLineNo: 1, quantity: 1 }] },
    };
    const previewResponse = await f.request(
      '/v1/purchase-invoices/' + invoice.id + '/credit-preview',
      input,
    );
    assert.equal(previewResponse.status, 201, await previewResponse.clone().text());
    const preview = F.CreditPreviewDtoSchema.parse(await previewResponse.json());
    assert.deepEqual(preview.lines, [
      { invoiceLineNo: 1, quantity: 1, net: '100', tax: '8', gross: '108' },
    ]);
    const creditInput = {
      ...input,
      operationId: randomUUID(),
      invoiceId: invoice.id,
      approvedAt: new Date().toISOString(),
      reason: '原金額・原税額の合成減額',
      evidenceId: evidence.evidence.id,
      purchaseReturnId: null,
      expectedPreviewSha256: preview.previewSha256,
    };
    const creditResponse = await f.request('/v1/purchase-credits', creditInput);
    assert.equal(creditResponse.status, 201, await creditResponse.clone().text());
    const credit = F.CreditActionDtoSchema.parse(await creditResponse.json());
    assert.equal(credit.invoice.balance.signedBalance, '-108');
    assert.deepEqual(await (await f.request('/v1/purchase-credits', creditInput)).json(), credit);
    const refundResponse = await f.request('/v1/purchase-refunds', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: credit.invoice.version,
      amount: '108',
      receivedAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '外部で受領した架空返金の合成記録',
    });
    assert.equal(refundResponse.status, 201);
    const refunded = F.RefundActionDtoSchema.parse(await refundResponse.json());
    assert.equal(refunded.invoice.balance.signedBalance, '0');
    const reverseRefund = await f.request(
      '/v1/purchase-refunds/' + refunded.record.id + '/reverse',
      {
        operationId: randomUUID(),
        storeId: f.store,
        expectedInvoiceVersion: refunded.invoice.version,
        effectiveAt: new Date().toISOString(),
        reason: '合成返金の逆記録',
        evidenceId: null,
      },
    );
    assert.equal(reverseRefund.status, 201);
    latest = F.RefundActionDtoSchema.parse(await reverseRefund.json()).invoice;
    assert.equal(latest.balance.signedBalance, '-108');
    const reverseCredit = await f.request('/v1/purchase-credits/' + credit.record.id + '/reverse', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: latest.version,
      effectiveAt: new Date().toISOString(),
      reason: '合成減額の逆記録',
      evidenceId: null,
    });
    assert.equal(reverseCredit.status, 201);
    latest = F.CreditActionDtoSchema.parse(await reverseCredit.json()).invoice;
    assert.equal(latest.balance.signedBalance, '0');
    const original = F.InvoiceDtoSchema.parse(
      await (await f.request('/v1/purchase-invoices/' + invoice.id + '?storeId=' + f.store)).json(),
    );
    assert.deepEqual(original.content, invoice.content);
    assert.deepEqual(
      original.ledger.map((e) => e.signedAmount),
      ['108', '-108', '-108', '108', '-108', '108'],
    );
    assert.equal(original.creditAvailability[0].remainingGross, '108');
    const stock = await f.database.transaction(f.admin, (tx) =>
      rows<{ count: number }>(tx, sql`SELECT count(*)::int AS count FROM inventory`),
    );
    assert.equal(stock[0].count, 0);
  } finally {
    await f.close();
  }
});

void test('HTTP selected supplier links keep issued purchase text immutable and physical returns never reduce invoice match availability', async () => {
  const f = await financeFixture();
  try {
    const supplierResponse = await f.request('/v1/suppliers', {
      operationId: randomUUID(),
      code: 'RETURN-SUPPLIER',
      name: '合成仕入先',
      address: '',
      registered: false,
      registrationNumber: null,
      defaultDueDays: 30,
      active: true,
    });
    assert.equal(supplierResponse.status, 201);
    const supplier = F.SupplierDtoSchema.parse(await supplierResponse.json());
    const orderInput = {
      operationId: randomUUID(),
      storeId: f.store,
      supplier: '入力時の仮名',
      supplierId: supplier.id,
      expectedAt: new Date().toISOString().slice(0, 10),
      lines: [{ productId: f.product, quantity: 2, unitCost: '50' }],
    };
    const orderResponse = await f.request('/v1/purchase-orders', orderInput);
    assert.equal(orderResponse.status, 201);
    const orderSchema = F.FinanceIdSchema.transform((id) => ({ id }));
    const order = orderSchema.parse(((await orderResponse.json()) as { id: unknown }).id);
    const list = await f.request('/v1/documents/purchase-order?storeId=' + f.store);
    const orderRows = (await list.json()) as {
      id: string;
      currentSupplierId?: string;
      body: { supplier: string };
    }[];
    assert.equal(orderRows.find((o) => o.id === order.id)?.currentSupplierId, supplier.id);
    assert.equal(orderRows.find((o) => o.id === order.id)?.body.supplier, supplier.name);
    for (const action of ['approve', 'issue']) {
      const r = await f.request('/v1/purchase-orders/' + order.id + '/' + action, {
        operationId: randomUUID(),
        storeId: f.store,
      });
      assert.equal(r.status, 201);
    }
    const receiptResponse = await f.request('/v1/purchase-orders/' + order.id + '/receipts', {
      operationId: randomUUID(),
      storeId: f.store,
      lines: [{ index: 0, quantity: 2 }],
    });
    assert.equal(receiptResponse.status, 201);
    const receipt = (await receiptResponse.json()) as { id: string };
    const returnInput = {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: null,
      expectedInvoiceVersion: null,
      returnedAt: new Date().toISOString(),
      reason: '後着請求前の架空物品返送',
      lines: [{ receiptId: receipt.id, receiptLineIndex: 0, quantity: 1 }],
    };
    const returnedResponse = await f.request('/v1/purchase-returns', returnInput);
    assert.equal(returnedResponse.status, 201, await returnedResponse.clone().text());
    const returned = F.ReturnActionDtoSchema.parse(await returnedResponse.json());
    assert.equal(returned.invoice, null);
    assert.notEqual(returned.record.inventorySourceId, returned.record.id);
    const available = await f.request(
      '/v1/purchase-receipts/available?storeId=' + f.store + '&supplierId=' + supplier.id,
    );
    assert.equal(available.status, 200);
    const candidates = F.financePageSchema(F.ReceiptCandidateDtoSchema).parse(
      await available.json(),
    );
    assert.equal(candidates.items[0].invoiceAllocatableQuantity, 2);
    assert.equal(candidates.items[0].returnableQuantity, 1);
    assert.equal(candidates.items[0].activeReturnedQuantity, 1);
    const excessive = await f.request('/v1/purchase-returns', {
      ...returnInput,
      operationId: randomUUID(),
      lines: [{ receiptId: receipt.id, receiptLineIndex: 0, quantity: 2 }],
    });
    assert.equal(excessive.status, 409);
    const cancellation = await f.request('/v1/receipts/' + receipt.id + '/cancel', {
      operationId: randomUUID(),
      storeId: f.store,
      reason: '返送済み入荷の誤取消拒否',
    });
    assert.equal(cancellation.status, 409);
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(sql`UPDATE products SET stock_managed=false WHERE id=${f.product}::uuid`),
    );
    const inverse = await f.request('/v1/purchase-returns/' + returned.record.id + '/reverse', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: null,
      effectiveAt: new Date().toISOString(),
      reason: '原在庫移動の逆記録',
    });
    assert.equal(inverse.status, 201, await inverse.clone().text());
    const reversed = F.ReturnActionDtoSchema.parse(await inverse.json());
    assert.equal(reversed.record.reversalOf, returned.record.id);
    assert.notEqual(reversed.record.inventorySourceId, reversed.record.id);
    const visible = z
      .object({ changes: z.array(z.object({ kind: z.string(), entity_id: z.uuid() })) })
      .parse(await f.business.changes({ ...f.admin, role: 'cashier' }, '0'));
    assert.equal(
      visible.changes.some((c) => c.kind === 'purchase-finance'),
      false,
    );
    assert.equal(
      visible.changes.some((c) => [returned.record.id, reversed.record.id].includes(c.entity_id)),
      false,
    );
    for (const sourceId of [returned.record.inventorySourceId, reversed.record.inventorySourceId])
      assert.ok(visible.changes.some((c) => c.kind === 'inventory' && c.entity_id === sourceId));
    const [stock] = await f.database.transaction(f.admin, (tx) =>
      rows<{ quantity: string; returns: number }>(
        tx,
        sql`SELECT sum(quantity)::text AS quantity,count(*) FILTER(WHERE reason IN ('purchase-return','purchase-return-reversal'))::int AS returns FROM inventory`,
      ),
    );
    assert.deepEqual(stock, { quantity: '2', returns: 2 });
  } finally {
    await f.close();
  }
});

void test('HTTP buyer statement stays unconfirmed until actual matching snapshot evidence and supports void correction without source rewriting', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    const voidedResponse = await f.request('/v1/purchase-invoices/' + invoice.id + '/void', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: new Date().toISOString(),
      reason: '架空原請求の訂正前取消',
    });
    assert.equal(voidedResponse.status, 201, await voidedResponse.clone().text());
    const voided = F.InvoiceActionDtoSchema.parse(await voidedResponse.json());
    assert.equal(voided.invoice.state, 'voided');
    assert.equal(voided.invoice.balance.signedBalance, '0');
    assert.deepEqual(voided.invoice.content, invoice.content);
    const correctedResponse = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: invoice.id,
      draft: {
        ...invoice.content,
        sourceKind: 'buyer-statement',
        sourceEvidenceId: null,
        taxTreatment: { mode: 'computed' },
      },
    });
    assert.equal(correctedResponse.status, 201);
    const corrected = F.InvoiceDtoSchema.parse(await correctedResponse.json());
    const postResponse = await f.request('/v1/purchase-invoices/' + corrected.id + '/post', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: corrected.version,
      effectiveAt: new Date().toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    });
    assert.equal(postResponse.status, 201);
    const posted = F.InvoiceActionDtoSchema.parse(await postResponse.json());
    assert.equal(posted.invoice.revision, 2);
    assert.equal(posted.invoice.supplierConfirmationStatus, 'pending');
    assert.equal(posted.invoice.sourceIdentity?.kind, 'numbered');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const proof = await fetch(f.api.base + '/v1/purchase-invoices/' + corrected.id + '/evidence', {
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'image/png',
        'x-regi-operation-id': randomUUID(),
        'x-regi-store-id': f.store,
        'x-regi-invoice-version': String(posted.invoice.version),
        'x-regi-evidence-name': 'confirmation.png',
        'x-regi-evidence-role': 'supplier-confirmation',
        'x-regi-evidence-method': 'email-copy',
      },
      body: bytes,
    });
    assert.equal(proof.status, 201);
    const evidence = F.EvidenceActionDtoSchema.parse(await proof.json());
    const confirmation = {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: evidence.invoiceVersion,
      postedSnapshotSha256: '0'.repeat(64),
      confirmedAt: new Date().toISOString(),
      counterpartyName: '架空の相手確認者',
      method: 'email',
      evidenceId: evidence.evidence.id,
      note: '実確認ではない合成証跡',
    };
    const mismatch = await f.request(
      '/v1/purchase-invoices/' + corrected.id + '/confirm-supplier',
      confirmation,
    );
    assert.equal(mismatch.status, 409);
    const valid = await f.request('/v1/purchase-invoices/' + corrected.id + '/confirm-supplier', {
      ...confirmation,
      operationId: randomUUID(),
      postedSnapshotSha256: posted.invoice.postedSnapshotSha256,
    });
    assert.equal(valid.status, 201, await valid.clone().text());
    const confirmed = F.SupplierConfirmationActionDtoSchema.parse(await valid.json());
    assert.equal(confirmed.invoice.supplierConfirmationStatus, 'confirmed-recorded');
    assert.equal(confirmed.confirmation.postedSnapshotSha256, posted.invoice.postedSnapshotSha256);
    assert.deepEqual(confirmed.invoice.content, posted.invoice.content);
  } finally {
    await f.close();
  }
});
