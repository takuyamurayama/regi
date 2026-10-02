import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Prisma } from '@prisma/client';
import { Actor, rows, sql, Tx } from '../apps/api/src/db';
import { BusinessError } from '../apps/api/src/errors';
import { pinHash } from '../apps/api/src/service';
import { syncFixture } from './sync-fixture';

interface EventRow {
  id: string;
  status: string;
  body: unknown;
  result: unknown;
  hash: string;
  dismissed_by: string | null;
  dismiss_reason: string | null;
}
interface DeviceChange {
  kind: string;
  entity_id: string;
  body: { id: string; status: string; shiftId?: string };
}
interface ResponseBody {
  id?: string;
  status?: string;
  resolution?: string;
  code?: string;
}
const code = (expected: string) => (error: unknown) =>
  error instanceof BusinessError && error.code === expected;
const invalidSale = (sale: Awaited<ReturnType<typeof syncFixture>>['sale']) => ({
  ...sale,
  body: { ...sale.body, total: '999' },
});
const dismissal = (store: string) => ({
  operationId: randomUUID(),
  storeId: store,
  reason: '原記録と照合し取引の不成立を確認',
});
const closing = (sale: Awaited<ReturnType<typeof syncFixture>>['sale'], sequence = '2') => ({
  id: randomUUID(),
  deviceId: sale.deviceId,
  leaseId: sale.leaseId,
  staffId: sale.staffId,
  occurredAt: new Date().toISOString(),
  ruleVersion: 'regi-1',
  sequence,
  type: 'shift.close',
  body: { shiftId: sale.body.shiftId, actual: '1000' },
});

