import { z } from 'zod';

export const FinanceIdSchema = z.uuid();
export const MoneyYenSchema = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const totalMoney = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(200);
const signedMoney = z
  .string()
  .regex(/^(0|-?[1-9][0-9]*)$/)
  .max(201);
export const CalendarDateSchema = z.iso.date();
export const FinanceInstantSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.number().int().positive();
const quantity = z.number().int().min(1).max(10000);
const reason = z.string().trim().min(1).max(500);
const note = z.string().max(500);
const nullableId = FinanceIdSchema.nullable();
const nullableDate = CalendarDateSchema.nullable();
const nullableInstant = FinanceInstantSchema.nullable();
const textIdentity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const actorRole = z.enum(['admin', 'headquarters', 'manager', 'cashier']);
export const AuthenticatedActorSchema = z.strictObject({
  staffId: FinanceIdSchema,
  role: actorRole,
});
export type AuthenticatedActorDto = z.infer<typeof AuthenticatedActorSchema>;
export type ActorRole = z.infer<typeof actorRole>;
export const OperationStatusQuerySchema = z.strictObject({ storeId: FinanceIdSchema });
export const OperationStatusDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  status: z.literal('committed'),
});
export type OperationStatusDto = z.infer<typeof OperationStatusDtoSchema>;
export const InvoiceStateSchema = z.enum(['draft', 'cancelled', 'posted', 'voided']);
export const SourceKindSchema = z.enum(['supplier-invoice', 'buyer-statement']);
export const PaymentMethodSchema = z.enum(['cash', 'bank-transfer', 'other']);
export const TaxCategorySchema = z.enum(['taxable', 'non-taxable', 'out-of-scope']);
export const RoundingSchema = z.enum(['floor', 'ceil', 'nearest']);
export const PayableStatusSchema = z.enum(['unpaid', 'partially-paid', 'settled', 'refund-due']);
export const LedgerKindSchema = z.enum([
  'invoice-debit',
  'invoice-void',
  'supplier-credit',
  'credit-reversal',
  'payment',
  'payment-reversal',
  'supplier-refund',
  'refund-reversal',
]);
export const EvidenceRoleSchema = z.enum([
  'source-invoice',
  'source-identification',
  'tax-variance',
  'supplier-confirmation',
  'supplier-credit',
  'payment',
  'supplier-refund',
  'supporting',
]);
export type InvoiceState = z.infer<typeof InvoiceStateSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
export type TaxCategory = z.infer<typeof TaxCategorySchema>;
export type Rounding = z.infer<typeof RoundingSchema>;
export type PayableStatus = z.infer<typeof PayableStatusSchema>;
export type LedgerKind = z.infer<typeof LedgerKindSchema>;
export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;
export type Id = string;
export type MoneyYen = string;
export type SignedMoneyYen = string;
export type CalendarDate = string;
export type Instant = string;
export type Sha256 = string;

export const ApiErrorDtoSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  field: z.string().nullable(),
  retryable: z.boolean(),
  nextAction: z.string(),
  fieldErrors: z
    .array(z.strictObject({ field: z.string(), message: z.string() }))
    .max(20)
    .optional(),
});
export type ApiErrorDto = z.infer<typeof ApiErrorDtoSchema>;
export const CompletionIssueSchema = z.strictObject({
  code: z.string(),
  field: z.string(),
  message: z.string(),
});
export type CompletionIssue = z.infer<typeof CompletionIssueSchema>;
export function financePageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    observedAt: FinanceInstantSchema,
    viewToken: z.string(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  observedAt: string;
  viewToken: string;
}
const pageQuery = {
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(4000).optional(),
};
const mutation = { operationId: FinanceIdSchema, storeId: FinanceIdSchema };
const invoiceMutation = { ...mutation, expectedInvoiceVersion: version };
export const SupplierQuerySchema = z.strictObject({
  ...pageQuery,
  active: z.enum(['true', 'false', 'all']).optional(),
  search: z.string().max(100).optional(),
});
export const InvoiceQuerySchema = z.strictObject({
  ...pageQuery,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema.optional(),
  state: z.enum(['all', 'draft', 'cancelled', 'posted', 'voided']).optional(),
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
  search: z.string().max(100).optional(),
});
export const PayablesQuerySchema = z.strictObject({
  ...pageQuery,
  storeId: z.union([FinanceIdSchema, z.literal('all')]),
  supplierId: FinanceIdSchema.optional(),
  status: z.enum(['all', 'unpaid', 'partially-paid', 'settled', 'refund-due']).optional(),
  overdue: z.enum(['true', 'false', 'all']).optional(),
  dueFrom: CalendarDateSchema.optional(),
  dueTo: CalendarDateSchema.optional(),
  asOf: FinanceInstantSchema.optional(),
});
export const FactListQuerySchema = z.strictObject({
  ...pageQuery,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema.optional(),
  invoiceId: FinanceIdSchema.optional(),
  receiptId: FinanceIdSchema.optional(),
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
});
export const ReceiptCandidateQuerySchema = z.strictObject({
  ...pageQuery,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  orderId: FinanceIdSchema.optional(),
  invoiceId: FinanceIdSchema.optional(),
});
export type SupplierQuery = z.infer<typeof SupplierQuerySchema>;
export type InvoiceQuery = z.infer<typeof InvoiceQuerySchema>;
export type PayablesQuery = z.infer<typeof PayablesQuerySchema>;
export type FactListQuery = z.infer<typeof FactListQuerySchema>;
export type ReceiptCandidateQuery = z.infer<typeof ReceiptCandidateQuerySchema>;

