import { test, expect } from '@playwright/test';
import {
  afterBrowserPaint,
  command,
  deferred,
  issuedOrder,
  receiptSchema,
  regressionFixture,
  useFixture,
} from './regression-support';

test('店舗切替後に遅い入荷履歴を別店舗の画面へ表示しない', async ({ page, request }) => {
  const fixture = regressionFixture();
  const orderA = await issuedOrder(request, fixture, fixture.stores.recovery);
  const orderB = await issuedOrder(request, fixture, fixture.stores.hold);
  const receiptA = await command(
    request,
    fixture,
    fixture.stores.recovery,
    `/v1/purchase-orders/${orderA.id}/receipts`,
    { lines: [{ index: 0, quantity: 1 }] },
    receiptSchema,
  );
  const receiptB = await command(
    request,
    fixture,
    fixture.stores.hold,
    `/v1/purchase-orders/${orderB.id}/receipts`,
    { lines: [{ index: 0, quantity: 1 }] },
    receiptSchema,
  );
  await useFixture(page, fixture);
  const received = deferred<void>(),
    release = deferred<void>();
  let held = false;
  await page.route('**/v1/documents/receipt?*', async (route) => {
    if (
      held ||
      new URL(route.request().url()).searchParams.get('storeId') !== fixture.stores.recovery
    )
      return route.continue();
    held = true;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    received.resolve();
    await release.promise;
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'x-test-delayed-receipts': 'old-a' },
    });
  });
  try {
    await page.goto(
      `/?page=${encodeURIComponent('発注・入荷')}&storeId=${fixture.stores.recovery}`,
    );
    await received.promise;
    await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.hold);
    await expect(page.locator('.receipt-record').filter({ hasText: receiptB.id })).toBeVisible();
    const completion = page.waitForResponse(
      (response) => response.headers()['x-test-delayed-receipts'] === 'old-a',
    );
    release.resolve();
    await (await completion).finished();
    await afterBrowserPaint(page);
    expect
      .soft(await page.locator('.receipt-record').filter({ hasText: receiptA.id }).count())
      .toBe(0);
    await expect(page.locator('.receipt-record').filter({ hasText: receiptB.id })).toBeVisible();
  } finally {
    release.resolve();
    await page.screenshot({ path: '.context/ui-acceptance/red-state-store.png', fullPage: true });
  }
});

test('AからBへ切り替えて戻っても古いAの読取結果を復活させない', async ({ page, request }) => {
  const fixture = regressionFixture(),
    order = await issuedOrder(request, fixture);
  const receipt = await command(
    request,
    fixture,
    fixture.stores.recovery,
    `/v1/purchase-orders/${order.id}/receipts`,
    { lines: [{ index: 0, quantity: 1 }] },
    receiptSchema,
  );
  await useFixture(page, fixture);
  const received = deferred<void>(),
    release = deferred<void>();
  let held = false,
    activeReads = 0;
  await page.route('**/v1/documents/receipt?*', async (route) => {
    if (
      held ||
      new URL(route.request().url()).searchParams.get('storeId') !== fixture.stores.recovery
    ) {
      activeReads++;
      try {
        const response = await route.fetch();
        await route.fulfill({ response });
      } finally {
        activeReads--;
      }
      return;
    }
    held = true;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    received.resolve();
    await release.promise;
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'x-test-delayed-receipts': 'old-a' },
    });
  });
  try {
    await page.goto(
      `/?page=${encodeURIComponent('発注・入荷')}&storeId=${fixture.stores.recovery}`,
    );
    await received.promise;
    await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.hold);
    await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.hold);
    const newer = await command(
      request,
      fixture,
      fixture.stores.recovery,
      `/v1/purchase-orders/${order.id}/receipts`,
      { lines: [{ index: 0, quantity: 1 }] },
      receiptSchema,
    );
    await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.recovery);
    await expect(page.locator('.receipt-record').filter({ hasText: newer.id })).toBeVisible();
    await expect(page.locator('.purchase-order').filter({ hasText: order.id })).toContainText(
      '2 / 10 入荷',
    );
    await afterBrowserPaint(page);
    await expect.poll(() => activeReads).toBe(0);
    await afterBrowserPaint(page);
    const completion = page.waitForResponse(
      (response) => response.headers()['x-test-delayed-receipts'] === 'old-a',
    );
    release.resolve();
    await (await completion).finished();
    await afterBrowserPaint(page);
    await expect(page.locator('.receipt-record').filter({ hasText: receipt.id })).toBeVisible();
    await expect(page.locator('.receipt-record').filter({ hasText: newer.id })).toBeVisible();
  } finally {
    release.resolve();
    await page.screenshot({ path: '.context/ui-acceptance/red-state-aba.png', fullPage: true });
  }
});