void test(
  'HTTP signed admin can dismiss once with required reason while other roles and tenants cannot',
  { timeout: 60000 },
  async () => {
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'],
      { stdio: 'pipe' },
    );
    const { database, business, admin, sale, store, device } = await syncFixture();
    const foreign = await syncFixture();
    const manager = randomUUID(),
      cashier = randomUUID(),
      headquarters = randomUUID();
    await database.transaction(admin, async (transaction) => {
      for (const [id, role] of [
        [manager, 'manager'],
        [cashier, 'cashier'],
        [headquarters, 'headquarters'],
      ]) {
        await transaction.$executeRaw(
          sql`INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash,active) VALUES(${id}::uuid,${admin.tenantId}::uuid,${id},'権限試験',${role},ARRAY[${store}::uuid],${pinHash('1234', admin.tenantId)},true)`,
        );
      }
    });
    const keys = await generateKeyPair('RS256'),
      publicKey = await exportJWK(keys.publicKey);
    const jwks = createServer((_request, response) =>
      response.end(
        JSON.stringify({ keys: [{ ...publicKey, kid: 'dismiss-test', alg: 'RS256', use: 'sig' }] }),
      ),
    );
    jwks.listen(0, '127.0.0.1');
    await once(jwks, 'listening');
    const address = jwks.address();
    assert.ok(address && typeof address !== 'string');
    const issuer = `http://127.0.0.1:${address.port}`;
    const token = (tenantId: string, subject: string) =>
      new SignJWT({ 'custom:tenant_id': tenantId, token_use: 'id', amr: ['mfa'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'dismiss-test' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience('dismiss-client')
        .setExpirationTime('5m')
        .sign(keys.privateKey);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const probeAddress = probe.address();
    assert.ok(probeAddress && typeof probeAddress !== 'string');
    const port = probeAddress.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        REGI_DEV_AUTH: 'false',
        COGNITO_ISSUER: issuer,
        COGNITO_CLIENT_ID: 'dismiss-client',
        COGNITO_MFA_ENFORCED: 'false',
        PORT: String(port),
      },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const request = async (id: string, body: unknown, bearer?: string) => {
      const response = await fetch(`${base}/v1/sync/reviews/${id}/dismiss`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { response, body: (await response.json()) as ResponseBody };
    };
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          if ((await fetch(`${base}/health`)).ok) break;
        } catch {
          /* startup */
        }
        await delay(100);
      }
      assert.equal(
        (await business.events(admin, { events: [invalidSale(sale)] })).results[0].status,
        'review',
      );
      const input = dismissal(store),
        adminToken = await token(admin.tenantId, admin.tenantId);
      assert.equal((await request(sale.id, input)).response.status, 401);
      for (const subject of [manager, cashier])
        assert.equal(
          (await request(sale.id, input, await token(admin.tenantId, subject))).response.status,
          403,
        );
      assert.equal(
        (await request(sale.id, { ...input, reason: '  ' }, adminToken)).response.status,
        400,
      );
      assert.equal(
        (
          await request(
            sale.id,
            dismissal(foreign.store),
            await token(foreign.admin.tenantId, foreign.admin.tenantId),
          )
        ).response.status,
        404,
      );
      assert.equal((await request(randomUUID(), input, adminToken)).response.status, 404);
      const before = await database.transaction(admin, (transaction) =>
        rows<{ cursor: string }>(transaction, sql`SELECT cursor::text FROM change_heads`),
      );
      const accepted = await request(sale.id, input, adminToken);
      assert.equal(accepted.response.status, 201);
      assert.equal(accepted.body.status, 'accepted');
      assert.equal(accepted.body.resolution, 'dismissed');
      assert.deepEqual((await request(sale.id, input, adminToken)).body, accepted.body);
      const records = await database.transaction(admin, (transaction) =>
        rows<EventRow>(transaction, sql`SELECT * FROM device_events WHERE id=${sale.id}::uuid`),
      );
      assert.equal(records[0].status, 'dismissed');
      assert.equal(records[0].dismissed_by, admin.staffId);
      assert.equal(records[0].dismiss_reason, input.reason);
      const audits = await database.transaction(admin, (transaction) =>
        rows<{ actor_id: string; body: { targetId: string; reason: string } }>(
          transaction,
          sql`SELECT actor_id,body FROM audit WHERE action='review.dismiss'`,
        ),
      );
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actor_id, admin.staffId);
      assert.equal(audits[0].body.targetId, sale.id);
      assert.equal(audits[0].body.reason, input.reason);
      const changes = (await business.changes(admin, before[0].cursor)) as {
        changes: DeviceChange[];
      };
      assert.deepEqual(
        changes.changes.filter((entry) => entry.kind === 'device-event').map((entry) => entry.body),
        [{ id: sale.id, status: 'dismissed' }],
      );
      assert.equal(
        (await business.events(admin, { events: [invalidSale(sale)] })).results[0].status,
        'accepted',
      );
      await business.deviceStatus(admin, device, {
        operationId: randomUUID(),
        storeId: store,
        stopped: true,
        pending: 0,
        reviewCount: 0,
      });
      assert.equal(
        (await business.events(admin, { events: [closing(sale)] })).results[0].status,
        'accepted',
      );
      await business.dayClose(admin, {
        operationId: randomUUID(),
        storeId: store,
        day: '2026-09-30',
      });
      const stocktake = (await business.stocktake(admin, {
        operationId: randomUUID(),
        storeId: store,
      })) as { id: string };
      assert.ok(stocktake.id);
      const second = { ...invalidSale(sale), id: randomUUID(), sequence: '3' };
      assert.equal(
        (await business.events(admin, { events: [second] })).results[0].status,
        'review',
      );
      assert.equal(
        (await request(second.id, dismissal(store), await token(admin.tenantId, headquarters)))
          .response.status,
        201,
      );
    } finally {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), delay(5000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
      jwks.closeAllConnections();
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
      await database.client.$disconnect();
      await foreign.database.client.$disconnect();
    }
  },
);

