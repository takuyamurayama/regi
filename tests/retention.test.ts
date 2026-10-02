import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {retireTenant} from '../scripts/retention';
test('retention dry run, expiry guard and owner deletion preserve RLS and immutable triggers',async()=>{
 const url=process.env.MAINTENANCE_TEST_DATABASE_URL;if(!url)throw new Error('MAINTENANCE_TEST_DATABASE_URL must point to local schema owner');
 assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname));
 const owner=new PrismaClient({datasourceUrl:url}),tenantId=randomUUID();
 try{
  await owner.$transaction(async transaction=>{await transaction.$executeRaw`SELECT set_config('regi.tenant',${tenantId},true)`;await transaction.$executeRaw`INSERT INTO tenants VALUES(${tenantId}::uuid,'終了試験','inclusive',now()-interval '2 years',now()-interval '91 days',1)`;});
  const dry=await retireTenant(owner,tenantId);assert.equal(dry.mode,'dry-run');assert.equal(dry.counts.tenants,1);
  const result=await retireTenant(owner,tenantId,true);assert.equal(result.mode,'deleted');
  const security=await owner.$queryRaw<any[]>`SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('tenants','documents','inventory','audit')`;assert.ok(security.every(record=>record.relforcerowsecurity));
  const triggers=await owner.$queryRaw<any[]>`SELECT tgenabled FROM pg_trigger WHERE tgname IN ('inventory_immutable','audit_immutable','sales_immutable')`;assert.ok(triggers.every(record=>record.tgenabled==='O'));
  await assert.rejects(()=>retireTenant(owner,'10000000-0000-4000-8000-000000000001',true),/90 days/);
 }finally{await owner.$disconnect();}
});
