import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planQuery } from '../apps/api/src/ai-plan';
test('Japanese natural-language periods use business dates and reject future actuals', () => {
  const now = new Date('2026-10-01T09:00:00Z');
  for (const [period, from, to] of [
    ['今月', '2026-10-01', '2026-10-01'],
    ['先月', '2026-09-01', '2026-09-30'],
    ['今週', '2026-09-28', '2026-10-01'],
    ['先週', '2026-09-21', '2026-09-27'],
    ['去年', '2025-01-01', '2025-12-31'],
  ]) {
    const plan = planQuery({ question: `${period}の売上`, metric: 'inventory' }, [], now);
    assert.equal(plan.metric, 'sales');
    assert.equal(plan.from, from);
    assert.equal(plan.to, to);
  }
  const beforeOpening = planQuery(
    { question: '今日の売上', metric: 'sales' },
    [],
    new Date('2026-09-30T19:59:59Z'),
  );
  assert.equal(beforeOpening.from, '2026-09-30');
  assert.throws(() => planQuery({ question: '来月の売上', metric: 'sales' }, [], now));
  assert.throws(() => planQuery({ question: '2026-02-30の売上', metric: 'sales' }, [], now));
});
