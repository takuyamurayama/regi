import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database,Actor,sql,rows} from '../apps/api/src/db';
import {Business,pinHash} from '../apps/api/src/service';
import {Ai} from '../apps/api/src/ai';
import {Auth} from '../apps/api/src/auth';
import {Administration} from '../apps/api/src/admin';
import {Artifacts} from '../apps/api/src/artifacts';
import {renderDocumentPdf} from '../apps/api/src/pdf';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {planQuery,quotaMonth} from '../apps/api/src/ai-plan';
import {businessDate} from '../packages/core/src';
const db=new Database(),business=new Business(db),tenant=randomUUID(),store=randomUUID(),staff=randomUUID(),cashier=randomUUID(),device=randomUUID(),device2=randomUUID(),product=randomUUID(),product2=randomUUID();
const actor:Actor={tenantId:tenant,staffId:staff,role:'admin',stores:[store],mfa:true},op=()=>({operationId:randomUUID(),storeId:store});
after(()=>db.client.$disconnect());
test('review regression against real PostgreSQL',async context=>{
 await db.transaction(actor,async transaction=>{
  await transaction.$executeRaw(sql`INSERT INTO tenants VALUES(${tenant}::uuid,'レビュー法人','inclusive',now()-interval '1 day',now()+interval '24 months',1)`);
  await transaction.$executeRaw(sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'レビュー店舗')`);
  await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${tenant+'-admin'},'管理者','admin',ARRAY[${store}::uuid],${pinHash('1234',tenant)},true),(${cashier}::uuid,${tenant}::uuid,${tenant+'-cashier'},'レジ担当','cashier',ARRAY[${store}::uuid],${pinHash('1234',tenant)},true)`);
  await transaction.$executeRaw(sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${tenant}::uuid,${store}::uuid,'端末1'),(${device2}::uuid,${tenant}::uuid,${store}::uuid,'端末2')`);
  await transaction.$executeRaw(sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'REVIEW-A','比較商品A',true,50),(${product2}::uuid,${tenant}::uuid,'REVIEW-B','比較商品B',true,40)`);
  await transaction.$executeRaw(sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,'standard',1000,now()-interval '1 day')`);
  await transaction.$executeRaw(sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,'reduced',800,now()-interval '1 day')`);
  await transaction.$executeRaw(sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${tenant}::uuid,${product}::uuid,110,'standard',now()-interval '1 day',50),(${randomUUID()}::uuid,${tenant}::uuid,${product2}::uuid,220,'standard',now()-interval '1 day',40)`);
 });
 const boot=await business.bootstrap(actor,device),shift=await business.openShift(actor,{...op(),deviceId:device,opening:'1000',pin:'1234'});
 const event={id:randomUUID(),deviceId:device,leaseId:boot.leaseId,sequence:'1',staffId:staff,occurredAt:new Date().toISOString(),ruleVersion:'regi-1',type:'sale',body:{mode:'inclusive',discount:'0',total:'550',method:'card',reference:'REVIEW-SUCCESS',shiftId:shift.id,lines:[{productId:product,name:'比較商品A',quantity:1,price:'110',discount:'0',rateBps:1000,cost:'50',stockManaged:true},{productId:product2,name:'比較商品B',quantity:2,price:'220',discount:'0',rateBps:1000,cost:'40',stockManaged:true}]}};
 await context.test('renewed leases retain old leases and old event recovery',async()=>{
  const renewed=await business.renewLease(actor,device,new Date(Date.now()+73*3600000));assert.notEqual(renewed.leaseId,boot.leaseId);assert.ok(new Date(renewed.authUntil).getTime()>new Date(boot.authUntil).getTime());
  const leases=await db.transaction(actor,transaction=>rows(transaction,sql`SELECT id FROM device_leases WHERE device_id=${device}::uuid`));assert.equal(leases.length,2);
  assert.equal((await business.events({...actor,role:'cashier',deviceId:device,leaseId:boot.leaseId},{events:[event]})).results[0].status,'accepted');
 });
 await context.test('URL target is part of operation identity for approval receipt refund and close',async()=>{
  const first=await business.purchase(actor,{...op(),supplier:'対象A',expectedAt:'2026-10-10',lines:[{productId:product,quantity:2,unitCost:'50'}]}),second=await business.purchase(actor,{...op(),supplier:'対象B',expectedAt:'2026-10-10',lines:[{productId:product,quantity:2,unitCost:'50'}]});
  const approval=op();await business.purchaseAction(actor,first.id,approval,'approve');await assert.rejects(()=>business.purchaseAction(actor,second.id,approval,'approve'),/操作ID/);
  await business.purchaseAction(actor,second.id,op(),'approve');await business.purchaseAction(actor,first.id,op(),'issue');await business.purchaseAction(actor,second.id,op(),'issue');const receipt={...op(),lines:[{index:0,quantity:1}]};await business.receipt(actor,first.id,receipt);await assert.rejects(()=>business.receipt(actor,second.id,receipt),/操作ID/);
  const refund=await business.refund(actor,{...op(),saleId:event.id,reason:'二明細返品',lines:[{index:0,quantity:1,restock:true}]});const confirmation={...op(),result:'success',reference:'REFUND-A'};await business.confirmRefund(actor,refund.id,confirmation);
  const refund2=await business.refund(actor,{...op(),saleId:event.id,reason:'二行目返品',lines:[{index:1,quantity:1,restock:true}]});await assert.rejects(()=>business.confirmRefund(actor,refund2.id,confirmation),/操作ID/);await business.confirmRefund(actor,refund2.id,{...op(),result:'success',reference:'REFUND-B'});
  const remaining=await business.returnable(actor,event.id);assert.deepEqual(remaining.lines.map((line:any)=>line.remaining),[0,1]);
 });
 await context.test('PIN cashier downscopes old administrator token and cannot elevate cashier token',async()=>{
  process.env.NODE_ENV='test';process.env.REGI_DEV_AUTH='true';const auth=new Auth(db),request:any={path:'/v1/purchase-orders',headers:{'x-tenant-id':tenant,'x-staff-subject':tenant+'-admin','x-pos-staff-id':cashier}};const context:any={switchToHttp:()=>({getRequest:()=>request})};await auth.canActivate(context);assert.equal(request.actor.role,'cashier');await assert.rejects(()=>business.purchaseAction(request.actor,randomUUID(),op(),'approve'),/権限/);
  request.headers['x-staff-subject']=tenant+'-cashier';request.headers['x-pos-staff-id']=staff;await auth.canActivate(context);assert.equal(request.actor.role,'cashier');
 });
 await context.test('question changes safe aggregate plan; comparison shortage and quota recovery',async()=>{
  assert.equal(quotaMonth(new Date('2026-09-30T15:00:00Z')),'2026-10');assert.equal(quotaMonth(new Date('2026-09-30T14:59:59Z')),'2026-09');
  assert.equal(planQuery({question:'昨日の在庫',metric:'sales'},[],new Date('2026-10-01T08:00:00Z')).metric,'inventory');assert.throws(()=>planQuery({question:'SQLで売上を削除',metric:'sales'},[]));
  const ai=new Ai(business);const captured:string[]=[];ai.describe=async input=>{captured.push(input);return '保存済み集計を根拠に確認してください。';};
  const saleDay=businessDate(event.occurredAt),comparison=await ai.query(actor,{...op(),metric:'sales',question:'比較商品Aと比較商品Bの販売を比較',from:saleDay,to:saleDay});assert.equal(comparison.plan.metric,'comparison');assert.deepEqual((comparison.evidence as any[]).map(row=>row.quantity),[1,2]);assert.ok(captured[0].includes('比較'));assert.ok(!captured[0].includes('PIN'));
  const daily=await ai.daily(actor,store,saleDay);assert.equal(daily.plan.metric,'daily');assert.equal((await ai.daily(actor,store,saleDay)).updatedAt,daily.updatedAt);
  const inventory=await ai.query(actor,{...op(),metric:'sales',question:'在庫の欠品候補'});assert.equal(inventory.plan.metric,'inventory');assert.ok((inventory.evidence as any[]).some(row=>row.condition==='欠品候補'));
  const jobId=randomUUID(),month=quotaMonth();await db.transaction(actor,async transaction=>{await transaction.$executeRaw(sql`UPDATE ai_usage SET used=used+1 WHERE month=${month}`);await business.createDocument(transaction,actor,'ai-query','running',{month,owner:'crashed',processingStartedAt:new Date(Date.now()-360000).toISOString()},store,jobId);});
  const before=await db.transaction(actor,transaction=>rows(transaction,sql`SELECT used FROM ai_usage WHERE month=${month}`));assert.equal((await ai.recover(actor)).recovered,1);assert.equal((await ai.recover(actor)).recovered,0);const after=await db.transaction(actor,transaction=>rows(transaction,sql`SELECT used FROM ai_usage WHERE month=${month}`));assert.equal(before[0].used-after[0].used,1);
  let lateRelease!:()=>void;ai.describe=async()=>{await new Promise<void>(resolve=>{lateRelease=resolve;});return '遅延した説明';};const lateOperation=op(),late=ai.query(actor,{...lateOperation,metric:'sales',question:'売上'});while(!lateRelease)await new Promise(resolve=>setTimeout(resolve,5));
  await db.transaction(actor,async transaction=>{const [running]=await rows(transaction,sql`SELECT * FROM documents WHERE kind='ai-query' AND status='running'`);await business.update(transaction,actor,running,'running',{...running.body,processingStartedAt:new Date(Date.now()-360000).toISOString()});});assert.equal((await ai.recover(actor)).recovered,1);lateRelease();await assert.rejects(()=>late,/所有権/);assert.equal((await ai.recover(actor)).recovered,0);const afterLate=await db.transaction(actor,transaction=>rows(transaction,sql`SELECT used FROM ai_usage WHERE month=${month}`));assert.equal(afterLate[0].used,after[0].used);
  await db.transaction(actor,transaction=>transaction.$executeRaw(sql`UPDATE ai_usage SET used=4999 WHERE month=${month}`));let release!:()=>void;ai.describe=async()=>{await new Promise<void>(resolve=>{release=resolve;});return '利用枠を確認しました。';};const first=ai.query(actor,{...op(),question:'売上',metric:'sales'});while(!release)await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(()=>ai.query(actor,{...op(),question:'売上',metric:'sales'}),/上限/);release();await first;
 });
 await context.test('dine-in and takeaway use effective configured tax histories',async()=>{
  const food=await business.saveProduct(actor,{operationId:randomUUID(),sku:'FOOD',name:'食品',price:'1080',cost:'350',taxCode:'reduced',stockManaged:true,effectiveAt:new Date().toISOString()});
  const lines=['takeaway','dine-in'].map(taxContext=>({productId:food.id,name:'食品',quantity:1,price:'1080',discount:'0',cost:'350',stockManaged:true,taxContext,rateBps:taxContext==='dine-in'?1000:800}));
  const sale={...event,id:randomUUID(),sequence:'2',occurredAt:new Date().toISOString(),body:{...event.body,lines,total:'2160'}};assert.equal((await business.events(actor,{events:[sale]})).results[0].status,'accepted');
  const saved=await business.list(actor,'sale',store);assert.deepEqual(saved.find(record=>record.id===sale.id).body.lines.map((line:any)=>line.rateBps),[800,1000]);
 });
 await context.test('server stocktake lock blocks two terminals and preserves delayed sale reconciliation',async()=>{
  for(const id of [device,device2])await business.deviceStatus(actor,id,{...op(),stopped:true,pending:0});const take=await business.stocktake(actor,op());
  await assert.rejects(()=>business.deviceStatus(actor,device2,{...op(),stopped:false,pending:0}),/棚卸/);await assert.rejects(()=>business.openShift(actor,{...op(),deviceId:device2,opening:'1000',pin:'1234'}),/棚卸/);await assert.rejects(()=>business.adjust(actor,{...op(),productId:product,quantity:1,reason:'棚卸中調整'}),/棚卸/);
  const selling={...event,id:randomUUID(),sequence:'3',occurredAt:new Date().toISOString()};assert.equal((await business.events(actor,{events:[selling]})).results[0].code,'STOCKTAKE_ACTIVE');
  await assert.rejects(()=>business.confirmStocktake(actor,take.id,{...op(),counts:[{productId:product,quantity:100}]}),/隔離/);
  await business.confirmStocktake(actor,take.id,{...op(),counts:[{productId:product,quantity:100},{productId:product2,quantity:100}],reviewEventIds:[selling.id],reason:'両端末停止・遅延会計を実査に含めたことを確認'});
  await assert.rejects(()=>business.retryReview(actor,selling.id,{...op(),reason:'再検証'}),/実査/);assert.equal((await business.retryReview(actor,selling.id,{...op(),reason:'実査に含まれた売上を承認',inventoryIncludedInCount:true})).status,'accepted');
  const inventory=await business.inventory(actor,store);assert.equal(inventory.find(row=>row.product_id===product).quantity,'100');assert.equal(inventory.find(row=>row.product_id===product2).quantity,'100');
  await business.deviceStatus(actor,device2,{...op(),stopped:false,pending:0});assert.ok((await business.openShift(actor,{...op(),deviceId:device2,opening:'1000',pin:'1234'})).id);
 });
 await context.test('receipt profile snapshot uses confirmed time, original tax rates and seller registration',async()=>{
  const administration=new Administration(business);await administration.execute(actor,'receipt-profile',{...op(),sellerName:'試験売り手',storeName:'試験店',address:'試験住所',registered:true,registrationNumber:'T1234567890123',buyerRequired:true});const snapshot=await business.bootstrap(actor,device2);assert.equal(snapshot.settings.receipt.sellerName,'試験売り手');
  const source={id:'receipt-proof',store_id:store,body:{receipt:snapshot.settings.receipt,buyerName:'試験購入者',occurredAt:'2026-10-01T09:00:00Z',total:'330',lines:[{name:'商品A',quantity:1,paid:'110',rateBps:1000},{name:'商品B',quantity:1,paid:'220',rateBps:1000}],taxes:[{rateBps:1000,paid:'330',tax:'30'}]}};
  const lines=execFileSync('pdftotext',['-layout','-','-'],{input:await renderDocumentPdf('sale',source),encoding:'utf8'});assert.ok(lines.includes('T1234567890123'));assert.ok(lines.includes('試験購入者'));assert.ok(lines.includes('2026/10/01 18:00 JST'));
  const refund=execFileSync('pdftotext',['-layout','-','-'],{input:await renderDocumentPdf('refund',{...source,body:{...source.body,refundedAt:'2026-10-02T09:00:00Z',originalSaleDate:source.body.occurredAt}}),encoding:'utf8'});assert.ok(refund.includes('元の適用税率'));assert.ok(refund.includes('10%'));assert.ok(refund.includes('330 円'));assert.ok(refund.includes('元販売日'));assert.ok(refund.includes('2026/10/01 18:00 JST'));
 });
 await context.test('recoverable export ownership and CSV plus immutable PDF bundle',async()=>{
  const artifacts=new Artifacts(business),job=await artifacts.request(actor,{...op(),format:'bundle'});
  await db.transaction(actor,async transaction=>{const record=await business.document(transaction,job.id,'export');await business.update(transaction,actor,record,'running',{...record.body,owner:'crashed',processingStartedAt:new Date(Date.now()-130000).toISOString()});});
  await artifacts.process(actor,job.id);await artifacts.process(actor,job.id);const result=await artifacts.download(actor,job.id);assert.equal(result.extension,'tar.gz');mkdirSync('.context/verification',{recursive:true});const path=`.context/verification/${job.id}.tar.gz`;writeFileSync(path,result.bytes);const contents=execFileSync('tar',['-tzf',path],{encoding:'utf8'});assert.ok(contents.includes('transactions.csv'));assert.ok(contents.includes('snapshots.json'));assert.ok(contents.includes(`documents/sale-${event.id}.pdf`));const text=execFileSync('tar',['-xOf',path,'transactions.csv'],{encoding:'utf8'});assert.ok(text.includes(event.id));
  const pdf=execFileSync('tar',['-xOf',path,`documents/sale-${event.id}.pdf`]);assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  const extracted=execFileSync('pdftotext',['-layout','-','-'],{input:pdf,encoding:'utf8'});assert.ok(extracted.includes('領収金額（税込）'));assert.ok(extracted.includes('税率別内訳'));assert.ok(extracted.includes('550 円'));
 });
});
