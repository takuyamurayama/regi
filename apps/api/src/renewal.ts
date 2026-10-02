import {createPublicKey,verify} from 'node:crypto';
import {z} from 'zod';
import {requireRule} from './errors';
export const renewalSchema=z.object({tenantId:z.uuid(),reference:z.string().min(1).max(200),months:z.literal(12),priceExTax:z.literal('2400000'),expiresAt:z.iso.datetime()}).strict();
export function verifyRenewal(token:string,tenantId:string){
 requireRule(typeof token==='string'&&token.length<10000,'RENEWAL_PROOF','販売者の署名付き更新契約が必要です',403);
 const publicKey=process.env.RENEWAL_PUBLIC_KEY;requireRule(publicKey,'RENEWAL_CONFIG','販売者の公開鍵が未設定です',503);
 const [payload,signature,...extra]=token.split('.');requireRule(payload&&signature&&!extra.length,'RENEWAL_PROOF','更新契約形式が不正です',403);
 let proof:z.infer<typeof renewalSchema>;
 try{requireRule(verify(null,Buffer.from(payload),createPublicKey(publicKey),Buffer.from(signature,'base64url')),'RENEWAL_PROOF','販売者署名を検証できません',403);proof=renewalSchema.parse(JSON.parse(Buffer.from(payload,'base64url').toString()));}catch{requireRule(false,'RENEWAL_PROOF','販売者署名・更新内容を検証できません',403);}
 requireRule(proof!.tenantId===tenantId&&Date.parse(proof!.expiresAt)>Date.now(),'RENEWAL_PROOF','更新契約の法人・有効期限が異なります',403);return proof!;
}
