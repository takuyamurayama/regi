import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as F from '../packages/core/src/finance';
import { financeFixture } from './finance-fixture';

async function exportPdf(f: Awaited<ReturnType<typeof financeFixture>>, invoiceId: string) {
  const response = await f.request('/v1/exports', {
    operationId: randomUUID(),
    storeId: f.store,
    format: 'purchase-invoice-pdf',
    invoiceId,
    asOf: new Date().toISOString(),
    viewToken: null,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const created = F.FinanceExportDtoSchema.parse(await response.json());
  for (let attempt = 0; attempt < 150; attempt++) {
    const dto = F.FinanceExportDtoSchema.parse(
      await (await f.request('/v1/purchase-exports/' + created.id + '?storeId=' + f.store)).json(),
    );
    assert.notEqual(dto.status, 'failed', JSON.stringify(dto.error));
    if (dto.status === 'completed') {
      assert.ok(dto.downloadPath);
      const downloaded = await f.request(dto.downloadPath + '?storeId=' + f.store);
      assert.equal(downloaded.status, 200);
      const output = spawnSync('pdftotext', ['-layout', '-', '-'], {
        input: Buffer.from(await downloaded.arrayBuffer()),
        encoding: 'utf8',
      });
      assert.equal(output.status, 0, output.stderr);
      return output.stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the actual buyer statement PDF did not complete');
}

void test('HTTP registered-supplier buyer statement PDF preserves both parties and supplier registration number before and after snapshot-bound confirmation', async () => {
  const f = await financeFixture();
  try {
    const supplierResponse = await f.request('/v1/suppliers', {
      operationId: randomUUID(),
      code: 'BUYER-PDF',
      name: '仕入明細の架空売手',
      address: '合成売手住所',
      registered: true,
      registrationNumber: 'T0000000000007',
      defaultDueDays: 30,
      active: true,
    });
    assert.equal(supplierResponse.status, 201);
    const supplier = F.SupplierDtoSchema.parse(await supplierResponse.json());
    const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const draft: F.InvoiceDraftFields = {
      sourceKind: 'buyer-statement',
      sourceIdentity: { kind: 'numbered', invoiceNumber: '合成仕入明細-PDF-001' },
      sourceEvidenceId: null,
      invoiceDate: day,
      dueDate: day,
      sourceReceivedDate: null,
      sourceReceivedAt: null,
      transactionFrom: day,
      transactionTo: day,
      seller: {
        name: supplier.name,
        address: supplier.address,
        registered: true,
        registrationNumber: supplier.registrationNumber,
      },
      buyer: { name: '仕入明細の架空買手', address: '合成買手住所' },
      priceMode: 'inclusive',
      rounding: 'floor',
      taxTreatment: { mode: 'computed' },
      lines: [
        {
          lineNo: 1,
          name: '合成軽減対象品',
          productId: f.product,
          transactionDate: day,
          quantity: 1,
          unitAmount: '108',
          discountAmount: '0',
          taxCategory: 'taxable',
          rateBps: 800,
          reducedTarget: true,
          receiptAllocations: [],
          unmatchedReason: '合成PDF試験、実入荷は作成しない',
        },
        {
          lineNo: 2,
          name: '合成標準対象品',
          productId: f.product,
          transactionDate: day,
          quantity: 1,
          unitAmount: '110',
          discountAmount: '0',
          taxCategory: 'taxable',
          rateBps: 1000,
          reducedTarget: false,
          receiptAllocations: [],
          unmatchedReason: '合成PDF試験、実入荷は作成しない',
        },
      ],
      note: '架空の登録番号・確認資料による合成試験。実取引や番号真正性の証明ではない。',
    };
    const createdResponse = await f.request('/v1/purchase-invoices', {
      operationId: randomUUID(),
      storeId: f.store,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft,
    });
    assert.equal(createdResponse.status, 201);
    const created = F.InvoiceDtoSchema.parse(await createdResponse.json());
    const postResponse = await f.request('/v1/purchase-invoices/' + created.id + '/post', {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: created.version,
      effectiveAt: new Date().toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    });
    assert.equal(postResponse.status, 201, await postResponse.clone().text());
    const posted = F.InvoiceActionDtoSchema.parse(await postResponse.json()).invoice;
    const pendingPdf = await exportPdf(f, posted.id);
    for (const text of [
      '仕入明細書',
      draft.buyer?.name,
      supplier.name,
      supplier.registrationNumber,
      '合成売手住所',
      '合成買手住所',
      '相手方確認待ち',
      '8%',
      '10%',
      '軽減税率対象',
      '218 円',
    ]) {
      assert.ok(text && pendingPdf.includes(text), 'missing actual PDF field: ' + String(text));
    }
    const proofBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const upload = await fetch(f.api.base + '/v1/purchase-invoices/' + posted.id + '/evidence', {
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'image/png',
        'x-regi-operation-id': randomUUID(),
        'x-regi-store-id': f.store,
        'x-regi-invoice-version': String(posted.version),
        'x-regi-evidence-name': 'synthetic-confirmation.png',
        'x-regi-evidence-role': 'supplier-confirmation',
        'x-regi-evidence-method': 'email-copy',
      },
      body: proofBytes,
    });
    assert.equal(upload.status, 201);
    const proof = F.EvidenceActionDtoSchema.parse(await upload.json());
    const confirmation = await f.request(
      '/v1/purchase-invoices/' + posted.id + '/confirm-supplier',
      {
        operationId: randomUUID(),
        storeId: f.store,
        expectedInvoiceVersion: proof.invoiceVersion,
        postedSnapshotSha256: posted.postedSnapshotSha256,
        confirmedAt: new Date().toISOString(),
        counterpartyName: '合成確認者',
        method: 'email',
        evidenceId: proof.evidence.id,
        note: '実確認ではないPDF合成試験',
      },
    );
    assert.equal(confirmation.status, 201);
    const confirmed = F.SupplierConfirmationActionDtoSchema.parse(
      await confirmation.json(),
    ).invoice;
    assert.deepEqual(confirmed.content, posted.content);
    assert.deepEqual(confirmed.ledger, posted.ledger);
    const supplierChanged = await f.request(
      '/v1/suppliers/' + supplier.id,
      {
        operationId: randomUUID(),
        version: supplier.version,
        code: supplier.code,
        name: '変更後の売手名称',
        address: '変更後住所',
        registered: true,
        registrationNumber: 'T0000000000008',
        defaultDueDays: 30,
        active: true,
      },
      'PATCH',
    );
    assert.equal(supplierChanged.status, 200);
    const confirmedPdf = await exportPdf(f, posted.id);
    for (const text of [
      '仕入明細書',
      '仕入明細の架空買手',
      supplier.name,
      'T0000000000007',
      '相手方確認記録あり',
      '合成確認者',
      proof.evidence.id,
      '軽減税率対象',
    ])
      assert.ok(confirmedPdf.includes(text), 'missing confirmed PDF field: ' + text);
    assert.equal(confirmedPdf.includes('T0000000000008'), false);
    assert.equal(confirmedPdf.includes('変更後'), false);
    assert.equal(confirmedPdf.includes('相手方確認待ち'), false);
  } finally {
    await f.close();
  }
});
