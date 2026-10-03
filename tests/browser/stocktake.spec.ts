import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
test('棚卸の複数実査・隔離承認・遅延売上再照合を画面で完結', async ({ page, request }) => {
  const fixture = JSON.parse(
      execFileSync('npx', ['tsx', 'scripts/android-fixture.ts'], {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      }),
    ),
    storeId = fixture.stores.recovery,
    deviceId = fixture.devices.recovery,
    headers = { 'x-tenant-id': fixture.tenant, 'x-staff-subject': fixture.adminSubject };
  const command = async (path: string, body: any = {}) => {
    const response = await request.post(path, {
      headers,
      data: { operationId: crypto.randomUUID(), storeId, ...body },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const products = await (await request.get('/v1/products', { headers })).json(),
    first = products[0],
    second = await command('/v1/products', {
      sku: 'COUNT-SECOND',
      name: '棚卸第二商品',
      price: '110',
      cost: '50',
      taxCode: 'standard',
      stockManaged: true,
      effectiveAt: new Date().toISOString(),
    });
  const shift = await command('/v1/shifts', { deviceId, opening: '1000', pin: '1234' }),
    boot = await (await request.get(`/v1/sync/bootstrap?deviceId=${deviceId}`, { headers })).json(),
    sale = {
      id: crypto.randomUUID(),
      deviceId,
      leaseId: boot.leaseId,
      sequence: '1',
      staffId: fixture.admin,
      occurredAt: new Date().toISOString(),
      ruleVersion: 'regi-1',
      type: 'sale',
      body: {
        mode: 'inclusive',
        discount: '0',
        total: first.price,
        method: 'card',
        reference: 'COUNT-SUCCESS',
        shiftId: shift.id,
        lines: [
          {
            productId: first.id,
            name: first.name,
            price: first.price,
            quantity: 1,
            discount: '0',
            rateBps: first.rate_bps,
            cost: first.cost,
            stockManaged: true,
          },
        ],
      },
    };
  await command(`/v1/devices/${deviceId}/status`, { stopped: true, pending: 0 });
  await page.addInitScript(
    ({ tenant, subject }) => {
      sessionStorage.setItem('regi-dev-tenant', tenant);
      sessionStorage.setItem('regi-dev-subject', subject);
    },
    { tenant: fixture.tenant, subject: fixture.adminSubject },
  );
  await page.goto(`/?storeId=${storeId}`);
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '在庫・移動', exact: true })
    .click();
  await page.getByRole('button', { name: '棚卸開始', exact: true }).click();
  await expect(page.getByLabel('棚卸記録')).not.toHaveValue('');
  const results = await command('/v1/sync/events', { events: [sale] });
  expect(results.results[0].code).toBe('STOCKTAKE_ACTIVE');
  await command(`/v1/devices/${deviceId}/status`, { stopped: true, pending: 1 });
  await page.getByRole('button', { name: '棚卸・隔離記録を再取得', exact: true }).click();
  await page.getByLabel(`実査 ${first.name}`, { exact: true }).fill('100');
  await page.getByLabel(`実査 ${second.name}`, { exact: true }).fill('75');
  await page.getByLabel('全隔離記録を原記録と照合しました').check();
  await page.getByLabel('棚卸隔離承認理由').fill('停止・原記録・二明細の実査を確認');
  const blockedConfirmation = page.waitForResponse(
    (response) => response.url().includes('/v1/stocktakes/') && response.url().endsWith('/confirm'),
  );
  await page.getByRole('button', { name: '実査全明細で棚卸確定', exact: true }).click();
  const blockedResult = (await (await blockedConfirmation).json()) as { code: string };
  expect(blockedResult.code).toBe('DEVICES_NOT_QUIET');
  await expect(page.getByLabel('棚卸記録')).not.toHaveValue('');
  const deviceStatus = (await command(`/v1/devices/${deviceId}/status`, {
    stopped: true,
    pending: 0,
    reviewCount: 1,
  })) as { pending: number; reviewCount: number };
  expect(deviceStatus.pending).toBe(0);
  expect(deviceStatus.reviewCount).toBe(1);
  await page.getByRole('button', { name: '実査全明細で棚卸確定', exact: true }).click();
  await expect(page.getByLabel('棚卸記録')).toHaveValue('');
  await page
    .getByRole('navigation', { name: '本部メニュー' })
    .getByRole('button', { name: '同期状況', exact: true })
    .click();
  const row = page.locator('.order').filter({ hasText: sale.id });
  await row
    .getByLabel('この売上の在庫減少は実査済み数量に含まれる（未チェック=含まれない）')
    .check();
  await page
    .getByPlaceholder('決済結果・原記録照合の承認理由')
    .fill('販売の在庫減少は実査数量に含まれている');
  await row.getByRole('button', { name: '理由付きで原記録を再検証' }).click();
  await expect(row).toHaveCount(0);
  const inventory = await (
    await request.get(`/v1/inventory?storeId=${storeId}`, { headers })
  ).json();
  expect(inventory.find((entry: any) => entry.product_id === first.id).quantity).toBe('100');
  expect(inventory.find((entry: any) => entry.product_id === second.id).quantity).toBe('75');
  await page.screenshot({ path: '.context/web-stocktake.png', fullPage: true });
});
