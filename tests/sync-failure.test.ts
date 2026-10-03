import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { Actor, Database, rows, sql, Tx } from '../apps/api/src/db';
import { BusinessError } from '../apps/api/src/errors';
import { Business } from '../apps/api/src/service';
import { syncFixture } from './sync-fixture';

interface SyncResult {
  id: string | null;
  status: 'accepted' | 'review' | 'retry';
  code?: string;
  message?: string;
}
interface StoredEvent {
  id: string;
  status: string;
  hash: string;
  result: SyncResult;
  body: unknown;
}
const actor = (): Actor => ({
  tenantId: randomUUID(),
  staffId: randomUUID(),
  stores: [randomUUID()],
  role: 'admin',
  mfa: true,
});
const envelope = () => ({
  id: randomUUID(),
  deviceId: randomUUID(),
  leaseId: randomUUID(),
  staffId: randomUUID(),
  sequence: '1',
  occurredAt: new Date().toISOString(),
  ruleVersion: 'regi-1',
  type: 'shift.open',
  body: { opening: '1000' },
});

class UnavailableDatabase extends Database {
  constructor(private readonly failure: Error) {
    super();
  }
  override transaction<T>(_actor: Actor, _callback: (transaction: Tx) => Promise<T>): Promise<T> {
    void _actor;
    void _callback;
    return Promise.reject(this.failure);
  }
}

void test('temporary database failures always keep the whole batch retryable without private messages', async () => {
  const codes = ['P1000', 'P1001', 'P1002', 'P2024', 'P2028', 'P2034'];
  const failures = [
    ...codes.map(
      (code) =>
        new Prisma.PrismaClientKnownRequestError('private connection password=secret', {
          code,
          clientVersion: '6.19.0',
        }),
    ),
    new Error('Timeout: private connection password=secret'),
    new Error('unknown private connection password=secret'),
  ];
  for (const failure of failures) {
    const database = new UnavailableDatabase(failure);
    try {
      const events = [envelope(), envelope(), envelope()];
      const response = await new Business(database).events(actor(), { events });
      assert.deepEqual(
        response.results.map((result) => result.status),
        ['retry', 'retry', 'retry'],
      );
      assert.deepEqual(
        response.results.map((result) => result.id),
        events.map((event) => event.id),
      );
      assert.ok(
        response.results.every(
          (result) => !result.message?.includes('private') && !result.message?.includes('password'),
        ),
      );
    } finally {
      await database.client.$disconnect();
    }
  }
});

void test('real PostgreSQL transient failures persist waiting, stop subsequent sales and accept after replay once', async () => {
  const fixture = await syncFixture(),
    { database, business, admin, sale } = fixture;
  const original = database.transaction.bind(database);
  let injected = true,
    saleAttempts = 0;
  const realSale = business.sale.bind(business);
  business.sale = (...args) => {
    saleAttempts++;
    return realSale(...args);
  };
  database.transaction = async <T>(
    requestActor: Actor,
    callback: (transaction: Tx) => Promise<T>,
  ) => {
    if (injected) {
      injected = false;
      throw new Prisma.PrismaClientKnownRequestError('private P2024 detail', {
        code: 'P2024',
        clientVersion: '6.19.0',
      });
    }
    return original(requestActor, callback);
  };
  const second = { ...sale, id: randomUUID(), sequence: '2' };
  try {
    const response = await business.events(admin, { events: [sale, second] });
    assert.deepEqual(
      response.results.map((result) => result.status),
      ['retry', 'retry'],
    );
    assert.equal(saleAttempts, 0);
    const waiting = await original(admin, (transaction) =>
      rows<StoredEvent>(transaction, sql`SELECT * FROM device_events ORDER BY sequence`),
    );
    assert.deepEqual(
      waiting.map((event) => event.status),
      ['waiting', 'waiting'],
    );
    assert.deepEqual(
      waiting.map((event) => event.body),
      [sale, second],
    );
    const accepted = await business.events(admin, { events: [sale, second] });
    assert.ok(accepted.results.every((result) => result.status === 'accepted'));
    assert.deepEqual(await business.events(admin, { events: [sale, second] }), accepted);
    const count = await original(admin, (transaction) =>
      rows<{ count: number }>(
        transaction,
        sql`SELECT count(*)::int AS count FROM documents WHERE kind='sale'`,
      ),
    );
    assert.equal(count[0].count, 2);
  } finally {
    await database.client.$disconnect();
  }
});

