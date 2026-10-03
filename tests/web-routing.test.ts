import assert from 'node:assert/strict';
import test from 'node:test';
import { pagePaths, readRoute, routeUrl, safeReturnPath } from '../apps/web/src/routing';

const store = '20000000-0000-4000-8000-000000000001';
const invoice = '70000000-0000-4000-8000-000000000001';

void test('web routes preserve legacy page, store and dates across canonical round trips', () => {
  for (const [page, path] of Object.entries(pagePaths)) {
    const route = readRoute(
      '/',
      `?page=${encodeURIComponent(page)}&storeId=${store}&from=2026-09-01&to=2026-09-30`,
    );
    assert.equal(route.notFound, undefined);
    const url = new URL(routeUrl(route), 'https://regi.example');
    assert.equal(url.pathname, path);
    assert.equal(url.searchParams.has('page'), false);
    assert.deepEqual(readRoute(url.pathname, url.search), route);
  }
});

void test('web invoice deep links retain the selected record without accepting invalid scope fields', () => {
  const route = readRoute(
    `/purchases/invoices/${invoice}`,
    `?storeId=${store}&from=2026-09-01&to=2026-09-30`,
  );
  assert.equal(route.invoiceId, invoice);
  assert.equal(route.page, '仕入明細・請求');
  assert.ok(routeUrl(route).startsWith(`/purchases/invoices/${invoice}?`));
  assert.equal(
    readRoute('/products', '?page=' + encodeURIComponent('管理設定')).page,
    '商品・価格',
  );
  for (const [path, query] of [
    ['/unknown', ''],
    ['/purchases/invoices/not-an-id', ''],
    ['/products', '?storeId=not-a-store'],
    ['/dashboard', '?from=2026-02-30'],
    ['/dashboard', '?from=2026-09-30&to=2026-09-01'],
  ])
    assert.equal(readRoute(path, query).notFound, true);
});

void test('web auth return paths reject external, control and credential URLs', () => {
  const origin = 'https://regi.example';
  const target = `/purchases/invoices/${invoice}?storeId=${store}&from=2026-09-01&to=2026-09-30`;
  assert.equal(safeReturnPath(target, origin), target);
  for (const value of [
    'https://other.example/products',
    '//other.example/products',
    '/\\other.example',
    '/products%0a',
    '/products?token=secret',
    '/?code=secret&state=state',
    '/unknown',
    '/products?from=2026-02-30',
  ])
    assert.equal(safeReturnPath(value, origin), '/');
});