void test('dismissed quarantine resolves both same-ID changed-body and same-sequence collisions without changing accepted original', async () => {
  const { database, business, admin, sale, store, device } = await syncFixture();
  try {
    await business.events(admin, { events: [sale] });
    const original = await database.transaction(admin, (transaction) =>
      rows<EventRow>(transaction, sql`SELECT * FROM device_events WHERE id=${sale.id}::uuid`),
    );
    await assert.rejects(
      business.dismissReview(admin, sale.id, dismissal(store)),
      code('REVIEW_STATE'),
    );
    const changed = { ...sale, body: { ...sale.body, tendered: '300' } },
      collision = { ...sale, id: randomUUID() };
    assert.equal(
      (await business.events(admin, { events: [changed, collision] })).results[0].status,
      'review',
    );
    for (const raw of [changed, collision]) {
      await business.dismissReview(admin, raw.id, dismissal(store));
      assert.equal((await business.events(admin, { events: [raw] })).results[0].status, 'accepted');
    }
    assert.deepEqual(
      await database.transaction(admin, (transaction) =>
        rows<EventRow>(transaction, sql`SELECT * FROM device_events WHERE id=${sale.id}::uuid`),
      ),
      original,
    );
    assert.equal((await business.list(admin, 'sale')).length, 1);
    const head = (await business.changes(admin, '0')) as { changes: DeviceChange[] };
    assert.equal(
      head.changes.filter(
        (entry) => entry.kind === 'device-event' && entry.body.status === 'dismissed',
      ).length,
      2,
    );
    const close = { ...closing(sale), body: { shiftId: sale.body.shiftId, actual: '1101' } };
    assert.equal((await business.events(admin, { events: [close] })).results[0].status, 'accepted');
    await business.deviceStatus(admin, device, {
      operationId: randomUUID(),
      storeId: store,
      stopped: true,
      pending: 0,
      reviewCount: 0,
    });
    await business.dayClose(admin, {
      operationId: randomUUID(),
      storeId: store,
      day: '2026-09-30',
    });
    const stocktake = (await business.stocktake(admin, {
      operationId: randomUUID(),
      storeId: store,
    })) as { id: string };
    assert.ok(stocktake.id);
  } finally {
    await database.client.$disconnect();
  }
});

void test('retry emits accepted device-event and cashier review reconciliation is complete and device scoped', async () => {
  const { database, business, admin, sale, store, device } = await syncFixture();
  try {
    await database.transaction(admin, (transaction) =>
      transaction.$executeRaw(
        sql`UPDATE staff SET stores=ARRAY[]::uuid[] WHERE id=${admin.staffId}::uuid`,
      ),
    );
    const review = sale;
    assert.equal((await business.events(admin, { events: [review] })).results[0].status, 'review');
    const cashier: Actor = { ...admin, role: 'cashier' };
    const listed = (await business.reviews(cashier, store, device)) as EventRow[];
    assert.deepEqual(
      listed.map((entry) => entry.id),
      [review.id],
    );
    await assert.rejects(business.reviews(cashier, store), code('ROLE_FORBIDDEN'));
    await assert.rejects(
      business.reviews(
        { ...cashier, deviceId: device, leaseId: sale.leaseId },
        store,
        randomUUID(),
      ),
      code('RECOVERY_SCOPE'),
    );
    await database.transaction(admin, (transaction) =>
      transaction.$executeRaw(
        sql`UPDATE staff SET stores=ARRAY[${store}::uuid] WHERE id=${admin.staffId}::uuid`,
      ),
    );
    await business.retryReview(admin, review.id, {
      ...dismissal(store),
      reason: '認証期間と原記録を照合し売上を受領',
    });
    assert.deepEqual(await business.reviews(cashier, store, device), []);
    const changes = (await business.changes(admin, '0')) as { changes: DeviceChange[] };
    assert.deepEqual(
      changes.changes.filter((entry) => entry.kind === 'device-event').map((entry) => entry.body),
      [{ id: review.id, status: 'accepted' }],
    );
    const waiting = {
      ...sale,
      id: randomUUID(),
      sequence: '2',
      body: { ...sale.body, shiftId: randomUUID() },
    };
    assert.equal((await business.events(admin, { events: [waiting] })).results[0].status, 'retry');
    assert.deepEqual(await business.reviews(cashier, store, device), []);
    assert.ok(
      ((await business.reviews(admin, store)) as EventRow[]).some(
        (entry) => entry.id === waiting.id && entry.status === 'waiting',
      ),
    );
    const automatic = { ...sale, id: randomUUID(), sequence: '3' };
    const original = database.transaction.bind(database);
    let failed = false;
    database.transaction = <T>(actor: Actor, callback: (transaction: Tx) => Promise<T>) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('temporary database outage'));
      }
      return original(actor, callback);
    };
    assert.equal(
      (await business.events(admin, { events: [automatic] })).results[0].status,
      'retry',
    );
    assert.equal(
      (await business.events(admin, { events: [automatic] })).results[0].status,
      'accepted',
    );
    const afterAutomatic = (await business.changes(admin, '0')) as { changes: DeviceChange[] };
    assert.deepEqual(
      afterAutomatic.changes
        .filter((entry) => entry.kind === 'device-event')
        .map((entry) => entry.body),
      [
        { id: review.id, status: 'accepted' },
        { id: automatic.id, status: 'accepted' },
      ],
    );
  } finally {
    await database.client.$disconnect();
  }
});