const supplierFields = {
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  address: z.string().max(300),
  registered: z.boolean(),
  registrationNumber: z
    .string()
    .regex(/^T[0-9]{13}$/)
    .nullable(),
  defaultDueDays: z.number().int().min(0).max(365),
  active: z.boolean(),
};
const registrationConsistent = (value: {
  registered: boolean;
  registrationNumber: string | null;
}) => (value.registered ? value.registrationNumber !== null : value.registrationNumber === null);
export const SupplierCreateRequestSchema = z
  .strictObject({ ...supplierFields, operationId: FinanceIdSchema })
  .refine(registrationConsistent, {
    path: ['registrationNumber'],
    message: '登録状態と登録番号が一致しません',
  });
export const SupplierUpdateRequestSchema = z
  .strictObject({ ...supplierFields, operationId: FinanceIdSchema, version })
  .refine(registrationConsistent, {
    path: ['registrationNumber'],
    message: '登録状態と登録番号が一致しません',
  });
export const SupplierDtoSchema = z
  .strictObject({
    ...supplierFields,
    id: FinanceIdSchema,
    version,
    registrationCheck: z.enum(['format-only', 'not-registered']),
    createdAt: FinanceInstantSchema,
    updatedAt: FinanceInstantSchema,
  })
  .refine(registrationConsistent);
export type SupplierCreateRequest = z.infer<typeof SupplierCreateRequestSchema>;
export type SupplierUpdateRequest = z.infer<typeof SupplierUpdateRequestSchema>;
export type SupplierDto = z.infer<typeof SupplierDtoSchema>;
export const PartySnapshotSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    address: z.string().max(300),
    registered: z.boolean(),
    registrationNumber: z
      .string()
      .regex(/^T[0-9]{13}$/)
      .nullable(),
  })
  .refine(registrationConsistent);
export const BuyerSnapshotSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  address: z.string().max(300),
});
export type PartySnapshot = z.infer<typeof PartySnapshotSchema>;
export type BuyerSnapshot = z.infer<typeof BuyerSnapshotSchema>;
export const SourceIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('numbered'), invoiceNumber: textIdentity }),
  z.strictObject({
    kind: z.literal('unnumbered'),
    sourceReference: textIdentity,
    identificationReason: reason,
    sourceEvidenceId: nullableId,
  }),
]);
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
export const ReceiptAllocationInputSchema = z.strictObject({
  receiptId: FinanceIdSchema,
  receiptLineIndex: z.number().int().min(0).max(499),
  quantity,
});
export type ReceiptAllocationInput = z.infer<typeof ReceiptAllocationInputSchema>;
export const InvoiceLineInputSchema = z
  .strictObject({
    lineNo: z.number().int().min(1).max(500),
    name: z.string().trim().min(1).max(200),
    productId: nullableId,
    transactionDate: CalendarDateSchema,
    quantity,
    unitAmount: MoneyYenSchema,
    discountAmount: MoneyYenSchema,
    taxCategory: TaxCategorySchema,
    rateBps: z.number().int().min(0).max(10000),
    reducedTarget: z.boolean(),
    receiptAllocations: z.array(ReceiptAllocationInputSchema).max(500),
    unmatchedReason: reason.nullable(),
  })
  .refine(
    (value) => value.taxCategory === 'taxable' || (value.rateBps === 0 && !value.reducedTarget),
    { path: ['taxCategory'], message: '非課税・不課税の税率は0で軽減対象にはできません' },
  );
