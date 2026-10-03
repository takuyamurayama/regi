import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { pagePaths } from '../apps/web/src/routing';
interface Request {
  uri: string;
  method: string;
  querystring: Record<string, unknown>;
  headers: Record<string, unknown>;
}
const source = readFileSync('infra/sandbox/web-route-rewrite.js', 'utf8');
function rewrite(request: Request): Request {
  const output: unknown = runInNewContext(
    `${source}\nhandler(event);`,
    { event: { request } },
    { timeout: 1000 },
  );
  assert.equal(output, request);
  return request;
}
void test('sandbox web rewrite serves every canonical UI path and invoice deep link without changing query scope', () => {
  const query = {
    storeId: { value: '20000000-0000-4000-8000-000000000001' },
    from: { value: '2026-09-01' },
    to: { value: '2026-09-30' },
    page: { value: '発注・入荷' },
  };
  for (const uri of [
    '/',
    ...Object.values(pagePaths),
    '/purchases/invoices/70000000-0000-4000-8000-000000000001',
    '/purchases/orders/',
  ])
    for (const method of ['GET', 'HEAD']) {
      const headers = { host: { value: 'test.cloudfront.net' } },
        request = { uri, method, querystring: query, headers };
      const output = rewrite(request);
      assert.equal(output.uri, '/index.html');
      assert.equal(output.querystring, query);
      assert.equal(output.headers, headers);
      assert.equal(output.method, method);
    }
});
void test('sandbox web rewrite preserves API, health, assets, unknown paths and nonread methods', () => {
  for (const uri of [
    '/v1',
    '/v1/products',
    '/v1/sync/events',
    '/health',
    '/assets/main.js',
    '/favicon.svg',
    '/unknown',
    '/purchases/invoices/not-an-id',
    '/purchases/invoices/70000000-0000-0000-0000-000000000001',
  ]) {
    assert.equal(rewrite({ uri, method: 'GET', querystring: {}, headers: {} }).uri, uri);
  }
  for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS'])
    assert.equal(
      rewrite({ uri: '/products', method, querystring: {}, headers: {} }).uri,
      '/products',
    );
});
