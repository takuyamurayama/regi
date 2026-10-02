# 0005: pgのsimple query protocolでSQL migrationを実行する

日付: 2026-10-02。状態: 採用。

### 背景

Prismaのraw実行は複数文ファイルの処理に適さない。semicolonだけで分割するとDO/functionのdollar quote、文字列、comment内部でSQLを壊す。適用済みmigrationの編集が無検知で通ると、同じversion名でもDB schemaの実態が一致しない。

### 決定

`pg` 8.xのClientを使い、通常のmigrationはファイル全体を1回の `client.query` で実行する。transactionでSQLとledger記録を確定する。`-- regi:transaction=false` の明示headerがある場合だけ、quote/dollar quote/commentを認識するlexerで文に分け、各文を非transactionで実行する。これはCREATE INDEX CONCURRENTLY等の明示例外に限る。

migrationファイル全体のSHA-256を `regi_migrations.checksum` に記録し、適用済みファイルの改変・消失・不一致では起動を拒否する。既存version-only ledgerは、凍結した既知migration001〜006の承認済みhashと一致する場合だけchecksumを一度backfillし、適用済みSQLをreplayしない。未知のlegacy version/hashは拒否する。runnerの競合はDB advisory lockで直列化する。

最初の000_rolesは存在しないregi_appをSCRAM verifierで作成する。既存roleのpasswordを勝手に更新しない。起動時に既存regi_appのsuperuser/BYPASSRLS/role作成/DB作成等の危険な権限を拒否する。owner/maintenance資格とapp資格を分離し、ledgerのapp書込みを許可しない。秘密値をSQLログへ出さない。

### 帰結と検証

複数文、DO/function、Unicode dollar tagをPostgreSQLの実動作で処理し、改変を検知できる。transaction=falseの途中失敗では既に実行した文をrollbackできないため、ledger未登録のまま停止し、operatorがDB状態を照合する必要がある。runnerはSQLの意味を推測して自動repairしない。

空DBへの000〜007、再実行、checksum一致/改変拒否、legacy adoption、SCRAM roleと安全flags、concurrent index、E-string/dollar quote/comment、007のstatus/partial unique/quarantine FORCE RLSを実PGで検証する。最終CIでもDB不要unitと実PGintegrationを分け、manifestを照合する。
