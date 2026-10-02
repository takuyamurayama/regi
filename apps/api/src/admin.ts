import { Injectable } from '@nestjs/common';
import { Actor, rows, sql } from './db';
import { Business, pinHash } from './service';
import { requireRule } from './errors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {verifyRenewal} from './renewal';
import {hasAdministratorAuthentication} from './admin-authentication';
@Injectable()
export class Administration {
 constructor(private readonly business:Business){}
 async execute(actor:Actor,action:string,input:any){
  requireRule(await hasAdministratorAuthentication(this.business.database,actor),'ADMIN_REQUIRED','環境の認証要件を満たす法人管理者のみ操作できます',403);
  return this.business.mutation(actor,input,`admin.${action}`,null,async transaction=>{
   if(action==='receipt-profile'){
    const data=z.object({storeId:z.uuid(),sellerName:z.string().min(1).max(200),storeName:z.string().min(1).max(200),address:z.string().max(300),registered:z.boolean(),registrationNumber:z.string().max(14),buyerRequired:z.boolean()}).parse(input);this.business.access(actor,data.storeId);requireRule(!data.registered||/^T\d{13}$/.test(data.registrationNumber),'REGISTRATION_NUMBER','登録事業者の登録番号はTと13桁です',400);
    return this.business.createDocument(transaction,actor,'receipt-profile','active',{...data,registrationNumber:data.registered?data.registrationNumber:''},data.storeId);
   }
   if(action==='store'){
    const data=z.object({name:z.string().min(1).max(100)}).parse(input);const [count]=await rows(transaction,sql`SELECT count(*)::int AS count FROM stores`);requireRule(count.count<5,'STORE_LIMIT','最大5店舗です');
    const id=randomUUID();await transaction.$executeRaw(sql`INSERT INTO stores VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.name})`);return {id,...data};
   }
   if(action==='staff'){
    const data=z.object({name:z.string().min(1).max(100),subject:z.string().min(1).max(200),role:z.enum(['admin','headquarters','manager','cashier']),stores:z.array(z.uuid()).min(1),pin:z.string().regex(/^\d{4,8}$/)}).parse(input);
    const [count]=await rows(transaction,sql`SELECT count(*)::int AS count FROM staff WHERE active`);requireRule(count.count<100,'STAFF_LIMIT','最大100名です');
    for(const store of data.stores){const [existing]=await rows(transaction,sql`SELECT id FROM stores WHERE id=${store}::uuid`);requireRule(existing,'STORE_NOT_FOUND','店舗が存在しません',404);}
    const id=randomUUID();await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.subject},${data.name},${data.role},${`{${data.stores.join(',')}}`}::uuid[],${pinHash(data.pin,randomUUID())},true)`);
    return {id,name:data.name,role:data.role,stores:data.stores};
   }
   if(action==='tax-rate'){
    const data=z.object({code:z.string().min(1).max(50),rateBps:z.number().int().min(0).max(10000),effectiveAt:z.iso.datetime()}).parse(input);
    requireRule(Date.parse(data.effectiveAt)>Date.now(),'PAST_TAX_CHANGE','税率履歴の遡及変更はできません',400);
    const id=randomUUID();await transaction.$executeRaw(sql`INSERT INTO tax_rates VALUES(${id}::uuid,${actor.tenantId}::uuid,${data.code},${data.rateBps},${new Date(data.effectiveAt)})`);await this.business.change(transaction,actor,'tax-rate',id,data,null);return {id,...data};
   }
   if(action==='renew-contract'){
    const data=verifyRenewal(input.proof,actor.tenantId);
    const [prior]=await rows(transaction,sql`SELECT id FROM documents WHERE kind='contract-renewal' AND body->>'reference'=${data.reference}`);requireRule(!prior,'CONTRACT_REFERENCE_USED','同じ更新契約は登録済みです');
    const [tenant]=await rows(transaction,sql`SELECT * FROM tenants FOR UPDATE`);const ends=new Date(Math.max(Date.now(),new Date(tenant.ends_at).getTime()));ends.setUTCFullYear(ends.getUTCFullYear()+1);
    await transaction.$executeRaw(sql`UPDATE tenants SET ends_at=${ends},version=version+1`);
    return this.business.createDocument(transaction,actor,'contract-renewal','confirmed',{reference:data.reference,priorEnd:tenant.ends_at,endsAt:ends.toISOString(),months:12,priceExTax:'2400000'},null);
   }
   if(action==='price-mode'){
    const data=z.object({mode:z.enum(['inclusive','exclusive'])}).parse(input);const [count]=await rows(transaction,sql`SELECT count(*)::int AS count FROM documents WHERE kind='sale'`);requireRule(count.count===0,'PRICE_MODE_FROZEN','販売開始後の価格入力方式変更はできません');
    await transaction.$executeRaw(sql`UPDATE tenants SET price_mode=${data.mode},version=version+1`);return data;
   }
   if(action==='revoke-staff'){
    const data=z.object({staffId:z.uuid(),reason:z.string().min(1)}).parse(input);requireRule(data.staffId!==actor.staffId,'SELF_REVOKE','自身を無効化できません');
    await transaction.$executeRaw(sql`UPDATE staff SET active=false WHERE id=${data.staffId}::uuid`);return {id:data.staffId,active:false};
   }
   requireRule(false,'ADMIN_ACTION','設定操作が不正です',400);
  },action==='renew-contract');
 }
}
