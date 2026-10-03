import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import * as F from '../../../packages/core/src/finance';
import { Actor, rows, sql, Tx } from './db';
import { Business, digest, json } from './service';
import { BusinessError, requireRule } from './errors';
import { recoveryKey } from './auth';
import { FinanceFiles, fileSha, evidenceLimit } from './finance-files';
import { financeSha, previewInvoice, taxGroupKey } from './finance-tax';

interface SupplierRow {
  id: string;
  body: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface InvoiceRow {
  id: string;
  store_id: string;
  supplier_id: string;
  state: F.InvoiceState;
  version: number;
  draft: unknown;
  supplier_snapshot: unknown;
  internal_reference: string;
  revision: number;
  predecessor_invoice_id: string | null;
  posted_snapshot_sha256: string | null;
  posted_snapshot_version: number | null;
  created_at: Date;
  updated_at: Date;
}
interface EvidenceRow {
  id: string;
  store_id: string;
  invoice_id: string;
  object_key: string;
  bytes: number;
  sha256: string;
  body: unknown;
  actor_id: string;
  recorded_at: Date;
}
interface LedgerRow {
  id: string;
  invoice_id: string;
  kind: F.LedgerKind;
  amount: string;
  signed_amount: string;
  fact_id: string;
  reversal_of: string | null;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
  reason: string | null;
}
interface FactRow {
  id: string;
  store_id: string;
  invoice_id: string;
  supplier_id: string;
  kind: 'payment' | 'credit' | 'refund';
  amount: string;
  body: unknown;
  ledger_id: string;
  reversal_of: string | null;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
  reason: string | null;
}
interface ReturnRow {
  id: string;
  store_id: string;
  invoice_id: string | null;
  supplier_id: string | null;
  body: unknown;
  reversal_of: string | null;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
  reason: string;
}
interface FinanceView {
  scope: string;
  observedAt: string;
  offset: number;
  effectiveAsOf: string | null;
  resultSha256: string | null;
}
const instant = (value: Date) => value.toISOString();
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ledgerSelect = sql`SELECT id,invoice_id,kind,amount::text,signed_amount::text,fact_id,reversal_of,occurred_at,recorded_at,actor_id,reason FROM purchase_ledger`;
const factSelect = sql`SELECT id,store_id,invoice_id,supplier_id,kind,amount::text,body,ledger_id,reversal_of,occurred_at,recorded_at,actor_id,reason FROM purchase_finance_facts`;
export function financeParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BusinessError(
      'INVALID_INPUT',
      '入力内容を確認してください',
      400,
      result.error.issues[0]?.path.join('.'),
    );
  return result.data;
}
export function financeStored<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof z.ZodError)
      throw new BusinessError(
        'INTERNAL_ERROR',
        '保存データを確認できません。同じ操作IDで結果を照合してください',
        500,
        undefined,
        true,
      );
    throw error;
  }
}
function object(value: unknown) {
  return z.record(z.string(), z.unknown()).parse(value);
}
function ledgerDto(row: LedgerRow): F.LedgerEntryDto {
  return F.LedgerEntryDtoSchema.parse({
    id: row.id,
    invoiceId: row.invoice_id,
    kind: row.kind,
    amount: row.amount,
    signedAmount: row.signed_amount,
    factId: row.fact_id,
    reversalOf: row.reversal_of,
    occurredAt: instant(row.occurred_at),
    recordedAt: instant(row.recorded_at),
    actorId: row.actor_id,
    reason: row.reason,
  });
}
export function financeBalance(entries: F.LedgerEntryDto[]): F.BalanceDto {
  const total = (positive: F.LedgerKind, negative: F.LedgerKind) =>
    entries.reduce(
      (sum, e) =>
        sum +
        (e.kind === positive ? BigInt(e.amount) : e.kind === negative ? -BigInt(e.amount) : 0n),
      0n,
    );
  const original = entries.find((e) => e.kind === 'invoice-debit');
  const signed = entries.reduce((sum, e) => sum + BigInt(e.signedAmount), 0n);
  const payments = total('payment', 'payment-reversal');
  return F.BalanceDtoSchema.parse({
    originalGross: original?.amount ?? null,
    credits: total('supplier-credit', 'credit-reversal').toString(),
    payments: payments.toString(),
    supplierRefunds: total('supplier-refund', 'refund-reversal').toString(),
    signedBalance: signed.toString(),
    payableAmount: max(signed, 0n).toString(),
    refundDueAmount: max(-signed, 0n).toString(),
    status: !original
      ? null
      : signed < 0n
        ? 'refund-due'
        : signed === 0n
          ? 'settled'
          : payments > 0n
            ? 'partially-paid'
            : 'unpaid',
  });
}

