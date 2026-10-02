import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { rows, sql } from '../../apps/api/src/db';
import { pinHash } from '../../apps/api/src/service';
import {
  EvidenceActionDtoSchema,
  InvoiceActionDtoSchema,
  InvoiceDtoSchema,
  type InvoiceDraftFields,
} from '../../packages/core/src/finance';
import { japanDateTime } from '../../apps/web/src/finance-ui';
import { financeFixture, postedInvoice } from '../finance-fixture';

test('取消済み原請求から訂正下書きを作成し証拠を再添付しても旧原請求と税額を変更しない', async ({
  page,
}) => {
  test.setTimeout(90000);
  const f = await financeFixture();
  try {
    const { invoice: original, originalBytes } = await postedInvoice(f);
    const voidResponse = await f.request(`/v1/purchase-invoices/${original.id}/void`, {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: original.version,
      effectiveAt: new Date().toISOString(),
      reason: '合成画面試験の原請求訂正',
    });
    expect(voidResponse.status, await voidResponse.clone().text()).toBe(201);
    const prior = InvoiceActionDtoSchema.parse(await voidResponse.json()).invoice;
    await page.addInitScript(
      ({ tenant }) => {
        sessionStorage.setItem('regi-dev-tenant', tenant);
        sessionStorage.setItem('regi-dev-subject', tenant);
      },
      { tenant: f.admin.tenantId },
    );
    await page.goto(`/purchases/invoices/${original.id}?storeId=${f.store}`);
    await expect(page.getByRole('heading', { name: '訂正請求', exact: true })).toBeVisible();
    const savedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/purchase-invoices' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '訂正下書きを作成', exact: true }).click();
    const saved = await savedResponse;
    expect(saved.status(), await saved.text()).toBe(201);
    const savedValue: unknown = await saved.json(),
      corrected = InvoiceDtoSchema.parse(savedValue);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/purchases/invoices/${corrected.id}` &&
        url.searchParams.get('storeId') === f.store,
    );
    const expectedDraft: InvoiceDraftFields = structuredClone(prior.content);
    expectedDraft.sourceEvidenceId = null;
    if (expectedDraft.sourceIdentity?.kind === 'unnumbered')
      expectedDraft.sourceIdentity.sourceEvidenceId = null;
    if (expectedDraft.taxTreatment.mode === 'supplier-stated')
      expectedDraft.taxTreatment.evidenceId = null;
    expect(corrected.predecessorInvoiceId).toBe(original.id);
    expect(corrected.content).toEqual(expectedDraft);
    expect(corrected.evidence).toEqual([]);
    expect(corrected.balance.originalGross).toBeNull();
    expect(corrected.ledger).toEqual([]);
    await expect(
      page.getByRole('button', { name: '買掛 108円を確定', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '元の取消済み請求を開く', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/purchases/invoices/${original.id}` &&
        url.searchParams.get('storeId') === f.store,
    );
    await expect(page.getByRole('button', { name: '訂正下書きを作成', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '訂正先の請求を開く', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/purchases/invoices/${corrected.id}` &&
        url.searchParams.get('storeId') === f.store,
    );
    const proofResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/purchase-invoices/${corrected.id}/evidence` &&
        response.request().method() === 'POST',
    );
    await page.getByLabel('添付ファイル', { exact: true }).setInputFiles({
      name: 'synthetic-corrected-original.pdf',
      mimeType: 'application/pdf',
      buffer: originalBytes,
    });
    await page.getByRole('button', { name: '資料を添付', exact: true }).click();
    const uploaded = await proofResponse;
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const proofValue: unknown = await uploaded.json(),
      proof = EvidenceActionDtoSchema.parse(proofValue);
    expect(proof.evidence.id).not.toBe(original.evidence[0].id);
    await page
      .getByRole('combobox', { name: '原書類の添付', exact: true })
      .selectOption(proof.evidence.id);
    await page
      .getByRole('combobox', { name: '原税額を確認できる資料', exact: true })
      .selectOption(proof.evidence.id);
    await page.getByRole('button', { name: '下書きを保存', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '下書きを保存しました' }),
    ).toBeVisible();
    await page
      .getByLabel('実際の債務計上・取消日時（日本時間）', { exact: true })
      .fill(japanDateTime());
    await page.getByRole('button', { name: '買掛 108円を確定', exact: true }).click();
    await expect(page.locator('.finance-section-header')).toContainText('確定済み');
    const actual = InvoiceDtoSchema.parse(
      await (await f.request(`/v1/purchase-invoices/${corrected.id}?storeId=${f.store}`)).json(),
    );
    expect(actual.revision).toBe(2);
    expect(actual.predecessorInvoiceId).toBe(original.id);
    expect(actual.balance.signedBalance).toBe('108');
    expect(actual.content.sourceIdentity).toEqual(original.content.sourceIdentity);
    expect(actual.preview.taxGroups).toEqual(original.preview.taxGroups);
    const preserved = InvoiceDtoSchema.parse(
      await (await f.request(`/v1/purchase-invoices/${original.id}?storeId=${f.store}`)).json(),
    );
    expect(preserved.content).toEqual(original.content);
    expect(preserved.evidence).toEqual(original.evidence);
    expect(preserved.postedSnapshotSha256).toBe(original.postedSnapshotSha256);
    expect(preserved.ledger).toEqual(prior.ledger);
    expect(preserved.balance.signedBalance).toBe('0');
    expect(preserved.replacementInvoiceId).toBe(actual.id);
    await page.goto(`/purchases/invoices/${original.id}?storeId=${f.store}`);
    await expect(page.getByRole('button', { name: '訂正下書きを作成', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '訂正先の請求を開く', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/purchases/invoices/${actual.id}` &&
        url.searchParams.get('storeId') === f.store,
    );
    const [debits] = await f.database.transaction(f.admin, (tx) =>
      rows<{ count: number }>(
        tx,
        sql`SELECT count(*)::int AS count FROM purchase_ledger WHERE invoice_id=${actual.id}::uuid AND kind='invoice-debit'`,
      ),
    );
    expect(debits.count).toBe(1);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: '.context/ui-acceptance/finance-correction.png',
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test('訂正下書きの作成は取消済み請求の管理者に限り店長と確定済み原請求には表示しない', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await financeFixture();
  try {
    const { invoice } = await postedInvoice(f),
      manager = randomUUID();
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(
        sql`INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash,active) VALUES(${manager}::uuid,${f.admin.tenantId}::uuid,${manager},'訂正権限の合成店長','manager',ARRAY[${f.store}::uuid],${pinHash('1234', manager)},true)`,
      ),
    );
    await page.addInitScript(
      ({ tenant }) => {
        sessionStorage.setItem('regi-dev-tenant', tenant);
        sessionStorage.setItem('regi-dev-subject', tenant);
      },
      { tenant: f.admin.tenantId },
    );
    await page.goto(`/purchases/invoices/${invoice.id}?storeId=${f.store}`);
    await expect(page.locator('.finance-section-header')).toContainText('確定済み');
    await expect(page.getByRole('button', { name: '訂正下書きを作成', exact: true })).toHaveCount(
      0,
    );
    const response = await f.request(`/v1/purchase-invoices/${invoice.id}/void`, {
      operationId: randomUUID(),
      storeId: f.store,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: new Date().toISOString(),
      reason: '合成の訂正権限試験',
    });
    expect(response.status).toBe(201);
    await page.evaluate(({ subject }) => sessionStorage.setItem('regi-dev-subject', subject), {
      subject: manager,
    });
    // Init scripts run on reload, so replace the actor explicitly before a new client document.
    await page.addInitScript(({ subject }) => sessionStorage.setItem('regi-dev-subject', subject), {
      subject: manager,
    });
    await page.reload();
    await expect(page.locator('.finance-section-header')).toContainText('確定取消済み');
    await expect(page.getByRole('button', { name: '訂正下書きを作成', exact: true })).toHaveCount(
      0,
    );
    expect(
      z.object({ actor: z.object({ role: z.literal('manager') }) }).parse(
        await (
          await page.request.get('/v1/settings', {
            headers: { ...f.headers, 'x-staff-subject': manager },
          })
        ).json(),
      ).actor.role,
    ).toBe('manager');
  } finally {
    await f.close();
  }
});
