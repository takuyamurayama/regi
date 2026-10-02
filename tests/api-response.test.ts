import assert from 'node:assert/strict';
import test from 'node:test';
import { networkError, readApiResponse } from '../apps/web/src/api-response';

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
