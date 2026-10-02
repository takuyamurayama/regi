import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAuth } from '../apps/web/src/auth';
test('browser PKCE rejects mismatched and expired state, refreshes once and clears logout', async () => {
  const values = new Map<string, string>(),
    storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    calls: URLSearchParams[] = [];
  let now = Date.now();
  const auth = new BrowserAuth(
    {
      domain: 'https://test.auth.example',
      clientId: 'public-client',
      redirect: 'https://regi.example/',
    },
    storage,
    async (_url, options) => {
      calls.push(new URLSearchParams(String(options?.body)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({
          id_token: calls.length === 1 ? 'ID-A' : 'ID-B',
          refresh_token: 'REFRESH',
          expires_in: calls.length === 1 ? 1 : 3600,
        }),
        { status: 200 },
      );
    },
    () => now,
  );
  const authorization = new URL(await auth.authorizationUrl());
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  await assert.rejects(() => auth.callback('https://regi.example/?code=test&state=bad'), /state/);
  assert.equal(calls.length, 0);
  const callback = `https://regi.example/?code=test&state=${authorization.searchParams.get('state')}`;
  assert.equal(await auth.callback(callback), 'ID-A');
  assert.ok(calls[0].get('code_verifier'));
  assert.deepEqual(await Promise.all([auth.token(''), auth.token('')]), ['ID-B', 'ID-B']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].get('grant_type'), 'refresh_token');
  await assert.rejects(() => auth.callback(callback), /state/);
  const next = new URL(await auth.authorizationUrl());
  now += 600001;
  await assert.rejects(
    () => auth.callback(`https://regi.example/?code=test&state=${next.searchParams.get('state')}`),
    /有効期限/,
  );
  auth.logout();
  assert.equal(values.size, 0);
});

void test('browser logout rejects stale refresh result without reviving credentials', async () => {
  const values = new Map<string, string>([
    ['regi-oauth-session', JSON.stringify({ token: 'old', refresh: 'refresh', expiresAt: 0 })],
  ]);
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((completion) => {
    resolve = completion;
  });
  const auth = new BrowserAuth(
    {
      domain: 'https://test.auth.example',
      clientId: 'public-client',
      redirect: 'https://regi.example/',
    },
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    () => pending,
  );
  const refresh = auth.token('');
  auth.logout();
  resolve(
    new Response(JSON.stringify({ id_token: 'stale', expires_in: 3600 }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await assert.rejects(refresh, /認証|ログイン/);
  assert.equal(values.size, 0);
});
