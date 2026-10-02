export class ApiError extends Error {
  readonly uncertain: boolean;
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable?: boolean,
    readonly nextAction?: string,
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
