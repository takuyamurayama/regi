import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  InvoiceDtoSchema,
  PaymentDtoSchema,
  financePageSchema,
} from '../../packages/core/src/finance';
import { japanDateTime } from '../../apps/web/src/finance-ui';
import { deferred, get, regressionFixture, useFixture } from './regression-support';

async function createSupplier(page: Page, store: string, name: string) {
  await page.goto(`/purchases/suppliers?storeId=${store}`);
  await expect(page.getByRole('heading', { name: '仕入先', level: 1, exact: true })).toBeVisible();
  await page.getByLabel('仕入先コード', { exact: true }).fill(`TEST-${randomUUID()}`);
  await page.getByLabel('仕入先名称', { exact: true }).fill(name);
  await page.getByLabel('住所', { exact: true }).fill('合成試験の架空住所');
  await page.getByRole('button', { name: '仕入先を保存', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `「${name}」を保存しました。` }),
  ).toBeVisible();
}

test('仕入画面で混在税率の下書きを確定し支払の応答切断後も同じ操作IDで残高と原請求を守る', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  const name = `合成仕入先 ${randomUUID()}`;
  await createSupplier(page, fixture.stores.recovery, name);
  await page.goto(`/purchases/invoices?storeId=${fixture.stores.recovery}`);
  await page.getByRole('button', { name: '請求の下書きを作成', exact: true }).click();
  await page.getByRole('combobox', { name: '仕入先', exact: true }).selectOption({ label: name });
  await page
    .getByRole('combobox', { name: '書類の種類', exact: true })
    .selectOption('buyer-statement');
  await page.getByLabel('原請求番号', { exact: true }).fill('合成原請求-3280');
  const local = japanDateTime(),
    day = local.slice(0, 10);
  await page.getByLabel('原請求日', { exact: true }).fill(day);
  await page.getByLabel('支払期日', { exact: true }).fill(day);
  await page.getByLabel('原書類の買手名称', { exact: true }).fill('合成試験の架空購入法人');
  const first = page.locator('.finance-line-card').nth(0);
  await first.getByLabel('品目名称', { exact: true }).fill('合成軽減対象の米');
  await first.getByLabel('実取引日', { exact: true }).fill(day);
  await first.getByLabel('数量', { exact: true }).fill('10');
  await first.getByLabel('単価（円）', { exact: true }).fill('100');
  await first.getByLabel('税率（%）', { exact: true }).fill('8');
  await first.getByLabel('軽減税率対象', { exact: true }).check();
  await first
    .getByLabel('入荷記録と未照合の理由', { exact: true })
    .fill('画面・税額の合成試験、入荷は創作しない');
  await page.getByRole('button', { name: '明細を追加', exact: true }).click();
  const second = page.locator('.finance-line-card').nth(1);
  await second.getByLabel('品目名称', { exact: true }).fill('合成標準税率の資材');
  await second.getByLabel('実取引日', { exact: true }).fill(day);
  await second.getByLabel('数量', { exact: true }).fill('10');
  await second.getByLabel('単価（円）', { exact: true }).fill('200');
  await second
    .getByLabel('入荷記録と未照合の理由', { exact: true })
    .fill('画面・税額の合成試験、入荷は創作しない');
  await page.getByRole('button', { name: '明細・税額をプレビュー', exact: true }).click();
  await expect(
    page.locator('.finance-summary').filter({ hasText: '明細からの計算額' }),
  ).toContainText('3,280円');
  await page.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/invoices\/[0-9a-f-]{36}\?/);
  const invoiceId = new URL(page.url()).pathname.split('/').at(-1);
  expect(invoiceId).toBeTruthy();
  await page.getByLabel('実際の債務計上・取消日時（日本時間）', { exact: true }).fill(local);
  await page.getByRole('button', { name: '買掛 3,280円を確定', exact: true }).click();
  await expect(page.locator('.finance-section-header')).toContainText('確定済み');
  await expect(
    page.getByRole('heading', { name: '仕入先による明細確認', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('仕入先の確認待ち', { exact: true })).toBeVisible();
  const ids: string[] = [],
    committed = deferred<void>();
  await page.route('**/v1/purchase-payments', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body: unknown = route.request().postDataJSON();
    ids.push(z.object({ operationId: z.uuid() }).parse(body).operationId);
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    if (ids.length === 1) {
      committed.resolve();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  const payments = page
    .locator('.finance-card')
    .filter({ has: page.getByRole('heading', { name: '支払記録', exact: true }) });
  await payments.getByLabel('実際に支払った金額（円）', { exact: true }).fill('1000');
  await payments.getByLabel('実際の支払日時（日本時間）', { exact: true }).fill(local);
  await payments.getByRole('combobox', { name: '支払方法', exact: true }).selectOption('cash');
  await payments.getByRole('button', { name: '支払を記録', exact: true }).click();
  await committed.promise;
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  await payments.getByRole('button', { name: '支払を記録', exact: true }).click();
  await expect(
    payments.getByRole('status').filter({ hasText: '支払 1,000円を記録しました。' }),
  ).toBeVisible();
  const actual = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoiceId}?storeId=${fixture.stores.recovery}`,
    InvoiceDtoSchema,
  );
  expect(actual.balance.originalGross).toBe('3280');
  expect(actual.balance.payableAmount).toBe('2280');
  expect(actual.ledger.map((entry) => entry.signedAmount)).toEqual(['3280', '-1000']);
  const recorded = await get(
    request,
    fixture,
    `/v1/purchase-payments?storeId=${fixture.stores.recovery}&invoiceId=${invoiceId}`,
    financePageSchema(PaymentDtoSchema),
  );
  expect(recorded.items).toHaveLength(1);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  await page.reload();
  await expect(page.locator('.finance-summary').first()).toContainText('3,280円');
  await expect(page.locator('.finance-summary').first()).toContainText('2,280円');
  await page.screenshot({
    path: '.context/ui-acceptance/finance-invoice-payment.png',
    fullPage: true,
  });
});

test('仕入画面は無効な数量と日本暦日を保持し未確定の原請求を0円確定として表示しない', async ({
  page,
}) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  const name = `無効入力の合成仕入先 ${randomUUID()}`;
  await createSupplier(page, fixture.stores.recovery, name);
  await page.goto(`/purchases/invoices?storeId=${fixture.stores.recovery}`);
  await page.getByRole('button', { name: '請求の下書きを作成', exact: true }).click();
  await page.getByRole('combobox', { name: '仕入先', exact: true }).selectOption({ label: name });
  const line = page.locator('.finance-line-card').first();
  await line.getByLabel('品目名称', { exact: true }).fill('入力拒否の合成試験');
  await line.getByLabel('実取引日', { exact: true }).fill(japanDateTime().slice(0, 10));
  await line.getByLabel('単価（円）', { exact: true }).fill('100');
  await line.getByLabel('数量', { exact: true }).fill('0');
  await page.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '数量は1〜10,000' })).toBeVisible();
  await expect(line.getByLabel('数量', { exact: true })).toHaveValue('0');
  await expect(page.getByRole('button', { name: /買掛.*確定/ })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/purchases/invoices');
  await page.screenshot({
    path: '.context/ui-acceptance/finance-invalid-quantity.png',
    fullPage: true,
  });
});
