import {rows,sql,Tx} from './db';
export async function receiptProfile(transaction:Tx,storeId:string,at=new Date()){
 const [tenant]=await rows(transaction,sql`SELECT name FROM tenants`),[store]=await rows(transaction,sql`SELECT name FROM stores WHERE id=${storeId}::uuid`);
 const [profile]=await rows(transaction,sql`SELECT body FROM documents WHERE kind='receipt-profile' AND store_id=${storeId}::uuid AND created_at<=${at} ORDER BY created_at DESC LIMIT 1`);
 return {sellerName:tenant.name,storeName:store.name,address:'',registrationNumber:'',registered:false,buyerRequired:false,...profile?.body};
}
