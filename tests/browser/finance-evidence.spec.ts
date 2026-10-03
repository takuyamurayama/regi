import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiErrorDtoSchema, InvoiceDtoSchema } from '../../packages/core/src/finance';
import { buyerDraft } from './finance-support';
import { deferred, get, regressionFixture, useFixture } from './regression-support';

test('原資料保存後の応答切断と画面移動でも同じ操作IDとファイルを再確認し原資料を重複させない', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const fixture = regressionFixture();
  const { invoice } = await buyerDraft(request, fixture);
  await useFixture(page, fixture);
  const committed = deferred<void>(),
    ids: string[] = [];
  await page.route(`**/v1/purchase-invoices/${invoice.id}/evidence`, async (route) => {
    ids.push(route.request().headers()['x-regi-operation-id']);
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    if (ids.length === 1) {
      committed.resolve();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await page.getByLabel('添付ファイル', { exact: true }).setInputFiles({
    name: '合成確認資料.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await committed.promise;
  await expect(page.getByRole('region', { name: '未確認の操作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '買掛・支払', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '買掛・支払', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '同じ操作を再確認', exact: true }).click();
  await expect(page.getByRole('region', { name: '未確認の操作', exact: true })).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  const actual = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(actual.evidence).toHaveLength(1);
  expect(actual.version).toBe(invoice.version + 1);
  expect(actual.evidence[0].originalName).toBe('合成確認資料.png');
  await page.getByRole('button', { name: '仕入明細・請求', exact: true }).click();
  const row = page.locator('tr').filter({ hasText: invoice.internalReference });
  await row.getByRole('button', { name: '請求の詳細', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '原ファイルを取得', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('合成確認資料.png');
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();
  const bytes = await readFile(savedPath);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(actual.evidence[0].sha256);
  expect(bytes.length).toBe(actual.evidence[0].bytes);
  await page.screenshot({
    path: '.context/ui-acceptance/finance-evidence-recovered.png',
    fullPage: true,
  });
});

test('原資料の初回拒否は未確認として固定せずファイルを修正でき金額や添付履歴を捏造しない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture();
  const { invoice } = await buyerDraft(request, fixture);
  await useFixture(page, fixture);
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  const responseEvent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/v1/purchase-invoices/${invoice.id}/evidence`),
  );
  const fileInput = page.getByLabel('添付ファイル', { exact: true });
  await fileInput.setInputFiles({
    name: 'PNG形式ではない合成資料.png',
    mimeType: 'image/png',
    buffer: Buffer.from('実際にはPNG形式ではない'),
  });
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  const rejected = await responseEvent;
  expect(rejected.status()).toBe(400);
  const rejectionBody: unknown = await rejected.json();
  expect(ApiErrorDtoSchema.parse(rejectionBody).retryable).toBe(false);
  await expect(fileInput).toBeEnabled();
  await expect(page.getByRole('region', { name: '未確認の操作', exact: true })).toHaveCount(0);
  const unchanged = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(unchanged.evidence).toHaveLength(0);
  expect(unchanged.balance.originalGross).toBeNull();
  await fileInput.setInputFiles({
    name: '修正後の合成資料.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '「修正後の合成資料.png」を添付しました。' }),
  ).toBeVisible();
  const corrected = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(corrected.evidence).toHaveLength(1);
  expect(corrected.balance.originalGross).toBeNull();
});
