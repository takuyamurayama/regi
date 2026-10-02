import {test,expect} from '@playwright/test';
import {Database,rows,sql} from '../../apps/api/src/db';
import {admin} from '../../scripts/seed';
test('AI shows JST quota, returns failed connection quota and keeps sales usable',async({page})=>{
 const database=new Database();
 const usage=()=>database.transaction(admin,async transaction=>{const records=await rows(transaction,sql`SELECT coalesce(sum(used),0)::text AS used FROM ai_usage`);return records[0].used;});
 try{
  const before=await usage();await page.goto('/');await page.getByRole('button',{name:'AI・需要予測',exact:false}).click();
  await expect(page.getByText(/日本時間の暦月ごとに5,000回/)).toBeVisible();
  await page.getByLabel('AI質問',{exact:true}).fill('今月の売上を説明');await page.getByRole('button',{name:'照会する',exact:true}).click();
  await expect(page.getByText(/AI_UNCONNECTED/)).toBeVisible();expect(await usage()).toBe(before);
  await page.screenshot({path:'.context/web-ai.png',fullPage:true});
  await page.getByRole('button',{name:'ダッシュボード',exact:false}).click();await expect(page.getByText('店舗の現在地を、ひと目で。')).toBeVisible();
 }finally{await database.client.$disconnect();}
});
