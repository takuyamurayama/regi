import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import * as F from '../../../packages/core/src/finance';
import { Actor, rows, sql } from './db';
import { Business, json } from './service';
import { Finance, financeParse, financeBalance } from './finance';
import { FinanceFiles, fileSha } from './finance-files';
import { financeSha } from './finance-tax';
import { BusinessError, requireRule } from './errors';
import { archive } from './archive';
import { csv } from './artifacts';
import { renderFinanceInvoicePdf } from './pdf';

const bundleLimit = 64 * 1024 * 1024;
const privateEvidence = z.strictObject({ dto: F.EvidenceDtoSchema, objectKey: z.string() });
const sourceSchema = z.strictObject({
  request: F.FinanceExportRequestSchema,
  observedAt: F.FinanceInstantSchema,
  invoice: F.InvoiceDtoSchema.nullable(),
  payables: F.PayablesPageDtoSchema.nullable(),
  payments: z.array(F.PaymentDtoSchema),
  credits: z.array(F.CreditDtoSchema),
  refunds: z.array(F.SupplierRefundDtoSchema),
  returns: z.array(F.ReturnDtoSchema),
  evidence: z.array(privateEvidence),
});
type ExportSource = z.infer<typeof sourceSchema>;
interface ExportRow {
  id: string;
  store_id: string;
  format: F.FinanceExportDto['format'];
  status: F.FinanceExportDto['status'];
  source: unknown;
  source_sha256: string;
  as_of: Date;
  observed_at: Date;
  body: unknown;
  created_at: Date;
}
const bodySchema = z.object({
  owner: z.string().optional(),
  startedAt: F.FinanceInstantSchema.optional(),
  key: z.string().optional(),
  fileSha256: F.Sha256Schema.nullable().optional(),
  bytes: z.number().nullable().optional(),
  mediaType: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
  error: F.ApiErrorDtoSchema.nullable().optional(),
  completedAt: F.FinanceInstantSchema.nullable().optional(),
});

