import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';
import { rows, sql } from '../apps/api/src/db';

void test('HTTP five hundred lines with thirty-digit prices and ten thousand units post exact thirty-seven-digit aggregates without database overflow', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    const unit = '9'.repeat(30);
    const net = BigInt(unit) * 10000n * 500n;
    const gross = net + net / 10n;
    const draft = {
      ...invoice.content,
      sourceKind: 'buyer-statement',
      sourceIdentity: { kind: 'numbered', invoiceNumber: '合成最大整数境界' },
      sourceEvidenceId: null,
      priceMode: 'exclusive',
      taxTreatment: { mode: 'computed' },
      lines: Array.from({ length: 500 }, (_, i) => ({
        ...invoice.content.lines[0],
        lineNo: i + 1,
        name: '整数境界明細' + String(i),
        quantity: 10000,
        unitAmount: unit,
        rateBps: 1000,
        reducedTarget: false,
      })),
    };
    const create = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft,
    });
    assert.equal(create.status, 201, await create.clone().text());
    const created = F.InvoiceDtoSchema.parse(await create.json());
    assert.equal(created.preview.acceptedGross, gross.toString());
    assert.equal(gross.toString().length, 37);
    const posted = await f.request('/v1/purchase-invoices/' + created.id + '/post', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: created.version,
      effectiveAt: new Date().toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    });
    assert.equal(posted.status, 201, await posted.clone().text());
    const result = F.InvoiceActionDtoSchema.parse(await posted.json());
    assert.equal(result.invoice.ledger[0].amount, gross.toString());
    assert.equal(result.invoice.balance.signedBalance, gross.toString());
    assert.equal(
      result.invoice.preview.lines.reduce((s, l) => s + BigInt(l.net), 0n),
      net,
    );
    assert.equal(
      result.invoice.preview.lines.reduce((s, l) => s + BigInt(l.taxAllocation), 0n),
      net / 10n,
    );
    const [ledger] = await f.database.transaction(f.admin, (tx) =>
      rows<{ amount: string }>(
        tx,
        sql`SELECT amount::text AS amount FROM purchase_ledger WHERE invoice_id=${created.id}::uuid`,
      ),
    );
    assert.equal(ledger.amount, gross.toString());
  } finally {
    await f.close();
  }
});

void test('HTTP impossible two-hundred-digit supplier transcription fails before ledger storage while original evidence and incomplete draft remain intact', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier, originalBytes } = await postedInvoice(f);
    const huge = '9'.repeat(200);
    const draft = {
      ...invoice.content,
      sourceIdentity: { kind: 'numbered', invoiceNumber: '過大原記載の合成検査' },
      sourceEvidenceId: null,
      taxTreatment: {
        mode: 'supplier-stated',
        groups: [{ groupKey: 'taxable:800', net: huge, tax: '0', gross: huge }],
        evidenceId: null,
        reason: null,
      },
    };
    const create = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft,
    });
    assert.equal(create.status, 201);
    let current = F.InvoiceDtoSchema.parse(await create.json());
    const upload = await fetch(f.api.base + '/v1/purchase-invoices/' + current.id + '/evidence', {
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'application/pdf',
        'x-regi-operation-id': randomUUID(),
        'x-regi-store-id': f.store,
        'x-regi-invoice-version': String(current.version),
        'x-regi-evidence-name': 'synthetic-huge.pdf',
        'x-regi-evidence-role': 'source-invoice',
        'x-regi-evidence-method': 'uploaded-original',
      },
      body: new Uint8Array(originalBytes),
    });
    assert.equal(upload.status, 201);
    const evidence = F.EvidenceActionDtoSchema.parse(await upload.json());
    const edited = await f.request(
      '/v1/purchase-invoices/' + current.id,
      {
        operationId: randomUUID(),
        storeId: f.store,
        version: evidence.invoiceVersion,
        draft: {
          ...draft,
          sourceEvidenceId: evidence.evidence.id,
          taxTreatment: { ...draft.taxTreatment, evidenceId: evidence.evidence.id },
        },
      },
      'PATCH',
    );
    assert.equal(edited.status, 200);
    current = F.InvoiceDtoSchema.parse(await edited.json());
    assert.ok(current.preview.completionIssues.some((i) => i.code === 'TAX_MISMATCH'));
    const post = await f.request('/v1/purchase-invoices/' + current.id + '/post', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: current.version,
      effectiveAt: new Date().toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    });
    assert.equal(post.status, 409);
    assert.equal(F.ApiErrorDtoSchema.parse(await post.json()).retryable, false);
    const original = F.InvoiceDtoSchema.parse(
      await (await f.request('/v1/purchase-invoices/' + current.id + '?storeId=' + f.store)).json(),
    );
    assert.equal(original.state, 'draft');
    assert.equal(original.balance.originalGross, null);
    assert.equal(original.evidence.length, 1);
    assert.equal(original.ledger.length, 0);
    assert.deepEqual(original.content, current.content);
    const downloaded = await f.request(evidence.evidence.downloadPath + '?storeId=' + f.store);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), originalBytes);
  } finally {
    await f.close();
  }
});

