import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { Database, rows, sql } from '../../apps/api/src/db';
import { InvoiceActionDtoSchema, InvoiceDtoSchema } from '../../packages/core/src/finance';
import { japanDateTime } from '../../apps/web/src/finance-ui';
import { buyerDraft, financeCommand } from './finance-support';
import {
  deferred,
  afterBrowserPaint,
  get,
  regressionFixture,
  useFixture,
  type RegressionFixture,
} from './regression-support';

const pendingSchema = z.array(z.object({ id: z.uuid() }));
async function operationFacts(fixture: RegressionFixture, id: string) {
  const database = new Database();
  try {
    return await database.transaction(
      {
        tenantId: fixture.tenant,
        staffId: fixture.admin,
        role: 'admin',
        stores: Object.values(fixture.stores),
        mfa: true,
      },
      async (transaction) => {
        const [fact] = await rows<{ operations: number; audit: number }>(
          transaction,
          sql`SELECT (SELECT count(*)::int FROM operations WHERE id=${id}::uuid) AS operations,
            (SELECT count(*)::int FROM audit WHERE entity_id=${id}::uuid) AS audit`,
        );
        return fact;
      },
    );
  } finally {
    await database.client.$disconnect();
  }
}
async function pendingId(page: import('@playwright/test').Page) {
  const saved = await page.evaluate(() => sessionStorage.getItem('regi-action-intents-v1'));
  expect(saved).toBeTruthy();
  const value: unknown = JSON.parse(saved ?? 'null');
  const [entry] = pendingSchema.parse(value);
  expect(entry).toBeTruthy();
  return entry.id;
}

test('支払応答を失って再読み込みしても本人の保存結果を照会し旧版の支払を二重送信しない', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const fixture = regressionFixture();
  const draft = await buyerDraft(request, fixture);
  const posted = await financeCommand(
    request,
    fixture,
    `/v1/purchase-invoices/${draft.invoice.id}/post`,
    {
      storeId: fixture.stores.recovery,
      expectedInvoiceVersion: draft.invoice.version,
      effectiveAt: new Date(Date.now() - 60000).toISOString(),
      reason: null,
      taxVarianceAcceptance: null,
    },
    InvoiceActionDtoSchema,
  );
  const invoice = posted.invoice;
  await useFixture(page, fixture);
  const ids: string[] = [];
  await page.route('**/v1/purchase-payments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body: unknown = route.request().postDataJSON();
    ids.push(z.object({ operationId: z.uuid() }).parse(body).operationId);
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    await route.abort('failed');
  });
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  const payment = page
    .locator('.finance-card')
    .filter({ has: page.getByRole('heading', { name: '支払記録', exact: true }) });
  await payment.getByLabel('実際に支払った金額（円）', { exact: true }).fill('100');
  await payment.getByLabel('実際の支払日時（日本時間）', { exact: true }).fill(japanDateTime());
  await payment.getByRole('combobox', { name: '支払方法', exact: true }).selectOption('cash');
  await payment.getByRole('button', { name: '支払を記録', exact: true }).click();
  await expect(page.getByRole('region', { name: '未確認の操作', exact: true })).toBeVisible();
  const id = await pendingId(page);
  await page.reload();
  await expect(page.locator('.finance-summary').first()).toContainText('980円');
  await payment.getByLabel('実際に支払った金額（円）', { exact: true }).fill('100');
  await payment.getByLabel('実際の支払日時（日本時間）', { exact: true }).fill(japanDateTime());
  await payment.getByRole('combobox', { name: '支払方法', exact: true }).selectOption('cash');
  await payment.getByRole('button', { name: '支払を記録', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '先の操作の結果が未確認' })).toBeVisible();
  expect(ids).toEqual([id]);
  const recovery = page.getByRole('region', { name: '未確認の操作', exact: true });
  await expect(recovery.getByRole('button', { name: '保存結果を照会', exact: true })).toBeVisible();
  // The actual other-store 404 cannot prove that the original operation did not commit.
  await page.route(`**/v1/operations/${id}/status?storeId=*`, async (route) => {
    const changed = new URL(route.request().url());
    changed.searchParams.set('storeId', fixture.stores.hold);
    const response = await route.fetch({ url: changed.toString() });
    expect(response.status()).toBe(404);
    await route.fulfill({ response });
  });
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '操作状態を確認できません' }),
  ).toBeVisible();
  expect(await pendingId(page)).toBe(id);
  await page.unroute(`**/v1/operations/${id}/status?storeId=*`);
  // Prepare real browser history so navigation remains available while the request is in flight.
  await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.hold);
  await page.goBack();
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  const ready = deferred<void>(),
    release = deferred<void>();
  await page.route(`**/v1/operations/${id}/status?storeId=*`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    ready.resolve();
    await release.promise;
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'x-test-delayed-operation': 'old' },
    });
  });
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await ready.promise;
  await page.goForward();
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.hold);
  await page.goBack();
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  const completion = page.waitForResponse(
    (response) => response.headers()['x-test-delayed-operation'] === 'old',
  );
  release.resolve();
  await (await completion).finished();
  await afterBrowserPaint(page);
  await expect(recovery).toBeVisible();
  expect(await pendingId(page)).toBe(id);
  await page.unroute(`**/v1/operations/${id}/status?storeId=*`);
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: '保存済み・原記録の再取得' }),
  ).toBeVisible();
  await expect(page.locator('.finance-summary').first()).toContainText('980円');
  await payment.getByLabel('実際に支払った金額（円）', { exact: true }).fill('100');
  await payment.getByLabel('実際の支払日時（日本時間）', { exact: true }).fill(japanDateTime());
  await payment.getByRole('combobox', { name: '支払方法', exact: true }).selectOption('cash');
  await payment.getByRole('button', { name: '支払を記録', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '保存済みです' })).toBeVisible();
  expect(ids).toEqual([id]);
  const original = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(original.balance.payableAmount).toBe('980');
  expect(original.ledger.map((entry) => entry.signedAmount)).toEqual(['1080', '-100']);
  expect(await operationFacts(fixture, id)).toEqual({ operations: 1, audit: 1 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({
    path: '.context/ui-acceptance/finance-payment-reload-recovery.png',
    fullPage: true,
  });
});

