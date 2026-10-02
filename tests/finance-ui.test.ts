import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financeYen, japanDateTime, japanInstant } from '../apps/web/src/finance-ui';
import { invoiceDraft, invoiceForm } from '../apps/web/src/finance/invoice-form';

void test('finance UI keeps huge yen and signed refund balances exact and never renders invalid amounts as zero', () => {
  assert.equal(financeYen('9007199254740993'), '9,007,199,254,740,993円');
  assert.equal(financeYen('-220'), '-220円');
  assert.equal(financeYen(null), '未確定');
  for (const invalid of ['NaN', '-0', '01', '1.1', '1e3', '1'.repeat(202)])
    assert.equal(financeYen(invalid), '金額を確認できません');
});
void test('finance UI converts actual Japanese calendar timestamps independently of host timezone and rejects impossible dates', () => {
  assert.equal(japanInstant('2026-10-02T05:00'), '2026-10-01T20:00:00.000Z');
  assert.equal(japanDateTime(new Date('2026-10-01T20:00:00Z')), '2026-10-02T05:00');
  assert.equal(japanInstant('2028-02-29T23:59'), '2028-02-29T14:59:00.000Z');
  for (const invalid of [
    '2026-02-29T12:00',
    '2026-10-02T24:00',
    '2026-10-02T12:60',
    '2026-10-02',
    '',
  ])
    assert.throws(() => japanInstant(invalid));
});
void test('finance UI preserves invalid quantity rate and money input until corrected and stores reduced classification explicitly', () => {
  const form = invoiceForm();
  Object.assign(form.lines[0], {
    name: '合成仕入',
    transactionDate: '2026-10-02',
    unitAmount: '9007199254740993',
    ratePercent: '8',
    quantity: '2',
  });
  const draft = invoiceDraft(form);
  assert.equal(draft.lines[0].unitAmount, '9007199254740993');
  assert.equal(draft.lines[0].rateBps, 800);
  assert.equal(draft.lines[0].reducedTarget, false);
  for (const invalid of ['', '0', '-1', '1.1', 'abc', '10001']) {
    form.lines[0].quantity = invalid;
    assert.throws(() => invoiceDraft(form));
    assert.equal(form.lines[0].quantity, invalid);
  }
  form.lines[0].quantity = '2';
  form.lines[0].ratePercent = '101';
  assert.throws(() => invoiceDraft(form));
  form.lines[0].ratePercent = '8';
  form.lines[0].unitAmount = '1e3';
  assert.throws(() => invoiceDraft(form));
});
void test('finance UI saves an incomplete skeleton without inventing original dates or mutating the source snapshot', () => {
  const initial = invoiceForm();
  const draft = invoiceDraft(initial);
  assert.equal(draft.invoiceDate, null);
  assert.equal(draft.sourceIdentity, null);
  assert.deepEqual(draft.lines, []);
  const editable = invoiceForm(draft);
  editable.draft.note = '編集中';
  assert.equal(draft.note, '');
  assert.equal(editable.draft.invoiceDate, null);
});
void test('finance UI preserves actual event seconds so a return after a receipt is not rounded back before it', () => {
  assert.equal(japanInstant('2026-10-02T05:00:59'), '2026-10-01T20:00:59.000Z');
  assert.equal(japanInstant('2026-10-02T05:00:00'), '2026-10-01T20:00:00.000Z');
  for (const invalid of ['2026-10-02T05:00:60', '2026-02-29T05:00:01'])
    assert.throws(() => japanInstant(invalid));
});
