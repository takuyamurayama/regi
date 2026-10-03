import { safeReturnPath } from './routing';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Config = { domain: string; clientId: string; redirect: string };
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export class BrowserAuth {
  private refreshing?: Promise<string>;
  private generation = 0;
  constructor(
    private config: Config,
    private storage: Store,
    private transport: typeof fetch = (...parameters) => globalThis.fetch(...parameters),
    private now = () => Date.now(),
  ) {}
  async authorizationUrl(returnPath = '/') {
    if (!this.config.domain.startsWith('https://') || !this.config.clientId)
      throw new Error('CognitoのHTTPSログイン先が未設定です');
    const generation = ++this.generation;
    this.refreshing = undefined;
    const bytes = crypto.getRandomValues(new Uint8Array(48)),
      encode = (value: Uint8Array) =>
        btoa(String.fromCharCode(...value))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '');
    const verifier = encode(bytes),
      challenge = encode(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      ),
      state = crypto.randomUUID();
    if (generation !== this.generation)
      throw new Error('ログインの状態が変わりました。再ログインしてください');
    this.storage.setItem(
      'regi-oauth-pending',
      JSON.stringify({
        verifier,
        state,
        issuedAt: this.now(),
        returnPath: safeReturnPath(returnPath, new URL(this.config.redirect).origin),
        clientId: this.config.clientId,
        redirect: this.config.redirect,
      }),
    );
    return (
      this.config.domain +
      '/oauth2/authorize?' +
      new URLSearchParams({
        client_id: this.config.clientId,
        response_type: 'code',
        scope: 'openid profile',
        redirect_uri: this.config.redirect,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
      })
    );
  }
  private async exchange(
    parameters: Record<string, string>,
    priorRefresh?: string,
    generation = this.generation,
  ) {
    const response = await this.transport(this.config.domain + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...parameters }),
    });
    if (generation !== this.generation)
      throw new Error('認証の状態が変わりました。再ログインしてください');
    if (!response.ok) throw new Error('Cognitoの認証更新に失敗しました。再ログインしてください');
    const value: unknown = await response.json();
    const result = record(value);
    if (generation !== this.generation)
      throw new Error('認証の状態が変わりました。再ログインしてください');
    if (
      !result ||
      typeof result.id_token !== 'string' ||
      !Number.isFinite(Number(result.expires_in)) ||
      (result.refresh_token !== undefined && typeof result.refresh_token !== 'string')
    )
      throw new Error('認証応答が不正です');
    this.storage.setItem(
      'regi-oauth-session',
      JSON.stringify({
        token: result.id_token,
        refresh: result.refresh_token ?? priorRefresh,
        expiresAt: this.now() + Number(result.expires_in) * 1000,
      }),
    );
    this.storage.setItem('regi-token', result.id_token);
    return result.id_token;
  }
  async callback(url: string) {
    const parameters = new URL(url).searchParams,
      code = parameters.get('code');
    if (!code) return null;
    const value: unknown = JSON.parse(this.storage.getItem('regi-oauth-pending') ?? 'null');
    const pending = record(value);
    if (
      !pending ||
      typeof pending.verifier !== 'string' ||
      typeof pending.issuedAt !== 'number' ||
      parameters.get('state') !== pending.state ||
      this.now() - pending.issuedAt > 600000 ||
      this.now() < pending.issuedAt ||
      (pending.clientId !== undefined && pending.clientId !== this.config.clientId) ||
      (pending.redirect !== undefined && pending.redirect !== this.config.redirect)
    )
      throw new Error('ログインのstate・有効期限が一致しません');
    this.storage.removeItem('regi-oauth-pending');
    const token = await this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirect,
      code_verifier: pending.verifier,
    });
    this.storage.setItem(
      'regi-oauth-return',
      safeReturnPath(
        typeof pending.returnPath === 'string' ? pending.returnPath : '/',
        new URL(this.config.redirect).origin,
      ),
    );
    return token;
  }
  async token(fallback: string) {
    const value: unknown = JSON.parse(this.storage.getItem('regi-oauth-session') ?? 'null');
    const session = record(value);
    if (!session) return fallback;
    if (
      typeof session.token !== 'string' ||
      typeof session.expiresAt !== 'number' ||
      (session.refresh !== undefined && typeof session.refresh !== 'string')
    )
      throw new Error('認証情報を確認できません。再ログインしてください');
    if (session.expiresAt > this.now() + 30000) return session.token;
    if (!session.refresh) throw new Error('再ログインしてください');
    if (!this.refreshing) {
      const pending = this.exchange(
        { grant_type: 'refresh_token', refresh_token: session.refresh },
        session.refresh,
      ).finally(() => {
        if (this.refreshing === pending) this.refreshing = undefined;
      });
      this.refreshing = pending;
    }
    return this.refreshing;
  }
  returnPath() {
    const path = safeReturnPath(
      this.storage.getItem('regi-oauth-return') ?? '/',
      new URL(this.config.redirect).origin,
    );
    this.storage.removeItem('regi-oauth-return');
    return path;
  }
  logout() {
    this.generation++;
    this.refreshing = undefined;
    for (const key of [
      'regi-token',
      'regi-oauth-session',
      'regi-oauth-pending',
      'regi-oauth-return',
    ])
      this.storage.removeItem(key);
  }
}
const config = import.meta.env ?? {};
export const hostedDomain = config.VITE_COGNITO_DOMAIN as string | undefined;
let instance: BrowserAuth | undefined;
const auth = () =>
  (instance ??= new BrowserAuth(
    {
      domain: hostedDomain ?? '',
      clientId: config.VITE_COGNITO_CLIENT_ID ?? '',
      redirect: location.origin + '/',
    },
    sessionStorage,
  ));
export async function login() {
  location.assign(await auth().authorizationUrl(location.pathname + location.search));
}
export async function callback() {
  const token = await auth().callback(location.href);
  if (token) {
    history.replaceState(null, '', auth().returnPath());
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return token;
}
export const freshToken = (fallback: string) => auth().token(fallback);
export const logout = () => auth().logout();
