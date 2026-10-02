import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { rows, sql } from '../apps/api/src/db';
import { BusinessError } from '../apps/api/src/errors';
import { digest, json } from '../apps/api/src/service';
import { syncFixture } from './sync-fixture';

type Fixture = Awaited<ReturnType<typeof syncFixture>>;
interface ShiftRow {
  id: string;
  status: string;
  body: { deviceId: string; opening: string; expected?: string; difference?: string };
}
interface Counts {
  operations: number;
  audit: number;
  changes: number;
  head: string;
}
interface HttpError {
  code: string;
  message: string;
  retryable: boolean;
}
const closeInput = (store: string, actual = '1000') => ({
  operationId: randomUUID(),
  storeId: store,
  actual,
});
const errorCode = (expected: string) => (error: unknown) =>
  error instanceof BusinessError && error.code === expected && !error.retryable;
async function snapshot(fixture: Fixture) {
  return fixture.database.transaction(fixture.admin, async (transaction) => {
    const [counts] = await rows<Counts>(
      transaction,
      sql`SELECT (SELECT count(*)::int FROM operations) AS operations,(SELECT count(*)::int FROM audit) AS audit,(SELECT count(*)::int FROM changes) AS changes,(SELECT cursor::text FROM change_heads) AS head`,
    );
    const shifts = await rows<ShiftRow>(
      transaction,
      sql`SELECT id,status,body FROM documents WHERE kind='shift' ORDER BY id`,
    );
    return { counts, shifts };
  });
}
async function reportSynced(fixture: Fixture) {
  await fixture.business.deviceStatus(fixture.admin, fixture.device, {
    operationId: randomUUID(),
    storeId: fixture.store,
    stopped: false,
    pending: 0,
    reviewCount: 0,
  });
}
async function port() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

void test(
  'HTTP online shift close rejects pending, unknown, unreported, stale, future and client review states without changing money or audit',
  { timeout: 60000 },
  async () => {
    const fixture = await syncFixture();
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'],
      { stdio: 'pipe' },
    );
    const serverPort = await port(),
      base = `http://127.0.0.1:${serverPort}`;
    const server = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        REGI_DEV_AUTH: 'true',
        PORT: String(serverPort),
      },
      stdio: 'ignore',
    });
    const close = (input: ReturnType<typeof closeInput>) =>
      fetch(`${base}/v1/shifts/${fixture.sale.body.shiftId}/close`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': fixture.admin.tenantId,
          'x-staff-subject': fixture.admin.tenantId,
        },
        body: JSON.stringify(input),
      });
    try {
      let started = false;
      for (let attempt = 0; attempt < 150 && server.exitCode === null; attempt++) {
        try {
          if ((await fetch(base + '/health')).ok) {
            started = true;
            break;
          }
        } catch {
          // The compiled API has not opened its socket yet.
        }
        await delay(100);
      }
      assert.ok(started, 'Compiled API starts with Nest constructor metadata');
      const cases = [
        { label: 'pending outbox', pending: 1, review: 0, age: 0, code: 'SYNC_PENDING' },
        {
          label: 'unknown checkout aggregate',
          pending: 1,
          review: 0,
          age: 0,
          code: 'SYNC_PENDING',
        },
        { label: 'unreported sync', pending: 0, review: 0, age: null, code: 'SYNC_PENDING' },
        { label: 'stale sync', pending: 0, review: 0, age: 180000, code: 'SYNC_PENDING' },
        { label: 'future sync', pending: 0, review: 0, age: -180000, code: 'SYNC_PENDING' },
        { label: 'client review only', pending: 0, review: 1, age: 0, code: 'REVIEW_PENDING' },
      ];
      for (const state of cases) {
        await fixture.database.transaction(fixture.admin, (transaction) =>
          transaction.$executeRaw(
            sql`UPDATE devices SET pending=${state.pending},review_count=${state.review},last_sync=${state.age === null ? null : new Date(Date.now() - state.age)} WHERE id=${fixture.device}::uuid`,
          ),
        );
        const before = await snapshot(fixture),
          response = await close(closeInput(fixture.store)),
          body = (await response.json()) as HttpError;
        assert.equal(response.status, 409, state.label);
        assert.equal(body.code, state.code, state.label);
        assert.equal(body.retryable, false, state.label);
        assert.match(body.message, /同期|要確認/);
        assert.deepEqual(await snapshot(fixture), before, state.label);
      }
      await reportSynced(fixture);
      const before = await snapshot(fixture),
        wrongStore = await close(closeInput(randomUUID()));
      assert.equal(wrongStore.status, 409);
      assert.equal(((await wrongStore.json()) as HttpError).code, 'SHIFT_STATE');
      assert.deepEqual(await snapshot(fixture), before);
      const unregistered = randomUUID();
      await fixture.database.transaction(fixture.admin, (transaction) =>
        transaction.$executeRaw(
          sql`UPDATE documents SET body=jsonb_set(body,'{deviceId}',to_jsonb(${unregistered}::text)) WHERE id=${fixture.sale.body.shiftId}::uuid`,
        ),
      );
      const unknownBefore = await snapshot(fixture),
        unknownDevice = await close(closeInput(fixture.store));
      assert.equal(unknownDevice.status, 404);
      assert.equal(((await unknownDevice.json()) as HttpError).code, 'DEVICE_NOT_FOUND');
      assert.deepEqual(await snapshot(fixture), unknownBefore);
    } finally {
      server.kill('SIGTERM');
      if (server.exitCode === null) await once(server, 'exit');
      await fixture.database.client.$disconnect();
    }
  },
);

