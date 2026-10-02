import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { rows, sql, type Actor } from '../apps/api/src/db';
import { pinHash } from '../apps/api/src/service';
import * as F from '../packages/core/src/finance';
import { financeFixture, postedInvoice } from './finance-fixture';

type Fixture = Awaited<ReturnType<typeof financeFixture>>;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const errorSchema = z.object({ code: z.string(), retryable: z.boolean() });
const changesSchema = z.object({
  cursor: z.string(),
  changes: z.array(
    z.object({
      cursor: z.string(),
      kind: z.string(),
      entity_id: z.uuid(),
      body: z.record(z.string(), z.unknown()),
    }),
  ),
});

async function readInvoice(fixture: Fixture, id: string) {
  const response = await fixture.request(`/v1/purchase-invoices/${id}?storeId=${fixture.store}`);
  assert.equal(response.status, 200, await response.clone().text());
  return F.InvoiceDtoSchema.parse(await response.json());
}
async function draftInvoice(fixture: Fixture) {
  const supplierResponse = await fixture.request('/v1/suppliers', {
    operationId: randomUUID(),
    code: 'SECURITY-' + randomUUID(),
    name: '金融境界の合成仕入先',
    address: '合成試験の架空住所',
    registered: false,
    registrationNumber: null,
    defaultDueDays: 30,
    active: true,
  });
  assert.equal(supplierResponse.status, 201, await supplierResponse.clone().text());
  const supplier = F.SupplierDtoSchema.parse(await supplierResponse.json()),
    day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const draft: F.InvoiceDraftFields = {
    sourceKind: 'buyer-statement',
    sourceIdentity: { kind: 'numbered', invoiceNumber: '合成境界-' + randomUUID() },
    sourceEvidenceId: null,
    invoiceDate: day,
    dueDate: day,
    sourceReceivedDate: null,
    sourceReceivedAt: null,
    transactionFrom: day,
    transactionTo: day,
    seller: {
      name: supplier.name,
      address: supplier.address,
      registered: false,
      registrationNumber: null,
    },
    buyer: { name: '合成試験の架空購入法人', address: '' },
    priceMode: 'inclusive',
    rounding: 'floor',
    taxTreatment: { mode: 'computed' },
    lines: [
      {
        lineNo: 1,
        name: '合成境界の仕入明細',
        productId: fixture.product,
        transactionDate: day,
        quantity: 1,
        unitAmount: '108',
        discountAmount: '0',
        taxCategory: 'taxable',
        rateBps: 800,
        reducedTarget: true,
        receiptAllocations: [],
        unmatchedReason: '合成境界試験、実入荷は作成しない',
      },
    ],
    note: '合成試験。実原資料・実顧客取引ではない',
  };
  const response = await fixture.request('/v1/purchase-invoices', {
    operationId: randomUUID(),
    storeId: fixture.store,
    supplierId: supplier.id,
    predecessorInvoiceId: null,
    draft,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return F.InvoiceDtoSchema.parse(await response.json());
}
function uploadHeaders(fixture: Fixture, invoice: F.InvoiceDto, operationId = randomUUID()) {
  return {
    ...fixture.headers,
    'content-type': 'image/png',
    'x-regi-operation-id': operationId,
    'x-regi-store-id': fixture.store,
    'x-regi-invoice-version': String(invoice.version),
    'x-regi-evidence-name': 'synthetic-security.png',
    'x-regi-evidence-role': 'supporting',
    'x-regi-evidence-method': 'uploaded-original',
  };
}
async function upload(
  fixture: Fixture,
  invoice: F.InvoiceDto,
  bytes: Uint8Array = png,
  headers = uploadHeaders(fixture, invoice),
) {
  return fetch(fixture.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence', {
    method: 'POST',
    headers,
    body: new Uint8Array(bytes),
  });
}
function chunkedUpload(fixture: Fixture, invoice: F.InvoiceDto, bytes: Buffer) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = httpRequest(
      fixture.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence',
      { method: 'POST', headers: uploadHeaders(fixture, invoice) },
      (response) => {
        request.end();
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: response.statusCode ?? 0, body });
          } catch (caught: unknown) {
            reject(
              caught instanceof Error ? caught : new Error('The upload response was not JSON'),
            );
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('413 response was not received')));
    // Keep the chunked stream open when its size crosses the cap; terminate only after a response.
    request.write(bytes.subarray(0, png.length));
    request.write(bytes.subarray(png.length));
  });
}
async function staff(fixture: Fixture, role: 'cashier' | 'manager') {
  const id = randomUUID();
  await fixture.database.transaction(fixture.admin, (tx) =>
    tx.$executeRaw(
      sql`INSERT INTO staff(id,tenant_id,subject,name,role,stores,pin_hash,active) VALUES(${id}::uuid,${fixture.admin.tenantId}::uuid,${id},'金融境界試験担当者',${role},ARRAY[${fixture.store}::uuid],${pinHash('1234', id)},true)`,
    ),
  );
  const actor: Actor = { ...fixture.admin, staffId: id, role, mfa: false };
  const request = (path: string, body?: unknown) =>
    fetch(fixture.api.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...fixture.headers, 'x-staff-subject': id, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { actor, request };
}
async function evidenceFacts(fixture: Fixture, invoiceId: string) {
  const [facts] = await fixture.database.transaction(fixture.admin, (tx) =>
    rows<{ evidence: number; debit: number }>(
      tx,
      sql`SELECT (SELECT count(*)::int FROM purchase_evidence WHERE invoice_id=${invoiceId}::uuid) AS evidence,(SELECT count(*)::int FROM purchase_ledger WHERE invoice_id=${invoiceId}::uuid AND kind='invoice-debit') AS debit`,
    ),
  );
  assert.ok(facts);
  return facts;
}

void test('HTTP financial roles and app FORCE RLS restrict posted invoices and evidence to the authenticated tenant and store', async () => {
  const f = await financeFixture();
  try {
    const { invoice, evidence, originalBytes } = await postedInvoice(f),
      manager = await staff(f, 'manager'),
      cashier = await staff(f, 'cashier'),
      otherStore = randomUUID();
    await f.database.transaction(f.admin, (tx) =>
      tx.$executeRaw(
        sql`INSERT INTO stores VALUES(${otherStore}::uuid,${f.admin.tenantId}::uuid,'担当外の合成店舗')`,
      ),
    );
    const read = await manager.request(`/v1/purchase-invoices/${invoice.id}?storeId=${f.store}`);
    assert.equal(read.status, 200);
    const visible = F.InvoiceDtoSchema.parse(await read.json());
    assert.equal(visible.balance.signedBalance, '108');
    assert.equal(visible.permissions.canPay, false);
    assert.equal(visible.permissions.canVoid, false);
    const managerDownload = await manager.request(
      evidence.evidence.downloadPath + '?storeId=' + f.store,
    );
    assert.equal(managerDownload.status, 200);
    assert.deepEqual(Buffer.from(await managerDownload.arrayBuffer()), originalBytes);
    for (const actor of [manager, cashier]) {
      const post = await actor.request('/v1/purchase-invoices/' + invoice.id + '/post', {
        operationId: randomUUID(),
        storeId: f.store,
        expectedInvoiceVersion: invoice.version,
        effectiveAt: new Date().toISOString(),
        reason: null,
        taxVarianceAcceptance: null,
      });
      assert.equal(post.status, 403);
      assert.equal(errorSchema.parse(await post.json()).code, 'ROLE_FORBIDDEN');
      const pay = await actor.request('/v1/purchase-payments', {
        operationId: randomUUID(),
        storeId: f.store,
        invoiceId: invoice.id,
        expectedInvoiceVersion: invoice.version,
        amount: '1',
        paidAt: new Date().toISOString(),
        method: 'cash',
        reference: null,
        evidenceId: null,
        note: '',
      });
      assert.equal(pay.status, 403);
    }
    assert.equal(
      (await cashier.request(`/v1/purchase-invoices/${invoice.id}?storeId=${f.store}`)).status,
      403,
    );
    assert.equal(
      (await cashier.request(evidence.evidence.downloadPath + '?storeId=' + f.store)).status,
      403,
    );
    assert.equal(
      (await manager.request(`/v1/purchase-invoices/${invoice.id}?storeId=${otherStore}`)).status,
      403,
    );
    assert.equal(
      (await manager.request(evidence.evidence.downloadPath + '?storeId=' + otherStore)).status,
      403,
    );
    const scopes: [Actor, number][] = [
      [manager.actor, 1],
      [cashier.actor, 0],
      [{ ...manager.actor, stores: [otherStore] }, 0],
      [{ ...f.admin, tenantId: randomUUID() }, 0],
    ];
    for (const [actor, count] of scopes) {
      const [facts] = await f.database.transaction(actor, (tx) =>
        rows<{ invoices: number; evidence: number; ledger: number }>(
          tx,
          sql`SELECT (SELECT count(*)::int FROM purchase_invoices WHERE id=${invoice.id}::uuid) AS invoices,(SELECT count(*)::int FROM purchase_evidence WHERE invoice_id=${invoice.id}::uuid) AS evidence,(SELECT count(*)::int FROM purchase_ledger WHERE invoice_id=${invoice.id}::uuid) AS ledger`,
        ),
      );
      assert.deepEqual(facts, { invoices: count, evidence: count, ledger: count });
    }
    const original = await readInvoice(f, invoice.id);
    assert.deepEqual(original.content, invoice.content);
    assert.equal(original.balance.signedBalance, '108');
    assert.equal(original.ledger.length, 1);
  } finally {
    await f.close();
  }
});

void test('HTTP finance changes contain only minimal markers and cashier filtering happens before the one-thousand change limit', async () => {
  const f = await financeFixture();
  try {
    const { invoice } = await postedInvoice(f),
      cashier = await staff(f, 'cashier');
    const original = changesSchema.parse(await (await f.request('/v1/sync/changes')).json());
    const markers = original.changes.filter((change) => change.kind === 'purchase-finance');
    assert.ok(markers.length >= 3);
    for (const marker of markers) {
      assert.deepEqual(Object.keys(marker.body).sort(), ['id', 'status', 'version']);
      assert.equal(marker.body.id, marker.entity_id);
    }
    const cursor = await f.database.transaction(f.admin, async (tx) => {
      const [head] = await rows<{ cursor: string }>(tx, sql`SELECT cursor::text FROM change_heads`);
      assert.ok(head);
      const prior = BigInt(head.cursor);
      await tx.$executeRaw(
        sql`INSERT INTO changes(tenant_id,cursor,store_id,kind,entity_id,body) SELECT ${f.admin.tenantId}::uuid,${prior}+number,${f.store}::uuid,'purchase-finance',${invoice.id}::uuid,jsonb_build_object('id',${invoice.id}::text,'status','posted','version',1) FROM generate_series(1,1001) number`,
      );
      await tx.$executeRaw(
        sql`INSERT INTO changes(tenant_id,cursor,store_id,kind,entity_id,body) VALUES(${f.admin.tenantId}::uuid,${prior + 1002n},${f.store}::uuid,'product',${f.product}::uuid,'{"id":"visible-after-finance"}'::jsonb)`,
      );
      await tx.$executeRaw(sql`UPDATE change_heads SET cursor=${prior + 1002n}`);
      return head.cursor;
    });
    const response = await cashier.request('/v1/sync/changes?cursor=' + cursor);
    assert.equal(response.status, 200);
    const actual = changesSchema.parse(await response.json());
    assert.deepEqual(
      actual.changes.map((change) => change.kind),
      ['product'],
    );
    assert.equal(actual.changes[0].entity_id, f.product);
    assert.equal(actual.cursor, (BigInt(cursor) + 1002n).toString());
    const [headquarters] = await f.database.transaction(f.admin, (tx) =>
      rows<{ count: number }>(
        tx,
        sql`SELECT count(*)::int AS count FROM purchase_invoices WHERE id=${invoice.id}::uuid`,
      ),
    );
    assert.equal(headquarters.count, 1);
  } finally {
    await f.close();
  }
});

void test('HTTP binary magic and ten-MiB caps reject evidence without creating an attachment or a payable debit', async () => {
  const f = await financeFixture();
  try {
    const invoice = await draftInvoice(f);
    const mismatch = await upload(f, invoice, Buffer.from('%PDF-synthetic-not-a-png'));
    assert.equal(mismatch.status, 400);
    assert.equal(errorSchema.parse(await mismatch.json()).code, 'EVIDENCE_FORMAT');
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 20);
    png.copy(oversize);
    const capped = await upload(f, invoice, oversize);
    assert.equal(capped.status, 413);
    assert.deepEqual(errorSchema.parse(await capped.json()), {
      code: 'PAYLOAD_TOO_LARGE',
      retryable: false,
    });
    const chunked = await chunkedUpload(f, invoice, oversize);
    assert.equal(chunked.status, 413);
    assert.deepEqual(errorSchema.parse(chunked.body), {
      code: 'PAYLOAD_TOO_LARGE',
      retryable: false,
    });
    assert.deepEqual(await evidenceFacts(f, invoice.id), { evidence: 0, debit: 0 });
    const unchanged = await readInvoice(f, invoice.id);
    assert.equal(unchanged.version, invoice.version);
    assert.equal(unchanged.state, 'draft');
    assert.equal(unchanged.balance.originalGross, null);
    assert.deepEqual(unchanged.evidence, []);
    assert.deepEqual(unchanged.content, invoice.content);
  } finally {
    await f.close();
  }
});

