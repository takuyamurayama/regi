# D0 sandbox 復元手順

対象は毎時・起動直後・停止直前のPostgreSQL17論理backupです。実AWS訓練は利用者がMacから実施し、結果を末尾へ記録します。このVMの実PG往復試験は、実AWSの到達・複製・所要時間の受入を代替しません。

## 復元点と原記録

稼働中に毎時backupが成功している場合のRPO目標は1時間です。停止中は最後の成功backup、失敗が続けばさらに前の成功backupが復元点です。大阪への複製は非同期です。RTOは実測後に記録します。

通常同期はpendingを送ります。snapshot後にサーバーでacceptedとなり端末もacceptedを保存した原イベントは、DBを戻すだけでは自動再送されません。端末を初期化せず、原ID・連番・payload・会計履歴を保持して、選んだ復元点とサーバー欠落を照合します。受領済み原イベントの回収対象選択は運用者対応です。未実装の自動回収画面があるものとして進めません。外部カード・QR支払をDB状態だけから再実行しません。

## 取得するpair

1. 障害/訓練開始時刻、最後の正常取引ID/時刻、対象DBと端末を記録します。
2. Macの承認済み資格で東京、または複製済みの大阪から `pg/YYYY/MM/DD/HH.dump.gz` と対応 `HH.manifest.json` の**versionを固定して**取得します。hostにはPutObjectだけを付与し、復元のためにGet/List/Deleteを追加しません。
3. 起動・停止backupは同じhour keyへ複数versionを作ります。最新dumpと最新manifestが同じ世代とは限りません。完了記録の両version ID、dump SHA、snapshot UUID、取得したmanifestを照合します。
4. MacでSHAを確認し、私有転送経路でhostの暗号化data volume配下のroot所有0600ファイルへ配置します。秘密やdumpをrepositoryへ入れません。転送時も対象account/instanceを確認します。

versionを固定した取得例です。placeholderを確認済みの値へ置換し、Macのprivate directoryで実行します。

```bash
aws s3api get-object --bucket '<backup-bucket>' --key 'pg/YYYY/MM/DD/HH.dump.gz' --version-id '<dump-version>' --profile '<approved-profile>' --region '<backup-region>' .private/restore.dump.gz
aws s3api get-object --bucket '<backup-bucket>' --key 'pg/YYYY/MM/DD/HH.manifest.json' --version-id '<manifest-version>' --profile '<approved-profile>' --region '<backup-region>' .private/restore.manifest.json
shasum -a 256 .private/restore.dump.gz
chmod 600 .private/restore.dump.gz .private/restore.manifest.json
```

片方だけ、SHA不一致、gzip破損、manifest欠損、異なるschema/migration世代は拒否します。大阪で到着していないversionを復元可能と扱いません。

## 別DBへの検証

host上のrootから最初にverify-onlyを実行します。

```bash
/opt/regi/restore.sh /var/lib/regi/private/restore.dump.gz --manifest /var/lib/regi/private/restore.manifest.json --verify-only
```

scriptは復元用のディスク余裕とarchive展開量を確認し、専用の新DB名へpg_restoreします。検証中の候補はCONNECTION LIMIT0でアプリ接続を禁止し、verify-onlyでは候補を保持します。DBのowner・文字コード・collation・明示的接続ACL、全public table件数とcatalog、regi_migrationsの版とchecksum、owner/appのrole flags、table ACL、FORCE RLSとpolicyをmanifestと照合します。既存DBへ直接pg_restoreしません。検証不一致は業務DBを切り替えず終了します。

切替前に復元点の業務データを照合します。売上・返金・在庫台帳・税率履歴・operations・端末連番・changes・契約と原帳票を確認します。バックアップ以降に作成されたS3帳票やSQS jobはDBと独立して残る場合があるため、同じjob IDと保存SHAで照合します。migrationの世代差を安全に扱えなければ停止し、operatorが新旧アプリとDBの整合を確認します。

## 切替とrollback

verify-onlyと原イベント照合の準備を完了した後、保守時間帯に以下を実行します。`--verify-only` を外すと、再び別DBへのrestore/検証を行い、成功後に切り替えます。

```bash
/opt/regi/restore.sh /var/lib/regi/private/restore.dump.gz --manifest /var/lib/regi/private/restore.manifest.json
```

scriptはAPI/workerだけを止めてPostgreSQLを稼働させたまま、元DBを保持した別名へ変更し、検証済みDBを業務DB名へ切り替え、API/workerを再開します。Docker compose全体のstopやEC2停止は行いません。旧DBはALLOW_CONNECTIONS=falseで保持します。切替・実API health・workerの再開確認が失敗した場合は保持した旧DBへrollbackします。rollback後の再開にも失敗した場合はRESTORE_ROLLBACK_FAILEDとoperator-requiredのprivate journalを記録し、業務復帰済みと扱いません。旧DB名、候補DB名、切替時刻、rollback結果を私有訓練記録へ残します。

再開後はhealth、読取、販売、同期、同じイベントIDの再送による非重複を確認します。snapshot後の端末acceptedとサーバー欠落を運用者が照合し、原記録を変更せず回収します。回収できない原データを存在済みと推測して営業再開しません。

## 訓練結果

| 項目                                               | 実測・記録欄 |
| -------------------------------------------------- | ------------ |
| 実施者、Mac資格の対象account/region/instance       | 未実施       |
| 障害/訓練開始・取得・検証完了・切替・業務再開UTC   | 未実施       |
| 最後の正常取引と選んだsnapshot UUID/時刻           | 未実施       |
| 東京/大阪、dump/manifest両version ID・SHA一致      | 未実施       |
| 候補DB名・保持した旧DB名                           | 未実施       |
| 全public table件数・migration/checksum一致         | 未実施       |
| role flags・ACL・FORCE RLS・policy一致             | 未実施       |
| 売上/返金/在庫/税率/operations/連番/changesの照合  | 未実施       |
| snapshot後の端末acceptedとサーバー欠落・原記録回収 | 未実施       |
| 同一IDの非重複、読取/販売/同期、旧DBへのrollback   | 未実施       |
| 毎時/起動/停止backup、大阪到着と失敗時のログ       | 未実施       |
| 実測RPO/RTO・残課題・次の月次訓練日                | 未実施       |

S3のcurrent35日＋noncurrent35日は、全versionが作成から35日以内に削除される保証ではありません。約70日残る場合があり、複製Pending/Failedはさらに長く残り得ます。法定保管用exportと、承認済み削除後の全version消滅は別に追跡します。

バックアップの最新完了/失敗記録はhostのroot管理 `/var/lib/regi/private/backups/last-backup.json`、直近成功は `last-successful-backup.json`、世代別完了記録は `receipts/` に保持します。復元の段階は `last-restore.json` で確認します。復元CLIの上限は1800秒＋終了猶予15秒です。SSMで実行する場合はpluginのexecutionTimeoutを例えば2100秒に設定し、Mac側も完了まで状態を確認します。時間切れ後はjournalを確認し、切替を推測して再実行しません。
