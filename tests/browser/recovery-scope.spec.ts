import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { regressionFixture, useFixture, issuedOrder } from './regression-support';

test('未確認操作の店舗から移動しても元店舗への復旧案内を消さない', async ({ page, request }) => {
  const fixture = regressionFixture(),
    order = await issuedOrder(request, fixture);
  await useFixture(page, fixture);
  await page.route(`**/v1/purchase-orders/${order.id}/receipts`, async (route) => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort('failed');
  });
  await page.goto(`/purchases/orders?storeId=${fixture.stores.recovery}`);
  const row = page.locator('.purchase-order').filter({ hasText: order.id });
  await expect(row).toContainText('issued');
  await row.getByLabel('入荷数量 1', { exact: true }).fill('4');
  await row.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.hold);
  await expect(page.getByRole('region', { name: '別店舗の未確認操作' })).toContainText(
    'recovery試験店',
  );
  await page
    .getByRole('region', { name: '別店舗の未確認操作' })
    .getByRole('button', { name: '元の店舗で操作を確認', exact: true })
    .click();
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  await expect(page.getByRole('region', { name: '未確認の操作' })).toBeVisible();
});

test('所属外の有効な店舗UUIDのURLは店舗を置換せず表示と送信を止める', async ({ page }) => {
  const fixture = regressionFixture(),
    foreign = randomUUID();
  await useFixture(page, fixture);
  await page.goto(`/products?storeId=${foreign}`);
  await expect(
    page.getByRole('heading', { level: 1, name: '商品・価格', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: '所属店舗とURLを確認してください' }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('storeId')).toBe(foreign);
  await expect(page.getByLabel('店舗', { exact: true })).not.toHaveValue(fixture.stores.recovery);
  await expect(page.getByRole('button', { name: '商品を登録', exact: true })).toBeDisabled();
});
