# 0004: D0ではAndroidのRoom version 4を維持する

日付: 2026-10-02。状態: 採用。

### 背景

Android端末のRoomには未送信売上、外部決済の確認待ち会計、端末連番、過去leaseが残る。同期契約と認証を変える時期にschema変更を重ねると、更新・再起動時のmigration失敗が原記録の利用不能につながる。既存metadata表は追加の解消情報と警告を保存できる。

### 決定

Room version4、既存entities/columns/indices/migration1→4を変更しない。端末同期のoutbox statusは既存pending/accepted/reviewを使い、server waiting/dismissedは既存状態へ写す。解消情報、reviewCount、認証警告等は既存metadataへ保存する。pendingCountはstatus=pendingだけ、reviewCountはstatus=reviewだけを数える。unknown/checking checkoutは別状態として保持し、端末statusのpendingに加算して締めを止める。

同期はpendingが無くなるまで100件・UTF-8 256KiB以内で送り、413で件数を減らす。単一イベントが上限を超えた場合は原記録を残し案内する。旧leaseごとの回収tokenを保持し、再送のID/sequence/payloadを変更しない。Cognito client切替・invalid_grantではtokensだけを破棄し、会計/outboxを消さない。

### 帰結と検証

schema migrationなしに同期の正しさを改善できる。metadataのkey/valueとstatus写像の契約を文書化・試験で維持する必要がある。将来のschema整理はユーザーの別承認と別ADRを必要とする。追加機能の承認だけでRoom変更を行わない。

Roomを用いる接続試験、再起動/process death、100件超の分割、413、review照合、device-eventの全種別反映、30日境界の時計試験、認証警告の画面試験で原記録の保持を検証する。実Cognitoの30日資格期限はローカル時計試験だけでは保証しない。
