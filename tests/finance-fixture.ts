import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  SupplierDtoSchema,
  InvoiceDtoSchema,
  InvoiceActionDtoSchema,
  EvidenceActionDtoSchema,
  type InvoiceDraftFields,
} from '../packages/core/src/finance';
import { renderDocumentPdf } from '../apps/api/src/pdf';
import { calculate } from '../packages/core/src';
import { syncFixture } from './sync-fixture';
import { apiFixture } from './api-fixture';

export async function financeFixture() {
  const fixture = await syncFixture();
  const api = await apiFixture();
  const headers = {
    'x-tenant-id': fixture.admin.tenantId,
    'x-staff-subject': fixture.admin.tenantId,
  };
  const request = (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    base = api.base,
  ) =>
    fetch(base + path, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    ...fixture,
    api,
    headers,
    request,
    close: async () => {
      await api.close();
      await fixture.database.client.$disconnect();
    },
  };
}
export async function postedInvoice(fixture: Awaited<ReturnType<typeof financeFixture>>) {
  const supplierBody = {
    operationId: randomUUID(),
    code: 'FINANCE-TEST',
    name: '原書類検証用の架空仕入先',
    address: '架空住所',
    registered: false,
    registrationNumber: null,
    defaultDueDays: 30,
    active: true,
  };
  const supplierResponse = await fixture.request('/v1/suppliers', supplierBody);
  assert.equal(supplierResponse.status, 201, await supplierResponse.clone().text());
  const supplier = SupplierDtoSchema.parse(await supplierResponse.json());
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const draft: InvoiceDraftFields = {
    sourceKind: 'supplier-invoice',
    sourceIdentity: { kind: 'numbered', invoiceNumber: '架空原請求-001' },
    sourceEvidenceId: null,
    invoiceDate: day,
    dueDate: day,
    sourceReceivedDate: day,
    sourceReceivedAt: new Date().toISOString(),
    transactionFrom: day,
    transactionTo: day,
    seller: {
      name: supplier.name,
      address: supplier.address,
      registered: false,
      registrationNumber: null,
    },
    buyer: { name: '請求検証用の架空購入法人', address: '架空購入者住所' },
    priceMode: 'inclusive',
    rounding: 'floor',
    taxTreatment: {
      mode: 'supplier-stated',
      groups: [{ groupKey: 'taxable:800', net: '100', tax: '8', gross: '108' }],
      evidenceId: null,
      reason: null,
    },
    lines: [
      {
        lineNo: 1,
        name: '架空仕入明細',
        productId: fixture.product,
        transactionDate: day,
        quantity: 1,
        unitAmount: '108',
        discountAmount: '0',
        taxCategory: 'taxable',
        rateBps: 800,
        reducedTarget: true,
        receiptAllocations: [],
        unmatchedReason: '架空原請求のファイル試験、入荷は創作しない',
      },
    ],
    note: '合成試験。実顧客の原資料・有償取引ではない',
  };
  const createdResponse = await fixture.request('/v1/purchase-invoices', {
    operationId: randomUUID(),
    storeId: fixture.store,
    supplierId: supplier.id,
    predecessorInvoiceId: null,
    draft,
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  let invoice = InvoiceDtoSchema.parse(await createdResponse.json());
  assert.equal(invoice.state, 'draft');
  assert.equal(invoice.balance.originalGross, null);
  const incomplete = await fixture.request('/v1/purchase-invoices/' + invoice.id + '/post', {
    operationId: randomUUID(),
    storeId: fixture.store,
    expectedInvoiceVersion: invoice.version,
    effectiveAt: new Date().toISOString(),
    reason: null,
    taxVarianceAcceptance: null,
  });
  assert.equal(incomplete.status, 409);
  const calculated = calculate(
    [
      {
        productId: fixture.product,
        name: draft.lines[0].name,
        quantity: 1,
        price: '108',
        discount: '0',
        rateBps: 800,
        cost: '50',
        stockManaged: false,
      },
    ],
    '0',
    'inclusive',
  );
  const originalBytes = await renderDocumentPdf('sale', {
    id: randomUUID(),
    store_id: fixture.store,
    body: {
      ...calculated,
      receipt: {
        sellerName: supplier.name,
        storeName: '架空仕入先の原書類',
        address: supplier.address,
        registered: false,
        registrationNumber: '',
        buyerRequired: true,
      },
      buyerName: draft.buyer?.name,
      occurredAt: new Date().toISOString(),
      method: 'card',
      reference: '架空原資料の合成試験',
      tendered: null,
    },
  });
  const upload = await fetch(
    fixture.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence',
    {
      method: 'POST',
      headers: {
        ...fixture.headers,
        'content-type': 'application/pdf',
        'x-regi-operation-id': randomUUID(),
        'x-regi-store-id': fixture.store,
        'x-regi-invoice-version': String(invoice.version),
        'x-regi-evidence-name': encodeURIComponent('架空原請求.pdf'),
        'x-regi-evidence-role': 'source-invoice',
        'x-regi-evidence-method': 'uploaded-original',
      },
      body: new Uint8Array(originalBytes),
    },
  );
  assert.equal(upload.status, 201, await upload.clone().text());
  const evidence = EvidenceActionDtoSchema.parse(await upload.json());
  const edit = await fixture.request(
    '/v1/purchase-invoices/' + invoice.id,
    {
      operationId: randomUUID(),
      storeId: fixture.store,
      version: evidence.invoiceVersion,
      draft: {
        ...draft,
        sourceEvidenceId: evidence.evidence.id,
        taxTreatment: { ...draft.taxTreatment, evidenceId: evidence.evidence.id },
      },
    },
    'PATCH',
  );
  assert.equal(edit.status, 200, await edit.clone().text());
  invoice = InvoiceDtoSchema.parse(await edit.json());
  const input = {
    operationId: randomUUID(),
    storeId: fixture.store,
    expectedInvoiceVersion: invoice.version,
    effectiveAt: new Date().toISOString(),
    reason: null,
    taxVarianceAcceptance: null,
  };
  const response = await fixture.request('/v1/purchase-invoices/' + invoice.id + '/post', input);
  assert.equal(response.status, 201, await response.clone().text());
  const posted = InvoiceActionDtoSchema.parse(await response.json());
  const replay = await fixture.request('/v1/purchase-invoices/' + invoice.id + '/post', input);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), posted);
  return { supplier, supplierBody, invoice: posted.invoice, evidence, originalBytes };
}