void test('HTTP twenty-evidence limit rejects only the twenty-first attachment while retaining all original hashes and the draft balance', async () => {
  const f = await financeFixture();
  try {
    let invoice = await draftInvoice(f);
    const original = invoice;
    const records: F.EvidenceDto[] = [];
    for (let index = 0; index < 20; index++) {
      const bytes = Buffer.concat([png, Buffer.from([index])]),
        response = await upload(f, invoice, bytes);
      assert.equal(response.status, 201, await response.clone().text());
      const action = F.EvidenceActionDtoSchema.parse(await response.json());
      records.push(action.evidence);
      assert.equal(action.evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
      invoice = { ...invoice, version: action.invoiceVersion };
    }
    const response = await upload(f, invoice);
    assert.equal(response.status, 409);
    assert.equal(errorSchema.parse(await response.json()).code, 'EVIDENCE_LIMIT');
    const actual = await readInvoice(f, invoice.id);
    assert.deepEqual(actual.evidence, records);
    assert.deepEqual(actual.content, original.content);
    assert.equal(actual.version, original.version + 20);
    assert.equal(actual.balance.originalGross, null);
    assert.deepEqual(await evidenceFacts(f, invoice.id), { evidence: 20, debit: 0 });
  } finally {
    await f.close();
  }
});

void test('HTTP evidence response loss replays one immutable SHA and rejects changed bytes with the same operation ID', async () => {
  const f = await financeFixture();
  try {
    const invoice = await draftInvoice(f),
      operationId = randomUUID(),
      headers = uploadHeaders(f, invoice, operationId);
    const receivedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        f.api.base + '/v1/purchase-invoices/' + invoice.id + '/evidence',
        { method: 'POST', headers: { ...headers, 'content-length': String(png.length) } },
        (response) => {
          // The server committed before sending 201; discard the body instead of acknowledging it.
          resolve(response.statusCode ?? 0);
          response.destroy();
        },
      );
      request.on('error', reject);
      request.end(png);
    });
    assert.equal(receivedStatus, 201);
    const committed = await readInvoice(f, invoice.id);
    assert.equal(committed.evidence.length, 1);
    const response = await upload(f, invoice, png, headers);
    assert.equal(response.status, 201, await response.clone().text());
    const replay = F.EvidenceActionDtoSchema.parse(await response.json());
    assert.deepEqual(replay.evidence, committed.evidence[0]);
    assert.equal(replay.invoiceVersion, invoice.version + 1);
    const changed = Buffer.from(png);
    changed[changed.length - 1] ^= 1;
    const conflict = await upload(f, invoice, changed, headers);
    assert.equal(conflict.status, 409);
    assert.equal(errorSchema.parse(await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
    const final = await readInvoice(f, invoice.id);
    assert.deepEqual(final.evidence, committed.evidence);
    assert.equal(final.version, invoice.version + 1);
    const [facts] = await f.database.transaction(f.admin, (tx) =>
      rows<{ operations: number; audit: number }>(
        tx,
        sql`SELECT (SELECT count(*)::int FROM operations WHERE id=${operationId}::uuid) AS operations,(SELECT count(*)::int FROM audit WHERE action='finance.evidence.upload' AND entity_id=${operationId}::uuid) AS audit`,
      ),
    );
    assert.deepEqual(facts, { operations: 1, audit: 1 });
    assert.deepEqual(await evidenceFacts(f, invoice.id), { evidence: 1, debit: 0 });
  } finally {
    await f.close();
  }
});

