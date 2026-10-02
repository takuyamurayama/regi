import { Injectable } from '@nestjs/common';
import { createHash, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Actor, Database, rows, sql, Tx } from './db';
import { BusinessError, requireRule } from './errors';
import { businessDate, calculate, money, RULE_VERSION } from '../../../packages/core/src';
import { z } from 'zod';
import { recoveryToken } from './auth';
import {receiptProfile} from './receipt-profile';
const uuid = z.uuid();
const integer = z.number().int().min(1).max(10000);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const terminalSchema=z.object({id:uuid,deviceId:uuid,leaseId:uuid,sequence:z.string().regex(/^[1-9][0-9]{0,17}$/),staffId:uuid,occurredAt:z.iso.datetime(),ruleVersion:z.literal(RULE_VERSION),type:z.enum(['shift.open','shift.close','cash.move']),body:z.record(z.string(),z.unknown())});
const saleSchema = z.object({ id:uuid,deviceId:uuid,leaseId:uuid,sequence:z.string().regex(/^[1-9][0-9]{0,17}$/),staffId:uuid,occurredAt:z.iso.datetime(),ruleVersion:z.literal(RULE_VERSION),
 type:z.literal('sale'),body:z.object({ mode:z.enum(['inclusive','exclusive']),discount:amount,total:amount,method:z.enum(['cash','card','qr']),tendered:amount.optional(),reference:z.string().max(100).optional(),shiftId:uuid,paymentStartedAt:z.iso.datetime().optional(),paymentLeaseId:uuid.optional(),buyerName:z.string().max(200).optional(),receipt:z.record(z.string(),z.unknown()).optional(),
 lines:z.array(z.object({productId:uuid,name:z.string().min(1).max(200),quantity:integer,price:amount,discount:amount,rateBps:z.number().int().min(0).max(10000),cost:amount,stockManaged:z.boolean(),taxContext:z.enum(['master','dine-in','takeaway']).optional()})).min(1).max(500) }) });
