# REGI 実装・検証の現状

D0の4週分は実装・push済みで、`52c1826` の [GitHub Actions全6job成功](https://github.com/takuyamurayama/regi/actions/runs/37020278090) を確認しています。続くWeb/URL・Android POS改善と仕入請求・買掛の追加実装も、下記のローカル最終検証を完了しました。追加変更のpush後のCI結果は [このブランチのCI一覧](https://github.com/takuyamurayama/regi/actions/workflows/ci.yml?query=branch%3Atakuyamurayama%2Fai-it) の該当commitを確認してください。

正式提出資料と法人情報の収集はユーザー指示で保留しています。税込528万円・税抜480万円・24か月という既存の販売仕様を維持し、価格価値や登録審査の合格を検証結果と同一視しません。

## 追加実装と検証

| 対象                     | 実装・確認内容                                                                                             | 最終状態                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| WebのURL・店舗・操作復旧 | 正規URL、原記録への直接アクセス、履歴移動、店舗/操作者変更の古い応答破棄、同ID再送、再読込後の保存結果照会 | 全ブラウザー51/51、skip0・実行manifest一致。最終PDF構成で対象6件も合格                                                              |
| 仕入請求・買掛           | 仕入先、原資料、入荷照合、税率別明細、債務、相手方確認、部分支払、減額、返金、逆記録、物品返品、訂正版     | 実HTTP/PG・原資料のSHA/bytes・応答切断・並行接続・役割/店舗RLS・原記録不変を検証。全integration135/135、skip0・実行manifest一致     |
| 帳票・原資料出力         | 固定時点のPDF/CSV/資料bundle、用途別証拠、軽減対象、買手作成明細の両者・登録番号・確認状態                 | 必須登録番号欠落をRed→Green。関連19/19合格、原資料とmanifestのSHA照合                                                               |
| 金額・日付・画面状態     | BigInt/整数円、500明細、原書類の税額、実取引秒、日本時間、無効な入力を保持                                 | DB不要unit50/50、runtime manifest一致                                                                                               |
| Android POS              | 数量入力、保留、会計復旧、現金の預り/釣銭、暫定締め、再ログイン表示、キーボード到達、日本時間のレシート    | JVM10/10、既存接続25/25＋追加画面17unique合格。検索p95 141/153ms・会計181ms。強制終了PID6688→6736で会計保持・同ID確定/同期/締め合格 |
| バックアップ・復元       | 元D0の8migrationと別の全9migration、金融13表・元スナップショット・逆記録の実PG dump/復元照合               | host Python28/28、forecast Python5/5                                                                                                |
| 静的検査・環境           | lint警告予算、全型検査、core/API/Web build、npm audit                                                      | 合格。高severity以上の依存脆弱性0。Docker build・runtime health/401・非root・保守imports・Python5も合格。全整形・秘密scan0も合格    |
| インフラ                 | Tier Mの意味的変更なし。sandboxの正規URL rewriteと新経路の境界                                             | 両root validate・sandbox provider mock11/11。AWS apply/配備/S3操作なし                                                              |

`tests/manifest.txt` はNode185（unit50＋integration135）＋Web51＝236件です。D0時点の133名（Node113＋Web20）をすべて保持し、追加103件。元の期待値を緩めず、D0の8migration試験は元SQLをそのまま別fixtureに固定し、008は独立した9migration/upgrade試験で検証します。最終全integrationはREADME通りの所有者接続も設定し135/135合格しました。先行130/131の1失敗はその実行環境変数の設定漏れで、期待値や製品コードを緩めず再実行しました。

## 入力エラーと日本語表示の改善（2026-10-03）

現金入出金は開局未選択・理由未入力・不正金額のまま送信できないようにし、各項目のそばに必要な入力を案内します。入力不備のAPIは日本語の項目別エラーを返し、共有DTOで検証します。初回400は入力修正、通信断後の未確認操作は元IDと内容を保持した保存結果照会へ案内を分けています。AIの選択肢は「売上・支払方法別売上・概算粗利・在庫・発注」、開局一覧は端末名・日本語の状態で表示します。

新規9試験をRed→Greenで追加し、Node185・Web51すべて成功、ASTと実行manifest一致・skip0、lint・型・整形・build・秘密scanも合格しました。詳細は [UX改善の履歴](history/2026-10-03-ux.md) を参照してください。

## D0と外部受入

| ゲート | 確認済みの実装・ローカル/CI証拠                                                            | 外部受入                                   |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| D0-1   | 障害注入、31秒超lock/P2028、保存失敗rollback、同ID再送                                     | 実AWS障害訓練                              |
| D0-2   | main/quarantineの理由付きdismiss、監査、終端判定、元accepted保持                           | 実端末の運用受入                           |
| D0-3   | HTTP100件×5明細、5000行CSV、経路別上限、非retryableの日本語413                             | 実回線/実端末                              |
| D0-4   | Android専用30日refresh、時計巻戻り、切替競合、invalid_grant警告                            | 実Cognito30日・sandbox実時間               |
| D0-5   | 毎時/起動/停止backup、同一snapshot、別DB復元、catalog/ACL/RLS/件数/SHA、容量拒否・rollback | MacでAWS適用、backup/大阪複製、RPO/RTO訓練 |
| D0-6   | 全6job CI緑、133名のAST/実行manifest一致。追加236名のAST/実行manifest一致確認              | mainは未作成・保護未設定。手順はREADME     |
| D0-7   | pg simple query、000〜007の8本SHA、SCRAM、改変拒否。追加008も空DB/007upgrade/RLS確認       | AWS移行時のchecksum照合                    |
| D0-8   | Budget10USD・ACTUAL80%/FORECASTED100%、停止中約650円/月の条件付き見積                      | Macのtfvars更新と通知受入                  |

単独申請の資格は「問題ない」という本人申告です。一般販売開始・有償導入・実プリンター・指定実機・実決済・法務/税務・正式登録審査は未確認です。現行の [ITツール登録要領](https://it-shien.smrj.go.jp/pdf/it2026_touroku_it_tool.pdf) と [国税庁6625](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6625.htm) の照合では、カテゴリー1のクラウド型スマートレジ「決済＋買手側受発注」の候補として必要な製品機能を確認し、見つかった買手作成PDFの登録番号欠落を修正しました。原本確認や事務局承認を済ませた扱いにはしません。

AWS apply・配備・S3操作はこのVMから実行していません。過去sandbox配備記録は今回のソースの配備証拠になりません。バックアップは現行35日＋非現行35日の例で約70日残り、複製未成功で延びる場合があります。DB復元後には端末accepted原イベントのID/連番/payloadとの照合が必要です。

D0余力枠C153（オンライン締めの同期済み条件）・C24（top-level PINを除いた冪等hash）は実装済みです。C154（翌営業日05時以降の価格）・C155（終了営業日だけの日締め）は任意追加の未実装項目です。Roomはversion4、スキーマ変更なし。

仕様は [同期プロトコル](architecture/sync-protocol.md)・[仕入請求と買掛](architecture/purchase-finance.md)、Macでの適用は [配備手順](runbook/deploy.md)・[復元手順](runbook/restore.md)・[sandbox](aws-sandbox.md) を参照してください。

履歴は [2026-10-01](history/2026-10-01.md)、[初期検証](history/2026-10-02.md)、[D0](history/2026-10-02-d0.md)、[追加実装](history/2026-10-02-post-d0.md) に保持します。
