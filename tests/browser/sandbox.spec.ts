import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {businessDate} from '../../packages/core/src';

test('架空データを明示し、今日のゼロ売上から84日間の実デモ集計と予測へ進める',async({page,request})=>{
 test.setTimeout(120000);
 const fixture=JSON.parse(execFileSync('npx',['tsx','scripts/sandbox-web-fixture.ts'],{encoding:'utf8',env:{...process.env,NODE_ENV:'test'}}));
 const headers={'x-tenant-id':fixture.tenantId,'x-staff-subject':fixture.adminSubject};
 await page.addInitScript(({tenantId,adminSubject})=>{sessionStorage.setItem('regi-dev-tenant',tenantId);sessionStorage.setItem('regi-dev-subject',adminSubject);},{tenantId:fixture.tenantId,adminSubject:fixture.adminSubject});
 await page.goto('/');
 await expect(page.locator('.metric strong').first()).toHaveText('¥0');
 const banner=page.getByRole('region',{name:'架空データの検証環境'});
 await expect(banner).toContainText('実在の販売実績ではありません');await expect(banner).toContainText('84日分');
 await expect(page.getByLabel('開始日',{exact:true})).toHaveValue(businessDate(new Date().toISOString()));
 await banner.getByRole('button',{name:'デモ期間を表示',exact:true}).click();
 await expect(page.getByLabel('開始日',{exact:true})).toHaveValue(fixture.startDay);
 await expect(page.getByLabel('終了日',{exact:true})).toHaveValue(fixture.endDay);
 const response=await request.get(`/v1/reports/sales?storeId=${fixture.storeIds[0]}&from=${fixture.startDay}&to=${fixture.endDay}`,{headers});
 expect(response.ok()).toBe(true);const report=await response.json();expect(report.count).toBe(252);
 await expect(page.locator('.metric strong').first()).toHaveText('¥'+BigInt(report.total).toLocaleString('ja-JP'));
 await expect(page.locator('.metric strong').nth(3)).toHaveText('252 件');
 await page.screenshot({path:'.context/aws-sandbox-demo-local.png',fullPage:true});
 await page.getByRole('navigation',{name:'本部メニュー'}).getByRole('button',{name:'AI・需要予測',exact:true}).click();
 await expect(page.getByRole('heading',{name:'翌7日需要予測',exact:true})).toBeVisible();
 await expect(page.locator('tbody tr')).toHaveCount(49);
 await expect(page.getByText(/履歴不足・精度不足は基準在庫方式/)).toBeVisible();
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('HTML504は生の解析エラーでなく、起動待ちと再読み込みの案内を表示する',async({page})=>{
 await page.route('**/v1/settings',route=>route.fulfill({status:504,contentType:'text/html',body:'<html>Gateway timeout</html>'}));
 await page.goto('/');
 await expect(page.getByRole('alert')).toContainText('HTTP 504');
 await expect(page.getByRole('alert')).toContainText('Macの起動コマンド');
 await expect(page.getByRole('alert')).toContainText('数分待って再読み込み');
 await expect(page.getByRole('alert')).not.toContainText('Unexpected token');
});