void test('Web opening conflict becomes durable review and dismissal aliases subsequent sale cash and close to the existing opening', async () => {
  const { database, business, admin, sale, store } = await syncFixture();
  try {
    const opening = {
      ...closing(sale, '1'),
      id: randomUUID(),
      type: 'shift.open',
      body: { opening: '2000' },
    };
    const response = await business.events(admin, { events: [opening] });
    assert.equal(response.results[0].status, 'review');
    assert.equal(response.results[0].code, 'SHIFT_OPEN_CONFLICT');
    assert.equal(response.results[0].shiftId, sale.body.shiftId);
    assert.equal(response.results[0].opening, '1000');
    await business.dismissReview(admin, opening.id, dismissal(store));
    const changes = (await business.changes(admin, '0')) as {
      changes: {
        kind: string;
        body: { id: string; status: string; shiftId?: string; opening?: string };
      }[];
    };
    assert.deepEqual(
      changes.changes.filter((entry) => entry.kind === 'device-event').map((entry) => entry.body),
      [{ id: opening.id, status: 'dismissed', shiftId: sale.body.shiftId, opening: '1000' }],
    );
    const sold = {
      ...sale,
      id: randomUUID(),
      sequence: '2',
      body: { ...sale.body, shiftId: opening.id },
    };
    const cash = {
      ...closing(sale, '3'),
      id: randomUUID(),
      type: 'cash.move',
      body: { shiftId: opening.id, amount: '50', direction: 'in', reason: '入金' },
    };
    const close = { ...closing(sale, '4'), body: { shiftId: opening.id, actual: '1151' } };
    assert.deepEqual(
      (await business.events(admin, { events: [sold, cash, close] })).results.map(
        (entry) => entry.status,
      ),
      ['accepted', 'accepted', 'accepted'],
    );
    const sales = (await business.list(admin, 'sale')) as { body: { shiftId: string } }[];
    assert.equal(sales[0].body.shiftId, sale.body.shiftId);
    const shifts = (await business.list(admin, 'shift')) as {
      id: string;
      body: { difference: string };
    }[];
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0].body.difference, '0');
    assert.deepEqual((await business.events(admin, { events: [opening] })).results[0], {
      id: opening.id,
      status: 'accepted',
      resolution: 'dismissed',
      shiftId: sale.body.shiftId,
      opening: '1000',
    });
  } finally {
    await database.client.$disconnect();
  }
});

