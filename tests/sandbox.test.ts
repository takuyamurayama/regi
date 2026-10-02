import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {Actor,Database,rows,sql} from '../apps/api/src/db';
import {Business,pinHash} from '../apps/api/src/service';
import {businessDate,calculate} from '../packages/core/src';
import {DEMO_DAYS,DemoConfig,demoId,demoConfigFromEnvironment,seedSandbox,validateDemoConfig} from '../scripts/sandbox-seed';

const originalUrl=process.env.DATABASE_URL??'',url=new URL(originalUrl);
assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Sandbox regression must use local PostgreSQL, never AWS');
const name='regi_demo_test_'+randomUUID().replaceAll('-',''),ownerUrl=new URL(process.env.MIGRATION_DATABASE_URL??originalUrl),appUrl=new URL(originalUrl);
ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
const adminUrl=new URL(process.env.SANDBOX_TEST_ADMIN_DATABASE_URL??originalUrl);
assert.ok(['127.0.0.1','localhost'].includes(adminUrl.hostname));
if(!process.env.SANDBOX_TEST_ADMIN_DATABASE_URL){adminUrl.username='postgres';adminUrl.password='';adminUrl.pathname='/postgres';}
const owner=new PrismaClient({datasourceUrl:adminUrl.toString()}),tenantId=randomUUID(),adminSubject='18d5ac1f-4b28-70b6-65d0-94af2d71820a';
const config:DemoConfig={tenantId,confirmTenant:tenantId,adminSubject,adminPin:String(randomInt(200000,999999)),endDay:businessDate(new Date(Date.now()-86400000).toISOString()),optIn:'synthetic-only'};
const actor:Actor={tenantId,staffId:demoId(tenantId,'admin'),role:'admin',stores:[demoId(tenantId,'store:0'),demoId(tenantId,'store:1')],mfa:true};
let database:Database;
before(async()=>{
 await owner.$executeRawUnsafe(`CREATE DATABASE ${name} OWNER regi_owner`);
 execFileSync('npx',['tsx','scripts/migrate.ts'],{stdio:'pipe',env:{...process.env,NODE_ENV:'test',DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:ownerUrl.toString()}});
 process.env.DATABASE_URL=appUrl.toString();database=new Database();
});
after(async()=>{
 await database?.client.$disconnect();process.env.DATABASE_URL=originalUrl;
 await owner.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await owner.$disconnect();
});

