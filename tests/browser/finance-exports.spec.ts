import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  EvidenceActionDtoSchema,
  FinanceExportDtoSchema,
  InvoiceActionDtoSchema,
  InvoiceDtoSchema,
  PaymentActionDtoSchema,
  SupplierDtoSchema,
} from '../../packages/core/src/finance';
import { buyerDraft, financeCommand } from './finance-support';
import {
  deferred,
  get,
  headers,
  regressionFixture,
  useFixture,
  type RegressionFixture,
} from './regression-support';
import { japanDateTime, japanInstant } from '../../apps/web/src/finance-ui';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
  'base64',
);
async function postedBuyer(request: APIRequestContext, fixture: RegressionFixture) {
  const source = await buyerDraft(request, fixture);
  const uploaded = await request.post(`/v1/purchase-invoices/${source.invoice.id}/evidence`, {
    headers: {
      ...headers(fixture),
      'content-type': 'image/png',
      'x-regi-operation-id': randomUUID(),
      'x-regi-store-id': fixture.stores.recovery,
      'x-regi-invoice-version': String(source.invoice.version),
      'x-regi-evidence-name': encodeURIComponent('合成出力の原資料.png'),
      'x-regi-evidence-role': 'supporting',
      'x-regi-evidence-method': 'uploaded-original',
    },
    data: png,
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const value: unknown = await uploaded.json(),
    evidence = EvidenceActionDtoSchema.parse(value);
  await financeCommand(
    request,
    fixture,
    `/v1/purchase-invoices/${source.invoice.id}/post`,
    {
      storeId: fixture.stores.recovery,
      expectedInvoiceVersion: evidence.invoiceVersion,
      effectiveAt: japanInstant(japanDateTime()),
      reason: null,
      taxVarianceAcceptance: null,
    },
    InvoiceActionDtoSchema,
  );
  return {
    ...source,
    evidence,
    invoice: await get(
      request,
      fixture,
      `/v1/purchase-invoices/${source.invoice.id}?storeId=${fixture.stores.recovery}`,
      InvoiceDtoSchema,
    ),
  };
}
async function downloaded(page: Page) {
  await expect(page.getByText(/出力完了/)).toBeVisible({ timeout: 20000 });
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ファイルをダウンロード', exact: true }).click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  return { bytes: await readFile(path), filename: download.suggestedFilename() };
}

test('請求PDFの出力応答が切断しても同じ要求を再確認し後日の支払を固定済み原明細に混ぜない', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const fixture = regressionFixture(),
    { invoice } = await postedBuyer(request, fixture);
  await useFixture(page, fixture);
  const committed = deferred<void>(),
    inputs: { operationId: string; asOf: string }[] = [];
  let jobId = '';
  await page.route('**/v1/exports', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const value: unknown = route.request().postDataJSON();
    inputs.push(z.object({ operationId: z.uuid(), asOf: z.string() }).parse(value));
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    const dto: unknown = await response.json();
    jobId = FinanceExportDtoSchema.parse(dto).id;
    if (inputs.length === 1) {
      committed.resolve();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await page.getByRole('button', { name: 'この条件で出力を作成', exact: true }).click();
  await committed.promise;
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  await financeCommand(
    request,
    fixture,
    '/v1/purchase-payments',
    {
      storeId: fixture.stores.recovery,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '40',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: '固定出力後の合成支払',
    },
    PaymentActionDtoSchema,
  );
  await page.getByRole('button', { name: '同じ条件で出力を再確認', exact: true }).click();
  const file = await downloaded(page);
  const job = await get(
    request,
    fixture,
    `/v1/purchase-exports/${jobId}?storeId=${fixture.stores.recovery}`,
    FinanceExportDtoSchema,
  );
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(file.bytes.length).toBe(job.bytes);
  expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(job.fileSha256);
  const text = spawnSync('pdftotext', ['-layout', '-', '-'], {
    input: file.bytes,
    encoding: 'utf8',
  });
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain('相手方確認待ち');
  expect(text.stdout).toContain('合成仕入の米');
  expect(text.stdout).toContain('軽減税率対象');
  expect(text.stdout).toContain('1,080');
  expect(text.stdout).not.toContain('固定出力後の合成支払');
  const actual = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(actual.balance.payableAmount).toBe('1040');
  expect(actual.content).toEqual(invoice.content);
});

test('関連資料一括出力を画面から取得し原ファイル全件と固定明細のSHAを照合する', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const fixture = regressionFixture(),
    { invoice, supplier, evidence } = await postedBuyer(request, fixture);
  await useFixture(page, fixture);
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await page
    .getByRole('combobox', { name: '出力内容', exact: true })
    .selectOption('purchase-finance-bundle');
  const responseEvent = page.waitForResponse(
    (response) => response.url().endsWith('/v1/exports') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'この条件で出力を作成', exact: true }).click();
  const response = await responseEvent;
  expect(response.status(), await response.text()).toBe(201);
  const value: unknown = await response.json(),
    created = FinanceExportDtoSchema.parse(value);
  await financeCommand(
    request,
    fixture,
    `/v1/suppliers/${supplier.id}`,
    {
      version: supplier.version,
      code: supplier.code,
      name: '出力固定後に変更した合成仕入先',
      address: supplier.address,
      registered: supplier.registered,
      registrationNumber: supplier.registrationNumber,
      defaultDueDays: supplier.defaultDueDays,
      active: true,
    },
    SupplierDtoSchema,
    'PATCH',
  );
  const file = await downloaded(page);
  const job = await get(
    request,
    fixture,
    `/v1/purchase-exports/${created.id}?storeId=${fixture.stores.recovery}`,
    FinanceExportDtoSchema,
  );
  expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(job.fileSha256);
  const tar = gunzipSync(file.bytes),
    files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512),
      name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/u, ''),
      size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(), 8);
    expect(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length).toBe(true);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(files.get(`evidence/${evidence.evidence.id}.png`)).toEqual(png);
  const manifestBytes = files.get('manifest.json');
  expect(manifestBytes).toBeDefined();
  const manifestValue: unknown = JSON.parse(manifestBytes!.toString());
  const manifest = z
    .object({
      sourceSnapshotSha256: z.string(),
      files: z.array(z.object({ name: z.string(), sha256: z.string(), bytes: z.number() })),
    })
    .parse(manifestValue);
  expect(manifest.sourceSnapshotSha256).toBe(job.sourceSnapshotSha256);
  for (const item of manifest.files) {
    const bytes = files.get(item.name);
    expect(bytes, item.name).toBeDefined();
    expect(bytes!.length).toBe(item.bytes);
    expect(createHash('sha256').update(bytes!).digest('hex')).toBe(item.sha256);
  }
  const snapshot = files.get('snapshot.json')!.toString();
  expect(snapshot).toContain(supplier.name);
  expect(snapshot).not.toContain('出力固定後に変更した合成仕入先');
  expect(snapshot).not.toContain('objectKey');
  expect(files.get('invoice.pdf')!.subarray(0, 5).toString()).toBe('%PDF-');
  await page.screenshot({
    path: '.context/ui-acceptance/finance-bundle-export.png',
    fullPage: true,
  });
});

