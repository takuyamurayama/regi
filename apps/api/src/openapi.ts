import {OpenAPIObject} from '@nestjs/swagger';
export function enrich(document:OpenAPIObject){
 const identifier={type:'string',format:'uuid'},money={type:'string',pattern:'^(0|[1-9][0-9]{0,29})$',description:'整数円。JSON numberを使用しない。単価・標準原価はsigned bigint範囲。'},quantity={type:'integer',minimum:1,maximum:10000};
 const object=(properties:any,required:string[]=Object.keys(properties))=>({type:'object',properties,required});
 const line=object({productId:identifier,name:{type:'string'},quantity,price:money,discount:money,rateBps:{type:'integer',minimum:0,maximum:10000},cost:money,stockManaged:{type:'boolean'},taxContext:{type:'string',enum:['master','dine-in','takeaway']}},['productId','name','quantity','price','discount','rateBps','cost','stockManaged']);
 const event=object({id:identifier,deviceId:identifier,leaseId:identifier,sequence:{type:'string',pattern:'^[1-9][0-9]{0,17}$'},staffId:identifier,occurredAt:{type:'string',format:'date-time'},ruleVersion:{type:'string',enum:['regi-1']},type:{type:'string',enum:['sale','shift.open','shift.close','cash.move']},body:{type:'object',description:'sale: mode, discount, total, method, tendered/reference, shiftId, lines。shift.open: opening。shift.close: shiftId,actual。cash.move: shiftId,amount,direction,reason。'}});
 document.components??={};document.components.schemas={...document.components.schemas,
  Money:money as any,SaleLine:line as any,DeviceEvent:event as any,
  BusinessError:object({code:{type:'string'},message:{type:'string'},field:{type:'string',nullable:true},retryable:{type:'boolean'},nextAction:{type:'string'}}) as any,
  SyncEvents:object({events:{type:'array',maxItems:100,items:{$ref:'#/components/schemas/DeviceEvent'}}}) as any,
  ProductInput:object({operationId:identifier,sku:{type:'string'},name:{type:'string'},jan:{type:'string',nullable:true},category:{type:'string'},stockManaged:{type:'boolean'},cost:money,price:money,taxCode:{type:'string'},effectiveAt:{type:'string',format:'date-time'},version:{type:'integer',description:'PATCH時は現在の版番号を必須とする。'}},['operationId','sku','name','stockManaged','cost','price','taxCode','effectiveAt']) as any,
  RefundInput:object({operationId:identifier,storeId:identifier,saleId:identifier,reason:{type:'string'},lines:{type:'array',items:object({index:{type:'integer',minimum:0},quantity,restock:{type:'boolean'}})}}) as any,
  RefundConfirm:object({operationId:identifier,storeId:identifier,result:{type:'string',enum:['success','unknown','failed']},reference:{type:'string'},shiftId:{...identifier,description:'現金返金時は支出元の営業中端末開局IDが必須。'}},['operationId','storeId','result']) as any,
  PurchaseInput:object({operationId:identifier,storeId:identifier,supplier:{type:'string'},expectedAt:{type:'string',format:'date'},lines:{type:'array',items:object({productId:identifier,quantity,unitCost:money})}}) as any,
  ReceiptInput:object({operationId:identifier,storeId:identifier,lines:{type:'array',items:object({index:{type:'integer',minimum:0},quantity})}}) as any,
  Operation:object({operationId:identifier,storeId:identifier}) as any,
  Enrollment:object({operationId:identifier,storeId:identifier,name:{type:'string'}}) as any,
  CsvImport:object({operationId:identifier,csv:{type:'string',description:'sku,jan,name,price,cost,taxCode,stockManaged。最大5,000行。'}}) as any,
  Reason:object({operationId:identifier,storeId:identifier,reason:{type:'string'},inventoryIncludedInCount:{type:'boolean',description:'棚卸以前の遅延売上では実査に含まれたか明示必須。'}},['operationId','storeId','reason']) as any,
  Revision:object({operationId:identifier,storeId:identifier,reason:{type:'string'},quantities:{type:'array',items:{type:'integer',minimum:0},description:'全明細の改訂数量。入荷済み数量未満は禁止。'}}) as any,
  Adjustment:object({operationId:identifier,storeId:identifier,productId:identifier,quantity:{type:'integer',minimum:-1000000,maximum:1000000},reason:{type:'string'}}) as any,
  DeviceStatus:object({operationId:identifier,storeId:identifier,stopped:{type:'boolean'},pending:{type:'integer',minimum:0}}) as any,
  StocktakeConfirm:object({operationId:identifier,storeId:identifier,counts:{type:'array',items:object({productId:identifier,quantity:{type:'integer',minimum:0,maximum:1000000}})},reviewEventIds:{type:'array',items:identifier},reason:{type:'string'}},['operationId','storeId','counts']) as any,
  Transfer:object({operationId:identifier,storeId:identifier,toStoreId:identifier,lines:{type:'array',items:object({productId:identifier,quantity})}}) as any,
  Shift:object({operationId:identifier,storeId:identifier,deviceId:identifier,opening:money,pin:{type:'string',pattern:'^\\d{4,8}$'}}) as any,
  ShiftClose:object({operationId:identifier,storeId:identifier,actual:money}) as any,
  Cash:object({operationId:identifier,storeId:identifier,shiftId:identifier,amount:money,direction:{type:'string',enum:['in','out']},reason:{type:'string'}}) as any,
  DayClose:object({operationId:identifier,storeId:identifier,day:{type:'string',format:'date'}}) as any,
  AiQuery:object({operationId:identifier,storeId:identifier,question:{type:'string',maxLength:2000},metric:{type:'string',enum:['sales','payments','profit','inventory','orders','daily']},from:{type:'string',format:'date'},to:{type:'string',format:'date'}},['operationId','storeId','question','metric']) as any,
  Export:object({operationId:identifier,storeId:identifier,format:{type:'string',enum:['csv','bundle','purchase-pdf','receipt-pdf','refund-pdf']},documentId:identifier},['operationId','storeId','format']) as any,
  Settings:object({operationId:identifier,storeId:identifier,name:{type:'string'},subject:{type:'string'},role:{type:'string',enum:['admin','headquarters','manager','cashier']},stores:{type:'array',items:identifier},pin:{type:'string'},staffId:identifier,deviceId:identifier,code:{type:'string'},rateBps:{type:'integer'},effectiveAt:{type:'string',format:'date-time'},mode:{type:'string',enum:['inclusive','exclusive']},proof:{type:'string',description:'販売者Ed25519署名付き契約。任意のreferenceのみでは更新不可。'},sellerName:{type:'string'},storeName:{type:'string'},address:{type:'string'},registered:{type:'boolean'},registrationNumber:{type:'string'},buyerRequired:{type:'boolean'}},['operationId']) as any,
  ReorderPolicy:object({operationId:identifier,storeId:identifier,productId:identifier,baseStock:{type:'integer',minimum:0},safetyStock:{type:'integer',minimum:0},leadDays:{type:'integer',minimum:1,maximum:7},minimum:{type:'integer',minimum:1},multiple:{type:'integer',minimum:1}}) as any
 };
 const mapping:Record<string,string>={'/v1/products':'ProductInput','/v1/products/{id}':'ProductInput','/v1/products/import':'CsvImport','/v1/devices/enroll':'Enrollment','/v1/devices/{id}/status':'DeviceStatus','/v1/sync/events':'SyncEvents','/v1/sync/reviews/{id}/retry':'Reason','/v1/refunds':'RefundInput','/v1/refunds/{id}/confirm':'RefundConfirm','/v1/purchase-orders':'PurchaseInput','/v1/purchase-orders/{id}/receipts':'ReceiptInput','/v1/purchase-orders/{id}/revise':'Revision','/v1/receipts/{id}/cancel':'Reason','/v1/inventory/adjustments':'Adjustment','/v1/stocktakes/{id}/confirm':'StocktakeConfirm','/v1/transfers':'Transfer','/v1/shifts':'Shift','/v1/shifts/{id}/close':'ShiftClose','/v1/cash-movements':'Cash','/v1/day-closes':'DayClose','/v1/ai/query':'AiQuery','/v1/exports':'Export','/v1/settings/{action}':'Settings','/v1/ai/reorder-policy':'ReorderPolicy'};
 for(const [path,item] of Object.entries(document.paths))for(const method of ['post','patch'] as const){const operation=item?.[method];if(!operation)continue;
  if(path!=='/v1/devices/{id}/lease')operation.requestBody={required:true,content:{'application/json':{schema:{$ref:`#/components/schemas/${mapping[path]??'Operation'}`}}}};
  for(const status of ['400','401','403','409','429','503'])operation.responses[status]={description:'業務・認証エラー。operationId/eventIdを変更せず再送。内容変更時は競合。',content:{'application/json':{schema:{$ref:'#/components/schemas/BusinessError'}}}};
 }
 if(document.paths['/health']?.get)document.paths['/health'].get.security=[];
 return document;
}
