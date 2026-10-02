import { Injectable } from '@nestjs/common';
import { Actor, rows, sql } from './db';
import { Business } from './service';
import { requireRule } from './errors';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { archive } from './archive';
import { renderDocumentPdf } from './pdf';
import { z } from 'zod';
const directory = join(process.cwd(), '.context', 'artifacts');
export function csv(value: unknown) {
  const text = String(value ?? '');
  return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
}
@Injectable()
export class Artifacts {
  constructor(private readonly business: Business) {}
  async request(actor: Actor, input: unknown) {
    const data = z
      .object({
        operationId: z.uuid(),
        storeId: z.uuid(),
        format: z.string(),
        documentId: z.uuid().nullable().optional(),
      })
      .parse(input);
    this.business.access(actor, data.storeId, ['admin', 'headquarters', 'manager']);
    requireRule(
      ['csv', 'bundle', 'purchase-pdf', 'receipt-pdf', 'refund-pdf'].includes(data.format),
      'EXPORT_FORMAT',
      '出力形式が不正です',
      400,
    );
    const job = await this.business.mutation(
      actor,
      input,
      'export.request',
      data.storeId,
      async (transaction) => {
        await this.business.contract(transaction, false);
        if (['purchase-pdf', 'receipt-pdf', 'refund-pdf'].includes(data.format)) {
          requireRule(data.documentId, 'INVALID_INPUT', '出力対象が必要です', 400);
          const kind =
            data.format === 'purchase-pdf'
              ? 'purchase-order'
              : data.format === 'refund-pdf'
                ? 'refund'
                : 'sale';
          const [source] = await rows<{ id: string }>(
            transaction,
            sql`SELECT id FROM documents WHERE id=${data.documentId}::uuid AND kind=${kind} AND store_id=${data.storeId}::uuid`,
          );
          requireRule(source, 'NOT_FOUND', '同じ店舗の出力対象がありません', 404);
        }
        return this.business.createDocument(
          transaction,
          actor,
          'export',
          'queued',
          { format: data.format, documentId: data.documentId ?? null },
          data.storeId,
        );
      },
      true,
    );
    if (process.env.EXPORT_QUEUE_URL)
      await new SQSClient({ region: process.env.AWS_REGION }).send(
        new SendMessageCommand({
          QueueUrl: process.env.EXPORT_QUEUE_URL,
          MessageBody: JSON.stringify({
            id: job.id,
            tenantId: actor.tenantId,
            staffId: actor.staffId,
          }),
        }),
      );
    return job;
  }
  async process(actor: Actor, id: string) {
    const owner = randomUUID(),
      record = await this.business.database.transaction(actor, async (transaction) => {
        await this.business.contract(transaction, false);
        const current = await this.business.document(transaction, id, 'export');
        this.business.access(actor, current.store_id, ['admin', 'headquarters', 'manager']);
        if (current.status === 'completed') return null;
        requireRule(
          current.status !== 'running' ||
            Date.parse(current.body.processingStartedAt) < Date.now() - 120000,
          'EXPORT_RUNNING',
          '別ワーカーが帳票を作成中です',
          409,
        );
        return this.business.update(transaction, actor, current, 'running', {
          ...current.body,
          owner,
          processingStartedAt: new Date().toISOString(),
        });
      });
    if (!record) return;
    try {
      let bytes: Buffer, extension: string;
      if (['csv', 'bundle'].includes(record.body.format)) {
        const records = await this.business.database.transaction(actor, async (transaction) => {
          await this.business.contract(transaction, false);
          return rows(
            transaction,
            sql`SELECT * FROM documents WHERE kind IN ('sale','refund','purchase-order') AND store_id=${record.store_id}::uuid ORDER BY created_at,id`,
          );
        });
        const sales = records.filter((entry) => entry.kind === 'sale'),
          refunds = records.filter((entry) => entry.kind === 'refund');
        bytes = Buffer.from(
          '\ufeff' +
            [
              ['種類', '番号', '日時', '税込金額', '状態'].map(csv).join(','),
              ...sales
                .concat(refunds)
                .map((entry) =>
                  [
                    entry.kind,
                    entry.id,
                    entry.body.occurredAt ?? entry.body.refundedAt,
                    entry.body.total,
                    entry.status,
                  ]
                    .map(csv)
                    .join(','),
                ),
            ].join('\r\n'),
        );
        extension = 'csv';
        if (record.body.format === 'bundle') {
          const files = [
            { name: 'transactions.csv', bytes },
            { name: 'snapshots.json', bytes: Buffer.from(JSON.stringify(records)) },
          ];
          for (const source of records.filter(
            (entry) =>
              entry.kind === 'sale' ||
              (entry.kind === 'refund' && entry.status === 'confirmed') ||
              (entry.kind === 'purchase-order' && entry.body.issuedSnapshot),
          ))
            files.push({
              name: `documents/${source.kind}-${source.id}.pdf`,
              bytes: await renderDocumentPdf(source.kind, source),
            });
          files.push({
            name: 'inventory.json',
            bytes: Buffer.from(
              JSON.stringify(await this.business.inventory(actor, record.store_id)),
            ),
          });
          bytes = archive(files);
          extension = 'tar.gz';
        }
      } else {
        const kind =
          record.body.format === 'purchase-pdf'
            ? 'purchase-order'
            : record.body.format === 'refund-pdf'
              ? 'refund'
              : 'sale';
        const source = await this.business.database.transaction(actor, (transaction) =>
          this.business.document(transaction, record.body.documentId, kind),
        );
        requireRule(
          source.store_id === record.store_id,
          'STORE_MISMATCH',
          '帳票の店舗が異なります',
          403,
        );
        requireRule(
          kind !== 'purchase-order' || source.body.issuedSnapshot,
          'ORDER_NOT_ISSUED',
          '発注書は発行後に出力できます',
        );
        requireRule(
          kind !== 'refund' || source.status === 'confirmed',
          'REFUND_NOT_CONFIRMED',
          '返還伝票は返金確定後に出力してください',
        );
        bytes = await renderDocumentPdf(kind, source);
        extension = 'pdf';
      }
      const filename = `${id}-${owner}.${extension}`,
        key = `${actor.tenantId}/${filename}`;
      if (process.env.ARTIFACT_BUCKET)
        await new S3Client({ region: process.env.AWS_REGION }).send(
          new PutObjectCommand({
            Bucket: process.env.ARTIFACT_BUCKET,
            Key: key,
            Body: bytes,
            ContentType:
              extension === 'pdf'
                ? 'application/pdf'
                : extension === 'tar.gz'
                  ? 'application/gzip'
                  : 'text/csv',
            ServerSideEncryption: 'AES256',
          }),
        );
      else {
        requireRule(
          process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
          'ARTIFACT_CONFIG',
          '本番S3が未設定です',
          503,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, filename), bytes);
      }
      await this.business.database.transaction(actor, async (transaction) => {
        const current = await this.business.document(transaction, id, 'export');
        requireRule(
          current.status === 'running' && current.body.owner === owner,
          'EXPORT_EXPIRED',
          '帳票処理所有権が失効しました',
          409,
        );
        await this.business.update(transaction, actor, current, 'completed', {
          ...current.body,
          key,
          filename,
          extension,
          bytes: bytes.length,
        });
      });
    } catch (error) {
      await this.business.database.transaction(actor, async (transaction) => {
        const current = await this.business.document(transaction, id, 'export');
        if (current.status === 'running' && current.body.owner === owner)
          await this.business.update(transaction, actor, current, 'queued', {
            ...current.body,
            error: 'TECHNICAL_FAILURE',
            retryAt: new Date(Date.now() + 60000).toISOString(),
          });
      });
      throw error;
    }
  }
  async download(actor: Actor, id: string) {
    requireRule(
      !actor.deviceId && ['admin', 'headquarters', 'manager'].includes(actor.role),
      'ROLE_FORBIDDEN',
      '帳票取得の権限がありません',
      403,
    );
    const record = await this.business.database.transaction(actor, async (transaction) => {
      await this.business.contract(transaction, false);
      return this.business.document(transaction, id, 'export');
    });
    this.business.access(actor, record.store_id, ['admin', 'headquarters', 'manager']);
    requireRule(record.status === 'completed', 'EXPORT_PENDING', '出力処理中です');
    if (process.env.ARTIFACT_BUCKET) {
      const output = await new S3Client({ region: process.env.AWS_REGION }).send(
        new GetObjectCommand({ Bucket: process.env.ARTIFACT_BUCKET, Key: record.body.key }),
      );
      return {
        bytes: Buffer.from(await output.Body!.transformToByteArray()),
        extension: record.body.extension,
      };
    }
    return {
      bytes: readFileSync(
        join(directory, record.body.filename ?? `${record.id}.${record.body.extension}`),
      ),
      extension: record.body.extension,
    };
  }
  async tick(actor: Actor) {
    const jobs = await this.business.database.transaction(actor, (transaction) =>
      rows(
        transaction,
        sql`SELECT id FROM documents WHERE kind='export' AND ((status='queued' AND coalesce((body->>'retryAt')::timestamptz,created_at)<=now()) OR (status='running' AND (body->>'processingStartedAt')::timestamptz<now()-interval '120 seconds')) ORDER BY created_at LIMIT 10`,
      ),
    );
    for (const job of jobs)
      try {
        await this.process(actor, job.id);
      } catch (error: any) {
        console.error('Export failed', job.id, error.message);
      }
  }
}
