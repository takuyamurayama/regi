import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { APIRequestContext, Page } from '@playwright/test';
import { Database, rows, sql } from '../../apps/api/src/db';

const fixtureSchema = z.object({
  tenant: z.uuid(),
  admin: z.uuid(),
  adminSubject: z.string(),
  stores: z.object({ recovery: z.uuid(), hold: z.uuid(), lease: z.uuid() }),
  devices: z.object({ recovery: z.uuid(), hold: z.uuid(), lease: z.uuid() }),
});
export type RegressionFixture = z.infer<typeof fixtureSchema>;
export const documentSchema = z.object({ id: z.uuid() });
export const receiptSchema = documentSchema.extend({
  body: z.object({
    orderId: z.uuid(),
    lines: z.array(z.object({ index: z.number(), quantity: z.number(), productId: z.uuid() })),
  }),
});

export function regressionFixture(): RegressionFixture {
  const value: unknown = JSON.parse(
    execFileSync('npx', ['tsx', 'scripts/android-fixture.ts'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    }),
  );
  return fixtureSchema.parse(value);
}

export function headers(fixture: RegressionFixture): Record<string, string> {
  return { 'x-tenant-id': fixture.tenant, 'x-staff-subject': fixture.adminSubject };
}

export async function useFixture(page: Page, fixture: RegressionFixture): Promise<void> {
  await page.addInitScript(
    ({ tenant, subject }) => {
      sessionStorage.setItem('regi-dev-tenant', tenant);
      sessionStorage.setItem('regi-dev-subject', subject);
    },
    { tenant: fixture.tenant, subject: fixture.adminSubject },
  );
}

export async function get<T>(
  request: APIRequestContext,
  fixture: RegressionFixture,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await request.get(path, { headers: headers(fixture) });
  assert.ok(response.ok(), await response.text());
  const value: unknown = await response.json();
  return schema.parse(value);
}

export async function command<T>(
  request: APIRequestContext,
  fixture: RegressionFixture,
  store: string,
  path: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await request.post(path, {
    headers: headers(fixture),
    data: { operationId: randomUUID(), storeId: store, ...body },
  });
  assert.ok(response.ok(), await response.text());
  const value: unknown = await response.json();
  return schema.parse(value);
}

export async function issuedOrder(
  request: APIRequestContext,
  fixture: RegressionFixture,
  store = fixture.stores.recovery,
): Promise<{ id: string; productId: string; supplier: string }> {
  const products = await get(request, fixture, '/v1/products', z.array(documentSchema));
  assert.ok(products[0]);
  const supplier = `通信回帰試験 ${randomUUID()}`;
  const order = await command(
    request,
    fixture,
    store,
    '/v1/purchase-orders',
    {
      supplier,
      expectedAt: new Date().toISOString().slice(0, 10),
      lines: [{ productId: products[0].id, quantity: 10, unitCost: '350' }],
    },
    documentSchema,
  );
  await command(
    request,
    fixture,
    store,
    `/v1/purchase-orders/${order.id}/approve`,
    {},
    documentSchema,
  );
  await command(
    request,
    fixture,
    store,
    `/v1/purchase-orders/${order.id}/issue`,
    {},
    documentSchema,
  );
  return { id: order.id, productId: products[0].id, supplier };
}

export async function mutationFacts(
  fixture: RegressionFixture,
  store: string,
  action: 'receipt.create' | 'cash.record',
): Promise<{ operations: string; audit: string }> {
  const database = new Database();
  try {
    return await database.transaction(
      {
        tenantId: fixture.tenant,
        staffId: fixture.admin,
        role: 'admin',
        stores: Object.values(fixture.stores),
        mfa: true,
      },
      async (transaction) => {
        const facts = await rows<{ operations: string; audit: string }>(
          transaction,
          sql`SELECT
            (SELECT count(*)::text FROM operations WHERE store_id=${store}::uuid AND id IN
              (SELECT entity_id FROM audit WHERE store_id=${store}::uuid AND action=${action})) AS operations,
            (SELECT count(*)::text FROM audit WHERE store_id=${store}::uuid AND action=${action}) AS audit`,
        );
        assert.ok(facts[0]);
        return facts[0];
      },
    );
  } finally {
    await database.client.$disconnect();
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((completion) => {
    resolve = completion;
  });
  return { promise, resolve };
}

export async function afterBrowserPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
