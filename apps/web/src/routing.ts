import { reportPeriod } from './report-period';

export const pagePaths = {
  ダッシュボード: '/dashboard',
  '商品・価格': '/products',
  '発注・入荷': '/purchases/orders',
  '在庫・移動': '/inventory',
  '返品・取引': '/sales',
  '開局・締め': '/shifts',
  'AI・需要予測': '/ai',
  同期状況: '/sync',
  管理設定: '/settings',
  '仕入明細・請求': '/purchases/invoices',
  '買掛・支払': '/purchases/payables',
  '仕入返品・減額': '/purchases/returns',
  仕入先: '/purchases/suppliers',
} as const;
export type PageName = keyof typeof pagePaths;
export interface WebRoute {
  page: PageName;
  storeId: string;
  from: string;
  to: string;
  invoiceId?: string;
  supplierId?: string;
  asOf?: string;
  status?: string;
  notFound?: boolean;
  demoDefault: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const calendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export function isPage(value: string): value is PageName {
  return Object.hasOwn(pagePaths, value);
}

export function readRoute(
  pathname: string,
  search: string,
  demoHistoryEnd?: string,
  now = new Date(),
): WebRoute {
  const query = new URLSearchParams(search);
  const period = reportPeriod(search, demoHistoryEnd, now);
  const entry = Object.entries(pagePaths).find(([, path]) => path === pathname.replace(/\/$/, ''));
  const invoice = /^\/purchases\/invoices\/([^/]+)\/?$/.exec(pathname);
  const legacy = query.get('page');
  const page =
    entry?.[0] ??
    (invoice ? '仕入明細・請求' : pathname === '/' ? (legacy ?? 'ダッシュボード') : '');
  const storeId = query.get('storeId') ?? '';
  const invoiceId = invoice?.[1] ?? query.get('invoiceId') ?? undefined;
  const supplierId = query.get('supplierId') ?? undefined;
  const asOf = query.get('asOf') ?? undefined;
  const status = query.get('status') ?? undefined;
  const notFound =
    !isPage(page) ||
    (storeId !== '' && !uuid.test(storeId)) ||
    !calendarDate(period.from) ||
    !calendarDate(period.to) ||
    period.from > period.to ||
    (invoiceId !== undefined && !uuid.test(invoiceId)) ||
    (supplierId !== undefined && !uuid.test(supplierId)) ||
    (asOf !== undefined && !calendarDate(asOf)) ||
    (status !== undefined &&
      ![
        'unpaid',
        'partially-paid',
        'settled',
        'refund-due',
        'draft',
        'posted',
        'cancelled',
        'voided',
        'overdue',
      ].includes(status));
  return {
    page: isPage(page) ? page : 'ダッシュボード',
    storeId,
    from: period.from,
    to: period.to,
    invoiceId,
    supplierId,
    asOf,
    status,
    ...(notFound ? { notFound: true } : {}),
    demoDefault: period.demoDefault,
  };
}

export function routeUrl(route: WebRoute): string {
  let path: string = pagePaths[route.page];
  if (route.page === '仕入明細・請求' && route.invoiceId) path += `/${route.invoiceId}`;
  const query = new URLSearchParams();
  if (route.storeId) query.set('storeId', route.storeId);
  query.set('from', route.from);
  query.set('to', route.to);
  if (route.invoiceId && route.page !== '仕入明細・請求') query.set('invoiceId', route.invoiceId);
  if (route.supplierId) query.set('supplierId', route.supplierId);
  if (route.asOf) query.set('asOf', route.asOf);
  if (route.status) query.set('status', route.status);
  return path + '?' + query.toString();
}

export function safeReturnPath(candidate: string, origin: string): string {
  const forbidden = (value: string) =>
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!candidate.startsWith('/') || candidate.startsWith('//') || forbidden(candidate)) return '/';
  try {
    const url = new URL(candidate, origin);
    if (url.origin !== origin || forbidden(decodeURIComponent(url.pathname + url.search)))
      return '/';
    const allowed = new Set([
      'page',
      'storeId',
      'from',
      'to',
      'invoiceId',
      'supplierId',
      'asOf',
      'status',
    ]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return '/';
    const route = readRoute(url.pathname, url.search);
    return route.notFound ? '/' : routeUrl(route);
  } catch {
    return '/';
  }
}