void test('real PostgreSQL accepted insert failure rolls back every monetary effect before durable waiting and one replay', async () => {
  const { database, business, admin, sale } = await syncFixture();
  const original = database.transaction.bind(database);
  const snapshot = () =>
    original(admin, (transaction) =>
      rows<{ sales: number; inventory: number; audits: number; cursor: string }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM documents WHERE kind='sale') AS sales,(SELECT count(*)::int FROM inventory) AS inventory,(SELECT count(*)::int FROM audit) AS audits,(SELECT cursor::text FROM change_heads) AS cursor`,
      ),
    );
  const before = await snapshot();
  let failed = false;
  database.transaction = <T>(requestActor: Actor, callback: (transaction: Tx) => Promise<T>) =>
    original(requestActor, (transaction) => {
      const decorated = new Proxy(transaction, {
        get(target, property, receiver): unknown {
          if (property === '$executeRaw')
            return (query: Prisma.Sql) => {
              if (
                !failed &&
                /INSERT INTO device_events/.test(query.sql) &&
                query.sql.includes("'accepted'")
              ) {
                failed = true;
                return Promise.reject(
                  new Prisma.PrismaClientKnownRequestError(
                    'private serialization failure after monetary writes',
                    { code: 'P2034', clientVersion: '6.19.0' },
                  ),
                );
              }
              return target.$executeRaw(query);
            };
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      return callback(decorated);
    });
  try {
    assert.equal((await business.events(admin, { events: [sale] })).results[0].status, 'retry');
    assert.deepEqual(await snapshot(), before);
    const waiting = await original(admin, (transaction) =>
      rows<StoredEvent>(transaction, sql`SELECT * FROM device_events WHERE id=${sale.id}::uuid`),
    );
    assert.equal(waiting[0].status, 'waiting');
    assert.deepEqual(waiting[0].body, sale);
    const accepted = await business.events(admin, { events: [sale] });
    assert.equal(accepted.results[0].status, 'accepted');
    assert.deepEqual(await business.events(admin, { events: [sale] }), accepted);
    const [after] = await snapshot();
    assert.equal(after.sales, 1);
    assert.equal(after.inventory, 1);
    assert.equal(after.audits, before[0].audits);
  } finally {
    await database.client.$disconnect();
  }
});

void test('real PostgreSQL review store failure returns SYNC_STORE_FAILED and preserves the remaining batch', async () => {
  const { database, business, admin, sale } = await syncFixture();
  const original = database.transaction.bind(database);
  let failed = false;
  database.transaction = <T>(requestActor: Actor, callback: (transaction: Tx) => Promise<T>) =>
    original(requestActor, (transaction) => {
      const decorated = new Proxy(transaction, {
        get(target, property, receiver): unknown {
          if (property === '$executeRaw')
            return (query: Prisma.Sql) => {
              if (!failed && /INSERT INTO device_events/.test(query.sql)) {
                failed = true;
                return Promise.reject(new Error('private store failure'));
              }
              return target.$executeRaw(query);
            };
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      return callback(decorated);
    });
  try {
    const invalid = { ...sale, body: { ...sale.body, total: '999' } },
      next = { ...sale, id: randomUUID(), sequence: '2' };
    const response = await business.events(admin, { events: [invalid, next] });
    assert.equal(response.results[0].status, 'retry');
    assert.equal(response.results[0].code, 'SYNC_STORE_FAILED');
    assert.equal(response.results[1].status, 'retry');
    assert.ok(!JSON.stringify(response).includes('private'));
    assert.equal((await business.list(admin, 'sale')).length, 0);
    assert.equal((await business.events(admin, { events: [invalid] })).results[0].status, 'review');
    assert.ok(
      ((await business.reviews(admin, admin.stores[0])) as StoredEvent[]).some(
        (record) => record.id === invalid.id,
      ),
    );
  } finally {
    await database.client.$disconnect();
  }
});

void test('real PostgreSQL dependency and sequence conflicts are durable and protect accepted original content', async () => {
  const { database, business, admin, sale, store } = await syncFixture();
  try {
    const missingShift = {
      ...sale,
      id: randomUUID(),
      sequence: '2',
      body: { ...sale.body, shiftId: randomUUID() },
    };
    const dependency = await business.events(admin, { events: [missingShift] });
    assert.equal(dependency.results[0].status, 'retry');
    const waiting = await database.transaction(admin, (transaction) =>
      rows<StoredEvent>(
        transaction,
        sql`SELECT * FROM device_events WHERE id=${missingShift.id}::uuid`,
      ),
    );
    assert.equal(waiting[0].status, 'waiting');
    const accepted = await business.events(admin, { events: [sale] });
    assert.equal(accepted.results[0].status, 'accepted');
    const collision = { ...sale, id: randomUUID() },
      conflict = await business.events(admin, { events: [collision] });
    assert.equal(conflict.results[0].status, 'retry');
    assert.equal(conflict.results[0].code, 'SEQUENCE_CONFLICT');
    const quarantined = await database.transaction(admin, (transaction) =>
      rows<StoredEvent>(
        transaction,
        sql`SELECT * FROM device_event_quarantine WHERE id=${collision.id}::uuid`,
      ),
    );
    assert.equal(quarantined[0].status, 'waiting');
    assert.deepEqual(quarantined[0].body, collision);
    assert.deepEqual(await business.events(admin, { events: [sale] }), accepted);
    const changed = { ...sale, body: { ...sale.body, tendered: '300' } };
    assert.equal(
      (await business.events(admin, { events: [changed] })).results[0].code,
      'IDEMPOTENCY_CONFLICT',
    );
    assert.deepEqual(await business.events(admin, { events: [sale] }), accepted);
    assert.equal((await business.list(admin, 'sale', store)).length, 1);
  } finally {
    await database.client.$disconnect();
  }
});

void test('real PostgreSQL recovery credentials cannot persist events from another device and malformed envelopes never return unstored review', async () => {
  const { database, business, admin, sale, store } = await syncFixture();
  try {
    const other = (await business.enroll(admin, {
      operationId: randomUUID(),
      storeId: store,
      name: '別端末',
    })) as { id: string };
    const recovery: Actor = {
      ...admin,
      deviceId: sale.deviceId,
      leaseId: sale.leaseId,
      role: 'cashier',
    };
    const foreign = { ...sale, id: randomUUID(), deviceId: other.id },
      response = await business.events(recovery, { events: [foreign] });
    assert.equal(response.results[0].status, 'retry');
    const captured = await database.transaction(admin, (transaction) =>
      rows<{ count: number }>(
        transaction,
        sql`SELECT (SELECT count(*) FROM device_events WHERE id=${foreign.id}::uuid)+(SELECT count(*) FROM device_event_quarantine WHERE id=${foreign.id}::uuid) AS count`,
      ),
    );
    assert.equal(Number(captured[0].count), 0);
    for (const invalid of [
      null,
      { ...sale, id: 'invalid' },
      { ...sale, deviceId: 'invalid' },
      { ...sale, sequence: '99999999999999999999999999999' },
    ]) {
      const result = await business.events(admin, { events: [invalid] });
      assert.equal(result.results[0].status, 'retry');
      assert.equal(result.results[0].code, 'SYNC_STORE_FAILED');
    }
  } finally {
    await database.client.$disconnect();
  }
});

void test('real PostgreSQL batch cutoff keeps existing quarantined reviews retryable and unchanged', async () => {
  const { database, business, admin, sale } = await syncFixture();
  const original = database.transaction.bind(database);
  try {
    assert.equal((await business.events(admin, { events: [sale] })).results[0].status, 'accepted');
    const changed = { ...sale, body: { ...sale.body, tendered: '300' } };
    assert.equal((await business.events(admin, { events: [changed] })).results[0].status, 'review');
    const snapshot = await original(admin, (transaction) =>
      rows<StoredEvent>(
        transaction,
        sql`SELECT * FROM device_event_quarantine WHERE id=${sale.id}::uuid`,
      ),
    );
    let failed = false;
    database.transaction = <T>(requestActor: Actor, callback: (transaction: Tx) => Promise<T>) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('private unexpected failure'));
      }
      return original(requestActor, callback);
    };
    const next = { ...sale, id: randomUUID(), sequence: '2' };
    const response = await business.events(admin, { events: [next, changed] });
    assert.deepEqual(
      response.results.map((result) => result.status),
      ['retry', 'retry'],
    );
    assert.deepEqual(
      await original(admin, (transaction) =>
        rows<StoredEvent>(
          transaction,
          sql`SELECT * FROM device_event_quarantine WHERE id=${sale.id}::uuid`,
        ),
      ),
      snapshot,
    );
  } finally {
    await database.client.$disconnect();
  }
});

for (const storage of ['device_events', 'device_event_quarantine']) {
  for (const operation of ['stocktake', 'dayClose']) {
    void test(`real PostgreSQL waiting state blocks ${operation} when stored in ${storage}`, async () => {
      const { database, business, admin, sale, store, device } = await syncFixture();
      try {
        let waitingEvent;
        if (storage === 'device_event_quarantine') {
          assert.equal(
            (await business.events(admin, { events: [sale] })).results[0].status,
            'accepted',
          );
          waitingEvent = { ...sale, id: randomUUID() };
        } else {
          waitingEvent = { ...sale, body: { ...sale.body, shiftId: randomUUID() } };
        }
        assert.equal(
          (await business.events(admin, { events: [waitingEvent] })).results[0].status,
          'retry',
        );
        await business.deviceStatus(admin, device, {
          operationId: randomUUID(),
          storeId: store,
          stopped: true,
          pending: 0,
        });
        await database.transaction(admin, async (transaction) => {
          await transaction.$executeRaw(
            sql`UPDATE documents SET status='closed' WHERE kind='shift'`,
          );
        });
        const input = { operationId: randomUUID(), storeId: store, day: '2026-09-30' };
        await assert.rejects(
          operation === 'stocktake'
            ? business.stocktake(admin, input)
            : business.dayClose(admin, input),
          (error: unknown) => error instanceof BusinessError && error.code === 'REVIEW_PENDING',
        );
      } finally {
        await database.client.$disconnect();
      }
    });
  }
}

void test('real PostgreSQL waiting event cannot be acknowledged into a completed stocktake', async () => {
  const { database, business, admin, sale, store, device, product } = await syncFixture();
  try {
    await business.deviceStatus(admin, device, {
      operationId: randomUUID(),
      storeId: store,
      stopped: true,
      pending: 0,
    });
    const stocktake = (await business.stocktake(admin, {
      operationId: randomUUID(),
      storeId: store,
    })) as { id: string };
    const waitingEvent = {
      ...envelope(),
      deviceId: device,
      leaseId: sale.leaseId,
      staffId: admin.staffId,
      type: 'shift.close',
      body: { shiftId: randomUUID(), actual: '0' },
    };
    assert.equal(
      (await business.events(admin, { events: [waitingEvent] })).results[0].status,
      'retry',
    );
    await assert.rejects(
      business.confirmStocktake(admin, stocktake.id, {
        operationId: randomUUID(),
        storeId: store,
        counts: [{ productId: product, quantity: 0 }],
        reviewEventIds: [waitingEvent.id],
        reason: '待機イベントを承認しても未完了のまま',
      }),
      (error: unknown) => error instanceof BusinessError && error.code === 'SYNC_PENDING',
    );
  } finally {
    await database.client.$disconnect();
  }
});

void test(
  'real PostgreSQL advisory lock held longer than thirty seconds induces P2028 without reviewing or losing sales',
  { timeout: 55000 },
  async () => {
    const { database, business, admin, sale } = await syncFixture();
    const lock = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await lock.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [admin.tenantId]);
    const original = database.transaction.bind(database),
      observed: unknown[] = [];
    database.transaction = async <T>(
      requestActor: Actor,
      callback: (transaction: Tx) => Promise<T>,
    ) => {
      try {
        return await original(requestActor, callback);
      } catch (error) {
        observed.push(error);
        throw error;
      }
    };
    const release = setTimeout(() => {
      void lock.query('COMMIT').catch((error) => observed.push(error));
    }, 31500);
    try {
      const result = await business.events(admin, { events: [sale] });
      assert.ok(
        observed.some(
          (error) =>
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028',
        ),
      );
      assert.equal(result.results[0].status, 'retry');
      const stored = await original(admin, (transaction) =>
        rows<StoredEvent>(transaction, sql`SELECT * FROM device_events WHERE id=${sale.id}::uuid`),
      );
      assert.equal(stored[0].status, 'waiting');
      assert.equal(
        (await business.events(admin, { events: [sale] })).results[0].status,
        'accepted',
      );
      assert.equal((await business.list(admin, 'sale')).length, 1);
    } finally {
      clearTimeout(release);
      await lock.query('ROLLBACK');
      await lock.end();
      await database.client.$disconnect();
    }
  },
);
