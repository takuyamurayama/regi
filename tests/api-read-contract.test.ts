import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { rows, sql } from '../apps/api/src/db';
import { pinHash } from '../apps/api/src/service';
import { AuthenticatedActorSchema } from '../packages/core/src/finance';
import { apiFixture } from './api-fixture';
import { syncFixture } from './sync-fixture';

void test('HTTP settings actor reflects authenticated staff and role instead of client supplied role or staff fields', async () => {
  const fixture = await syncFixture();
  const api = await apiFixture();
  const cashier = randomUUID();
  await fixture.database.transaction(fixture.admin, (transaction) =>
    transaction.$executeRaw(
      sql`INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash,active) VALUES(${cashier}::uuid,${fixture.admin.tenantId}::uuid,${cashier},'読み取り契約試験','cashier',ARRAY[${fixture.store}::uuid],${pinHash('1234', cashier)},true)`,
    ),
  );
  try {
    for (const [subject, staffId, role] of [
      [fixture.admin.tenantId, fixture.admin.staffId, 'admin'],
      [cashier, cashier, 'cashier'],
    ]) {
      const response = await fetch(
        api.base + '/v1/settings?role=admin&staffId=' + fixture.admin.staffId,
        { headers: { 'x-tenant-id': fixture.admin.tenantId, 'x-staff-subject': subject } },
      );
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null && 'actor' in body);
      assert.deepEqual(AuthenticatedActorSchema.parse(body.actor), { staffId, role });
    }
  } finally {
    await api.close();
    await fixture.database.client.$disconnect();
  }
});

void test('HTTP document lists reject empty or malformed store UUID with nonretryable 400 while omitted headquarters scope stays valid', async () => {
  const fixture = await syncFixture();
  const api = await apiFixture();
  const headers = {
    'x-tenant-id': fixture.admin.tenantId,
    'x-staff-subject': fixture.admin.tenantId,
  };
  try {
    for (const value of ['', 'not-a-uuid', 'all', 'null']) {
      const response = await fetch(api.base + '/v1/documents/receipt?storeId=' + value, {
        headers,
      });
      assert.equal(response.status, 400, 'storeId=' + value);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null && 'retryable' in body);
      assert.equal(body.retryable, false);
    }
    const response = await fetch(api.base + '/v1/documents/receipt', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    const [facts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ operations: number }>(
        transaction,
        sql`SELECT count(*)::int AS operations FROM operations WHERE store_id=${fixture.store}::uuid`,
      ),
    );
    assert.equal(facts.operations, 1);
  } finally {
    await api.close();
    await fixture.database.client.$disconnect();
  }
});
