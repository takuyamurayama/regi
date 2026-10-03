import { test, expect } from '@playwright/test';
import { regressionFixture, useFixture } from './regression-support';

test('画面をURLへ保存し、再読み込みで同じ業務画面へ戻る', async ({ page }) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  await page.goto(`/?storeId=${fixture.stores.recovery}&from=2026-09-01&to=2026-09-30`);
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '発注・入荷', exact: true })
    .click();
  expect.soft(new URL(page.url()).pathname).toBe('/purchases/orders');
  await page.reload();
  try {
    await expect(
      page.getByRole('heading', { name: '発注・入荷', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  } finally {
    await page.screenshot({
      path: '.context/ui-acceptance/red-routing-reload.png',
      fullPage: true,
    });
  }
});

test('旧日本語pageのURLを店舗と期間を保って正規URLへ置換する', async ({ page }) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  await page.goto(
    `/?page=${encodeURIComponent('在庫・移動')}&storeId=${fixture.stores.hold}&from=2026-09-02&to=2026-09-29`,
  );
  await expect(
    page.getByRole('heading', { name: '在庫・移動', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.hold);
  const url = new URL(page.url());
  expect.soft(url.pathname).toBe('/inventory');
  expect.soft(url.searchParams.has('page')).toBe(false);
  expect(url.searchParams.get('storeId')).toBe(fixture.stores.hold);
  expect(url.searchParams.get('from')).toBe('2026-09-02');
  expect(url.searchParams.get('to')).toBe('2026-09-29');
  await page.screenshot({ path: '.context/ui-acceptance/red-routing-legacy.png', fullPage: true });
});

test('戻ると進むで画面を復元し、履歴に新しい遷移を重ねない', async ({ page }) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  await page.goto(`/?storeId=${fixture.stores.recovery}`);
  await page.goto(`/?page=${encodeURIComponent('商品・価格')}&storeId=${fixture.stores.recovery}`);
  await expect(
    page.getByRole('heading', { name: '商品・価格', exact: true, level: 1 }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '発注・入荷', exact: true })
    .click();
  await page.goBack();
  try {
    await expect(
      page.getByRole('heading', { name: '商品・価格', exact: true, level: 1 }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole('heading', { name: '発注・入荷', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  } finally {
    await page.screenshot({
      path: '.context/ui-acceptance/red-routing-history.png',
      fullPage: true,
    });
  }
});

test('店舗と期間の変更をURLへ保存し、再読み込みで復元する', async ({ page }) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  await page.goto(`/?storeId=${fixture.stores.recovery}&from=2026-09-01&to=2026-09-30`);
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  await page.getByLabel('開始日', { exact: true }).fill('2026-09-03');
  await page.getByLabel('終了日', { exact: true }).fill('2026-09-27');
  await page.getByLabel('店舗', { exact: true }).selectOption(fixture.stores.hold);
  const url = new URL(page.url());
  expect.soft(url.searchParams.get('storeId')).toBe(fixture.stores.hold);
  expect.soft(url.searchParams.get('from')).toBe('2026-09-03');
  expect.soft(url.searchParams.get('to')).toBe('2026-09-27');
  await page.reload();
  try {
    await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.hold);
    await expect(page.getByLabel('開始日', { exact: true })).toHaveValue('2026-09-03');
    await expect(page.getByLabel('終了日', { exact: true })).toHaveValue('2026-09-27');
  } finally {
    await page.screenshot({
      path: '.context/ui-acceptance/red-routing-filters.png',
      fullPage: true,
    });
  }
});
