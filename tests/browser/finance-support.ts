import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import {
  SupplierDtoSchema,
  InvoiceDtoSchema,
  type InvoiceDraftFields,
} from '../../packages/core/src/finance';
import { japanDateTime } from '../../apps/web/src/finance-ui';
import { headers, type RegressionFixture } from './regression-support';

export async function financeCommand<T>(
  request: APIRequestContext,
  fixture: RegressionFixture,
  path: string,
  body: object,
  schema: z.ZodType<T>,
  method = 'POST',
): Promise<T> {
  const response = await request.fetch(path, {
    method,
    headers: headers(fixture),
    data: { operationId: randomUUID(), ...body },
  });
  assert.ok(response.ok(), await response.text());
  const value: unknown = await response.json();
  return schema.parse(value);
}
export async function buyerDraft(request: APIRequestContext, fixture: RegressionFixture) {
  const supplier = await financeCommand(
    request,
    fixture,
    '/v1/suppliers',
    {
      code: `TEST-${randomUUID()}`,
      name: '原資料画面検証用の合成仕入先',
      address: '架空住所',
      registered: false,
      registrationNumber: null,
      defaultDueDays: 30,
      active: true,
    },
    SupplierDtoSchema,
  );
  const day = japanDateTime().slice(0, 10);
  const draft: InvoiceDraftFields = {
    sourceKind: 'buyer-statement',
    sourceIdentity: { kind: 'numbered', invoiceNumber: `合成確認-${randomUUID()}` },
    sourceEvidenceId: null,
    invoiceDate: day,
    dueDate: day,
    sourceReceivedDate: null,
    sourceReceivedAt: null,
    transactionFrom: day,
    transactionTo: day,
    seller: {
      name: supplier.name,
      address: supplier.address,
      registered: false,
      registrationNumber: null,
    },
    buyer: { name: '原資料画面検証用の架空購入法人', address: '' },
    priceMode: 'exclusive',
    rounding: 'floor',
    taxTreatment: { mode: 'computed' },
    lines: [
      {
        lineNo: 1,
        name: '合成仕入の米',
        productId: null,
        transactionDate: day,
        quantity: 10,
        unitAmount: '100',
        discountAmount: '0',
        taxCategory: 'taxable',
        rateBps: 800,
        reducedTarget: true,
        receiptAllocations: [],
        unmatchedReason: '原資料の通信試験、入荷は創作しない',
      },
    ],
    note: '合成試験、実顧客取引ではない',
  };
  const invoice = await financeCommand(
    request,
    fixture,
    '/v1/purchase-invoices',
    {
      storeId: fixture.stores.recovery,
      supplierId: supplier.id,
      predecessorInvoiceId: null,
      draft,
    },
    InvoiceDtoSchema,
  );
  return { supplier, invoice, draft };
}
