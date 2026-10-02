import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { Database, Actor, rows, sql } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';

interface ApiResult {
  code?: string;
  message?: string;
  nextAction?: string;
  retryable?: boolean;
  count?: number;
  results?: { status: string }[];
  ids?: string[];
}
interface ApiChanges {
  cursor: string;
  changes: { cursor: string; entity_id: string; kind: string }[];
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

void test(
  'HTTP accepts one hundred sales with five lines and five thousand CSV rows; every body limit returns actionable nonretryable Japanese 413',
  { timeout: 180000 },
  async () => {
    const database = new Database(),
      business = new Business(database),
      tenant = randomUUID(),
      store = randomUUID(),
      staff = randomUUID(),
      device = randomUUID(),
      product = randomUUID();
    const actor: Actor = {
      tenantId: tenant,
      staffId: staff,
      stores: [store],
      role: 'admin',
      mfa: true,
    };
    await database.transaction(actor, async (transaction) => {
      await transaction.$executeRaw(
        sql`INSERT INTO tenants VALUES(${tenant}::uuid,'HTTP容量試験','inclusive',now()-interval '1 day',now()+interval '2 years',1)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'HTTP容量試験店')`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${tenant},'管理者','admin',ARRAY[${store}::uuid],${pinHash('1234', tenant)},true)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${tenant}::uuid,${store}::uuid,'HTTP容量端末')`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'HTTP-LIMIT','HTTP容量商品',true,50)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,'standard',1000,now()-interval '1 day')`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${tenant}::uuid,${product}::uuid,101,'standard',now()-interval '1 day',50)`,
      );
    });
    const boot = (await business.bootstrap(actor, device)) as { leaseId: string };
    const shift = (await business.openShift(actor, {
      operationId: randomUUID(),
      storeId: store,
      deviceId: device,
      opening: '1000',
      pin: '1234',
    })) as { id: string };
    const port = await unusedPort(),
      base = 'http://127.0.0.1:' + String(port);
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'],
      { stdio: 'pipe' },
    );
    const server = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], {
      env: { ...process.env, NODE_ENV: 'test', REGI_DEV_AUTH: 'true', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant,
          'x-staff-subject': tenant,
        },
        body: JSON.stringify(body),
      });
    try {
      let started = false;
      for (let attempt = 0; attempt < 150 && server.exitCode === null; attempt++) {
        try {
          const response = await fetch(base + '/health');
          if (response.ok) {
            started = true;
            break;
          }
        } catch {
          /* Startup has not opened its socket yet. */
        }
        await delay(100);
      }
      assert.ok(started, output);
      const events = Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        deviceId: device,
        leaseId: boot.leaseId,
        sequence: String(index + 1),
        staffId: staff,
        occurredAt: new Date().toISOString(),
        ruleVersion: 'regi-1',
        type: 'sale',
        body: {
          mode: 'inclusive',
          discount: '0',
          total: '505',
          method: 'cash',
          tendered: '1000',
          shiftId: shift.id,
          lines: Array.from({ length: 5 }, () => ({
            productId: product,
            name: '日本語の容量確認用商品'.repeat(12),
            quantity: 1,
            price: '101',
            discount: '0',
            rateBps: 1000,
            cost: '50',
            stockManaged: true,
          })),
        },
      }));
      assert.ok(Buffer.byteLength(JSON.stringify({ events })) > 100 * 1024);
      const sync = await post('/v1/sync/events', { events }),
        syncBody = (await sync.json()) as ApiResult;
      assert.equal(sync.status, 201, JSON.stringify(syncBody));
      assert.equal(syncBody.results?.length, 100);
      assert.ok(syncBody.results?.every((result) => result.status === 'accepted'));
      const csv =
        'sku,jan,name,price,cost,taxCode,stockManaged\n' +
        Array.from(
          { length: 5000 },
          (_, index) =>
            'CSV-' +
            String(index) +
            ',,' +
            '日本語商品'.repeat(38) +
            String(index) +
            ',100,50,standard,true',
        ).join('\n');
      assert.ok(Buffer.byteLength(JSON.stringify({ csv })) > 2 * 1024 * 1024);
      const snapshot = () =>
        database.transaction(actor, (transaction) =>
          rows<{
            products: number;
            prices: number;
            changes: number;
            operations: number;
            audits: number;
            cursor: string;
          }>(
            transaction,
            sql`SELECT (SELECT count(*)::int FROM products) AS products,(SELECT count(*)::int FROM prices) AS prices,(SELECT count(*)::int FROM changes) AS changes,(SELECT count(*)::int FROM operations) AS operations,(SELECT count(*)::int FROM audit) AS audits,(SELECT cursor::text FROM change_heads) AS cursor`,
          ),
        );
      const before = (await snapshot())[0],
        importInput = { operationId: randomUUID(), csv };
      const imported = await post('/v1/products/import', importInput),
        importedBody = (await imported.json()) as ApiResult;
      assert.equal(imported.status, 201, JSON.stringify(importedBody));
      assert.equal(importedBody.count, 5000);
      const ids = importedBody.ids;
      assert.ok(ids);
      assert.equal(new Set(ids).size, 5000);
      const after = (await snapshot())[0];
      assert.deepEqual(after, {
        products: before.products + 5000,
        prices: before.prices + 5000,
        changes: before.changes + 5000,
        operations: before.operations + 1,
        audits: before.audits + 1,
        cursor: (BigInt(before.cursor) + 5000n).toString(),
      });
      const productChanges = await database.transaction(actor, (transaction) =>
        rows<{ cursor: string; entity_id: string }>(
          transaction,
          sql`SELECT cursor::text,entity_id FROM changes WHERE kind='product' AND cursor>${BigInt(before.cursor)} ORDER BY changes.cursor`,
        ),
      );
      assert.deepEqual(
        productChanges.map((record) => record.entity_id),
        ids,
      );
      assert.deepEqual(
        productChanges.map((record) => record.cursor),
        Array.from({ length: 5000 }, (_, index) =>
          (BigInt(before.cursor) + BigInt(index + 1)).toString(),
        ),
      );
      let cursor = before.cursor;
      const delivered: string[] = [];
      while (BigInt(cursor) < BigInt(after.cursor)) {
        const response = await fetch(base + '/v1/sync/changes?cursor=' + cursor, {
          headers: { 'x-tenant-id': tenant, 'x-staff-subject': tenant },
        });
        assert.equal(response.status, 200);
        const page = (await response.json()) as ApiChanges;
        assert.equal(page.changes.length, 1000);
        assert.deepEqual(
          page.changes.map((record) => record.cursor),
          Array.from({ length: 1000 }, (_, index) =>
            (BigInt(cursor) + BigInt(index + 1)).toString(),
          ),
        );
        assert.ok(page.changes.every((record) => record.kind === 'product'));
        delivered.push(...page.changes.map((record) => record.entity_id));
        assert.equal(page.cursor, page.changes.at(-1)?.cursor);
        cursor = page.cursor;
      }
      assert.equal(cursor, after.cursor);
      assert.deepEqual(delivered, ids);
      const replay = await post('/v1/products/import', importInput);
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), importedBody);
      assert.deepEqual((await snapshot())[0], after);
      for (const failure of ['duplicate', 'tax']) {
        const brokenCsv =
          'sku,jan,name,price,cost,taxCode,stockManaged\n' +
          Array.from(
            { length: 501 },
            (_, index) =>
              (index === 500 && failure === 'duplicate' ? 'CSV-0' : `ROLLBACK-${index}`) +
              `,,原子性試験,100,50,${index === 500 && failure === 'tax' ? 'missing-tax' : 'standard'},true`,
          ).join('\n');
        const failed = await post('/v1/products/import', {
          operationId: randomUUID(),
          csv: brokenCsv,
        });
        assert.equal(failed.status, failure === 'duplicate' ? 500 : 400);
        assert.deepEqual((await snapshot())[0], after);
        const rollback = await database.transaction(actor, (transaction) =>
          rows<{ count: number }>(
            transaction,
            sql`SELECT count(*)::int AS count FROM products WHERE sku LIKE 'ROLLBACK-%'`,
          ),
        );
        assert.equal(rollback[0].count, 0);
      }
      for (const [path, body] of [
        ['/v1/sync/events', { events: [], padding: 'x'.repeat(4 * 1024 * 1024) }],
        ['/v1/products/import', { operationId: randomUUID(), csv: 'x'.repeat(5 * 1024 * 1024) }],
        ['/v1/devices/' + device + '/status', { padding: 'x'.repeat(256 * 1024) }],
      ] as const) {
        const response = await post(path, body),
          result = (await response.json()) as ApiResult;
        assert.equal(response.status, 413);
        assert.equal(result.code, 'PAYLOAD_TOO_LARGE');
        assert.equal(result.retryable, false);
        assert.equal(result.nextAction, '分割して再送');
        assert.ok(result.message && /[\u3040-\u30ff\u4e00-\u9fff]/.test(result.message));
        assert.ok(!result.message.includes('too large'));
      }
    } finally {
      writeFileSync('.context/d0-payload-limit-server.log', output);
      server.kill('SIGTERM');
      if (server.exitCode === null)
        await Promise.race([
          new Promise<void>((resolve) => server.once('exit', () => resolve())),
          delay(5000).then(() => {
            server.kill('SIGKILL');
          }),
        ]);
      await database.client.$disconnect();
    }
  },
);
