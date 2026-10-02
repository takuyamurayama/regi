import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Administration } from '../apps/api/src/admin';
import { rows, sql } from '../apps/api/src/db';
import { BusinessError } from '../apps/api/src/errors';
import { digest, pinHash } from '../apps/api/src/service';
import { syncFixture } from './sync-fixture';

type Fixture = Awaited<ReturnType<typeof syncFixture>>;
interface StaffResult {
  id: string;
  name: string;
  role: string;
  stores: string[];
}
interface OperationRow {
  hash: string;
  result: Record<string, unknown>;
  audit: { pin: string };
  audit_count: number;
}
const rejected = (expected: string) => (error: unknown) =>
  error instanceof BusinessError && error.code === expected;
const staffInput = (store: string) => ({
  operationId: randomUUID(),
  name: 'PIN冪等試験担当者',
  subject: randomUUID(),
  role: 'cashier',
  stores: [store],
  pin: '1234',
  metadata: { pin: '業務タグ' },
});
async function operation(fixture: Fixture, id: string) {
  const [record] = await fixture.database.transaction(fixture.admin, (transaction) =>
    rows<OperationRow>(
      transaction,
      sql`SELECT o.hash,o.result,(SELECT body FROM audit WHERE entity_id=o.id) AS audit,(SELECT count(*)::int FROM audit WHERE entity_id=o.id) AS audit_count FROM operations o WHERE id=${id}::uuid`,
    ),
  );
  return record;
}

