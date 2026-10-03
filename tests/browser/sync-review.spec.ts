import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { syncFixture } from '../sync-fixture';

async function reviewFixture() {
  const fixture = await syncFixture();
  try {
    const invalid = { ...fixture.sale, body: { ...fixture.sale.body, total: '999' } };
    expect(
      (await fixture.business.events(fixture.admin, { events: [invalid] })).results[0].status,
    ).toBe('review');
    expect(
      (
        await fixture.business.events(fixture.admin, {
          events: [{ ...invalid, body: { ...invalid.body, total: '998' } }],
        })
      ).results[0].status,
    ).toBe('review');
    const waiting = {
      ...fixture.sale,
      id: randomUUID(),
      sequence: '2',
      body: { ...fixture.sale.body, shiftId: randomUUID() },
    };
    expect(
      (await fixture.business.events(fixture.admin, { events: [waiting] })).results[0].code,
    ).toBe('SYNC_DEPENDENCY');
    await fixture.business.deviceStatus(fixture.admin, fixture.device, {
      operationId: randomUUID(),
      storeId: fixture.store,
      pending: 0,
      reviewCount: 2,
      stopped: true,
    });
    return { ...fixture, waiting };
  } finally {
    await fixture.database.client.$disconnect();
  }
}

test('同期画面は依存待ちと要確認を区別し端末の未送信と要確認を別表示する', async ({ page }) => {
  const fixture = await reviewFixture();
  await page.addInitScript(
    ({ tenant }) => {
      sessionStorage.setItem('regi-dev-tenant', tenant);
      sessionStorage.setItem('regi-dev-subject', tenant);
    },
    { tenant: fixture.admin.tenantId },
  );
  await page.goto(`/sync?storeId=${fixture.store}`);
  await expect(
    page.getByRole('heading', { name: '同期状況', level: 1, exact: true }),
  ).toBeVisible();
  try {
    const waiting = page.getByRole('article', { name: `同期イベント main ${fixture.waiting.id}` });
    await expect(waiting).toContainText('依存待ち');
    await expect(waiting).toContainText('SYNC_DEPENDENCY');
    await expect(page.getByRole('columnheader', { name: '未送信', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '要確認', exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: '同期障害端末' });
    await expect(row).toContainText('2');
  } finally {
    await page.screenshot({ path: '.context/ui-acceptance/red-sync-waiting.png', fullPage: true });
  }
});

test('同じIDの原記録と隔離記録を別々に理由付きで却下し終端状態を確認する', async ({
  page,
  request,
}) => {
  const fixture = await reviewFixture(),
    dismissals: { source: string; reason: string }[] = [];
  await page.addInitScript(
    ({ tenant }) => {
      sessionStorage.setItem('regi-dev-tenant', tenant);
      sessionStorage.setItem('regi-dev-subject', tenant);
    },
    { tenant: fixture.admin.tenantId },
  );
  await page.route(`**/v1/sync/reviews/${fixture.sale.id}/dismiss`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    expect(body).toMatchObject({ storeId: fixture.store });
    if (
      typeof body !== 'object' ||
      body === null ||
      !('source' in body) ||
      !('reason' in body) ||
      typeof body.source !== 'string' ||
      typeof body.reason !== 'string'
    )
      throw new Error('dismiss source/reason missing');
    dismissals.push({ source: body.source, reason: body.reason });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.fulfill({ response });
  });
  await page.goto(`/sync?storeId=${fixture.store}`);
  try {
    for (const source of ['main', 'quarantine']) {
      const row = page.getByRole('article', { name: `同期イベント ${source} ${fixture.sale.id}` });
      await expect(row).toBeVisible();
      const button = row.getByRole('button', { name: '原記録を却下して終端にする', exact: true });
      await expect(button).toBeDisabled();
      const reason = `${source}の決済不成立を確認`;
      await row.getByLabel('照合理由', { exact: true }).fill(reason);
      await button.click();
      await expect(row.getByRole('button', { name: '却下を確定', exact: true })).toBeVisible();
      await row.getByRole('button', { name: '却下を確定', exact: true }).click();
      await expect(row).toHaveCount(0);
    }
    expect(dismissals).toEqual([
      { source: 'main', reason: 'mainの決済不成立を確認' },
      { source: 'quarantine', reason: 'quarantineの決済不成立を確認' },
    ]);
    const response = await request.get(`/v1/sync/reviews?storeId=${fixture.store}`, {
      headers: { 'x-tenant-id': fixture.admin.tenantId, 'x-staff-subject': fixture.admin.tenantId },
    });
    expect(response.ok()).toBe(true);
    const result: unknown = await response.json();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.waiting.id, status: 'waiting' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(fixture.sale.id);
  } finally {
    await page.screenshot({ path: '.context/ui-acceptance/red-sync-dismiss.png', fullPage: true });
  }
});
