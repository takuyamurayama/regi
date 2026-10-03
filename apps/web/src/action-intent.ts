import { ApiError } from './api-response';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface IntentDescriptor {
  id: string;
  scope: string;
  path: string;
  method: string;
  returnPath: string;
  fingerprint: string;
  createdAt: number;
}
interface Intent extends IntentDescriptor {
  status: 'unknown' | 'acknowledged';
  send?: (id: string) => Promise<unknown>;
  result?: unknown;
  flight?: Promise<unknown>;
  committedOnly?: boolean;
}
const storageKey = 'regi-action-intents-v1';
function descriptor(value: unknown): value is IntentDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    ['id', 'scope', 'path', 'method', 'returnPath', 'fingerprint'].every(
      (key) => typeof item[key] === 'string',
    ) &&
    typeof item.createdAt === 'number' &&
    typeof item.path === 'string' &&
    item.path.startsWith('/v1/')
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return (
      '{' +
      entries.map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') +
      '}'
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error('送信内容を確認してください');
}
export async function inputFingerprint(value: unknown): Promise<string> {
  const input =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => !['pin', 'operationId'].includes(key)),
        )
      : value;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(input)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ActionIntents {
  private readonly intents = new Map<string, Intent>();
  private bodyGeneration = 0;
  constructor(
    private readonly storage: StoragePort,
    private readonly changed = () => {},
  ) {
    try {
      const value: unknown = JSON.parse(storage.getItem(storageKey) ?? '[]');
      if (Array.isArray(value))
        for (const item of value as unknown[])
          if (descriptor(item)) this.intents.set(item.id, { ...item, status: 'unknown' });
    } catch {
      throw new Error('未確認の操作情報を読み込めません。原記録を確認してください');
    }
  }
  private persist(): void {
    const pending = [...this.intents.values()]
      .filter((item) => item.status === 'unknown')
      .map(({ id, scope, path, method, returnPath, fingerprint, createdAt }) => ({
        id,
        scope,
        path,
        method,
        returnPath,
        fingerprint,
        createdAt,
      }));
    if (pending.length) this.storage.setItem(storageKey, JSON.stringify(pending));
    else this.storage.removeItem(storageKey);
    this.changed();
  }
  pending(scope?: string): IntentDescriptor[] {
    return [...this.intents.values()]
      .filter((item) => (scope === undefined || item.scope === scope) && item.status === 'unknown')
      .map(({ id, scope, path, method, returnPath, fingerprint, createdAt }) => ({
        id,
        scope,
        path,
        method,
        returnPath,
        fingerprint,
        createdAt,
      }));
  }
  acknowledged(scope: string): boolean {
    return [...this.intents.values()].some(
      (item) => item.scope === scope && item.status === 'acknowledged',
    );
  }
  confirmCommitted(id: string, scope: string): void {
    const intent = this.intents.get(id);
    if (!intent || intent.scope !== scope)
      throw new Error('元の店舗・操作者で操作を確認してください');
    intent.status = 'acknowledged';
    intent.committedOnly = true;
    delete intent.send;
    delete intent.result;
    delete intent.flight;
    this.persist();
  }
  private confirmedError(): ApiError {
    return new ApiError(
      '先の操作は保存済みです。原記録を再取得し、別の取引を記録する場合は「新しい操作を開始」を選んでください',
      409,
      'OPERATION_ALREADY_CONFIRMED',
      false,
    );
  }
  startNew(scope: string): void {
    for (const [id, item] of this.intents)
      if (item.scope === scope && item.status === 'acknowledged') this.intents.delete(id);
    this.changed();
  }
  forgetBodies(): void {
    this.bodyGeneration++;
    for (const [id, item] of this.intents) {
      if (item.status === 'acknowledged') this.intents.delete(id);
      else {
        delete item.send;
        delete item.result;
        delete item.flight;
      }
    }
    this.changed();
  }
  async run<T>(request: {
    scope: string;
    path: string;
    method: string;
    returnPath: string;
    input: unknown;
    operationId?: string;
    active: () => boolean;
    send: (id: string) => Promise<T>;
  }): Promise<T> {
    const fingerprint = await inputFingerprint(request.input);
    if (!request.active()) throw new Error('画面または店舗が変わったため送信を中止しました');
    const matching = [...this.intents.values()].filter(
      (item) =>
        item.scope === request.scope &&
        item.path === request.path &&
        item.method === request.method,
    );
    if (matching.some((item) => item.committedOnly)) throw this.confirmedError();
    let intent = matching.find((item) => item.fingerprint === fingerprint);
    if (matching.some((item) => item.status === 'unknown' && item !== intent))
      throw new Error(
        '先の操作の結果が未確認です。元の店舗で原記録を再取得し、同じ操作を再確認してください',
      );
    if (intent && request.operationId && request.operationId !== intent.id)
      throw new Error('先の操作と操作IDが異なります。元の操作を再確認してください');
    if (!intent) {
      if (this.pending(request.scope).length >= 100)
        throw new Error(
          '未確認の操作が多いため、新しい送信を停止しました。原記録を確認してください',
        );
      intent = {
        id: request.operationId ?? crypto.randomUUID(),
        scope: request.scope,
        path: request.path,
        method: request.method,
        returnPath: request.returnPath,
        fingerprint,
        createdAt: Date.now(),
        status: 'unknown',
        send: request.send,
      };
      if (this.intents.has(intent.id)) throw new Error('操作IDが別の操作に使用されています');
      this.intents.set(intent.id, intent);
    }
    if (intent.status === 'acknowledged') return intent.result as T;
    if (!intent.send) intent.send = request.send;
    return (await this.execute(intent)) as T;
  }
  private execute(intent: Intent): Promise<unknown> {
    if (intent.committedOnly) return Promise.reject(this.confirmedError());
    if (intent.flight) return intent.flight;
    if (!intent.send)
      return Promise.reject(
        new Error(
          '再読み込み前の入力は保存していません。原記録を確認し、同じ内容を再入力してください',
        ),
      );
    const wasUnknown = this.storage.getItem(storageKey)?.includes(intent.id) ?? false;
    const generation = this.bodyGeneration;
    this.persist();
    intent.flight = intent
      .send(intent.id)
      .then((result) => {
        if (generation !== this.bodyGeneration) {
          this.intents.delete(intent.id);
          this.persist();
          return result;
        }
        intent.status = 'acknowledged';
        intent.result = result;
        delete intent.send;
        this.persist();
        return result;
      })
      .catch((caught: unknown) => {
        if (!wasUnknown && caught instanceof ApiError && !caught.uncertain)
          this.intents.delete(intent.id);
        this.persist();
        if (
          wasUnknown &&
          caught instanceof ApiError &&
          caught.status === 400 &&
          ['INVALID_INPUT', 'INVALID_REQUEST'].includes(caught.code ?? '')
        ) {
          const nextAction = '「未確認の操作」から保存結果を確認してください。';
          throw new ApiError(
            `先の操作が保存されたか確認できていません。入力を変更せず、${nextAction}`,
            caught.status,
            caught.code,
            caught.retryable,
            nextAction,
            caught.fieldErrors,
          );
        }
        throw caught;
      })
      .finally(() => {
        delete intent.flight;
      });
    return intent.flight;
  }
  retry(id: string, scope: string): Promise<unknown> {
    const intent = this.intents.get(id);
    if (!intent || intent.scope !== scope)
      return Promise.reject(new Error('元の店舗・操作者で操作を確認してください'));
    return this.execute(intent);
  }
}
