import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { businessDate } from '../../packages/core/src';

const pages = [
  '商品・価格',
  '発注・入荷',
  '在庫・移動',
  '返品・取引',
  '開局・締め',
  'AI・需要予測',
  '同期状況',
  '管理設定',
  'ダッシュボード',
];

test('支払比率と金額は実PostgreSQLの確定取引に一致する', async ({ page, request }) => {
  const fixture = JSON.parse(
    execFileSync('npx', ['tsx', 'scripts/android-fixture.ts'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    }),
  );
  const storeId = fixture.stores.recovery,
    deviceId = fixture.devices.recovery,
    headers = { 'x-tenant-id': fixture.tenant, 'x-staff-subject': fixture.adminSubject };
  const command = async (path: string, body: any) => {
    const response = await request.post(path, {
      headers,
      data: { operationId: crypto.randomUUID(), storeId, ...body },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const productsResponse = await request.get('/v1/products', { headers });
  expect(productsResponse.ok()).toBeTruthy();
  const product = (await productsResponse.json())[0],
    shift = await command('/v1/shifts', { deviceId, opening: '1000', pin: '1234' });
  const bootResponse = await request.get(`/v1/sync/bootstrap?deviceId=${deviceId}`, { headers });
  expect(bootResponse.ok()).toBeTruthy();
  const boot = await bootResponse.json(),
    occurredAt = new Date().toISOString(),
    day = businessDate(occurredAt);
  const events = ['cash', 'card', 'qr'].map((method, index) => ({
    id: crypto.randomUUID(),
    deviceId,
    leaseId: boot.leaseId,
    sequence: String(BigInt(boot.sequence) + BigInt(index + 1)),
    staffId: fixture.admin,
    occurredAt,
    ruleVersion: 'regi-1',
    type: 'sale',
    body: {
      mode: 'inclusive',
      discount: '0',
      total: String(BigInt(product.price) * BigInt(index + 1)),
      method,
      tendered: '10000',
      reference: 'DESIGN-TEST-CONFIRMED',
      shiftId: shift.id,
      lines: [
        {
          productId: product.id,
          name: product.name,
          quantity: index + 1,
          price: product.price,
          discount: '0',
          rateBps: product.rate_bps,
          cost: product.cost,
          stockManaged: product.stock_managed,
        },
      ],
    },
  }));
  const results = await command('/v1/sync/events', { events });
  expect(results.results.map((entry: any) => entry.status)).toEqual([
    'accepted',
    'accepted',
    'accepted',
  ]);
  const reportResponse = await request.get(
    `/v1/reports/sales?storeId=${storeId}&from=${day}&to=${day}`,
    { headers },
  );
  expect(reportResponse.ok()).toBeTruthy();
  const report = await reportResponse.json();
  expect(report.total).toBe('6480');
  expect(report.payments).toEqual({ cash: '1080', card: '2160', qr: '3240' });
  await page.addInitScript(
    ({ tenant, subject }) => {
      sessionStorage.setItem('regi-dev-tenant', tenant);
      sessionStorage.setItem('regi-dev-subject', subject);
    },
    { tenant: fixture.tenant, subject: fixture.adminSubject },
  );
  await page.goto(`/?storeId=${storeId}&from=${day}&to=${day}`);
  await expect(page.locator('.metric strong').first()).toHaveText('¥6,480');
  await expect(page.locator('.metric strong').nth(3)).toHaveText('3 件');
  for (const [index, label] of ['現金', 'カード', 'QR'].entries()) {
    const meter = page.getByRole('meter', { name: label + 'の売上比率' }),
      share = [16.66, 33.33, 50][index];
    await expect(meter).toHaveAttribute('aria-valuenow', String(share));
    await expect(meter.locator('i')).toHaveAttribute('style', `width: ${share}%;`);
  }
  await expect(page.locator('.payment-heading b')).toHaveText(['¥1,080', '¥2,160', '¥3,240']);
  await page.screenshot({ path: '.context/ui-modern-payments.png', fullPage: true });
});

test('読み込み中の金額と比率を売上ゼロとして表示しない', async ({ page }) => {
  let releaseReport: () => void = () => {};
  let markReportReceived: () => void = () => {};
  const release = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  const reportReceived = new Promise<void>((resolve) => {
    markReportReceived = resolve;
  });
  await page.route('**/v1/reports/sales?**', async (route) => {
    const response = await route.fetch();
    markReportReceived();
    await release;
    await route.fulfill({ response });
  });
  try {
    await page.goto('/');
    await reportReceived;
    await expect(page.locator('.metric strong')).toHaveText(['—', '—', '—', '—']);
    await expect(page.locator('.payment-heading b')).toHaveText(['—', '—', '—']);
    await expect(page.locator('.payment-meter small')).toHaveText(['—', '—', '—']);
    await expect(page.getByRole('meter')).toHaveCount(0);
  } finally {
    releaseReport();
  }
  await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
  await expect(page.getByRole('meter')).toHaveCount(3);
});

test('スマホ・タブレット・デスクトップで全9画面を横崩れなく操作できる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    for (const name of pages) {
      const button = page
        .getByRole('navigation', { name: '本部メニュー' })
        .getByRole('button', { name, exact: true });
      await button.click();
      await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
      await expect(button).toHaveAttribute('aria-current', 'page');
      await page.getByRole('button', { name: '更新', exact: true }).click();
      await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
      if (name === '商品・価格') {
        const checkbox = page.getByRole('checkbox', { name: '在庫管理する', exact: true });
        const checkboxBounds = await checkbox.boundingBox(),
          labelBounds = await checkbox.locator('..').boundingBox();
        expect(checkboxBounds?.width).toBe(16);
        expect(labelBounds?.height).toBeLessThan(32);
      }
      const bounds = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(bounds.width, `${viewport.width}px / ${name}`).toBeLessThanOrEqual(bounds.viewport);
      await expect(page.locator('.error')).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '商品・価格', exact: true }).click();
  const suffix = crypto.randomUUID().slice(0, 8);
  await page.getByLabel('SKU', { exact: true }).fill(`MOBILE-${suffix}`);
  await page.getByLabel('商品名', { exact: true }).fill(`モバイル操作商品 ${suffix}`);
  await page.getByLabel('単価（円）').fill('110');
  await page.getByLabel('標準原価（円）').fill('50');
  await page.getByRole('button', { name: '商品を登録', exact: true }).click();
  await expect(page.getByRole('cell', { name: `MOBILE-${suffix}`, exact: true })).toBeVisible();
});

test('キーボードでメイン・ナビ・出力履歴へアクセスし動きを抑制できる', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.metric strong').first()).toHaveText(/^¥/);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'メインコンテンツへ' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  const button = page.getByRole('button', { name: '商品・価格', exact: true });
  await button.focus();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  expect(await button.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  );
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-current', 'page');
  const history = page.locator('.export-history'),
    summary = history.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(history).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(history).not.toHaveAttribute('open', '');
});
