export async function readApiResponse(response: Response) {
  let payload: any;
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {}
  }
  if (!response.ok) {
    if (payload?.code && typeof payload.message === 'string')
      throw new Error(`${payload.code}: ${payload.message} ${payload.nextAction ?? ''}`);
    if ([502, 503, 504].includes(response.status))
      throw new Error(
        `HTTP ${response.status}: 検証サーバーが停止中、起動処理中、または一時的に応答できません。Macの起動コマンドを実行し、数分待って再読み込みしてください。`,
      );
    throw new Error(
      `HTTP ${response.status}: サーバーが要求を受け付けませんでした。ログイン状態と接続を確認し、再読み込みしてください。`,
    );
  }
  if (payload === undefined)
    throw new Error(
      'APIの応答形式を確認できません。再読み込みしてください。続く場合は配布設定を確認してください。',
    );
  return payload;
}

export function networkError() {
  return new Error(
    'サーバーとの通信に失敗しました。ネットワーク接続を確認してください。検証環境を起動した直後は、数分待って再読み込みしてください。',
  );
}
