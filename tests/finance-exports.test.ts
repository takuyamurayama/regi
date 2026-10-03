import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';

async function completed(f: Awaited<ReturnType<typeof financeFixture>>, id: string) {
  for (let i = 0; i < 150; i++) {
    const response = await f.request('/v1/purchase-exports/' + id + '?storeId=' + f.store);
    assert.equal(response.status, 200, await response.clone().text());
    const dto = F.FinanceExportDtoSchema.parse(await response.json());
    if (dto.status === 'completed') return dto;
    if (dto.status === 'failed') assert.fail(JSON.stringify(dto.error));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('export did not complete');
}
void test('HTTP finance PDF and evidence bundle capture immutable source and byte hashes before later master and payment changes', async () => {
  const f = await financeFixture();
  try {
    const { invoice, supplier, supplierBody, evidence, originalBytes } = await postedInvoice(f);
    const input = {
      operationId: randomUUID(),
      storeId: f.store,
      format: 'purchase-finance-bundle',
      invoiceId: invoice.id,
      asOf: new Date().toISOString(),
      viewToken: null,
    };
    const response = await f.request('/v1/exports', input);
    assert.equal(response.status, 201, await response.clone().text());
    const initial = F.FinanceExportDtoSchema.parse(await response.json());
    assert.equal(initial.status, 'queued');
    const changed = await f.request(
      '/v1/suppliers/' + supplier.id,
      {
        ...supplierBody,
        operationId: randomUUID(),
        version: supplier.version,
        name: '出力要求後の変更名',
      },
      'PATCH',
    );
    assert.equal(changed.status, 200);
    const paid = await f.request('/v1/purchase-payments', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '50',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '固定出力要求後の記録',
    });
    assert.equal(paid.status, 201);
    const payment = F.PaymentActionDtoSchema.parse(await paid.json());
    const paymentView = F.financePageSchema(F.PaymentDtoSchema).parse(
      await (await f.request('/v1/purchase-payments?storeId=' + f.store)).json(),
    );
    assert.equal(paymentView.items.length, 1);
    const inverseResponse = await f.request(
      '/v1/purchase-payments/' + payment.record.id + '/reverse',
      {
        operationId: randomUUID(),
        storeId: f.store,
        expectedInvoiceVersion: payment.invoice.version,
        effectiveAt: new Date().toISOString(),
        reason: '固定観測後の合成逆記録',
        evidenceId: null,
      },
    );
    assert.equal(inverseResponse.status, 201);
    const inverse = F.PaymentActionDtoSchema.parse(await inverseResponse.json());
    const laterResponse = await f.request('/v1/purchase-payments', {
      operationId: randomUUID(),
      storeId: f.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: inverse.invoice.version,
      amount: '20',
      paidAt: invoice.ledger[0].occurredAt,
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '観測後の記録は固定出力へ混入させない',
    });
    assert.equal(laterResponse.status, 201);
    const later = F.PaymentActionDtoSchema.parse(await laterResponse.json());
    const paymentCsvResponse = await f.request('/v1/exports', {
      operationId: randomUUID(),
      storeId: f.store,
      format: 'purchase-payments-csv',
      supplierId: null,
      invoiceId: null,
      from: null,
      to: null,
      asOf: paymentView.observedAt,
      viewToken: paymentView.viewToken,
    });
    assert.equal(paymentCsvResponse.status, 201, await paymentCsvResponse.clone().text());
    const csvJob = await completed(
      f,
      F.FinanceExportDtoSchema.parse(await paymentCsvResponse.json()).id,
    );
    assert.ok(csvJob.downloadPath);
    const paymentCsv = await (await f.request(csvJob.downloadPath + '?storeId=' + f.store)).text();
    assert.equal(paymentCsv.split('\r\n').length, 2);
    assert.ok(paymentCsv.includes(payment.record.id));
    assert.equal(paymentCsv.includes(inverse.record.id), false);
    assert.equal(paymentCsv.includes(later.record.id), false);
    const job = await completed(f, initial.id);
    assert.equal(job.sourceSnapshotSha256, initial.sourceSnapshotSha256);
    assert.ok(job.downloadPath);
    const download = await f.request(job.downloadPath + '?storeId=' + f.store);
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), job.fileSha256);
    assert.equal(bytes.length, job.bytes);
    const tar = gunzipSync(bytes),
      files = new Map<string, Buffer>();
    let offset = 0;
    while (offset + 512 <= tar.length && tar[offset] !== 0) {
      const header = tar.subarray(offset, offset + 512),
        name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/u, ''),
        size = parseInt(
          header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(),
          8,
        );
      files.set(name, tar.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const proof = files.get('evidence/' + evidence.evidence.id + '.pdf');
    assert.ok(proof);
    assert.deepEqual(proof, originalBytes);
    const manifestBytes = files.get('manifest.json');
    assert.ok(manifestBytes);
    const manifest = JSON.parse(manifestBytes.toString()) as {
      sourceSnapshotSha256: string;
      files: { name: string; sha256: string; bytes: number }[];
    };
    assert.equal(manifest.sourceSnapshotSha256, job.sourceSnapshotSha256);
    for (const entry of manifest.files) {
      const file = files.get(entry.name);
      assert.ok(file);
      assert.equal(file.length, entry.bytes);
      assert.equal(createHash('sha256').update(file).digest('hex'), entry.sha256);
    }
    const source = files.get('snapshot.json');
    assert.ok(source);
    assert.ok(source.toString().includes(supplier.name));
    assert.equal(source.toString().includes('出力要求後の変更名'), false);
    assert.equal(source.toString().includes('固定出力要求後の記録'), false);
    const pdf = files.get('invoice.pdf');
    assert.ok(pdf);
    const path = '.context/finance-export-tests/' + initial.id + '.pdf';
    await mkdir('.context/finance-export-tests', { recursive: true });
    await writeFile(path, pdf);
    const text = await promisify(execFile)('pdftotext', ['-layout', path, '-']);
    assert.match(text.stdout, /受領請求の管理用写し/u);
    assert.match(text.stdout, /架空原請求-001/u);
    assert.match(text.stdout, /非登録事業者/u);
    assert.match(text.stdout, /8%/u);
    assert.match(text.stdout, /軽減税率対象/u);
    assert.equal(text.stdout.includes('出力要求後の変更名'), false);
    const replay = await f.request('/v1/exports', input);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), initial);
  } finally {
    await f.close();
  }
});

