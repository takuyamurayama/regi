import { Injectable } from '@nestjs/common';
import { Actor, rows, sql } from './db';
import { Business } from './service';
import { requireRule } from './errors';
import { parseCsv } from '../../../packages/core/src/csv';
import { money } from '../../../packages/core/src';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
@Injectable()
export class Imports {
  constructor(private readonly business: Business) {}
  async products(actor: Actor, input: any) {
    requireRule(
      ['admin', 'headquarters'].includes(actor.role),
      'ROLE_FORBIDDEN',
      '商品取込権限がありません',
      403,
    );
    const payload = z
      .object({
        csv: z
          .string()
          .min(1)
          .max(5 * 1024 * 1024),
      })
      .parse(input);
    let records: Record<string, string>[];
    try {
      records = parseCsv(payload.csv);
    } catch (error: any) {
      requireRule(false, 'CSV_INVALID', error.message, 400);
    }
    requireRule(
      records!.length > 0 && records!.length <= 5000,
      'CSV_ROW_LIMIT',
      '1回の取込は1〜5000商品です',
      400,
    );
    const schema = z
      .object({
        sku: z.string().min(1).max(100),
        jan: z.string().max(50),
        name: z.string().min(1).max(200),
        price: z.string().regex(/^\d+$/),
        cost: z.string().regex(/^\d+$/),
        taxCode: z.string().min(1).max(50),
        stockManaged: z.enum(['true', 'false']),
      })
      .strict();
    const data = records!.map((record) => schema.parse(record));
    return this.business.mutation(actor, input, 'products.import', null, async (transaction) => {
      const [count] = await rows<{ count: number }>(
        transaction,
        sql`SELECT count(*)::int AS count FROM products`,
      );
      requireRule(
        count.count + data.length <= 50000,
        'SKU_LIMIT',
        '法人の5万SKU上限を超えています',
      );
      const effectiveAt = new Date();
      const taxes = await rows<{ code: string }>(
        transaction,
        sql`SELECT DISTINCT code FROM tax_rates WHERE effective_at<=now()`,
      );
      const taxCodes = new Set(taxes.map((tax) => tax.code));
      const prepared = data.map((record) => {
        const price = money(record.price),
          cost = money(record.cost);
        requireRule(
          price <= 9223372036854775807n && cost <= 9223372036854775807n,
          'PRICE_RANGE',
          'CSVの単価・原価が整数範囲を超えています',
          400,
        );
        requireRule(
          taxCodes.has(record.taxCode),
          'TAX_NOT_FOUND',
          'CSVの税区分が登録されていません',
          400,
        );
        return { id: randomUUID(), priceId: randomUUID(), record, price, cost };
      });
      const [head] = await rows<{ cursor: bigint }>(
        transaction,
        sql`INSERT INTO change_heads(tenant_id,cursor) VALUES(${actor.tenantId}::uuid,${data.length}) ON CONFLICT(tenant_id) DO UPDATE SET cursor=change_heads.cursor+${data.length} RETURNING cursor`,
      );
      const firstCursor = head.cursor - BigInt(data.length);
      // Bound parameters and round trips while retaining one atomic import and ordered changes.
      for (let offset = 0; offset < prepared.length; offset += 500) {
        const batch = prepared.slice(offset, offset + 500);
        await transaction.$executeRaw(
          sql`INSERT INTO products(id,tenant_id,sku,jan,name,stock_managed,cost) VALUES ${Prisma.join(batch.map(({ id, record, cost }) => sql`(${id}::uuid,${actor.tenantId}::uuid,${record.sku},${record.jan || null},${record.name},${record.stockManaged === 'true'},${cost})`))}`,
        );
        await transaction.$executeRaw(
          sql`INSERT INTO prices(id,tenant_id,product_id,amount,tax_code,effective_at,cost_snapshot) VALUES ${Prisma.join(batch.map(({ id, priceId, record, price, cost }) => sql`(${priceId}::uuid,${actor.tenantId}::uuid,${id}::uuid,${price},${record.taxCode},${effectiveAt},${cost})`))}`,
        );
        await transaction.$executeRaw(
          sql`INSERT INTO changes(tenant_id,cursor,store_id,kind,entity_id,body,created_at) VALUES ${Prisma.join(batch.map(({ id, record }, index) => sql`(${actor.tenantId}::uuid,${firstCursor + BigInt(offset + index + 1)},NULL,'product',${id}::uuid,${JSON.stringify({ id, ...record })}::jsonb,now())`))}`,
        );
      }
      return { count: data.length, ids: prepared.map((record) => record.id) };
    });
  }
}