export type InvoiceLineInput = z.infer<typeof InvoiceLineInputSchema>;
export const TaxAmountsSchema = z.strictObject({
  groupKey: z.string().min(1).max(64),
  net: totalMoney,
  tax: totalMoney,
  gross: totalMoney,
});
export type TaxAmounts = z.infer<typeof TaxAmountsSchema>;
export const TaxTreatmentSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('computed') }),
  z.strictObject({
    mode: z.literal('supplier-stated'),
    groups: z.array(TaxAmountsSchema).max(502),
    evidenceId: nullableId,
    reason: reason.nullable(),
  }),
]);
export type TaxTreatment = z.infer<typeof TaxTreatmentSchema>;
export const InvoiceDraftFieldsSchema = z.strictObject({
  sourceKind: SourceKindSchema,
  sourceIdentity: SourceIdentitySchema.nullable(),
  sourceEvidenceId: nullableId,
  invoiceDate: nullableDate,
  dueDate: nullableDate,
  sourceReceivedDate: nullableDate,
  sourceReceivedAt: nullableInstant,
  transactionFrom: nullableDate,
  transactionTo: nullableDate,
  seller: PartySnapshotSchema.nullable(),
  buyer: BuyerSnapshotSchema.nullable(),
  priceMode: z.enum(['inclusive', 'exclusive']),
  rounding: RoundingSchema,
  taxTreatment: TaxTreatmentSchema,
  lines: z.array(InvoiceLineInputSchema).max(500),
  note,
});
export type InvoiceDraftFields = z.infer<typeof InvoiceDraftFieldsSchema>;
export const InvoiceCreateRequestSchema = z.strictObject({
  ...mutation,
  supplierId: FinanceIdSchema,
  predecessorInvoiceId: nullableId,
  draft: InvoiceDraftFieldsSchema,
});
export const InvoiceEditRequestSchema = z.strictObject({
  ...mutation,
  version,
  draft: InvoiceDraftFieldsSchema,
});
export const InvoicePreviewRequestSchema = z.strictObject({
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  invoiceId: nullableId,
  version: version.nullable(),
  draft: InvoiceDraftFieldsSchema,
});
export type InvoiceCreateRequest = z.infer<typeof InvoiceCreateRequestSchema>;
export type InvoiceEditRequest = z.infer<typeof InvoiceEditRequestSchema>;
export type InvoicePreviewRequest = z.infer<typeof InvoicePreviewRequestSchema>;
export const TaxGroupPreviewSchema = z.strictObject({
  groupKey: z.string(),
  taxCategory: TaxCategorySchema,
  rateBps: z.number().int().min(0).max(10000),
  lineCount: z.number().int().positive(),
  computed: TaxAmountsSchema,
  supplierStated: TaxAmountsSchema.nullable(),
  deltaTax: signedMoney,
  allowedVarianceYen: totalMoney,
  withinLimit: z.boolean(),
});
export type TaxGroupPreview = z.infer<typeof TaxGroupPreviewSchema>;
export const InvoicePreviewDtoSchema = z.strictObject({
  previewSha256: Sha256Schema,
  lines: z.array(
    InvoiceLineInputSchema.safeExtend({
      net: totalMoney,
      taxAllocation: totalMoney,
      gross: totalMoney,
    }),
  ),
  taxGroups: z.array(TaxGroupPreviewSchema),
  computedGross: totalMoney,
  statedGross: totalMoney.nullable(),
  acceptedGross: totalMoney.nullable(),
  taxVarianceAcceptanceRequired: z.boolean(),
  completionIssues: z.array(CompletionIssueSchema),
  postReadiness: z.enum(['incomplete', 'needs-tax-variance-acceptance', 'ready']),
});
export type InvoicePreviewDto = z.infer<typeof InvoicePreviewDtoSchema>;
export const TaxVarianceAcceptanceSchema = z.strictObject({
  previewSha256: Sha256Schema,
  reason,
  evidenceId: FinanceIdSchema,
});
export type TaxVarianceAcceptance = z.infer<typeof TaxVarianceAcceptanceSchema>;
export const InvoicePostRequestSchema = z.strictObject({
  ...invoiceMutation,
  effectiveAt: FinanceInstantSchema,
  reason: reason.nullable(),
  taxVarianceAcceptance: TaxVarianceAcceptanceSchema.nullable(),
});
export const InvoiceReasonRequestSchema = z.strictObject({
  ...invoiceMutation,
  reason,
  effectiveAt: FinanceInstantSchema.optional(),
});
export type InvoicePostRequest = z.infer<typeof InvoicePostRequestSchema>;
export type InvoiceReasonRequest = z.infer<typeof InvoiceReasonRequestSchema>;
export const BalanceDtoSchema = z.strictObject({
  originalGross: totalMoney.nullable(),
  credits: totalMoney,
  payments: totalMoney,
  supplierRefunds: totalMoney,
  signedBalance: signedMoney,
  payableAmount: totalMoney,
  refundDueAmount: totalMoney,
  status: PayableStatusSchema.nullable(),
});
export type BalanceDto = z.infer<typeof BalanceDtoSchema>;
export const InvoiceSummaryDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  supplierName: z.string(),
  state: InvoiceStateSchema,
  version,
  sourceKind: SourceKindSchema,
  sourceIdentity: SourceIdentitySchema.nullable(),
  internalReference: z.string(),
  revision: version,
  predecessorInvoiceId: nullableId,
  replacementInvoiceId: nullableId,
  invoiceDate: nullableDate,
  dueDate: nullableDate,
  postedSnapshotSha256: Sha256Schema.nullable(),
  postedSnapshotVersion: version.nullable(),
  supplierConfirmationStatus: z.enum(['not-applicable', 'pending', 'confirmed-recorded']),
  balance: BalanceDtoSchema,
  completionIssues: z.array(CompletionIssueSchema),
  createdAt: FinanceInstantSchema,
  updatedAt: FinanceInstantSchema,
});
export type InvoiceSummaryDto = z.infer<typeof InvoiceSummaryDtoSchema>;
export const LedgerEntryDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  invoiceId: FinanceIdSchema,
  kind: LedgerKindSchema,
  amount: totalMoney,
  signedAmount: signedMoney,
  factId: FinanceIdSchema,
  reversalOf: nullableId,
  occurredAt: FinanceInstantSchema,
  recordedAt: FinanceInstantSchema,
  actorId: FinanceIdSchema,
  reason: reason.nullable(),
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDtoSchema>;
const evidenceMethod = z.enum(['uploaded-original', 'email-copy', 'scanned-paper', 'other']);
const evidenceMedia = z.enum(['application/pdf', 'image/png', 'image/jpeg']);
export const EvidenceDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  invoiceId: FinanceIdSchema,
  storeId: FinanceIdSchema,
  originalName: z.string().min(1).max(200),
  mediaType: evidenceMedia,
  bytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  sha256: Sha256Schema,
  role: EvidenceRoleSchema,
  method: evidenceMethod,
  note,
  actorId: FinanceIdSchema,
  recordedAt: FinanceInstantSchema,
  downloadPath: z.string(),
});
export type EvidenceDto = z.infer<typeof EvidenceDtoSchema>;
const confirmationMethod = z.enum(['email', 'signed-document', 'recorded-meeting', 'other']);
export const SupplierConfirmationRequestSchema = z.strictObject({
  ...invoiceMutation,
  postedSnapshotSha256: Sha256Schema,
  confirmedAt: FinanceInstantSchema,
  counterpartyName: z.string().trim().min(1).max(200),
  method: confirmationMethod,
  evidenceId: FinanceIdSchema,
  note,
});
export const SupplierConfirmationDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  invoiceId: FinanceIdSchema,
  postedSnapshotSha256: Sha256Schema,
  counterpartyName: z.string(),
  confirmedAt: FinanceInstantSchema,
  method: confirmationMethod,
  evidenceId: FinanceIdSchema,
  actorId: FinanceIdSchema,
  recordedAt: FinanceInstantSchema,
  note,
});
export type SupplierConfirmationRequest = z.infer<typeof SupplierConfirmationRequestSchema>;
export type SupplierConfirmationDto = z.infer<typeof SupplierConfirmationDtoSchema>;
export const InvoiceDtoSchema = InvoiceSummaryDtoSchema.extend({
  content: InvoiceDraftFieldsSchema,
  preview: InvoicePreviewDtoSchema,
  evidence: z.array(EvidenceDtoSchema),
  confirmations: z.array(SupplierConfirmationDtoSchema),
  ledger: z.array(LedgerEntryDtoSchema),
  creditAvailability: z.array(
    z.strictObject({
      invoiceLineNo: z.number().int().positive(),
      remainingQuantity: z.number().int().nonnegative(),
      remainingNet: totalMoney,
      remainingTax: totalMoney,
      remainingGross: totalMoney,
    }),
  ),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canCancel: z.boolean(),
    canPost: z.boolean(),
    canVoid: z.boolean(),
    canPay: z.boolean(),
    canCredit: z.boolean(),
    canReceiveRefund: z.boolean(),
    canConfirmSupplier: z.boolean(),
  }),
});
export type InvoiceDto = z.infer<typeof InvoiceDtoSchema>;
export const InvoiceActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  invoice: InvoiceDtoSchema,
});
export const SupplierConfirmationActionDtoSchema = InvoiceActionDtoSchema.extend({
  confirmation: SupplierConfirmationDtoSchema,
});
export type InvoiceActionDto = z.infer<typeof InvoiceActionDtoSchema>;
export type SupplierConfirmationActionDto = z.infer<typeof SupplierConfirmationActionDtoSchema>;