void test('online shift close blocks main and quarantine nonterminal events until dismissal and counts accepted cash exactly once', async () => {
  const fixture = await syncFixture();
  try {
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    await reportSynced(fixture);
    const accepted = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ status: string; hash: string; body: unknown; result: unknown }>(
        transaction,
        sql`SELECT status,hash,body,result FROM device_events WHERE id=${fixture.sale.id}::uuid`,
      ),
    );
    let sequence = 2;
    for (const source of ['main', 'quarantine']) {
      for (const status of ['pending', 'review', 'waiting']) {
        const event = {
          ...fixture.sale,
          id: randomUUID(),
          sequence: String(sequence++),
          body: { ...fixture.sale.body, total: '999' },
        };
        const result = { id: event.id, status: status === 'review' ? 'review' : 'retry' };
        await fixture.database.transaction(fixture.admin, (transaction) =>
          transaction.$executeRaw(
            sql`INSERT INTO ${source === 'main' ? Prisma.raw('device_events') : Prisma.raw('device_event_quarantine')}(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES(${fixture.admin.tenantId}::uuid,${event.id}::uuid,${fixture.store}::uuid,${fixture.device}::uuid,${event.sequence}::bigint,${digest(event)},${status},${json(result)}::jsonb,${json(event)}::jsonb)`,
          ),
        );
        const before = await snapshot(fixture);
        await assert.rejects(
          () =>
            fixture.business.closeShift(
              fixture.admin,
              fixture.sale.body.shiftId,
              closeInput(fixture.store, '1101'),
            ),
          errorCode('REVIEW_PENDING'),
        );
        assert.deepEqual(await snapshot(fixture), before);
        const dismissed: unknown = await fixture.business.dismissReview(fixture.admin, event.id, {
          operationId: randomUUID(),
          storeId: fixture.store,
          source,
          reason: '原受領済み売上と照合し重複する試験イベントを棄却',
        });
        assert.ok(dismissed && typeof dismissed === 'object' && 'status' in dismissed);
        assert.equal(dismissed.status, 'accepted');
      }
    }
    const otherDevice = randomUUID();
    await fixture.database.transaction(fixture.admin, async (transaction) => {
      await transaction.$executeRaw(
        sql`INSERT INTO devices(id,tenant_id,store_id,name,pending) VALUES(${otherDevice}::uuid,${fixture.admin.tenantId}::uuid,${fixture.store}::uuid,'別端末',7)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO device_event_quarantine(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES(${fixture.admin.tenantId}::uuid,${randomUUID()}::uuid,${fixture.store}::uuid,${otherDevice}::uuid,1,'other-device','waiting','{}'::jsonb,'{}'::jsonb)`,
      );
    });
    await reportSynced(fixture);
    const result: unknown = await fixture.business.closeShift(
      fixture.admin,
      fixture.sale.body.shiftId,
      closeInput(fixture.store, '1101'),
    );
    const closed = result as ShiftRow;
    assert.equal(closed.status, 'provisional');
    assert.equal(closed.body.expected, '1101');
    assert.equal(closed.body.difference, '0');
    assert.deepEqual(
      await fixture.database.transaction(fixture.admin, (transaction) =>
        rows<{ status: string; hash: string; body: unknown; result: unknown }>(
          transaction,
          sql`SELECT status,hash,body,result FROM device_events WHERE id=${fixture.sale.id}::uuid`,
        ),
      ),
      accepted,
    );
    const [facts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ sales: number; stock: string; dismissed: number }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM documents WHERE kind='sale') AS sales,(SELECT sum(quantity)::text FROM inventory) AS stock,(SELECT count(*)::int FROM (SELECT id FROM device_events WHERE status='dismissed' UNION ALL SELECT id FROM device_event_quarantine WHERE status='dismissed') terminal) AS dismissed`,
      ),
    );
    assert.deepEqual(facts, { sales: 1, stock: '-1', dismissed: 6 });
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('completed online shift close replays its original result even after new pending and stale status', async () => {
  const fixture = await syncFixture();
  try {
    await reportSynced(fixture);
    const input = closeInput(fixture.store),
      original: unknown = await fixture.business.closeShift(
        fixture.admin,
        fixture.sale.body.shiftId,
        input,
      );
    await fixture.database.transaction(fixture.admin, (transaction) =>
      transaction.$executeRaw(
        sql`UPDATE devices SET pending=1,review_count=1,last_sync=now()-interval '1 day' WHERE id=${fixture.device}::uuid`,
      ),
    );
    const before = await snapshot(fixture),
      replay: unknown = await fixture.business.closeShift(
        fixture.admin,
        fixture.sale.body.shiftId,
        input,
      );
    const persistedOriginal: unknown = JSON.parse(JSON.stringify(original));
    assert.deepEqual(replay, persistedOriginal);
    assert.deepEqual(await snapshot(fixture), before);
    assert.equal(before.shifts[0].status, 'provisional');
    assert.equal(before.shifts[0].body.expected, '1000');
    assert.equal(before.shifts[0].body.difference, '0');
    const [count] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ operations: number; audits: number; changes: number }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM operations WHERE id=${input.operationId}::uuid) AS operations,(SELECT count(*)::int FROM audit WHERE action='shift.close' AND entity_id=${input.operationId}::uuid) AS audits,(SELECT count(*)::int FROM changes WHERE kind='shift' AND entity_id=${fixture.sale.body.shiftId}::uuid AND body->>'status'='provisional') AS changes`,
      ),
    );
    assert.deepEqual(count, { operations: 1, audits: 1, changes: 1 });
  } finally {
    await fixture.database.client.$disconnect();
  }
});