@Injectable()
export class Finance {
  constructor(
    readonly business: Business,
    readonly files: FinanceFiles,
  ) {}
  authorize(actor: Actor, storeId?: string, financial = false) {
    requireRule(
      !actor.deviceId &&
        (financial ? ['admin', 'headquarters'] : ['admin', 'headquarters', 'manager']).includes(
          actor.role,
        ),
      'ROLE_FORBIDDEN',
      '仕入金融情報の操作権限がありません',
      403,
    );
    if (storeId !== undefined) this.business.access(actor, storeId);
  }
  private async read<T>(actor: Actor, storeId: string | undefined, fn: (tx: Tx) => Promise<T>) {
    this.authorize(actor, storeId);
    try {
      return await this.business.database.transaction(actor, async (tx) => {
        await this.business.contract(tx, false);
        return fn(tx);
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError)
        throw new BusinessError(
          'INTERNAL_ERROR',
          '保存データを確認できません。同じ操作IDで結果を照合してください',
          500,
          undefined,
          true,
        );
      throw error;
    }
  }
  private async operate<T>(
    actor: Actor,
    input: Record<string, unknown>,
    action: string,
    storeId: string | null,
    schema: z.ZodType<T>,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const result: unknown = await this.business.mutation(
      actor,
      input,
      action,
      storeId,
      async (tx) => financeStored(schema, await fn(tx)),
    );
    return financeStored(schema, result);
  }
  async replay<T>(
    actor: Actor,
    input: Record<string, unknown>,
    action: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    return this.business.database.transaction(actor, async (tx) => {
      const [prior] = await rows<{ hash: string; result: unknown }>(
        tx,
        sql`SELECT hash,result FROM operations WHERE id=${String(input.operationId)}::uuid`,
      );
      if (!prior) return null;
      requireRule(
        prior.hash === digest({ action, input }),
        'IDEMPOTENCY_CONFLICT',
        '同じ操作IDの内容が異なります',
      );
      return financeStored(schema, prior.result);
    });
  }
  private async marker(
    tx: Tx,
    actor: Actor,
    id: string,
    status: string,
    version: number,
    storeId: string | null,
  ) {
    await this.business.change(tx, actor, 'purchase-finance', id, { id, status, version }, storeId);
  }
  private supplierDto(row: SupplierRow) {
    const body = object(row.body);
    return F.SupplierDtoSchema.parse({
      ...body,
      id: row.id,
      version: row.version,
      registrationCheck: body.registered === true ? 'format-only' : 'not-registered',
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
    });
  }
  async supplier(tx: Tx, id: string, active = false) {
    const [row] = await rows<SupplierRow>(
      tx,
      sql`SELECT id,body,version,created_at,updated_at FROM purchase_suppliers WHERE id=${id}::uuid`,
    );
    requireRule(row, 'SUPPLIER_NOT_FOUND', '仕入先がありません', 404);
    const dto = this.supplierDto(row);
    if (active) requireRule(dto.active, 'SUPPLIER_INACTIVE', '有効な仕入先を選択してください');
    return dto;
  }
  async suppliers(actor: Actor, input: unknown) {
    const query = financeParse(F.SupplierQuerySchema, input);
    return this.read(actor, undefined, async (tx) => {
      const all = await rows<SupplierRow>(
        tx,
        sql`SELECT id,body,version,created_at,updated_at FROM purchase_suppliers WHERE (${query.active ?? 'true'}='all' OR active=${query.active !== 'false'}) AND (body->>'name' ILIKE ${'%' + (query.search ?? '') + '%'} OR code ILIKE ${'%' + (query.search ?? '') + '%'}) ORDER BY created_at,id`,
      );
      return this.page(
        actor,
        'suppliers',
        query,
        all.map((r) => this.supplierDto(r)),
      );
    });
  }
  async saveSupplier(actor: Actor, input: unknown, id?: string) {
    this.authorize(actor, undefined, true);
    if (id !== undefined) financeParse(F.FinanceIdSchema, id);
    const data = id
      ? financeParse(F.SupplierUpdateRequestSchema, input)
      : financeParse(F.SupplierCreateRequestSchema, input);
    const intent = { ...data, ...(id ? { targetId: id } : {}) };
    return this.operate(
      actor,
      intent,
      id ? 'finance.supplier.edit' : 'finance.supplier.create',
      null,
      F.SupplierDtoSchema,
      async (tx) => {
        const supplierId = id ?? randomUUID();
        const [duplicate] = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM purchase_suppliers WHERE code=${data.code} AND id<>${supplierId}::uuid`,
        );
        requireRule(!duplicate, 'SUPPLIER_CODE_CONFLICT', '仕入先コードが重複しています');
        const body = { ...data };
        delete (body as Partial<typeof data>).operationId;
        if ('version' in body) delete body.version;
        if (id) {
          const current = await this.supplier(tx, id);
          requireRule(
            'version' in data && current.version === data.version,
            'VERSION_CONFLICT',
            '仕入先が更新されています',
          );
          await tx.$executeRaw(
            sql`UPDATE purchase_suppliers SET code=${data.code},body=${json(body)}::jsonb,active=${data.active},version=version+1,updated_at=clock_timestamp() WHERE id=${id}::uuid`,
          );
        } else
          await tx.$executeRaw(
            sql`INSERT INTO purchase_suppliers(id,tenant_id,code,body,active) VALUES(${supplierId}::uuid,${actor.tenantId}::uuid,${data.code},${json(body)}::jsonb,${data.active})`,
          );
        const saved = await this.supplier(tx, supplierId);
        await this.marker(
          tx,
          actor,
          supplierId,
          data.active ? 'active' : 'inactive',
          saved.version,
          null,
        );
        return saved;
      },
    );
  }
  async invoiceRow(tx: Tx, id: string, storeId: string) {
    const [row] = await rows<InvoiceRow>(
      tx,
      sql`SELECT * FROM purchase_invoices WHERE id=${id}::uuid AND store_id=${storeId}::uuid FOR UPDATE`,
    );
    requireRule(row, 'NOT_FOUND', '仕入請求がありません', 404);
    return row;
  }
  private expected(row: InvoiceRow, version: number) {
    requireRule(
      row.version === version,
      'VERSION_CONFLICT',
      '仕入請求が更新されています。最新版を確認してください',
    );
  }
  private state(row: InvoiceRow, state: F.InvoiceState) {
    requireRule(row.state === state, 'INVOICE_STATE', '仕入請求の状態を確認してください');
  }
  private async bump(tx: Tx, actor: Actor, row: InvoiceRow) {
    await tx.$executeRaw(
      sql`UPDATE purchase_invoices SET version=version+1,updated_at=clock_timestamp() WHERE id=${row.id}::uuid`,
    );
    await this.marker(tx, actor, row.id, row.state, row.version + 1, row.store_id);
  }
  private evidenceDto(row: EvidenceRow) {
    return F.EvidenceDtoSchema.parse({
      ...object(row.body),
      id: row.id,
      storeId: row.store_id,
      invoiceId: row.invoice_id,
      bytes: row.bytes,
      sha256: row.sha256,
      actorId: row.actor_id,
      recordedAt: instant(row.recorded_at),
      downloadPath: '/v1/purchase-invoices/' + row.invoice_id + '/evidence/' + row.id + '/download',
    });
  }
  private async evidenceRow(tx: Tx, invoice: InvoiceRow, id: string, roles?: F.EvidenceRole[]) {
    const [row] = await rows<EvidenceRow>(
      tx,
      sql`SELECT * FROM purchase_evidence WHERE id=${id}::uuid AND invoice_id=${invoice.id}::uuid AND store_id=${invoice.store_id}::uuid`,
    );
    requireRule(row, 'INVOICE_SOURCE_REQUIRED', '請求に属する保存済み証憑が必要です');
    const dto = this.evidenceDto(row);
    if (roles)
      requireRule(
        roles.includes(dto.role),
        'INVOICE_SOURCE_REQUIRED',
        '用途に合った証憑を選択してください',
      );
    return row;
  }
  async invoiceDto(tx: Tx, actor: Actor, row: InvoiceRow): Promise<F.InvoiceDto> {
    const [snapshot] = await rows<{ content: unknown; preview: unknown }>(
      tx,
      sql`SELECT content,preview FROM purchase_invoice_snapshots WHERE invoice_id=${row.id}::uuid`,
    );
    const content = F.InvoiceDraftFieldsSchema.parse(snapshot?.content ?? row.draft);
    const preview = snapshot
      ? F.InvoicePreviewDtoSchema.parse(snapshot.preview)
      : previewInvoice(content);
    const entries = (
      await rows<LedgerRow>(
        tx,
        sql`${ledgerSelect} WHERE invoice_id=${row.id}::uuid ORDER BY recorded_at,id`,
      )
    ).map(ledgerDto);
    const financial = financeBalance(entries);
    const evidence = (
      await rows<EvidenceRow>(
        tx,
        sql`SELECT * FROM purchase_evidence WHERE invoice_id=${row.id}::uuid ORDER BY recorded_at,id`,
      )
    ).map((r) => this.evidenceDto(r));
    const confirmations = (
      await rows<{
        id: string;
        body: unknown;
        snapshot_sha256: string;
        evidence_id: string;
        actor_id: string;
        recorded_at: Date;
      }>(
        tx,
        sql`SELECT * FROM purchase_supplier_confirmations WHERE invoice_id=${row.id}::uuid ORDER BY recorded_at,id`,
      )
    ).map((c) =>
      F.SupplierConfirmationDtoSchema.parse({
        ...object(c.body),
        id: c.id,
        invoiceId: row.id,
        postedSnapshotSha256: c.snapshot_sha256,
        evidenceId: c.evidence_id,
        actorId: c.actor_id,
        recordedAt: instant(c.recorded_at),
      }),
    );
    const [replacement] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM purchase_invoices WHERE predecessor_invoice_id=${row.id}::uuid AND state IN ('draft','posted','voided')`,
    );
    const financialRole = ['admin', 'headquarters'].includes(actor.role);
    const supplier = F.PartySnapshotSchema.parse(row.supplier_snapshot);
    const creditAvailability = await this.creditAvailability(tx, row, preview);
    return F.InvoiceDtoSchema.parse({
      id: row.id,
      storeId: row.store_id,
      supplierId: row.supplier_id,
      supplierName: supplier.name,
      state: row.state,
      version: row.version,
      sourceKind: content.sourceKind,
      sourceIdentity: content.sourceIdentity,
      internalReference: row.internal_reference,
      revision: row.revision,
      predecessorInvoiceId: row.predecessor_invoice_id,
      replacementInvoiceId: replacement?.id ?? null,
      invoiceDate: content.invoiceDate,
      dueDate: content.dueDate,
      postedSnapshotSha256: row.posted_snapshot_sha256,
      postedSnapshotVersion: row.posted_snapshot_version,
      supplierConfirmationStatus:
        content.sourceKind === 'supplier-invoice'
          ? 'not-applicable'
          : confirmations.some((c) => c.postedSnapshotSha256 === row.posted_snapshot_sha256)
            ? 'confirmed-recorded'
            : 'pending',
      balance: financial,
      completionIssues: preview.completionIssues,
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
      content,
      preview,
      evidence,
      confirmations,
      ledger: entries,
      creditAvailability,
      permissions: {
        canEdit: row.state === 'draft',
        canCancel: row.state === 'draft',
        canPost: financialRole && row.state === 'draft',
        canVoid: financialRole && row.state === 'posted',
        canPay: financialRole && row.state === 'posted' && BigInt(financial.payableAmount) > 0n,
        canCredit: financialRole && row.state === 'posted',
        canReceiveRefund:
          financialRole && row.state === 'posted' && BigInt(financial.refundDueAmount) > 0n,
        canConfirmSupplier:
          financialRole && row.state === 'posted' && content.sourceKind === 'buyer-statement',
      },
    });
  }
  private async creditAvailability(tx: Tx, row: InvoiceRow, preview: F.InvoicePreviewDto) {
    const active = await rows<{ body: unknown }>(
      tx,
      sql`SELECT f.body FROM purchase_finance_facts f WHERE f.invoice_id=${row.id}::uuid AND f.kind='credit' AND f.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM purchase_finance_facts r WHERE r.reversal_of=f.id)`,
    );
    const credits = active.flatMap((f) =>
      z
        .array(
          z.object({
            invoiceLineNo: z.number(),
            quantity: z.number().nullable(),
            net: z.string(),
            tax: z.string(),
            gross: z.string(),
          }),
        )
        .parse(object(f.body).lines),
    );
    return preview.lines.map((line) => {
      const used = credits.filter((c) => c.invoiceLineNo === line.lineNo);
      return {
        invoiceLineNo: line.lineNo,
        remainingQuantity: line.quantity - used.reduce((s, c) => s + (c.quantity ?? 0), 0),
        remainingNet: (BigInt(line.net) - used.reduce((s, c) => s + BigInt(c.net), 0n)).toString(),
        remainingTax: (
          BigInt(line.taxAllocation) - used.reduce((s, c) => s + BigInt(c.tax), 0n)
        ).toString(),
        remainingGross: (
          BigInt(line.gross) - used.reduce((s, c) => s + BigInt(c.gross), 0n)
        ).toString(),
      };
    });
  }
  async invoice(actor: Actor, id: string, storeId: unknown) {
    const store = financeParse(F.FinanceIdSchema, storeId);
    financeParse(F.FinanceIdSchema, id);
    return this.read(actor, store, async (tx) =>
      this.invoiceDto(tx, actor, await this.invoiceRow(tx, id, store)),
    );
  }
  async invoices(actor: Actor, input: unknown) {
    const q = financeParse(F.InvoiceQuerySchema, input);
    return this.read(actor, q.storeId, async (tx) => {
      const all = await rows<InvoiceRow>(
        tx,
        sql`SELECT * FROM purchase_invoices WHERE store_id=${q.storeId}::uuid AND (${q.supplierId ?? null}::uuid IS NULL OR supplier_id=${q.supplierId ?? null}::uuid) AND (${q.state ?? 'all'}='all' OR state=${q.state ?? 'all'}) ORDER BY created_at,id`,
      );
      const invoices: F.InvoiceSummaryDto[] = [];
      for (const r of all) {
        const dto = await this.invoiceDto(tx, actor, r);
        if (
          (q.from && (!dto.invoiceDate || dto.invoiceDate < q.from)) ||
          (q.to && (!dto.invoiceDate || dto.invoiceDate > q.to)) ||
          (q.search &&
            !json([dto.internalReference, dto.sourceIdentity, dto.supplierName]).includes(q.search))
        )
          continue;
        invoices.push(F.InvoiceSummaryDtoSchema.strip().parse(dto));
      }
      return this.page(actor, 'invoices', q, invoices);
    });
  }
  async saveInvoice(actor: Actor, input: unknown, id?: string) {
    if (id) financeParse(F.FinanceIdSchema, id);
    const data = id
      ? financeParse(F.InvoiceEditRequestSchema, input)
      : financeParse(F.InvoiceCreateRequestSchema, input);
    this.authorize(actor, data.storeId);
    if ('predecessorInvoiceId' in data && data.predecessorInvoiceId)
      this.authorize(actor, data.storeId, true);
    return this.operate(
      actor,
      { ...data, ...(id ? { targetId: id } : {}) },
      id ? 'finance.invoice.edit' : 'finance.invoice.create',
      data.storeId,
      F.InvoiceDtoSchema,
      async (tx) => {
        let invoiceId: string;
        if (id && 'version' in data) {
          const current = await this.invoiceRow(tx, id, data.storeId);
          this.expected(current, data.version);
          this.state(current, 'draft');
          await this.validateAllocations(tx, current, data.draft);
          await tx.$executeRaw(
            sql`UPDATE purchase_invoices SET draft=${json(data.draft)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE id=${id}::uuid`,
          );
          invoiceId = id;
        } else {
          requireRule('supplierId' in data, 'INVALID_INPUT', '仕入先が必要です', 400);
          const supplier = await this.supplier(tx, data.supplierId, true);
          const supplierSnapshot = F.PartySnapshotSchema.parse({
            name: supplier.name,
            address: supplier.address,
            registered: supplier.registered,
            registrationNumber: supplier.registrationNumber,
          });
          invoiceId = randomUUID();
          if (data.predecessorInvoiceId) {
            const predecessor = await this.invoiceRow(tx, data.predecessorInvoiceId, data.storeId);
            requireRule(
              predecessor.state === 'voided' && predecessor.supplier_id === data.supplierId,
              'INVOICE_REPLACEMENT_CONFLICT',
              '同店舗・仕入先の取消済み原請求を指定してください',
            );
            const [replacement] = await rows<{ id: string }>(
              tx,
              sql`SELECT id FROM purchase_invoices WHERE predecessor_invoice_id=${data.predecessorInvoiceId}::uuid AND state IN ('draft','posted','voided') LIMIT 1`,
            );
            requireRule(
              !replacement,
              'INVOICE_REPLACEMENT_CONFLICT',
              '原請求の訂正下書き・訂正版が既にあります',
            );
          }
          await tx.$executeRaw(
            sql`INSERT INTO purchase_invoices(id,tenant_id,store_id,supplier_id,state,draft,supplier_snapshot,internal_reference,predecessor_invoice_id) VALUES(${invoiceId}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${data.supplierId}::uuid,'draft',${json(data.draft)}::jsonb,${json(supplierSnapshot)}::jsonb,${'PI-' + invoiceId},${data.predecessorInvoiceId}::uuid)`,
          );
          await this.validateAllocations(
            tx,
            await this.invoiceRow(tx, invoiceId, data.storeId),
            data.draft,
          );
        }
        const current = await this.invoiceRow(tx, invoiceId, data.storeId);
        await this.marker(tx, actor, invoiceId, current.state, current.version, data.storeId);
        return this.invoiceDto(tx, actor, current);
      },
    );
  }
  async preview(actor: Actor, input: unknown) {
    const data = financeParse(F.InvoicePreviewRequestSchema, input);
    return this.read(actor, data.storeId, async (tx) => {
      await this.supplier(tx, data.supplierId);
      if (data.invoiceId) {
        const row = await this.invoiceRow(tx, data.invoiceId, data.storeId);
        requireRule(row.supplier_id === data.supplierId, 'FACT_MISMATCH', '仕入先が異なります');
        if (data.version !== null) this.expected(row, data.version);
        await this.validateAllocations(tx, row, data.draft);
      } else
        await this.validateAllocations(
          tx,
          { id: randomUUID(), store_id: data.storeId, supplier_id: data.supplierId },
          data.draft,
          false,
        );
      return previewInvoice(data.draft);
    });
  }
  private async verifyPostEvidence(actor: Actor, id: string, data: F.InvoicePostRequest) {
    const evidence = await this.read(actor, data.storeId, async (tx) => {
      const row = await this.invoiceRow(tx, id, data.storeId);
      this.expected(row, data.expectedInvoiceVersion);
      this.state(row, 'draft');
      const draft = F.InvoiceDraftFieldsSchema.parse(row.draft);
      const records: EvidenceRow[] = [];
      if (draft.sourceKind === 'supplier-invoice') {
        requireRule(draft.sourceEvidenceId, 'INVOICE_SOURCE_REQUIRED', '原請求の証憑が必要です');
        records.push(await this.evidenceRow(tx, row, draft.sourceEvidenceId, ['source-invoice']));
      }
      if (draft.sourceIdentity?.kind === 'unnumbered') {
        requireRule(
          draft.sourceIdentity.sourceEvidenceId,
          'INVOICE_SOURCE_REQUIRED',
          '原番号のない請求の識別証憑が必要です',
        );
        records.push(
          await this.evidenceRow(tx, row, draft.sourceIdentity.sourceEvidenceId, [
            'source-identification',
            'source-invoice',
          ]),
        );
      }
      if (draft.taxTreatment.mode === 'supplier-stated') {
        requireRule(
          draft.taxTreatment.evidenceId,
          'INVOICE_SOURCE_REQUIRED',
          '転記元の証憑が必要です',
        );
        records.push(
          await this.evidenceRow(tx, row, draft.taxTreatment.evidenceId, [
            'source-invoice',
            'tax-variance',
          ]),
        );
      }
      if (data.taxVarianceAcceptance)
        records.push(
          await this.evidenceRow(tx, row, data.taxVarianceAcceptance.evidenceId, [
            'source-invoice',
            'tax-variance',
          ]),
        );
      return records;
    });
    for (const e of evidence) await this.files.get(e.object_key, e.bytes, e.sha256);
  }
  async post(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.InvoicePostRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    const intent = { ...data, targetId: id };
    const prior = await this.replay(
      actor,
      intent,
      'finance.invoice.post',
      F.InvoiceActionDtoSchema,
    );
    if (prior) return prior;
    await this.verifyPostEvidence(actor, id, data);
    try {
      return await this.operate(
        actor,
        intent,
        'finance.invoice.post',
        data.storeId,
        F.InvoiceActionDtoSchema,
        async (tx) => {
          const row = await this.invoiceRow(tx, id, data.storeId);
          this.expected(row, data.expectedInvoiceVersion);
          this.state(row, 'draft');
          const draft = F.InvoiceDraftFieldsSchema.parse(row.draft);
          const preview = previewInvoice(draft);
          requireRule(
            preview.completionIssues.length === 0 && preview.acceptedGross !== null,
            'INVOICE_INCOMPLETE',
            '原書類・明細・税区分の未完了項目を確認してください',
          );
          requireRule(
            BigInt(preview.acceptedGross) > 0n,
            'INVOICE_INCOMPLETE',
            '請求総額は正の金額が必要です',
          );
          if (preview.taxVarianceAcceptanceRequired) {
            requireRule(
              data.taxVarianceAcceptance &&
                data.taxVarianceAcceptance.previewSha256 === preview.previewSha256,
              'TAX_VARIANCE_CONFIRMATION_REQUIRED',
              '同じ計算結果の端数差を理由・証憑付きで確認してください',
            );
            await this.evidenceRow(tx, row, data.taxVarianceAcceptance.evidenceId, [
              'source-invoice',
              'tax-variance',
            ]);
          }
          this.factDate(data.effectiveAt);
          const invoiceDay = draft.invoiceDate;
          requireRule(
            invoiceDay && invoiceDay <= this.japanDay(data.effectiveAt),
            'FACT_DATE_ORDER',
            '実際の債務発生日時と原請求日を確認してください',
          );
          if (invoiceDay !== this.japanDay(data.effectiveAt))
            requireRule(
              data.reason,
              'FACT_DATE_ORDER',
              '原書類日と債務発生日が異なる理由を記録してください',
            );
          await this.validateAllocations(tx, row, draft);
          const identity = draft.sourceIdentity;
          requireRule(identity, 'INVOICE_INCOMPLETE', '原請求の識別情報が必要です');
          const key =
            (identity.kind === 'numbered' ? 'number:' : 'reference:') +
            (identity.kind === 'numbered'
              ? identity.invoiceNumber
              : identity.sourceReference
            ).trim();
          let revision = 1;
          if (row.predecessor_invoice_id) {
            const predecessor = await this.invoiceRow(tx, row.predecessor_invoice_id, row.store_id);
            const previous = F.InvoiceDraftFieldsSchema.parse(predecessor.draft).sourceIdentity;
            requireRule(
              predecessor.state === 'voided' &&
                predecessor.supplier_id === row.supplier_id &&
                previous &&
                (previous.kind === 'numbered' ? 'number:' : 'reference:') +
                  (previous.kind === 'numbered'
                    ? previous.invoiceNumber
                    : previous.sourceReference
                  ).trim() ===
                  key,
              'INVOICE_REPLACEMENT_CONFLICT',
              '取消済み原請求と同じ仕入先・原番号を維持してください',
            );
            revision = predecessor.revision + 1;
          }
          const [existing] = await rows<{ invoice_id: string }>(
            tx,
            sql`SELECT invoice_id FROM purchase_invoice_identity WHERE supplier_id=${row.supplier_id}::uuid AND identity_key=${key} AND revision=${revision}`,
          );
          requireRule(!existing, 'INVOICE_NUMBER_CONFLICT', 'この仕入先の原請求識別は確定済みです');
          if (row.predecessor_invoice_id) {
            const [replacement] = await rows<{ id: string }>(
              tx,
              sql`SELECT id FROM purchase_invoices WHERE predecessor_invoice_id=${row.predecessor_invoice_id}::uuid AND state IN ('posted','voided')`,
            );
            requireRule(
              !replacement,
              'INVOICE_REPLACEMENT_CONFLICT',
              '原請求の訂正版は確定済みです',
            );
          }
          const postedSource = {
            content: draft,
            preview,
            supplierSnapshot: F.PartySnapshotSchema.parse(row.supplier_snapshot),
            effectiveAt: data.effectiveAt,
            reason: data.reason,
            taxVarianceAcceptance: data.taxVarianceAcceptance,
            revision,
          };
          const sha = financeSha(postedSource);
          await tx.$executeRaw(
            sql`INSERT INTO purchase_invoice_identity(tenant_id,store_id,supplier_id,identity_key,revision,invoice_id) VALUES(${actor.tenantId}::uuid,${row.store_id}::uuid,${row.supplier_id}::uuid,${key},${revision},${id}::uuid)`,
          );
          await tx.$executeRaw(
            sql`INSERT INTO purchase_invoice_snapshots(invoice_id,tenant_id,store_id,version,sha256,content,preview,supplier_snapshot,effective_at,reason,actor_id) VALUES(${id}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.version + 1},${sha},${json(draft)}::jsonb,${json(preview)}::jsonb,${json(row.supplier_snapshot)}::jsonb,${data.effectiveAt}::timestamptz,${data.reason},${actor.staffId}::uuid)`,
          );
          for (const line of draft.lines)
            for (const allocation of line.receiptAllocations)
              await tx.$executeRaw(
                sql`INSERT INTO purchase_invoice_allocations(id,tenant_id,store_id,invoice_id,invoice_line_no,receipt_id,receipt_line_index,quantity) VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${id}::uuid,${line.lineNo},${allocation.receiptId}::uuid,${allocation.receiptLineIndex},${allocation.quantity})`,
              );
          await this.insertLedger(
            tx,
            actor,
            row,
            'invoice-debit',
            preview.acceptedGross,
            id,
            data.effectiveAt,
            null,
            data.reason,
          );
          await tx.$executeRaw(
            sql`UPDATE purchase_invoices SET state='posted',version=version+1,updated_at=clock_timestamp(),posted_snapshot_sha256=${sha},posted_snapshot_version=${row.version + 1},revision=${revision} WHERE id=${id}::uuid`,
          );
          await this.marker(tx, actor, id, 'posted', row.version + 1, row.store_id);
          return {
            operationId: data.operationId,
            invoice: await this.invoiceDto(tx, actor, await this.invoiceRow(tx, id, row.store_id)),
          };
        },
      );
    } catch (error: unknown) {
      if (this.unique(error))
        throw new BusinessError('INVOICE_NUMBER_CONFLICT', 'この仕入先の原請求識別は確定済みです');
      throw error;
    }
  }
  private unique(error: unknown) {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false;
    if (error.code === '23505' || error.code === 'P2002') return true;
    return (
      error.code === 'P2010' &&
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'code' in error.meta &&
      error.meta.code === '23505'
    );
  }
  private factDate(value: string, lower?: string, code = 'FACT_DATE_ORDER') {
    requireRule(
      Date.parse(value) <= Date.now(),
      'FACT_DATE_ORDER',
      '未来の事実は記録できません。実際の日時を確認してください',
    );
    requireRule(
      !lower || Date.parse(value) >= Date.parse(lower),
      code,
      '実際の日時を確認してください。元記録より前の日時・未来の事実は記録できません',
    );
  }
  private japanDay(value: string) {
    return new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
  }
  private async insertLedger(
    tx: Tx,
    actor: Actor,
    row: InvoiceRow,
    kind: F.LedgerKind,
    amount: string,
    factId: string,
    occurredAt: string,
    reversalOf: string | null,
    reason: string | null,
  ) {
    requireRule(
      /^(0|[1-9][0-9]{0,39})$/u.test(amount),
      'FINANCE_AMOUNT_LIMIT',
      'この金額は記録可能な範囲を超えています',
    );
    const id = randomUUID();
    await tx.$executeRaw(
      sql`INSERT INTO purchase_ledger(id,tenant_id,store_id,invoice_id,kind,amount,fact_id,reversal_of,occurred_at,actor_id,reason) VALUES(${id}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.id}::uuid,${kind},${amount}::numeric,${factId}::uuid,${reversalOf}::uuid,${occurredAt}::timestamptz,${actor.staffId}::uuid,${reason})`,
    );
    return id;
  }
  private async debitDate(tx: Tx, row: InvoiceRow) {
    const [debit] = await rows<{ occurred_at: Date }>(
      tx,
      sql`SELECT occurred_at FROM purchase_ledger WHERE invoice_id=${row.id}::uuid AND kind='invoice-debit'`,
    );
    requireRule(debit, 'INVOICE_STATE', '確定済み債務がありません');
    return instant(debit.occurred_at);
  }
  async evidence(actor: Actor, id: string, metadata: unknown, bytes: Buffer) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.EvidenceUploadMetadataSchema, metadata);
    this.authorize(actor, data.storeId);
    requireRule(
      bytes.length > 0 && bytes.length <= evidenceLimit,
      'PAYLOAD_TOO_LARGE',
      '証憑は10MiB以内で送信してください',
      413,
    );
    const valid =
      data.mediaType === 'application/pdf'
        ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
        : data.mediaType === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    requireRule(valid, 'EVIDENCE_FORMAT', 'ファイル形式と内容が一致しません', 400);
    const sha = fileSha(bytes);
    const intent = { ...data, targetId: id, sha256: sha, bytes: bytes.length };
    const prior = await this.replay(
      actor,
      intent,
      'finance.evidence.upload',
      F.EvidenceActionDtoSchema,
    );
    if (prior) return prior;
    await this.read(actor, data.storeId, async (tx) => {
      const row = await this.invoiceRow(tx, id, data.storeId);
      this.expected(row, data.invoiceVersion);
      requireRule(
        ['draft', 'posted'].includes(row.state),
        'INVOICE_STATE',
        '証憑を追加できない状態です',
      );
      const [count] = await rows<{ count: number }>(
        tx,
        sql`SELECT count(*)::int AS count FROM purchase_evidence WHERE invoice_id=${id}::uuid`,
      );
      requireRule(count.count < 20, 'EVIDENCE_LIMIT', '請求ごとの証憑は20件までです');
    });
    const evidenceId = randomUUID(),
      key = actor.tenantId + '/finance/evidence/' + evidenceId;
    await this.files.put(key, bytes, data.mediaType);
    // An uncertain commit must retain the immutable object; it can be reconciled later.
    return this.operate(
      actor,
      intent,
      'finance.evidence.upload',
      data.storeId,
      F.EvidenceActionDtoSchema,
      async (tx) => {
        const row = await this.invoiceRow(tx, id, data.storeId);
        this.expected(row, data.invoiceVersion);
        requireRule(
          ['draft', 'posted'].includes(row.state),
          'INVOICE_STATE',
          '証憑を追加できない状態です',
        );
        const [count] = await rows<{ count: number }>(
          tx,
          sql`SELECT count(*)::int AS count FROM purchase_evidence WHERE invoice_id=${id}::uuid`,
        );
        requireRule(count.count < 20, 'EVIDENCE_LIMIT', '請求ごとの証憑は20件までです');
        const body = {
          originalName: data.originalName,
          mediaType: data.mediaType,
          role: data.role,
          method: data.method,
          note: data.note,
        };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_evidence(id,tenant_id,store_id,invoice_id,object_key,bytes,sha256,body,actor_id) VALUES(${evidenceId}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${id}::uuid,${key},${bytes.length},${sha},${json(body)}::jsonb,${actor.staffId}::uuid)`,
        );
        await this.bump(tx, actor, row);
        const evidence = await this.evidenceRow(tx, row, evidenceId);
        return {
          operationId: data.operationId,
          evidence: this.evidenceDto(evidence),
          invoiceId: id,
          invoiceVersion: row.version + 1,
        };
      },
    );
  }
  async downloadEvidence(actor: Actor, id: string, evidenceId: string, storeId: unknown) {
    financeParse(F.FinanceIdSchema, id);
    financeParse(F.FinanceIdSchema, evidenceId);
    const store = financeParse(F.FinanceIdSchema, storeId);
    const row = await this.read(actor, store, async (tx) =>
      this.evidenceRow(tx, await this.invoiceRow(tx, id, store), evidenceId),
    );
    const dto = this.evidenceDto(row);
    return {
      bytes: await this.files.get(row.object_key, row.bytes, row.sha256),
      mediaType: dto.mediaType,
      name: dto.originalName,
      sha256: dto.sha256,
    };
  }
  async settle(actor: Actor, input: unknown, kind: 'payment' | 'refund') {
    const data =
      kind === 'payment'
        ? financeParse(F.PaymentRequestSchema, input)
        : financeParse(F.SupplierRefundRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    return this.operate(
      actor,
      data,
      'finance.' + kind + '.record',
      data.storeId,
      F.PaymentActionDtoSchema,
      async (tx) => {
        const row = await this.invoiceRow(tx, data.invoiceId, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        this.state(row, 'posted');
        const dto = await this.invoiceDto(tx, actor, row);
        const amount = BigInt(data.amount);
        requireRule(
          amount > 0n &&
            amount <=
              BigInt(kind === 'payment' ? dto.balance.payableAmount : dto.balance.refundDueAmount),
          kind === 'payment' ? 'OVER_PAYMENT' : 'OVER_REFUND',
          '記録金額は未決済残高以内にしてください',
        );
        const occurredAt = 'paidAt' in data ? data.paidAt : data.receivedAt;
        this.factDate(
          occurredAt,
          await this.debitDate(tx, row),
          kind === 'payment' ? 'PREPAYMENT_UNSUPPORTED' : 'FACT_DATE_ORDER',
        );
        requireRule(
          data.method !== 'bank-transfer' || data.reference?.trim(),
          'INVALID_INPUT',
          '実施済み振込の参照情報を記録してください',
          400,
        );
        requireRule(
          data.method !== 'other' || data.note.trim(),
          'INVALID_INPUT',
          'その他の決済方法を記録してください',
          400,
        );
        if (data.evidenceId)
          await this.evidenceRow(tx, row, data.evidenceId, [
            kind === 'payment' ? 'payment' : 'supplier-refund',
            'supporting',
          ]);
        const factId = randomUUID();
        const ledgerId = await this.insertLedger(
          tx,
          actor,
          row,
          kind === 'payment' ? 'payment' : 'supplier-refund',
          data.amount,
          factId,
          occurredAt,
          null,
          null,
        );
        const body = {
          method: data.method,
          reference: data.reference,
          evidenceId: data.evidenceId,
          note: data.note,
        };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,occurred_at,actor_id) VALUES(${factId}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.id}::uuid,${row.supplier_id}::uuid,${kind},${data.amount}::numeric,${json(body)}::jsonb,${ledgerId}::uuid,${occurredAt}::timestamptz,${actor.staffId}::uuid)`,
        );
        await this.bump(tx, actor, row);
        return {
          operationId: data.operationId,
          record: await this.factDto(tx, factId),
          invoice: F.InvoiceSummaryDtoSchema.strip().parse(
            await this.invoiceDto(tx, actor, await this.invoiceRow(tx, row.id, row.store_id)),
          ),
        };
      },
    );
  }
  async reverseSettlement(actor: Actor, id: string, input: unknown, kind: 'payment' | 'refund') {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.FactReverseRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    return this.operate(
      actor,
      { ...data, targetId: id },
      'finance.' + kind + '.reverse',
      data.storeId,
      F.PaymentActionDtoSchema,
      async (tx) => {
        const [original] = await rows<FactRow>(
          tx,
          sql`${factSelect} WHERE id=${id}::uuid AND store_id=${data.storeId}::uuid AND kind=${kind}`,
        );
        requireRule(original, 'NOT_FOUND', '元の決済記録がありません', 404);
        requireRule(!original.reversal_of, 'FACT_MISMATCH', '正の元記録を指定してください');
        const row = await this.invoiceRow(tx, original.invoice_id, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        this.state(row, 'posted');
        const [reverse] = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM purchase_finance_facts WHERE reversal_of=${id}::uuid`,
        );
        requireRule(!reverse, 'ALREADY_REVERSED', '元記録は逆記録済みです');
        this.factDate(data.effectiveAt, instant(original.occurred_at));
        if (data.evidenceId) await this.evidenceRow(tx, row, data.evidenceId);
        const factId = randomUUID();
        const ledgerId = await this.insertLedger(
          tx,
          actor,
          row,
          kind === 'payment' ? 'payment-reversal' : 'refund-reversal',
          original.amount,
          factId,
          data.effectiveAt,
          original.ledger_id,
          data.reason,
        );
        const body = { ...object(original.body), evidenceId: data.evidenceId, note: data.reason };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,reversal_of,occurred_at,actor_id,reason) VALUES(${factId}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.id}::uuid,${row.supplier_id}::uuid,${kind},${original.amount}::numeric,${json(body)}::jsonb,${ledgerId}::uuid,${id}::uuid,${data.effectiveAt}::timestamptz,${actor.staffId}::uuid,${data.reason})`,
        );
        await this.bump(tx, actor, row);
        return {
          operationId: data.operationId,
          record: await this.factDto(tx, factId),
          invoice: F.InvoiceSummaryDtoSchema.strip().parse(
            await this.invoiceDto(tx, actor, await this.invoiceRow(tx, row.id, row.store_id)),
          ),
        };
      },
    );
  }
  async factDto(tx: Tx, id: string, observedAt?: string) {
    const [fact] = await rows<FactRow>(tx, sql`${factSelect} WHERE id=${id}::uuid`);
    requireRule(fact, 'NOT_FOUND', '決済記録がありません', 404);
    const [ledger] = await rows<LedgerRow>(
      tx,
      sql`${ledgerSelect} WHERE id=${fact.ledger_id}::uuid`,
    );
    requireRule(ledger, 'NOT_FOUND', '台帳記録がありません', 404);
    const [reversal] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM purchase_finance_facts WHERE reversal_of=${id}::uuid AND (${observedAt ?? null}::timestamptz IS NULL OR recorded_at<=${observedAt ?? null}::timestamptz)`,
    );
    return F.PaymentDtoSchema.parse({
      ...object(fact.body),
      id: fact.id,
      storeId: fact.store_id,
      invoiceId: fact.invoice_id,
      supplierId: fact.supplier_id,
      amount: fact.amount,
      occurredAt: instant(fact.occurred_at),
      recordedAt: instant(fact.recorded_at),
      actorId: fact.actor_id,
      reversalOf: fact.reversal_of,
      reversedBy: reversal?.id ?? null,
      reason: fact.reason,
      ledger: ledgerDto(ledger),
    });
  }
  async facts(actor: Actor, input: unknown, kind: 'payment' | 'refund') {
    const q = financeParse(F.FactListQuerySchema, input);
    return this.read(actor, q.storeId, async (tx) => {
      const observedAt = this.cursorView(actor, kind, q).observedAt;
      const facts = await rows<FactRow>(
        tx,
        sql`${factSelect} WHERE store_id=${q.storeId}::uuid AND kind=${kind} AND recorded_at<=${observedAt}::timestamptz AND (${q.supplierId ?? null}::uuid IS NULL OR supplier_id=${q.supplierId ?? null}::uuid) AND (${q.invoiceId ?? null}::uuid IS NULL OR invoice_id=${q.invoiceId ?? null}::uuid) ORDER BY recorded_at,id`,
      );
      const items: F.PaymentDto[] = [];
      for (const fact of facts) {
        const day = this.japanDay(instant(fact.occurred_at));
        if ((q.from && day < q.from) || (q.to && day > q.to)) continue;
        items.push(await this.factDto(tx, fact.id, observedAt));
      }
      return this.page(actor, kind, q, items, observedAt);
    });
  }
  async payables(actor: Actor, input: unknown) {
    const q = financeParse(F.PayablesQuerySchema, input);
    if (q.storeId === 'all') this.authorize(actor, undefined, true);
    return this.read(actor, q.storeId === 'all' ? undefined : q.storeId, async (tx) => {
      const view = this.cursorView(actor, 'payables', q);
      const observed = view.observedAt;
      const asOf = view.effectiveAsOf ?? observed;
      requireRule(
        Date.parse(asOf) <= Date.now(),
        'INVALID_INPUT',
        '未来の残高は表示できません',
        400,
      );
      const invoices = await rows<InvoiceRow>(
        tx,
        sql`SELECT * FROM purchase_invoices WHERE (${q.storeId}='all' OR store_id=${q.storeId === 'all' ? null : q.storeId}::uuid) AND state IN ('posted','voided') AND (${q.supplierId ?? null}::uuid IS NULL OR supplier_id=${q.supplierId ?? null}::uuid) ORDER BY created_at,id`,
      );
      const items: F.PayableRowDto[] = [];
      for (const row of invoices) {
        const dto = await this.invoiceDto(tx, actor, row);
        const entries = (
          await rows<LedgerRow>(
            tx,
            sql`${ledgerSelect} WHERE invoice_id=${row.id}::uuid AND occurred_at<=${asOf}::timestamptz AND recorded_at<=${observed}::timestamptz ORDER BY recorded_at,id`,
          )
        ).map(ledgerDto);
        const historical = financeBalance(entries);
        if (!historical.originalGross) continue;
        requireRule(
          dto.sourceIdentity && dto.invoiceDate && dto.dueDate,
          'INVOICE_INCOMPLETE',
          '確定済み請求情報が不足しています',
        );
        const state = entries.some((e) => e.kind === 'invoice-void') ? 'voided' : 'posted';
        const overdue = dto.dueDate < this.japanDay(asOf) && BigInt(historical.payableAmount) > 0n;
        if (
          (q.status && q.status !== 'all' && historical.status !== q.status) ||
          (q.overdue && q.overdue !== 'all' && overdue !== (q.overdue === 'true')) ||
          (q.dueFrom && dto.dueDate < q.dueFrom) ||
          (q.dueTo && dto.dueDate > q.dueTo)
        )
          continue;
        items.push(
          F.PayableRowDtoSchema.parse({
            ...historical,
            invoiceId: row.id,
            storeId: row.store_id,
            supplierId: row.supplier_id,
            supplierName: dto.supplierName,
            internalReference: dto.internalReference,
            sourceIdentity: dto.sourceIdentity,
            invoiceDate: dto.invoiceDate,
            dueDate: dto.dueDate,
            currentState: row.state,
            stateAtAsOf: state,
            overdue,
          }),
        );
      }
      const page = this.page(actor, 'payables', q, items, observed, asOf);
      return F.PayablesPageDtoSchema.parse({
        ...page,
        asOf,
        totals: {
          payableAmount: items.reduce((s, i) => s + BigInt(i.payableAmount), 0n).toString(),
          refundDueAmount: items.reduce((s, i) => s + BigInt(i.refundDueAmount), 0n).toString(),
          invoiceCount: items.length,
        },
      });
    });
  }
  private sign(value: unknown) {
    const bytes = Buffer.from(json(value)).toString('base64url');
    return (
      bytes +
      '.' +
      createHmac('sha256', recoveryKey())
        .update('finance-view:' + bytes)
        .digest('base64url')
    );
  }
  cursorView(actor: Actor, kind: string, query: Record<string, unknown>): FinanceView {
    const scope = financeSha({
      tenantId: actor.tenantId,
      staffId: actor.staffId,
      role: actor.role,
      stores: actor.stores,
      kind,
      query:
        kind === 'payables'
          ? {
              storeId: query.storeId,
              supplierId: query.supplierId ?? null,
              status: query.status ?? 'all',
              overdue: query.overdue ?? 'all',
              dueFrom: query.dueFrom ?? null,
              dueTo: query.dueTo ?? null,
            }
          : Object.fromEntries(
              Object.entries(query).filter(
                ([key]) =>
                  !['cursor', 'pageSize', ...(kind === 'payables' ? ['asOf'] : [])].includes(key),
              ),
            ),
    });
    if (!query.cursor) {
      const observedAt = new Date().toISOString();
      return {
        scope,
        observedAt,
        offset: 0,
        effectiveAsOf:
          kind === 'payables' ? (typeof query.asOf === 'string' ? query.asOf : observedAt) : null,
        resultSha256: null,
      };
    }
    requireRule(
      typeof query.cursor === 'string',
      'INVALID_CURSOR',
      '一覧を再取得してください',
      400,
    );
    const [payload, signature] = query.cursor.split('.');
    requireRule(payload && signature, 'INVALID_CURSOR', '一覧を再取得してください', 400);
    const expected = createHmac('sha256', recoveryKey())
      .update('finance-view:' + payload)
      .digest();
    const received = Buffer.from(signature, 'base64url');
    requireRule(
      expected.length === received.length && timingSafeEqual(expected, received),
      'INVALID_CURSOR',
      '一覧を再取得してください',
      400,
    );
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      throw new BusinessError('INVALID_CURSOR', '一覧を再取得してください', 400);
    }
    const parsed = z
      .object({
        scope: z.string(),
        observedAt: F.FinanceInstantSchema,
        offset: z.number().int().nonnegative(),
        effectiveAsOf: F.FinanceInstantSchema.nullable(),
        resultSha256: F.Sha256Schema.nullable(),
      })
      .safeParse(value);
    requireRule(
      parsed.success && parsed.data.scope === scope,
      'INVALID_CURSOR',
      '対象・条件が変わっています。一覧を再取得してください',
      400,
    );
    requireRule(
      kind !== 'payables' || query.asOf === undefined || query.asOf === parsed.data.effectiveAsOf,
      'INVALID_CURSOR',
      '残高の基準日時が変わっています。一覧を再取得してください',
      400,
    );
    return parsed.data;
  }
  private page<T>(
    actor: Actor,
    kind: string,
    query: Record<string, unknown>,
    items: T[],
    observedAt?: string,
    effectiveAsOf?: string,
  ): F.Page<T> {
    const view = this.cursorView(actor, kind, query);
    if (observedAt) view.observedAt = observedAt;
    if (effectiveAsOf) view.effectiveAsOf = effectiveAsOf;
    const resultSha = financeSha(
      kind === 'payables'
        ? items.map((item) =>
            Object.fromEntries(
              Object.entries(object(item)).filter(([key]) => key !== 'currentState'),
            ),
          )
        : items,
    );
    requireRule(
      view.resultSha256 === null || view.resultSha256 === resultSha,
      'INVALID_CURSOR',
      '一覧の内容が更新されています。先頭から再取得してください',
      400,
    );
    view.resultSha256 = resultSha;
    const size = typeof query.pageSize === 'number' ? query.pageSize : 50;
    return {
      items: items.slice(view.offset, view.offset + size),
      nextCursor:
        items.length > view.offset + size
          ? this.sign({ ...view, offset: view.offset + size })
          : null,
      observedAt: view.observedAt,
      viewToken: this.sign({ ...view, offset: 0 }),
    };
  }
  private async validateAllocations(
    tx: Tx,
    row: Pick<InvoiceRow, 'id' | 'store_id' | 'supplier_id'>,
    draft: F.InvoiceDraftFields,
    ownExisting = true,
  ) {
    requireRule(
      draft.lines.every(
        (l) =>
          new Set(l.receiptAllocations.map((a) => a.receiptId + ':' + a.receiptLineIndex)).size ===
          l.receiptAllocations.length,
      ),
      'RECEIPT_OVERALLOCATED',
      '同じ入荷行の照合をまとめてください',
    );
    const requested = new Map<string, number>();
    const candidates = await this.receiptRows(
      tx,
      row.store_id,
      row.supplier_id,
      ownExisting ? row.id : undefined,
    );
    for (const line of draft.lines)
      for (const allocation of line.receiptAllocations) {
        const key = allocation.receiptId + ':' + allocation.receiptLineIndex;
        const candidate = candidates.find((c) => c.receiptId + ':' + c.receiptLineIndex === key);
        requireRule(
          candidate && candidate.productId === line.productId,
          'RECEIPT_OVERALLOCATED',
          '同じ店舗・仕入先・商品の入荷行を指定してください',
        );
        const total = (requested.get(key) ?? 0) + allocation.quantity;
        requireRule(
          total <= candidate.invoiceAllocatableQuantity,
          'RECEIPT_OVERALLOCATED',
          '他の請求で照合済み・取消済みの数量は照合できません',
        );
        requested.set(key, total);
      }
  }
  private async receiptRows(
    tx: Tx,
    storeId: string,
    supplierId?: string,
    ownInvoiceId?: string,
  ): Promise<F.ReceiptCandidateDto[]> {
    const receipts = await rows<{
      id: string;
      body: unknown;
      created_at: Date;
      order_body: unknown;
      supplier_id: string | null;
    }>(
      tx,
      sql`SELECT r.id,r.body,r.created_at,o.body AS order_body,(SELECT l.supplier_id FROM purchase_supplier_links l WHERE l.order_id=o.id ORDER BY l.recorded_at DESC,l.id DESC LIMIT 1) AS supplier_id FROM documents r JOIN documents o ON o.id=(r.body->>'orderId')::uuid AND o.kind='purchase-order' WHERE r.kind='receipt' AND r.status='confirmed' AND r.store_id=${storeId}::uuid ORDER BY r.created_at,r.id`,
    );
    const cancellations = await rows<{ receipt_id: string }>(
      tx,
      sql`SELECT body->>'receiptId' AS receipt_id FROM documents WHERE kind='receipt-cancel' AND status='confirmed' AND store_id=${storeId}::uuid`,
    );
    const allocations = await rows<{
      receipt_id: string;
      receipt_line_index: number;
      quantity: number;
    }>(
      tx,
      sql`SELECT receipt_id,receipt_line_index,sum(quantity)::int AS quantity FROM (SELECT a.receipt_id,a.receipt_line_index,a.quantity FROM purchase_invoice_allocations a JOIN purchase_invoices i ON i.id=a.invoice_id WHERE i.store_id=${storeId}::uuid AND i.state='posted' AND i.id IS DISTINCT FROM ${ownInvoiceId ?? null}::uuid UNION ALL SELECT (a->>'receiptId')::uuid,(a->>'receiptLineIndex')::int,(a->>'quantity')::int FROM purchase_invoices i CROSS JOIN LATERAL jsonb_array_elements(i.draft->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'receiptAllocations') a WHERE i.store_id=${storeId}::uuid AND i.state='draft' AND i.id IS DISTINCT FROM ${ownInvoiceId ?? null}::uuid) active GROUP BY receipt_id,receipt_line_index`,
    );
    const returns = await rows<{
      receipt_id: string;
      receipt_line_index: number;
      quantity: number;
    }>(
      tx,
      sql`SELECT l.receipt_id,l.receipt_line_index,sum(l.quantity)::int AS quantity FROM purchase_return_lines l JOIN purchase_returns r ON r.id=l.return_id WHERE r.store_id=${storeId}::uuid AND r.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM purchase_returns inverse WHERE inverse.reversal_of=r.id) GROUP BY l.receipt_id,l.receipt_line_index`,
    );
    let own: F.InvoiceDraftFields | null = null;
    if (ownInvoiceId) {
      const [row] = await rows<{ draft: unknown; state: string }>(
        tx,
        sql`SELECT draft,state FROM purchase_invoices WHERE id=${ownInvoiceId}::uuid AND store_id=${storeId}::uuid`,
      );
      requireRule(row, 'NOT_FOUND', '仕入請求がありません', 404);
      if (row.state === 'draft') own = F.InvoiceDraftFieldsSchema.parse(row.draft);
    }
    const result: F.ReceiptCandidateDto[] = [];
    const receiptSchema = z.object({
      orderId: F.FinanceIdSchema,
      lines: z.array(
        z.object({
          index: z.number().int(),
          productId: F.FinanceIdSchema,
          quantity: z.number().int(),
        }),
      ),
    });
    const orderSchema = z.object({
      lines: z.array(z.object({ name: z.string(), productId: F.FinanceIdSchema })),
    });
    for (const r of receipts) {
      if (supplierId && r.supplier_id !== supplierId) continue;
      const receipt = receiptSchema.parse(r.body),
        order = orderSchema.parse(r.order_body);
      for (const line of receipt.lines) {
        const cancelled = cancellations.some((c) => c.receipt_id === r.id) ? line.quantity : 0;
        const allocated =
          allocations.find((a) => a.receipt_id === r.id && a.receipt_line_index === line.index)
            ?.quantity ?? 0;
        const returned =
          returns.find((a) => a.receipt_id === r.id && a.receipt_line_index === line.index)
            ?.quantity ?? 0;
        const ownQty =
          own?.lines
            .flatMap((l) => l.receiptAllocations)
            .filter((a) => a.receiptId === r.id && a.receiptLineIndex === line.index)
            .reduce((s, a) => s + a.quantity, 0) ?? 0;
        result.push(
          F.ReceiptCandidateDtoSchema.parse({
            receiptId: r.id,
            orderId: receipt.orderId,
            storeId,
            supplierId: r.supplier_id,
            receiptLineIndex: line.index,
            productId: line.productId,
            name: order.lines[line.index]?.name ?? '',
            receivedAt: instant(r.created_at),
            originalQuantity: line.quantity,
            cancelledQuantity: cancelled,
            activeInvoiceAllocatedQuantity: allocated,
            activeReturnedQuantity: returned,
            ownDraftAllocatedQuantity: ownQty,
            invoiceAllocatableQuantity: Math.max(0, line.quantity - cancelled - allocated),
            returnableQuantity: Math.max(0, line.quantity - cancelled - returned),
            taxStatus: 'not-inferred-from-purchase-order',
          }),
        );
      }
    }
    return result;
  }
  async receiptCandidates(actor: Actor, input: unknown) {
    const q = financeParse(F.ReceiptCandidateQuerySchema, input);
    return this.read(actor, q.storeId, async (tx) => {
      await this.supplier(tx, q.supplierId);
      const items = (await this.receiptRows(tx, q.storeId, q.supplierId, q.invoiceId)).filter(
        (r) => !q.orderId || r.orderId === q.orderId,
      );
      return this.page(actor, 'receipt-candidates', q, items);
    });
  }
  async cancelOrVoid(actor: Actor, id: string, input: unknown, action: 'cancel' | 'void') {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.InvoiceReasonRequestSchema, input);
    this.authorize(actor, data.storeId, action === 'void');
    return this.operate(
      actor,
      { ...data, targetId: id },
      'finance.invoice.' + action,
      data.storeId,
      F.InvoiceActionDtoSchema,
      async (tx) => {
        const row = await this.invoiceRow(tx, id, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        this.state(row, action === 'cancel' ? 'draft' : 'posted');
        if (action === 'void') {
          requireRule(data.effectiveAt, 'INVALID_INPUT', '取消の実際の日時が必要です', 400);
          this.factDate(data.effectiveAt, await this.debitDate(tx, row));
          const [facts] = await rows<{ id: string }>(
            tx,
            sql`SELECT id FROM purchase_finance_facts f WHERE invoice_id=${id}::uuid AND reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM purchase_finance_facts r WHERE r.reversal_of=f.id) UNION ALL SELECT id FROM purchase_returns r WHERE invoice_id=${id}::uuid AND reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM purchase_returns inverse WHERE inverse.reversal_of=r.id) LIMIT 1`,
          );
          requireRule(
            !facts,
            'INVOICE_VOID_BLOCKED',
            '決済・減額・物品返品の元記録を先に逆記録してください',
          );
          const [debit] = await rows<LedgerRow>(
            tx,
            sql`${ledgerSelect} WHERE invoice_id=${id}::uuid AND kind='invoice-debit'`,
          );
          requireRule(debit, 'INVOICE_STATE', '元の債務がありません');
          await this.insertLedger(
            tx,
            actor,
            row,
            'invoice-void',
            debit.amount,
            randomUUID(),
            data.effectiveAt,
            debit.id,
            data.reason,
          );
        }
        const state = action === 'cancel' ? 'cancelled' : 'voided';
        await tx.$executeRaw(
          sql`UPDATE purchase_invoices SET state=${state},version=version+1,updated_at=clock_timestamp() WHERE id=${id}::uuid`,
        );
        await this.marker(tx, actor, id, state, row.version + 1, row.store_id);
        return {
          operationId: data.operationId,
          invoice: await this.invoiceDto(tx, actor, await this.invoiceRow(tx, id, data.storeId)),
        };
      },
    );
  }
  async confirmSupplier(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.SupplierConfirmationRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    const intent = { ...data, targetId: id };
    const prior = await this.replay(
      actor,
      intent,
      'finance.invoice.confirm-supplier',
      F.SupplierConfirmationActionDtoSchema,
    );
    if (prior) return prior;
    const evidence = await this.read(actor, data.storeId, async (tx) => {
      const row = await this.invoiceRow(tx, id, data.storeId);
      this.expected(row, data.expectedInvoiceVersion);
      return this.evidenceRow(tx, row, data.evidenceId, ['supplier-confirmation']);
    });
    await this.files.get(evidence.object_key, evidence.bytes, evidence.sha256);
    return this.operate(
      actor,
      intent,
      'finance.invoice.confirm-supplier',
      data.storeId,
      F.SupplierConfirmationActionDtoSchema,
      async (tx) => {
        const row = await this.invoiceRow(tx, id, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        this.state(row, 'posted');
        requireRule(
          F.InvoiceDraftFieldsSchema.parse(row.draft).sourceKind === 'buyer-statement',
          'CONFIRMATION_REQUIRED',
          '買い手作成明細の確認だけを記録してください',
        );
        requireRule(
          row.posted_snapshot_sha256 === data.postedSnapshotSha256,
          'CONFIRMATION_SNAPSHOT_MISMATCH',
          '確定済み明細の同じSHAを指定してください',
        );
        this.factDate(data.confirmedAt, await this.debitDate(tx, row));
        await this.evidenceRow(tx, row, data.evidenceId, ['supplier-confirmation']);
        const confirmationId = randomUUID(),
          body = {
            counterpartyName: data.counterpartyName,
            confirmedAt: data.confirmedAt,
            method: data.method,
            note: data.note,
          };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_supplier_confirmations(id,tenant_id,store_id,invoice_id,snapshot_sha256,evidence_id,body,actor_id) VALUES(${confirmationId}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${id}::uuid,${data.postedSnapshotSha256},${data.evidenceId}::uuid,${json(body)}::jsonb,${actor.staffId}::uuid)`,
        );
        await this.bump(tx, actor, row);
        const invoice = await this.invoiceDto(
          tx,
          actor,
          await this.invoiceRow(tx, id, data.storeId),
        );
        const confirmation = invoice.confirmations.find((c) => c.id === confirmationId);
        requireRule(confirmation, 'NOT_FOUND', '確認記録がありません', 404);
        return { operationId: data.operationId, invoice, confirmation };
      },
    );
  }
  private async creditQuote(
    tx: Tx,
    actor: Actor,
    row: InvoiceRow,
    credit: F.CreditLines,
  ): Promise<F.CreditPreviewDto> {
    this.state(row, 'posted');
    const invoice = await this.invoiceDto(tx, actor, row);
    const issues: F.CompletionIssue[] = [];
    const issue = (message: string) =>
      issues.push({ code: 'OVER_CREDIT', field: 'credit.lines', message });
    const lines: F.CreditPreviewDto['lines'] = [];
    if (new Set(credit.lines.map((l) => l.invoiceLineNo)).size !== credit.lines.length)
      issue('同じ原請求行の減額をまとめてください');
    const portion = (amount: string, qty: number, offset: number, count: number) => {
      const total = BigInt(amount),
        units = BigInt(qty),
        remainder = Number(total % units);
      return (
        (total / units) * BigInt(count) +
        BigInt(Math.max(0, Math.min(count, remainder - offset)))
      ).toString();
    };
    for (const requested of credit.lines) {
      const original = invoice.preview.lines.find((l) => l.lineNo === requested.invoiceLineNo);
      const available = invoice.creditAvailability.find(
        (l) => l.invoiceLineNo === requested.invoiceLineNo,
      );
      if (!original || !available) {
        issue('原請求の明細を指定してください');
        continue;
      }
      let net: string, tax: string, gross: string, quantity: number | null;
      if ('quantity' in requested) {
        quantity = requested.quantity;
        if (quantity > available.remainingQuantity)
          issue('減額数量が原請求の未減額数量を超えています');
        const offset = original.quantity - available.remainingQuantity;
        net = portion(original.net, original.quantity, offset, quantity);
        tax = portion(original.taxAllocation, original.quantity, offset, quantity);
        gross = (BigInt(net) + BigInt(tax)).toString();
      } else {
        quantity = null;
        net = requested.net;
        tax = requested.tax;
        gross = requested.gross;
        if (BigInt(net) + BigInt(tax) !== BigInt(gross))
          issue('税抜額と税額の合計を税込額と一致させてください');
      }
      if (
        BigInt(net) > BigInt(available.remainingNet) ||
        BigInt(tax) > BigInt(available.remainingTax) ||
        BigInt(gross) > BigInt(available.remainingGross)
      )
        issue('減額は原金額・原税額の未減額分以内にしてください');
      lines.push({ invoiceLineNo: requested.invoiceLineNo, quantity, net, tax, gross });
    }
    const groups = new Map<string, F.TaxAmounts>();
    for (const line of lines) {
      const original = invoice.preview.lines.find((l) => l.lineNo === line.invoiceLineNo);
      if (!original) continue;
      const key = taxGroupKey(original),
        g = groups.get(key) ?? { groupKey: key, net: '0', tax: '0', gross: '0' };
      groups.set(key, {
        groupKey: key,
        net: (BigInt(g.net) + BigInt(line.net)).toString(),
        tax: (BigInt(g.tax) + BigInt(line.tax)).toString(),
        gross: (BigInt(g.gross) + BigInt(line.gross)).toString(),
      });
    }
    const gross = lines.reduce((sum, l) => sum + BigInt(l.gross), 0n);
    if (gross === 0n) issue('減額金額は正の金額が必要です');
    const result = {
      lines,
      groups: [...groups.values()],
      gross: gross.toString(),
      resultingSignedBalance: (BigInt(invoice.balance.signedBalance) - gross).toString(),
      issues,
    };
    return F.CreditPreviewDtoSchema.parse({
      previewSha256: financeSha({ invoiceId: row.id, version: row.version, credit, result }),
      ...result,
    });
  }
  async creditPreview(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.CreditPreviewRequestSchema, input);
    return this.read(actor, data.storeId, async (tx) => {
      const row = await this.invoiceRow(tx, id, data.storeId);
      this.expected(row, data.expectedInvoiceVersion);
      return this.creditQuote(tx, actor, row, data.credit);
    });
  }
  async credit(actor: Actor, input: unknown) {
    const data = financeParse(F.CreditRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    const prior = await this.replay(actor, data, 'finance.credit.record', F.CreditActionDtoSchema);
    if (prior) return prior;
    const evidence = await this.read(actor, data.storeId, async (tx) =>
      this.evidenceRow(
        tx,
        await this.invoiceRow(tx, data.invoiceId, data.storeId),
        data.evidenceId,
        ['supplier-credit'],
      ),
    );
    await this.files.get(evidence.object_key, evidence.bytes, evidence.sha256);
    return this.operate(
      actor,
      data,
      'finance.credit.record',
      data.storeId,
      F.CreditActionDtoSchema,
      async (tx) => {
        const row = await this.invoiceRow(tx, data.invoiceId, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        const quote = await this.creditQuote(tx, actor, row, data.credit);
        requireRule(
          quote.issues.length === 0,
          'OVER_CREDIT',
          '減額の数量・原税額・残額を確認してください',
        );
        requireRule(
          quote.previewSha256 === data.expectedPreviewSha256,
          'VERSION_CONFLICT',
          '減額の計算結果が変わっています',
        );
        this.factDate(data.approvedAt, await this.debitDate(tx, row));
        await this.evidenceRow(tx, row, data.evidenceId, ['supplier-credit']);
        if (data.purchaseReturnId) {
          const [r] = await rows<{
            supplier_id: string | null;
            invoice_id: string | null;
            body: unknown;
            reversal_of: string | null;
          }>(
            tx,
            sql`SELECT supplier_id,invoice_id,body,reversal_of FROM purchase_returns WHERE id=${data.purchaseReturnId}::uuid AND store_id=${row.store_id}::uuid AND NOT EXISTS(SELECT 1 FROM purchase_returns inverse WHERE inverse.reversal_of=purchase_returns.id)`,
          );
          requireRule(
            r &&
              !r.reversal_of &&
              r.supplier_id === row.supplier_id &&
              (!r.invoice_id || r.invoice_id === row.id),
            'FACT_MISMATCH',
            '同じ店舗・仕入先の未逆記録返品を指定してください',
          );
          const returned = z
            .array(
              F.ReturnLineInputSchema.extend({ productId: F.FinanceIdSchema, name: z.string() }),
            )
            .parse(object(r.body).lines);
          const draft = F.InvoiceDraftFieldsSchema.parse(row.draft);
          requireRule(
            returned.every((l) =>
              quote.lines.some(
                (q) =>
                  draft.lines.find((d) => d.lineNo === q.invoiceLineNo)?.productId ===
                    l.productId &&
                  q.quantity !== null &&
                  q.quantity >= l.quantity,
              ),
            ),
            'FACT_MISMATCH',
            '物品返品と原請求の明細・減額数量を確認してください',
          );
        }
        const id = randomUUID(),
          ledgerId = await this.insertLedger(
            tx,
            actor,
            row,
            'supplier-credit',
            quote.gross,
            id,
            data.approvedAt,
            null,
            data.reason,
          ),
          body = {
            evidenceId: data.evidenceId,
            purchaseReturnId: data.purchaseReturnId,
            lines: quote.lines,
            groups: quote.groups,
          };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,occurred_at,actor_id,reason) VALUES(${id}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.id}::uuid,${row.supplier_id}::uuid,'credit',${quote.gross}::numeric,${json(body)}::jsonb,${ledgerId}::uuid,${data.approvedAt}::timestamptz,${actor.staffId}::uuid,${data.reason})`,
        );
        await this.bump(tx, actor, row);
        return {
          operationId: data.operationId,
          record: await this.creditDto(tx, id),
          invoice: F.InvoiceSummaryDtoSchema.strip().parse(
            await this.invoiceDto(tx, actor, await this.invoiceRow(tx, row.id, row.store_id)),
          ),
        };
      },
    );
  }
  async creditDto(tx: Tx, id: string): Promise<F.CreditDto> {
    const [fact] = await rows<FactRow>(
      tx,
      sql`${factSelect} WHERE id=${id}::uuid AND kind='credit'`,
    );
    requireRule(fact, 'NOT_FOUND', '減額記録がありません', 404);
    const [ledger] = await rows<LedgerRow>(
      tx,
      sql`${ledgerSelect} WHERE id=${fact.ledger_id}::uuid`,
    );
    requireRule(ledger, 'NOT_FOUND', '台帳記録がありません', 404);
    const [inverse] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM purchase_finance_facts WHERE reversal_of=${id}::uuid`,
    );
    return F.CreditDtoSchema.parse({
      ...object(fact.body),
      id: fact.id,
      storeId: fact.store_id,
      invoiceId: fact.invoice_id,
      supplierId: fact.supplier_id,
      amount: fact.amount,
      occurredAt: instant(fact.occurred_at),
      recordedAt: instant(fact.recorded_at),
      actorId: fact.actor_id,
      reversalOf: fact.reversal_of,
      reversedBy: inverse?.id ?? null,
      reason: fact.reason,
      ledger: ledgerDto(ledger),
    });
  }
  async credits(actor: Actor, input: unknown) {
    const q = financeParse(F.FactListQuerySchema, input);
    return this.read(actor, q.storeId, async (tx) => {
      const facts = await rows<FactRow>(
        tx,
        sql`${factSelect} WHERE kind='credit' AND store_id=${q.storeId}::uuid AND (${q.invoiceId ?? null}::uuid IS NULL OR invoice_id=${q.invoiceId ?? null}::uuid) AND (${q.supplierId ?? null}::uuid IS NULL OR supplier_id=${q.supplierId ?? null}::uuid) ORDER BY recorded_at,id`,
      );
      const items: F.CreditDto[] = [];
      for (const fact of facts) {
        const day = this.japanDay(instant(fact.occurred_at));
        if ((q.from && day < q.from) || (q.to && day > q.to)) continue;
        items.push(await this.creditDto(tx, fact.id));
      }
      return this.page(actor, 'credits', q, items);
    });
  }
  async reverseCredit(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.FactReverseRequestSchema, input);
    this.authorize(actor, data.storeId, true);
    return this.operate(
      actor,
      { ...data, targetId: id },
      'finance.credit.reverse',
      data.storeId,
      F.CreditActionDtoSchema,
      async (tx) => {
        const [original] = await rows<FactRow>(
          tx,
          sql`${factSelect} WHERE id=${id}::uuid AND kind='credit' AND store_id=${data.storeId}::uuid`,
        );
        requireRule(original, 'NOT_FOUND', '元の減額記録がありません', 404);
        requireRule(!original.reversal_of, 'FACT_MISMATCH', '正の元記録を指定してください');
        const [inverse] = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM purchase_finance_facts WHERE reversal_of=${id}::uuid`,
        );
        requireRule(!inverse, 'ALREADY_REVERSED', '元記録は逆記録済みです');
        const row = await this.invoiceRow(tx, original.invoice_id, data.storeId);
        this.expected(row, data.expectedInvoiceVersion);
        this.state(row, 'posted');
        this.factDate(data.effectiveAt, instant(original.occurred_at));
        if (data.evidenceId) await this.evidenceRow(tx, row, data.evidenceId);
        const factId = randomUUID(),
          ledgerId = await this.insertLedger(
            tx,
            actor,
            row,
            'credit-reversal',
            original.amount,
            factId,
            data.effectiveAt,
            original.ledger_id,
            data.reason,
          );
        await tx.$executeRaw(
          sql`INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,reversal_of,occurred_at,actor_id,reason) VALUES(${factId}::uuid,${actor.tenantId}::uuid,${row.store_id}::uuid,${row.id}::uuid,${row.supplier_id}::uuid,'credit',${original.amount}::numeric,${json(original.body)}::jsonb,${ledgerId}::uuid,${id}::uuid,${data.effectiveAt}::timestamptz,${actor.staffId}::uuid,${data.reason})`,
        );
        await this.bump(tx, actor, row);
        return {
          operationId: data.operationId,
          record: await this.creditDto(tx, factId),
          invoice: F.InvoiceSummaryDtoSchema.strip().parse(
            await this.invoiceDto(tx, actor, await this.invoiceRow(tx, row.id, row.store_id)),
          ),
        };
      },
    );
  }
  async returnDto(tx: Tx, id: string): Promise<F.ReturnDto> {
    const [row] = await rows<ReturnRow>(
      tx,
      sql`SELECT * FROM purchase_returns WHERE id=${id}::uuid`,
    );
    requireRule(row, 'NOT_FOUND', '物品返品がありません', 404);
    const [inverse] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM purchase_returns WHERE reversal_of=${id}::uuid`,
    );
    return F.ReturnDtoSchema.parse({
      ...object(row.body),
      id: row.id,
      storeId: row.store_id,
      invoiceId: row.invoice_id,
      supplierId: row.supplier_id,
      occurredAt: instant(row.occurred_at),
      recordedAt: instant(row.recorded_at),
      actorId: row.actor_id,
      reason: row.reason,
      reversalOf: row.reversal_of,
      reversedBy: inverse?.id ?? null,
    });
  }
  async returns(actor: Actor, input: unknown) {
    const q = financeParse(F.FactListQuerySchema, input);
    return this.read(actor, q.storeId, async (tx) => {
      const all = await rows<ReturnRow>(
        tx,
        sql`SELECT * FROM purchase_returns WHERE store_id=${q.storeId}::uuid AND (${q.invoiceId ?? null}::uuid IS NULL OR invoice_id=${q.invoiceId ?? null}::uuid) AND (${q.supplierId ?? null}::uuid IS NULL OR supplier_id=${q.supplierId ?? null}::uuid) ORDER BY recorded_at,id`,
      );
      const items: F.ReturnDto[] = [];
      for (const row of all) {
        const day = this.japanDay(instant(row.occurred_at));
        const dto = await this.returnDto(tx, row.id);
        if (
          (q.from && day < q.from) ||
          (q.to && day > q.to) ||
          (q.receiptId && !dto.lines.some((l) => l.receiptId === q.receiptId))
        )
          continue;
        items.push(dto);
      }
      return this.page(actor, 'returns', q, items);
    });
  }
  async returnGoods(actor: Actor, input: unknown) {
    const data = financeParse(F.ReturnRequestSchema, input);
    this.authorize(actor, data.storeId);
    return this.operate(
      actor,
      data,
      'finance.return.record',
      data.storeId,
      F.ReturnActionDtoSchema,
      async (tx) => {
        let invoice: InvoiceRow | null = null;
        if (data.invoiceId) {
          invoice = await this.invoiceRow(tx, data.invoiceId, data.storeId);
          requireRule(data.expectedInvoiceVersion, 'INVALID_INPUT', '関連請求の版が必要です', 400);
          this.expected(invoice, data.expectedInvoiceVersion);
          this.state(invoice, 'posted');
        } else
          requireRule(
            data.expectedInvoiceVersion === null,
            'INVALID_INPUT',
            '未関連の請求版は指定できません',
            400,
          );
        this.factDate(data.returnedAt);
        requireRule(
          new Set(data.lines.map((l) => l.receiptId + ':' + l.receiptLineIndex)).size ===
            data.lines.length,
          'OVER_RETURN',
          '同じ入荷行の返品をまとめてください',
        );
        const candidates = await this.receiptRows(tx, data.storeId, invoice?.supplier_id);
        const lines: F.ReturnDto['lines'] = [];
        let supplierId: string | null | undefined;
        for (const line of data.lines) {
          const available = candidates.find(
            (r) => r.receiptId === line.receiptId && r.receiptLineIndex === line.receiptLineIndex,
          );
          requireRule(
            available && line.quantity <= available.returnableQuantity,
            'OVER_RETURN',
            '未返送の入荷数量以内にしてください',
          );
          requireRule(
            Date.parse(data.returnedAt) >= Date.parse(available.receivedAt),
            'FACT_DATE_ORDER',
            '入荷前の物品返品は記録できません',
          );
          if (supplierId === undefined) supplierId = available.supplierId;
          requireRule(
            supplierId === available.supplierId,
            'FACT_MISMATCH',
            '同じ仕入先の物品返品をまとめてください',
          );
          lines.push({ ...line, productId: available.productId, name: available.name });
        }
        const id = randomUUID(),
          inventorySourceId = randomUUID(),
          body = { lines, inventorySourceId };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_returns(id,tenant_id,store_id,invoice_id,supplier_id,body,occurred_at,actor_id,reason) VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${data.invoiceId}::uuid,${supplierId ?? null}::uuid,${json(body)}::jsonb,${data.returnedAt}::timestamptz,${actor.staffId}::uuid,${data.reason})`,
        );
        for (const [index, line] of lines.entries()) {
          await tx.$executeRaw(
            sql`INSERT INTO purchase_return_lines(return_id,tenant_id,store_id,line_no,receipt_id,receipt_line_index,product_id,quantity) VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${index + 1},${line.receiptId}::uuid,${line.receiptLineIndex},${line.productId}::uuid,${line.quantity})`,
          );
          await this.business.stock(
            tx,
            actor,
            data.storeId,
            line.productId,
            -line.quantity,
            inventorySourceId,
            String(index + 1),
            'purchase-return',
          );
        }
        if (invoice) await this.bump(tx, actor, invoice);
        await this.marker(tx, actor, id, 'returned', 1, data.storeId);
        return {
          operationId: data.operationId,
          record: await this.returnDto(tx, id),
          invoice: invoice
            ? F.InvoiceSummaryDtoSchema.strip().parse(
                await this.invoiceDto(
                  tx,
                  actor,
                  await this.invoiceRow(tx, invoice.id, data.storeId),
                ),
              )
            : null,
        };
      },
    );
  }
  async reverseReturn(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.ReturnReverseRequestSchema, input);
    this.authorize(actor, data.storeId);
    return this.operate(
      actor,
      { ...data, targetId: id },
      'finance.return.reverse',
      data.storeId,
      F.ReturnActionDtoSchema,
      async (tx) => {
        const [original] = await rows<ReturnRow>(
          tx,
          sql`SELECT * FROM purchase_returns WHERE id=${id}::uuid AND store_id=${data.storeId}::uuid`,
        );
        requireRule(original, 'NOT_FOUND', '元の物品返品がありません', 404);
        requireRule(!original.reversal_of, 'FACT_MISMATCH', '正の元記録を指定してください');
        const [inverse] = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM purchase_returns WHERE reversal_of=${id}::uuid`,
        );
        requireRule(!inverse, 'ALREADY_REVERSED', '元記録は逆記録済みです');
        this.factDate(data.effectiveAt, instant(original.occurred_at));
        let invoice: InvoiceRow | null = null;
        if (original.invoice_id) {
          invoice = await this.invoiceRow(tx, original.invoice_id, data.storeId);
          requireRule(data.expectedInvoiceVersion, 'INVALID_INPUT', '関連請求の版が必要です', 400);
          this.expected(invoice, data.expectedInvoiceVersion);
          this.state(invoice, 'posted');
        } else
          requireRule(
            data.expectedInvoiceVersion === null,
            'INVALID_INPUT',
            '未関連の請求版は指定できません',
            400,
          );
        const linkedCredit = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM purchase_finance_facts f WHERE kind='credit' AND body->>'purchaseReturnId'=${id} AND reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM purchase_finance_facts r WHERE r.reversal_of=f.id)`,
        );
        requireRule(
          linkedCredit.length === 0,
          'FACT_MISMATCH',
          '関連する減額を先に逆記録してください',
        );
        const dto = await this.returnDto(tx, id),
          returnId = randomUUID(),
          inventorySourceId = randomUUID(),
          body = { lines: dto.lines, inventorySourceId };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_returns(id,tenant_id,store_id,invoice_id,supplier_id,body,reversal_of,occurred_at,actor_id,reason) VALUES(${returnId}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${original.invoice_id}::uuid,${original.supplier_id}::uuid,${json(body)}::jsonb,${id}::uuid,${data.effectiveAt}::timestamptz,${actor.staffId}::uuid,${data.reason})`,
        );
        for (const [index, line] of dto.lines.entries())
          await tx.$executeRaw(
            sql`INSERT INTO purchase_return_lines(return_id,tenant_id,store_id,line_no,receipt_id,receipt_line_index,product_id,quantity) VALUES(${returnId}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${index + 1},${line.receiptId}::uuid,${line.receiptLineIndex},${line.productId}::uuid,${line.quantity})`,
          );
        const movements = await rows<{ product_id: string; quantity: number; source_line: string }>(
          tx,
          sql`SELECT product_id,quantity,source_line FROM inventory WHERE source_id=${dto.inventorySourceId}::uuid AND reason='purchase-return' ORDER BY source_line`,
        );
        for (const movement of movements)
          await this.business.stock(
            tx,
            actor,
            data.storeId,
            movement.product_id,
            -movement.quantity,
            inventorySourceId,
            movement.source_line,
            'purchase-return-reversal',
            true,
          );
        if (invoice) await this.bump(tx, actor, invoice);
        await this.marker(tx, actor, id, 'reversed', 2, data.storeId);
        await this.marker(tx, actor, returnId, 'return-reversal', 1, data.storeId);
        return {
          operationId: data.operationId,
          record: await this.returnDto(tx, returnId),
          invoice: invoice
            ? F.InvoiceSummaryDtoSchema.strip().parse(
                await this.invoiceDto(
                  tx,
                  actor,
                  await this.invoiceRow(tx, invoice.id, data.storeId),
                ),
              )
            : null,
        };
      },
    );
  }
  async linkSupplier(actor: Actor, id: string, input: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const data = financeParse(F.PurchaseSupplierLinkRequestSchema, input);
    this.authorize(actor, data.storeId);
    return this.operate(
      actor,
      { ...data, targetId: id },
      'finance.purchase.supplier-link',
      data.storeId,
      F.PurchaseSupplierLinkDtoSchema,
      async (tx) => {
        const [order] = await rows<{
          id: string;
          store_id: string;
          version: number;
          body: unknown;
        }>(
          tx,
          sql`SELECT id,store_id,version,body FROM documents WHERE kind='purchase-order' AND id=${id}::uuid AND store_id=${data.storeId}::uuid FOR UPDATE`,
        );
        requireRule(order, 'NOT_FOUND', '発注がありません', 404);
        requireRule(
          order.version === data.expectedOrderVersion,
          'VERSION_CONFLICT',
          '発注が更新されています',
        );
        const supplier = await this.supplier(tx, data.supplierId, true);
        const snapshot = F.PartySnapshotSchema.parse({
          name: supplier.name,
          address: supplier.address,
          registered: supplier.registered,
          registrationNumber: supplier.registrationNumber,
        });
        const [prior] = await rows<{ id: string; supplier_id: string }>(
          tx,
          sql`SELECT id,supplier_id FROM purchase_supplier_links WHERE order_id=${id}::uuid ORDER BY recorded_at DESC,id DESC LIMIT 1`,
        );
        if (prior && prior.supplier_id !== data.supplierId) {
          const [allocated] = await rows<{ id: string }>(
            tx,
            sql`SELECT i.id FROM purchase_invoices i WHERE i.state IN ('draft','posted') AND i.store_id=${data.storeId}::uuid AND (EXISTS(SELECT 1 FROM purchase_invoice_allocations a JOIN documents r ON r.id=a.receipt_id WHERE a.invoice_id=i.id AND r.body->>'orderId'=${id}) OR EXISTS(SELECT 1 FROM jsonb_array_elements(i.draft->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'receiptAllocations') a JOIN documents r ON r.id=(a->>'receiptId')::uuid WHERE r.body->>'orderId'=${id})) LIMIT 1`,
          );
          requireRule(
            !allocated,
            'FINANCE_RECEIPT_ALLOCATED',
            '請求照合中の発注の仕入先は変更できません',
          );
        }
        const linkId = randomUUID(),
          body = {
            supplierSnapshot: snapshot,
            originalSupplierText: z.string().parse(object(order.body).supplier),
            reason: data.reason,
          };
        await tx.$executeRaw(
          sql`INSERT INTO purchase_supplier_links(id,tenant_id,store_id,order_id,supplier_id,body,prior_link_id,actor_id) VALUES(${linkId}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${id}::uuid,${data.supplierId}::uuid,${json(body)}::jsonb,${prior?.id ?? null}::uuid,${actor.staffId}::uuid)`,
        );
        await tx.$executeRaw(sql`UPDATE documents SET version=version+1 WHERE id=${id}::uuid`);
        const [saved] = await rows<{ recorded_at: Date }>(
          tx,
          sql`SELECT recorded_at FROM purchase_supplier_links WHERE id=${linkId}::uuid`,
        );
        requireRule(saved, 'NOT_FOUND', '関連付けがありません', 404);
        await this.marker(tx, actor, id, 'supplier-linked', order.version + 1, data.storeId);
        return {
          id: linkId,
          orderId: id,
          storeId: data.storeId,
          supplierId: data.supplierId,
          ...body,
          priorLinkId: prior?.id ?? null,
          recordedAt: instant(saved.recorded_at),
        };
      },
    );
  }
}
