import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, networkError, readApiResponse } from '../apps/web/src/api-response';

test('CloudFront HTML errors show cause and recovery instructions, never raw HTML or JSON parse errors', async () => {
  for (const status of [502, 503, 504])
    await assert.rejects(
      () =>
        readApiResponse(
          new Response('<html>Gateway timeout</html>', {
            status,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`HTTP ${status}`));
        assert.ok(error.message.includes('停止中、起動処理中、または'));
        assert.ok(error.message.includes('Macの起動コマンド'));
        assert.ok(!error.message.includes('<html>'));
        assert.ok(!error.message.includes('Unexpected'));
        return true;
      },
    );
  await assert.rejects(
    () =>
      readApiResponse(
        new Response('{broken', { status: 503, headers: { 'content-type': 'application/json' } }),
      ),
    /数分待って/,
  );
  await assert.rejects(
    () =>
      readApiResponse(
        new Response('<html>Web index</html>', { headers: { 'content-type': 'text/html' } }),
      ),
    /配布設定/,
  );
});
test('business error messages retain next actions; general network failure does not assert the server is stopped', async () => {
  const headers = { 'content-type': 'application/json' };
  assert.deepEqual(await readApiResponse(new Response('{"total":"123"}', { headers })), {
    total: '123',
  });
  await assert.rejects(
    () =>
      readApiResponse(
        new Response(
          '{"code":"STORE_DENIED","message":"店舗の権限がありません","nextAction":"所属店舗を選択"}',
          { status: 403, headers },
        ),
      ),
    /STORE_DENIED: 店舗の権限がありません 所属店舗を選択/,
  );
  assert.ok(networkError().message.includes('ネットワーク接続'));
  assert.ok(!networkError().message.includes('停止中'));
});

void test('input errors show Japanese field guidance without schema internals or retrying an unchanged invalid request', async () => {
  await assert.rejects(
    () =>
      readApiResponse(
        new Response(
          JSON.stringify({
            code: 'INVALID_INPUT',
            message: '入力内容を確認してください。',
            retryable: false,
            nextAction: '該当項目を修正してから送信してください。',
            fieldErrors: [
              { field: 'shiftId', message: '開局記録を選択してください。' },
              { field: 'reason', message: '理由を入力してください。' },
            ],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.uncertain, false);
      assert.match(error.message, /開局記録を選択してください/);
      assert.match(error.message, /理由を入力してください/);
      assert.match(error.message, /修正/);
      assert.doesNotMatch(error.message, /INVALID_INPUT|操作ID|invalid_format|uuid/);
      return true;
    },
  );
  await assert.rejects(
    () =>
      readApiResponse(
        new Response(
          JSON.stringify({
            code: 'INVALID_INPUT',
            message:
              '[{"origin":"string","code":"invalid_format","format":"uuid","path":["shiftId"],"message":"Invalid UUID"}]',
            nextAction: '入力・同期状況を確認し、同じ操作IDで再試行してください。',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /入力内容/);
      assert.match(error.message, /修正/);
      assert.doesNotMatch(error.message, /Invalid UUID|origin|uuid|操作ID/);
      return true;
    },
  );
});
