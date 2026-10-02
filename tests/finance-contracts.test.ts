import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  AuthenticatedActorSchema,
  CalendarDateSchema,
  FinanceInstantSchema,
  InvoiceCreateRequestSchema,
  InvoiceDraftFieldsSchema,
  InvoiceLineInputSchema,
  MoneyYenSchema,
  SourceIdentitySchema,
  SupplierCreateRequestSchema,
} from '../packages/core/src/finance';

const line = {
  lineNo: 1,
  name: '契約検証用の品目',
  productId: null,
  transactionDate: '2026-10-02',
  quantity: 1,
  unitAmount: '101',
  discountAmount: '0',
  taxCategory: 'taxable',
  rateBps: 800,
  reducedTarget: true,
  receiptAllocations: [],
  unmatchedReason: '原証憑のみで照合',
};
const draft = {
  sourceKind: 'supplier-invoice',
  sourceIdentity: null,
  sourceEvidenceId: null,
  invoiceDate: null,
  dueDate: null,
  sourceReceivedDate: null,
  sourceReceivedAt: null,
  transactionFrom: null,
  transactionTo: null,
  seller: null,
  buyer: null,
  priceMode: 'inclusive',
  rounding: 'floor',
  taxTreatment: { mode: 'computed' },
  lines: [],
  note: '',
};
void test('finance money contracts reject JSON numbers negatives decimal notation and overlong inputs without losing big integers', () => {
  const huge = '999999999999999999999999999999';
  assert.equal(MoneyYenSchema.parse(huge), huge);
  for (const invalid of [
    0,
    101,
    -1,
    Number('9007199254740993'),
    '01',
    '-1',
    '1.0',
    '1e3',
    '1,000',
    huge + '9',
  ])
    assert.equal(MoneyYenSchema.safeParse(invalid).success, false);
});
void test('finance dates are valid Japanese calendar dates and offset timestamps normalize to UTC without altering the source day', () => {
  assert.equal(CalendarDateSchema.parse('2028-02-29'), '2028-02-29');
  for (const invalid of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-01-32',
    '2026-10-02T00:00:00Z',
  ])
    assert.equal(CalendarDateSchema.safeParse(invalid).success, false);
  assert.equal(FinanceInstantSchema.parse('2026-10-02T01:30:00+09:00'), '2026-10-01T16:30:00.000Z');
  assert.equal(FinanceInstantSchema.safeParse('2026-10-02T01:30:00').success, false);
});
void test('finance input contracts reject client actor tenant keys and registration state mismatches', () => {
  const supplier = {
    operationId: randomUUID(),
    code: 'SUP-1',
    name: '架空契約検証仕入先',
    address: '',
    registered: false,
    registrationNumber: null,
    defaultDueDays: 30,
    active: true,
  };
  assert.equal(SupplierCreateRequestSchema.safeParse(supplier).success, true);
  for (const extra of [
    { tenantId: randomUUID() },
    { actorId: randomUUID() },
    { role: 'admin' },
    { objectKey: 'private/key' },
  ])
    assert.equal(SupplierCreateRequestSchema.safeParse({ ...supplier, ...extra }).success, false);
  assert.equal(
    SupplierCreateRequestSchema.safeParse({ ...supplier, registered: true }).success,
    false,
  );
  assert.equal(
    SupplierCreateRequestSchema.safeParse({ ...supplier, registrationNumber: 'T0000000000000' })
      .success,
    false,
  );
  assert.equal(
    AuthenticatedActorSchema.safeParse({ staffId: randomUUID(), role: 'admin' }).success,
    true,
  );
  assert.equal(
    AuthenticatedActorSchema.safeParse({ staffId: randomUUID(), role: 'superuser' }).success,
    false,
  );
});
void test('finance incomplete draft preserves every field and accepts 500 Japanese lines but rejects a 501st line', () => {
  assert.deepEqual(InvoiceDraftFieldsSchema.parse(draft), draft);
  const lines = Array.from({ length: 500 }, (_, index) => ({
    ...line,
    lineNo: index + 1,
    name: '日本語の原仕入明細'.repeat(10),
  }));
  const input = {
    operationId: randomUUID(),
    storeId: randomUUID(),
    supplierId: randomUUID(),
    predecessorInvoiceId: null,
    draft: { ...draft, lines },
  };
  assert.deepEqual(InvoiceCreateRequestSchema.parse(input), input);
  assert.equal(
    InvoiceCreateRequestSchema.safeParse({
      ...input,
      draft: { ...input.draft, lines: [...lines, { ...line, lineNo: 500 }] },
    }).success,
    false,
  );
});
void test('finance tax classification accepts zero-rate reduced targets but rejects taxable values on non-taxable or out-of-scope lines', () => {
  assert.equal(
    InvoiceLineInputSchema.safeParse({ ...line, rateBps: 0, reducedTarget: true }).success,
    true,
  );
  for (const taxCategory of ['non-taxable', 'out-of-scope']) {
    assert.equal(
      InvoiceLineInputSchema.safeParse({ ...line, taxCategory, rateBps: 0, reducedTarget: false })
        .success,
      true,
    );
    assert.equal(
      InvoiceLineInputSchema.safeParse({
        ...line,
        taxCategory,
        rateBps: 1000,
        reducedTarget: false,
      }).success,
      false,
    );
    assert.equal(
      InvoiceLineInputSchema.safeParse({ ...line, taxCategory, rateBps: 0, reducedTarget: true })
        .success,
      false,
    );
  }
});
void test('finance original identities preserve spelling and require explicit unnumbered identification instead of inventing vendor numbers', () => {
  assert.deepEqual(SourceIdentitySchema.parse({ kind: 'numbered', invoiceNumber: ' ABC-001 ' }), {
    kind: 'numbered',
    invoiceNumber: ' ABC-001 ',
  });
  assert.equal(
    SourceIdentitySchema.safeParse({ kind: 'numbered', invoiceNumber: ' ' }).success,
    false,
  );
  assert.equal(
    SourceIdentitySchema.safeParse({
      kind: 'unnumbered',
      sourceReference: '原書類参照',
      identificationReason: ' ',
      sourceEvidenceId: null,
    }).success,
    false,
  );
  const identity = {
    kind: 'unnumbered',
    sourceReference: '10月2日納品の原請求',
    identificationReason: '日付と明細で原書類を識別',
    sourceEvidenceId: null,
  };
  assert.deepEqual(SourceIdentitySchema.parse(identity), identity);
});