function canonical(value:any):string { if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']'; if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'; return JSON.stringify(value); }
export function digest(value: any) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const json = (value:any):string => JSON.stringify(value,(_,entry)=>typeof entry==='bigint'?entry.toString():entry);
function parse<T>(schema:z.ZodType<T>,input:unknown):T { const result=schema.safeParse(input); requireRule(result.success,'INVALID_INPUT',result.success?'':result.error.message,400); return result.data; }
export function pinHash(pin:string, salt:string) { return `${salt}:${scryptSync(pin,salt,32).toString('hex')}`; }
@Injectable()
export class Business {
 constructor(readonly database: Database) {}
 access(actor:Actor,storeId:string,roles?:Actor['role'][]) {
  parse(uuid,storeId);
  requireRule(['admin','headquarters'].includes(actor.role) || actor.stores.includes(storeId),'STORE_FORBIDDEN','担当外店舗へアクセスできません',403);
  if(roles) requireRule(roles.includes(actor.role),'ROLE_FORBIDDEN','この操作の権限がありません',403);
 }
 async contract(transaction:Tx,write=true) {
  const [tenant]=await rows(transaction,sql`SELECT * FROM tenants`);
  requireRule(tenant,'TENANT_NOT_FOUND','法人が存在しません',404);
  const deadline=new Date(tenant.ends_at).getTime()+(write?0:30*86400000);
  requireRule(Date.now()>=new Date(tenant.starts_at).getTime() && Date.now()<deadline,'CONTRACT_EXPIRED','契約期限を確認してください',403);
  return tenant;
 }
 async mutation(actor:Actor,input:any,action:string,storeId:string|null,callback:(transaction:Tx)=>Promise<any>,recovery=false) {
  const operationId=parse(uuid,input.operationId);
  if(storeId) this.access(actor,storeId);
  const hash=digest({action,input});
  return this.database.transaction(actor,async transaction=>{
   const [existing]=await rows(transaction,sql`SELECT * FROM operations WHERE id=${operationId}::uuid`);
   if(existing){requireRule(existing.hash===hash,'IDEMPOTENCY_CONFLICT','同じ操作IDの内容が異なります');return existing.result;}
   if(!recovery) await this.contract(transaction);
   const result=await callback(transaction);
   await transaction.$executeRaw(sql`INSERT INTO operations(tenant_id,id,store_id,hash,result) VALUES(${actor.tenantId}::uuid,${operationId}::uuid,${storeId}::uuid,${hash},${json(result)}::jsonb)`);
   const audited={...input};if('pin' in audited)audited.pin='[redacted]';
   await transaction.$executeRaw(sql`INSERT INTO audit(id,tenant_id,store_id,actor_id,action,entity_id,body) VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${storeId}::uuid,${actor.staffId}::uuid,${action},${operationId}::uuid,${json(audited)}::jsonb)`);
   return result;
  });
 }
 async change(transaction:Tx,actor:Actor,kind:string,id:string,body:any,storeId:string|null) {
  const [head]=await rows(transaction,sql`INSERT INTO change_heads(tenant_id,cursor) VALUES(${actor.tenantId}::uuid,1) ON CONFLICT(tenant_id) DO UPDATE SET cursor=change_heads.cursor+1 RETURNING cursor`);
  await transaction.$executeRaw(sql`INSERT INTO changes VALUES(${actor.tenantId}::uuid,${head.cursor},${storeId}::uuid,${kind},${id}::uuid,${json(body)}::jsonb,now())`);
 }
 async createDocument(transaction:Tx,actor:Actor,kind:string,status:string,body:any,storeId:string|null,id:string=randomUUID()) {
  await transaction.$executeRaw(sql`INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id) VALUES(${id}::uuid,${actor.tenantId}::uuid,${storeId}::uuid,${kind},${status},${json(body)}::jsonb,${actor.staffId}::uuid)`);
  const result={id,kind,status,body,storeId}; await this.change(transaction,actor,kind,id,result,storeId); return result;
 }
 async document(transaction:Tx,id:string,kind:string) {
  parse(uuid,id);
  const [record]=await rows(transaction,sql`SELECT * FROM documents WHERE id=${id}::uuid AND kind=${kind} FOR UPDATE`);
  requireRule(record,'NOT_FOUND','対象の記録がありません',404); return record;
 }
 async update(transaction:Tx,actor:Actor,record:any,status:string,body:any) {
  await transaction.$executeRaw(sql`UPDATE documents SET status=${status},body=${json(body)}::jsonb,version=version+1 WHERE id=${record.id}::uuid`);
  const result={...record,status,body,version:record.version+1}; await this.change(transaction,actor,record.kind,record.id,result,record.store_id);return result;
 }
 async stock(transaction:Tx,actor:Actor,storeId:string,productId:string,quantity:number,sourceId:string,line:string,reason:string) {
  if(!quantity)return;
  if(reason!=='stocktake'){const [locked]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='stocktake' AND status='pending' AND store_id=${storeId}::uuid`);requireRule(!locked,'STOCKTAKE_ACTIVE','棚卸確定まで在庫を動かす操作を停止してください');}
  parse(uuid,productId);requireRule(Number.isSafeInteger(quantity)&&Math.abs(quantity)<=1000000,'INVALID_QUANTITY','在庫数量が不正です',400);
  const [product]=await rows(transaction,sql`SELECT * FROM products WHERE id=${productId}::uuid`);requireRule(product,'PRODUCT_NOT_FOUND','商品がありません',404);
  if(!product.stock_managed)return;
  await transaction.$executeRaw(sql`INSERT INTO inventory VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${storeId}::uuid,${productId}::uuid,${quantity},${sourceId}::uuid,${line},${reason},now())`);
  await this.change(transaction,actor,'inventory',sourceId,{productId,quantity,reason},storeId);
 }
 async productSnapshot(transaction:Tx) {
   return rows(transaction,sql`SELECT p.*,pr.cost_snapshot::text AS cost,pr.amount::text AS price,pr.tax_code,tr.rate_bps FROM products p
    LEFT JOIN LATERAL(SELECT * FROM prices WHERE product_id=p.id AND effective_at<=now() ORDER BY effective_at DESC LIMIT 1) pr ON true
    LEFT JOIN LATERAL(SELECT * FROM tax_rates WHERE code=pr.tax_code AND effective_at<=now() ORDER BY effective_at DESC LIMIT 1) tr ON true ORDER BY p.sku`);
 }
 async products(actor:Actor) {
  return this.database.transaction(actor,async transaction=>{await this.contract(transaction,false);return this.productSnapshot(transaction);});
 }
 async saveProduct(actor:Actor,input:any,id?:string) {
  requireRule(['admin','headquarters'].includes(actor.role),'ROLE_FORBIDDEN','商品管理権限がありません',403);
  const data=parse(z.object({operationId:uuid,sku:z.string().min(1).max(100),jan:z.string().max(50).nullable().optional(),name:z.string().min(1).max(200),category:z.string().max(100).default(''),stockManaged:z.boolean(),cost:amount,price:amount,taxCode:z.string().min(1).max(50),effectiveAt:z.iso.datetime(),version:z.number().int().positive().optional()}),input);
  requireRule(money(data.cost)<=9223372036854775807n&&money(data.price)<=9223372036854775807n,'PRICE_RANGE','単価・原価はDBの整数範囲内で指定してください',400);
  return this.mutation(actor,{...input,targetId:id??null},'product.save',null,async transaction=>{
   const productId=id?parse(uuid,id):randomUUID();
   const [tax]=await rows(transaction,sql`SELECT * FROM tax_rates WHERE code=${data.taxCode} AND effective_at<=${new Date(data.effectiveAt)} ORDER BY effective_at DESC LIMIT 1`);requireRule(tax,'TAX_NOT_FOUND','適用税率がありません',400);
   if(id){
    const changed=await transaction.$executeRaw(sql`UPDATE products SET sku=${data.sku},jan=${data.jan??null},name=${data.name},category=${data.category},stock_managed=${data.stockManaged},cost=${money(data.cost)},version=version+1 WHERE id=${id}::uuid AND version=${data.version??0}`);
    requireRule(changed===1,'VERSION_CONFLICT','商品が他の操作で変更されました');
   }else{
    const [count]=await rows(transaction,sql`SELECT count(*)::int AS count FROM products`);requireRule(count.count<50000,'SKU_LIMIT','5万SKUの上限です');
    await transaction.$executeRaw(sql`INSERT INTO products(id,tenant_id,sku,jan,name,category,stock_managed,cost) VALUES(${productId}::uuid,${actor.tenantId}::uuid,${data.sku},${data.jan??null},${data.name},${data.category},${data.stockManaged},${money(data.cost)})`);
   }
   await transaction.$executeRaw(sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${actor.tenantId}::uuid,${productId}::uuid,${money(data.price)},${data.taxCode},${new Date(data.effectiveAt)},${money(data.cost)})`);
   const result={id:productId,...data};await this.change(transaction,actor,'product',productId,result,null);return result;
  });
 }
 async settings(actor:Actor) {
  return this.database.transaction(actor,async transaction=>({tenant:await this.contract(transaction,false),stores:await rows(transaction,sql`SELECT * FROM stores`),
   devices:await rows(transaction,sql`SELECT * FROM devices`),staff:await rows(transaction,sql`SELECT id,name,role,stores,active FROM staff`),receiptProfiles:await rows(transaction,sql`SELECT store_id,body FROM documents WHERE kind='receipt-profile' ORDER BY created_at DESC`),taxRates:await rows(transaction,sql`SELECT * FROM tax_rates ORDER BY effective_at`),demo:(await rows(transaction,sql`SELECT jsonb_build_object('synthetic',true,'startDay',body->>'startDay','endDay',body->>'endDay','days',body->'days') AS config FROM documents WHERE kind='demo-seed' AND status='completed' LIMIT 1`))[0]?.config??null}));
 }
 async enroll(actor:Actor,input:any) {
  const data=parse(z.object({operationId:uuid,storeId:uuid,name:z.string().min(1).max(100)}),input);this.access(actor,data.storeId,['admin']);
  return this.mutation(actor,input,'device.enroll',data.storeId,async transaction=>{
   const [count]=await rows(transaction,sql`SELECT count(*)::int AS count FROM devices WHERE store_id=${data.storeId}::uuid AND active`);requireRule(count.count<2,'DEVICE_LIMIT','店舗の端末上限は2台です');
   const id=randomUUID();await transaction.$executeRaw(sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.storeId}::uuid,${data.name})`);return {id,...data};
  });
 }
 async bootstrap(actor:Actor,deviceId:string) {
  parse(uuid,deviceId);
  return this.database.transaction(actor,async transaction=>{
   const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${deviceId}::uuid AND active`);requireRule(device,'DEVICE_NOT_FOUND','登録端末がありません',404);this.access(actor,device.store_id);
   const tenant=await this.contract(transaction),issuedAt=new Date(),authUntil=new Date(Math.min(Date.now()+72*3600000,new Date(tenant.ends_at).getTime())),leaseId=randomUUID();
   const settings={tenant,stores:await rows(transaction,sql`SELECT * FROM stores`),receipt:await receiptProfile(transaction,device.store_id),taxRates:await rows(transaction,sql`SELECT * FROM tax_rates ORDER BY effective_at`)};
   const products=await this.productSnapshot(transaction);
   const priceSchedules=await rows(transaction,sql`SELECT p.id AS "productId",p.name,pr.amount::text AS price,pr.cost_snapshot::text AS cost,pr.tax_code AS "taxCode",pr.effective_at AS "effectiveAt" FROM prices pr JOIN products p ON p.id=pr.product_id WHERE pr.effective_at>now() ORDER BY pr.effective_at`);
   await transaction.$executeRaw(sql`INSERT INTO device_leases(id,tenant_id,store_id,device_id,issued_at,auth_until,contract_until,price_mode,receipt) VALUES(${leaseId}::uuid,${actor.tenantId}::uuid,${device.store_id}::uuid,${deviceId}::uuid,${issuedAt},${authUntil},${tenant.ends_at},${tenant.price_mode},${json(settings.receipt)}::jsonb)`);
   await transaction.$executeRaw(sql`UPDATE devices SET last_sync=${issuedAt},lease_issued_at=${issuedAt},auth_until=${authUntil},lease_contract_until=${tenant.ends_at} WHERE id=${deviceId}::uuid`);
   const [head]=await rows(transaction,sql`SELECT cursor::text FROM change_heads`);
   const [sequence]=await rows(transaction,sql`SELECT coalesce(max(sequence),0)::text AS sequence FROM device_events WHERE device_id=${deviceId}::uuid`);
   const [activeShift]=await rows(transaction,sql`SELECT * FROM documents WHERE kind='shift' AND status='open' AND body->>'deviceId'=${deviceId}`);
   const pins=await rows(transaction,sql`SELECT id,name,role,stores,pin_hash FROM staff WHERE active AND ${device.store_id}::uuid=ANY(stores)`);
   return {settings,products,priceSchedules,staff:pins,cursor:head?.cursor??'0',sequence:sequence.sequence,activeShift:activeShift??null,device,leaseId,recoveryToken:await recoveryToken({...actor,stores:[device.store_id]},deviceId,leaseId,tenant.ends_at),ruleVersion:RULE_VERSION,issuedAt,authUntil,contractUntil:tenant.ends_at};
  });
 }
 async renewLease(actor:Actor,deviceId:string,issuedAt=new Date()){
  parse(uuid,deviceId);
  return this.database.transaction(actor,async transaction=>{
   const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${deviceId}::uuid AND active`);requireRule(device,'DEVICE_NOT_FOUND','登録端末がありません',404);this.access(actor,device.store_id);
   const tenant=await this.contract(transaction),authUntil=new Date(Math.min(issuedAt.getTime()+72*3600000,new Date(tenant.ends_at).getTime())),leaseId=randomUUID();
   const receipt=await receiptProfile(transaction,device.store_id);
   await transaction.$executeRaw(sql`INSERT INTO device_leases(id,tenant_id,store_id,device_id,issued_at,auth_until,contract_until,price_mode,receipt) VALUES(${leaseId}::uuid,${actor.tenantId}::uuid,${device.store_id}::uuid,${deviceId}::uuid,${issuedAt},${authUntil},${tenant.ends_at},${tenant.price_mode},${json(receipt)}::jsonb)`);
   const [stocktake]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='stocktake' AND status='pending' AND store_id=${device.store_id}::uuid`);
   const staff=await rows(transaction,sql`SELECT id,name,role,stores,pin_hash FROM staff WHERE active AND ${device.store_id}::uuid=ANY(stores)`);
   return {leaseId,issuedAt,authUntil,contractUntil:tenant.ends_at,recoveryToken:await recoveryToken({...actor,stores:[device.store_id]},deviceId,leaseId,tenant.ends_at),staff,stocktakeId:stocktake?.id??null,onlineStaffId:actor.staffId,receipt:await receiptProfile(transaction,device.store_id)};
  });
 }
 async changes(actor:Actor,cursor:string) {
  requireRule(/^\d{1,18}$/.test(cursor),'INVALID_CURSOR','同期位置が不正です',400);
  return this.database.transaction(actor,async transaction=>{
   const entries=await rows(transaction,sql`SELECT cursor::text,kind,entity_id,store_id,body FROM changes WHERE cursor>${BigInt(cursor)} ORDER BY cursor LIMIT 1000`);
   const [head]=await rows(transaction,sql`SELECT cursor::text FROM change_heads`);
   return {changes:entries,cursor:entries.length===1000?entries.at(-1).cursor:head?.cursor??cursor};
  });
 }
 async events(actor:Actor,input:any) {
  requireRule(Array.isArray(input.events)&&input.events.length<=100,'EVENT_LIMIT','最大100件のイベントを指定してください',400);
  const results=[];
  for(const raw of input.events){
   try{const event=raw.type==='sale'?parse(saleSchema,raw):parse(terminalSchema,raw);results.push(await this.database.transaction(actor,transaction=>event.type==='sale'?this.sale(transaction,actor,event as z.infer<typeof saleSchema>,digest(raw)):this.terminalEvent(transaction,actor,event as z.infer<typeof terminalSchema>,digest(raw))));}
   catch(error:any){
    const retry=error instanceof BusinessError&&error.code==='SYNC_DEPENDENCY';
    const result={id:raw.id,status:retry?'retry':'review',code:error instanceof BusinessError?error.code:'INVALID_EVENT',message:error.message};results.push(result);
    if(retry)continue;
    if(uuid.safeParse(raw.id).success && uuid.safeParse(raw.deviceId).success && /^\d+$/.test(String(raw.sequence))){
     await this.database.transaction(actor,async transaction=>{
      const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${raw.deviceId}::uuid`);
      if(device && (['admin','headquarters'].includes(actor.role)||actor.stores.includes(device.store_id)))
       await transaction.$executeRaw(sql`INSERT INTO device_events VALUES(${actor.tenantId}::uuid,${raw.id}::uuid,${device.store_id}::uuid,${raw.deviceId}::uuid,${BigInt(raw.sequence)},${digest(raw)},'review',${json(result)}::jsonb,${json(raw)}::jsonb,now()) ON CONFLICT DO NOTHING`);
     }).catch(()=>{});
    }
   }
  }
  return {results};
 }
 async terminalEvent(transaction:Tx,actor:Actor,event:z.infer<typeof terminalSchema>,requestHash=digest(event)){
  requireRule(!actor.deviceId||(actor.deviceId===event.deviceId&&actor.leaseId===event.leaseId),'RECOVERY_SCOPE','回収範囲が異なります',403);
  const hash=requestHash,[prior]=await rows(transaction,sql`SELECT * FROM device_events WHERE id=${event.id}::uuid`);
  if(prior){requireRule(prior.hash===hash,'IDEMPOTENCY_CONFLICT','イベント内容が異なります');return prior.result;}
  const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${event.deviceId}::uuid`);requireRule(device,'DEVICE_NOT_FOUND','端末がありません',404);this.access(actor,device.store_id);
  const [lease]=await rows(transaction,sql`SELECT * FROM device_leases WHERE id=${event.leaseId}::uuid AND device_id=${event.deviceId}::uuid`);
  const occurred=Date.parse(event.occurredAt);requireRule(lease&&occurred>=new Date(lease.issued_at).getTime()&&occurred<new Date(lease.auth_until).getTime()&&occurred<new Date(lease.contract_until).getTime()&&occurred<=Date.now()+60000,'OFFLINE_EXPIRED','認証・契約の有効範囲外です',403);
  const [staff]=await rows(transaction,sql`SELECT * FROM staff WHERE id=${event.staffId}::uuid`);requireRule(staff?.stores.includes(device.store_id),'STAFF_FORBIDDEN','担当者の店舗が異なります',403);
  const [duplicate]=await rows(transaction,sql`SELECT id FROM device_events WHERE device_id=${event.deviceId}::uuid AND sequence=${BigInt(event.sequence)}`);requireRule(!duplicate,'SEQUENCE_CONFLICT','端末連番が重複しています');
  const operator={...actor,staffId:event.staffId};let record:any;
  if(event.type==='shift.open'){
   const [stocktake]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='stocktake' AND status='pending' AND store_id=${device.store_id}::uuid`);requireRule(!stocktake,'STOCKTAKE_ACTIVE','棚卸中は開局できません');
   const body=parse(z.object({opening:amount}),event.body);
   record=await this.createDocument(transaction,operator,'shift','open',{deviceId:event.deviceId,opening:body.opening,openedAt:event.occurredAt},device.store_id,event.id);
  }else{
   const shiftId=parse(uuid,event.body.shiftId),[shift]=await rows(transaction,sql`SELECT * FROM documents WHERE id=${shiftId}::uuid AND kind='shift' FOR UPDATE`);
   requireRule(shift,'SYNC_DEPENDENCY','開局イベントの受領待ちです');requireRule(shift.store_id===device.store_id&&shift.body.deviceId===event.deviceId,'SHIFT_MISMATCH','開局端末が異なります');
   if(event.type==='cash.move'){
    const body=parse(z.object({amount,direction:z.enum(['in','out']),reason:z.string().min(1).max(500)}),event.body);
    requireRule(shift.status==='open','SHIFT_STATE','営業中の端末へ記録してください');record=await this.createDocument(transaction,operator,'cash','confirmed',{...body,shiftId},device.store_id,event.id);
   }else{
    const body=parse(z.object({actual:amount}),event.body);requireRule(shift.status==='open','SHIFT_STATE','端末は締め済みです');
    const [received]=await rows(transaction,sql`SELECT count(*)::bigint AS count FROM device_events WHERE device_id=${event.deviceId}::uuid AND sequence<${BigInt(event.sequence)} AND status='accepted'`);
    requireRule(BigInt(received.count)===BigInt(event.sequence)-1n,'SYNC_DEPENDENCY','締めより前の全イベントを先に同期してください');
    const sales=await rows(transaction,sql`SELECT body FROM documents WHERE kind='sale' AND body->>'shiftId'=${shiftId}`),moves=await rows(transaction,sql`SELECT body FROM documents WHERE kind='cash' AND body->>'shiftId'=${shiftId}`),refunds=await rows(transaction,sql`SELECT body FROM documents WHERE kind='refund' AND status='confirmed' AND body->>'refundShiftId'=${shiftId} AND body->>'method'='cash'`);
    const expected=money(shift.body.opening)+sales.filter(sale=>sale.body.method==='cash').reduce<bigint>((sum,sale)=>sum+money(sale.body.total),0n)+moves.reduce<bigint>((sum,move)=>sum+(move.body.direction==='in'?1n:-1n)*money(move.body.amount),0n)-refunds.reduce<bigint>((sum,refund)=>sum+money(refund.body.total),0n);
    record=await this.update(transaction,operator,shift,'provisional',{...shift.body,actual:body.actual,expected:expected.toString(),difference:(money(body.actual)-expected).toString(),closedAt:event.occurredAt});
   }
  }
  const result={id:event.id,status:'accepted',record};await transaction.$executeRaw(sql`INSERT INTO device_events VALUES(${actor.tenantId}::uuid,${event.id}::uuid,${device.store_id}::uuid,${event.deviceId}::uuid,${BigInt(event.sequence)},${hash},'accepted',${json(result)}::jsonb,${json(event)}::jsonb,now())`);return result;
 }
 async sale(transaction:Tx,actor:Actor,event:z.infer<typeof saleSchema>,requestHash=digest(event),review?:{reason:string;approvedBy:string;inventoryIncludedInCount?:boolean}) {
  requireRule(!actor.deviceId||(actor.deviceId===event.deviceId&&actor.leaseId===event.leaseId),'RECOVERY_SCOPE','別端末・認証期間のイベントは回収できません',403);
  const hash=requestHash;
  const [prior]=await rows(transaction,sql`SELECT * FROM device_events WHERE id=${event.id}::uuid`);
  if(prior){requireRule(prior.hash===hash,'IDEMPOTENCY_CONFLICT','イベントIDの内容が異なります');return prior.result;}
  const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${event.deviceId}::uuid`);
  requireRule(device,'DEVICE_NOT_FOUND','登録端末がありません',404);this.access(actor,device.store_id);
  const [counting]=await rows(transaction,sql`SELECT * FROM documents WHERE kind='stocktake' AND store_id=${device.store_id}::uuid AND (status='pending' OR (status='confirmed' AND (body->>'confirmedAt')::timestamptz>=${new Date(event.occurredAt)})) ORDER BY created_at DESC LIMIT 1`);
  requireRule(!counting||counting.status!=='pending','STOCKTAKE_ACTIVE','棚卸中に到着した売上は要確認に隔離します');
  requireRule(!counting||typeof review?.inventoryIncludedInCount==='boolean','STOCKTAKE_RECONCILE','棚卸より前の遅延売上です。数量が実査に含まれたか管理者が照合してください');
  const [staff]=await rows(transaction,sql`SELECT * FROM staff WHERE id=${event.staffId}::uuid`);
  requireRule(staff?.stores.includes(device.store_id),'STAFF_FORBIDDEN','販売担当者の店舗所属を確認してください',403);
  const [lease]=await rows(transaction,sql`SELECT * FROM device_leases WHERE id=${event.leaseId}::uuid AND device_id=${event.deviceId}::uuid`);
  const occurred=new Date(event.occurredAt).getTime();
  requireRule(lease && occurred>=new Date(lease.issued_at).getTime() && occurred<=Date.now()+60000
    && occurred<new Date(lease.auth_until).getTime() && occurred<new Date(lease.contract_until).getTime(),'OFFLINE_EXPIRED','販売日時が認証・契約の有効範囲外です',403);
  requireRule(lease.price_mode===event.body.mode,'PRICE_MODE_MISMATCH','法人の価格入力方式が異なります');
  const [duplicate]=await rows(transaction,sql`SELECT id FROM device_events WHERE device_id=${event.deviceId}::uuid AND sequence=${BigInt(event.sequence)}`);requireRule(!duplicate,'SEQUENCE_CONFLICT','端末連番が重複しています');
  const [shift]=await rows(transaction,sql`SELECT * FROM documents WHERE id=${event.body.shiftId}::uuid AND kind='shift' FOR UPDATE`);requireRule(shift,'SYNC_DEPENDENCY','開局イベントの受領待ちです');requireRule(shift.body.deviceId===event.deviceId&&shift.store_id===device.store_id&&occurred>=Date.parse(shift.body.openedAt)&&(!shift.body.closedAt||occurred<=Date.parse(shift.body.closedAt)),'SHIFT_MISMATCH','開局記録・販売日時が異なります');
  const calculated=calculate(event.body.lines,event.body.discount,event.body.mode);
  const [paymentLease]=await rows(transaction,sql`SELECT * FROM device_leases WHERE id=${event.body.paymentLeaseId??event.leaseId}::uuid AND device_id=${event.deviceId}::uuid`);
  requireRule(calculated.total===event.body.total,'CALCULATION_MISMATCH','端末とサーバーの金額が一致しません');
  for(const line of event.body.lines){
   const paymentStartedAt=new Date(event.body.paymentStartedAt??event.occurredAt);requireRule(paymentLease&&paymentStartedAt.getTime()<=occurred&&paymentStartedAt.getTime()>=new Date(paymentLease.issued_at).getTime()&&paymentStartedAt.getTime()<new Date(paymentLease.auth_until).getTime(),'PAYMENT_TIME','開始時認証・支払開始日時を確認してください',400);
   const [product]=await rows(transaction,sql`SELECT p.*,pr.amount::text,pr.cost_snapshot::text,CASE WHEN ${line.taxContext??null}='dine-in' AND pr.tax_code='reduced' THEN 'standard' ELSE pr.tax_code END AS tax_code,tr.rate_bps FROM products p
    JOIN LATERAL(SELECT * FROM prices WHERE product_id=p.id AND effective_at<=${paymentStartedAt} ORDER BY effective_at DESC LIMIT 1) pr ON true
    JOIN LATERAL(SELECT * FROM tax_rates WHERE code=CASE WHEN ${line.taxContext??null}='dine-in' AND pr.tax_code='reduced' THEN 'standard' ELSE pr.tax_code END AND effective_at<=${paymentStartedAt} ORDER BY effective_at DESC LIMIT 1) tr ON true WHERE p.id=${line.productId}::uuid`);
   let knownPrice=product?.amount===line.price&&product?.cost_snapshot===line.cost;
   if(!knownPrice&&review){const [historical]=await rows(transaction,sql`SELECT id FROM prices WHERE product_id=${line.productId}::uuid AND amount=${money(line.price)} AND cost_snapshot=${money(line.cost)} AND effective_at<=${lease.issued_at} LIMIT 1`);knownPrice=Boolean(historical);}
   requireRule(product && product.stock_managed===line.stockManaged && knownPrice && product.rate_bps===line.rateBps,'MASTER_MISMATCH','販売時の価格・原価・税率を確認してください');
   const [confirmedRate]=await rows(transaction,sql`SELECT rate_bps FROM tax_rates WHERE code=${product.tax_code} AND effective_at<=${new Date(event.occurredAt)} ORDER BY effective_at DESC LIMIT 1`);
   requireRule(review||confirmedRate?.rate_bps===line.rateBps,'TAX_CROSSING_REVIEW','支払開始後に税率が切り替わりました。管理者確認が必要です');
  }
  if(event.body.method==='cash')requireRule(money(event.body.tendered)>=money(calculated.total),'INSUFFICIENT_CASH','現金預り額が不足しています',400);
  else requireRule(event.body.reference?.trim(),'PAYMENT_UNKNOWN','外部端末の成功結果と確認番号が必要です',400);
  const receipt=Object.keys(paymentLease?.receipt??{}).length?paymentLease.receipt:await receiptProfile(transaction,device.store_id,new Date(event.body.paymentStartedAt??event.occurredAt));requireRule(!event.body.receipt||digest(event.body.receipt)===digest(receipt),'RECEIPT_PROFILE_MISMATCH','帳票設定が開始時認証情報と異なります');requireRule(!receipt.buyerRequired||event.body.buyerName?.trim(),'BUYER_REQUIRED','帳票宛名を入力してください',400);
  const record=await this.createDocument(transaction,{...actor,staffId:event.staffId},'sale','confirmed',{...calculated,receipt,buyerName:event.body.buyerName??'',method:event.body.method,tendered:event.body.tendered??null,reference:event.body.reference??null,
   deviceId:event.deviceId,shiftId:event.body.shiftId,paymentStartedAt:event.body.paymentStartedAt??event.occurredAt,occurredAt:event.occurredAt,businessDate:businessDate(event.occurredAt),reviewApproval:review??null},device.store_id,event.id);
  for(const [index,line] of calculated.lines.entries()){await this.stock(transaction,actor,device.store_id,line.productId,-line.quantity,event.id,String(index),'sale');if(counting&&review?.inventoryIncludedInCount)await this.stock(transaction,actor,device.store_id,line.productId,line.quantity,event.id,`reconcile-${index}`,'stocktake-late-reconciliation');}
  const result={id:event.id,status:'accepted',sale:record};
  await transaction.$executeRaw(sql`INSERT INTO device_events VALUES(${actor.tenantId}::uuid,${event.id}::uuid,${device.store_id}::uuid,${event.deviceId}::uuid,${BigInt(event.sequence)},${hash},'accepted',${json(result)}::jsonb,${json(event)}::jsonb,now())`);
  await transaction.$executeRaw(sql`UPDATE devices SET last_sync=now() WHERE id=${event.deviceId}::uuid`);
  return result;
 }
 async reviews(actor:Actor,storeId:string){
  this.access(actor,storeId,['admin','headquarters','manager']);
  return this.database.transaction(actor,transaction=>rows(transaction,sql`SELECT * FROM device_events WHERE store_id=${storeId}::uuid AND status='review' ORDER BY created_at`));
 }
 async retryReview(actor:Actor,id:string,input:any){
  this.access(actor,input.storeId,['admin','headquarters','manager']);requireRule(typeof input.reason==='string'&&input.reason.trim(),'REASON_REQUIRED','原記録・決済結果を照合した承認理由が必要です',400);
  return this.mutation(actor,{...input,targetId:id??null},'review.retry',input.storeId,async transaction=>{
   const [record]=await rows(transaction,sql`SELECT * FROM device_events WHERE id=${parse(uuid,id)}::uuid AND store_id=${input.storeId}::uuid FOR UPDATE`);requireRule(record,'NOT_FOUND','要確認イベントがありません',404);
   if(record.status==='accepted')return record.result;
   requireRule(record.status==='review','REVIEW_STATE','対象の状態が異なります');
   await transaction.$executeRaw(sql`DELETE FROM device_events WHERE id=${id}::uuid`);
   return record.body.type==='sale'?this.sale(transaction,actor,parse(saleSchema,record.body),record.hash,{reason:input.reason,approvedBy:actor.staffId,inventoryIncludedInCount:input.inventoryIncludedInCount}):this.terminalEvent(transaction,actor,parse(terminalSchema,record.body),record.hash);
  },true);
 }
 async list(actor:Actor,kind:string,storeId?:string,query='') {
  requireRule(['sale','refund','purchase-order','receipt','receipt-cancel','stocktake','transfer','shift','cash','day-close','export','ai-query','supplier','purchase-return'].includes(kind),'INVALID_KIND','一覧種別が不正です',400);
  if(storeId)this.access(actor,storeId);
  requireRule(query.length<=200,'SEARCH_LIMIT','検索語は200文字以内です',400);
  return this.database.transaction(actor,async transaction=>{await this.contract(transaction,false);return rows(transaction,sql`SELECT * FROM documents WHERE kind=${kind} AND (${storeId??null}::uuid IS NULL OR store_id=${storeId??null}::uuid OR (kind='transfer' AND body->>'toStoreId'=${storeId??''})) AND (id::text ILIKE ${'%'+query+'%'} OR body::text ILIKE ${'%'+query+'%'}) ORDER BY created_at DESC LIMIT 1000`);});
 }
 async returnable(actor:Actor,id:string){return this.database.transaction(actor,async transaction=>{await this.contract(transaction,false);const sale=await this.document(transaction,parse(uuid,id),'sale');this.access(actor,sale.store_id);const refunds=await rows(transaction,sql`SELECT body,status FROM documents WHERE kind='refund' AND body->>'saleId'=${id} AND status IN ('confirmed','pending')`);return {sale,lines:sale.body.lines.map((line:any,index:number)=>({...line,index,remaining:line.quantity-refunds.flatMap(record=>record.body.lines).filter(returned=>returned.index===index).reduce((sum,returned)=>sum+returned.quantity,0)})),pending:refunds.some(record=>record.status==='pending')};});}
 async refund(actor:Actor,input:any) {
  const data=parse(z.object({operationId:uuid,storeId:uuid,saleId:uuid,reason:z.string().min(1).max(500),lines:z.array(z.object({index:z.number().int().min(0),quantity:integer,restock:z.boolean()})).min(1)}),input);this.access(actor,data.storeId,['admin','headquarters','manager']);
  requireRule(new Set(data.lines.map(line=>line.index)).size===data.lines.length,'DUPLICATE_LINE','返品明細が重複しています',400);
  return this.mutation(actor,input,'refund.reserve',data.storeId,async transaction=>{
   const sale=await this.document(transaction,data.saleId,'sale');requireRule(sale.store_id===data.storeId,'STORE_MISMATCH','元販売店舗で返品してください',403);
   const prior=await rows(transaction,sql`SELECT * FROM documents WHERE kind='refund' AND body->>'saleId'=${data.saleId} AND status IN ('pending','confirmed')`);
   requireRule(!prior.some(record=>record.status==='pending'),'REFUND_PENDING','未完了の返金を先に確認してください');
   const lines=data.lines.map(line=>{
    const original=sale.body.lines[line.index];requireRule(original,'LINE_NOT_FOUND','元明細がありません',400);
    const returned=prior.flatMap(record=>record.body.lines).filter(entry=>entry.index===line.index).reduce((sum,entry)=>sum+entry.quantity,0);
    requireRule(returned+line.quantity<=original.quantity,'OVER_REFUND','返品可能数量を超えています');
    const paid=original.unitRefunds.slice(returned,returned+line.quantity).reduce((sum:bigint,value:string)=>sum+money(value),0n).toString();
    const taxManagement=(original.unitTaxRefunds??[]).slice(returned,returned+line.quantity).reduce((sum:bigint,value:string)=>sum+money(value),0n).toString();
    return {...line,productId:original.productId,name:original.name,rateBps:original.rateBps,paid,taxManagement,unitOffset:returned};
   });
   return this.createDocument(transaction,actor,'refund','pending',{saleId:data.saleId,receipt:sale.body.receipt,buyerName:sale.body.buyerName,reason:data.reason,method:sale.body.method,originalSaleDate:sale.body.occurredAt,lines,total:lines.reduce((sum,line)=>sum+money(line.paid),0n).toString()},data.storeId);
  });
 }
 async confirmRefund(actor:Actor,id:string,input:any) {
  parse(z.object({operationId:uuid,storeId:uuid,result:z.enum(['success','unknown','failed']),reference:z.string().max(100).optional(),shiftId:uuid.optional()}),input);this.access(actor,input.storeId,['admin','headquarters','manager']);
  return this.mutation(actor,{...input,targetId:id??null},'refund.confirm',input.storeId,async transaction=>{
   const refund=await this.document(transaction,id,'refund');requireRule(refund.store_id===input.storeId,'STORE_MISMATCH','店舗が異なります',403);requireRule(refund.status==='pending','REFUND_COMPLETE','既に返金処理済みです');
   if(input.result==='unknown')return this.update(transaction,actor,refund,'pending',{...refund.body,confirmation:'unknown',reference:input.reference??null});
   if(input.result==='failed')return this.update(transaction,actor,refund,'cancelled',{...refund.body,confirmation:'failed'});
   requireRule(refund.body.method==='cash'||input.reference?.trim(),'PAYMENT_UNKNOWN','外部返金確認番号が必要です',400);
   if(refund.body.method==='cash'){
    requireRule(input.shiftId,'REFUND_SHIFT_REQUIRED','現金返金を支出した開局IDが必要です',400);
    const shift=await this.document(transaction,input.shiftId,'shift');requireRule(shift.store_id===input.storeId&&shift.status==='open','REFUND_SHIFT_STATE','現金返金は営業中の端末に記録してください');
   }
   const body={...refund.body,confirmation:'success',refundShiftId:input.shiftId??null,reference:input.reference??null,refundedAt:new Date().toISOString(),businessDate:businessDate(new Date().toISOString())};
   for(const line of body.lines)if(line.restock)await this.stock(transaction,actor,input.storeId,line.productId,line.quantity,refund.id,String(line.index),'refund');
   return this.update(transaction,actor,refund,'confirmed',body);
  });
 }
 async purchase(actor:Actor,input:any) {
  const data=parse(z.object({operationId:uuid,storeId:uuid,supplier:z.string().min(1).max(200),expectedAt:z.iso.date(),lines:z.array(z.object({productId:uuid,quantity:integer,unitCost:amount})).min(1).max(500)}),input);
  return this.mutation(actor,input,'purchase.create',data.storeId,async transaction=>{
   const lines=[];for(const line of data.lines){const [product]=await rows(transaction,sql`SELECT id,name FROM products WHERE id=${line.productId}::uuid`);requireRule(product,'PRODUCT_NOT_FOUND','商品がありません',404);lines.push({...line,name:product.name,received:0});}
   return this.createDocument(transaction,actor,'purchase-order','draft',{supplier:data.supplier,expectedAt:data.expectedAt,lines,revisions:[]},data.storeId);
  });
 }
 async purchaseAction(actor:Actor,id:string,input:any,action:'approve'|'issue'|'revise') {
  this.access(actor,input.storeId,['admin','headquarters','manager']);
  return this.mutation(actor,{...input,targetId:id},`purchase.${action}`,input.storeId,async transaction=>{
   const order=await this.document(transaction,id,'purchase-order');requireRule(order.store_id===input.storeId,'STORE_MISMATCH','店舗が異なります',403);
   if(action==='approve'){requireRule(order.status==='draft','ORDER_STATE','下書きのみ承認できます');return this.update(transaction,actor,order,'approved',{...order.body,approvedBy:actor.staffId});}
   if(action==='issue'){requireRule(order.status==='approved','ORDER_STATE','承認済み発注のみ発行できます');const issuedAt=new Date().toISOString(),receipt=await receiptProfile(transaction,input.storeId);return this.update(transaction,actor,order,'issued',{...order.body,issuedSnapshot:{...order.body,issuedAt,receipt},issuedAt});}
   requireRule(['issued','partial','received'].includes(order.status),'ORDER_STATE','発行済み発注を改訂してください');
   requireRule(Array.isArray(input.quantities)&&input.quantities.length===order.body.lines.length && typeof input.reason==='string'&&input.reason.trim(),'INVALID_REVISION','全明細の数量と改訂理由が必要です',400);
   const lines=order.body.lines.map((line:any,index:number)=>{const quantity=parse(integer,input.quantities[index]);requireRule(quantity>=line.received,'BELOW_RECEIVED','入荷済み数量より少なくできません');return {...line,quantity};});
   return this.update(transaction,actor,order,lines.every((line:any)=>line.received===line.quantity)?'received':lines.some((line:any)=>line.received>0)?'partial':'issued',
    {...order.body,lines,revisions:[...order.body.revisions,{prior:order.body.lines,reason:input.reason,actor:actor.staffId,at:new Date().toISOString()}]});
  });
 }
 async receipt(actor:Actor,id:string,input:any) {
  const data=parse(z.object({operationId:uuid,storeId:uuid,lines:z.array(z.object({index:z.number().int().min(0),quantity:integer})).min(1)}),input);this.access(actor,data.storeId,['admin','headquarters','manager']);
  requireRule(new Set(data.lines.map(line=>line.index)).size===data.lines.length,'DUPLICATE_LINE','入荷明細が重複しています',400);
  return this.mutation(actor,{...input,targetId:id??null},'receipt.create',data.storeId,async transaction=>{
   const order=await this.document(transaction,id,'purchase-order');requireRule(order.store_id===data.storeId,'STORE_MISMATCH','店舗が異なります',403);requireRule(['issued','partial'].includes(order.status),'ORDER_STATE','発注を先に発行してください');
   const lines=order.body.lines.map((line:any)=>({...line}));
   for(const line of data.lines){requireRule(lines[line.index]&&lines[line.index].received+line.quantity<=lines[line.index].quantity,'OVER_RECEIPT','発注残数を超えています');lines[line.index].received+=line.quantity;}
   const receipt=await this.createDocument(transaction,actor,'receipt','confirmed',{orderId:id,lines:data.lines.map(line=>({...line,productId:lines[line.index].productId}))},data.storeId);
   for(const line of receipt.body.lines)await this.stock(transaction,actor,data.storeId,line.productId,line.quantity,receipt.id,String(line.index),'receipt');
   await this.update(transaction,actor,order,lines.every((line:any)=>line.received===line.quantity)?'received':'partial',{...order.body,lines});return receipt;
  });
 }
 async cancelReceipt(actor:Actor,id:string,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);requireRule(typeof input.reason==='string'&&input.reason.trim(),'REASON_REQUIRED','取消理由が必要です',400);
  return this.mutation(actor,{...input,targetId:id??null},'receipt.cancel',input.storeId,async transaction=>{
   const receipt=await this.document(transaction,id,'receipt');requireRule(receipt.store_id===input.storeId,'STORE_MISMATCH','店舗が異なります',403);
   const [prior]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='receipt-cancel' AND body->>'receiptId'=${id}`);requireRule(!prior,'ALREADY_CANCELLED','入荷は取消済みです');
   const order=await this.document(transaction,receipt.body.orderId,'purchase-order');
   const cancellation=await this.createDocument(transaction,actor,'receipt-cancel','confirmed',{receiptId:id,reason:input.reason},input.storeId);
   const lines=order.body.lines.map((line:any)=>({...line}));
   for(const line of receipt.body.lines){lines[line.index].received-=line.quantity;await this.stock(transaction,actor,input.storeId,line.productId,-line.quantity,cancellation.id,String(line.index),'receipt-cancel');}
   await this.update(transaction,actor,order,lines.some((line:any)=>line.received>0)?'partial':'issued',{...order.body,lines});return cancellation;
  });
 }
 async inventory(actor:Actor,storeId?:string) {
  if(storeId)this.access(actor,storeId);
  return this.database.transaction(actor,async transaction=>{await this.contract(transaction,false);return rows(transaction,sql`SELECT store_id,product_id,sum(quantity)::text AS quantity FROM inventory WHERE (${storeId??null}::uuid IS NULL OR store_id=${storeId??null}::uuid) GROUP BY store_id,product_id ORDER BY product_id`);});
 }
 async transfer(actor:Actor,input:any) {
  const data=parse(z.object({operationId:uuid,storeId:uuid,toStoreId:uuid,lines:z.array(z.object({productId:uuid,quantity:integer})).min(1)}),input);this.access(actor,data.storeId,['admin','headquarters','manager']);this.access(actor,data.toStoreId);requireRule(data.storeId!==data.toStoreId,'SAME_STORE','移動先店舗を変更してください',400);
  return this.mutation(actor,input,'transfer.dispatch',data.storeId,async transaction=>{
   const transfer=await this.createDocument(transaction,actor,'transfer','transit',{toStoreId:data.toStoreId,lines:data.lines},data.storeId);
   for(const [index,line] of data.lines.entries())await this.stock(transaction,actor,data.storeId,line.productId,-line.quantity,transfer.id,String(index),'transfer-out');return transfer;
  });
 }
 async receiveTransfer(actor:Actor,id:string,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);
  return this.mutation(actor,{...input,targetId:id??null},'transfer.receive',input.storeId,async transaction=>{
   const transfer=await this.document(transaction,id,'transfer');requireRule(transfer.body.toStoreId===input.storeId && transfer.status==='transit','TRANSFER_STATE','受入店舗・移動状態を確認してください');
   for(const [index,line] of transfer.body.lines.entries())await this.stock(transaction,actor,input.storeId,line.productId,line.quantity,id,String(index),'transfer-in');
   return this.update(transaction,actor,transfer,'received',{...transfer.body,receivedAt:new Date().toISOString()});
  });
 }
 async deviceStatus(actor:Actor,id:string,input:any) {
  parse(z.object({operationId:uuid,storeId:uuid,stopped:z.boolean(),pending:z.number().int().min(0)}),input);
  return this.mutation(actor,{...input,targetId:id??null},'device.status',input.storeId,async transaction=>{
   if(!input.stopped){const [lock]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='stocktake' AND status='pending' AND store_id=${input.storeId}::uuid`);requireRule(!lock,'STOCKTAKE_ACTIVE','棚卸中は端末の販売停止を解除できません');}
   const changed=await transaction.$executeRaw(sql`UPDATE devices SET stopped=${input.stopped},pending=${input.pending},last_sync=now() WHERE id=${parse(uuid,id)}::uuid AND store_id=${input.storeId}::uuid`);requireRule(changed===1,'DEVICE_NOT_FOUND','端末がありません',404);return {id,stopped:input.stopped,pending:input.pending};
  });
 }
 async stocktake(actor:Actor,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);
  return this.mutation(actor,input,'stocktake.start',input.storeId,async transaction=>{
   const devices=await rows(transaction,sql`SELECT * FROM devices WHERE store_id=${input.storeId}::uuid AND active`);
   requireRule(devices.length && devices.every(device=>device.stopped&&device.pending===0&&device.last_sync&&Date.now()-new Date(device.last_sync).getTime()<120000),'DEVICES_NOT_QUIET','全登録端末の同期と販売停止を確認してください');
   const [review]=await rows(transaction,sql`SELECT id FROM device_events WHERE store_id=${input.storeId}::uuid AND status='review' LIMIT 1`);requireRule(!review,'REVIEW_PENDING','要確認イベントを解消してください');
   return this.createDocument(transaction,actor,'stocktake','pending',{devices:devices.map(device=>device.id),startedAt:new Date().toISOString()},input.storeId);
  });
 }
 async confirmStocktake(actor:Actor,id:string,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);
  parse(z.object({operationId:uuid,storeId:uuid,counts:z.array(z.object({productId:uuid,quantity:z.number().int().min(0).max(1000000)})).min(1)}),input);
  requireRule(new Set(input.counts.map((line:any)=>line.productId)).size===input.counts.length,'DUPLICATE_LINE','棚卸商品が重複しています',400);
  return this.mutation(actor,{...input,targetId:id??null},'stocktake.confirm',input.storeId,async transaction=>{
   const record=await this.document(transaction,id,'stocktake');requireRule(record.store_id===input.storeId&&record.status==='pending','STOCKTAKE_STATE','棚卸状態が異なります');
   const reviews=await rows(transaction,sql`SELECT id,device_id FROM device_events WHERE store_id=${input.storeId}::uuid AND status='review'`);
   requireRule(!reviews.length||(Array.isArray(input.reviewEventIds)&&reviews.every(review=>input.reviewEventIds.includes(review.id))&&typeof input.reason==='string'&&input.reason.trim()),'STOCKTAKE_REVIEW_ACK','棚卸開始後の隔離イベントを確認し、理由と全イベントIDを承認してください');
   const devices=await rows(transaction,sql`SELECT * FROM devices WHERE store_id=${input.storeId}::uuid AND active`);requireRule(devices.every(device=>device.stopped&&device.pending<=reviews.filter(review=>review.device_id===device.id).length),'DEVICES_NOT_QUIET','未送信・未完了会計を解消し、端末の販売停止を維持してください');
   for(const line of input.counts){const [balance]=await rows(transaction,sql`SELECT coalesce(sum(quantity),0)::int AS quantity FROM inventory WHERE store_id=${input.storeId}::uuid AND product_id=${line.productId}::uuid`);await this.stock(transaction,actor,input.storeId,line.productId,line.quantity-balance.quantity,id,line.productId,'stocktake');}
   return this.update(transaction,actor,record,'confirmed',{...record.body,counts:input.counts,reviewEventIds:input.reviewEventIds??[],reviewReason:input.reason??null,confirmedAt:new Date().toISOString()});
  });
 }
 async adjust(actor:Actor,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);parse(z.object({operationId:uuid,storeId:uuid,productId:uuid,quantity:z.number().int().min(-1000000).max(1000000).refine(value=>value!==0),reason:z.string().min(1).max(500)}),input);
  return this.mutation(actor,input,'inventory.adjust',input.storeId,async transaction=>{await this.stock(transaction,actor,input.storeId,input.productId,input.quantity,input.operationId,'adjust',input.reason);return {id:input.operationId,...input};});
 }
 async openShift(actor:Actor,input:any) {
  parse(z.object({operationId:uuid,storeId:uuid,deviceId:uuid,opening:amount,pin:z.string().regex(/^\d{4,8}$/)}),input);
  return this.mutation(actor,{...input,pin:'[redacted]'},'shift.open',input.storeId,async transaction=>{
   const [lock]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='stocktake' AND status='pending' AND store_id=${input.storeId}::uuid`);requireRule(!lock,'STOCKTAKE_ACTIVE','棚卸中は開局できません');
   const [staff]=await rows(transaction,sql`SELECT pin_hash FROM staff WHERE id=${actor.staffId}::uuid`);const [salt,expected]=staff.pin_hash.split(':');
   requireRule(timingSafeEqual(scryptSync(input.pin,salt,32),Buffer.from(expected,'hex')),'PIN_INVALID','PINを確認してください',401);
   const [device]=await rows(transaction,sql`SELECT * FROM devices WHERE id=${input.deviceId}::uuid AND store_id=${input.storeId}::uuid AND active AND NOT stopped`);requireRule(device,'DEVICE_STOPPED','端末登録・販売停止状態を確認してください');
   return this.createDocument(transaction,actor,'shift','open',{deviceId:input.deviceId,opening:input.opening,openedAt:new Date().toISOString()},input.storeId);
  });
 }
 async cash(actor:Actor,input:any) {
  parse(z.object({operationId:uuid,storeId:uuid,shiftId:uuid,amount:amount,direction:z.enum(['in','out']),reason:z.string().min(1)}),input);
  return this.mutation(actor,input,'cash.record',input.storeId,async transaction=>{const shift=await this.document(transaction,input.shiftId,'shift');requireRule(shift.store_id===input.storeId&&shift.status==='open','SHIFT_STATE','開局記録を確認してください');return this.createDocument(transaction,actor,'cash','confirmed',{shiftId:input.shiftId,amount:input.amount,direction:input.direction,reason:input.reason},input.storeId);});
 }
 async closeShift(actor:Actor,id:string,input:any) {
  parse(z.object({operationId:uuid,storeId:uuid,actual:amount}),input);
  return this.mutation(actor,{...input,targetId:id??null},'shift.close',input.storeId,async transaction=>{
   const shift=await this.document(transaction,id,'shift');requireRule(shift.store_id===input.storeId&&shift.status==='open','SHIFT_STATE','開局記録を確認してください');
   const sales=await rows(transaction,sql`SELECT body FROM documents WHERE kind='sale' AND body->>'shiftId'=${id}`);
   const moves=await rows(transaction,sql`SELECT body FROM documents WHERE kind='cash' AND body->>'shiftId'=${id}`);
   const refunds=await rows(transaction,sql`SELECT body FROM documents WHERE kind='refund' AND status='confirmed' AND body->>'method'='cash' AND body->>'refundShiftId'=${id}`);
   const expected:bigint=money(shift.body.opening)+sales.filter(record=>record.body.method==='cash').reduce<bigint>((sum,record)=>sum+money(record.body.total),0n)
    +moves.reduce<bigint>((sum,record)=>sum+(record.body.direction==='in'?1n:-1n)*money(record.body.amount),0n)-refunds.reduce<bigint>((sum,record)=>sum+money(record.body.total),0n);
   return this.update(transaction,actor,shift,'provisional',{...shift.body,actual:input.actual,expected:expected.toString(),difference:(money(input.actual)-expected).toString(),closedAt:new Date().toISOString()});
  },true);
 }
 async dayClose(actor:Actor,input:any) {
  this.access(actor,input.storeId,['admin','headquarters','manager']);parse(z.object({operationId:uuid,storeId:uuid,day:z.iso.date()}),input);
  return this.mutation(actor,input,'day.close',input.storeId,async transaction=>{
   const devices=await rows(transaction,sql`SELECT * FROM devices WHERE store_id=${input.storeId}::uuid AND active`);requireRule(devices.length&&devices.every(device=>device.pending===0&&device.last_sync&&Date.now()-new Date(device.last_sync).getTime()<120000),'SYNC_PENDING','全端末の同期を確認してください');
   const unresolved=await rows(transaction,sql`SELECT id FROM documents WHERE store_id=${input.storeId}::uuid AND ((kind='refund' AND status='pending') OR (kind='shift' AND status='open'))`);requireRule(!unresolved.length,'DAY_UNRESOLVED','未完了会計・返品・開局を解消してください');
   const [review]=await rows(transaction,sql`SELECT id FROM device_events WHERE store_id=${input.storeId}::uuid AND status='review' LIMIT 1`);requireRule(!review,'REVIEW_PENDING','要確認イベントを解消してください');
   const [prior]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='day-close' AND store_id=${input.storeId}::uuid AND body->>'day'=${input.day}`);requireRule(!prior,'DAY_ALREADY_CLOSED','店舗日締めは確定済みです');
   return this.createDocument(transaction,actor,'day-close','confirmed',{day:input.day,closedAt:new Date().toISOString()},input.storeId);
  });
 }
 async report(actor:Actor,storeId?:string,from?:string,to?:string) {
  if(storeId)this.access(actor,storeId);if(from)parse(z.iso.date(),from);if(to)parse(z.iso.date(),to);
  return this.database.transaction(actor,async transaction=>{
   await this.contract(transaction,false);
   const sales=await rows(transaction,sql`SELECT * FROM documents WHERE kind='sale' AND (${storeId??null}::uuid IS NULL OR store_id=${storeId??null}::uuid) AND body->>'businessDate'>=${from??'0001-01-01'} AND body->>'businessDate'<=${to??'9999-12-31'}`);
   const refunds=await rows(transaction,sql`SELECT * FROM documents WHERE kind='refund' AND status='confirmed' AND (${storeId??null}::uuid IS NULL OR store_id=${storeId??null}::uuid) AND body->>'businessDate'>=${from??'0001-01-01'} AND body->>'businessDate'<=${to??'9999-12-31'}`);
   const total=sales.reduce<bigint>((sum,sale)=>sum+money(sale.body.total),0n),returned=refunds.reduce<bigint>((sum,refund)=>sum+money(refund.body.total),0n);
   const cost=sales.flatMap(sale=>sale.body.lines).reduce<bigint>((sum,line)=>sum+money(line.cost)*BigInt(line.quantity),0n);
   const tax=sales.flatMap(sale=>sale.body.taxes).reduce<bigint>((sum,entry)=>sum+money(entry.tax),0n);
   let returnedCost=0n;for(const refund of refunds){const sale=await this.document(transaction,refund.body.saleId,'sale');returnedCost+=refund.body.lines.reduce((subtotal:bigint,line:any)=>subtotal+money(sale.body.lines[line.index].cost)*BigInt(line.quantity),0n);}
   const returnedTax=refunds.flatMap(refund=>refund.body.lines).reduce<bigint>((sum,line)=>sum+money(line.taxManagement??'0'),0n);
   return {storeId:storeId??null,from:from??null,to:to??null,total:total.toString(),refunds:returned.toString(),net:(total-returned).toString(),approximateGrossProfit:(total-tax-cost-returned+returnedCost+returnedTax).toString(),grossProfitLabel:'標準原価による概算（返品税額は申告用ではありません）',count:sales.length,
    payments:Object.fromEntries(['cash','card','qr'].map(method=>[method,sales.filter(sale=>sale.body.method===method).reduce((sum,sale)=>sum+money(sale.body.total),0n).toString()])),updatedAt:new Date().toISOString(),link:`/reports?storeId=${storeId??''}&from=${from??''}&to=${to??''}`};
  });
 }
}