void test('staff mutation excludes only top-level PIN from idempotency hash while preserving original PIN verification and audit redaction', async () => {
  const fixture = await syncFixture();
  const administration = new Administration(fixture.business);
  try {
    const input = staffInput(fixture.store),
      beforeInput = structuredClone(input);
    const original: unknown = await administration.execute(fixture.admin, 'staff', input),
      result = original as StaffResult;
    const [created] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ pin_hash: string }>(
        transaction,
        sql`SELECT pin_hash FROM staff WHERE id=${result.id}::uuid`,
      ),
    );
    assert.equal(created.pin_hash, pinHash(input.pin, created.pin_hash.split(':')[0]));
    const saved = await operation(fixture, input.operationId);
    const replay: unknown = await administration.execute(fixture.admin, 'staff', {
      ...input,
      pin: '5678',
    });
    assert.deepEqual(replay, original);
    assert.deepEqual(input, beforeInput);
    const withoutPin = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'pin'));
    assert.equal(saved.hash, digest({ action: 'admin.staff', input: withoutPin }));
    assert.equal(saved.audit.pin, '[redacted]');
    assert.equal(saved.audit_count, 1);
    assert.equal('pin' in saved.result, false);
    assert.deepEqual(await operation(fixture, input.operationId), saved);
    const [counts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ staff: number; pin_hash: string; operations: number }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM staff WHERE subject=${input.subject}) AS staff,(SELECT pin_hash FROM staff WHERE id=${result.id}::uuid) AS pin_hash,(SELECT count(*)::int FROM operations WHERE id=${input.operationId}::uuid) AS operations`,
      ),
    );
    assert.deepEqual(counts, { staff: 1, pin_hash: created.pin_hash, operations: 1 });
    for (const changed of [
      { ...input, name: '別の業務名' },
      { ...input, role: 'manager' },
      { ...input, stores: [randomUUID()] },
      { ...input, metadata: { pin: '変更された業務タグ' } },
    ])
      await assert.rejects(
        () => administration.execute(fixture.admin, 'staff', changed),
        rejected('IDEMPOTENCY_CONFLICT'),
      );
    assert.deepEqual(await operation(fixture, input.operationId), saved);
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('fresh shift opening still rejects a wrong PIN and stores a PIN-free operation hash after correct authentication', async () => {
  const fixture = await syncFixture();
  try {
    const device = randomUUID();
    await fixture.database.transaction(fixture.admin, (transaction) =>
      transaction.$executeRaw(
        sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${fixture.admin.tenantId}::uuid,${fixture.store}::uuid,'PIN認証試験端末')`,
      ),
    );
    const input = {
      operationId: randomUUID(),
      storeId: fixture.store,
      deviceId: device,
      opening: '1000',
      pin: '5678',
    };
    await assert.rejects(
      () => fixture.business.openShift(fixture.admin, input),
      (error: unknown) =>
        error instanceof BusinessError && error.code === 'PIN_INVALID' && error.status === 401,
    );
    const [rejectedFacts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ shifts: number; operations: number; audit: number }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM documents WHERE kind='shift' AND body->>'deviceId'=${device}) AS shifts,(SELECT count(*)::int FROM operations WHERE id=${input.operationId}::uuid) AS operations,(SELECT count(*)::int FROM audit WHERE entity_id=${input.operationId}::uuid) AS audit`,
      ),
    );
    assert.deepEqual(rejectedFacts, { shifts: 0, operations: 0, audit: 0 });
    const valid = { ...input, pin: '1234' },
      original: unknown = await fixture.business.openShift(fixture.admin, valid),
      record = await operation(fixture, input.operationId);
    const withoutPin = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'pin'));
    assert.equal(record.hash, digest({ action: 'shift.open', input: withoutPin }));
    assert.equal(record.audit.pin, '[redacted]');
    assert.equal(valid.pin, '1234');
    assert.deepEqual(await fixture.business.openShift(fixture.admin, valid), original);
    assert.deepEqual(await operation(fixture, input.operationId), record);
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('legacy staff and redacted shift PIN hashes fail closed without rewriting history or reexecuting business actions', async () => {
  const fixture = await syncFixture();
  const administration = new Administration(fixture.business);
  try {
    const input = staffInput(fixture.store),
      created: unknown = await administration.execute(fixture.admin, 'staff', input),
      staff = created as StaffResult;
    const legacyStaff = digest({ action: 'admin.staff', input });
    await fixture.database.transaction(fixture.admin, (transaction) =>
      transaction.$executeRaw(
        sql`UPDATE operations SET hash=${legacyStaff} WHERE id=${input.operationId}::uuid`,
      ),
    );
    const before = await operation(fixture, input.operationId);
    await assert.rejects(
      () => administration.execute(fixture.admin, 'staff', input),
      rejected('IDEMPOTENCY_CONFLICT'),
    );
    assert.deepEqual(await operation(fixture, input.operationId), before);
    const [credential] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ id: string; pin_hash: string }>(
        transaction,
        sql`SELECT id,pin_hash FROM staff WHERE subject=${input.subject}`,
      ),
    );
    assert.equal(credential.id, staff.id);
    assert.equal(credential.pin_hash, pinHash('1234', credential.pin_hash.split(':')[0]));

    const device = randomUUID();
    await fixture.database.transaction(fixture.admin, (transaction) =>
      transaction.$executeRaw(
        sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${fixture.admin.tenantId}::uuid,${fixture.store}::uuid,'旧hash試験端末')`,
      ),
    );
    const opening = {
      operationId: randomUUID(),
      storeId: fixture.store,
      deviceId: device,
      opening: '1000',
      pin: '1234',
    };
    const opened: unknown = await fixture.business.openShift(fixture.admin, opening);
    const legacyOpening = digest({
      action: 'shift.open',
      input: { ...opening, pin: '[redacted]' },
    });
    await fixture.database.transaction(fixture.admin, (transaction) =>
      transaction.$executeRaw(
        sql`UPDATE operations SET hash=${legacyOpening} WHERE id=${opening.operationId}::uuid`,
      ),
    );
    const previous = await operation(fixture, opening.operationId);
    await assert.rejects(
      () => fixture.business.openShift(fixture.admin, opening),
      rejected('IDEMPOTENCY_CONFLICT'),
    );
    assert.deepEqual(await operation(fixture, opening.operationId), previous);
    const [shift] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ count: number; body: unknown; status: string }>(
        transaction,
        sql`SELECT count(*) OVER()::int AS count,body,status FROM documents WHERE kind='shift' AND body->>'deviceId'=${device}`,
      ),
    );
    assert.equal(shift.count, 1);
    assert.equal(shift.status, 'open');
    assert.deepEqual(shift.body, (opened as { body: unknown }).body);
  } finally {
    await fixture.database.client.$disconnect();
  }
});
