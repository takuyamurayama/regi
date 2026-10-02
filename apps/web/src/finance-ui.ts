export type FinanceSection = 'suppliers' | 'invoices' | 'payables' | 'returns';
export type FinanceRole = 'admin' | 'headquarters' | 'manager' | 'cashier';
export interface FinanceFileOptions {
  method?: string;
  body?: Blob;
  headers?: Record<string, string>;
}
export interface FinanceProps {
  section: FinanceSection;
  invoiceId?: string;
  store: string;
  scopeKey: string;
  actorRole: FinanceRole;
  actorStaffId: string;
  busy: boolean;
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  post: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  fileRequest: (path: string, options?: FinanceFileOptions) => Promise<Response>;
  action: (callback: () => Promise<unknown>) => Promise<void>;
  navigate: (path: string) => void;
}

export function financeValue<T>(schema: { parse: (input: unknown) => T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw new Error('仕入データの形式を確認できませんでした。再読み込みしてください。');
  }
}

export function financeYen(value: string | null): string {
  if (value === null) return '未確定';
  if (value.length > 201 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return '金額を確認できません';
  return `${BigInt(value).toLocaleString('ja-JP')}円`;
}

export function financeDate(value: string | null): string {
  if (!value) return '未入力';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日時を確認できません';
  return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export function japanDateTime(
  value = new Date(),
  precision: 'minute' | 'second' = 'minute',
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(precision === 'second' ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}${precision === 'second' ? `:${part('second')}` : ''}`;
}

export function japanInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    throw new Error('実際の日時を日本時間で入力してください。');
  const seconds = value.length === 19;
  const date = new Date(`${value}${seconds ? '' : ':00'}+09:00`);
  if (Number.isNaN(date.getTime()) || japanDateTime(date, seconds ? 'second' : 'minute') !== value)
    throw new Error('存在する日時を入力してください。');
  return date.toISOString();
}

export function financeMessage(error: unknown): string {
  return error instanceof Error ? error.message : '仕入データを取得できませんでした。';
}

export function validateFinanceRequest(
  schema: { parse: (input: unknown) => unknown },
  input: object,
  message = '入力内容に不足や誤りがあります。日付・金額・必須項目を確認してください。',
): void {
  try {
    schema.parse({ operationId: '00000000-0000-4000-8000-000000000000', ...input });
  } catch {
    throw new Error(message);
  }
}

export function financePath(
  path: string,
  store: string,
  query: Record<string, string> = {},
): string {
  const [pathname, existing = ''] = path.split('?');
  const parameters = new URLSearchParams(existing);
  parameters.set('storeId', store);
  for (const [key, value] of Object.entries(query)) parameters.set(key, value);
  return `${pathname}?${parameters}`;
}

export function downloadFinanceBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
