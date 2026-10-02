import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';

test('PDF作成後に履歴を開き、遅い作成の完了を自動確認して保存できる',async({page})=>{
 const saleId='60000000-0000-4000-8000-000000000001',jobId='70000000-0000-4000-8000-000000000001',storeId='20000000-0000-4000-8000-000000000001';
 let requested=false,polls=0,requests=0;
 const body={format:'receipt-pdf',documentId:saleId};
 await page.route('**/v1/documents/sale?*',route=>route.fulfill({json:[{id:saleId,body:{total:'110',method:'cash',lines:[]}}]}));
 await page.route('**/v1/exports',async route=>{
  requests++;expect(route.request().postDataJSON()).toMatchObject({format:'receipt-pdf',documentId:saleId,storeId});requested=true;
  await route.fulfill({json:{id:jobId,kind:'export',status:'queued',storeId,body}});
 });
 await page.route('**/v1/documents/export?*',route=>{
  if(!requested)return route.fulfill({json:[]});
  polls++;
  if(polls===2)return route.fulfill({status:503,contentType:'text/html',body:'Service unavailable'});
  return route.fulfill({json:[{id:jobId,store_id:storeId,status:polls>=4?'completed':polls===1?'queued':'running',created_at:'2026-10-02T04:00:00Z',body:{...body,...(polls>=4?{extension:'pdf'}:{})}}]});
 });
 const bytes=Buffer.from('%PDF-1.4\nsynthetic-download-regression\n%%EOF');
 await page.route(`**/v1/exports/${jobId}/download`,route=>route.fulfill({contentType:'application/pdf',body:bytes}));
 await page.goto('/?page='+encodeURIComponent('返品・取引'));
 await page.getByRole('button',{name:'再印刷PDF',exact:true}).click();
 const history=page.locator('.export-history'),row=history.locator(`[data-export-id="${jobId}"]`);
 await expect(history).toHaveAttribute('open','');
 await expect(row).toContainText('領収書PDF');
 await expect(history.getByRole('alert')).toContainText('HTTP 503');
 await expect(row).toContainText('作成完了',{timeout:10000});
 await expect(history.getByRole('alert')).toHaveCount(0);
 const completedPolls=polls;
 await page.waitForTimeout(2500);
 expect(polls).toBe(completedPolls);
 expect(requests).toBe(1);
 const downloading=page.waitForEvent('download');
 await row.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
 const download=await downloading;
 expect(await download.failure()).toBeNull();
 expect(download.suggestedFilename()).toBe(`regi-${jobId}.pdf`);
 expect(readFileSync((await download.path())!)).toEqual(bytes);
 await page.route(`**/v1/exports/${jobId}/download`,route=>route.fulfill({status:403,json:{code:'STORE_FORBIDDEN',message:'この店舗の帳票を出力する権限がありません',retryable:false}}));
 await row.getByRole('button',{name:'PDFをダウンロード',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('この店舗の帳票を出力する権限がありません');
});

for(const sample of [
 {format:'csv',extension:'csv',create:'取引CSVを作成',download:'CSVをダウンロード',contentType:'text/csv',bytes:Buffer.from('\ufeff種類,税込金額\r\nsale,110')},
 {format:'bundle',extension:'tar.gz',create:'CSV・保存帳票一式を作成',download:'一式をダウンロード',contentType:'application/gzip',bytes:gzipSync('synthetic-bundle-download')},
])test(`${sample.create}も完了を自動表示して保存できる`,async({page})=>{
 const jobId=crypto.randomUUID(),storeId='20000000-0000-4000-8000-000000000001';let requested=false;
 await page.route('**/v1/exports',async route=>{expect(route.request().postDataJSON().format).toBe(sample.format);requested=true;await route.fulfill({json:{id:jobId,storeId,status:'queued',body:{format:sample.format}}});});
 await page.route('**/v1/documents/export?*',route=>route.fulfill({json:requested?[{id:jobId,store_id:storeId,status:'completed',body:{format:sample.format,extension:sample.extension}}]:[]}));
 await page.route(`**/v1/exports/${jobId}/download`,route=>route.fulfill({contentType:sample.contentType,body:sample.bytes}));
 await page.goto('/');await expect(page.getByLabel('店舗',{exact:true})).toHaveValue(storeId);
 await page.getByRole('button',{name:sample.create,exact:true}).click();
 const row=page.locator(`[data-export-id="${jobId}"]`);await expect(row).toBeVisible();await expect(row).toContainText('作成完了');
 const downloading=page.waitForEvent('download');await row.getByRole('button',{name:sample.download,exact:true}).click();const download=await downloading;
 expect(await download.failure()).toBeNull();expect(download.suggestedFilename()).toBe(`regi-${jobId}.${sample.extension}`);expect(readFileSync((await download.path())!)).toEqual(sample.bytes);
});
