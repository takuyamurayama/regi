import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Artifacts } from '../apps/api/src/artifacts';
import { Administration } from '../apps/api/src/admin';
import { rows, sql } from '../apps/api/src/db';
import { digest } from '../apps/api/src/service';
import { calculate, type LineInput } from '../packages/core/src';
import { syncFixture } from './sync-fixture';

interface ReceiptProfile {
  storeId: string;
  sellerName: string;
  storeName: string;
  address: string;
  registered: boolean;
  registrationNumber: string;
  buyerRequired: boolean;
}
type SaleBody = ReturnType<typeof calculate> & {
  receipt: ReceiptProfile;
  buyerName: string;
  occurredAt: string;
  paymentStartedAt: string;
  method: string;
};
interface Source<T> {
  id: string;
  store_id: string;
  status: string;
  body: T;
}
interface RefundBody {
  receipt: ReceiptProfile;
  buyerName: string;
  originalSaleDate: string;
  refundedAt: string;
  total: string;
  lines: {
    index: number;
    quantity: number;
    rateBps: number;
    paid: string;
    taxManagement: string;
    unitOffset: number;
    taxCode?: string;
    reducedTarget?: boolean;
  }[];
}
type Fixture = Awaited<ReturnType<typeof invoiceFixture>>;
function idOf(value: unknown) {
  assert.ok(typeof value === 'object' && value !== null && 'id' in value);
  assert.equal(typeof value.id, 'string');
  return value.id as string;
}
function extract(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const result = spawnSync('pdftotext', ['-layout', '-', '-'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function invoiceFixture(reducedRate = 800, standardRate = 1000) {
  const fixture = await syncFixture();
  const administration = new Administration(fixture.business);
  const profile: ReceiptProfile = {
    storeId: fixture.store,
    sellerName: '帳票検証用の架空法人',
    storeName: '帳票検証用の架空店舗',
    address: '東京都の架空検証住所',
    registered: true,
    registrationNumber: 'T0000000000000',
    buyerRequired: true,
  };
  const products = [
    { id: randomUUID(), sku: 'INVOICE-A', name: '保存弁当', price: '101', taxCode: 'reduced' },
    { id: randomUUID(), sku: 'INVOICE-B', name: '保存お茶', price: '101', taxCode: 'reduced' },
    { id: randomUUID(), sku: 'INVOICE-C', name: '保存日用品', price: '110', taxCode: 'standard' },
  ];
  await fixture.database.transaction(fixture.admin, async (transaction) => {
    await transaction.$executeRaw(
      sql`INSERT INTO tax_rates(id,tenant_id,code,rate_bps,effective_at) VALUES(${randomUUID()}::uuid,${fixture.admin.tenantId}::uuid,'reduced',${reducedRate},now()-interval '1 day')`,
    );
    if (standardRate !== 1000)
      await transaction.$executeRaw(
        sql`INSERT INTO tax_rates(id,tenant_id,code,rate_bps,effective_at) VALUES(${randomUUID()}::uuid,${fixture.admin.tenantId}::uuid,'standard',${standardRate},now()-interval '1 hour')`,
      );
    for (const product of products) {
      await transaction.$executeRaw(
        sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product.id}::uuid,${fixture.admin.tenantId}::uuid,${product.sku},${product.name},true,50)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO prices(id,tenant_id,product_id,amount,tax_code,effective_at,cost_snapshot) VALUES(${randomUUID()}::uuid,${fixture.admin.tenantId}::uuid,${product.id}::uuid,${BigInt(product.price)},${product.taxCode},now()-interval '1 day',50)`,
      );
    }
  });
  await administration.execute(fixture.admin, 'receipt-profile', {
    operationId: randomUUID(),
    ...profile,
  });
  const boot: unknown = await fixture.business.bootstrap(fixture.admin, fixture.device);
  assert.ok(typeof boot === 'object' && boot !== null && 'leaseId' in boot);
  assert.equal(typeof boot.leaseId, 'string');
  const lines: LineInput[] = products.map((product, index) => ({
    productId: product.id,
    name: product.name,
    quantity: index === 0 ? 2 : 1,
    price: product.price,
    discount: '0',
    rateBps: product.taxCode === 'reduced' ? reducedRate : standardRate,
    cost: '50',
    stockManaged: true,
    taxContext: product.taxCode === 'reduced' ? 'takeaway' : 'master',
  }));
  const now = new Date().toISOString();
  const sale = {
    ...fixture.sale,
    leaseId: boot.leaseId as string,
    occurredAt: now,
    body: {
      ...fixture.sale.body,
      paymentStartedAt: now,
      buyerName: '検証用の架空購入者',
      lines,
      total: calculate(lines, '0', 'inclusive').total,
      tendered: '1000',
    },
  };
  return { ...fixture, administration, profile, products, sale };
}
async function saleRecord(fixture: Fixture) {
  const [record] = await fixture.database.transaction(fixture.admin, (transaction) =>
    rows<Source<SaleBody>>(
      transaction,
      sql`SELECT id,store_id,status,body FROM documents WHERE id=${fixture.sale.id}::uuid AND kind='sale'`,
    ),
  );
  assert.ok(record);
  return record;
}
async function pdf(fixture: Fixture, format: 'receipt-pdf' | 'refund-pdf', documentId: string) {
  const artifacts = new Artifacts(fixture.business);
  const job: unknown = await artifacts.request(fixture.admin, {
    operationId: randomUUID(),
    storeId: fixture.store,
    documentId,
    format,
  });
  const id = idOf(job);
  await artifacts.process(fixture.admin, id);
  const file = await artifacts.download(fixture.admin, id);
  return { id, artifacts, bytes: file.bytes, text: extract(file.bytes) };
}
async function changeMasters(fixture: Fixture) {
  await fixture.administration.execute(fixture.admin, 'receipt-profile', {
    operationId: randomUUID(),
    ...fixture.profile,
    sellerName: '変更後の発行者',
    storeName: '変更後の店舗名',
    registrationNumber: 'T9999999999999',
    address: '変更後の住所',
  });
  for (const product of fixture.products)
    await fixture.business.saveProduct(
      fixture.admin,
      {
        operationId: randomUUID(),
        version: 1,
        ...product,
        name: '変更後の商品名',
        cost: '80',
        price: '999',
        stockManaged: true,
        taxCode: 'standard',
        effectiveAt: new Date().toISOString(),
      },
      product.id,
    );
  // This historical fixture update stays within its own UUID tenant; no shared tax/master changes.
  await fixture.database.transaction(fixture.admin, (transaction) =>
    transaction.$executeRaw(
      sql`INSERT INTO tax_rates(id,tenant_id,code,rate_bps,effective_at) VALUES(${randomUUID()}::uuid,${fixture.admin.tenantId}::uuid,'reduced',1200,clock_timestamp()),(${randomUUID()}::uuid,${fixture.admin.tenantId}::uuid,'standard',2500,clock_timestamp())`,
    ),
  );
}

void test('real mixed-rate sale PDF and completed download retain original invoice snapshot after master and profile changes', async () => {
  const fixture = await invoiceFixture();
  try {
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    const original = await saleRecord(fixture);
    assert.deepEqual(original.body.receipt, fixture.profile);
    assert.equal(original.body.buyerName, fixture.sale.body.buyerName);
    assert.equal(original.body.total, '413');
    assert.deepEqual(original.body.taxes, [
      { rateBps: 800, base: '303', tax: '22', paid: '303' },
      { rateBps: 1000, base: '110', tax: '10', paid: '110' },
    ]);
    assert.equal(
      original.body.lines.reduce((sum, line) => sum + BigInt(line.managementTax), 0n),
      32n,
    );
    const before = await pdf(fixture, 'receipt-pdf', fixture.sale.id);
    for (const expected of [
      '適格請求書',
      fixture.profile.sellerName,
      fixture.profile.registrationNumber,
      fixture.sale.body.buyerName,
      '8%',
      '10%',
      '22 円',
      '10 円',
      '413 円',
    ])
      assert.ok(before.text.includes(expected), expected);
    await changeMasters(fixture);
    const replay = await fixture.business.events(fixture.admin, { events: [fixture.sale] });
    assert.equal(replay.results[0].status, 'accepted');
    assert.deepEqual(await saleRecord(fixture), original);
    const saved = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ hash: string; body: unknown }>(
        transaction,
        sql`SELECT hash,body FROM device_events WHERE id=${fixture.sale.id}::uuid`,
      ),
    );
    assert.equal(saved[0].hash, digest(fixture.sale));
    assert.deepEqual(saved[0].body, fixture.sale);
    const after = await pdf(fixture, 'receipt-pdf', fixture.sale.id);
    assert.equal(after.text, before.text);
    assert.equal(
      createHash('sha256')
        .update((await before.artifacts.download(fixture.admin, before.id)).bytes)
        .digest('hex'),
      createHash('sha256').update(before.bytes).digest('hex'),
    );
    for (const absent of ['変更後の発行者', '変更後の商品名', 'T9999999999999', '25%', '999 円'])
      assert.ok(!after.text.includes(absent), absent);
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('real partial refunds keep original issuer buyer dates rates and allocated tax without rewriting the sale', async () => {
  const fixture = await invoiceFixture();
  try {
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    const original = await saleRecord(fixture);
    await changeMasters(fixture);
    const confirmed: Source<RefundBody>[] = [];
    for (const lines of [
      [{ index: 0, quantity: 1, restock: true }],
      [
        { index: 0, quantity: 1, restock: true },
        { index: 1, quantity: 1, restock: true },
        { index: 2, quantity: 1, restock: true },
      ],
    ]) {
      const reserved: unknown = await fixture.business.refund(fixture.admin, {
        operationId: randomUUID(),
        storeId: fixture.store,
        saleId: fixture.sale.id,
        reason: '架空試験の数量訂正',
        lines,
      });
      const id = idOf(reserved);
      await fixture.business.confirmRefund(fixture.admin, id, {
        operationId: randomUUID(),
        storeId: fixture.store,
        result: 'success',
        shiftId: fixture.sale.body.shiftId,
      });
      const [record] = await fixture.database.transaction(fixture.admin, (transaction) =>
        rows<Source<RefundBody>>(
          transaction,
          sql`SELECT id,store_id,status,body FROM documents WHERE id=${id}::uuid AND kind='refund'`,
        ),
      );
      confirmed.push(record);
      assert.equal(record.status, 'confirmed');
      assert.deepEqual(record.body.receipt, original.body.receipt);
      assert.equal(record.body.buyerName, original.body.buyerName);
      assert.equal(record.body.originalSaleDate, original.body.occurredAt);
      for (const line of record.body.lines) {
        const source = original.body.lines[line.index];
        assert.equal(line.taxCode, source.taxCode);
        assert.equal(line.reducedTarget, source.reducedTarget);
      }
      assert.ok(Date.parse(record.body.refundedAt) >= Date.parse(record.body.originalSaleDate));
      const file = await pdf(fixture, 'refund-pdf', id);
      for (const expected of [
        '返還伝票',
        fixture.profile.sellerName,
        fixture.profile.registrationNumber,
        fixture.sale.body.buyerName,
        '元販売日',
        '返還日',
        '8%',
        '101 円',
      ])
        assert.ok(file.text.includes(expected), expected);
      assert.ok(!file.text.includes('うち消費税額'));
      assert.ok(!file.text.includes('変更後'));
      assert.ok(!file.text.includes('25%'));
    }
    assert.equal(
      confirmed.reduce((sum, record) => sum + BigInt(record.body.total), 0n),
      413n,
    );
    assert.equal(
      confirmed
        .flatMap((record) => record.body.lines)
        .reduce((sum, line) => sum + BigInt(line.taxManagement), 0n),
      32n,
    );
    assert.equal(confirmed[1].body.lines[0].unitOffset, 1);
    assert.deepEqual(await saleRecord(fixture), original);
    await assert.rejects(
      () =>
        fixture.business.refund(fixture.admin, {
          operationId: randomUUID(),
          storeId: fixture.store,
          saleId: fixture.sale.id,
          reason: '過剰返金の拒否試験',
          lines: [{ index: 0, quantity: 1, restock: true }],
        }),
      /返品可能数量/,
    );
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('buyer-required live sale persists review and no sale or stock mutation until an explicit valid buyer event arrives', async () => {
  const fixture = await invoiceFixture();
  try {
    const invalid = { ...fixture.sale, body: { ...fixture.sale.body, buyerName: '' } };
    const rejected = await fixture.business.events(fixture.admin, { events: [invalid] });
    assert.equal(rejected.results[0].status, 'review');
    assert.equal(rejected.results[0].code, 'BUYER_REQUIRED');
    const [facts] = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ sales: number; stock: number; status: string; body: unknown }>(
        transaction,
        sql`SELECT (SELECT count(*)::int FROM documents WHERE kind='sale') AS sales,(SELECT count(*)::int FROM inventory) AS stock,status,body FROM device_events WHERE id=${invalid.id}::uuid`,
      ),
    );
    assert.deepEqual(facts, { sales: 0, stock: 0, status: 'review', body: invalid });
    fixture.sale = { ...fixture.sale, id: randomUUID(), sequence: '2' };
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    assert.ok(
      (await pdf(fixture, 'receipt-pdf', fixture.sale.id)).text.includes(
        fixture.sale.body.buyerName,
      ),
    );
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('server derives reduced tax classification from verified historical code for old payloads even at reduced 12 percent and standard 8 percent', async () => {
  const fixture = await invoiceFixture(1200, 800);
  try {
    fixture.sale.body.lines.push({
      ...fixture.sale.body.lines[1],
      name: '保存お茶（店内）',
      taxContext: 'dine-in',
      rateBps: 800,
    });
    fixture.sale.body.total = calculate(fixture.sale.body.lines, '0', 'inclusive').total;
    const raw = structuredClone(fixture.sale);
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    const record = await saleRecord(fixture);
    assert.deepEqual(
      record.body.lines.map((line) => {
        return { taxCode: line.taxCode, reducedTarget: line.reducedTarget };
      }),
      [
        { taxCode: 'reduced', reducedTarget: true },
        { taxCode: 'reduced', reducedTarget: true },
        { taxCode: 'standard', reducedTarget: false },
        { taxCode: 'standard', reducedTarget: false },
      ],
    );
    assert.deepEqual(fixture.sale, raw);
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('actual persisted reduced sale PDF marks reduced targets and legend independently of displayed percentage', async () => {
  const fixture = await invoiceFixture(1200, 800);
  try {
    assert.equal(
      (await fixture.business.events(fixture.admin, { events: [fixture.sale] })).results[0].status,
      'accepted',
    );
    const file = await pdf(fixture, 'receipt-pdf', fixture.sale.id);
    assert.ok(file.text.includes('12%'));
    assert.ok(file.text.includes('8%'));
    assert.ok(
      file.text.includes('軽減税率対象'),
      'actual sale PDF must explain the saved reduced-target marker',
    );
    for (const name of ['保存弁当', '保存お茶'])
      assert.ok(
        file.text
          .split('\n')
          .find((line) => line.includes(name))
          ?.includes('※'),
        name,
      );
    assert.ok(
      !file.text
        .split('\n')
        .find((line) => line.includes('保存日用品'))
        ?.includes('※'),
    );
  } finally {
    await fixture.database.client.$disconnect();
  }
});

void test('client supplied sale tax metadata cannot override verified classification or be approved into a sale', async () => {
  for (const metadata of [
    { taxCode: 'standard', reducedTarget: false },
    { taxCode: 'reduced', reducedTarget: false },
  ]) {
    const fixture = await invoiceFixture();
    try {
      const event = {
        ...fixture.sale,
        body: {
          ...fixture.sale.body,
          lines: fixture.sale.body.lines.map((line, index) =>
            index === 0 ? { ...line, ...metadata } : line,
          ),
        },
      };
      const response = await fixture.business.events(fixture.admin, { events: [event] });
      assert.equal(response.results[0].status, 'review');
      assert.equal(response.results[0].code, 'MASTER_MISMATCH');
      await assert.rejects(
        () =>
          fixture.business.retryReview(fixture.admin, event.id, {
            operationId: randomUUID(),
            storeId: fixture.store,
            reason: '誤分類を確認承認で通さない検査',
          }),
        /税区分/,
      );
      const [facts] = await fixture.database.transaction(fixture.admin, (transaction) =>
        rows<{ count: number; body: unknown; status: string }>(
          transaction,
          sql`SELECT (SELECT count(*)::int FROM documents WHERE kind='sale') AS count,body,status FROM device_events WHERE id=${event.id}::uuid`,
        ),
      );
      assert.deepEqual(facts, { count: 0, body: event, status: 'review' });
    } finally {
      await fixture.database.client.$disconnect();
    }
  }
});
