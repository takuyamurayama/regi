import { Injectable } from '@nestjs/common';
import { Actor, rows, sql } from './db';
import { Business } from './service';
import { requireRule } from './errors';
import { parseCsv } from '../../../packages/core/src/csv';
import { money } from '../../../packages/core/src';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
          .max(1024 * 1024),
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
      const [count] = await rows(transaction, sql`SELECT count(*)::int AS count FROM products`);
      requireRule(
        count.count + data.length <= 50000,
        'SKU_LIMIT',
        '法人の5万SKU上限を超えています',
      );
      const effectiveAt = new Date(),
        ids: string[] = [];
      for (const record of data) {
        requireRule(
          money(record.price) <= 9223372036854775807n && money(record.cost) <= 9223372036854775807n,
          'PRICE_RANGE',
          'CSVの単価・原価が整数範囲を超えています',
          400,
        );
        const [tax] = await rows(
          transaction,
          sql`SELECT id FROM tax_rates WHERE code=${record.taxCode} AND effective_at<=now() LIMIT 1`,
        );
        requireRule(tax, 'TAX_NOT_FOUND', 'CSVの税区分が登録されていません', 400);
        const id = randomUUID();
        await transaction.$executeRaw(
          sql`INSERT INTO products(id,tenant_id,sku,jan,name,stock_managed,cost) VALUES(${id}::uuid,${actor.tenantId}::uuid,${record.sku},${record.jan || null},${record.name},${record.stockManaged === 'true'},${money(record.cost)})`,
        );
        await transaction.$executeRaw(
          sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${id}::uuid,${money(record.price)},${record.taxCode},${effectiveAt},${money(record.cost)})`,
        );
        await this.business.change(transaction, actor, 'product', id, { id, ...record }, null);
        ids.push(id);
      }
      return { count: data.length, ids };
    });
  }
}