test('sandbox opt-in, subject, tenant confirmation and private PIN file are mandatory',()=>{
 assert.throws(()=>validateDemoConfig({...config,optIn:''}));
 assert.throws(()=>validateDemoConfig({...config,confirmTenant:randomUUID()}));
 assert.throws(()=>validateDemoConfig({...config,adminSubject:'local-admin'}));
 assert.equal(validateDemoConfig(config).adminSubject,adminSubject);
 assert.throws(()=>validateDemoConfig({...config,adminPin:'1234'}));
 assert.throws(()=>validateDemoConfig({...config,endDay:businessDate(new Date().toISOString())}));
 mkdirSync('.context/verification',{recursive:true});const path=`.context/verification/${tenantId}.pin`;
 writeFileSync(path,config.adminPin,{mode:0o600});
 const environment={REGI_SANDBOX_ADMIN_PIN_FILE:path,REGI_SANDBOX_TENANT_ID:tenantId,REGI_SANDBOX_CONFIRM_TENANT:tenantId,REGI_SANDBOX_ADMIN_SUBJECT:adminSubject,REGI_SANDBOX_END_DAY:config.endDay,REGI_SANDBOX_SEED:'synthetic-only'};
 assert.deepEqual(demoConfigFromEnvironment(environment),config);chmodSync(path,0o644);
 assert.throws(()=>demoConfigFromEnvironment(environment),/PRIVATE/);chmodSync(path,0o600);
});
test('synthetic seed resumes after interruption and creates complete authentic business facts',async()=>{
 await assert.rejects(()=>seedSandbox(database,config,completed=>{if(completed===1)throw new Error('SIMULATED_INTERRUPTION');}),/SIMULATED_INTERRUPTION/);
 const result=await seedSandbox(database,config);assert.equal(result.synthetic,true);assert.equal(result.days,84);assert.equal(result.counts.products,8);assert.equal(result.counts.events,840);
 const count=(kind:string,status:string)=>result.counts.documents.find(entry=>entry.kind===kind&&entry.status===status)?.count;
 assert.equal(count('sale','confirmed'),504);assert.equal(count('day-close','confirmed'),168);assert.equal(count('shift','provisional'),168);
 assert.equal(count('supplier','active'),2);assert.equal(count('purchase-order','draft'),2);assert.equal(count('purchase-order','partial'),2);assert.equal(count('purchase-order','received'),2);
 assert.equal(count('receipt','confirmed'),4);assert.equal(count('refund','confirmed'),2);assert.equal(count('refund','pending'),2);
 await database.transaction(actor,async transaction=>{
  const [role]=await rows(transaction,sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  const sales=await rows(transaction,sql`SELECT body FROM documents WHERE kind='sale'`);
  for(const {body} of sales){
   assert.equal(calculate(body.lines,body.discount,body.mode).total,body.total);
   assert.equal(body.lines.reduce((sum:bigint,line:any)=>sum+BigInt(line.paid),0n).toString(),body.total);
   for(const line of body.lines)assert.equal(line.unitRefunds.reduce((sum:bigint,value:string)=>sum+BigInt(value),0n).toString(),line.paid);
   assert.ok(body.receipt.sellerName.includes('デモ'));assert.equal(body.receipt.registered,false);assert.ok(body.reference.includes('SYNTHETIC'));
  }
  const prices=await rows(transaction,sql`SELECT * FROM prices`);assert.equal(prices.length,16);
  const shifts=await rows(transaction,sql`SELECT body FROM documents WHERE kind='shift'`);assert.ok(shifts.every(entry=>entry.body.difference==='0'));
  const [untracked]=await rows(transaction,sql`SELECT count(*)::int AS count FROM inventory WHERE product_id=${demoId(tenantId,'product:7')}::uuid`);assert.equal(untracked.count,0);
  const [refund]=await rows(transaction,sql`SELECT body FROM documents WHERE kind='refund' AND status='confirmed' LIMIT 1`);
  const [original]=await rows(transaction,sql`SELECT body FROM documents WHERE id=${refund.body.saleId}::uuid`);
  assert.equal(refund.body.total,refund.body.lines.reduce((sum:bigint,line:any)=>sum+BigInt(original.body.lines[line.index].unitRefunds[0]),0n).toString());
 });
 const balances=await new Business(database).inventory(actor,actor.stores[0]);
 assert.equal(Number(balances.find(row=>row.product_id===demoId(tenantId,'product:0')).quantity),13);
 assert.equal(Number(balances.find(row=>row.product_id===demoId(tenantId,'product:1')).quantity),30);
 assert.equal(Number(balances.find(row=>row.product_id===demoId(tenantId,'product:3')).quantity),46);
});
test('parallel reruns preserve every fact, cursor and count without duplicating sales or stock',async()=>{
 const snapshot=()=>database.transaction(actor,transaction=>rows(transaction,sql`SELECT (SELECT count(*) FROM documents)::text AS documents,(SELECT count(*) FROM inventory)::text AS inventory,(SELECT count(*) FROM audit)::text AS audits,(SELECT cursor FROM change_heads)::text AS cursor`));
 const before=await snapshot();await Promise.all([seedSandbox(database,config),seedSandbox(database,config)]);assert.deepEqual(await snapshot(),before);
 await assert.rejects(()=>seedSandbox(database,{...config,endDay:businessDate(new Date(Date.now()-2*86400000).toISOString())}),/CONFIGURATION_CONFLICT/);
 assert.deepEqual(await snapshot(),before);
});
test('existing real tenant and a Cognito subject in another tenant cannot be claimed or overwritten',async()=>{
 const realTenant=randomUUID(),realSubject=randomUUID(),realActor:Actor={...actor,tenantId:realTenant,staffId:randomUUID(),stores:[]};
 await database.transaction(realActor,async transaction=>{
  await transaction.$executeRaw(sql`INSERT INTO tenants VALUES(${realTenant}::uuid,'実データ保護試験','inclusive',now(),now()+interval '2 years',1)`);
  await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${realActor.staffId}::uuid,${realTenant}::uuid,${realSubject},'既存担当者','admin',ARRAY[]::uuid[],${pinHash(config.adminPin,randomUUID())},true)`);
 });
 await assert.rejects(()=>seedSandbox(database,{...config,tenantId:realTenant,confirmTenant:realTenant,adminSubject:realSubject}),/EXISTING_TENANT/);
 const fresh=randomUUID();await assert.rejects(()=>seedSandbox(database,{...config,tenantId:fresh,confirmTenant:fresh,adminSubject:realSubject}));
 const tenants=await database.transaction({...actor,tenantId:fresh},transaction=>rows(transaction,sql`SELECT * FROM tenants`));assert.equal(tenants.length,0);
 const protectedRows=await database.transaction(realActor,transaction=>rows(transaction,sql`SELECT name FROM tenants`));assert.equal(protectedRows[0].name,'実データ保護試験');
});
test('seed retains RLS and immutable sales/inventory and does not expose another store',async()=>{
 const cashier:Actor={...actor,role:'cashier',stores:[actor.stores[0]],mfa:false};
 const stores=await database.transaction(cashier,transaction=>rows(transaction,sql`SELECT id FROM stores`));assert.deepEqual(stores.map(store=>store.id),[actor.stores[0]]);
 await assert.rejects(()=>database.transaction(actor,transaction=>transaction.$executeRaw(sql`UPDATE documents SET body='{}' WHERE kind='sale'`)),/immutable/);
 await assert.rejects(()=>database.transaction(actor,transaction=>transaction.$executeRaw(sql`DELETE FROM inventory`)));
 await assert.rejects(()=>new Business(database).inventory(cashier,actor.stores[1]),/担当外/);
});
test('both demo stores train forecasts from 84 complete days using real Python and PostgreSQL',async()=>{
 const python=process.env.PYTHON_EXECUTABLE??'.context/venv311/bin/python';
 for(const storeId of actor.stores){
  const output=JSON.parse(execFileSync(python,['forecast/regi_forecast.py','--tenant',tenantId,'--store',storeId],{encoding:'utf8',env:{...process.env,DATABASE_URL:appUrl.toString()}}));
  assert.equal(output.complete_days,DEMO_DAYS);assert.equal(output.products,7);
 }
 const forecasts=await database.transaction(actor,transaction=>rows(transaction,sql`SELECT * FROM forecasts`));assert.equal(forecasts.length,98);
 assert.ok(forecasts.every(row=>Number(row.quantity)>=0&&row.model_version&&row.trained_from&&row.trained_to&&['lightgbm','base-stock'].includes(row.method)));
});
