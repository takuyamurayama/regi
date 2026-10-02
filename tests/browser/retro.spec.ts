import { test, expect } from '@playwright/test';

test('白背景・細い単線枠と通常フォントで業務メニューを表示する', async ({ page }) => {
  const fontUrls: string[] = [],
    errors: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontUrls.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe('rgb(255, 255, 255)');
  const font = await page.locator('.brand-name').evaluate((element) => ({
    family: getComputedStyle(element).fontFamily,
    loaded: Array.from(document.fonts).some(
      (face) => face.family === 'DotGothic16' && face.status === 'loaded',
    ),
  }));
  expect(font.family).not.toContain('DotGothic16');
  expect(font.loaded).toBe(false);
  expect(fontUrls).toEqual([]);
  for (const selector of ['.shortcut-card', '.metric:not(.metric-featured)']) {
    const windows = await page.locator(selector).evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.borderTopStyle,
          width: style.borderTopWidth,
          radius: parseFloat(style.borderTopLeftRadius),
        };
      }),
    );
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window).toMatchObject({
        background: 'rgb(255, 255, 255)',
        border: 'solid',
        width: '1px',
      });
      expect(window.radius).toBeGreaterThanOrEqual(8);
    }
  }
  expect(
    await page
      .locator('.dashboard-hero')
      .evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe('0px');
  await expect(page.locator('.menu-cursor,.command-cursor,.guild-scene')).toHaveCount(0);
  expect(
    await page.locator('main').evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toBe('none');
  const navigation = page.getByRole('navigation', { name: '本部メニュー' });
  const selected = navigation.getByRole('button', { name: 'ダッシュボード', exact: true });
  await expect(selected).toHaveAttribute('aria-current', 'page');
  const products = navigation.getByRole('button', { name: '商品・価格', exact: true });
  await products.focus();
  await expect(products).toBeFocused();
  expect(await products.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
    'solid',
  );
  await page.keyboard.press('Enter');
  await expect(products).toHaveAttribute('aria-current', 'page');
  await expect(selected).not.toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { name: '商品・価格', level: 1, exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('ショートカットの4操作はキーボードで既存の業務画面へ進む', async ({ page }) => {
  const aiCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/ai/query')) aiCalls.push(request.url());
  });
  await page.goto('/');
  const pages = ['商品・価格', '発注・入荷', '在庫・移動', '返品・取引'];
  for (const name of pages) {
    await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
    const shortcut = page
      .getByRole('region', { name: 'ショートカット' })
      .getByRole('button', { name: name + 'へ進む', exact: true });
    await shortcut.focus();
    await expect(shortcut).toBeFocused();
    await expect(shortcut.locator('svg')).toHaveCount(2);
    for (const icon of await shortcut.locator('svg').all())
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name, level: 1, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '本部メニュー' })
      .getByRole('button', { name: 'ダッシュボード', exact: true })
      .click();
  }
  expect(aiCalls).toEqual([]);
});
