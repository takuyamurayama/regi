import { expect, test } from '@playwright/test';
import { z } from 'zod';
import {
  InvoiceActionDtoSchema,
  InvoiceDtoSchema,
  ReceiptCandidateDtoSchema,
  financePageSchema,
} from '../../packages/core/src/finance';
import { japanDateTime, japanInstant } from '../../apps/web/src/finance-ui';
import { buyerDraft, financeCommand } from './finance-support';
import {
  command,
  documentSchema,
  get,
  receiptSchema,
  regressionFixture,
  useFixture,
} from './regression-support';

const stockSchema = z.array(z.object({ product_id: z.uuid(), quantity: z.string() }));

test('物品返品・原税額による減額・返金受領と逆記録を画面で操作し原請求と在庫を保持する', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const fixture = regressionFixture(),
    store = fixture.stores.recovery;
  const { supplier, invoice, draft } = await buyerDraft(request, fixture);
  const products = await get(request, fixture, '/v1/products', z.array(documentSchema));
  const product = products[0];
  expect(product).toBeDefined();
  const stock = async () =>
    (await get(request, fixture, `/v1/inventory?storeId=${store}`, stockSchema)).find(
      (item) => item.product_id === product.id,
    )?.quantity ?? '0';
  const initialStock = BigInt(await stock());
  const order = await command(
    request,
    fixture,
    store,
    '/v1/purchase-orders',
    {
      supplier: supplier.name,
      supplierId: supplier.id,
      expectedAt: draft.invoiceDate,
      lines: [{ productId: product.id, quantity: 10, unitCost: '100' }],
    },
    documentSchema,
  );
  for (const action of ['approve', 'issue'])
    await command(
      request,
      fixture,
      store,
      `/v1/purchase-orders/${order.id}/${action}`,
      {},
      documentSchema,
    );
  const receipt = await command(
    request,
    fixture,
    store,
    `/v1/purchase-orders/${order.id}/receipts`,
    { lines: [{ index: 0, quantity: 10 }] },
    receiptSchema,
  );
  const edited = await financeCommand(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}`,
    {
      storeId: store,
      version: invoice.version,
      draft: {
        ...draft,
        lines: [
          {
            ...draft.lines[0],
            productId: product.id,
            receiptAllocations: [{ receiptId: receipt.id, receiptLineIndex: 0, quantity: 10 }],
            unmatchedReason: null,
          },
        ],
      },
    },
    InvoiceDtoSchema,
    'PATCH',
  );
  const local = japanDateTime();
  const posted = await financeCommand(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}/post`,
    {
      storeId: store,
      expectedInvoiceVersion: edited.version,
      effectiveAt: japanInstant(local),
      reason: null,
      taxVarianceAcceptance: null,
    },
    InvoiceActionDtoSchema,
  );
  expect(posted.invoice.balance.originalGross).toBe('1080');
  await useFixture(page, fixture);
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${store}`);
  const payments = page
    .locator('.finance-card')
    .filter({ has: page.getByRole('heading', { name: '支払記録', exact: true }) });
  await payments.getByLabel('実際に支払った金額（円）', { exact: true }).fill('1080');
  await payments.getByLabel('実際の支払日時（日本時間）', { exact: true }).fill(local);
  await payments.getByRole('combobox', { name: '支払方法', exact: true }).selectOption('cash');
  await payments.getByRole('button', { name: '支払を記録', exact: true }).click();
  await expect(payments.getByRole('status')).toHaveText('支払 1,080円を記録しました。');
  await page.getByRole('button', { name: '仕入返品・減額', exact: true }).click();
  await page
    .getByRole('combobox', { name: '返品する仕入先', exact: true })
    .selectOption(supplier.id);
  await page
    .getByRole('combobox', { name: '関連する確定請求', exact: true })
    .selectOption(invoice.id);
  await page
    .getByRole('combobox', { name: '返品する元入荷明細', exact: true })
    .selectOption(`${receipt.id}:0`);
  await page.getByLabel('今回の返品数量', { exact: true }).fill('3');
  await page.getByRole('button', { name: '返品明細に追加', exact: true }).click();
  const actualReturn = new Date();
  const returnLocal = `${japanDateTime(actualReturn)}:${String(actualReturn.getUTCSeconds()).padStart(2, '0')}`;
  await page.getByLabel('実際の物品返品日時（日本時間）', { exact: true }).fill(returnLocal);
  await page.getByLabel('物品返品の理由', { exact: true }).fill('合成試験の物品3個返送');
  await page.getByRole('button', { name: '物品返品を記録して在庫を減らす', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '物品返品を記録しました。3個' }),
  ).toBeVisible();
  expect(BigInt(await stock())).toBe(initialStock + 7n);
  const candidates = await get(
    request,
    fixture,
    `/v1/purchase-receipts/available?storeId=${store}&supplierId=${supplier.id}&invoiceId=${invoice.id}`,
    financePageSchema(ReceiptCandidateDtoSchema),
  );
  expect(
    candidates.items.find((item) => item.receiptId === receipt.id)?.activeReturnedQuantity,
  ).toBe(3);
  await page.goto(`/purchases/invoices/${invoice.id}?storeId=${store}`);
  await page.getByText('原書類・関連資料（0件）', { exact: true }).click();
  await page.getByLabel('添付ファイル', { exact: true }).setInputFiles({
    name: '合成減額承認.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page
    .getByRole('combobox', { name: '資料の用途', exact: true })
    .selectOption('supplier-credit');
  await page.getByRole('button', { name: '資料を添付', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '「合成減額承認.png」を添付しました。' }),
  ).toBeVisible();
  await page.getByText('仕入先承認済みの減額を記録・確認', { exact: true }).click();
  const credit = page
    .locator('.finance-card')
    .filter({ has: page.getByRole('heading', { name: '仕入先が承認した減額', exact: true }) });
  await credit.getByLabel('減額する数量', { exact: true }).fill('3');
  await credit.getByRole('button', { name: '減額と残高をプレビュー', exact: true }).click();
  await expect(credit).toContainText('今回の減額：324円');
  await credit.getByLabel('実際の減額承認日時（日本時間）', { exact: true }).fill(returnLocal);
  await credit
    .getByRole('combobox', { name: '減額承認の資料', exact: true })
    .selectOption({ label: '合成減額承認.png' });
  await credit
    .getByRole('combobox', { name: '関連する物品返品', exact: true })
    .selectOption({ label: '合成試験の物品3個返送 ・3個' });
  await credit
    .getByLabel('減額の理由', { exact: true })
    .fill('合成試験の原税額24円を含む324円承認');
  await credit.getByRole('button', { name: '仕入先の減額を記録', exact: true }).click();
  await expect(credit.getByRole('status')).toHaveText('仕入先の減額 324円を記録しました。');
  const refunds = page
    .locator('.finance-card')
    .filter({ has: page.getByRole('heading', { name: '仕入先からの返金受領', exact: true }) });
  await refunds.getByLabel('実際に受領した返金額（円）', { exact: true }).fill('324');
  await refunds.getByLabel('実際の返金受領日時（日本時間）', { exact: true }).fill(returnLocal);
  await refunds.getByRole('combobox', { name: '返金方法', exact: true }).selectOption('cash');
  await refunds.getByRole('button', { name: '返金受領を記録', exact: true }).click();
  await expect(refunds.getByRole('status')).toHaveText('返金受領 324円を記録しました。');
  await refunds.getByRole('button', { name: '理由を付けて取り消す', exact: true }).click();
  await refunds.getByLabel('取消理由', { exact: true }).fill('合成返金記録の取消');
  await refunds.getByLabel('実際の取消日時（日本時間）', { exact: true }).fill(returnLocal);
  await refunds.getByRole('button', { name: '取消記録を追加', exact: true }).click();
  await expect(refunds.getByRole('status')).toHaveText(
    '元の記録を保持し、取消記録を追加しました。',
  );
  await expect(
    credit.getByRole('button', { name: '減額を理由付きで取り消す', exact: true }),
  ).toBeVisible();
  await credit.getByRole('button', { name: '減額を理由付きで取り消す', exact: true }).click();
  await credit.getByLabel('減額の取消理由', { exact: true }).fill('合成減額記録の取消');
  await credit.getByLabel('減額の実際の取消日時（日本時間）', { exact: true }).fill(returnLocal);
  await credit.getByRole('button', { name: '減額の取消記録を追加', exact: true }).click();
  await expect(
    credit.getByRole('status').filter({ hasText: '元の減額を保持し、取消記録を追加しました。' }),
  ).toBeVisible();
  const actual = await get(
    request,
    fixture,
    `/v1/purchase-invoices/${invoice.id}?storeId=${store}`,
    InvoiceDtoSchema,
  );
  expect(actual.content).toEqual(edited.content);
  expect(actual.balance.originalGross).toBe('1080');
  expect(actual.balance.signedBalance).toBe('0');
  expect(actual.ledger.map((item) => item.signedAmount)).toEqual([
    '1080',
    '-1080',
    '-324',
    '324',
    '-324',
    '324',
  ]);
  expect(BigInt(await stock())).toBe(initialStock + 7n);
  await page.screenshot({
    path: '.context/ui-acceptance/finance-return-refund.png',
    fullPage: true,
  });
});