export const PurchaseSupplierLinkRequestSchema = z.strictObject({
  ...mutation,
  supplierId: FinanceIdSchema,
  expectedOrderVersion: version,
  reason,
});
export const PurchaseSupplierLinkDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  orderId: FinanceIdSchema,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  supplierSnapshot: PartySnapshotSchema,
  originalSupplierText: z.string(),
  priorLinkId: nullableId,
  reason,
  recordedAt: FinanceInstantSchema,
});
export type PurchaseSupplierLinkRequest = z.infer<typeof PurchaseSupplierLinkRequestSchema>;
export type PurchaseSupplierLinkDto = z.infer<typeof PurchaseSupplierLinkDtoSchema>;
export const ReceiptCandidateDtoSchema = z.strictObject({
  receiptId: FinanceIdSchema,
  orderId: FinanceIdSchema,
  storeId: FinanceIdSchema,
  supplierId: nullableId,
  receiptLineIndex: z.number().int().nonnegative(),
  productId: FinanceIdSchema,
  name: z.string(),
  receivedAt: FinanceInstantSchema,
  originalQuantity: z.number().int().nonnegative(),
  cancelledQuantity: z.number().int().nonnegative(),
  activeInvoiceAllocatedQuantity: z.number().int().nonnegative(),
  activeReturnedQuantity: z.number().int().nonnegative(),
  ownDraftAllocatedQuantity: z.number().int().nonnegative(),
  invoiceAllocatableQuantity: z.number().int().nonnegative(),
  returnableQuantity: z.number().int().nonnegative(),
  taxStatus: z.literal('not-inferred-from-purchase-order'),
});
export type ReceiptCandidateDto = z.infer<typeof ReceiptCandidateDtoSchema>;
export const PayableRowDtoSchema = BalanceDtoSchema.extend({
  originalGross: totalMoney,
  invoiceId: FinanceIdSchema,
  storeId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  supplierName: z.string(),
  internalReference: z.string(),
  sourceIdentity: SourceIdentitySchema,
  invoiceDate: CalendarDateSchema,
  dueDate: CalendarDateSchema,
  currentState: InvoiceStateSchema,
  stateAtAsOf: z.enum(['posted', 'voided']),
  overdue: z.boolean(),
});
export type PayableRowDto = z.infer<typeof PayableRowDtoSchema>;
export const PayablesPageDtoSchema = financePageSchema(PayableRowDtoSchema).extend({
  asOf: FinanceInstantSchema,
  totals: z.strictObject({
    payableAmount: totalMoney,
    refundDueAmount: totalMoney,
    invoiceCount: z.number().int().nonnegative(),
  }),
});
export type PayablesPageDto = z.infer<typeof PayablesPageDtoSchema>;
const settlement = {
  amount: MoneyYenSchema,
  method: PaymentMethodSchema,
  reference: z.string().max(200).nullable(),
  evidenceId: nullableId,
  note,
};
export const PaymentRequestSchema = z.strictObject({
  ...invoiceMutation,
  invoiceId: FinanceIdSchema,
  ...settlement,
  paidAt: FinanceInstantSchema,
});
export const SupplierRefundRequestSchema = z.strictObject({
  ...invoiceMutation,
  invoiceId: FinanceIdSchema,
  ...settlement,
  receivedAt: FinanceInstantSchema,
});
export const FactReverseRequestSchema = z.strictObject({
  ...invoiceMutation,
  reason,
  effectiveAt: FinanceInstantSchema,
  evidenceId: nullableId,
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;
export type SupplierRefundRequest = z.infer<typeof SupplierRefundRequestSchema>;
export type FactReverseRequest = z.infer<typeof FactReverseRequestSchema>;
export const FactDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  storeId: FinanceIdSchema,
  invoiceId: FinanceIdSchema,
  supplierId: FinanceIdSchema,
  amount: totalMoney,
  occurredAt: FinanceInstantSchema,
  recordedAt: FinanceInstantSchema,
  actorId: FinanceIdSchema,
  reversalOf: nullableId,
  reversedBy: nullableId,
  reason: reason.nullable(),
  ledger: LedgerEntryDtoSchema,
});
export type FactDto = z.infer<typeof FactDtoSchema>;
export const PaymentDtoSchema = FactDtoSchema.extend({
  method: PaymentMethodSchema,
  reference: z.string().nullable(),
  evidenceId: nullableId,
  note,
});
export const SupplierRefundDtoSchema = PaymentDtoSchema;
export const PaymentActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  record: PaymentDtoSchema,
  invoice: InvoiceSummaryDtoSchema,
});
export const RefundActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  record: SupplierRefundDtoSchema,
  invoice: InvoiceSummaryDtoSchema,
});
export type PaymentDto = z.infer<typeof PaymentDtoSchema>;
export type SupplierRefundDto = z.infer<typeof SupplierRefundDtoSchema>;
export type PaymentActionDto = z.infer<typeof PaymentActionDtoSchema>;
export type RefundActionDto = z.infer<typeof RefundActionDtoSchema>;
export const ReturnLineInputSchema = z.strictObject({
  receiptId: FinanceIdSchema,
  receiptLineIndex: z.number().int().min(0).max(499),
  quantity,
});
export type ReturnLineInput = z.infer<typeof ReturnLineInputSchema>;
export const ReturnRequestSchema = z.strictObject({
  ...mutation,
  invoiceId: nullableId,
  expectedInvoiceVersion: version.nullable(),
  returnedAt: FinanceInstantSchema,
  reason,
  lines: z.array(ReturnLineInputSchema).min(1).max(500),
});
export const ReturnReverseRequestSchema = z.strictObject({
  ...mutation,
  expectedInvoiceVersion: version.nullable(),
  effectiveAt: FinanceInstantSchema,
  reason,
});
export const ReturnDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  storeId: FinanceIdSchema,
  invoiceId: nullableId,
  supplierId: nullableId,
  lines: z.array(ReturnLineInputSchema.extend({ productId: FinanceIdSchema, name: z.string() })),
  occurredAt: FinanceInstantSchema,
  recordedAt: FinanceInstantSchema,
  actorId: FinanceIdSchema,
  reason,
  reversalOf: nullableId,
  reversedBy: nullableId,
  inventorySourceId: FinanceIdSchema,
});
export const ReturnActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  record: ReturnDtoSchema,
  invoice: InvoiceSummaryDtoSchema.nullable(),
});
export type ReturnRequest = z.infer<typeof ReturnRequestSchema>;
export type ReturnReverseRequest = z.infer<typeof ReturnReverseRequestSchema>;
export type ReturnDto = z.infer<typeof ReturnDtoSchema>;
export type ReturnActionDto = z.infer<typeof ReturnActionDtoSchema>;
const creditAmount = z.strictObject({
  invoiceLineNo: z.number().int().min(1).max(500),
  net: MoneyYenSchema,
  tax: MoneyYenSchema,
  gross: MoneyYenSchema,
});
export const CreditLinesSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('quantity'),
    lines: z
      .array(z.strictObject({ invoiceLineNo: z.number().int().min(1).max(500), quantity }))
      .min(1)
      .max(500),
  }),
  z.strictObject({ mode: z.literal('amount'), lines: z.array(creditAmount).min(1).max(500) }),
]);
export type CreditLines = z.infer<typeof CreditLinesSchema>;
export const CreditPreviewRequestSchema = z.strictObject({
  storeId: FinanceIdSchema,
  expectedInvoiceVersion: version,
  credit: CreditLinesSchema,
});
const creditPreviewLine = z.strictObject({
  invoiceLineNo: z.number().int().positive(),
  quantity: quantity.nullable(),
  net: totalMoney,
  tax: totalMoney,
  gross: totalMoney,
});
export const CreditPreviewDtoSchema = z.strictObject({
  previewSha256: Sha256Schema,
  lines: z.array(creditPreviewLine),
  groups: z.array(TaxAmountsSchema),
  gross: totalMoney,
  resultingSignedBalance: signedMoney,
  issues: z.array(CompletionIssueSchema),
});
export const CreditRequestSchema = z.strictObject({
  ...invoiceMutation,
  invoiceId: FinanceIdSchema,
  approvedAt: FinanceInstantSchema,
  reason,
  evidenceId: FinanceIdSchema,
  purchaseReturnId: nullableId,
  credit: CreditLinesSchema,
  expectedPreviewSha256: Sha256Schema,
});
export const CreditDtoSchema = FactDtoSchema.extend({
  evidenceId: FinanceIdSchema,
  purchaseReturnId: nullableId,
  lines: z.array(creditPreviewLine),
  groups: z.array(TaxAmountsSchema),
});
export const CreditActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  record: CreditDtoSchema,
  invoice: InvoiceSummaryDtoSchema,
});
export type CreditPreviewRequest = z.infer<typeof CreditPreviewRequestSchema>;
export type CreditPreviewDto = z.infer<typeof CreditPreviewDtoSchema>;
export type CreditRequest = z.infer<typeof CreditRequestSchema>;
export type CreditDto = z.infer<typeof CreditDtoSchema>;
export type CreditActionDto = z.infer<typeof CreditActionDtoSchema>;
export const EvidenceActionDtoSchema = z.strictObject({
  operationId: FinanceIdSchema,
  evidence: EvidenceDtoSchema,
  invoiceId: FinanceIdSchema,
  invoiceVersion: version,
});
export type EvidenceActionDto = z.infer<typeof EvidenceActionDtoSchema>;
export const EvidenceUploadMetadataSchema = z.strictObject({
  ...mutation,
  invoiceVersion: version,
  originalName: z
    .string()
    .min(1)
    .max(200)
    .refine((value) =>
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    ),
  mediaType: evidenceMedia,
  role: EvidenceRoleSchema,
  method: evidenceMethod,
  note,
});
export type EvidenceUploadMetadata = z.infer<typeof EvidenceUploadMetadataSchema>;
const exportCommon = {
  ...mutation,
  asOf: FinanceInstantSchema,
  viewToken: z.string().max(4000).nullable(),
};
export const FinanceExportRequestSchema = z.discriminatedUnion('format', [
  z.strictObject({
    ...exportCommon,
    format: z.literal('purchase-invoice-pdf'),
    invoiceId: FinanceIdSchema,
  }),
  z.strictObject({
    ...exportCommon,
    format: z.literal('purchase-finance-bundle'),
    invoiceId: FinanceIdSchema,
  }),
  z.strictObject({
    ...exportCommon,
    format: z.literal('payables-csv'),
    supplierId: nullableId,
    status: z.enum(['all', 'unpaid', 'partially-paid', 'settled', 'refund-due']),
    overdue: z.boolean().nullable(),
    dueFrom: nullableDate,
    dueTo: nullableDate,
  }),
  z.strictObject({
    ...exportCommon,
    format: z.literal('purchase-payments-csv'),
    supplierId: nullableId,
    invoiceId: nullableId,
    from: nullableDate,
    to: nullableDate,
  }),
]);
export type FinanceExportRequest = z.infer<typeof FinanceExportRequestSchema>;
export const FinanceExportDtoSchema = z.strictObject({
  id: FinanceIdSchema,
  storeId: FinanceIdSchema,
  format: z.enum([
    'purchase-invoice-pdf',
    'purchase-finance-bundle',
    'payables-csv',
    'purchase-payments-csv',
  ]),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  sourceSnapshotSha256: Sha256Schema,
  asOf: FinanceInstantSchema,
  observedAt: FinanceInstantSchema,
  fileSha256: Sha256Schema.nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  mediaType: z.string().nullable(),
  filename: z.string().nullable(),
  downloadPath: z.string().nullable(),
  error: ApiErrorDtoSchema.nullable(),
  createdAt: FinanceInstantSchema,
  completedAt: nullableInstant,
});
export type FinanceExportDto = z.infer<typeof FinanceExportDtoSchema>;
