import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { previewInvoice } from '../apps/api/src/finance-tax';
import { InvoiceDraftFieldsSchema, type InvoiceLineInput } from '../packages/core/src/finance';

function line(lineNo: number, unitAmount = '101', rateBps = 800): InvoiceLineInput {
  return {
    lineNo,
    name: '税計算の架空品目' + String(lineNo),
    productId: null,
    transactionDate: '2026-10-02',
    quantity: 1,
    unitAmount,
    discountAmount: '0',
    taxCategory: 'taxable',
    rateBps,
    reducedTarget: true,
    receiptAllocations: [],
    unmatchedReason: '原書類との直接照合',
  };
}
function draft(lines: InvoiceLineInput[]) {
  return InvoiceDraftFieldsSchema.parse({
    sourceKind: 'buyer-statement',
    sourceIdentity: { kind: 'numbered', invoiceNumber: '架空計算試験-001' },
    sourceEvidenceId: null,
    invoiceDate: '2026-10-02',
    dueDate: '2026-11-02',
    sourceReceivedDate: null,
    sourceReceivedAt: null,
    transactionFrom: '2026-10-02',
    transactionTo: '2026-10-02',
    seller: { name: '架空仕入先', address: '', registered: false, registrationNumber: null },
    buyer: { name: '架空購入法人', address: '' },
    priceMode: 'inclusive',
    rounding: 'floor',
    taxTreatment: { mode: 'computed' },
    lines,
    note: '',
  });
}
void test('finance tax rounds once per rate and keeps taxable zero non-taxable and out-of-scope groups separate', () => {
  const preview = previewInvoice(
    draft([
      line(1),
      line(2),
      line(3),
      { ...line(4, '110', 1000), reducedTarget: false },
      { ...line(5, '50', 0), taxCategory: 'non-taxable', reducedTarget: false },
      { ...line(6, '50', 0), taxCategory: 'out-of-scope', reducedTarget: false },
      line(7, '40', 0),
    ]),
  );
  assert.equal(preview.computedGross, '553');
  assert.equal(preview.postReadiness, 'ready');
  assert.deepEqual(
    preview.taxGroups.map((group) => [group.groupKey, group.computed.tax]),
    [
      ['taxable:800', '22'],
      ['taxable:1000', '10'],
      ['non-taxable', '0'],
      ['out-of-scope', '0'],
      ['taxable:0', '0'],
    ],
  );
  assert.deepEqual(
    preview.lines.slice(0, 3).map((entry) => entry.taxAllocation),
    ['8', '7', '7'],
  );
  assert.equal(
    preview.lines.reduce((sum, entry) => sum + BigInt(entry.taxAllocation), 0n),
    32n,
  );
});
void test('finance tax inclusive exclusive rounding discount and huge integer arithmetic retain exact group line totals', () => {
  for (const priceMode of ['inclusive', 'exclusive'] as const)
    for (const rounding of ['floor', 'ceil', 'nearest'] as const) {
      const input = {
        ...draft([
          line(1, '999999999999999999999999999999', 1200),
          { ...line(2, '101', 1200), discountAmount: '1' },
        ]),
        priceMode,
        rounding,
      };
      const preview = previewInvoice(input);
      assert.equal(
        preview.lines.reduce((sum, entry) => sum + BigInt(entry.gross), 0n).toString(),
        preview.acceptedGross,
      );
      for (const entry of preview.lines)
        assert.equal(BigInt(entry.net) + BigInt(entry.taxAllocation), BigInt(entry.gross));
      assert.equal(preview.taxGroups.length, 1);
      const numerator = (BigInt(input.lines[0].unitAmount) + 100n) * 1200n;
      const divisor = priceMode === 'inclusive' ? 11200n : 10000n;
      const expected =
        numerator / divisor +
        ((rounding === 'ceil' && numerator % divisor > 0n) ||
        (rounding === 'nearest' && (numerator % divisor) * 2n >= divisor)
          ? 1n
          : 0n);
      assert.equal(preview.taxGroups[0].computed.tax, expected.toString());
    }
});
void test('supplier stated variance is bounded by group line count while fixed gross and original tax remain distinct', () => {
  const input = draft([line(1), line(2), line(3)]);
  const evidenceId = randomUUID();
  const supplier = {
    ...input,
    sourceKind: 'supplier-invoice' as const,
    sourceEvidenceId: evidenceId,
    taxTreatment: {
      mode: 'supplier-stated' as const,
      groups: [{ groupKey: 'taxable:800', net: '278', tax: '25', gross: '303' }],
      evidenceId,
      reason: '原書類と計算値の端数差',
    },
  };
  const accepted = previewInvoice(supplier);
  assert.equal(accepted.taxGroups[0].computed.tax, '22');
  assert.equal(accepted.taxGroups[0].supplierStated?.tax, '25');
  assert.equal(accepted.taxGroups[0].deltaTax, '3');
  assert.equal(accepted.taxGroups[0].allowedVarianceYen, '3');
  assert.equal(accepted.postReadiness, 'needs-tax-variance-acceptance');
  assert.equal(
    accepted.lines.reduce((sum, entry) => sum + BigInt(entry.taxAllocation), 0n),
    25n,
  );
  const excessive = previewInvoice({
    ...supplier,
    taxTreatment: {
      ...supplier.taxTreatment,
      groups: [{ groupKey: 'taxable:800', net: '277', tax: '26', gross: '303' }],
    },
  });
  assert.equal(excessive.taxGroups[0].withinLimit, false);
  assert.equal(excessive.acceptedGross, null);
  assert.ok(excessive.completionIssues.some((issue) => issue.code === 'TAX_VARIANCE_LIMIT'));
});
void test('finance zero-value and non-taxable groups never accept an invented supplier tax under the rounding variance allowance', () => {
  for (const inputLine of [
    { ...line(1, '40', 0), taxCategory: 'non-taxable' as const, reducedTarget: false },
    line(1, '0', 800),
  ]) {
    const input = draft([inputLine]);
    const evidenceId = randomUUID();
    const groupKey = inputLine.taxCategory === 'taxable' ? 'taxable:800' : 'non-taxable';
    const source = {
      ...input,
      priceMode: 'exclusive' as const,
      sourceKind: 'supplier-invoice' as const,
      sourceEvidenceId: evidenceId,
      taxTreatment: {
        mode: 'supplier-stated' as const,
        groups: [
          {
            groupKey,
            net: inputLine.unitAmount,
            tax: '1',
            gross: (BigInt(inputLine.unitAmount) + 1n).toString(),
          },
        ],
        evidenceId,
        reason: '原書類の不正な税額を検知する試験',
      },
    };
    const preview = previewInvoice(source);
    assert.equal(preview.acceptedGross, null);
    assert.ok(preview.completionIssues.some((issue) => issue.code === 'TAX_MISMATCH'));
    assert.equal(preview.lines[0].taxAllocation, '0');
  }
});
void test('finance previews keep incomplete identity original-source allocation and date errors explicit without calling the draft posted', () => {
  const input = {
    ...draft([line(1)]),
    sourceIdentity: null,
    dueDate: '2026-10-01',
    lines: [
      {
        ...line(1),
        unmatchedReason: null,
        receiptAllocations: [{ receiptId: randomUUID(), receiptLineIndex: 0, quantity: 2 }],
      },
    ],
  };
  const preview = previewInvoice(input);
  assert.equal(preview.postReadiness, 'incomplete');
  for (const code of ['INVOICE_INCOMPLETE', 'RECEIPT_OVERALLOCATED'])
    assert.ok(preview.completionIssues.some((issue) => issue.code === code));
});