@Injectable()
export class FinanceExports {
  constructor(
    private readonly finance: Finance,
    private readonly business: Business,
    private readonly files: FinanceFiles,
  ) {}
  private dto(row: ExportRow): F.FinanceExportDto {
    const body = bodySchema.parse(row.body);
    return F.FinanceExportDtoSchema.parse({
      id: row.id,
      storeId: row.store_id,
      format: row.format,
      status: row.status,
      sourceSnapshotSha256: row.source_sha256,
      asOf: row.as_of.toISOString(),
      observedAt: row.observed_at.toISOString(),
      fileSha256: body.fileSha256 ?? null,
      bytes: body.bytes ?? null,
      mediaType: body.mediaType ?? null,
      filename: body.filename ?? null,
      downloadPath: row.status === 'completed' ? '/v1/exports/' + row.id + '/download' : null,
      error: body.error ?? null,
      createdAt: row.created_at.toISOString(),
      completedAt: body.completedAt ?? null,
    });
  }
  private async capture(actor: Actor, data: F.FinanceExportRequest): Promise<ExportSource> {
    if (data.format === 'payables-csv') {
      const query = {
        storeId: data.storeId,
        asOf: data.asOf,
        status: data.status,
        overdue: data.overdue === null ? 'all' : data.overdue ? 'true' : 'false',
        ...(data.supplierId ? { supplierId: data.supplierId } : {}),
        ...(data.dueFrom ? { dueFrom: data.dueFrom } : {}),
        ...(data.dueTo ? { dueTo: data.dueTo } : {}),
      };
      let page = await this.finance.payables(actor, {
        ...query,
        pageSize: 200,
        ...(data.viewToken ? { cursor: data.viewToken } : {}),
      });
      const first = page,
        items = [...page.items];
      while (page.nextCursor) {
        page = await this.finance.payables(actor, {
          ...query,
          pageSize: 200,
          cursor: page.nextCursor,
        });
        items.push(...page.items);
      }
      return {
        request: data,
        observedAt: first.observedAt,
        invoice: null,
        payables: { ...first, items, nextCursor: null },
        payments: [],
        credits: [],
        refunds: [],
        returns: [],
        evidence: [],
      };
    }
    if (data.format === 'purchase-payments-csv') {
      const query = {
        storeId: data.storeId,
        ...(data.supplierId ? { supplierId: data.supplierId } : {}),
        ...(data.invoiceId ? { invoiceId: data.invoiceId } : {}),
        ...(data.from ? { from: data.from } : {}),
        ...(data.to ? { to: data.to } : {}),
      };
      let page = await this.finance.facts(
        actor,
        { ...query, pageSize: 200, ...(data.viewToken ? { cursor: data.viewToken } : {}) },
        'payment',
      );
      const first = page,
        items = [...page.items];
      while (page.nextCursor) {
        page = await this.finance.facts(
          actor,
          { ...query, pageSize: 200, cursor: page.nextCursor },
          'payment',
        );
        items.push(...page.items);
      }
      const payments = items.filter((p) => p.occurredAt <= data.asOf);
      for (const p of payments) {
        if (p.reversedBy && !payments.some((r) => r.id === p.reversedBy)) p.reversedBy = null;
      }
      return {
        request: data,
        observedAt: first.observedAt,
        invoice: null,
        payables: null,
        payments,
        credits: [],
        refunds: [],
        returns: [],
        evidence: [],
      };
    }
    return this.business.database.transaction(actor, async (tx) => {
      await this.business.contract(tx, false);
      const row = await this.finance.invoiceRow(tx, data.invoiceId, data.storeId);
      requireRule(
        ['posted', 'voided'].includes(row.state),
        'INVOICE_STATE',
        '確定済みの原明細を出力してください',
      );
      const observedAt = new Date().toISOString(),
        current = await this.finance.invoiceDto(tx, actor, row);
      const ids = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM purchase_ledger WHERE invoice_id=${data.invoiceId}::uuid AND occurred_at<=${data.asOf}::timestamptz AND recorded_at<=${observedAt}::timestamptz`,
      );
      const ledger = current.ledger.filter((l) => ids.some((id) => id.id === l.id));
      requireRule(
        ledger.some((l) => l.kind === 'invoice-debit'),
        'NOT_FOUND',
        '指定日時時点の確定済み債務がありません',
        404,
      );
      const evidenceRows = await rows<{ id: string; object_key: string }>(
        tx,
        sql`SELECT id,object_key FROM purchase_evidence WHERE invoice_id=${data.invoiceId}::uuid AND recorded_at<=${observedAt}::timestamptz ORDER BY recorded_at,id`,
      );
      const evidence = current.evidence.filter((e) => evidenceRows.some((r) => r.id === e.id));
      const confirmations = current.confirmations.filter(
        (c) => c.recordedAt <= observedAt && c.confirmedAt <= data.asOf,
      );
      const payments: F.PaymentDto[] = [],
        credits: F.CreditDto[] = [],
        refunds: F.SupplierRefundDto[] = [],
        returns: F.ReturnDto[] = [];
      const facts = await rows<{ id: string; kind: 'payment' | 'credit' | 'refund' }>(
        tx,
        sql`SELECT id,kind FROM purchase_finance_facts WHERE invoice_id=${data.invoiceId}::uuid AND occurred_at<=${data.asOf}::timestamptz AND recorded_at<=${observedAt}::timestamptz ORDER BY recorded_at,id`,
      );
      for (const fact of facts) {
        if (fact.kind === 'credit') credits.push(await this.finance.creditDto(tx, fact.id));
        else if (fact.kind === 'payment') payments.push(await this.finance.factDto(tx, fact.id));
        else refunds.push(await this.finance.factDto(tx, fact.id));
      }
      for (const collection of [payments, credits, refunds])
        for (const fact of collection)
          if (fact.reversedBy && !collection.some((r) => r.id === fact.reversedBy))
            fact.reversedBy = null;
      const physical = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM purchase_returns WHERE store_id=${data.storeId}::uuid AND (invoice_id=${data.invoiceId}::uuid OR id IN (SELECT (body->>'purchaseReturnId')::uuid FROM purchase_finance_facts WHERE invoice_id=${data.invoiceId}::uuid AND kind='credit')) AND occurred_at<=${data.asOf}::timestamptz AND recorded_at<=${observedAt}::timestamptz ORDER BY recorded_at,id`,
      );
      for (const r of physical) returns.push(await this.finance.returnDto(tx, r.id));
      for (const r of returns)
        if (r.reversedBy && !returns.some((inverse) => inverse.id === r.reversedBy))
          r.reversedBy = null;
      const active = credits.filter(
        (c) => !c.reversalOf && !credits.some((r) => r.reversalOf === c.id),
      );
      const creditAvailability = current.preview.lines.map((l) => {
        const used = active.flatMap((c) => c.lines).filter((c) => c.invoiceLineNo === l.lineNo);
        return {
          invoiceLineNo: l.lineNo,
          remainingQuantity: l.quantity - used.reduce((s, c) => s + (c.quantity ?? 0), 0),
          remainingNet: (BigInt(l.net) - used.reduce((s, c) => s + BigInt(c.net), 0n)).toString(),
          remainingTax: (
            BigInt(l.taxAllocation) - used.reduce((s, c) => s + BigInt(c.tax), 0n)
          ).toString(),
          remainingGross: (
            BigInt(l.gross) - used.reduce((s, c) => s + BigInt(c.gross), 0n)
          ).toString(),
        };
      });
      const invoice = F.InvoiceDtoSchema.parse({
        ...current,
        state: ledger.some((l) => l.kind === 'invoice-void') ? 'voided' : 'posted',
        ledger,
        balance: financeBalance(ledger),
        evidence,
        confirmations,
        creditAvailability,
        supplierConfirmationStatus:
          current.sourceKind === 'supplier-invoice'
            ? 'not-applicable'
            : confirmations.length
              ? 'confirmed-recorded'
              : 'pending',
        permissions: {
          canEdit: false,
          canCancel: false,
          canPost: false,
          canVoid: false,
          canPay: false,
          canCredit: false,
          canReceiveRefund: false,
          canConfirmSupplier: false,
        },
      });
      return {
        request: data,
        observedAt,
        invoice,
        payables: null,
        payments,
        credits,
        refunds,
        returns,
        evidence: evidenceRows.map((e) => {
          const dto = evidence.find((d) => d.id === e.id);
          requireRule(dto, 'EVIDENCE_UNAVAILABLE', '証憑の記録が一致しません', 503);
          return { dto, objectKey: e.object_key };
        }),
      };
    });
  }
  async request(actor: Actor, input: unknown) {
    const data = financeParse(F.FinanceExportRequestSchema, input);
    this.finance.authorize(actor, data.storeId);
    requireRule(
      Date.parse(data.asOf) <= Date.now(),
      'INVALID_INPUT',
      '未来の残高・事実は出力できません',
      400,
    );
    const prior = await this.finance.replay(
      actor,
      data,
      'finance.export.request',
      F.FinanceExportDtoSchema,
    );
    if (prior) return prior;
    const source = sourceSchema.parse(await this.capture(actor, data));
    const size =
      Buffer.byteLength(json(source)) + source.evidence.reduce((sum, e) => sum + e.dto.bytes, 0);
    requireRule(
      size <= bundleLimit,
      'EXPORT_TOO_LARGE',
      '一式の非圧縮容量が64MiBを超えています。原資料を個別取得してください',
    );
    const result: unknown = await this.business.mutation(
      actor,
      data,
      'finance.export.request',
      data.storeId,
      async (tx) => {
        await this.business.contract(tx, false);
        const id = randomUUID(),
          sha = financeSha(source);
        await tx.$executeRaw(
          sql`INSERT INTO purchase_export_snapshots(id,tenant_id,store_id,format,status,source,source_sha256,as_of,observed_at,body,actor_id) VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${data.format},'queued',${json(source)}::jsonb,${sha},${data.asOf}::timestamptz,${source.observedAt}::timestamptz,'{}'::jsonb,${actor.staffId}::uuid)`,
        );
        const [row] = await rows<ExportRow>(
          tx,
          sql`SELECT * FROM purchase_export_snapshots WHERE id=${id}::uuid`,
        );
        requireRule(row, 'NOT_FOUND', '出力要求がありません', 404);
        await this.business.change(
          tx,
          actor,
          'purchase-finance',
          id,
          { id, status: 'queued', version: 1 },
          data.storeId,
        );
        return this.dto(row);
      },
      true,
    );
    const job = F.FinanceExportDtoSchema.parse(result);
    if (process.env.EXPORT_QUEUE_URL)
      await new SQSClient({ region: process.env.AWS_REGION }).send(
        new SendMessageCommand({
          QueueUrl: process.env.EXPORT_QUEUE_URL,
          MessageBody: json({
            id: job.id,
            tenantId: actor.tenantId,
            staffId: actor.staffId,
            kind: 'purchase-finance',
          }),
        }),
      );
    else
      setImmediate(
        () =>
          void this.process(actor, job.id).catch(() =>
            console.error('Finance export processing failed', job.id),
          ),
      );
    return job;
  }
  async exists(actor: Actor, id: string) {
    financeParse(F.FinanceIdSchema, id);
    if (!['admin', 'headquarters', 'manager'].includes(actor.role) || actor.deviceId) return false;
    return this.business.database.transaction(actor, async (tx) => {
      const [r] = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM purchase_export_snapshots WHERE id=${id}::uuid`,
      );
      return Boolean(r);
    });
  }
  async get(actor: Actor, id: string, storeId: unknown) {
    financeParse(F.FinanceIdSchema, id);
    const store = financeParse(F.FinanceIdSchema, storeId);
    this.finance.authorize(actor, store);
    return this.business.database.transaction(actor, async (tx) => {
      await this.business.contract(tx, false);
      const [r] = await rows<ExportRow>(
        tx,
        sql`SELECT * FROM purchase_export_snapshots WHERE id=${id}::uuid AND store_id=${store}::uuid`,
      );
      requireRule(r, 'NOT_FOUND', '出力がありません', 404);
      return this.dto(r);
    });
  }
  private payableCsv(source: ExportSource) {
    requireRule(source.payables, 'INVOICE_INCOMPLETE', '固定した残高がありません');
    return Buffer.from(
      '\ufeff' +
        [
          [
            '請求ID',
            '店舗ID',
            '仕入先',
            '原識別',
            '原請求日',
            '期日',
            '原金額',
            '減額',
            '支払',
            '返金受領',
            '符号付き残高',
            '支払残',
            '返金待ち',
            '基準日時',
            '観測日時',
          ]
            .map(csv)
            .join(','),
          ...source.payables.items.map((p) =>
            [
              p.invoiceId,
              p.storeId,
              p.supplierName,
              p.sourceIdentity.kind === 'numbered'
                ? p.sourceIdentity.invoiceNumber
                : p.sourceIdentity.sourceReference,
              p.invoiceDate,
              p.dueDate,
              p.originalGross,
              p.credits,
              p.payments,
              p.supplierRefunds,
              p.signedBalance,
              p.payableAmount,
              p.refundDueAmount,
              source.request.asOf,
              source.observedAt,
            ]
              .map(csv)
              .join(','),
          ),
        ].join('\r\n'),
    );
  }
  private paymentCsv(source: ExportSource) {
    return Buffer.from(
      '\ufeff' +
        [
          [
            '記録ID',
            '請求ID',
            '仕入先ID',
            '実支払日時',
            '記録日時',
            '記録金額',
            '符号付き金額',
            '方法',
            '外部参照',
            '元記録ID',
            '逆記録ID',
            '記録者',
            '理由',
          ]
            .map(csv)
            .join(','),
          ...source.payments.map((p) =>
            [
              p.id,
              p.invoiceId,
              p.supplierId,
              p.occurredAt,
              p.recordedAt,
              p.amount,
              p.ledger.signedAmount,
              p.method,
              p.reference,
              p.reversalOf,
              p.reversedBy,
              p.actorId,
              p.reason,
            ]
              .map(csv)
              .join(','),
          ),
        ].join('\r\n'),
    );
  }
  private async render(source: ExportSource) {
    if (source.request.format === 'payables-csv')
      return {
        bytes: this.payableCsv(source),
        extension: 'csv',
        mediaType: 'text/csv; charset=utf-8',
      };
    if (source.request.format === 'purchase-payments-csv')
      return {
        bytes: this.paymentCsv(source),
        extension: 'csv',
        mediaType: 'text/csv; charset=utf-8',
      };
    requireRule(source.invoice, 'INVOICE_INCOMPLETE', '固定した原明細がありません');
    const pdf = await renderFinanceInvoicePdf(source.invoice);
    if (source.request.format === 'purchase-invoice-pdf')
      return { bytes: pdf, extension: 'pdf', mediaType: 'application/pdf' };
    const files: { name: string; bytes: Buffer }[] = [
      { name: 'invoice.pdf', bytes: pdf },
      {
        name: 'snapshot.json',
        bytes: Buffer.from(json({ ...source, evidence: source.evidence.map((e) => e.dto) })),
      },
      { name: 'payments.csv', bytes: this.paymentCsv(source) },
    ];
    let uncompressed = files.reduce((s, f) => s + f.bytes.length, 0);
    for (const e of source.evidence) {
      const bytes = await this.files.get(e.objectKey, e.dto.bytes, e.dto.sha256);
      const extension =
        e.dto.mediaType === 'application/pdf'
          ? 'pdf'
          : e.dto.mediaType === 'image/png'
            ? 'png'
            : 'jpg';
      uncompressed += bytes.length;
      requireRule(
        uncompressed <= bundleLimit,
        'EXPORT_TOO_LARGE',
        '一式の非圧縮容量が64MiBを超えています。原資料を個別取得してください',
      );
      files.push({ name: 'evidence/' + e.dto.id + '.' + extension, bytes });
    }
    const manifest = Buffer.from(
      json({
        sourceSnapshotSha256: financeSha(source),
        asOf: source.request.asOf,
        observedAt: source.observedAt,
        files: files.map((f) => ({
          name: f.name,
          bytes: f.bytes.length,
          sha256: fileSha(f.bytes),
        })),
      }),
    );
    uncompressed += manifest.length;
    requireRule(
      uncompressed <= bundleLimit,
      'EXPORT_TOO_LARGE',
      '一式の非圧縮容量が64MiBを超えています。原資料を個別取得してください',
    );
    files.push({ name: 'manifest.json', bytes: manifest });
    return { bytes: archive(files), extension: 'tar.gz', mediaType: 'application/gzip' };
  }
  async process(actor: Actor, id: string) {
    this.finance.authorize(actor);
    financeParse(F.FinanceIdSchema, id);
    const owner = randomUUID();
    const record = await this.business.database.transaction(actor, async (tx) => {
      await this.business.contract(tx, false);
      const [r] = await rows<ExportRow>(
        tx,
        sql`SELECT * FROM purchase_export_snapshots WHERE id=${id}::uuid FOR UPDATE`,
      );
      requireRule(r, 'NOT_FOUND', '出力がありません', 404);
      this.finance.authorize(actor, r.store_id);
      if (['completed', 'failed'].includes(r.status)) return null;
      const body = bodySchema.parse(r.body);
      requireRule(
        r.status !== 'running' ||
          (body.startedAt && Date.parse(body.startedAt) < Date.now() - 120000),
        'EXPORT_RUNNING',
        '別ワーカーが出力中です',
      );
      await tx.$executeRaw(
        sql`UPDATE purchase_export_snapshots SET status='running',body=${json({ owner, startedAt: new Date().toISOString() })}::jsonb WHERE id=${id}::uuid`,
      );
      return r;
    });
    if (!record) return;
    try {
      const source = sourceSchema.parse(record.source);
      requireRule(
        financeSha(source) === record.source_sha256,
        'EVIDENCE_UNAVAILABLE',
        '固定した出力元のSHAが一致しません',
        503,
      );
      const result = await this.render(source);
      const key = actor.tenantId + '/finance/exports/' + randomUUID();
      await this.files.put(key, result.bytes, result.mediaType);
      const body = {
        owner,
        key,
        fileSha256: fileSha(result.bytes),
        bytes: result.bytes.length,
        mediaType: result.mediaType,
        filename: 'regi-' + id + '.' + result.extension,
        error: null,
        completedAt: new Date().toISOString(),
      };
      await this.finish(actor, id, owner, 'completed', body);
    } catch (error: unknown) {
      const businessError =
        error instanceof BusinessError
          ? error
          : new BusinessError(
              'INTERNAL_ERROR',
              '固定した出力を作成できませんでした。操作結果・原資料を確認してください',
              500,
              undefined,
              true,
            );
      await this.finish(actor, id, owner, 'failed', {
        owner,
        fileSha256: null,
        bytes: null,
        mediaType: null,
        filename: null,
        error: {
          code: businessError.code,
          message: businessError.message,
          field: businessError.field ?? null,
          retryable: businessError.retryable,
          nextAction:
            businessError.code === 'EXPORT_TOO_LARGE'
              ? '原資料を個別取得してください'
              : '元の出力要求・原資料を確認してください',
        },
        completedAt: new Date().toISOString(),
      });
    }
  }
  private async finish(
    actor: Actor,
    id: string,
    owner: string,
    status: 'completed' | 'failed',
    body: unknown,
  ) {
    await this.business.database.transaction(actor, async (tx) => {
      const [r] = await rows<ExportRow>(
        tx,
        sql`SELECT * FROM purchase_export_snapshots WHERE id=${id}::uuid FOR UPDATE`,
      );
      requireRule(
        r && r.status === 'running' && bodySchema.parse(r.body).owner === owner,
        'EXPORT_EXPIRED',
        '出力処理の所有権が失効しました',
      );
      await tx.$executeRaw(
        sql`UPDATE purchase_export_snapshots SET status=${status},body=${json(body)}::jsonb WHERE id=${id}::uuid`,
      );
      await this.business.change(
        tx,
        actor,
        'purchase-finance',
        id,
        { id, status, version: 2 },
        r.store_id,
      );
    });
  }
  async download(actor: Actor, id: string, storeId: unknown) {
    const dto = await this.get(actor, id, storeId);
    requireRule(dto.status === 'completed', 'EXPORT_PENDING', '出力が完了していません');
    const [row] = await this.business.database.transaction(actor, (tx) =>
      rows<ExportRow>(tx, sql`SELECT * FROM purchase_export_snapshots WHERE id=${id}::uuid`),
    );
    requireRule(row, 'NOT_FOUND', '出力がありません', 404);
    const body = bodySchema.parse(row.body);
    requireRule(
      body.key && dto.bytes !== null && dto.fileSha256 && dto.mediaType && dto.filename,
      'EVIDENCE_UNAVAILABLE',
      '出力ファイルの記録を確認できません',
      503,
    );
    return {
      bytes: await this.files.get(body.key, dto.bytes, dto.fileSha256),
      mediaType: dto.mediaType,
      filename: dto.filename,
      sha256: dto.fileSha256,
    };
  }
  async tick(actor: Actor) {
    if (!['admin', 'headquarters', 'manager'].includes(actor.role) || actor.deviceId) return;
    const jobs = await this.business.database.transaction(actor, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`SELECT id FROM purchase_export_snapshots WHERE status='queued' OR (status='running' AND (body->>'startedAt')::timestamptz<clock_timestamp()-interval '120 seconds') ORDER BY created_at,id LIMIT 10`,
      ),
    );
    for (const job of jobs) await this.process(actor, job.id);
  }
}
