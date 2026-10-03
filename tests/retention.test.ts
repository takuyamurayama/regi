import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { retireTenant } from '../scripts/retention';
test('retention dry run, expiry guard and owner deletion preserve RLS and immutable triggers', async () => {
  const url = process.env.MAINTENANCE_TEST_DATABASE_URL;
  if (!url) throw new Error('MAINTENANCE_TEST_DATABASE_URL must point to local schema owner');
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
  const owner = new PrismaClient({ datasourceUrl: url }),
    tenantId = randomUUID(),
    storeId = randomUUID(),
    deviceId = randomUUID(),
    eventId = randomUUID();
  try {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('regi.tenant',${tenantId},true),set_config('regi.all_stores','true',true)`;
      await transaction.$executeRaw`INSERT INTO tenants VALUES(${tenantId}::uuid,'終了試験','inclusive',now()-interval '2 years',now()-interval '91 days',1)`;
      await transaction.$executeRaw`INSERT INTO stores(id,tenant_id,name) VALUES(${storeId}::uuid,${tenantId}::uuid,'終了店舗')`;
      await transaction.$executeRaw`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${deviceId}::uuid,${tenantId}::uuid,${storeId}::uuid,'終了端末')`;
      await transaction.$executeRaw`INSERT INTO device_event_quarantine(tenant_id,id,store_id,device_id,sequence,hash,status,result,body) VALUES(${tenantId}::uuid,${eventId}::uuid,${storeId}::uuid,${deviceId}::uuid,1,'retention-fixture','waiting','{"code":"SYNC_SEQUENCE_CONFLICT"}'::jsonb,'{"type":"sale.confirm"}'::jsonb)`;
    });
    const dry = await retireTenant(owner, tenantId);
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.counts.tenants, 1);
    assert.equal(dry.counts.stores, 1);
    assert.equal(dry.counts.devices, 1);
    assert.equal(dry.counts.device_event_quarantine, 1);
    const result = await retireTenant(owner, tenantId, true);
    assert.equal(result.mode, 'deleted');
    const remaining = await owner.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('regi.tenant',${tenantId},true),set_config('regi.all_stores','true',true)`;
      return transaction.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM device_event_quarantine WHERE tenant_id=${tenantId}::uuid`;
    });
    assert.equal(remaining[0].count, 0);
    const security = await owner.$queryRaw<
      { relforcerowsecurity: boolean }[]
    >`SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('tenants','documents','inventory','audit','device_event_quarantine')`;
    assert.equal(security.length, 5);
    assert.ok(security.every((record) => record.relforcerowsecurity));
    const triggers = await owner.$queryRaw<
      { tgenabled: string }[]
    >`SELECT tgenabled FROM pg_trigger WHERE tgname IN ('inventory_immutable','audit_immutable','sales_immutable')`;
    assert.ok(triggers.every((record) => record.tgenabled === 'O'));
    await assert.rejects(
      () => retireTenant(owner, '10000000-0000-4000-8000-000000000001', true),
      /90 days/,
    );
  } finally {
    await owner.$disconnect();
  }
});
