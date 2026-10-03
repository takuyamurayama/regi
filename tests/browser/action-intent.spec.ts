import { test, expect } from '@playwright/test';
import { z } from 'zod';
import {
  command,
  deferred,
  documentSchema,
  get,
  issuedOrder,
  mutationFacts,
  receiptSchema,
  regressionFixture,
  useFixture,
} from './regression-support';

const operationSchema = z.object({ operationId: z.uuid() });
const inventorySchema = z.array(z.object({ product_id: z.uuid(), quantity: z.string() }));

test('入荷のcommit後に応答が失われても同じ操作IDの再送で入荷を重ねない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture(),
    order = await issuedOrder(request, fixture);
  await useFixture(page, fixture);
  const committed = deferred<void>(),
    ids: string[] = [];
  await page.route(`**/v1/purchase-orders/${order.id}/receipts`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    ids.push(operationSchema.parse(body).operationId);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (ids.length === 1) {
      committed.resolve();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(`/?page=${encodeURIComponent('発注・入荷')}&storeId=${fixture.stores.recovery}`);
  const row = page.locator('.purchase-order').filter({ hasText: order.id });
  await expect(row).toContainText('issued');
  await row.getByLabel('入荷数量 1', { exact: true }).fill('4');
  await row.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await committed.promise;
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  const receiptsBeforeRetry = await get(
    request,
    fixture,
    `/v1/documents/receipt?storeId=${fixture.stores.recovery}`,
    z.array(receiptSchema),
  );
  expect(receiptsBeforeRetry.filter((receipt) => receipt.body.orderId === order.id)).toHaveLength(
    1,
  );
  await row.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  const receipts = await get(
    request,
    fixture,
    `/v1/documents/receipt?storeId=${fixture.stores.recovery}`,
    z.array(receiptSchema),
  );
  const inventory = await get(
    request,
    fixture,
    `/v1/inventory?storeId=${fixture.stores.recovery}`,
    inventorySchema,
  );
  expect.soft(ids).toHaveLength(2);
  expect.soft(ids[1]).toBe(ids[0]);
  expect.soft(receipts.filter((receipt) => receipt.body.orderId === order.id)).toHaveLength(1);
  expect.soft(inventory.find((entry) => entry.product_id === order.productId)?.quantity).toBe('4');
  expect
    .soft(await mutationFacts(fixture, fixture.stores.recovery, 'receipt.create'))
    .toEqual({ operations: '1', audit: '1' });
  await page.screenshot({ path: '.context/ui-acceptance/red-intent-receipt.png', fullPage: true });
});

test('現金記録の応答が失われても再確認で原記録と監査を重複しない', async ({ page, request }) => {
  const fixture = regressionFixture();
  const shift = await command(
    request,
    fixture,
    fixture.stores.recovery,
    '/v1/shifts',
    { deviceId: fixture.devices.recovery, opening: '1000', pin: '1234' },
    documentSchema,
  );
  await useFixture(page, fixture);
  const committed = deferred<void>(),
    ids: string[] = [];
  await page.route('**/v1/cash-movements', async (route) => {
    const body: unknown = route.request().postDataJSON();
    ids.push(operationSchema.parse(body).operationId);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (ids.length === 1) {
      committed.resolve();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(`/?page=${encodeURIComponent('開局・締め')}&storeId=${fixture.stores.recovery}`);
  await page.getByLabel('開局記録', { exact: true }).selectOption(shift.id);
  await page.getByLabel('現金額', { exact: true }).fill('500');
  await page.getByPlaceholder('現金移動理由').fill('実際に受け取った準備金の追加');
  await page.getByRole('button', { name: '現金入金', exact: true }).click();
  await committed.promise;
  await expect(
    page.getByRole('alert').filter({ hasText: 'サーバーとの通信に失敗しました' }),
  ).toBeVisible();
  expect(
    await get(
      request,
      fixture,
      `/v1/documents/cash?storeId=${fixture.stores.recovery}`,
      z.array(documentSchema),
    ),
  ).toHaveLength(1);
  await page.getByRole('button', { name: '現金入金', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  const records = await get(
    request,
    fixture,
    `/v1/documents/cash?storeId=${fixture.stores.recovery}`,
    z.array(documentSchema),
  );
  expect.soft(ids).toHaveLength(2);
  expect.soft(ids[1]).toBe(ids[0]);
  expect.soft(records).toHaveLength(1);
  expect
    .soft(await mutationFacts(fixture, fixture.stores.recovery, 'cash.record'))
    .toEqual({ operations: '1', audit: '1' });
  await page.screenshot({ path: '.context/ui-acceptance/red-intent-cash.png', fullPage: true });
});

test('保存後の一覧取得失敗を未保存として再実行しない', async ({ page, request }) => {
  const fixture = regressionFixture(),
    order = await issuedOrder(request, fixture);
  await useFixture(page, fixture);
  let writes = 0,
    failNextRead = false,
    failedRead = false;
  await page.route(`**/v1/purchase-orders/${order.id}/receipts`, async (route) => {
    writes++;
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (writes === 1) failNextRead = true;
    await route.fulfill({ response });
  });
  await page.route('**/v1/documents/purchase-order?*', async (route) => {
    if (!failNextRead) return route.continue();
    failNextRead = false;
    failedRead = true;
    await route.fulfill({
      status: 503,
      contentType: 'text/html',
      body: '<html>Temporary read failure</html>',
    });
  });
  await page.goto(`/?page=${encodeURIComponent('発注・入荷')}&storeId=${fixture.stores.recovery}`);
  const row = page.locator('.purchase-order').filter({ hasText: order.id });
  await expect(row).toContainText('issued');
  await row.getByLabel('入荷数量 1', { exact: true }).fill('4');
  await row.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect.poll(() => failedRead).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP 503' })).toBeVisible();
  expect(
    await get(
      request,
      fixture,
      `/v1/documents/receipt?storeId=${fixture.stores.recovery}`,
      z.array(receiptSchema),
    ),
  ).toHaveLength(1);
  await row.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  expect.soft(writes).toBe(1);
  expect
    .soft(
      await get(
        request,
        fixture,
        `/v1/documents/receipt?storeId=${fixture.stores.recovery}`,
        z.array(receiptSchema),
      ),
    )
    .toHaveLength(1);
  expect
    .soft(await mutationFacts(fixture, fixture.stores.recovery, 'receipt.create'))
    .toEqual({ operations: '1', audit: '1' });
  await page.screenshot({ path: '.context/ui-acceptance/red-intent-refresh.png', fullPage: true });
});