test('原資料応答を失って再読み込みしてもファイルを永続化せず保存結果照会から元SHAの添付を再取得する', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture();
  const { invoice } = await buyerDraft(request, fixture);
  await useFixture(page, fixture);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
    'base64',
  );
  const ids: string[] = [];
  await page.route(`**/v1/purchase-invoices/${invoice.id}/evidence`, async (route) => {
    ids.push(route.request().headers()['x-regi-operation-id']);
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    await route.abort('failed');
  });
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await page
    .getByLabel('添付ファイル', { exact: true })
    .setInputFiles({ name: '再読み込み検証合成資料.png', mimeType: 'image/png', buffer: bytes });
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await expect(page.getByRole('region', { name: '未確認の操作', exact: true })).toBeVisible();
  const id = await pendingId(page);
  const serialized = await page.evaluate(() => sessionStorage.getItem('regi-action-intents-v1'));
  expect(serialized).not.toContain('再読み込み検証合成資料');
  expect(serialized).not.toContain(bytes.toString('base64'));
  await page.reload();
  const recovery = page.getByRole('region', { name: '未確認の操作', exact: true });
  await recovery.getByRole('button', { name: '同じ操作を再確認', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '再読み込み前の入力は保存していません' }),
  ).toBeVisible();
  expect(await pendingId(page)).toBe(id);
  await expect(recovery.getByRole('button', { name: '保存結果を照会', exact: true })).toBeVisible();
  await page.route(`**/v1/operations/${id}/status?storeId=*`, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'ROLE_FORBIDDEN',
        message: '操作状態を確認できません',
        retryable: false,
      }),
    }),
  );
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ROLE_FORBIDDEN' })).toBeVisible();
  expect(await pendingId(page)).toBe(id);
  await page.unroute(`**/v1/operations/${id}/status?storeId=*`);
  await page.route(`**/v1/operations/${id}/status?storeId=*`, (route) => route.abort('failed'));
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  expect(await pendingId(page)).toBe(id);
  await page.unroute(`**/v1/operations/${id}/status?storeId=*`);
  await recovery.getByRole('button', { name: '保存結果を照会', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: '保存済み・原記録の再取得' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').getByText('再読み込み検証合成資料.png', { exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '原ファイルを取得', exact: true }).click();
  const download = await downloadEvent;
  const downloaded = await readFile(await download.path());
  expect(downloaded).toEqual(bytes);
  await page.getByLabel('添付ファイル', { exact: true }).setInputFiles({
    name: '再読み込み検証合成資料.png',
    mimeType: 'image/png',
    buffer: bytes,
  });
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '保存済みです' })).toBeVisible();
  expect(ids).toEqual([id]);
  const original = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(original.evidence).toHaveLength(1);
  expect(original.evidence[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(original.version).toBe(invoice.version + 1);
  expect(original.ledger).toHaveLength(0);
  expect(await operationFacts(fixture, id)).toEqual({ operations: 1, audit: 1 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({
    path: '.context/ui-acceptance/finance-evidence-reload-recovery.png',
    fullPage: true,
  });
});