void test('HTTP finance bundle rejects more than sixty-four MiB of original evidence without silently omitting files', async () => {
  const f = await financeFixture();
  try {
    const { invoice } = await postedInvoice(f);
    let version = invoice.version;
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    for (let i = 0; i < 7; i++) {
      const response = await fetch(
        f.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence',
        {
          method: 'POST',
          headers: {
            ...f.headers,
            'content-type': 'image/png',
            'x-regi-operation-id': randomUUID(),
            'x-regi-store-id': f.store,
            'x-regi-invoice-version': String(version),
            'x-regi-evidence-name': 'synthetic-limit-' + String(i) + '.png',
            'x-regi-evidence-role': 'supporting',
            'x-regi-evidence-method': 'uploaded-original',
          },
          body: bytes,
        },
      );
      assert.equal(response.status, 201);
      version = F.EvidenceActionDtoSchema.parse(await response.json()).invoiceVersion;
    }
    const response = await f.request('/v1/exports', {
      operationId: randomUUID(),
      storeId: f.store,
      format: 'purchase-finance-bundle',
      invoiceId: invoice.id,
      asOf: new Date().toISOString(),
      viewToken: null,
    });
    assert.equal(response.status, 409, await response.clone().text());
    const error = F.ApiErrorDtoSchema.parse(await response.json());
    assert.equal(error.code, 'EXPORT_TOO_LARGE');
    assert.equal(error.retryable, false);
    const original = F.InvoiceDtoSchema.parse(
      await (await f.request('/v1/purchase-invoices/' + invoice.id + '?storeId=' + f.store)).json(),
    );
    assert.equal(original.evidence.length, 8);
    assert.equal(original.balance.signedBalance, '108');
    assert.equal(original.postedSnapshotSha256, invoice.postedSnapshotSha256);
  } finally {
    await f.close();
  }
});
