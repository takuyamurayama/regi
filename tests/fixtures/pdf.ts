import {calculate} from '../../packages/core/src';
const profile={sellerName:'サンプル食堂 株式会社',storeName:'丸の内店（架空の検証用店舗）',address:'東京都千代田区丸の内 1-2-3',registered:true,registrationNumber:'T1234567890123',buyerRequired:false};
export const receipt={id:'06ac25b8-54c1-487c-bd12-c5a8714c03bb',store_id:'sample-store',body:{
 ...calculate([{productId:'takeaway',name:'季節のお弁当',quantity:1,price:'1080',discount:'0',rateBps:800,cost:'400',stockManaged:true,taxContext:'takeaway'},{productId:'lunch',name:'本日のランチセット',quantity:1,price:'1100',discount:'0',rateBps:1000,cost:'450',stockManaged:true,taxContext:'dine-in'}],'0','inclusive'),
 receipt:profile,occurredAt:'2026-10-02T04:00:00Z',buyerName:'',method:'cash',tendered:'3000'
}};
export const purchase={id:'bfc72896-cbca-4448-a40d-6321fdb6af35',store_id:'sample-store',body:{supplier:'変更後の仕入先',lines:[{name:'変更済み商品',quantity:999,unitCost:'99999'}],issuedSnapshot:{receipt:profile,supplier:'サンプル青果',issuedAt:'2026-10-02T02:30:00Z',expectedAt:'2026-10-05',lines:[{name:'国産トマト（1箱）',quantity:2,unitCost:'1200'},{name:'季節の葉物野菜（1袋）',quantity:4,unitCost:'300'}]}}};
export const refund={id:'6a3497f3-c3c2-4cfa-86e8-a3ca5e6fa342',store_id:'sample-store',body:{receipt:profile,saleId:receipt.id,buyerName:'',method:'cash',originalSaleDate:receipt.body.occurredAt,refundedAt:'2026-10-03T05:00:00Z',reason:'数量の訂正',total:'1080',lines:[{name:'季節のお弁当',quantity:1,paid:'1080',rateBps:800}]}};