test('買掛CSVは画面で確認した観測時点と条件を保持し遅れて記録した支払を混ぜない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture(),
    { invoice } = await postedBuyer(request, fixture);
  await useFixture(page, fixture);
  await page.goto(`/purchases/payables?storeId=${fixture.stores.recovery}`);
  await expect(page.locator('.finance-summary')).toContainText('1,080円');
  await financeCommand(
    request,
    fixture,
    '/v1/purchase-payments',
    {
      storeId: fixture.stores.recovery,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount: '40',
      paidAt: new Date().toISOString(),
      method: 'cash',
      reference: null,
      evidenceId: null,
      note: 'CSV観測後の合成支払',
    },
    PaymentActionDtoSchema,
  );
  await page.getByRole('button', { name: 'この条件で出力を作成', exact: true }).click();
  const file = await downloaded(page),
    csv = file.bytes.toString('utf8');
  expect(csv).toContain('原金額');
  expect(csv).toContain(invoice.id);
  expect(csv).toContain('1080');
  expect(csv).not.toContain('1040');
  await page.reload();
  await expect(page.locator('.finance-summary')).toContainText('1,040円');
});

test('買手作成明細は実際の相手名と日時と根拠資料を記録するまで仕入先確認済みにしない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture(),
    { invoice, evidence } = await postedBuyer(request, fixture);
  await useFixture(page, fixture);
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await expect(page.getByText('仕入先の確認待ち', { exact: true })).toBeVisible();
  await page.getByText('仕入先の確認を記録', { exact: true }).click();
  const proofChoice = page.getByRole('combobox', { name: '仕入先確認の資料', exact: true });
  await expect(
    proofChoice.getByRole('option', { name: '合成出力の原資料.png', exact: true }),
  ).toHaveCount(0);
  await page.getByText('原書類・関連資料（1件）', { exact: true }).click();
  await page
    .getByLabel('添付ファイル', { exact: true })
    .setInputFiles({ name: '合成仕入先の確認資料.png', mimeType: 'image/png', buffer: png });
  await page
    .getByRole('combobox', { name: '資料の用途', exact: true })
    .selectOption('supplier-confirmation');
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '「合成仕入先の確認資料.png」を添付しました。' }),
  ).toBeVisible();
  const party = page.getByLabel('確認した仕入先の相手名', { exact: true });
  const actual = page.getByLabel('実際の確認日時（日本時間）', { exact: true });
  await expect(party).toHaveValue('');
  await expect(actual).toHaveValue('');
  await party.fill('合成試験の架空確認担当');
  await actual.fill(japanDateTime());
  await page.getByRole('combobox', { name: '確認方法', exact: true }).selectOption('email');
  await page
    .getByRole('combobox', { name: '仕入先確認の資料', exact: true })
    .selectOption({ label: '合成仕入先の確認資料.png' });
  await page
    .getByLabel('確認内容の補足', { exact: true })
    .fill('実取引ではない。原明細SHA対応の画面試験');
  await page.getByRole('button', { name: '仕入先の実際の確認を記録', exact: true }).click();
  await expect(page.getByText('仕入先の確認記録あり', { exact: true })).toBeVisible();
  const recorded = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(recorded.confirmations).toHaveLength(1);
  expect(recorded.confirmations[0].postedSnapshotSha256).toBe(invoice.postedSnapshotSha256);
  expect(recorded.confirmations[0].evidenceId).toBe(
    recorded.evidence.find((item) => item.role === 'supplier-confirmation')?.id,
  );
  expect(recorded.confirmations[0].evidenceId).not.toBe(evidence.evidence.id);
  expect(recorded.confirmations[0].counterpartyName).toBe('合成試験の架空確認担当');
  expect(recorded.content).toEqual(invoice.content);
  expect(recorded.ledger.map((item) => item.signedAmount)).toEqual(['1080']);
});