void test('Prisma single_open_shift SQLSTATE23505 maps to review without converting unrelated unique failures', async () => {
  const { database, business, admin, sale } = await syncFixture();
  const original = database.transaction.bind(database);
  try {
    for (const constraint of [
      'single_open_shift',
      'unrelated_unique',
      'stripped_with_existing',
      'stripped_without_existing',
    ]) {
      if (constraint === 'stripped_without_existing')
        await original(admin, (transaction) =>
          transaction.$executeRaw(
            sql`UPDATE documents SET status='provisional' WHERE kind='shift'`,
          ),
        );
      let injected = false;
      database.transaction = <T>(actor: Actor, callback: (transaction: Tx) => Promise<T>) => {
        if (!injected) {
          injected = true;
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(
              `duplicate key violates unique constraint "${constraint}"`,
              {
                code: 'P2010',
                clientVersion: '6.19.0',
                meta: {
                  code: '23505',
                  message: constraint.startsWith('stripped_')
                    ? 'Unique constraint failed: '
                    : `duplicate key value violates unique constraint "${constraint}"`,
                },
              },
            ),
          );
        }
        return original(actor, callback);
      };
      const opening = {
        ...closing(sale, constraint === 'single_open_shift' ? '1' : '2'),
        id: randomUUID(),
        type: 'shift.open',
        body: { opening: '1000' },
      };
      const result = (await business.events(admin, { events: [opening] })).results[0];
      const mapped = constraint === 'single_open_shift' || constraint === 'stripped_with_existing';
      assert.equal(result.status, mapped ? 'review' : 'retry');
      assert.equal(result.code, mapped ? 'SHIFT_OPEN_CONFLICT' : 'SYNC_RETRY');
    }
  } finally {
    await database.client.$disconnect();
  }
});

void test('real Web duplicate opening converts the single_open_shift constraint to SHIFT_OPEN_CONFLICT and preserves the existing opening', async () => {
  const { database, business, admin, store, device, sale } = await syncFixture();
  try {
    await assert.rejects(
      business.openShift(admin, {
        operationId: randomUUID(),
        storeId: store,
        deviceId: device,
        opening: '2000',
        pin: '1234',
      }),
      code('SHIFT_OPEN_CONFLICT'),
    );
    const shifts = (await business.list(admin, 'shift')) as {
      id: string;
      body: { opening: string };
    }[];
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0].id, sale.body.shiftId);
    assert.equal(shifts[0].body.opening, '1000');
  } finally {
    await database.client.$disconnect();
  }
});

void test('review counts are independent of pending and unresolved checkout aggregates still block stocktake', async () => {
  const { database, business, admin, sale, store, device, product } = await syncFixture();
  try {
    await business.deviceStatus(admin, device, {
      operationId: randomUUID(),
      storeId: store,
      stopped: true,
      pending: 0,
      reviewCount: 0,
    });
    const stocktake = (await business.stocktake(admin, {
      operationId: randomUUID(),
      storeId: store,
    })) as { id: string };
    assert.equal((await business.events(admin, { events: [sale] })).results[0].status, 'review');
    await business.deviceStatus(admin, device, {
      operationId: randomUUID(),
      storeId: store,
      stopped: true,
      pending: 1,
      reviewCount: 1,
    });
    const status = await database.transaction(admin, (transaction) =>
      rows<{ pending: number; review_count: number }>(
        transaction,
        sql`SELECT pending,review_count FROM devices WHERE id=${device}::uuid`,
      ),
    );
    assert.deepEqual(status, [{ pending: 1, review_count: 1 }]);
    const input = {
      operationId: randomUUID(),
      storeId: store,
      counts: [{ productId: product, quantity: 0 }],
      reviewEventIds: [sale.id],
      reason: '実査照合',
    };
    await assert.rejects(
      business.confirmStocktake(admin, stocktake.id, input),
      code('DEVICES_NOT_QUIET'),
    );
    await business.deviceStatus(admin, device, {
      operationId: randomUUID(),
      storeId: store,
      stopped: true,
      pending: 0,
      reviewCount: 1,
    });
    await business.confirmStocktake(admin, stocktake.id, { ...input, operationId: randomUUID() });
  } finally {
    await database.client.$disconnect();
  }
});
