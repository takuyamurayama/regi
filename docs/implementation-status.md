# REGI 実装・検証の現状

第4週までの実装とローカル回帰が完了し、現在は最終SHA・整形・秘密検査中です。第3週コミットは `ddef040`、第4週コミットとpush/CIは検査後に記録します。

ユーザー承認のD0を段階的に実装中です。続くUI/URL改善、実画面試験、単独ITツール登録に必要な追加機能も承認されています。既存の税込528万円・24か月の販売仕様は、機能評価や登録審査の合格を意味しません。

| ゲート                           | ローカル証拠                                                                                                           | 外部受入・残作業                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D0-1 同期障害で無痕跡消失0       | Prisma注入・実31秒超lock/P2028・review/accepted保存失敗のrollbackと原ID再送                                            | 実AWS障害訓練は未実施                                          |
| D0-2 reviewのdismiss終端で日締め | 理由・承認者・監査・main/quarantine・連番・既存accepted保護の実PG試験                                                  | 実端末の運用受入                                               |
| D0-3 100件/5000行・413契約       | HTTP100件×5明細、2MiB超5000行、5MiB経路、非retryable413                                                                | 実回線/実端末確認                                              |
| D0-4 Android専用30日refresh      | 30日境界・時計巻戻り・client切替競合・invalid_grant保持警告                                                            | 実Cognito30日・sandbox実時間未実施                             |
| D0-5 毎時backup/復元             | 毎時/起動/停止script・同一snapshot、別DB復元、件数/catalog/ACL/RLS/SHA検査。実PG往復・破損/改変/容量拒否・rollback合格 | MacからAWS適用、毎時/起動/停止backup、大阪複製、RPO/RTO訓練    |
| D0-6 CI/manifest/main保護        | 既存91名維持、Node112+Web20のmanifest132・実行結果一致                                                                 | push後CIは未実行。main保護の手順はREADME、設定はユーザー確認後 |
| D0-7 000〜007/checksum           | pg simple query、空DB8本・全SHA一致・改変拒否・SCRAM/FORCE RLS                                                         | 既存AWS移行時のchecksum確認                                    |
| D0-8 Budget/停止費               | Budget10USD・ACTUAL80%/FORECASTED100%、停止中約650円/月の条件付き見積をdocsへ記載                                      | Mac tfvars旧30USD変更と通知受入                                |

今回のVMからAWS apply・配備・S3操作は行っていません。過去sandbox配備の履歴は今回のD0ソースが配備済みである証拠にしません。端末のaccepted原イベントはDB復元だけでは自動再送されないため、復元訓練で原ID/連番/payloadと復元後サーバーを照合します。

資格については「問題ない」という本人申告です。原本や審査機関による確認、一般販売開始・有償導入実績は未確認です。合成売上を実顧客実績に読み替えません。指定Android実機・実プリンター・実決済、法務/税務、正式登録審査も未完了です。

過去記録は [2026-10-01](history/2026-10-01.md) と [初期検証・2026-10-02](history/2026-10-02.md) に保持します。

ローカルの第3週回帰はNode104/104、Web20/20、Android JVM7/7・接続25/25（既存8＋追加17、skip0）。検索は元5万SKU・60サンプル・p95<300msを維持して連続166/153ms、会計確定184ms（元1秒未満）。強制終了後にPID4448→4498で同じ確認待ち会計の保持・二重確定防止・同期・締めを確認しました。manifest124名は元91名をすべて保持しています。型・lint警告予算・整形・秘密scan0も合格。

同期契約は [同期プロトコル](architecture/sync-protocol.md)、設計判断は [ADR一覧](adr/0001-incremental-hardening.md)、Mac配備と復元は [配備手順](runbook/deploy.md)・[復元手順](runbook/restore.md) を参照してください。

第4週の最終Node112/112・freshWeb20/20・runtime manifest132一致を確認しました。host Python27/27は最終sourceをCI同様のPG17コンテナークライアントで検証し（先行するローカル試験26/26も合格）、、forecast Python5/5もDocker内で合格。Dockerはdigest固定build、非root・開発依存不在、保守import、health200/healthy、未認証401。両Terraform validateとsandbox mock10/10、最終host13ファイルSHA照合も合格しました。Android sourceと同期wire契約は第3週から変更せず、オンライン締め条件はoutboxのshift.closeへ掛けていません。

D0余力枠はC153（オンライン締めの同期/要確認解消前提）とC24（top-level PIN除去後のoperation hash）をRed→Greenで追加しました。既存PIN付きhashは不一致拒否し履歴を書換えず、旧IDが拒否された場合の新ID自動再実行も行いません。C154（翌営業日05時以降の価格）とC155（終了営業日だけの日締め）は画面・商品作成契約を合わせるpost-D0の課題として残しています。
