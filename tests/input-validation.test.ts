import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import { test } from 'node:test';
import { z } from 'zod';
import { ApiErrorDtoSchema } from '../packages/core/src/finance';
import { rows, sql } from '../apps/api/src/db';
import { BusinessError, Errors } from '../apps/api/src/errors';
import { apiFixture } from './api-fixture';
import { syncFixture } from './sync-fixture';

interface ErrorBody {
  code: string;
  message: string;
  field: string | null;
  retryable: boolean;
  nextAction: string;
  fieldErrors?: { field: string; message: string }[];
}

function filtered(error: unknown) {
  let status = 0;
  let body: ErrorBody | undefined;
  const response = {
    status(value: number) {
      status = value;
      return this;
    },
    json(value: ErrorBody) {
      body = value;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new Errors().catch(error, host);
  assert.ok(body);
  return { status, body };
}

void test(
  'HTTP invalid cash input returns actionable Japanese field errors without recording money, and corrected input succeeds',
  { timeout: 60000 },
  async () => {
    const fixture = await syncFixture();
    const api = await apiFixture();
    const operationId = randomUUID();
    const snapshot = () =>
      fixture.database.transaction(fixture.admin, async (transaction) => {
        const [counts] = await rows<{
          operations: number;
          audit: number;
          cash: number;
        }>(
          transaction,
          sql`SELECT (SELECT count(*)::int FROM operations) AS operations,(SELECT count(*)::int FROM audit) AS audit,(SELECT count(*)::int FROM documents WHERE kind='cash') AS cash`,
        );
        return counts;
      });
    const post = (body: unknown) =>
      fetch(api.base + '/v1/cash-movements', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': fixture.admin.tenantId,
          'x-staff-subject': fixture.admin.tenantId,
        },
        body: JSON.stringify(body),
      });
    try {
      const before = await snapshot();
      const invalid = await post({
        operationId,
        storeId: fixture.store,
        shiftId: '',
        amount: '1000',
        direction: 'in',
        reason: '',
      });
      const body = (await invalid.json()) as ErrorBody;
      assert.deepEqual(ApiErrorDtoSchema.parse(body), body);
      assert.equal(invalid.status, 400);
      assert.equal(body.code, 'INVALID_INPUT');
      assert.equal(body.retryable, false);
      assert.equal(body.field, 'shiftId');
      assert.deepEqual(body.fieldErrors, [
        { field: 'shiftId', message: '開局記録を選択してください。' },
        { field: 'reason', message: '理由を入力してください。' },
      ]);
      assert.match(body.message, /開局記録.*理由/s);
      assert.doesNotMatch(
        JSON.stringify(body),
        /invalid_format|too_small|Invalid UUID|pattern|origin/,
      );
      assert.equal(body.nextAction, '該当する項目を修正してから保存してください。');
      assert.doesNotMatch(body.nextAction, /操作ID|同期/);
      assert.deepEqual(await snapshot(), before);

      const malformedAmount = await post({
        operationId,
        storeId: fixture.store,
        shiftId: fixture.sale.body.shiftId,
        amount: '-1',
        direction: 'in',
        reason: '準備金の追加',
      });
      const amountBody = (await malformedAmount.json()) as ErrorBody;
      assert.equal(malformedAmount.status, 400);
      assert.deepEqual(amountBody.fieldErrors, [
        { field: 'amount', message: '金額は0以上の整数で入力してください。' },
      ]);
      assert.deepEqual(await snapshot(), before);

      const corrected = await post({
        operationId,
        storeId: fixture.store,
        shiftId: fixture.sale.body.shiftId,
        amount: '1000',
        direction: 'in',
        reason: '準備金の追加',
      });
      assert.equal(corrected.status, 201, await corrected.clone().text());
      assert.deepEqual(await snapshot(), {
        operations: before.operations + 1,
        audit: before.audit + 1,
        cash: before.cash + 1,
      });
    } finally {
      await api.close();
      await fixture.database.client.$disconnect();
    }
  },
);

void test('direct Zod validation uses safe field labels and preserves nonvalidation business errors', () => {
  const parsed = z
    .object({ productId: z.uuid(), privateUnknownField: z.string().min(1) })
    .safeParse({ productId: 'malformed-private-value', privateUnknownField: '' });
  assert.ok(!parsed.success);
  const result = filtered(parsed.error);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_INPUT');
  assert.equal(result.body.retryable, false);
  assert.deepEqual(result.body.fieldErrors, [
    { field: 'productId', message: '商品を選択してください。' },
    { field: 'privateUnknownField', message: '入力内容を確認してください。' },
  ]);
  assert.doesNotMatch(
    result.body.message,
    /malformed-private-value|privateUnknownField|UUID|too_small|origin/,
  );
  const denied = filtered(new BusinessError('ROLE_FORBIDDEN', 'この操作の権限がありません', 403));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'ROLE_FORBIDDEN');
  assert.equal(denied.body.message, 'この操作の権限がありません');
  assert.equal(denied.body.retryable, false);
  const uncertain = filtered(new BusinessError('UNKNOWN_RESULT', '未確認', 503, undefined, true));
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.code, 'UNKNOWN_RESULT');
  assert.equal(uncertain.body.retryable, true);
  assert.match(uncertain.body.nextAction, /同じ操作ID/);
});

void test('invalid sync business input remains a durable review with a sanitized message', async () => {
  const fixture = await syncFixture();
  try {
    const event = { ...fixture.sale, body: { ...fixture.sale.body, shiftId: '' } };
    const result = await fixture.business.events(fixture.admin, { events: [event] });
    assert.equal(result.results[0].status, 'review');
    assert.equal(result.results[0].code, 'INVALID_INPUT');
    assert.equal(result.results[0].message, '開局記録を選択してください。');
    const reviews = await fixture.database.transaction(fixture.admin, (transaction) =>
      rows<{ status: string; result: { message: string }; body: typeof event }>(
        transaction,
        sql`SELECT status,result,body FROM device_events WHERE id=${event.id}::uuid`,
      ),
    );
    assert.equal(reviews[0].status, 'review');
    assert.equal(reviews[0].result.message, '開局記録を選択してください。');
    assert.deepEqual(reviews[0].body, event);
  } finally {
    await fixture.database.client.$disconnect();
  }
});
