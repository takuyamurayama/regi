import { test, expect } from '@playwright/test';
import { command, documentSchema, get, regressionFixture, useFixture } from './regression-support';
import { z } from 'zod';

test('現金操作は開局未選択・理由未入力・不正金額を項目のそばで案内し送信しない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture();
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/v1\/(cash-movements|shifts\/.*\/close)$/.test(new URL(request.url()).pathname)
    )
      writes++;
  });
  await useFixture(page, fixture);
  await page.goto(`/shifts?storeId=${fixture.stores.recovery}`);
  await expect(page.getByLabel('店舗', { exact: true })).toHaveValue(fixture.stores.recovery);
  await expect(page.getByRole('button', { name: '現金入金', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '現金出金', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '端末暫定締め', exact: true })).toBeDisabled();
  await expect(
    page.getByText('営業中の開局記録がありません。先に開局してください。', { exact: true }),
  ).toBeVisible();
  const shift = await command(
    request,
    fixture,
    fixture.stores.recovery,
    '/v1/shifts',
    {
      deviceId: fixture.devices.recovery,
      opening: '1000',
      pin: '1234',
    },
    documentSchema,
  );
  await page.reload();
  await page.getByLabel('開局記録', { exact: true }).selectOption(shift.id);
  const settings = await get(
    request,
    fixture,
    '/v1/settings',
    z.object({ devices: z.array(z.object({ id: z.uuid(), name: z.string() })) }),
  );
  const device = settings.devices.find((entry) => entry.id === fixture.devices.recovery);
  expect(device).toBeDefined();
  const shiftRow = page.getByRole('row').filter({ hasText: device!.name });
  await expect(shiftRow).toContainText('開局中');
  await expect(shiftRow).not.toContainText(fixture.devices.recovery);
  await expect(page.getByRole('button', { name: '現金入金', exact: true })).toBeDisabled();
  await expect(
    page.getByText('現金入出金の理由を入力してください。', { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder('現金移動理由').fill('   ');
  await expect(page.getByRole('button', { name: '現金出金', exact: true })).toBeDisabled();
  await page.getByPlaceholder('現金移動理由').fill('準備金の追加');
  for (const value of ['-1', '1.5', 'abc', '01', '1'.repeat(31)]) {
    await page.getByLabel('現金額', { exact: true }).fill(value);
    await expect(page.getByRole('button', { name: '現金入金', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '端末暫定締め', exact: true })).toBeDisabled();
    await expect(page.getByLabel('現金額', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(
      page.getByText('現金額は0以上の整数で入力してください（最大30桁、先頭の0は不要）。', {
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.getByLabel('現金額', { exact: true }).fill('500');
  await expect(page.getByRole('button', { name: '現金入金', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '現金出金', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '端末暫定締め', exact: true })).toBeEnabled();
  expect(writes).toBe(0);
});

test('初回入力拒否は日本語で修正を案内し、修正した現金操作を一度だけ保存する', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture();
  const shift = await command(
    request,
    fixture,
    fixture.stores.recovery,
    '/v1/shifts',
    {
      deviceId: fixture.devices.recovery,
      opening: '1000',
      pin: '1234',
    },
    documentSchema,
  );
  const ids: string[] = [];
  await page.route('**/v1/cash-movements', async (route) => {
    const body = z.object({ operationId: z.uuid() }).parse(route.request().postDataJSON());
    ids.push(body.operationId);
    if (ids.length === 1)
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'INVALID_INPUT',
          message: '入力内容を確認してください。',
          retryable: false,
          nextAction: '該当項目を修正してから送信してください。',
          fieldErrors: [{ field: 'reason', message: '現金移動理由を入力してください。' }],
        }),
      });
    else await route.continue();
  });
  await useFixture(page, fixture);
  await page.goto(`/shifts?storeId=${fixture.stores.recovery}`);
  await page.getByLabel('開局記録', { exact: true }).selectOption(shift.id);
  await page.getByPlaceholder('現金移動理由').fill('準備金の追加');
  await page.getByRole('button', { name: '現金入金', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: '現金移動理由を入力してください。' });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('INVALID_INPUT');
  await expect(alert).not.toContainText('操作ID');
  await expect(page.getByLabel('開局記録', { exact: true })).toHaveValue(shift.id);
  await page.getByPlaceholder('現金移動理由').fill('確認済みの準備金追加');
  await page.getByRole('button', { name: '現金入金', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
  expect(
    await get(
      request,
      fixture,
      `/v1/documents/cash?storeId=${fixture.stores.recovery}`,
      z.array(documentSchema),
    ),
  ).toHaveLength(1);
});

test('AIの照会対象は日本語表示で選択でき、送信する集計キーは維持する', async ({ page }) => {
  const fixture = regressionFixture();
  await useFixture(page, fixture);
  await page.goto(`/ai?storeId=${fixture.stores.recovery}`);
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '集計を根拠に照会', exact: true }) });
  const select = section.getByRole('combobox');
  await expect(select.locator('option')).toHaveText([
    '売上',
    '支払方法別売上',
    '概算粗利',
    '在庫',
    '発注',
  ]);
  for (const [value, label] of [
    ['sales', '売上'],
    ['payments', '支払方法別売上'],
    ['profit', '概算粗利'],
    ['inventory', '在庫'],
    ['orders', '発注'],
  ]) {
    await select.selectOption({ label });
    await expect(select).toHaveValue(value);
  }
  let sentMetric: string | undefined;
  await page.route('**/v1/ai/query', async (route) => {
    sentMetric = z
      .object({ metric: z.literal('orders') })
      .parse(route.request().postDataJSON()).metric;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ explanation: '発注の照会対象を受信しました。' }),
    });
  });
  await section.getByRole('button', { name: '照会する', exact: true }).click();
  await expect(section.getByText('発注の照会対象を受信しました。', { exact: true })).toBeVisible();
  expect(sentMetric).toBe('orders');
  await page.screenshot({
    path: '.context/ui-acceptance/ai-japanese-selection.png',
    fullPage: true,
  });
});
