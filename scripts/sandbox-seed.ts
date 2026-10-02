import {createHash,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod';
import {Actor,Database,rows,sql} from '../apps/api/src/db';
import {Business,json,pinHash} from '../apps/api/src/service';
import {Recommendations} from '../apps/api/src/recommendations';
import {businessDate,calculate,RULE_VERSION} from '../packages/core/src';

export const DEMO_VERSION='regi-synthetic-v1';
export const DEMO_DAYS=84;
export const demoCatalog=[
 {sku:'DEMO-COFFEE',name:'【デモ】コーヒー豆 200g',category:'食品',price:1080,cost:350,taxCode:'reduced',stockManaged:true,target:12},
 {sku:'DEMO-TEA',name:'【デモ】紅茶 100g',category:'食品',price:864,cost:280,taxCode:'reduced',stockManaged:true,target:0},
 {sku:'DEMO-RICE',name:'【デモ】お米 2kg',category:'食品',price:1728,cost:600,taxCode:'reduced',stockManaged:true,target:24},
 {sku:'DEMO-BREAD',name:'【デモ】パン',category:'食品',price:216,cost:80,taxCode:'reduced',stockManaged:true,target:6},
 {sku:'DEMO-MUG',name:'【デモ】マグカップ',category:'雑貨',price:1650,cost:550,taxCode:'standard',stockManaged:true,target:80},
 {sku:'DEMO-TOWEL',name:'【デモ】タオル',category:'雑貨',price:1100,cost:400,taxCode:'standard',stockManaged:true,target:5},
 {sku:'DEMO-GIFT',name:'【デモ】ギフトセット',category:'雑貨',price:3300,cost:1200,taxCode:'standard',stockManaged:true,target:2},
 {sku:'DEMO-SERVICE',name:'【デモ】包装サービス',category:'サービス',price:2200,cost:700,taxCode:'standard',stockManaged:false,target:0},
];
export type DemoConfig={tenantId:string;confirmTenant:string;adminSubject:string;adminPin:string;endDay:string;optIn:string};
export function demoId(tenantId:string,key:string){
 const bytes=createHash('sha256').update(`${DEMO_VERSION}:${tenantId}:${key}`).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function validateDemoConfig(input:DemoConfig){
 const config=z.object({tenantId:z.uuid(),confirmTenant:z.uuid(),adminSubject:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),adminPin:z.string().regex(/^\d{6,8}$/),endDay:z.iso.date(),optIn:z.literal('synthetic-only')}).parse(input);
 if(config.tenantId!==config.confirmTenant)throw new Error('SANDBOX_TENANT_CONFIRMATION_REQUIRED');
 if(config.adminPin==='123456'||/^([0-9])\1+$/.test(config.adminPin))throw new Error('SANDBOX_PIN_TOO_WEAK');
 if(config.endDay>=businessDate(new Date().toISOString()))throw new Error('SANDBOX_HISTORY_MUST_END_BEFORE_CURRENT_BUSINESS_DAY');
 return config;
}
export function demoConfigFromEnvironment(environment:NodeJS.ProcessEnv=process.env):DemoConfig{
 const path=environment.REGI_SANDBOX_ADMIN_PIN_FILE;
 if(!path)throw new Error('SANDBOX_PRIVATE_PIN_FILE_REQUIRED');
 const file=statSync(path);
 if(!file.isFile()||(file.mode&0o077)!==0)throw new Error('SANDBOX_PIN_FILE_MUST_BE_PRIVATE');
 return validateDemoConfig({tenantId:environment.REGI_SANDBOX_TENANT_ID??'',confirmTenant:environment.REGI_SANDBOX_CONFIRM_TENANT??'',adminSubject:environment.REGI_SANDBOX_ADMIN_SUBJECT??'',adminPin:readFileSync(path,'utf8').trim(),endDay:environment.REGI_SANDBOX_END_DAY??'',optIn:environment.REGI_SANDBOX_SEED??''});
}
const dayAt=(endDay:string,index:number)=>new Date(Date.parse(endDay+'T00:00:00Z')-(DEMO_DAYS-1-index)*86400000).toISOString().slice(0,10);
const quantityAt=(day:number,product:number,store:number,method:number)=>1+(day+product+store+method)%3+Math.floor(day/21);

export async function seedSandbox(database:Database,input:DemoConfig,onDay?:(completed:number)=>void|Promise<void>){
 const config=validateDemoConfig(input);await database.onModuleInit();
 const tenantId=config.tenantId,id=(key:string)=>demoId(tenantId,key);
 const stores=[id('store:0'),id('store:1')],staffId=id('admin'),actor:Actor={tenantId,staffId,role:'admin',stores,mfa:true};
 const business=new Business(database),recommendations=new Recommendations(business);
 const startDay=dayAt(config.endDay,0),effectiveAt=new Date(startDay+'T00:00:00Z'),revisionAt=new Date(dayAt(config.endDay,42)+'T00:00:00Z');
 const contractStart=new Date(effectiveAt.getTime()-86400000),contractEnd=new Date(config.endDay+'T00:00:00Z');contractEnd.setUTCFullYear(contractEnd.getUTCFullYear()+2);
 const fingerprint=createHash('sha256').update(json({version:DEMO_VERSION,tenantId,adminSubject:config.adminSubject,endDay:config.endDay,days:DEMO_DAYS,catalog:demoCatalog})).digest('hex');
 await database.transaction(actor,async transaction=>{
  const [tenant]=await rows(transaction,sql`SELECT id FROM tenants`);
  if(tenant){
   const [marker]=await rows(transaction,sql`SELECT * FROM documents WHERE id=${id('seed')}::uuid AND kind='demo-seed'`);
   if(marker?.body.fingerprint!==fingerprint)throw new Error('SANDBOX_EXISTING_TENANT_OR_CONFIGURATION_CONFLICT');
   const [staff]=await rows(transaction,sql`SELECT * FROM staff WHERE id=${staffId}::uuid AND subject=${config.adminSubject} AND active AND role='admin'`);
   if(!staff)throw new Error('SANDBOX_ADMIN_IDENTITY_CONFLICT');
   const [salt,hash]=staff.pin_hash.split(':');
   if(!timingSafeEqual(scryptSync(config.adminPin,salt,32),Buffer.from(hash,'hex')))throw new Error('SANDBOX_PIN_CONFLICT');
   return;
  }
  await transaction.$executeRaw(sql`INSERT INTO tenants VALUES(${tenantId}::uuid,'【デモ・架空】REGI サンドボックス法人','inclusive',${contractStart},${contractEnd},1)`);
  for(const [index,storeId] of stores.entries())await transaction.$executeRaw(sql`INSERT INTO stores VALUES(${storeId}::uuid,${tenantId}::uuid,${['【デモ】駅前店','【デモ】公園店'][index]})`);
  await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${staffId}::uuid,${tenantId}::uuid,${config.adminSubject},'【デモ用】管理者','admin',${`{${stores.join(',')}}`}::uuid[],${pinHash(config.adminPin,randomUUID())},true)`);
  await business.createDocument(transaction,actor,'demo-seed','pending',{version:DEMO_VERSION,fingerprint,startDay,endDay:config.endDay,days:DEMO_DAYS,synthetic:true},null,id('seed'));
  for(const [code,rate] of [['standard',1000],['reduced',800]] as const){
   await transaction.$executeRaw(sql`INSERT INTO tax_rates VALUES(${id('tax:'+code)}::uuid,${tenantId}::uuid,${code},${rate},${contractStart})`);
   await business.change(transaction,actor,'tax-rate',id('tax:'+code),{code,rateBps:rate,effectiveAt:contractStart.toISOString()},null);
  }
  for(const [index,product] of demoCatalog.entries()){
   const productId=id('product:'+index),latestCost=product.cost+20;
   await transaction.$executeRaw(sql`INSERT INTO products(id,tenant_id,sku,name,category,stock_managed,cost) VALUES(${productId}::uuid,${tenantId}::uuid,${product.sku},${product.name},${product.category},${product.stockManaged},${latestCost})`);
   for(const [revision,at] of [effectiveAt,revisionAt].entries())await transaction.$executeRaw(sql`INSERT INTO prices VALUES(${id(`price:${index}:${revision}`)}::uuid,${tenantId}::uuid,${productId}::uuid,${product.price+revision*54},${product.taxCode},${at},${product.cost+revision*20})`);
   await business.change(transaction,actor,'product',productId,{id:productId,...product,synthetic:true},null);
  }
  for(const [index,storeId] of stores.entries()){
   await transaction.$executeRaw(sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${id('device:'+index)}::uuid,${tenantId}::uuid,${storeId}::uuid,${`【デモ】合成履歴端末 ${index+1}`})`);
   const profile={sellerName:'【デモ・架空】REGI サンドボックス法人',storeName:['【デモ】駅前店','【デモ】公園店'][index],address:'架空の店舗・実在の所在地ではありません',registered:false,registrationNumber:'',buyerRequired:false};
   await transaction.$executeRaw(sql`INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id,created_at) VALUES(${id('profile:'+index)}::uuid,${tenantId}::uuid,${storeId}::uuid,'receipt-profile','active',${json(profile)}::jsonb,${staffId}::uuid,${contractStart})`);
   await business.change(transaction,actor,'receipt-profile',id('profile:'+index),profile,storeId);
  }
  for(let index=0;index<2;index++)await business.createDocument(transaction,actor,'supplier','active',{name:['【デモ・架空】食品卸','【デモ・架空】生活雑貨卸'][index],contact:'架空データ・連絡先なし',synthetic:true},null,id('supplier:'+index));
 });
 for(const [storeIndex,storeId] of stores.entries()){
  const deviceId=id('device:'+storeIndex);
  for(const [productIndex,product] of demoCatalog.entries())if(product.stockManaged){
   let sold=0;for(let day=0;day<DEMO_DAYS;day++)for(let method=0;method<3;method++)sold+=quantityAt(day,productIndex,storeIndex,method);
   await business.adjust(actor,{operationId:id(`opening-stock:${storeIndex}:${productIndex}`),storeId,productId:id('product:'+productIndex),quantity:sold+product.target,reason:'【デモ・架空】合成履歴の開始在庫'});
   await recommendations.policy(actor,{operationId:id(`policy:${storeIndex}:${productIndex}`),storeId,productId:id('product:'+productIndex),baseStock:productIndex===4?20:60,safetyStock:6,leadDays:3,minimum:6,multiple:6});
  }
  for(let dayIndex=0;dayIndex<DEMO_DAYS;dayIndex++){
   const day=dayAt(config.endDay,dayIndex),leaseId=id(`lease:${storeIndex}:${day}`),shiftId=id(`shift:${storeIndex}:${day}`);
   await database.transaction(actor,async transaction=>{
    const [prior]=await rows(transaction,sql`SELECT id FROM device_leases WHERE id=${leaseId}::uuid`);
    if(!prior){
     const [profile]=await rows(transaction,sql`SELECT body FROM documents WHERE id=${id('profile:'+storeIndex)}::uuid`);
     await transaction.$executeRaw(sql`INSERT INTO device_leases(id,tenant_id,store_id,device_id,issued_at,auth_until,contract_until,price_mode,receipt) VALUES(${leaseId}::uuid,${tenantId}::uuid,${storeId}::uuid,${deviceId}::uuid,${new Date(Date.parse(day+'T00:00:00Z')-3600000)},${new Date(Date.parse(day+'T00:00:00Z')+23*3600000)},${contractEnd},'inclusive',${json(profile.body)}::jsonb)`);
    }
    const eventBase={deviceId,leaseId,staffId,ruleVersion:RULE_VERSION};
    await business.terminalEvent(transaction,actor,{...eventBase,id:shiftId,sequence:String(dayIndex*5+1),occurredAt:day+'T00:00:00.000Z',type:'shift.open',body:{opening:'20000'}});
    let cash=20000n;
    for(const [methodIndex,method] of ['cash','card','qr'].entries()){
     const lines=demoCatalog.map((product,productIndex)=>({productId:id('product:'+productIndex),name:product.name,quantity:quantityAt(dayIndex,productIndex,storeIndex,methodIndex),price:String(product.price+(dayIndex>=42?54:0)),cost:String(product.cost+(dayIndex>=42?20:0)),discount:'0',rateBps:product.taxCode==='reduced'?800:1000,stockManaged:product.stockManaged}));
     const discount=String((dayIndex%7)*11),calculated=calculate(lines,discount,'inclusive');if(method==='cash')cash+=BigInt(calculated.total);
     await business.sale(transaction,actor,{...eventBase,id:id(`sale:${storeIndex}:${day}:${method}`),sequence:String(dayIndex*5+methodIndex+2),occurredAt:day+['T02:00:00.000Z','T09:00:00.000Z','T12:00:00.000Z'][methodIndex],type:'sale',body:{mode:'inclusive',discount,total:calculated.total,method:method as 'cash'|'card'|'qr',tendered:calculated.total,reference:`SYNTHETIC-NOT-A-PAYMENT-${day}-${method}`,shiftId,lines}});
    }
    await business.terminalEvent(transaction,actor,{...eventBase,id:id(`close:${storeIndex}:${day}`),sequence:String(dayIndex*5+5),occurredAt:day+'T14:00:00.000Z',type:'shift.close',body:{shiftId,actual:cash.toString()}});
   });
   await business.dayClose(actor,{operationId:id(`day-close:${storeIndex}:${day}`),storeId,day});
   await onDay?.(storeIndex*DEMO_DAYS+dayIndex+1);
  }
  const supplier='【デモ・架空】食品卸';
  for(const kind of ['draft','outstanding','received']){
   const order=await business.purchase(actor,{operationId:id(`purchase:${storeIndex}:${kind}`),storeId,supplier,expectedAt:new Date(Date.parse(config.endDay+'T00:00:00Z')+7*86400000).toISOString().slice(0,10),lines:[{productId:id('product:1'),quantity:30,unitCost:'300'},{productId:id('product:3'),quantity:30,unitCost:'100'}]});
   if(kind!=='draft'){
    await business.purchaseAction(actor,order.id,{operationId:id(`approve:${storeIndex}:${kind}`),storeId},'approve');
    await business.purchaseAction(actor,order.id,{operationId:id(`issue:${storeIndex}:${kind}`),storeId},'issue');
    await business.receipt(actor,order.id,{operationId:id(`receipt:${storeIndex}:${kind}`),storeId,lines:kind==='received'?[{index:0,quantity:30},{index:1,quantity:30}]:[{index:1,quantity:10}]});
   }
  }
  const confirmed=await business.refund(actor,{operationId:id('refund:'+storeIndex),storeId,saleId:id(`sale:${storeIndex}:${config.endDay}:card`),reason:'【デモ・架空】返品・返金・再入庫の操作例',lines:[{index:0,quantity:1,restock:true},{index:1,quantity:1,restock:false}]});
  await business.confirmRefund(actor,confirmed.id,{operationId:id('refund-confirm:'+storeIndex),storeId,result:'success',reference:'SYNTHETIC-NOT-A-REFUND'});
  await business.refund(actor,{operationId:id('pending-refund:'+storeIndex),storeId,saleId:id(`sale:${storeIndex}:${config.endDay}:qr`),reason:'【デモ・架空】外部返金の確認待ち例',lines:[{index:2,quantity:1,restock:true}]});
 }
 await database.transaction(actor,async transaction=>{
  const marker=await business.document(transaction,id('seed'),'demo-seed');
  if(marker.status!=='completed')await business.update(transaction,actor,marker,'completed',{...marker.body,completedAt:new Date().toISOString()});
 });
 const counts=await database.transaction(actor,async transaction=>({
  products:(await rows(transaction,sql`SELECT count(*)::int AS count FROM products`))[0].count,
  documents:await rows(transaction,sql`SELECT kind,status,count(*)::int AS count FROM documents GROUP BY kind,status ORDER BY kind,status`),
  inventoryMovements:(await rows(transaction,sql`SELECT count(*)::int AS count FROM inventory`))[0].count,
  events:(await rows(transaction,sql`SELECT count(*)::int AS count FROM device_events`))[0].count,
 }));
 return {synthetic:true,version:DEMO_VERSION,tenantId,staffId,storeIds:stores,deviceIds:stores.map((_,index)=>id('device:'+index)),startDay,endDay:config.endDay,days:DEMO_DAYS,counts};
}
if(require.main===module){
 const database=new Database();
 Promise.resolve().then(()=>seedSandbox(database,demoConfigFromEnvironment())).then(result=>console.log(json(result))).catch(()=>{console.error('Sandbox seed failed. Check explicit opt-in, private PIN file, tenant/subject ownership, configuration and DB migrations. No credentials are logged.');process.exitCode=1;}).finally(()=>database.client.$disconnect());
}
