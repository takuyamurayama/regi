import { test, expect } from '@playwright/test';

test('ブラウザー標準fetchでPKCEのコード交換と並列トークン更新が成功する', async ({ page }) => {
  const requests: URLSearchParams[] = [];
  await page.route('**/auth-regression', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>認証回帰試験</title>' }),
  );
  await page.route('https://auth.regi.example/oauth2/token', async (route) => {
    requests.push(new URLSearchParams(route.request().postData() ?? ''));
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        id_token: requests.length === 1 ? 'synthetic-initial-token' : 'synthetic-refreshed-token',
        refresh_token: 'synthetic-refresh-token',
        expires_in: 3600,
      }),
    });
  });
  await page.goto('/auth-regression');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/auth.ts';
    const { BrowserAuth } = await import(modulePath);
    const redirect = location.origin + '/';
    const auth = new BrowserAuth(
      { domain: 'https://auth.regi.example', clientId: 'regression-client', redirect },
      sessionStorage,
    );
    const authorization = new URL(await auth.authorizationUrl());
    const callbackToken = await auth.callback(
      redirect +
        '?' +
        new URLSearchParams({
          code: 'synthetic-code',
          state: authorization.searchParams.get('state')!,
        }),
    );
    const pending = sessionStorage.getItem('regi-oauth-pending');
    const session = JSON.parse(sessionStorage.getItem('regi-oauth-session')!);
    sessionStorage.setItem('regi-oauth-session', JSON.stringify({ ...session, expiresAt: 0 }));
    const refreshed = await Promise.all([auth.token(''), auth.token('')]);
    const storedToken = sessionStorage.getItem('regi-token');
    auth.logout();
    return {
      callbackToken,
      pending,
      refreshed,
      storedToken,
      loggedOut: sessionStorage.length === 0,
    };
  });
  expect(result).toEqual({
    callbackToken: 'synthetic-initial-token',
    pending: null,
    refreshed: ['synthetic-refreshed-token', 'synthetic-refreshed-token'],
    storedToken: 'synthetic-refreshed-token',
    loggedOut: true,
  });
  expect(requests).toHaveLength(2);
  expect(requests[0].get('grant_type')).toBe('authorization_code');
  expect(requests[0].get('code')).toBe('synthetic-code');
  expect(requests[0].get('code_verifier')).toHaveLength(64);
  expect(requests[1].get('grant_type')).toBe('refresh_token');
  expect(requests[1].get('refresh_token')).toBe('synthetic-refresh-token');
});
