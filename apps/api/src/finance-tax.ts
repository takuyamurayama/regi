import { createHash } from 'node:crypto';
import { allocate } from '../../../packages/core/src';
import {
  InvoiceDraftFieldsSchema,
  InvoicePreviewDtoSchema,
  type CompletionIssue,
  type InvoiceDraftFields,
  type InvoiceLineInput,
  type InvoicePreviewDto,
  type Rounding,
  type TaxAmounts,
  type TaxGroupPreview,
} from '../../../packages/core/src/finance';

export const taxGroupKey = (line: Pick<InvoiceLineInput, 'taxCategory' | 'rateBps'>) =>
  line.taxCategory === 'taxable' ? 'taxable:' + String(line.rateBps) : line.taxCategory;
export function financeSha(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function rounded(numerator: bigint, denominator: bigint, rounding: Rounding) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return (
    quotient +
    ((rounding === 'ceil' && remainder > 0n) ||
    (rounding === 'nearest' && remainder * 2n >= denominator)
      ? 1n
      : 0n)
  );
}
export function previewInvoice(input: InvoiceDraftFields): InvoicePreviewDto {
  const draft = InvoiceDraftFieldsSchema.parse(input);
  const issues: CompletionIssue[] = [];
  const issue = (code: string, field: string, message: string) =>
    issues.push({ code, field, message });
  for (const key of ['sourceIdentity', 'invoiceDate', 'dueDate', 'seller', 'buyer'] as const)
    if (draft[key] === null) issue('INVOICE_INCOMPLETE', key, '確定に必要な項目を入力してください');
  if (draft.lines.length === 0) issue('INVOICE_INCOMPLETE', 'lines', '仕入明細を入力してください');
  if (draft.sourceKind === 'supplier-invoice') {
    if (draft.sourceEvidenceId === null)
      issue('INVOICE_SOURCE_REQUIRED', 'sourceEvidenceId', '受領した原請求の証憑が必要です');
    if (draft.taxTreatment.mode !== 'supplier-stated')
      issue('INVOICE_INCOMPLETE', 'taxTreatment', '受領した原書類の税率別金額を転記してください');
  } else if (draft.taxTreatment.mode !== 'computed')
    issue('TAX_MISMATCH', 'taxTreatment', '買い手作成明細は計算方式を使用してください');
  if (draft.sourceIdentity?.kind === 'unnumbered' && !draft.sourceIdentity.sourceEvidenceId)
    issue(
      'INVOICE_SOURCE_REQUIRED',
      'sourceIdentity.sourceEvidenceId',
      '原番号のない請求の識別証憑が必要です',
    );
  if (draft.invoiceDate && draft.dueDate && draft.dueDate < draft.invoiceDate)
    issue('INVOICE_INCOMPLETE', 'dueDate', '期日は原請求日以降にしてください');
  if (draft.transactionFrom && draft.transactionTo && draft.transactionFrom > draft.transactionTo)
    issue('INVOICE_INCOMPLETE', 'transactionTo', '取引期間の前後関係を確認してください');
  if (new Set(draft.lines.map((line) => line.lineNo)).size !== draft.lines.length)
    issue('INVOICE_INCOMPLETE', 'lines', '明細番号が重複しています');
  const amounts = draft.lines.map((line, index) => {
    const amount = BigInt(line.unitAmount) * BigInt(line.quantity) - BigInt(line.discountAmount);
    if (amount < 0n)
      issue(
        'TAX_MISMATCH',
        'lines.' + String(index) + '.discountAmount',
        '値引きは明細金額以内にしてください',
      );
    const allocated = line.receiptAllocations.reduce(
      (sum, allocation) => sum + allocation.quantity,
      0,
    );
    if (allocated > line.quantity)
      issue(
        'RECEIPT_OVERALLOCATED',
        'lines.' + String(index) + '.receiptAllocations',
        '照合数量は原請求明細数量以内にしてください',
      );
    if (allocated < line.quantity && !line.unmatchedReason)
      issue(
        'INVOICE_INCOMPLETE',
        'lines.' + String(index) + '.unmatchedReason',
        '入荷記録のない数量の根拠を記録してください',
      );
    return amount < 0n ? 0n : amount;
  });
  const groups = new Map<string, number[]>();
  draft.lines.forEach((line, index) => {
    const key = taxGroupKey(line);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const stated = draft.taxTreatment.mode === 'supplier-stated' ? draft.taxTreatment.groups : null;
  if (
    stated &&
    (new Set(stated.map((group) => group.groupKey)).size !== stated.length ||
      stated.some((group) => !groups.has(group.groupKey)))
  )
    issue('TAX_MISMATCH', 'taxTreatment.groups', '原記載の税率別区分が明細と一致しません');
  const lines: InvoicePreviewDto['lines'] = draft.lines.map((line) => ({
    ...line,
    net: '0',
    taxAllocation: '0',
    gross: '0',
  }));
  const taxGroups: TaxGroupPreview[] = [];
  let computedGross = 0n,
    statedGross = 0n,
    acceptedGross = 0n;
  let varianceRequired = false;
  for (const [key, indexes] of groups) {
    const first = draft.lines[indexes[0]];
    const base = indexes.reduce((sum, index) => sum + amounts[index], 0n);
    const tax =
      first.taxCategory === 'taxable'
        ? rounded(
            base * BigInt(first.rateBps),
            BigInt(draft.priceMode === 'inclusive' ? 10000 + first.rateBps : 10000),
            draft.rounding,
          )
        : 0n;
    const gross = draft.priceMode === 'inclusive' ? base : base + tax;
    const net = gross - tax;
    const computed: TaxAmounts = {
      groupKey: key,
      net: net.toString(),
      tax: tax.toString(),
      gross: gross.toString(),
    };
    const supplier = stated?.find((group) => group.groupKey === key) ?? null;
    if (stated && !supplier)
      issue('TAX_MISMATCH', 'taxTreatment.groups', '原記載の税率別金額が不足しています');
    const delta = supplier ? BigInt(supplier.tax) - tax : 0n;
    const bound = BigInt(Math.max(indexes.length, 1));
    const withinLimit = (delta < 0n ? -delta : delta) <= bound;
    let accepted = supplier ?? computed;
    if (supplier) {
      const valid =
        BigInt(supplier.net) + BigInt(supplier.tax) === BigInt(supplier.gross) &&
        (draft.priceMode === 'inclusive'
          ? BigInt(supplier.gross) === gross
          : BigInt(supplier.net) === net) &&
        ((first.rateBps !== 0 && first.taxCategory === 'taxable' && base > 0n) ||
          BigInt(supplier.tax) === 0n);
      if (!valid) {
        issue('TAX_MISMATCH', 'taxTreatment.groups', '原金額・税額・税込額の関係が一致しません');
        accepted = computed;
      }
      if (!withinLimit) {
        issue(
          'TAX_VARIANCE_LIMIT',
          'taxTreatment.groups',
          '原記載税額と計算額の差が端数の許容範囲を超えています',
        );
        accepted = computed;
      }
      varianceRequired ||= delta !== 0n;
      statedGross += BigInt(supplier.gross);
    }
    const shares = allocate(
      BigInt(accepted.tax),
      indexes.map((index) => amounts[index]),
    );
    indexes.forEach((index, position) => {
      const taxAllocation = shares[position];
      const lineGross =
        draft.priceMode === 'inclusive' ? amounts[index] : amounts[index] + taxAllocation;
      lines[index] = {
        ...draft.lines[index],
        gross: lineGross.toString(),
        taxAllocation: taxAllocation.toString(),
        net: (lineGross - taxAllocation).toString(),
      };
    });
    computedGross += gross;
    acceptedGross += BigInt(accepted.gross);
    taxGroups.push({
      groupKey: key,
      taxCategory: first.taxCategory,
      rateBps: first.rateBps,
      lineCount: indexes.length,
      computed,
      supplierStated: supplier,
      deltaTax: delta.toString(),
      allowedVarianceYen: bound.toString(),
      withinLimit,
    });
  }
  const readiness = issues.length
    ? 'incomplete'
    : varianceRequired
      ? 'needs-tax-variance-acceptance'
      : 'ready';
  const result = {
    lines,
    taxGroups,
    computedGross: computedGross.toString(),
    statedGross: stated ? statedGross.toString() : null,
    acceptedGross: issues.some((entry) =>
      ['TAX_MISMATCH', 'TAX_VARIANCE_LIMIT'].includes(entry.code),
    )
      ? null
      : acceptedGross.toString(),
    taxVarianceAcceptanceRequired: varianceRequired,
    completionIssues: issues,
    postReadiness: readiness,
  };
  return InvoicePreviewDtoSchema.parse({ previewSha256: financeSha({ draft, result }), ...result });
}
