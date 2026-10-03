export interface ApiFieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly uncertain: boolean;
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable?: boolean,
    readonly nextAction?: string,
    readonly fieldErrors: readonly ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.uncertain = status === undefined || status >= 500 || status < 400;
  }
}

export async function readApiResponse(response: Response) {
  let payload: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {}
  }
  if (!response.ok) {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'code' in payload &&
      typeof payload.code === 'string' &&
      'message' in payload &&
      typeof payload.message === 'string'
    ) {
      const nextAction =
        'nextAction' in payload && typeof payload.nextAction === 'string'
          ? payload.nextAction
          : undefined;
      if (response.status === 400 && ['INVALID_INPUT', 'INVALID_REQUEST'].includes(payload.code)) {
        const fieldErrors: ApiFieldError[] = [];
        if ('fieldErrors' in payload && Array.isArray(payload.fieldErrors)) {
          const entries: unknown[] = payload.fieldErrors;
          for (const item of entries.slice(0, 20)) {
            if (
              typeof item === 'object' &&
              item !== null &&
              'field' in item &&
              typeof item.field === 'string' &&
              'message' in item &&
              typeof item.message === 'string'
            )
              fieldErrors.push({ field: item.field, message: item.message });
          }
        }
        // Older servers may still return Zod's internal JSON; never show that to operators.
        const message = fieldErrors.length
          ? [...new Set(fieldErrors.map((entry) => entry.message))].join(' ')
          : /[\u3040-\u30ff\u3400-\u9fff]/u.test(payload.message) &&
              !/^\s*[[{]/u.test(payload.message)
            ? payload.message
            : '入力内容を確認してください。';
        const guidance = '該当項目を修正してから送信してください。';
        throw new ApiError(
          `${message} ${guidance}`,
          response.status,
          payload.code,
          false,
          guidance,
          fieldErrors,
        );
      }
      throw new ApiError(
        `${payload.code}: ${payload.message} ${nextAction ?? ''}`,
        response.status,
        payload.code,
        'retryable' in payload && typeof payload.retryable === 'boolean'
          ? payload.retryable
          : undefined,
        nextAction,
      );
    }
    if ([502, 503, 504].includes(response.status))
      throw new ApiError(
        `HTTP ${response.status}: 検証サーバーが停止中、起動処理中、または一時的に応答できません。Macの起動コマンドを実行し、数分待って再読み込みしてください。`,
        response.status,
      );
    throw new ApiError(
      `HTTP ${response.status}: サーバーが要求を受け付けませんでした。ログイン状態と接続を確認し、再読み込みしてください。`,
      response.status,
    );
  }
  if (payload === undefined)
    throw new ApiError(
      'APIの応答形式を確認できません。再読み込みしてください。続く場合は配布設定を確認してください。',
      response.status,
    );
  return payload;
}

export function networkError() {
  return new ApiError(
    'サーバーとの通信に失敗しました。ネットワーク接続を確認してください。検証環境を起動した直後は、数分待って再読み込みしてください。',
  );
}
