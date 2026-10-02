# 0002: 同期応答は3値、サーバー受領状態は5状態とする

日付: 2026-10-02。状態: 採用。

### 背景

既存端末はaccepted/review/retryの結果に応じてoutboxを更新する。サーバー内部の依存待ちと管理者による却下を同じwire enumへ増やすと、未対応端末が元イベントの再送を止めたり、終端状態を正しく判断できない。DBへのreview保存失敗をreviewとして応答することも売上証跡を失う原因になる。

### 決定

`POST /v1/sync/events` のstatusを `accepted|review|retry` に固定する。サーバーの `device_events` と隔離表は `pending|accepted|review|waiting|dismissed` を保持する。業務処理と受領は同じtransactionで確定する。未知例外、timeout、DB障害、受領保存失敗はretryとし、内部例外messageは固定日本語へ置き換える。未知障害が1件あれば残りをretryで打ち切る。reviewは原記録を永続化できた場合だけ返す。

依存待ちと連番衝突はwaitingとして保存する。既存IDの異なるpayloadと連番衝突はquarantineへ保存し、既存acceptedを上書きしない。理由付き却下はadmin/headquartersのみが実行し、原body/hash、承認者、理由、auditを保持する。dismissedの再送はacceptedのstatusと保存済み解消情報を返す。

日締め、棚卸開始、端末締めはaccepted/dismissedを終端として扱う。重複連番の終端件数はDISTINCTで数え、両表の未解消行を別に検査する。解消と同じtransactionで `kind='device-event'`、id/statusのchangesを配信する。端末はaccepted/dismissedをaccepted、pending/waitingをpending、reviewをreviewへ写し、原会計履歴を消さない。

端末のpendingは未受領・再送対象、reviewはサーバーへ原イベントを保存済みで人の照合待ちとする。要確認一覧にないlocal reviewは同じID/連番/payloadのpendingへ戻して再照合する。acceptedは外部決済成功を推測する指示ではない。

### 帰結と検証

端末のwire互換性を保ったまま、業務締めを妨げる未解消と理由付き終端を区別できる。quarantineとauditが増え、管理者は却下理由と取引原記録を照合する責任を持つ。原payloadを編集して再送しない。

実PGの障害注入、review INSERT失敗、同ID/同連番衝突、dismiss後の締め、audit/RLS、差分取り逃し時の同payload再送を検証する。詳細な状態図とpayload上限は `../architecture/sync-protocol.md` を参照する。
