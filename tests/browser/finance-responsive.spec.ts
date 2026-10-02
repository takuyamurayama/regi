import { expect, test } from '@playwright/test';
import { InvoiceActionDtoSchema } from '../../packages/core/src/finance';
import { japanDateTime, japanInstant } from '../../apps/web/src/finance-ui';
import { buyerDraft, financeCommand } from './finance-support';
import { regressionFixture, useFixture } from './regression-support';

test('仕入請求の長い識別子と仕入先名でも狭い画面で残高と支払操作を確認できる', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture(),
    { invoice } = await buyerDraft(request, fixture);
  await financeCommand(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}/post`,
    {
      storeId: fixture.stores.recovery,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: japanInstant(japanDateTime()),
      reason: null,
      taxVarianceAcceptance: null,
    },
    InvoiceActionDtoSchema,
  );
  await useFixture(page, fixture);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${fixture.stores.recovery}`);
  await expect(page.locator('.finance-summary').first()).toContainText('1,080円');
  const width = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  await expect(page.getByRole('heading', { name: '支払記録', exact: true })).toBeVisible();
  const payment = page.getByLabel('実際に支払った金額（円）', { exact: true });
  await payment.focus();
  await expect(payment).toBeFocused();
  const target = await payment.boundingBox();
  expect(target?.height).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.screenshot({ path: '.context/ui-acceptance/finance-invoice-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.finance-summary').first()).toContainText('1,080円');
  await page.screenshot({
    path: '.context/ui-acceptance/finance-invoice-1280.png',
    fullPage: true,
  });
});
