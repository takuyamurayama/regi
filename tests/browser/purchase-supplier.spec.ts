import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { PurchaseSupplierLinkDtoSchema, SupplierDtoSchema } from '../../packages/core/src/finance';
import { financeCommand } from './finance-support';
import {
  documentSchema,
  get,
  issuedOrder,
  regressionFixture,
  useFixture,
} from './regression-support';

const orderSchema = documentSchema.extend({
  version: z.number().int().positive(),
  body: z.object({ supplier: z.string() }).passthrough(),
  currentSupplierId: z.uuid().nullable(),
  currentSupplierVersion: z.number().int().positive().nullable(),
});

test('仕入先マスターで発注し既存発注へ対応付けても発行済み仕入先と原明細を変えない', async ({
  page,
  request,
}) => {
  const fixture = regressionFixture(),
    historical = await issuedOrder(request, fixture),
    supplier = await financeCommand(
      request,
      fixture,
      '/v1/suppliers',
      {
        code: `WEB-${randomUUID()}`,
        name: `画面対応付け試験 ${randomUUID()}`,
        address: '合成試験用の架空住所',
        registered: false,
        registrationNumber: null,
        defaultDueDays: 30,
        active: true,
      },
      SupplierDtoSchema,
    );
  const listPath = `/v1/documents/purchase-order?storeId=${fixture.stores.recovery}`;
  const original = (await get(request, fixture, listPath, z.array(orderSchema))).find(
    (order) => order.id === historical.id,
  );
  expect(original).toBeDefined();
  if (!original) throw new Error('試験用発注がありません');
  expect(original.currentSupplierId).toBeNull();

  await useFixture(page, fixture);
  await page.goto(`/purchases/orders?storeId=${fixture.stores.recovery}`);
  const draft = page.locator('section').filter({
    has: page.getByRole('heading', { name: '発注下書きを作成', exact: true }),
  });
  await draft.getByRole('button', { name: '仕入先マスターを選ぶ', exact: true }).click();
  await expect(
    draft.getByRole('option', { name: `${supplier.code} / ${supplier.name}` }),
  ).toBeAttached();
  await draft
    .getByRole('combobox', { name: '仕入先マスター', exact: true })
    .selectOption(supplier.id);
  await expect(draft.getByLabel('仕入先', { exact: true })).toHaveValue(supplier.name);
  await draft
    .getByRole('combobox', { name: '商品', exact: true })
    .selectOption(historical.productId);
  await draft.getByLabel('数量', { exact: true }).fill('2');
  await draft.getByLabel('仕入単価', { exact: true }).fill('350');
  const savedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/purchase-orders' &&
      response.request().method() === 'POST',
  );
  await draft.getByRole('button', { name: '下書き作成', exact: true }).click();
  const saved = await savedResponse;
  expect(saved.status(), await saved.text()).toBe(201);
  const savedValue: unknown = await saved.json(),
    created = orderSchema.omit({ version: true }).parse(savedValue);
  expect(created.body.supplier).toBe(supplier.name);
  expect(created.currentSupplierId).toBe(supplier.id);
  expect(created.currentSupplierVersion).toBe(supplier.version);
  await expect(page.locator('.purchase-order').filter({ hasText: created.id })).toContainText(
    supplier.name,
  );
  const createdRecord = (await get(request, fixture, listPath, z.array(orderSchema))).find(
    (order) => order.id === created.id,
  );
  expect(createdRecord?.version).toBe(1);
  expect(createdRecord?.currentSupplierId).toBe(supplier.id);

  const row = page.locator('.purchase-order').filter({ hasText: historical.id });
  await row.getByText('仕入先との対応', { exact: true }).click();
  await row.getByRole('button', { name: '仕入先マスターを選ぶ', exact: true }).click();
  await expect(
    row.getByRole('option', { name: `${supplier.code} / ${supplier.name}` }),
  ).toBeAttached();
  await row
    .getByRole('combobox', { name: '仕入先マスター', exact: true })
    .selectOption(supplier.id);
  await row
    .getByLabel('マスター対応理由', { exact: true })
    .fill('原発注を保存したまま仕入先を照合');
  const linkResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/v1/purchase-orders/${historical.id}/supplier-link` &&
      response.request().method() === 'POST',
  );
  await row.getByRole('button', { name: '仕入先マスターとの対応を記録', exact: true }).click();
  const linkedResponse = await linkResponse;
  expect(linkedResponse.status(), await linkedResponse.text()).toBe(201);
  const linkedValue: unknown = await linkedResponse.json(),
    linked = PurchaseSupplierLinkDtoSchema.parse(linkedValue);
  expect(linked.originalSupplierText).toBe(historical.supplier);
  expect(linked.supplierSnapshot.name).toBe(supplier.name);
  await expect(row).toContainText('仕入先マスターとの対応: 対応済み');
  const updated = (await get(request, fixture, listPath, z.array(orderSchema))).find(
    (order) => order.id === historical.id,
  );
  expect(updated?.body).toEqual(original.body);
  expect(updated?.version).toBe(original.version + 1);
  expect(updated?.currentSupplierId).toBe(supplier.id);
  expect(updated?.currentSupplierVersion).toBe(supplier.version);
  await expect(row.locator('b')).toContainText(historical.supplier);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: '.context/ui-acceptance/final/purchase-supplier-link.png',
    fullPage: true,
  });
});
