import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Database, Actor, sql } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';

interface ApiResult {
  code?: string;
  message?: string;
  nextAction?: string;
  retryable?: boolean;
  count?: number;
  results?: { status: string }[];
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
            'CSV-' + String(index) + ',,日本語商品' + String(index) + ',100,50,standard,true',
        ).join('\n');
      assert.ok(Buffer.byteLength(JSON.stringify({ csv })) > 100 * 1024);
      const imported = await post('/v1/products/import', { operationId: randomUUID(), csv }),
        importedBody = (await imported.json()) as ApiResult;
      assert.equal(imported.status, 201, JSON.stringify(importedBody));
      assert.equal(importedBody.count, 5000);
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
