import {
  InvoiceDraftFieldsSchema,
  type InvoiceDraftFields,
  type InvoiceLineInput,
  type SupplierDto,
} from '@regi/core/finance';

export interface InvoiceLineForm extends Omit<
  InvoiceLineInput,
  'quantity' | 'rateBps' | 'unmatchedReason'
> {
  quantity: string;
  ratePercent: string;
  unmatchedReason: string;
}
export interface InvoiceForm {
  draft: InvoiceDraftFields;
  lines: InvoiceLineForm[];
}
export function newInvoiceLine(lineNo: number): InvoiceLineForm {
  return {
    lineNo,
    name: '',
    productId: null,
    transactionDate: '',
    quantity: '1',
    unitAmount: '',
    discountAmount: '0',
    taxCategory: 'taxable',
    ratePercent: '10',
    reducedTarget: false,
    receiptAllocations: [],
    unmatchedReason: '',
  };
}
export function invoiceForm(draft?: InvoiceDraftFields): InvoiceForm {
  const content: InvoiceDraftFields = draft ?? {
    sourceKind: 'supplier-invoice',
    sourceIdentity: { kind: 'numbered', invoiceNumber: '' },
    sourceEvidenceId: null,
    invoiceDate: null,
    dueDate: null,
    sourceReceivedDate: null,
    sourceReceivedAt: null,
    transactionFrom: null,
    transactionTo: null,
    seller: null,
    buyer: null,
    priceMode: 'exclusive',
    rounding: 'floor',
    taxTreatment: { mode: 'computed' },
    lines: [],
    note: '',
  };
  return {
    draft: structuredClone(content),
    lines: content.lines.length
      ? content.lines.map(({ rateBps, ...line }) => ({
          ...line,
          quantity: String(line.quantity),
          ratePercent: String(rateBps / 100),
          unmatchedReason: line.unmatchedReason ?? '',
        }))
      : [newInvoiceLine(1)],
  };
}
export function selectInvoiceSupplier(form: InvoiceForm, supplier: SupplierDto): InvoiceForm {
  return {
    ...form,
    draft: {
      ...form.draft,
      seller: {
        name: supplier.name,
        address: supplier.address,
        registered: supplier.registered,
        registrationNumber: supplier.registrationNumber,
      },
    },
  };
}
export function invoiceDraft(form: InvoiceForm): InvoiceDraftFields {
  const lines = form.lines
    .filter(
      (line) =>
        line.name !== '' ||
        line.unitAmount !== '' ||
        line.transactionDate !== '' ||
        line.receiptAllocations.length > 0 ||
        line.unmatchedReason !== '',
    )
    .map((line, index) => {
      if (!/^[1-9][0-9]{0,4}$/.test(line.quantity) || Number(line.quantity) > 10000)
        throw new Error(`${index + 1}行目の数量は1〜10,000の整数で入力してください。`);
      if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/.test(line.ratePercent))
        throw new Error(`${index + 1}行目の税率は0〜100%の範囲で小数第2位まで入力してください。`);
      const [whole, fraction = ''] = line.ratePercent.split('.');
      const rateBps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      if (rateBps > 10000) throw new Error(`${index + 1}行目の税率は100%以下で入力してください。`);
      const { ratePercent: _ratePercent, ...fields } = line;
      void _ratePercent;
      return {
        ...fields,
        lineNo: index + 1,
        quantity: Number(line.quantity),
        rateBps,
        unmatchedReason: line.unmatchedReason.trim() || null,
      };
    });
  const sourceIdentity =
    form.draft.sourceIdentity?.kind === 'numbered' && form.draft.sourceIdentity.invoiceNumber === ''
      ? null
      : form.draft.sourceIdentity;
  const result = InvoiceDraftFieldsSchema.safeParse({ ...form.draft, sourceIdentity, lines });
  if (!result.success)
    throw new Error('明細の名称・実取引日・単価・税区分と、請求書の必須項目を確認してください。');
  return result.data;
}
