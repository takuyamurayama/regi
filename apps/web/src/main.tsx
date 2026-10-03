import React, { useEffect, useState, useRef } from 'react';
import { businessDate } from '@regi/core';
import { OperationStatusDtoSchema } from '@regi/core/finance';
import { createRoot } from 'react-dom/client';
import './style.css';
import { Purchases, Refunds, Management, Stocktakes, ReceiptCorrections } from './workflows';
import { login, callback, hostedDomain, freshToken, logout } from './auth';
import { Dashboard } from './Dashboard';
import { Icon, type IconName } from './Icon';
import { Table } from './Table';
import { yen } from './presentation';
import { reportPeriod } from './report-period';
import { readApiResponse, networkError } from './api-response';
import { ActionIntents, type IntentDescriptor } from './action-intent';
import { webActor, webStores, webTenant, intentOrigin } from './web-context';
import { SyncReviews } from './SyncReviews';
import { Finance } from './Finance';
import type { FinanceSection } from './finance-ui';
import { isPage, readRoute, routeUrl, safeReturnPath, type WebRoute } from './routing';
const initialPeriod = reportPeriod(location.search, import.meta.env.VITE_DEMO_HISTORY_END);
const defaultTenant = '10000000-0000-4000-8000-000000000001';
const navigation = [
  'ダッシュボード',
  '商品・価格',
  '発注・入荷',
  '在庫・移動',
  '返品・取引',
  '開局・締め',
  'AI・需要予測',
  '同期状況',
  '管理設定',
];
const financeSections: Partial<Record<string, FinanceSection>> = {
  '仕入明細・請求': 'invoices',
  '買掛・支払': 'payables',
  '仕入返品・減額': 'returns',
  仕入先: 'suppliers',
};
const purchaseNavigation = ['発注・入荷', ...Object.keys(financeSections)];
const navigationIcons: IconName[] = [
  'overview',
  'products',
  'orders',
  'inventory',
  'refund',
  'clock',
  'book',
  'sync',
  'settings',
];
const pageDescriptions: Record<string, string> = {
  '商品・価格': '商品情報から、次の価格まで。登録・予約・CSV取込を一か所で。',
  '発注・入荷': '仕入れの流れを、ひとつに。発注から分納まで、記録をつなぎます。',
  '在庫・移動': 'いまある在庫を、正確に。増減・棚卸・店舗間移動を管理します。',
  '返品・取引': '一つひとつの取引に、確かな記録を。返品可能数を確認して、返金へ。',
  '開局・締め': '一日のはじまりと終わりを、すっきり。現金と同期状況を照合します。',
  'AI・需要予測': 'データを、判断の味方に。予測・提案・集計を根拠とともに。',
  同期状況: '店舗と本部の記録をつなぐ。同期位置と要確認の原記録を確認します。',
  管理設定: 'あなたの店舗に、フィットする設定。権限・契約・帳票を一か所で。',
  '仕入明細・請求': '入荷と請求を照合し、税額と原資料を仕入記録へつなぎます。',
  '買掛・支払': '仕入先への未払残高と、実際の支払・返金を確認します。',
  '仕入返品・減額': '物品の返品と請求減額を区別し、数量と金額を記録します。',
  仕入先: '仕入先の連絡先と取引条件を管理します。',
};
function App() {
  const [route, setRoute] = useState(() =>
    readRoute(location.pathname, location.search, import.meta.env.VITE_DEMO_HISTORY_END),
  );
  const page = route.page;
  const [settings, setSettings] = useState<any>(null),
    [store, setStore] = useState(''),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [products, setProducts] = useState<any[]>([]),
    [orders, setOrders] = useState<any[]>([]),
    [sales, setSales] = useState<any[]>([]),
    [refunds, setRefunds] = useState<any[]>([]),
    [shifts, setShifts] = useState<any[]>([]),
    [exports, setExports] = useState<any[]>([]);
  const [token, setToken] = useState(sessionStorage.getItem('regi-token') ?? ''),
    [subject, setSubject] = useState(sessionStorage.getItem('regi-dev-subject') ?? 'local-admin');
  const [product, setProduct] = useState({
    sku: '',
    name: '',
    jan: '',
    price: '',
    cost: '',
    taxCode: 'standard',
    stockManaged: true,
  });
  const [quantity, setQuantity] = useState('1'),
    [supplier, setSupplier] = useState(''),
    [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [reference, setReference] = useState(''),
    [target, setTarget] = useState(''),
    [shiftId, setShiftId] = useState(''),
    [cash, setCash] = useState('10000'),
    [question, setQuestion] = useState('売上の傾向を説明'),
    [metric, setMetric] = useState('sales');
  const [editing, setEditing] = useState<any>(null),
    [effectiveAt, setEffectiveAt] = useState(''),
    [pin, setPin] = useState(''),
    [aiResult, setAiResult] = useState<any>(null),
    [suggestions, setSuggestions] = useState<any[]>([]),
    [transfers, setTransfers] = useState<any[]>([]),
    [reviews, setReviews] = useState<any[]>([]);
  const [from, setFromValue] = useState(route.from),
    [to, setToValue] = useState(route.to);
  const cashValid = /^(0|[1-9][0-9]{0,29})$/.test(cash);
  const hasOpenShifts = shifts.some((entry: { status: string }) => entry.status === 'open');
  const shiftSelectionValid = shifts.some(
    (entry: { id: string; status: string }) => entry.id === shiftId && entry.status === 'open',
  );
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [exportsOpen, setExportsOpen] = useState(false),
    [exportPollingError, setExportPollingError] = useState(''),
    [downloading, setDownloading] = useState('');
  const exportPanel = useRef<HTMLElement>(null);
  const visibleExports = exports.filter((entry) => (entry.store_id ?? entry.storeId) === store),
    hasPendingExports = visibleExports.some((entry) =>
      ['queued', 'running'].includes(entry.status),
    );
  const credentialKey = JSON.stringify([
      token,
      subject,
      sessionStorage.getItem('regi-dev-tenant') ?? defaultTenant,
    ]),
    settingsCredential = useRef('');
  const activeSettings = settingsCredential.current === credentialKey ? settings : null;
  const actor = webActor(activeSettings),
    availableStores = webStores(activeSettings),
    storeReady = Boolean(actor && availableStores.some((entry) => entry.id === store));
  const scopeKey = JSON.stringify([
      page,
      store,
      from,
      to,
      subject,
      token,
      route.invoiceId,
      actor?.staffId,
      actor?.role,
      recoveryVersion,
    ]),
    scopeState = useRef({ key: scopeKey, version: 0 });
  if (scopeState.current.key !== scopeKey)
    scopeState.current = { key: scopeKey, version: scopeState.current.version + 1 };
  const scope = scopeState.current,
    currentScope = useRef(scope);
  currentScope.current = scope;
  const busyOwner = useRef<object | null>(null);
  const authState = useRef({
    token,
    subject,
    store,
    tenant: sessionStorage.getItem('regi-dev-tenant') ?? defaultTenant,
  });
  authState.current = {
    token,
    subject,
    store,
    tenant: sessionStorage.getItem('regi-dev-tenant') ?? defaultTenant,
  };
  const productInstant = useRef<{ key: string; value: string } | null>(null);
  const [, redrawIntents] = useState(0);
  const intentsRef = useRef<ActionIntents | null>(null);
  intentsRef.current ??= new ActionIntents(sessionStorage, () =>
    redrawIntents((value) => value + 1),
  );
  const intents = intentsRef.current;
  const intentScope = JSON.stringify([webTenant(settings), actor?.staffId, store]);
  const otherPending = intents.pending().filter((entry) => {
    const origin = intentOrigin(entry.scope);
    return (
      origin?.tenantId === webTenant(settings) &&
      origin?.staffId === actor?.staffId &&
      origin?.storeId !== store &&
      availableStores.some((item) => item.id === origin?.storeId)
    );
  });
  function updateRoute(next: WebRoute, replace = false) {
    if (!next.notFound) history[replace ? 'replaceState' : 'pushState'](null, '', routeUrl(next));
    setRoute(next);
    setStore(next.storeId);
    setFromValue(next.from);
    setToValue(next.to);
  }
  function setPage(value: string) {
    if (!isPage(value)) return;
    setData(null);
    updateRoute({
      ...route,
      page: value,
      storeId: store,
      from,
      to,
      invoiceId: undefined,
      supplierId: undefined,
      asOf: undefined,
      status: undefined,
    });
  }
  const setFrom = (value: string) =>
    updateRoute({ ...route, storeId: store, from: value, to, demoDefault: false }, true);
  const setTo = (value: string) =>
    updateRoute({ ...route, storeId: store, from, to: value, demoDefault: false }, true);
  async function transport(
    path: string,
    options: RequestInit,
    captured = authState.current,
    originatingStore?: string,
  ): Promise<Response> {
    if (!path.startsWith('/v1/') || path.startsWith('//') || /[\\\r\n]/.test(path))
      throw new Error('APIの送信先を確認してください');
    const authorization = await freshToken(captured.token);
    if (
      captured.subject !== authState.current.subject ||
      captured.tenant !== authState.current.tenant ||
      captured.token !== authState.current.token ||
      (originatingStore !== undefined && originatingStore !== authState.current.store)
    )
      throw new Error('元の店舗・操作者で操作を確認してください');
    const requestHeaders = new Headers(options.headers);
    for (const name of ['authorization', 'x-tenant-id', 'x-staff-subject'])
      requestHeaders.delete(name);
    let response: Response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          ...Object.fromEntries(requestHeaders.entries()),
          ...(authorization
            ? { Authorization: `Bearer ${authorization}` }
            : import.meta.env.DEV
              ? {
                  'x-tenant-id': captured.tenant,
                  'x-staff-subject': captured.subject,
                }
              : {}),
        },
      });
    } catch {
      throw networkError();
    }
    return response;
  }
  async function api(path: string, body?: any, method = 'POST'): Promise<any> {
    return readApiResponse(
      await transport(path, {
        method: body ? method : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }
  async function lookupOperation(entry: IntentDescriptor) {
    const requestedScope = currentScope.current;
    const value: unknown = await api(
      `/v1/operations/${encodeURIComponent(entry.id)}/status?storeId=${encodeURIComponent(store)}`,
    );
    const status = OperationStatusDtoSchema.parse(value);
    if (requestedScope !== currentScope.current) return;
    if (status.operationId !== entry.id)
      throw new Error('操作状態の応答を確認できません。未確認の操作を保持しています');
    intents.confirmCommitted(entry.id, intentScope);
    // No old request body or response is reconstructed. Remount the originating records instead.
    setRecoveryVersion((value) => value + 1);
  }
  async function refresh() {
    if (
      !actor ||
      !availableStores.some((entry) => entry.id === store) ||
      route.notFound ||
      from > to
    )
      return;
    const paths: Record<string, string> = {
      ダッシュボード: `/v1/reports/sales?storeId=${store}&from=${from}&to=${to}`,
      '在庫・移動': `/v1/inventory?storeId=${store}`,
      'AI・需要予測': `/v1/ai/forecasts?storeId=${store}`,
      同期状況: '/v1/sync/changes?cursor=0',
    };
    const [
      productRows,
      orderRows,
      saleRows,
      refundRows,
      shiftRows,
      exportRows,
      configuration,
      transferRows,
      report,
      reviewRows,
    ] = await Promise.all([
      api('/v1/products'),
      api(`/v1/documents/purchase-order?storeId=${store}`),
      api(`/v1/documents/sale?storeId=${store}`),
      api(`/v1/documents/refund?storeId=${store}`),
      api(`/v1/documents/shift?storeId=${store}`),
      api(`/v1/documents/export?storeId=${store}`),
      api('/v1/settings'),
      api(`/v1/documents/transfer?storeId=${store}`),
      paths[page] ? api(paths[page]) : null,
      page === '同期状況' && actor.role !== 'cashier'
        ? api(`/v1/sync/reviews?storeId=${store}`)
        : [],
    ]);
    if (scope !== currentScope.current) return;
    setSettings(configuration);
    setTransfers(transferRows);
    setProducts(productRows);
    setOrders(orderRows);
    setSales(saleRows);
    setRefunds(refundRows);
    setShifts(shiftRows);
    setExports(exportRows);
    setData(report);
    setReviews(reviewRows);
  }
  async function action(callback: () => Promise<unknown>) {
    if (busyOwner.current) return;
    const owner = {},
      requestedScope = currentScope.current;
    busyOwner.current = owner;
    setBusy(true);
    setError('');
    try {
      await callback();
      if (requestedScope === currentScope.current) await refresh();
    } catch (caught: unknown) {
      if (requestedScope === currentScope.current)
        setError(
          caught instanceof Error
            ? caught.message
            : '処理結果を確認できません。原記録を確認してください',
        );
    } finally {
      if (busyOwner.current === owner) {
        busyOwner.current = null;
        if (requestedScope === currentScope.current) setBusy(false);
      }
    }
  }
  function productEffectiveAt(): string {
    if (effectiveAt) return new Date(effectiveAt).toISOString();
    const key = JSON.stringify([intentScope, product, editing?.id, editing?.version]);
    if (productInstant.current?.key !== key)
      productInstant.current = { key, value: new Date().toISOString() };
    return productInstant.current.value;
  }
  const post = async (path: string, body: unknown = {}, method = 'POST') => {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new Error('送信内容を確認してください');
    if (!actor || !availableStores.some((entry) => entry.id === store))
      throw new Error('操作者と所属店舗を確認してから送信してください');
    const supplied = body as Record<string, unknown>;
    const requestedScope = currentScope.current,
      capturedAuth = authState.current,
      originatingStore = store;
    const payload: Record<string, unknown> = structuredClone({
      ...(/^\/v1\/suppliers(?:\/|$)/.test(path) ? {} : { storeId: store }),
      ...supplied,
    });
    if ('storeId' in payload && payload.storeId !== originatingStore)
      throw new Error('元の店舗で操作を確認してください');
    const result = await intents.run({
      scope: intentScope,
      path,
      method,
      returnPath: routeUrl({ ...route, storeId: store, from, to }),
      input: payload,
      operationId: typeof payload.operationId === 'string' ? payload.operationId : undefined,
      active: () => requestedScope === currentScope.current,
      send: async (id) =>
        readApiResponse(
          await transport(
            path,
            {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...payload, operationId: id }),
            },
            capturedAuth,
            originatingStore,
          ),
        ),
    });
    if (path === '/v1/exports' && requestedScope === currentScope.current) {
      const exportResult = result as { id: string };
      setExports((current) => [
        exportResult,
        ...current.filter((entry) => entry.id !== exportResult.id),
      ]);
      setExportsOpen(true);
      setExportPollingError('');
      requestAnimationFrame(() => exportPanel.current?.scrollIntoView({ block: 'start' }));
    }
    return result;
  };
  async function fileRequest(
    path: string,
    options: { method?: string; body?: Blob; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const method = options.method ?? 'GET',
      capturedAuth = authState.current,
      originatingStore = store,
      requestedScope = currentScope.current;
    if (!actor || !availableStores.some((entry) => entry.id === store))
      throw new Error('操作者と所属店舗を確認してから送信してください');
    const normalizedHeaders = new Headers(options.headers);
    const operationId = normalizedHeaders.get('x-regi-operation-id') ?? undefined;
    normalizedHeaders.delete('x-regi-operation-id');
    const headers = Object.fromEntries(normalizedHeaders.entries());
    if (['GET', 'HEAD'].includes(method)) {
      const response = await transport(path, { method, headers }, capturedAuth);
      if (!response.ok) await readApiResponse(response);
      return response;
    }
    const body = options.body?.slice(),
      hash = body
        ? Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', await body.arrayBuffer())),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')
        : '';
    const response = await intents.run({
      scope: intentScope,
      path,
      method,
      returnPath: routeUrl({ ...route, storeId: store, from, to }),
      input: {
        hash,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-regi-operation-id'),
        ),
      },
      operationId,
      active: () => requestedScope === currentScope.current,
      send: async (id) => {
        const response = await transport(
          path,
          { method, body, headers: { ...headers, 'X-Regi-Operation-Id': id } },
          capturedAuth,
          originatingStore,
        );
        if (!response.ok) await readApiResponse(response);
        const value: unknown = await readApiResponse(response.clone());
        if (typeof value !== 'object' || value === null)
          throw new Error('保存結果を確認できません。原記録を確認してください');
        return response;
      },
    });
    return response.clone();
  }
  async function downloadExport(entry: any) {
    if (downloading) return;
    setDownloading(entry.id);
    setError('');
    try {
      const response = await fileRequest(`/v1/exports/${entry.id}/download`);
      const blob = await response.blob();
      if (scope !== currentScope.current) return;
      if (!blob.size) throw new Error('帳票が空です。出力履歴から再作成してください');
      const url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `regi-${entry.id}.${entry.body.extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (caught: unknown) {
      if (scope === currentScope.current)
        setError(caught instanceof Error ? caught.message : '帳票を取得できません');
    } finally {
      if (scope === currentScope.current) setDownloading('');
    }
  }
  useEffect(() => {
    if (hostedDomain && !token) return;
    let active = true;
    api('/v1/settings')
      .then((result) => {
        if (active) {
          settingsCredential.current = credentialKey;
          setSettings(result);
          const requested = readRoute(
            location.pathname,
            location.search,
            import.meta.env.VITE_DEMO_HISTORY_END,
          );
          const availableStores = webStores(result);
          const selectedStore = requested.storeId || availableStores[0]?.id || '';
          if (requested.notFound || !availableStores.some((entry) => entry.id === selectedStore)) {
            setStore('');
            return;
          }
          updateRoute({ ...requested, storeId: selectedStore }, true);
        }
      })
      .catch((caught) => {
        if (active) setError(caught.message);
      });
    return () => {
      active = false;
    };
  }, [token, subject]);
  useEffect(() => {
    const restore = () => {
      const next = readRoute(
        location.pathname,
        location.search,
        import.meta.env.VITE_DEMO_HISTORY_END,
      );
      setRoute(next);
      setStore(next.storeId);
      setFromValue(next.from);
      setToValue(next.to);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    busyOwner.current = null;
    setBusy(false);
    setError('');
    setSelected('');
    setReason('');
    setReference('');
    setTarget('');
    setShiftId('');
    setPin('');
    setQuantity('1');
    setCash('10000');
    setEditing(null);
    setEffectiveAt('');
    setDownloading('');
    setProduct({
      sku: '',
      name: '',
      jan: '',
      price: '',
      cost: '',
      taxCode: 'standard',
      stockManaged: true,
    });
    setOrders([]);
    setSales([]);
    setRefunds([]);
    setShifts([]);
    setTransfers([]);
    setReviews([]);
    setData(null);
  }, [scope.version]);
  useEffect(() => {
    callback()
      .then((result) => {
        if (result) {
          setToken(result);
          sessionStorage.setItem('regi-token', result);
        }
      })
      .catch((caught) => setError(caught.message));
  }, []);
  useEffect(() => {
    refresh().catch((caught: unknown) => {
      if (scope === currentScope.current)
        setError(caught instanceof Error ? caught.message : '読取結果を確認できません');
    });
  }, [page, store, from, to, settings?.tenant.id, recoveryVersion]);
  useEffect(() => {
    setExportPollingError('');
    if (!store || !hasPendingExports) return;
    let active = true,
      timer: number;
    const poll = async () => {
      try {
        const result = await api(`/v1/documents/export?storeId=${store}`);
        if (active && scope === currentScope.current) {
          setExports(result);
          setExportPollingError('');
        }
      } catch (caught: any) {
        if (active && scope === currentScope.current)
          setExportPollingError(
            `${caught.message} 完了状態を再確認しています。通信とサーバーの起動状態を確認してください。`,
          );
      } finally {
        if (active) timer = window.setTimeout(poll, 2000);
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [scope, hasPendingExports]);
  const productName = (id: string) => products.find((entry) => entry.id === id)?.name ?? id;
  const productSelect = (
    <select
      aria-label="商品"
      value={selected}
      onChange={(event) => setSelected(event.target.value)}
    >
      <option value="">商品を選択</option>
      {products.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.name}
        </option>
      ))}
    </select>
  );
  const storeSelect = (
    <select aria-label="移動先" value={target} onChange={(event) => setTarget(event.target.value)}>
      <option value="">移動先店舗</option>
      {settings?.stores
        .filter((entry: any) => entry.id !== store)
        .map((entry: any) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
    </select>
  );
  if (hostedDomain && !token)
    return (
      <main className="auth-screen">
        <section>
          <span className="brand-name">REGI</span>
          <h1>店舗管理にログイン</h1>
          <p>
            Cognitoでメールアドレスとパスワードを確認します。追加認証の有無は環境の設定に従います。AWSの認証情報はブラウザーへ入力しません。
          </p>
          <button
            className="primary"
            onClick={() => login().catch((caught) => setError(caught.message))}
          >
            ログイン
          </button>
          {error && <p role="alert">{error}</p>}
        </section>
      </main>
    );
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        メインコンテンツへ
      </a>
      <aside aria-label="本部サイドバー">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="store" />
          </span>
          <div className="brand-copy">
            <div className="brand-name">REGI</div>
            <small>店舗のための管理ツール</small>
          </div>
        </div>
        <div className="workspace">
          <span className="workspace-icon">
            <Icon name="store" />
          </span>
          <div className="workspace-label">
            本部管理<small>{settings?.tenant.name ?? 'ログイン待ち'}</small>
          </div>
        </div>
        <div className="nav-label">
          メニュー <span>店舗・本部の業務管理</span>
        </div>
        <nav aria-label="本部メニュー">
          {navigation.map((item, index) => (
            <button
              aria-label={item}
              aria-current={
                item === page || (item === '発注・入荷' && financeSections[page])
                  ? 'page'
                  : undefined
              }
              title={item}
              className={
                item === page || (item === '発注・入荷' && financeSections[page]) ? 'active' : ''
              }
              onClick={() => {
                setData(null);
                setPage(item);
              }}
              key={item}
            >
              <Icon name={navigationIcons[index]} />
              <span className="navigation-text">{item}</span>
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <div className="plan-label">
            <i />
            REGI Standard
          </div>
          <small>1法人 / 最大5店舗 / 24か月</small>
          <div className="sidebar-footer">
            <span className="avatar" aria-hidden="true">
              R
            </span>
            <div>
              商いの記録<small>販売・仕入・在庫をひとつに</small>
            </div>
          </div>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <header className="app-header">
          <div>
            <div className="breadcrumb">
              <span>REGI</span>
              <span className="separator">/</span>
              <span>本部管理</span>
            </div>
            <h1>{page}</h1>
          </div>
          <div className="header-controls">
            <span className="online">オンライン管理</span>
            <div className="store-selector">
              <Icon name="store" />
              <select
                disabled={busy}
                aria-label="店舗"
                value={store}
                onChange={(event) => {
                  setData(null);
                  updateRoute({
                    ...route,
                    storeId: event.target.value,
                    from,
                    to,
                    invoiceId: undefined,
                    supplierId: undefined,
                    status: undefined,
                  });
                }}
              >
                <option value="">店舗を選択</option>
                {availableStores.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="refresh-button"
              aria-label="更新"
              disabled={busy}
              onClick={() => action(refresh)}
            >
              <Icon name="sync" className={busy ? 'refreshing' : ''} />
              <span className="refresh-label">更新</span>
            </button>
          </div>
        </header>
        <div className="content" aria-busy={busy}>
          {settings && !storeReady && !route.notFound && (
            <div role="alert" className="error">
              この店舗・画面は表示できません。所属店舗とURLを確認してください
            </div>
          )}
          {otherPending.map((entry) => {
            const origin = intentOrigin(entry.scope),
              savedPath = safeReturnPath(entry.returnPath, location.origin);
            return (
              <section
                key={entry.id}
                aria-label="別店舗の未確認操作"
                className="notice intent-recovery"
              >
                <b>店舗切替前の操作の結果が未確認です</b>
                <p>
                  {availableStores.find((item) => item.id === origin?.storeId)?.name}{' '}
                  の原記録を確認してください。新しい店舗への再送は行いません。
                </p>
                <button
                  onClick={() => {
                    const url = new URL(savedPath, location.origin),
                      next = readRoute(
                        url.pathname,
                        url.search,
                        import.meta.env.VITE_DEMO_HISTORY_END,
                      );
                    if (origin && availableStores.some((item) => item.id === origin.storeId))
                      updateRoute({ ...next, storeId: origin.storeId });
                  }}
                >
                  元の店舗で操作を確認
                </button>
              </section>
            );
          })}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {busy && (
            <div role="status" className="notice">
              保存中です。同じ操作を重ねずお待ちください。
            </div>
          )}
          {intents.pending(intentScope).map((entry) => (
            <section className="notice intent-recovery" key={entry.id} aria-label="未確認の操作">
              <b>先の操作の結果が未確認です</b>
              <p>原記録を再取得して確認してください。同じ操作の再確認には元の操作IDを使います。</p>
              <div className="row">
                <button
                  disabled={busy}
                  onClick={() => {
                    void action(() => lookupOperation(entry));
                  }}
                >
                  保存結果を照会
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void action(refresh);
                  }}
                >
                  原記録を再取得
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void action(() => intents.retry(entry.id, intentScope));
                  }}
                >
                  同じ操作を再確認
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    const target = new URL(
                      safeReturnPath(entry.returnPath, location.origin),
                      location.origin,
                    );
                    updateRoute(readRoute(target.pathname, target.search));
                  }}
                >
                  元の画面へ戻る
                </button>
              </div>
              <details>
                <summary>問い合わせ用の操作情報</summary>
                <code>{entry.id}</code>
              </details>
            </section>
          ))}
          {intents.acknowledged(intentScope) && !busy && (
            <div className="notice intent-completed" role="status">
              <span>
                保存済み・原記録の再取得。表示の再取得に失敗しても、保存した操作は重ねません。
              </span>
              <button
                onClick={() => {
                  intents.startNew(intentScope);
                  productInstant.current = null;
                }}
              >
                新しい操作を開始
              </button>
            </div>
          )}
          {(settings?.demo?.synthetic || initialPeriod.demoDefault) && (
            <section className="demo-banner" aria-label="架空データの検証環境">
              <div>
                <b>デモ環境 · 実在の販売実績ではありません</b>
                <p>
                  {settings?.demo?.synthetic
                    ? `${settings.demo.startDay} ～ ${settings.demo.endDay} の${settings.demo.days}日分の架空データ。`
                    : `初期表示は ${initialPeriod.from} ～ ${initialPeriod.to} のデモ期間です。`}
                  今日の売上には過去のデモ売上を含めません。
                </p>
              </div>
              {settings?.demo?.synthetic && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setData(null);
                    updateRoute({
                      ...route,
                      page: 'ダッシュボード',
                      storeId: store,
                      from: settings.demo.startDay,
                      to: settings.demo.endDay,
                    });
                  }}
                >
                  デモ期間を表示
                </button>
              )}
            </section>
          )}
          {purchaseNavigation.includes(page) && (
            <nav className="purchase-navigation" aria-label="仕入業務">
              {purchaseNavigation.map((item) => (
                <button
                  key={item}
                  aria-current={item === page ? 'page' : undefined}
                  className={item === page ? 'active' : ''}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ))}
            </nav>
          )}
          {page !== 'ダッシュボード' && !financeSections[page] && (
            <div className="page-intro">
              <span className="eyebrow">商いの記録</span>
              <h2>{page}</h2>
              <p>{pageDescriptions[page]}</p>
            </div>
          )}
          {route.notFound && (
            <section role="alert">
              <h2>画面が見つかりません</h2>
              <p>URLと店舗の指定を確認してください。</p>
            </section>
          )}
          {page === 'ダッシュボード' && !route.notFound && (
            <Dashboard
              report={data}
              sales={sales}
              storeName={settings?.stores.find((entry: any) => entry.id === store)?.name ?? ''}
              from={from}
              to={to}
              onFromChange={setFrom}
              onToChange={setTo}
              onNavigate={setPage}
            />
          )}

          {financeSections[page] &&
            !route.notFound &&
            actor &&
            availableStores.some((entry) => entry.id === store) && (
              <Finance
                key={`finance:${scope.version}`}
                section={financeSections[page]}
                invoiceId={route.invoiceId}
                store={store}
                scopeKey={`${scopeKey}:${scope.version}`}
                actorRole={actor.role}
                actorStaffId={actor.staffId}
                busy={busy}
                api={api}
                post={post}
                fileRequest={fileRequest}
                action={action}
                navigate={(path) => {
                  const safe = safeReturnPath(path, location.origin);
                  if (safe === '/' && path !== '/')
                    throw new Error('画面の移動先を確認してください');
                  const url = new URL(safe, location.origin);
                  const next = readRoute(
                    url.pathname,
                    url.search,
                    import.meta.env.VITE_DEMO_HISTORY_END,
                  );
                  if (!next.storeId) next.storeId = store;
                  if (next.notFound || !availableStores.some((entry) => entry.id === next.storeId))
                    throw new Error('元の店舗で操作を確認してください');
                  updateRoute(next);
                }}
              />
            )}
          {page === '商品・価格' && (
            <>
              <section>
                <h3>商品登録・価格予約</h3>
                <div className="form-grid">
                  {(['sku', 'name', 'jan', 'price', 'cost'] as const).map((key, index) => (
                    <label key={key}>
                      {['SKU', '商品名', 'JAN', '単価（円）', '標準原価（円）'][index]}
                      <input
                        value={product[key]}
                        onChange={(event) => setProduct({ ...product, [key]: event.target.value })}
                      />
                    </label>
                  ))}
                  <label>
                    税区分
                    <select
                      value={product.taxCode}
                      onChange={(event) => setProduct({ ...product, taxCode: event.target.value })}
                    >
                      {[
                        ...new Set<string>(
                          settings?.taxRates.map((entry: any) => entry.code) ?? [],
                        ),
                      ].map((code) => (
                        <option key={code}>{code}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={product.stockManaged}
                      onChange={(event) =>
                        setProduct({ ...product, stockManaged: event.target.checked })
                      }
                    />
                    在庫管理する
                  </label>
                </div>
                <button
                  disabled={busy || !storeReady}
                  className="primary"
                  onClick={() =>
                    action(() =>
                      post(
                        editing ? `/v1/products/${editing.id}` : '/v1/products',
                        {
                          ...product,
                          jan: product.jan || null,
                          effectiveAt: productEffectiveAt(),
                          version: editing?.version,
                        },
                        editing ? 'PATCH' : 'POST',
                      ),
                    )
                  }
                >
                  商品を登録
                </button>
                <div className="row">
                  <select
                    aria-label="編集商品"
                    value={editing?.id ?? ''}
                    onChange={(event) => {
                      const entry = products.find((product) => product.id === event.target.value);
                      setEditing(entry ?? null);
                      if (entry)
                        setProduct({
                          sku: entry.sku,
                          name: entry.name,
                          jan: entry.jan ?? '',
                          price: entry.price,
                          cost: entry.cost,
                          taxCode: entry.tax_code,
                          stockManaged: entry.stock_managed,
                        });
                    }}
                  >
                    <option value="">新規登録</option>
                    {products.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                  <label>
                    適用開始日時
                    <input
                      type="datetime-local"
                      value={effectiveAt}
                      onChange={(event) => setEffectiveAt(event.target.value)}
                    />
                  </label>
                  <label>
                    商品CSV取込
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file)
                          action(async () =>
                            post('/v1/products/import', { csv: await file.text() }),
                          );
                      }}
                    />
                  </label>
                </div>
                <p>CSV見出し: sku,jan,name,price,cost,taxCode,stockManaged（true / false）</p>
              </section>
              <section>
                <h3>商品マスター</h3>
                <Table
                  headers={['SKU', '商品名', 'JAN', '税込単価', '税率', '原価', '在庫管理']}
                  rows={products.map((entry) => [
                    entry.sku,
                    entry.name,
                    entry.jan,
                    yen(entry.price),
                    `${entry.rate_bps / 100}%`,
                    yen(entry.cost),
                    entry.stock_managed ? '対象' : '対象外',
                  ])}
                />
              </section>
            </>
          )}
          {page === '発注・入荷' && (
            <>
              <Purchases
                key={`purchases:${scope.version}`}
                api={api}
                post={post}
                action={action}
                busy={busy || !storeReady}
                products={products}
                orders={orders}
                store={store}
                actorRole={actor?.role}
              />
              <ReceiptCorrections
                key={`receipts:${scope.version}`}
                api={api}
                post={post}
                action={action}
                busy={busy}
                products={products}
                orders={orders}
                store={store}
              />
            </>
          )}
          {page === '在庫・移動' && (
            <>
              <section>
                <h3>在庫増減 / 店舗間移動</h3>
                <div className="row">
                  {productSelect}
                  <input
                    aria-label="数量"
                    type="number"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                  />
                  <input
                    placeholder="調整理由"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post('/v1/inventory/adjustments', {
                          productId: selected,
                          quantity: Number(quantity),
                          reason,
                        }),
                      )
                    }
                  >
                    増減を記録
                  </button>
                  {storeSelect}
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post('/v1/transfers', {
                          toStoreId: target,
                          lines: [{ productId: selected, quantity: Number(quantity) }],
                        }),
                      )
                    }
                  >
                    出庫
                  </button>
                </div>
                <p>残高の直接上書きは行いません。マイナス在庫は確認・調整対象です。</p>
              </section>
              <Stocktakes
                key={`stocktakes:${scope.version}`}
                api={api}
                post={post}
                action={action}
                busy={busy}
                products={products}
                store={store}
              />
              <section>
                <h3>店舗間移動</h3>
                {transfers.map((transfer) => (
                  <div className="order" key={transfer.id}>
                    <span>
                      {transfer.id.slice(0, 8)} / {transfer.status}
                    </span>
                    {transfer.status === 'transit' && transfer.body.toStoreId === store && (
                      <button
                        disabled={busy}
                        onClick={() => action(() => post(`/v1/transfers/${transfer.id}/receive`))}
                      >
                        移動品を受入
                      </button>
                    )}
                  </div>
                ))}
                <h3>店舗別在庫</h3>
                <Table
                  headers={['商品', '数量', '警告']}
                  rows={(Array.isArray(data) ? data : []).map((entry) => [
                    productName(entry.product_id),
                    entry.quantity,
                    Number(entry.quantity) < 0 ? 'マイナス在庫 / 要調整' : '—',
                  ])}
                />
              </section>
            </>
          )}
          {page === '返品・取引' && (
            <Refunds
              key={`refunds:${scope.version}`}
              api={api}
              post={post}
              action={action}
              busy={busy}
              products={products}
              sales={sales}
              refunds={refunds}
              shifts={shifts}
              store={store}
            />
          )}
          {page === '開局・締め' && (
            <>
              <section>
                <h3>端末開局 / 現金 / 店舗日締め</h3>
                <div className="row shift-actions">
                  <label>
                    担当者PIN
                    <input
                      aria-label="担当者PIN"
                      type="password"
                      placeholder="担当者PIN"
                      value={pin}
                      onChange={(event) => setPin(event.target.value)}
                    />
                  </label>
                  <label>
                    現金額（円）
                    <input
                      aria-label="現金額"
                      value={cash}
                      onChange={(event) => setCash(event.target.value)}
                      inputMode="numeric"
                      aria-invalid={!cashValid}
                      aria-describedby={!cashValid ? 'shift-cash-help' : undefined}
                    />
                    {!cashValid && (
                      <small id="shift-cash-help" className="field-error">
                        現金額は0以上の整数で入力してください（最大30桁、先頭の0は不要）。
                      </small>
                    )}
                  </label>
                  <button
                    disabled={busy || !cashValid || !pin.trim()}
                    onClick={() =>
                      action(async () => {
                        const result = await post('/v1/shifts', {
                          deviceId: settings.devices.find((entry: any) => entry.store_id === store)
                            ?.id,
                          opening: cash,
                          pin,
                        });
                        if (
                          typeof result === 'object' &&
                          result !== null &&
                          'id' in result &&
                          typeof result.id === 'string'
                        )
                          setShiftId(result.id);
                      })
                    }
                  >
                    開局
                  </button>
                  <label>
                    開局記録
                    <select
                      aria-label="開局記録"
                      value={shiftId}
                      onChange={(event) => setShiftId(event.target.value)}
                      aria-describedby={!shiftSelectionValid ? 'shift-selection-help' : undefined}
                    >
                      <option value="">開局記録を選択</option>
                      {shifts
                        .filter((entry) => entry.status === 'open')
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {
                              settings?.devices.find(
                                (device: any) => device.id === entry.body.deviceId,
                              )?.name
                            }{' '}
                            / {new Date(entry.created_at).toLocaleString('ja-JP')}
                          </option>
                        ))}
                    </select>
                    {!shiftSelectionValid && (
                      <small id="shift-selection-help">
                        {hasOpenShifts
                          ? '現金の入出金・端末暫定締めには、開局記録を選択してください。'
                          : '営業中の開局記録がありません。先に開局してください。'}
                      </small>
                    )}
                  </label>
                  <label>
                    現金移動理由
                    <input
                      aria-label="現金移動理由"
                      placeholder="現金移動理由"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      aria-invalid={reason.length > 0 && !reason.trim()}
                      aria-describedby={!reason.trim() ? 'shift-reason-help' : undefined}
                    />
                    {!reason.trim() && (
                      <small id="shift-reason-help">現金入出金の理由を入力してください。</small>
                    )}
                  </label>
                  <button
                    disabled={busy || !shiftSelectionValid || !cashValid || !reason.trim()}
                    onClick={() =>
                      action(() =>
                        post('/v1/cash-movements', {
                          shiftId,
                          amount: cash,
                          direction: 'in',
                          reason: reason.trim(),
                        }),
                      )
                    }
                  >
                    現金入金
                  </button>
                  <button
                    disabled={busy || !shiftSelectionValid || !cashValid || !reason.trim()}
                    onClick={() =>
                      action(() =>
                        post('/v1/cash-movements', {
                          shiftId,
                          amount: cash,
                          direction: 'out',
                          reason: reason.trim(),
                        }),
                      )
                    }
                  >
                    現金出金
                  </button>
                  <button
                    disabled={busy || !shiftSelectionValid || !cashValid}
                    onClick={() =>
                      action(() => post(`/v1/shifts/${shiftId}/close`, { actual: cash }))
                    }
                  >
                    端末暫定締め
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => action(() => post('/v1/day-closes', { day: to }))}
                  >
                    店舗日締め確定
                  </button>
                </div>
              </section>
              <section>
                <Table
                  headers={['端末', '状態', '準備金', '実査額', '差額']}
                  rows={shifts.map((entry) => [
                    settings?.devices.find(
                      (device: { id: string; name: string }) => device.id === entry.body.deviceId,
                    )?.name ?? '端末情報を確認してください',
                    (
                      { open: '開局中', provisional: '暫定締め済み', closed: '締め済み' } as Record<
                        string,
                        string
                      >
                    )[String(entry.status)] ?? '状態を確認してください',
                    yen(entry.body.opening),
                    entry.body.actual ?? '—',
                    entry.body.difference ?? '—',
                  ])}
                />
              </section>
            </>
          )}
          {page === 'AI・需要予測' && (
            <>
              <section className="strategy-card">
                <span className="tag">STRATEGY NOTES · 集計の根拠</span>
                <h3>集計を根拠に照会</h3>
                <div className="row">
                  <label>
                    照会対象
                    <select
                      aria-label="照会する集計"
                      value={metric}
                      onChange={(event) => setMetric(event.target.value)}
                    >
                      {[
                        ['sales', '売上'],
                        ['payments', '支払方法別売上'],
                        ['profit', '概算粗利'],
                        ['inventory', '在庫'],
                        ['orders', '発注'],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    aria-label="AI質問"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        const result = await post('/v1/ai/query', { metric, question, from, to });
                        setAiResult(result);
                      })
                    }
                  >
                    照会する
                  </button>
                </div>
                <p>
                  日本時間の暦月ごとに5,000回（日報を含む）。入力上限12,000・出力上限2,000トークン。Bedrock未接続時は利用枠を戻します。生成文で集計の数値は書き換えません。
                </p>
                {aiResult?.updatedAt && (
                  <p>
                    対象店舗:{' '}
                    {settings?.stores.find((entry: any) => entry.id === aiResult.storeId)?.name ??
                      aiResult.storeId}{' '}
                    / {aiResult.from} ～ {aiResult.to} / 更新日時:{' '}
                    {new Date(aiResult.updatedAt).toLocaleString('ja-JP', {
                      timeZone: 'Asia/Tokyo',
                    })}
                    （日本時間） / {aiResult.dataSufficiency}{' '}
                    <a href={aiResult.link}>根拠の集計画面へ</a>
                  </p>
                )}
                {aiResult?.explanation && <p>{aiResult.explanation}</p>}
                {aiResult?.evidence && <pre>{JSON.stringify(aiResult.evidence, null, 2)}</pre>}
              </section>
              <section>
                <h3>推奨発注 / 基準在庫設定</h3>
                <div className="row">
                  {productSelect}
                  <input
                    aria-label="基準在庫"
                    type="number"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post('/v1/ai/reorder-policy', {
                          productId: selected,
                          baseStock: Number(quantity),
                          safetyStock: 3,
                          leadDays: 3,
                          minimum: 1,
                          multiple: 1,
                        }),
                      )
                    }
                  >
                    基準在庫を設定
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(async () =>
                        setSuggestions(await api(`/v1/ai/recommendations?storeId=${store}`)),
                      )
                    }
                  >
                    発注推奨を計算
                  </button>
                  <input
                    placeholder="仕入先"
                    value={supplier}
                    onChange={(event) => setSupplier(event.target.value)}
                  />
                </div>
                {suggestions.map((suggestion) => (
                  <div className="order" key={suggestion.productId}>
                    <span>
                      {suggestion.name} / {suggestion.quantity} 個 / {suggestion.method} /{' '}
                      {suggestion.updatedAt ?? '更新記録なし'}
                    </span>
                    {suggestion.quantity > 0 && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(() =>
                            post('/v1/purchase-orders', {
                              supplier,
                              expectedAt: to,
                              lines: [
                                {
                                  productId: suggestion.productId,
                                  quantity: suggestion.quantity,
                                  unitCost:
                                    products.find((product) => product.id === suggestion.productId)
                                      ?.cost ?? '0',
                                },
                              ],
                            }),
                          )
                        }
                      >
                        提案から発注下書き
                      </button>
                    )}
                  </div>
                ))}
                <h3>翌7日需要予測</h3>
                <Table
                  headers={['商品', '営業日', '予測数', '方式', '更新日時']}
                  rows={(Array.isArray(data) ? data : []).map((entry) => [
                    productName(entry.product_id),
                    entry.day,
                    entry.quantity,
                    entry.method,
                    entry.generated_at,
                  ])}
                />
                <p>履歴不足・精度不足は基準在庫方式。同期未完了日は学習に含めません。</p>
              </section>
            </>
          )}
          {page === '同期状況' && (
            <SyncReviews
              key={`sync:${scope.version}`}
              records={reviews}
              devices={settings?.devices ?? []}
              cursor={data?.cursor}
              store={store}
              actor={actor}
              busy={busy}
              post={post}
              action={action}
            />
          )}
          {page === '管理設定' && (
            <>
              <section>
                <h3>認証・契約</h3>
                <div className="row">
                  {hostedDomain && (
                    <button onClick={() => login().catch((caught) => setError(caught.message))}>
                      Cognitoログイン
                    </button>
                  )}
                  {import.meta.env.DEV && (
                    <>
                      <input
                        aria-label="認証トークン"
                        type="password"
                        placeholder="Cognito ID token"
                        value={token}
                        onChange={(event) => {
                          setToken(event.target.value);
                          sessionStorage.setItem('regi-token', event.target.value);
                        }}
                      />
                      <select value={subject} onChange={(event) => setSubject(event.target.value)}>
                        <option>local-admin</option>
                        <option>local-cashier</option>
                      </select>
                    </>
                  )}
                  <button
                    onClick={() => {
                      logout();
                      intents.forgetBodies();
                      setProducts([]);
                      setOrders([]);
                      setSales([]);
                      setRefunds([]);
                      setShifts([]);
                      setExports([]);
                      setData(null);
                      setToken('');
                      sessionStorage.removeItem('regi-token');
                      setSettings(null);
                    }}
                  >
                    ログアウト
                  </button>
                </div>
                <p>
                  ローカル認証は開発サーバーのみ。商用環境は管理者MFA必須です。個人の架空データ検証環境だけ、メールアドレスとパスワードでログインできます。
                </p>
                <p>
                  契約満了: {settings?.tenant.ends_at} / 価格入力: {settings?.tenant.price_mode}
                </p>
                <Table
                  headers={['担当者', '権限', '有効']}
                  rows={
                    settings?.staff.map((entry: any) => [
                      entry.name,
                      entry.role,
                      entry.active ? '有効' : '無効',
                    ]) ?? []
                  }
                />
                <div className="row">
                  <input
                    placeholder="追加店舗名 / 更新契約番号"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() => action(() => post('/v1/settings/store', { name: reason }))}
                  >
                    店舗追加
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() => post('/v1/settings/renew-contract', { proof: reason }))
                    }
                  >
                    署名付き契約で12か月更新
                  </button>
                </div>
              </section>
              <Management
                key={`management:${scope.version}`}
                api={api}
                post={post}
                action={action}
                busy={busy}
                products={products}
                settings={settings}
                store={store}
              />
            </>
          )}
          {!financeSections[page] && (
            <section className="exports" ref={exportPanel}>
              <div className="section-heading">
                <div className="export-heading">
                  <Icon name="download" />
                  <div>
                    <h3>データ・帳票出力</h3>
                    <p>店舗の記録を、必要な形式で。</p>
                  </div>
                </div>
                <div className="export-actions">
                  <button
                    disabled={busy}
                    onClick={() => action(() => post('/v1/exports', { format: 'csv' }))}
                  >
                    取引CSVを作成
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => action(() => post('/v1/exports', { format: 'bundle' }))}
                  >
                    CSV・保存帳票一式を作成
                  </button>
                </div>
              </div>
              <details
                className="export-history"
                open={exportsOpen}
                onToggle={(event) => setExportsOpen(event.currentTarget.open)}
              >
                <summary>
                  <Icon name="folder" />
                  出力履歴 <span className="export-count">{visibleExports.length}</span>
                  <Icon name="chevron" />
                </summary>
                <p role="status">
                  {hasPendingExports
                    ? '帳票を作成中です。完了状態は自動更新されます。'
                    : '作成完了した帳票は、下のダウンロードボタンで保存できます。'}{' '}
                  一式出力はPDF・CSVを含む圧縮ファイルです。
                </p>
                {exportPollingError && (
                  <p role="alert" className="error">
                    {exportPollingError}
                  </p>
                )}
                {visibleExports.map((entry) => (
                  <div className="row export-record" data-export-id={entry.id} key={entry.id}>
                    <span>
                      {(
                        {
                          csv: '取引CSV',
                          bundle: 'CSV・保存帳票一式',
                          'purchase-pdf': '発注書PDF',
                          'receipt-pdf': '領収書PDF',
                          'refund-pdf': '返還伝票PDF',
                        } as Record<string, string>
                      )[entry.body.format] ?? entry.body.format}{' '}
                      /{' '}
                      {entry.status === 'completed'
                        ? '作成完了'
                        : entry.body.error
                          ? '作成エラー・再試行待ち'
                          : entry.status === 'running'
                            ? '作成中'
                            : '作成待ち'}
                      <small>
                        出力番号 {entry.id.slice(0, 8)}
                        {entry.created_at
                          ? ` / ${new Date(entry.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`
                          : ''}
                      </small>
                    </span>
                    {entry.status === 'completed' && (
                      <button
                        disabled={busy || Boolean(downloading)}
                        onClick={() => downloadExport(entry)}
                      >
                        {downloading === entry.id
                          ? 'ダウンロード中…'
                          : entry.body.extension === 'pdf'
                            ? 'PDFをダウンロード'
                            : entry.body.extension === 'csv'
                              ? 'CSVをダウンロード'
                              : '一式をダウンロード'}
                      </button>
                    )}
                  </div>
                ))}
              </details>
            </section>
          )}
          <footer>
            <span>
              <strong>REGI</strong> · 店舗運営を、もっとシンプルに。
            </span>
            <span>販売・仕入・在庫の一貫管理</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
