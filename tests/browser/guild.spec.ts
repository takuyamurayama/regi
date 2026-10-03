import { test, expect, type Page } from '@playwright/test';

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((channel) => {
        const value = Number(channel) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort(
    (first, second) => second - first,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function assertTextContrast(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const elements = page.locator(selector);
    expect(await elements.count(), selector).toBeGreaterThan(0);
    const colors = await elements.evaluateAll((entries) =>
      entries.map((element) => {
        let ancestor: Element | null = element;
        let background = getComputedStyle(document.documentElement).backgroundColor;
        while (ancestor) {
          const color = getComputedStyle(ancestor).backgroundColor;
          const channels = color.match(/[\d.]+/g)!;
          const alpha = channels.length === 4 ? Number(channels[3]) : 1;
          if (alpha > 0) {
            if (alpha !== 1) throw new Error('半透明背景は合成後のコントラスト測定が必要です');
            background = color;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        return {
          foreground: getComputedStyle(element).color,
          background,
          text: element.textContent?.trim().slice(0, 50),
        };
      }),
    );
    for (const color of colors)
      expect(
        contrast(color.foreground, color.background),
        `${selector}: ${color.text}`,
      ).toBeGreaterThanOrEqual(4.5);
  }
}

test('白いモダン画面は光るAI装飾なしで実際の予測画面へ遷移する', async ({ page }) => {
  const aiCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/ai/query')) aiCalls.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
  await expect(page.getByText('店舗の状況', { exact: true })).toBeVisible();
  await expect(page.locator('.store-illustration')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.store-illustration svg')).toHaveAttribute('focusable', 'false');
  await expect(page.locator('.ai-orb')).toHaveCount(0);
  await expect(page.getByText('REGI INTELLIGENCE', { exact: true })).toHaveCount(0);
  const panel = await page.locator('.dashboard-strategy').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundImage: style.backgroundImage,
      filter: style.filter,
      backdropFilter: style.backdropFilter,
    };
  });
  expect(panel).toEqual({ backgroundImage: 'none', filter: 'none', backdropFilter: 'none' });
  const colors = await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        foreground: getComputedStyle(element).color,
        background:
          element.getAttribute('aria-current') === 'page'
            ? getComputedStyle(element).backgroundColor
            : getComputedStyle(element.closest('aside')!).backgroundColor,
      })),
    );
  for (const color of colors)
    expect(contrast(color.foreground, color.background)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: '需要予測・発注提案を見る', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AI・需要予測', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('AI質問', { exact: true })).toBeVisible();
  await expect(page.getByText(/日本時間の暦月ごとに5,000回/)).toBeVisible();
  await expect(page.getByText(/履歴不足・精度不足は基準在庫方式/)).toBeVisible();
  expect(aiCalls).toEqual([]);
});

test('白基調の画面で金額・説明・フォーム・実APIエラーを読める', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    'light',
  );
  await assertTextContrast(page, [
    '.metric strong',
    '.metric label',
    '.metric small',
    '.dashboard-title h2',
    '.dashboard-title .eyebrow',
    '.dashboard-title p',
    '.payment-heading',
    '.payment-meter small',
    '.card-footnote',
    '.dashboard-strategy .tag',
    '.tag small',
    '.dashboard-strategy h3',
    '.dashboard-strategy p',
    '.strategy-availability',
    '.dashboard-strategy button',
    '.transactions-card th',
    '.transactions-card td',
    '.store-selector select',
    '.date-range-label',
    '.dates input',
  ]);
  await page.getByRole('button', { name: '商品・価格', exact: true }).click();
  await expect(page.getByRole('button', { name: '商品を登録', exact: true })).toBeEnabled();
  await assertTextContrast(page, [
    '.form-grid label',
    '.form-grid input:not([type="checkbox"])',
    '.form-grid select',
    '.primary',
  ]);
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/products' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '商品を登録', exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(page.getByRole('alert')).toBeVisible();
  await assertTextContrast(page, ['.error']);
});
