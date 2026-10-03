import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renderDocumentPdf } from '../apps/api/src/pdf';
import { calculate } from '../packages/core/src';
import { receipt, purchase, refund } from './fixtures/pdf';

function extract(bytes: Buffer, bounds = false) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const result = spawnSync('pdftotext', [bounds ? '-bbox' : '-layout', '-', '-'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'PDF検証にはPopplerのpdftotextが必要です');
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function assertBounds(bytes: Buffer) {
  const bounds = extract(bytes, true);
  for (const match of bounds.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)/g,
  )) {
    assert.ok(Number(match[1]) >= 43 && Number(match[3]) <= 552.3, `水平はみ出し：${match[5]}`);
    assert.ok(Number(match[2]) >= 30 && Number(match[4]) <= 823, `垂直はみ出し：${match[5]}`);
  }
}

test('飲食店領収書のPDFに保存済み税率・値引き・支払・JST日時を整えて出力する', async () => {
  const before = JSON.stringify(receipt),
    bytes = await renderDocumentPdf('sale', receipt),
    text = extract(bytes);
  for (const expected of [
    '領収書',
    '適格簡易領収書',
    'サンプル食堂',
    'T1234567890123',
    '店内飲食',
    '持ち帰り',
    '8%',
    '10%',
    '税率別内訳',
    '1,080 円',
    '1,100 円',
    '2,180 円',
    '80 円',
    '100 円',
    'お預り',
    '3,000 円',
    'お釣り',
    '820 円',
    '2026/10/02 13:00 JST',
  ])
    assert.ok(text.includes(expected), expected);
  assert.match(text, /1\s*\/\s*1/);
  assert.equal(text.split('\f').filter((page) => page.trim()).length, 1);
  assert.equal(JSON.stringify(receipt), before);
  assertBounds(bytes);
});

test('発注書は発行時点の数量・単価・仕入先を使い、未保存の税率を創作しない', async () => {
  const bytes = await renderDocumentPdf('purchase-order', purchase),
    text = extract(bytes);
  for (const expected of [
    '発注書',
    'サンプル青果 御中',
    '入荷予定日',
    '2026/10/05',
    '仕入単価',
    '発注金額',
    '2,400 円',
    '1,200 円',
    '3,600 円',
    '税区分・税額は本帳票では確定しません',
  ])
    assert.ok(text.includes(expected), expected);
  for (const absent of ['変更後の仕入先', '99,999', '0%', '税込金額', 'うち消費税額'])
    assert.ok(!text.includes(absent), absent);
  assertBounds(bytes);
  await assert.rejects(
    () => renderDocumentPdf('purchase-order', { ...purchase, body: { lines: [] } }),
    /発行済み/,
  );
});

test('返還伝票は元販売日・返還日・元の適用税率と部分返金額だけを出力する', async () => {
  const bytes = await renderDocumentPdf('refund', refund),
    text = extract(bytes);
  for (const expected of [
    '返還伝票',
    '元販売日',
    '2026/10/02 13:00 JST',
    '返還日',
    '2026/10/03 14:00 JST',
    '税込返金額',
    '元の適用税率',
    '8%',
    '1,080 円',
    '元取引番号',
    '数量の訂正',
  ])
    assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('10%'));
  assert.ok(!text.includes('うち消費税額'));
  assertBounds(bytes);
});

test('税抜・全額値引き・将来税率でも税額は保存内容から表示する', async () => {
  for (const discount of ['1', '200']) {
    const calculated = calculate(
      [
        {
          productId: 'sample',
          name: '保存価格の商品',
          quantity: 2,
          price: '100',
          discount: '0',
          rateBps: 1200,
          cost: '30',
          stockManaged: true,
        },
      ],
      discount,
      'exclusive',
    );
    const bytes = await renderDocumentPdf('sale', {
        ...receipt,
        body: {
          ...receipt.body,
          ...calculated,
          method: 'card',
          reference: 'REF-123',
          receipt: { ...receipt.body.receipt, registered: false },
        },
      }),
      text = extract(bytes);
    assert.ok(text.includes(`${BigInt(calculated.total).toLocaleString('ja-JP')} 円`));
    assert.ok(text.includes('12%'));
    assert.ok(text.includes('（税抜）'));
    assert.ok(text.includes('非登録事業者'));
    assert.ok(!text.includes('T1234567890123'));
    assert.ok(text.includes('値引き'));
    assert.ok(text.includes('REF-123'));
    assert.ok(!text.includes('お釣り'));
    assertBounds(bytes);
  }
});

test('宛名必須の適格請求書・日本時間の日付繰越・大きな整数金額を保持する', async () => {
  const amount = '9007199254740993';
  const bytes = await renderDocumentPdf('sale', {
      ...receipt,
      body: {
        ...receipt.body,
        total: amount,
        occurredAt: '2026-10-02T18:30:00Z',
        receipt: { ...receipt.body.receipt, buyerRequired: true },
        buyerName: 'サンプル商事',
        method: 'qr',
        reference: 'QR-TEST',
        lines: [{ name: '大口注文', quantity: 1, paid: amount, rateBps: 0 }],
        taxes: [{ rateBps: 0, paid: amount, tax: '0' }],
      },
    }),
    text = extract(bytes);
  for (const expected of [
    '適格請求書',
    'サンプル商事 様',
    '2026/10/03 03:30 JST',
    '9,007,199,254,740,993 円',
    'QR（外部端末）',
  ])
    assert.ok(text.includes(expected), expected);
  assertBounds(bytes);
});

test('500明細でも全商品を一度ずつ出力し、各ページに表見出しとページ番号を付ける', async () => {
  const lines = Array.from({ length: 500 }, (_, index) => ({
    name: `検証商品-${String(index + 1).padStart(3, '0')}`,
    quantity: 1,
    unitCost: '12345',
  }));
  const bytes = await renderDocumentPdf('purchase-order', {
      ...purchase,
      body: { issuedSnapshot: { ...purchase.body.issuedSnapshot, lines } },
    }),
    text = extract(bytes);
  const pages = text.split('\f').filter((page) => page.trim());
  assert.ok(pages.length > 10 && pages.length < 35);
  for (const line of lines) assert.equal(text.split(line.name).length - 1, 1, line.name);
  for (const [index, page] of pages.entries()) {
    assert.ok(page.includes(`${index + 1} / ${pages.length}`));
    assert.ok(page.includes('発注書'));
    if (page.includes('検証商品-')) assert.ok(page.includes('仕入単価'));
  }
  assert.ok(text.includes('6,172,500 円'));
  assertBounds(bytes);
});

test('長い宛名・住所・改行を含む巨大明細を省略せずページ内へ折り返す', async () => {
  const name = '長い品名'.repeat(600) + '末尾確認',
    profile = {
      ...receipt.body.receipt,
      sellerName: '会社名'.repeat(40),
      storeName: '店舗名'.repeat(40),
      address: '東京都'.repeat(120),
    };
  const bytes = await renderDocumentPdf('purchase-order', {
      ...purchase,
      body: {
        issuedSnapshot: {
          ...purchase.body.issuedSnapshot,
          receipt: profile,
          supplier: '仕入先'.repeat(65),
          lines: [{ name, quantity: 1, unitCost: '1' }],
        },
      },
    }),
    text = extract(bytes);
  assert.ok(text.includes('末尾確認'));
  assert.equal(text.replace(/\s/g, '').split('長い品名').length - 1, 600);
  assertBounds(bytes);
});