void test('HTTP invoice receipt reservations serialize across drafts while physical return quantities stay separate and cancellation preserves original facts', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier } = await postedInvoice(f);
    const orderResponse = await f.request('/v1/purchase-orders', {
      operationId: randomUUID(),
      storeId: f.store,
      supplier: supplier.name,
      supplierId: supplier.id,
      expectedAt: invoice.invoiceDate,
      lines: [{ productId: f.product, quantity: 2, unitCost: '50' }],
    });
    assert.equal(orderResponse.status, 201);
    const order = (await orderResponse.json()) as { id: string };
    for (const action of ['approve', 'issue']) {
      const response = await f.request('/v1/purchase-orders/' + order.id + '/' + action, {
        operationId: randomUUID(),
        storeId: f.store,
      });
      assert.equal(response.status, 201);
    }
    const receiptResponse = await f.request('/v1/purchase-orders/' + order.id + '/receipts', {
      operationId: randomUUID(),
      storeId: f.store,
      lines: [{ index: 0, quantity: 2 }],
    });
    assert.equal(receiptResponse.status, 201);
    const receipt = (await receiptResponse.json()) as { id: string };
    const draft = {
      ...invoice.content,
      sourceKind: 'buyer-statement',
      sourceIdentity: { kind: 'numbered', invoiceNumber: '合成入荷照合1' },
      sourceEvidenceId: null,
      taxTreatment: { mode: 'computed' },
      lines: [
        {
          ...invoice.content.lines[0],
          quantity: 2,
          receiptAllocations: [{ receiptId: receipt.id, receiptLineIndex: 0, quantity: 2 }],
          unmatchedReason: null,
        },
      ],
    };
    const create = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft,
    });
    assert.equal(create.status, 201);
    const reserved = F.InvoiceDtoSchema.parse(await create.json());
    const second = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft: { ...draft, sourceIdentity: { kind: 'numbered', invoiceNumber: '合成入荷照合2' } },
    });
    assert.equal(second.status, 409);
    assert.equal(F.ApiErrorDtoSchema.parse(await second.json()).code, 'RECEIPT_OVERALLOCATED');
    const preview = await f.request('/v1/purchase-invoices/preview', {
      storeId: f.store,
      supplierId: supplier.id,
      invoiceId: null,
      version: null,
      draft,
    });
    assert.equal(preview.status, 409);
    const own = F.financePageSchema(F.ReceiptCandidateDtoSchema).parse(
      await (
        await f.request(
          '/v1/purchase-receipts/available?storeId=' +
            f.store +
            '&supplierId=' +
            supplier.id +
            '&invoiceId=' +
            reserved.id,
        )
      ).json(),
    );
    assert.equal(own.items[0].ownDraftAllocatedQuantity, 2);
    assert.equal(own.items[0].invoiceAllocatableQuantity, 2);
    assert.equal(own.items[0].returnableQuantity, 2);
    const cancelled = await f.request('/v1/receipts/' + receipt.id + '/cancel', {
      operationId: randomUUID(),
      storeId: f.store,
      reason: '照合中入荷の取消拒否',
    });
    assert.equal(cancelled.status, 409);
    assert.equal(
      F.ApiErrorDtoSchema.parse(await cancelled.json()).code,
      'FINANCE_RECEIPT_ALLOCATED',
    );
    const returned = await f.request('/v1/purchase-returns', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: null,
      expectedInvoiceVersion: null,
      returnedAt: new Date().toISOString(),
      reason: '後着請求前の物品返送',
      lines: [{ receiptId: receipt.id, receiptLineIndex: 0, quantity: 2 }],
    });
    assert.equal(returned.status, 201);
    const posted = await f.request('/v1/purchase-invoices/' + reserved.id + '/post', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: reserved.version,
      effectiveAt: new Date().toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    });
    assert.equal(posted.status, 201);
    const result = F.InvoiceActionDtoSchema.parse(await posted.json());
    assert.equal(result.invoice.balance.signedBalance, '216');
    const available = F.financePageSchema(F.ReceiptCandidateDtoSchema).parse(
      await (
        await f.request(
          '/v1/purchase-receipts/available?storeId=' + f.store + '&supplierId=' + supplier.id,
        )
      ).json(),
    );
    assert.equal(available.items[0].activeInvoiceAllocatedQuantity, 2);
    assert.equal(available.items[0].invoiceAllocatableQuantity, 0);
    assert.equal(available.items[0].activeReturnedQuantity, 2);
    assert.equal(available.items[0].returnableQuantity, 0);
    const [raw] = await f.database.transaction(f.admin, (tx) =>
      rows<{ quantity: string; receipts: number; cancelled: number }>(
        tx,
        sql`SELECT (SELECT sum(quantity)::text FROM inventory) AS quantity,(SELECT count(*)::int FROM documents WHERE kind='receipt') AS receipts,(SELECT count(*)::int FROM documents WHERE kind='receipt-cancel') AS cancelled`,
      ),
    );
    assert.deepEqual(raw, { quantity: '0', receipts: 1, cancelled: 0 });
  } finally {
    await f.close();
  }
});
