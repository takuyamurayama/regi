import { Injectable } from '@nestjs/common';
import { Actor, rows, sql } from './db';
import { Business } from './service';
import { requireRule } from './errors';
import { z } from 'zod';
@Injectable()
export class Recommendations {
 constructor(private readonly business:Business){}
 async policy(actor:Actor,input:any){
  this.business.access(actor,input.storeId,['admin','headquarters','manager']);
  const policy=z.object({productId:z.uuid(),baseStock:z.number().int().min(0),safetyStock:z.number().int().min(0),leadDays:z.number().int().min(1).max(7),minimum:z.number().int().min(1),multiple:z.number().int().min(1)}).parse(input);
  return this.business.mutation(actor,input,'reorder.policy',input.storeId,async transaction=>{
   const [product]=await rows(transaction,sql`SELECT id FROM products WHERE id=${policy.productId}::uuid`);requireRule(product,'PRODUCT_NOT_FOUND','商品がありません',404);
   return this.business.createDocument(transaction,actor,'reorder-policy','active',policy,input.storeId);
  });
 }
 async list(actor:Actor,storeId:string){
  this.business.access(actor,storeId);
  return this.business.database.transaction(actor,async transaction=>{
   await this.business.contract(transaction,false);const products=await this.business.productSnapshot(transaction);
   const inventory=await rows(transaction,sql`SELECT product_id,sum(quantity)::int AS quantity FROM inventory WHERE store_id=${storeId}::uuid GROUP BY product_id`);
   const orders=await rows(transaction,sql`SELECT body FROM documents WHERE kind='purchase-order' AND store_id=${storeId}::uuid AND status IN ('approved','issued','partial')`);
   const policies=await rows(transaction,sql`SELECT body FROM documents WHERE kind='reorder-policy' AND store_id=${storeId}::uuid ORDER BY created_at DESC`);
   const forecasts=await rows(transaction,sql`SELECT * FROM forecasts WHERE store_id=${storeId}::uuid AND day>CURRENT_DATE ORDER BY day`);
   return products.filter(product=>product.stock_managed).map(product=>{
    const policy=policies.find(record=>record.body.productId===product.id)?.body;
    if(!policy)return {productId:product.id,name:product.name,quantity:0,method:'base-stock-unconfigured',reason:'基準在庫設定が必要です',updatedAt:null};
    const available=forecasts.filter(entry=>entry.product_id===product.id).slice(0,policy.leadDays);
    const fresh=available.length===policy.leadDays&&available.every(entry=>entry.method==='lightgbm'&&Date.now()-new Date(entry.generated_at).getTime()<36*3600000);
    const demand=fresh?available.reduce((sum,entry)=>sum+Number(entry.quantity),0):policy.baseStock;
    const onHand=inventory.find(entry=>entry.product_id===product.id)?.quantity??0;
    const outstanding=orders.flatMap(order=>order.body.lines).filter(line=>line.productId===product.id).reduce((sum,line)=>sum+line.quantity-line.received,0);
    const needed=Math.max(0,Math.ceil(demand+(fresh?policy.safetyStock:0)-onHand-outstanding));
    return {productId:product.id,name:product.name,quantity:needed===0?0:Math.ceil(Math.max(policy.minimum,needed)/policy.multiple)*policy.multiple,method:fresh?'lightgbm':'base-stock',demand,onHand,outstanding,safetyStock:policy.safetyStock,minimum:policy.minimum,multiple:policy.multiple,updatedAt:available[0]?.generated_at??null};
   });
  });
 }
}