void test('HTTP missing or corrupted evidence returns unavailable while preserving its original metadata and payable snapshot', async () => {
  const f = await financeFixture();
  let file: string | undefined, original: Buffer | undefined;
  try {
    const { invoice, evidence, originalBytes } = await postedInvoice(f);
    const [stored] = await f.database.transaction(f.admin, (tx) =>
      rows<{ object_key: string }>(
        tx,
        sql`SELECT object_key FROM purchase_evidence WHERE id=${evidence.evidence.id}::uuid`,
      ),
    );
    assert.ok(stored);
    file = join(process.cwd(), '.context', 'finance-files', stored.object_key);
    original = await readFile(file);
    assert.deepEqual(original, originalBytes);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(file, corrupt);
    const downloadPath = evidence.evidence.downloadPath + '?storeId=' + f.store;
    const corruptResponse = await f.request(downloadPath);
    assert.equal(corruptResponse.status, 503);
    assert.equal(errorSchema.parse(await corruptResponse.json()).code, 'EVIDENCE_UNAVAILABLE');
    await unlink(file);
    const missing = await f.request(downloadPath);
    assert.equal(missing.status, 503);
    assert.equal(errorSchema.parse(await missing.json()).code, 'EVIDENCE_UNAVAILABLE');
    const preserved = await readInvoice(f, invoice.id);
    assert.deepEqual(preserved.content, invoice.content);
    assert.deepEqual(preserved.evidence, invoice.evidence);
    assert.equal(preserved.postedSnapshotSha256, invoice.postedSnapshotSha256);
    assert.deepEqual(preserved.ledger, invoice.ledger);
    assert.equal(preserved.balance.signedBalance, '108');
    await writeFile(file, original, { mode: 0o600 });
    const restored = await f.request(downloadPath);
    assert.equal(restored.status, 200);
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), originalBytes);
  } finally {
    if (file && original) await writeFile(file, original, { mode: 0o600 });
    await f.close();
  }
});
