import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
test('商品登録 → 発注承認 → 発行 → 分納入荷 → 在庫表示', async ({ page }) => {
  const suffix = Date.now().toString();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '商品・価格', exact: true })
    .click();
  await page.getByLabel('SKU', { exact: true }).fill(`E2E-${suffix}`);
  await page.getByLabel('商品名', { exact: true }).fill(`検証商品 ${suffix}`);
  await page.getByLabel('JAN', { exact: true }).fill(`JAN${suffix}`);
  await page.getByLabel('単価（円）').fill('110');
  await page.getByLabel('標準原価（円）').fill('60');
  await page.getByRole('button', { name: '商品を登録', exact: true }).click();
  await expect(page.getByRole('cell', { name: `E2E-${suffix}`, exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '発注・入荷', exact: true })
    .click();
  await page.getByLabel('商品検索', { exact: true }).fill(suffix);
  await page.getByLabel('仕入先').fill(`検証仕入先 ${suffix}`);
  await page.getByLabel('商品', { exact: true }).selectOption({ label: `検証商品 ${suffix}` });
  await page.getByLabel('数量', { exact: true }).fill('10');
  await page.getByRole('button', { name: '下書き作成', exact: true }).click();
  const order = page.locator('.purchase-order').filter({ hasText: `検証仕入先 ${suffix}` });
  await expect(order).toContainText('draft');
  await order.getByRole('button', { name: '承認', exact: true }).click();
  await expect(order).toContainText('approved');
  await order.getByRole('button', { name: '発行', exact: true }).click();
  await expect(order).toContainText('issued');
  await page.getByLabel('数量', { exact: true }).fill('4');
  await order.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect(order).toContainText('4 / 10 入荷');
  await expect(order).toContainText('partial');
  const requested = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/exports' && response.request().method() === 'POST',
  );
  await order.getByRole('button', { name: '発注書PDF', exact: true }).click();
  const job = await (await requested).json();
  const exportRow = page.locator(`[data-export-id="${job.id}"]`);
  await expect(exportRow).toBeVisible();
  await expect(exportRow).toContainText('発注書PDF');
  await expect(exportRow).toContainText('作成完了', { timeout: 15000 });
  const downloading = page.waitForEvent('download');
  await exportRow.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const download = await downloading;
  expect(await download.failure()).toBeNull();
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  const extracted = spawnSync('pdftotext', ['-layout', '-', '-'], {
    input: bytes,
    encoding: 'utf8',
  });
  expect(extracted.status, extracted.stderr).toBe(0);
  expect(extracted.stdout).toContain('発注金額 合計');
  expect(extracted.stdout).toContain(`検証仕入先 ${suffix} 御中`);
  expect(extracted.stdout).toContain('600 円');
  expect(extracted.stdout).not.toContain('0%');
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '在庫・移動', exact: true })
    .click();
  const row = page.getByRole('row').filter({ hasText: `検証商品 ${suffix}` });
  await expect(row).toContainText('4');
  await page.screenshot({ path: '.context/web-inventory.png', fullPage: true });
});
test('担当外店舗・レジ担当の管理操作は拒否', async ({ request }) => {
  const headers = {
    'x-tenant-id': '10000000-0000-4000-8000-000000000001',
    'x-staff-subject': 'local-cashier',
  };
  const response = await request.get(
    '/v1/reports/sales?storeId=20000000-0000-4000-8000-000000000002',
    { headers },
  );
  expect(response.status()).toBe(403);
  const adjustment = await request.post('/v1/inventory/adjustments', {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      storeId: '20000000-0000-4000-8000-000000000001',
      productId: '50000000-0000-4000-8000-000000000001',
      quantity: 1,
      reason: 'unauthorized',
    },
  });
  expect(adjustment.status()).toBe(403);
});
test('ダッシュボード画面を保存', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('店舗の現在地を、ひと目で。')).toBeVisible();
  await page.screenshot({ path: '.context/web-dashboard.png', fullPage: true });
});
test('二明細発注で第二明細だけ分納し、二明細売上の第二明細を返品する', async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(),
    headers = {
      'x-tenant-id': '10000000-0000-4000-8000-000000000001',
      'x-staff-subject': 'local-admin',
    },
    storeId = '20000000-0000-4000-8000-000000000001';
  const command = async (path: string, body: any) => {
    const response = await request.post(path, {
      headers,
      data: { operationId: crypto.randomUUID(), storeId, ...body },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const first = await command('/v1/products', {
      sku: `BROWSER-A-${suffix}`,
      name: `複数商品A ${suffix}`,
      price: '110',
      cost: '50',
      taxCode: 'standard',
      stockManaged: true,
      effectiveAt: new Date().toISOString(),
    }),
    second = await command('/v1/products', {
      sku: `BROWSER-B-${suffix}`,
      name: `複数商品B ${suffix}`,
      price: '220',
      cost: '40',
      taxCode: 'standard',
      stockManaged: true,
      effectiveAt: new Date().toISOString(),
    });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '発注・入荷', exact: true })
    .click();
  await page.getByLabel('仕入先', { exact: true }).fill(`複数仕入先 ${suffix}`);
  await page.getByLabel('商品', { exact: true }).selectOption({ label: `複数商品A ${suffix}` });
  await page.getByLabel('数量', { exact: true }).fill('3');
  await page.getByRole('button', { name: '明細を追加', exact: true }).click();
  await page.getByLabel('商品', { exact: true }).selectOption({ label: `複数商品B ${suffix}` });
  await page.getByLabel('数量', { exact: true }).fill('4');
  await page.getByRole('button', { name: '明細を追加', exact: true }).click();
  await page.getByRole('button', { name: '下書き作成', exact: true }).click();
  const order = page.locator('.purchase-order').filter({ hasText: `複数仕入先 ${suffix}` });
  await order.getByRole('button', { name: '承認', exact: true }).click();
  await order.getByRole('button', { name: '発行', exact: true }).click();
  await order.getByLabel('入荷数量 2', { exact: true }).fill('2');
  await order.getByRole('button', { name: '指定数量を入荷', exact: true }).click();
  await expect(order).toContainText('0 / 3 入荷');
  await expect(order).toContainText('2 / 4 入荷');
  const settings = await (await request.get('/v1/settings', { headers })).json();
  let device = settings.devices.find((entry: any) => entry.name === 'ブラウザー返品試験');
  if (!device) device = await command('/v1/devices/enroll', { name: 'ブラウザー返品試験' });
  await command(`/v1/devices/${device.id}/status`, { stopped: false, pending: 0 });
  const shifts = await (
    await request.get(`/v1/documents/shift?storeId=${storeId}`, { headers })
  ).json();
  let shift = shifts.find(
    (entry: any) => entry.body.deviceId === device.id && entry.status === 'open',
  );
  if (!shift)
    shift = await command('/v1/shifts', { deviceId: device.id, opening: '1000', pin: '1234' });
  const boot = await (
    await request.get(`/v1/sync/bootstrap?deviceId=${device.id}`, { headers })
  ).json();
  const saleId = crypto.randomUUID();
  const event = {
    id: saleId,
    deviceId: device.id,
    leaseId: boot.leaseId,
    sequence: (BigInt(boot.sequence) + 1n).toString(),
    staffId: '30000000-0000-4000-8000-000000000001',
    occurredAt: new Date().toISOString(),
    ruleVersion: 'regi-1',
    type: 'sale',
    body: {
      mode: 'inclusive',
      discount: '0',
      total: '550',
      method: 'card',
      reference: 'BROWSER-SUCCESS',
      shiftId: shift.id,
      lines: [
        {
          productId: first.id,
          name: `複数商品A ${suffix}`,
          quantity: 1,
          price: '110',
          discount: '0',
          rateBps: 1000,
          cost: '50',
          stockManaged: true,
        },
        {
          productId: second.id,
          name: `複数商品B ${suffix}`,
          quantity: 2,
          price: '220',
          discount: '0',
          rateBps: 1000,
          cost: '40',
          stockManaged: true,
        },
      ],
    },
  };
  const synced = await command('/v1/sync/events', { events: [event] });
  expect(synced.results[0].status).toBe('accepted');
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '返品・取引', exact: true })
    .click();
  const sale = page.locator('.order').filter({ hasText: saleId });
  await sale.getByRole('button', { name: '返品明細を選択', exact: true }).click();
  await page.getByLabel('返品数量 2', { exact: true }).fill('1');
  await page.getByLabel('返品理由', { exact: true }).fill('第二明細を部分返品');
  await page.getByRole('button', { name: '選択明細を返品予約', exact: true }).click();
  const refunds = await (
      await request.get(`/v1/documents/refund?storeId=${storeId}`, { headers })
    ).json(),
    refund = refunds.find((entry: any) => entry.body.saleId === saleId);
  expect(refund.body.total).toBe('220');
  expect(refund.body.lines[0].index).toBe(1);
  await page.getByLabel('外部返金確認番号', { exact: true }).fill('BROWSER-REFUND-SUCCESS');
  const refundRow = page.locator('.order').filter({ hasText: refund.id });
  await refundRow.getByRole('button', { name: '返金成功を記録', exact: true }).click();
  await expect(refundRow).toContainText('confirmed');
  const remaining = await (await request.get(`/v1/sales/${saleId}/returnable`, { headers })).json();
  expect(remaining.lines.map((line: any) => line.remaining)).toEqual([1, 1]);
  await page.screenshot({ path: '.context/web-multiline-refund.png', fullPage: true });
});
