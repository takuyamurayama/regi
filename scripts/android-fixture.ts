import {randomUUID} from 'node:crypto';
import {Database,Actor,sql} from '../apps/api/src/db';
import {pinHash} from '../apps/api/src/service';
import {Prisma} from '@prisma/client';
async function main(){
 if(process.env.NODE_ENV!=='test')throw new Error('Android fixture is local test only');
 const tenant=randomUUID(),admin=randomUUID(),cashier=randomUUID(),product=randomUUID(),keys=['recovery','hold','lease'],stores=keys.map(()=>randomUUID()),devices=keys.map(()=>randomUUID());
 const actor:Actor={tenantId:tenant,staffId:admin,role:'admin',stores,mfa:true},database=new Database();
 try{await database.transaction(actor,async transaction=>{
  await transaction.$executeRaw(sql`INSERT INTO tenants VALUES(${tenant}::uuid,'Android独立試験法人','inclusive',now()-interval '1 day',now()+interval '24 months',1)`);
  for(const [index,store] of stores.entries()){await transaction.$executeRaw(sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,${keys[index]+'試験店'})`);await transaction.$executeRaw(sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${devices[index]}::uuid,${tenant}::uuid,${store}::uuid,${keys[index]+'試験POS'})`);}
  for(const [id,subject,role] of [[admin,tenant+'-admin','admin'],[cashier,tenant+'-cashier','cashier']])await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${id}::uuid,${tenant}::uuid,${subject},${'試験'+role},${role},ARRAY[${Prisma.join(stores.map(store=>sql`${store}::uuid`))}],${pinHash('1234',tenant+'-'+role)},true)`);
  await transaction.$executeRaw(sql`INSERT INTO products(id,tenant_id,sku,jan,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'COFFEE-001','4900000000001','コーヒー豆 200g',true,350)`);
  for(const [code,rate] of [['standard',1000],['reduced',800]])await transaction.$executeRaw(sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,${code},${rate},now()-interval '1 day')`);
  await transaction.$executeRaw(sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${tenant}::uuid,${product}::uuid,1080,'reduced',now()-interval '1 day',350)`);
 });console.log(JSON.stringify({tenant,admin,cashier,adminSubject:tenant+'-admin',cashierSubject:tenant+'-cashier',stores:Object.fromEntries(keys.map((key,index)=>[key,stores[index]])),devices:Object.fromEntries(keys.map((key,index)=>[key,devices[index]]))}));}finally{await database.client.$disconnect();}
}
main().catch(error=>{console.error(error.message);process.exit(1);});
