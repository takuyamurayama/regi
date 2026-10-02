# REGI 実装・検証記録

更新日: 2026-10-02。承認済み仕様は `implementation-plan.md`。独立レビュー第1・第2回を修正し、下記のローカル回帰を完了した。実施範囲で既知の未解決コード不具合はない。ただし「製品完成」「販売準備完了」「補助金利用販売開始条件充足」は、実機・商用本番・実導入・審査の条件が未達のため判定しない。

**最新状態:** 親担当の実AWS検証で、個人合成sandboxのCognito MFA OFF・更新API/host/Web・権限境界・データ保持が合格。本人の認証後ログイン操作は未検証。ユーザーの明示希望でEC2は稼働継続し、2時間自動停止が有効。末尾の最終受入記録が、途中のUNAPPLIED/再適用待ちと旧配備の02:50 UTC停止記録を更新する。実装担当はAWS/Macを操作していない。

## 工程別の照合

次表は初回ローカル検証時点の照合。後続の個人sandbox実AWS配備・検証は末尾の記録を参照し、商用本番や実機の未実施条件とは区別する。

| 工程       | 実装済みソース・資料                                                                                               | この環境で検証済み                                                                                                             | 未実施・外部条件                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1 基盤     | NestJS/Prisma/実PostgreSQL、整数円、税率/価格履歴、認可、FORCE RLS、冪等性、OpenAPI                                | PG17.10の非所有者/NOBYPASSRLS、同時更新、TS/Kotlin共通fixtureと各1万ケース、型検査、新規DBの全6マイグレーション                | 実Cognito/MFA・顧客アカウント接続                                                  |
| 2 販売     | Compose/Room/WorkManager、PIN、保留、現金/外部決済確認待ち、原子的確定、送信待ち、税区分、LAN印刷                  | API28ソフトウェアエミュレーター、実ファイルRoom、強制停止/別PID復元、重複確定/再送、72h境界、TCP sink、5万SKU                  | Galaxy Tab Active5 Pro、Epson TM-m30III-H、実カード/QR端末、紙の印字/切断/用紙切れ |
| 3 店舗業務 | 返品予約/返金/再入庫、発注/承認/発行/改訂/分納/取消、在庫台帳、棚卸、移動、現金/締め                               | 実PGで金額・数量・競合・2端末棚卸、Web/Composeで二明細の第二明細入荷と部分返品、隔離原記録照合                                 | 実店舗の日次運用、スタッフ訓練                                                     |
| 4 本部・AI | React本部、集計/概算粗利、CSV/PDF一式、LightGBM、発注推奨、自然言語の許可済み集計計画、定期日報、Bedrock接続コード | Python5試験、実PG70日合成履歴から7日分保存、曜日平均比較/不足時フォールバック、枠/回復/権限、未接続時のWeb操作                 | 実Bedrock国内推論プロファイル/資格情報、実店舗56日以上の履歴、商用精度評価         |
| 5 運用     | Docker、Terraform東京/Multi-AZ/RDS35日、監視/復旧手順、署名配布設定、90日削除処理                                  | Docker build/API health/worker起動、Terraform fmt/validate、負荷、ローカル論理復元、終了/更新/期限削除、unsigned release build | AWS apply、SQS/S3実疎通、PITR・本番相当RPO/RTO、署名鍵/MDM、実機更新               |
| 6 販売準備 | 料金表、規約ドラフト、導入/運用手順、登録資料チェックリスト、合成データの実画面                                    | 資料作成とローカル画面撮影                                                                                                     | 法務/税務レビュー、実導入・改善効果、事業者/ツール登録、専用要領照合、審査         |

## 独立レビュー対応

| 指摘                       | 修正と検証                                                                                                                                                                                       | 判定                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| オンラインでも72時間で停止 | 商品bootstrapと別のlease更新。開始時lease/金額/担当者を保存し、成立時leaseと旧lease回収を分離。時計を73h進めてオフライン拒否→オンライン更新→同じ外部会計継続。期限内イベントの後日回収も実PG試験 | 修正・回帰済み                          |
| 棚卸停止の自己申告依存     | サーバー店舗ロック、再開/在庫変動拒否、到着売上の原記録隔離。全隔離ID・理由で実査照合、確定後に含有可否を承認し別台帳で二重減少防止。2端末競合、Web複数実査の操作試験                            | 修正・回帰済み                          |
| AIが質問を捨てる           | 質問を許可済み指標/期間/商品比較へ解決。昨日/週/月/年/明示日を扱い、不正日・未来実績・SQL/PINを拒否。生の命令をモデルに渡さず、信頼済み数値と説明を分離。日報・不足・欠品/過剰候補・権限を試験   | 修正・回帰済み。実モデル推論は未接続    |
| Android本番認証            | ブラウザーAuthCode+PKCE/state期限、Keystore暗号化refresh、端末登録、callback、ログアウト。オンライン権限をPIN担当者へ縮小し、レジ担当tokenで昇格不可。模擬tokenサーバー/実PG認可で検証           | 修正・回帰済み。実Cognito/MFAは未接続   |
| 先頭明細/UUID手入力        | 商品/元取引検索、複数発注明細、返品可能残数、選択数量、分納残数。WebとComposeの実操作で第二明細だけ入荷・返品。内部UUIDの入力を必須にしない                                                      | 修正・操作回帰済み                      |
| 帳票の業務情報不足         | 売り手/店舗/住所/登録区分/T番号/購入者要否、実際の確定時刻、販売時・発行時スナップショット。元販売日/返還日/元税率、税率別金額を保持。PDF・一式出力・TCPを試験                                   | 修正・回帰済み。実印字/税務確認は未実施 |
| 顧客の更新契約自己申告     | 販売者側Ed25519署名。APIは公開鍵で法人/12か月/240万円/契約参照/期限を検証。自己申告・改ざん・別法人・重複を拒否                                                                                  | 修正・回帰済み                          |
| 操作IDにURL対象がない      | 対象IDを操作hashへ包含。別返品/発注/入荷/移動等への同じID・bodyは競合。元結果を別対象の成功と誤認しない                                                                                          | 修正・実PG回帰済み                      |
| AI異常終了/月次基準        | 5分の所有権/期限回収、古い処理の完了と二重返却を拒否。4999回から同時実行で上限確認。日本時間の暦月をAPI・UI・規約・月境界試験へ統一                                                              | 修正・回帰済み                          |
| README再現の不一致         | Pythonを `.context/venv311` に統一し、DB試験より先に依存導入。npm ci、別の新規PG DBへの全マイグレーション/seed/40試験を実行                                                                      | 修正・再現済み                          |

## 必須受入項目との対応

| 対象       | 検証証拠と到達点                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 税・値引き | 共通JSON、TS/Kotlin各1万ケース、複数税率/税込・税抜/全額値引き/最大剰余配分/税率切替。店内・持帰りの販売スナップショットも実PG試験                                 |
| 返品       | 数量予約・同時更新・元店舗・管理者制限。個数配分、部分返品の繰返し、全返品保存則、返金不明の予約維持                                                               |
| 二重操作   | 会計/返金/入荷の並行要求、同内容再送、異内容・別URL対象の競合。Room重複確定・原子的outbox保存                                                                      |
| 通信断     | 72h期限と時刻ずれ、旧lease回収、連番/重複/要確認、指数再送。強制停止後に別PIDで永続会計を復元。実時間72h連続運転・実機OS再起動は未実施                             |
| 外部決済   | 確認待ちの永続化、成功確認番号で復元確定、unknownを自動成功扱いしない。実決済の成功/返金は未接続                                                                   |
| 在庫       | 分納/取消/再入庫/移動/棚卸/隔離再照合。元イベントの重複禁止、台帳と集計数量の一致。サービス商品の非在庫扱い                                                        |
| 帳票       | 保存済み金額とPDF/TAR内PDF、税率別返還、再印刷非計上。日本語ラスタTCP送信。紙の印字確認は未実施                                                                    |
| 権限       | 他法人/未許可店舗、CSV/AI/在庫/返品、PINによる権限縮小、RLS・所有者API起動拒否、production開発認証拒否                                                             |
| AI         | 不足時fallback、実PG予測保存、期間/比較/根拠、失敗時枠返却/期限所有権/同時上限。実Bedrockでの生成品質と国内推論先は未検証                                          |
| 性能       | 永続Roomの5万SKUでJAN/商品名/部分一致60回、p95=251ms（300ms未満のassert）。端末内確定368ms（1秒未満のassert）。API28ソフトウェアエミュレーターであり実機値ではない |
| 負荷       | ローカルHTTP+PG、100仮想端末/10会計毎秒/200会計、p95=19.24ms、最大69.99ms。p95が2秒を超えると失敗。ストレスfixtureだけ端末登録上限をSQLで迂回                      |
| 復旧       | ローカルpg_dump/pg_restoreとコミット済みマーカー回収、合計430ms。マーカーRPO=0ms。AWS PITR・本番相当量・S3/SQS照合によるRPO5分/RTO4時間は未実測                    |
| 終了・更新 | 販売者署名付き12か月更新、終了後閲覧/出力、期限内未送信売上回収、90日削除guard/dry-run/実DB削除/RLS復帰。実S3全バージョン削除とバックアップ消滅は未実施            |

## 実行コマンド・結果

接続情報はローカル専用 `.env` を使用する。所有者接続は migration/削除試験だけに渡し、APIへ渡さない。ログは `.context/verification/`、数値は `.context/load-results.json` と `.context/restore-results.json`。以下は実行結果であり、予定のコマンドではない。

| コマンド                                                                                                                                                                    | 結果                                                                                   | ログ                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm ci` / `npx prisma generate --schema apps/api/prisma/schema.prisma`                                                                                                     | 依存導入/生成成功、npm監査0件                                                          | repro-ci.log / repro-prisma.log                                                 |
| `bash scripts/local-db.sh` / `npm run db:migrate` / `NODE_ENV=development npm run db:seed`                                                                                  | 新規 `regi_repro_20261001` DBへ001〜006とseed成功                                      | repro-db.log / repro-migrate.log / repro-seed.log                               |
| `NODE_ENV=test npm test`（DATABASE_URLとMAINTENANCE_TEST_DATABASE_URL設定）                                                                                                 | 40 PASS、0 FAIL、0 SKIP。新規DBでも40 PASS                                             | tests.log / repro-tests.log                                                     |
| `npm run build`                                                                                                                                                             | core/API/Web型検査・ビルド成功                                                         | build.log                                                                       |
| `npm run test:web`（実API/Chrome/PG起動）                                                                                                                                   | 6 PASS、0 FAIL。二明細・棚卸・認可・AI未接続の枠復帰を実操作                           | web.log / browser-results.json                                                  |
| `bash scripts/android-test.sh`（DATABASE_URL設定）                                                                                                                          | JVM3 PASS、接続8 PASS、0 FAIL/0 SKIP。通常JUnit runner                                 | android.log / android-jvm.xml / android-connected.xml                           |
| `ANDROID_SERIAL=emulator-5556 bash scripts/android-restart-test.sh`                                                                                                         | prepare/recover成功、PID7079→7129。強制停止後にunknown会計の2159円を復元、重複売上なし | android-restart.log / android-restart-prepare.log / android-restart-recover.log |
| `android/gradlew assembleRelease --no-daemon`                                                                                                                               | release/lintVital成功。署名鍵なしのunsigned APKであり本番配布未完了                    | android-release.log                                                             |
| `python3.11 -m venv .context/venv311` / `.context/venv311/bin/pip install -r forecast/requirements.txt` / `.context/venv311/bin/python -m unittest discover -s forecast -v` | 導入成功、5 PASS。さらにnpm testから実PG予測保存を実行                                 | python-install.log / python.log / tests.log                                     |
| `.context/terraform/terraform -chdir=infra fmt -check` / `.context/terraform/terraform -chdir=infra validate -no-color`                                                     | 成功。applyは実施していない                                                            | terraform.log                                                                   |
| `sudo docker build -t regi:local .` / ローカルAPI・workerコンテナー起動                                                                                                     | 成功、3001 health=ok、worker running。SQS/S3外部接続なし                               | docker-build.log / docker-health.log                                            |
| `NODE_ENV=test REGI_LOAD_BASEURL=http://localhost:3000 npx tsx scripts/load-test.ts`                                                                                        | 200/200受領、p95=19.24ms、2秒assert合格                                                | load.log / load-results.json                                                    |
| `NODE_ENV=test npx tsx scripts/restore-test.ts`                                                                                                                             | 別DBへの論理復元、マーカー回収、430ms                                                  | restore.log / restore-results.json                                              |
| productionでREGI_DEV_AUTH=true、所有者DBでAPI起動                                                                                                                           | いずれも期待どおり非0終了・起動拒否                                                    | production-auth-guard.log / owner-role-guard.log                                |
| `npm audit --json`                                                                                                                                                          | 0 vulnerabilities                                                                      | npm-audit.json                                                                  |

再現試験は既存DBの再利用だけではなく、依存のクリーン再導入と新規DBへの全マイグレーションで確認した。Web/APIは起動したまま利用可能（5173/3000）。本番cloudへは配備していない。

## 反復試験で発見した追加修正

- Composeの非UIスレッド再開を検出し、画面の状態更新をMain dispatcherへ固定。商品検索をキャンセル可能にし、選択済み商品を表示、入荷フォーム幅を修正。実タップで二明細の第二明細を選択・入荷・返品した。
- 永続Roomに強化した性能試験が319msで失敗。JAN/SKU/商品名索引をmigrationで追加し、部分一致は全件SKU索引走査/整列を避けて結果100件だけ整列。期待値300msを緩めず、完全一致と部分一致を含む60回で251msに改善。
- 強制停止試験の独自runnerがAGPで登録されない問題を検出。テスト限定Gradle propertyで明示runnerを切替え、通常の接続試験も維持。
- 再導入後に前アカウントのPOS担当者が残りbootstrapが拒否される問題を検出。identity変更時だけ旧担当者を解除し、同一identityの通信断では権限縮小を保持する試験を追加。登録済みRoomを別端末へ付け替えず、既存会計・履歴を保護する。
- Webの非同期応答が別店舗画面へ反映される競合をscopeで防止。サーバー取引検索結果のrefreshによる消失、訂正履歴の再取得ループを修正。税区分・売り手・署名更新・帳票一式・AI月基準の表示/手順を統一。

失敗した試験を削除して合格扱いにはしていない。失敗ログを `.context/verification/failures/` に保存し、修正後の対象試験と関連回帰の成功ログを別に保存する。

## 外部依存と完成判定

- Galaxy/Epson/決済端末の実物なし。現在の印刷はTCPラスタ送信で、双方向の紙切れ・実印字完了ステータス確認は実装していない。実紙、カット、通信断/再印刷の受入は未実施。
- AWS本番/検証アカウント、DNS/ACM、Cognito/MFA利用者、Bedrock国内profile、S3/SQS/監視/費用/実バックアップが未接続。Terraform validateや模擬token/モデル応答は実配備・実推論の証拠ではない。
- 署名鍵/MDMなし。releaseはunsigned。未送信が残るアプリ内の破壊的初期化は設けないが、OSのアンインストール/データ消去はMDM等で制限する必要がある。
- OS再起動で単調時計が巻き戻った場合はオンラインで時刻leaseを再確立する保守的動作。アプリのプロセス強制停止からの復元は検証済みだが、実機OS再起動・72h実時間試験は未実施。
- 実店舗、実導入事例、実改善効果、法務/税務確認、登録事業者/ツール審査、当日の専用公募要領照合は未実施。未確認の提供者名・資格情報・事例・登録承認を捏造していない。規約はドラフト。

したがって、この環境で実行可能な製品ソース・ローカル実装/検証・運用/申請準備資料は完成とする。設計の「実機での製品完成」「販売準備完了」「補助金利用販売開始条件充足」は外部条件未達として明確に区別する。コミット・push・PR・有料本番配備・申請送信は実施していない。

## 本部WebのUI刷新（2026-10-01 UTC・旧Apple風の検証記録）

### 実装範囲

- Appleのシンプルな印象を参考にした独自デザイン。白・淡いグレー・ブルー、広い余白、角丸カード、半透明ヘッダー、ローカルのシステムフォント、独自SVGアイコンを採用。Appleのロゴ・素材は使用していない。
- 全9画面のナビ・フォーム・表・エラー・出力履歴を統一。ダッシュボードを実集計の4指標、支払方法の比率、AIへの導線、最近の取引へ整理。出力履歴は開閉でき、元の記録と認証付きダウンロード処理を保持。
- 390 / 768 / 1440pxで全9画面を表示・更新。スマホではアイコンのナビに切り替え、名前の読み上げと選択状態を保持。表の内部スクロール、キーボードのフォーカス、スキップリンク、reduced-motionに対応。
- 金額はBigIntのまま表示。比率のみ整数演算後に表示用の数へ変換。固定の比率や架空の増減を表示しない。読込中は金額・比率とも「—」とし、0円の実績と区別。
- 主な変更: `apps/web/src/main.tsx`、`style.css`、`Dashboard.tsx`、`Icon.tsx`、`Table.tsx`、`presentation.ts`。業務API・DB・Androidの実装はこのUI作業では変更していない。サービス名の候補は検討中で、未承認の名称変更は行っていない。

### 実行結果

| コマンド                                                              | 結果                                                                                                                                                             | 証拠（`.context/`）                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `npx tsx --test tests/presentation.test.ts`                           | 3 PASS。ゼロ/欠けた支払方法、実比率、Number安全整数を超える金額、負額の円表示                                                                                    | `ui-presentation-tests.log`                      |
| `npm run test:web -- tests/browser/design.spec.ts`                    | 4 PASS。実API/PGで現金1080・カード2160・QR3240円の比率16.66/33.33/50%、実応答を待たせる読込表示、全9画面×3サイズ、スマホ商品登録、キーボード・出力履歴・動き抑制 | `ui-design-tests.log` / `ui-apple-payments.png`  |
| `NODE_ENV=test npx tsx --test tests/review.test.ts`                   | 9 PASS。日付固定の試験を修正後、AI比較/日報・権限・棚卸・冪等性を再検証                                                                                          | `ui-review-tests.log`                            |
| `NODE_ENV=test npm test`（`.env`とMAINTENANCE_TEST_DATABASE_URL設定） | 43 PASS、0 FAIL/0 SKIP。既存40試験と追加3試験。実PostgreSQLのRLS/同時更新/返品/在庫/予測も回帰                                                                   | `ui-full-tests.log`                              |
| `NODE_ENV=production npm run build`                                   | core/API/Webの型検査・本番ビルド成功。Webチャンク270.19kB（gzip 84.44kB）。開発用NODE_ENVを本番ビルドへ持ち越さず、警告上限も変更していない                      | `ui-full-build.log`                              |
| `npm run test:web`                                                    | 10 PASS、0 FAIL。既存6業務試験と追加4表示・操作試験。二明細発注/分納/返品、棚卸照合、認可、AI未接続時の枠返却を維持                                              | `ui-web-regression.log` / `browser-results.json` |

最初の全体試験で、比較試験の期間だけが2026-10-01に固定され、実際のfixture売上の営業日が翌日になる問題を検出した。`tests/review.test.ts`の対象期間・日報日をfixture売上日時の`businessDate`に合わせて修正した。数量期待値 `[1,2]`、比較・回復・上限の検査は維持し、対象→全体の順で再実行。元の失敗ログは `verification/failures/ui-full-tests-20261001.log` に保存した。

画面撮影で商品フォームのチェックボックスまで幅100%になり、ラベルが縦折返しする不具合を検出した。幅指定からチェックボックスを除外し、3サイズで幅16px・ラベル高さ32px未満を検査へ追加。最終スクリーンショットは動き抑制設定で撮影し、比率バーの過渡的な伸長途中ではなく実際の比率を記録する。

### 実画面と未実施

実Chromeで確認・撮影: `ui-apple-desktop.png`、`ui-apple-desktop-full.png`、`ui-apple-tablet.png`、`ui-apple-mobile.png`、`ui-apple-products.png`。画面はローカル検証データの実API応答を表示し、販売実績や顧客事例の証明ではない。

今回の検証はLinuxのChrome。MacのSafari・iPhone/iPad実機での表示は未検証。AndroidのUI刷新は対象外で、Android/AWS/実機/プリンターの試験を今回再実行したという意味ではない。以前の外部依存と製品完成判定は変更しない。商標・ドメインの空きは未確認で、サービス名は承認待ち。

## RPG風UIへの変更（2026-10-01 UTC・初回配色の検証記録）

ユーザーの「AIっぽさをなくしたRPG風の画面」という追加要望に対応。本部Webを商人ギルドの冒険手帳としてデザインした。これは見た目の変更で、販売・発注・返品・棚卸・認可・AIの契約や処理をゲームへ置換していない。

### 実装済み

- 深緑のギルドメニュー、羊皮紙の台帳、金色の枠、角張ったウィンドウ・ボタン。半透明のぼかし、発光、紫の多色グラデーション、キラキラのアイコン、「REGI INTELLIGENCE」の装飾を除去。
- `apps/web/src/GuildScene.tsx` にオリジナルのドット絵をSVGで実装。建物・森・商人の絵は装飾として `aria-hidden` とし、架空の店舗写真・実導入事例ではない。既存ゲームの画像・キャラクターや外部配信フォントは使わない。
- `Icon.tsx` の紋章・コンパス・宝箱・巻物・帳簿を導入。`Dashboard.tsx` の予測への導線を「仕入れの作戦室へ」に変更し、実際の需要予測画面へ接続。根拠・不足時フォールバック・利用枠・未接続時の扱いは保持。
- `style.css` と `main.tsx` で全9画面の枠・表・フォーム・エラー・ナビを統一。金額は円、支払バーは実比率、表示名は業務名を維持。架空のHP・レベル・経験値・売上目標達成率は追加しない。
- `tests/browser/guild.spec.ts` を追加。ドット絵・発光なし・予測への遷移・ナビ文字の4.5以上のコントラスト比・勝手にAI照会を実行しないことを確認。既存の金額期待値や業務試験は削除・緩和していない。

### 検証済み

| 実行コマンド                                                          | 結果                                                                                                                                                             | 証拠（`.context/`）                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `npm run test:web -- tests/browser/guild.spec.ts`                     | 1 PASS。新しいテーマと実画面への遷移                                                                                                                             | `rpg-guild-test.log`                   |
| `NODE_ENV=test npm test`（`.env`とMAINTENANCE_TEST_DATABASE_URL設定） | 43 PASS、0 FAIL/0 SKIP。実PostgreSQLのRLS・競合・冪等性・返品・在庫・予測と金額表示を回帰                                                                        | `rpg-tests.log`                        |
| `NODE_ENV=production npm run build`                                   | core/API/Webの型検査・ビルド成功                                                                                                                                 | `rpg-build.log`                        |
| `npm run test:web`                                                    | 11 PASS、0 FAIL。既存10試験＋ギルド1試験。390/768/1440pxで9画面、スマホ登録、二明細発注・分納・返品、棚卸照合、AI未接続、権限、キーボードを実API/PG/Chromeで検証 | `rpg-web.log` / `browser-results.json` |

実Chromeのスクリーンショットは `ui-rpg-desktop.png`、`ui-rpg-desktop-full.png`、`ui-rpg-mobile.png`、`ui-rpg-tablet.png`、`ui-rpg-products.png`、`ui-rpg-strategy.png`、`ui-rpg-payments.png`。発光を除去したテーマで実集計を表示し、動き抑制設定で過渡的なアニメーションを避けて記録した。

### 未実施・外部依存

今回の変更は本部Webのみ。AndroidのUI、実機・プリンター・AWS・Cognito・Bedrock実疎通、Safari/iPhone/iPadでの表示は今回検証していない。以前の外部依存と製品完成判定は維持。サービス名はREGIのままで、未承認の名称変更・コミット・push・本番配備は行っていない。

## RPG配色の調整（2026-10-01 UTC・旧ネイビー配色の検証記録）

ユーザーの配色への指摘に対応し、深緑・羊皮紙色からチャコール・深いネイビー・控えめな金色へ変更した。RPGの商人ギルドという方向性、既存の業務画面・実データ・権限は保持する。

### 実装済み

- `apps/web/src/style.css` の色を用途別CSS変数に集約。台帳・ナビ・表・フォーム・エラー・状態表示をダーク配色に統一し、金は主操作・選択状態・紋章等のアクセントに限定。金色ボタンは暗い文字色、注意・エラーはそれぞれ識別可能な背景と文字色を使用。
- `color-scheme: dark` により日付・選択・ファイル入力もダーク配色とする。金額・見出しは明るく、補足文にも読める明度を確保。従来のキーボード操作・動き抑制・レスポンシブ構成は保持。
- `apps/web/src/GuildScene.tsx` を夜の色調に変更し、オリジナルの三日月を追加。発光・AI風の紫色や多色グラデーション・キラキラは追加していない。
- `tests/browser/guild.spec.ts` に実際の計算済みCSS色を使うコントラスト試験を追加。金額・見出し・補足・表・フォーム・ボタン・実APIから返った入力エラーを検査する。`design.spec.ts` の支払検証スクリーンショットは新しい配色用の別ファイルに保存。
- 業務API・DB・Androidのソースはこの配色作業では変更していない。サービス名はREGIを維持。`README.md` と本書を現在の配色・検証手順へ更新。

### 検証済み

| 実行コマンド                                                                                             | 結果                                                                                                                                                                                             | 証拠（`.context/`）                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `npm run test:web -- tests/browser/guild.spec.ts tests/browser/design.spec.ts`（コントラスト試験追加前） | 5 PASS。RPGの導線、実支払比率、読込表示、9画面×390/768/1440px、キーボード操作                                                                                                                    | `night-design.log`                       |
| `npm run test:web -- tests/browser/guild.spec.ts`                                                        | 2 PASS。発光なし・実予測画面への遷移を維持。追加試験は指定した本文・操作・フォーム・実APIエラーの文字コントラスト比が4.5以上、ネイティブ配色がdark、未入力の登録要求が実APIで400になることを確認 | `night-guild.log`                        |
| `NODE_ENV=test npx tsx --test tests/retention.test.ts`（`.env`とMAINTENANCE_TEST_DATABASE_URL設定）      | 1 PASS。期限ガード・削除・RLS/不変トリガー復帰を対象試験で確認                                                                                                                                   | `night-retention.log`                    |
| `NODE_ENV=test npm test`（同じ環境設定）                                                                 | 43 PASS、0 FAIL/0 SKIP。実PostgreSQLでRLS・同時再送・同時入荷・返品・棚卸・権限・冪等性・予測を回帰                                                                                              | `night-tests.log`                        |
| `NODE_ENV=production npm run build`                                                                      | core/API/Webの型検査・本番ビルド成功。WebのJSは275.39kB（gzip 86.56kB）                                                                                                                          | `night-build.log`                        |
| `npm run test:web`                                                                                       | 12 PASS、0 FAIL。既存11試験と追加の読みやすさ試験。実API/PG/Chromeで二明細の分納・返品、棚卸照合、権限、実支払比率、読込状態、スマホ商品登録、9画面×3サイズを確認                                | `night-web.log` / `browser-results.json` |

最初の全体試験では42 PASS・1 FAILとなり、共有DBへの保守DDLと別ファイルの業務書込みが並行してPostgreSQLのデッドロック（40P01）を発生させた。失敗ログは `verification/failures/night-parallel-tests-20261001.log` に保存。`package.json` の `npm test` を `tsx --test --test-concurrency=1 tests/*.test.ts` とし、共有スキーマに対する試験ファイルを順次実行するよう修正した。個々の試験内の `Promise.all` による同時再送・返金・入荷・過剰入荷の検査と期待値は変更していない。対象試験→全体43試験→本番ビルド→ブラウザー12試験の順で再実行し、全て合格した。

### 実画面・未実施

Chromeで実API応答を表示して撮影・確認: `ui-rpg-dark-desktop.png`、`ui-rpg-dark-desktop-full.png`、`ui-rpg-dark-tablet.png`、`ui-rpg-dark-mobile.png`、`ui-rpg-dark-products.png`、`ui-rpg-dark-strategy.png`、`ui-rpg-dark-payments.png`。画面撮影のブラウザー例外は0件（`night-screenshots.log`）。実データはローカル試験データであり、顧客事例・実店舗の販売実績ではない。

今回のコントラスト試験は指定した文字・操作の確認であり、全ての状態についてのWCAG適合認証ではない。Linux Chromeのみで、Safari/iPhone/iPadは未検証。Androidビルド・実機・プリンター・AWS・Cognito・Bedrock実疎通・Terraformの検証は配色変更では再実行していない。以前の外部依存と製品完成判定を維持し、本部Webの配色検証を製品全体の実機完成とは称していない。コミット・push・PR・本番配備は実施していない。

## コマンド式レトロRPG UI（2026-10-01 UTC・旧黒背景の検証記録）

ユーザーが選択した「ドラクエ系」を、黒いウィンドウ・白い二重枠・ドット文字・▶の選択カーソルというレトロなメニュー表現として実装した。既存ゲームのブランド・画像・キャラクター・音楽を複製するものではない。配色だけでなくナビ・ウィンドウ・文字・ダッシュボードの操作導線を変更した。

### 実装済み

- `apps/web/src/style.css`: ネイビー・金・明朝体・背景グリッドを廃止。黒地に白い二重枠を設け、タイトルを枠の上に置く。ナビは現在の画面・ホバー・フォーカスに▶を表示。本文・フォーム・表は通常フォントのまま読みやすさを保持し、見出し・メニュー・金額はドット文字を使用。
- `apps/web/src/main.tsx` と `Dashboard.tsx`: 日本語のメニューと「なにを しますか？」のコマンドウィンドウを追加。4つのコマンドは商品・発注・在庫・取引の既存画面へ接続する。9画面の業務名、キーボード操作、実金額・実支払比率、権限・AI利用枠・根拠は保持。円を架空のゲーム通貨に置き換えず、経験値・レベル・報酬も追加していない。
- `GuildScene.tsx`: 町・道・川・橋・店・商人を見下ろすオリジナルのドット絵へ変更。装飾は `aria-hidden`、SVGは `crispEdges`。外部の画像・既存ゲームの素材は使用していない。
- `apps/web/package.json` と `package-lock.json`: `@fontsource/dotgothic16@5.3.0` を追加。フォントは同梱して自サイトから配信し、Google Fonts等の外部サーバーには実行時接続しない。OFLの原文を `apps/web/public/fonts/LICENSE-DotGothic16.txt` に保持し、本番ビルドの `dist/fonts/` にも存在することを確認した。
- `tests/browser/retro.spec.ts`: 黒地・二重枠、実際のローカルフォント読込、ナビのカーソル・選択状態、コマンド4操作のキーボード遷移、自動AI照会を行わないことを追加検証。既存のコントラスト・実APIエラー・全画面サイズ試験も継続。
- 業務API・DB・AndroidはこのUI作業で変更していない。サービス名はREGIを維持し、READMEを現在のデザインへ更新した。

### 検証済み

| 実行コマンド                                                                                               | 結果                                                                                                                                                                                    | 証拠（`.context/`）                      |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `npm install`                                                                                              | Fontsourceを導入、auditは0 vulnerabilities                                                                                                                                              | `retro-install.log`                      |
| `NODE_ENV=production npm run build -w @regi/web`                                                           | Webの型検査・本番ビルド成功                                                                                                                                                             | `retro-web-build.log`                    |
| `npm run test:web -- tests/browser/retro.spec.ts tests/browser/guild.spec.ts tests/browser/design.spec.ts` | 修正後8 PASS。ローカルのドット文字・二重枠・コマンド4遷移、既存の実支払比率・読込表示・コントラスト4.5以上・9画面×390/768/1440px・キーボード・スマホ商品登録を検証                      | `retro-design-tests.log`                 |
| `NODE_ENV=test npm test`（`.env`とMAINTENANCE_TEST_DATABASE_URL設定）                                      | 43 PASS、0 FAIL/0 SKIP。実PostgreSQLの法人/店舗RLS・同時再送/入荷/返金・在庫・棚卸・金額・契約・AI/予測の回帰                                                                           | `retro-tests.log`                        |
| `NODE_ENV=production npm run build`                                                                        | core/API/Webの型検査・本番ビルド成功。Web JS 275.28kB（gzip 86.31kB）、CSSはフォントのUnicode範囲定義込み180.04kB（gzip 78.12kB）。フォントは使用する文字に応じて分割ファイルを読み込む | `retro-build.log`                        |
| `npm run test:web -- tests/browser/operations.spec.ts tests/browser/stocktake.spec.ts`                     | 5 PASS。対象を明示したナビから発注・分納・二明細返品・棚卸照合を再検証                                                                                                                  | `retro-operations.log`                   |
| `npm run test:web`                                                                                         | 14 PASS、0 FAIL。従来12試験と追加2試験。実API/PG/Chromeで業務操作・認可・実比率・コントラスト・全9画面×3サイズ・キーボード操作を回帰                                                    | `retro-web.log` / `browser-results.json` |

最初の表示試験は6 PASS・2 FAIL。文字サイズ変更でスマホの商品画面の長いCSV説明が横にはみ出し、マウス操作の後にプログラムでフォーカスするとカーソルが `:focus-visible` に依存して表示されないことを検出した。説明文の折り返しと `:focus` 時のカーソル表示を修正し、8試験全てを再実行して合格。元ログは `verification/failures/retro-design-first.log` に保存した。

最初の全ブラウザー試験は11 PASS・3 FAIL。新設コマンドとナビが同じ業務名を含むため、従来の曖昧なボタン検索がPlaywrightのstrict mode違反になった。`operations.spec.ts` と `stocktake.spec.ts` の操作対象を「本部メニュー」内の完全一致のボタンへ限定した。金額・数量・返品残数・棚卸残高・権限の期待値は変更せず、コマンド自身は新しい2試験で別に検証する。対象5試験→全14試験で合格。元ログは `verification/failures/retro-web-first.log` に保存した。

### 実画面・未実施

Chromeで実API応答を撮影: `ui-retro-desktop.png`、`ui-retro-desktop-full.png`、`ui-retro-tablet.png`、`ui-retro-mobile.png`、`ui-retro-products.png`、`ui-retro-strategy.png`、`ui-retro-payments.png`。撮影時のブラウザー例外0件、28フォント要求は全て自サイト宛（`retro-screenshots.log`）。PC・スマホ・商品画面を目視確認。金額はローカルの試験取引で、実店舗の導入事例や実績ではない。

今回の実装・検証は本部WebのUIに限定。Safari/iPhone/iPad・AndroidのUI刷新・実機・プリンター・AWS/Cognito/Bedrock実疎通・本番負荷は未実施。独立したAndroid/Python/Terraform検証を今回再実行したという意味ではない。以前の外部依存と製品全体の完成判定は変更しない。コミット・push・PR・本番配備・サービス名変更は実施していない。

## レトロRPGの白背景版（2026-10-02 UTC・旧レトロUIの検証記録）

ユーザーの「背景は白」に対応。本部Webの背景・ウィンドウ・サイドバー・ヘッダー・入力欄を白に変更し、文字と二重枠は黒へ反転した。ドット文字・▶カーソル・コマンド4操作・町の地図・全9業務画面は保持する。

`apps/web/src/style.css` の色変数と `color-scheme: light` を更新。入力系の共通宣言を `font: inherit` に戻し、フォントの継承も統一した。注意・エラー・確定状態は明るい背景上で識別できる配色に変更。`retro.spec.ts` は白背景と黒い二重枠、`guild.spec.ts` はlightのネイティブ配色を期待するよう、承認された見た目の変更に合わせて更新した。金額・数量・権限・業務操作の期待値とコントラスト比4.5以上の条件は変更していない。READMEと支払検証のスクリーンショット保存先も更新した。

| 実行コマンド                                                                                               | 結果                                                                                                                                                                  | 証拠（`.context/`）                            |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `npm run test:web -- tests/browser/retro.spec.ts tests/browser/guild.spec.ts tests/browser/design.spec.ts` | 8 PASS。白背景・黒枠・ローカルのドット文字・カーソル・コマンド遷移、文字コントラスト、実APIの入力エラー、全9画面×390/768/1440px、スマホ商品登録、実支払比率・読込表示 | `retro-light-design.log`                       |
| `NODE_ENV=test npm test`（`.env`とMAINTENANCE_TEST_DATABASE_URL設定）                                      | 43 PASS、0 FAIL/0 SKIP。実PostgreSQLのRLS・同時更新・冪等性・返品・在庫・棚卸・契約・AI/予測を回帰                                                                    | `retro-light-tests.log`                        |
| `NODE_ENV=production npm run build`                                                                        | core/API/Webの型検査・本番ビルド成功                                                                                                                                  | `retro-light-build.log`                        |
| `npm run test:web`                                                                                         | 14 PASS、0 FAIL。実API/PG/Chromeで分納・二明細返品・棚卸照合・権限・実支払比率と全画面の表示/操作を回帰                                                               | `retro-light-web.log` / `browser-results.json` |

Chromeで撮影: `ui-retro-light-desktop.png`、`ui-retro-light-desktop-full.png`、`ui-retro-light-tablet.png`、`ui-retro-light-mobile.png`、`ui-retro-light-products.png`、`ui-retro-light-strategy.png`、`ui-retro-light-payments.png`。PC・スマホ・商品画面を目視確認。撮影時のブラウザー例外0件、ページ背景は `rgb(255, 255, 255)`・配色はlight（`retro-light-screenshots.log`）。画面はローカルの試験取引で、実店舗の実績ではない。

今回変更した製品ソースは本部WebのCSSのみ。業務API・DB・Androidは変更せず、Safari/実機・プリンター・AWS/Cognito/Bedrock実疎通は未実施のまま。以前の外部依存と製品完成判定は維持する。コミット・push・PR・本番配備・サービス名変更は行っていない。

## 白基調のモダンUI（2026-10-02 UTC・現在の画面）

ユーザーの「やっぱりもう少し近代的にしたい」に対応。白背景は維持し、ドット文字・二重枠・▶カーソル・ゲーム風の見出しを外した。通常フォント、細い単線枠、丸みのあるカード、余白、控えめなブルーで本部Webの全9業務画面を統一。AI風の発光・グラデーションは追加しない。

### 実装

- `apps/web/src/style.css`: 配色・文字・枠・角丸・ナビ・入力欄・ボタン・各カードとレスポンシブ配置を更新。選択中のナビは淡いブルーと `aria-current`、キーボードのフォーカスはアウトラインで示す。390/768/1440pxで表示し、横長の表は表内だけでスクロールする。
- `apps/web/src/Dashboard.tsx`: 「コマンド」を「ショートカット」に変更。商品・発注・在庫・返品の4操作は既存の実業務画面へ遷移する。店舗状況・決済内訳・発注サポート等の見出しとアイコンを更新。円の金額、読込中の「—」、支払比率、取引日時・店舗・期間は実APIの情報を維持する。
- `apps/web/src/StoreIllustration.tsx`: オリジナルの店舗SVGを追加し、旧 `GuildScene.tsx` を削除。装飾は `aria-hidden` とし、小さい画面では非表示にする。借用したゲーム素材・画像・架空の業績は使用しない。
- `apps/web/src/main.tsx`: 店舗アイコン・通常の業務アイコン・管理ツールの説明に変更し、ドットフォントの読み込みと三角カーソルを削除。サービス名はREGIのまま。
- `apps/web/package.json`・`package-lock.json`: `@fontsource/dotgothic16` を除去し、不要になった同梱ライセンスも削除。本番成果物はHTML/CSS/JSのみでフォントファイルを含まない。
- `tests/browser/retro.spec.ts`・`guild.spec.ts`: 承認された見た目に合わせ、白背景・単線枠・角丸・通常フォント・ダウンロード不要・フォーカス・4業務遷移・AIの非自動呼出しを検証。既存の金額・数量・認可・返品残数・棚卸残高・コントラスト比4.5以上の条件は緩めていない。`design.spec.ts` の保存先とREADMEも更新。

### 実行した検証

APIとWebを起動したローカル環境で、対象試験→全Node試験→全ビルド→全ブラウザー試験の順に実行。今回の各実行は初回から全件合格。

| 実行コマンド                                                                                                          | 結果                                                                                                                                      | 証拠（`.context/`）                       |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `npm install`                                                                                                         | 不要フォント1パッケージを削除。監査239パッケージ、報告された脆弱性0件                                                                     | `modern-install.log`                      |
| `NODE_ENV=production npm run build -w @regi/web`                                                                      | Web型検査・本番ビルド成功                                                                                                                 | `modern-web-build.log`                    |
| `npm run test:web -- tests/browser/retro.spec.ts tests/browser/guild.spec.ts tests/browser/design.spec.ts`            | 8 PASS。全9画面×3サイズ・スマホの商品登録・実APIの入力エラー・支払比率・キーボード・文字コントラスト・現行テーマ                          | `modern-design.log`                       |
| `set -a; source .env; set +a; export MAINTENANCE_TEST_DATABASE_URL="$MIGRATION_DATABASE_URL"; NODE_ENV=test npm test` | 43 PASS、0 FAIL/0 SKIP。実PostgreSQLでRLS・同時更新・冪等性・返品・入荷・在庫・棚卸・認証更新・契約・AI枠回復・Python予測とのDB連携を回帰 | `modern-tests.log`                        |
| `NODE_ENV=production npm run build`                                                                                   | core/API/Webの型検査・本番ビルド成功。Web CSS 24.07kB、JS 274.22kB（gzip 5.49/85.70kB）                                                   | `modern-build.log`                        |
| `npm run test:web`                                                                                                    | 14 PASS、0 FAIL。実API/PG/Chromeで二明細の分納・返品・棚卸の遅延売上照合・担当外店舗の拒否・AI停止時の操作・表示を回帰                    | `modern-web.log` / `browser-results.json` |
| `node .context/capture-modern.mjs`                                                                                    | 実画面を撮影、ブラウザー例外0件・フォント要求0件・自動AI照会0件。背景white・配色light、スマホ・タブレットの横はみ出しなし                 | `modern-screenshots.log`                  |
| `rg --files apps/web/dist` と不要フォント/旧装飾参照の検索                                                            | 成果物3ファイル、旧フォント依存・読み込み・カーソルの製品ソース参照なし                                                                   | `modern-assets.log`                       |

### 実画面・未実施

Chromeで `ui-modern-desktop.png`、`ui-modern-desktop-full.png`、`ui-modern-tablet.png`、`ui-modern-mobile.png`、`ui-modern-products.png`、`ui-modern-strategy.png` を撮影。支払比率の試験は `ui-modern-payments.png` を保存した。PC・スマホ・商品画面を目視確認。金額はローカルの試験取引で、実店舗の導入実績ではない。

今回の変更は本部Web・関連テスト・説明資料に限定し、業務API・DB・Androidは変更していない。この環境で実行したUI表示・操作試験と関連回帰に未解決の失敗はない。Androidビルド/エミュレーター、独立したPython単体試験、Terraformの再検証は今回実施していない（Pythonの実DB連携試験は上記Node試験で実行）。Safari/iPhone/iPad、指定実機・プリンター、AWS/Cognito/Bedrock実接続、本番負荷・復元、実導入事例・登録審査の外部確認は引き続き別途必要。製品全体の完成判定を今回のUI改修の合格で置き換えない。コミット・push・PR・本番配備・サービス名変更は行っていない。

## 個人AWS・オンデマンド検証環境（2026-10-02 UTC）

ユーザーは常時稼働案ではなく、必要時だけ起動する単一EC2の安価な**架空データ用**環境を承認した。実装担当はソース/試験/手順を担当し、AWS操作は本人Macの確認済みprofileを使う親担当だけが実施。AWS資格情報のVM転送、コミット、pushは行っていない。本節は以前の「AWS未配備」記録に対する今回の進捗で、製品完成・本番仕様達成を意味しない。

### 実装と承認済み仕様への対応

| 設計領域                 | 今回の実装・検証範囲                                                                                                                                                                      | 別途必要な確認                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1 基盤・認証・法人分離   | 独立sandbox Terraform、Cognito MFA/PKCE、immutable法人属性、nonowner/NOBYPASSRLSのSCRAM role初期化。実PGのRLS/別法人・店舗拒否、productionのdev header拒否                                | 本人の初回変更/TOTP登録・Hosted UI操作、クラウドでの実JWT疎通                            |
| 2 販売・同期・金額       | 別opt-in seederで84日×2店舗の本物の業務トランザクション。504確定売上の税込/税別・個数返金配分・immutable台帳・840イベントを検査。API/Room等の既存仕様は維持                               | このsandboxは実店舗販売や決済成功の実績ではない。指定Android実機・実プリンターは未接続   |
| 3 返品・仕入・在庫・締め | 発注6/入荷4/確定返品2/確認待ち2/店舗日締め168。分納残、別々の返金/再入庫、サービス非在庫、台帳残高を実PGで照合。並列再投入・中断復旧                                                      | 実AWSの画面操作/帳票・外部端末による現金/カード/QR返金は別確認                           |
| 4 本部・予測・AI         | 合成表示と期間選択、デモビルドだけ末尾7日初期表示。実Python/LightGBMで84完了日から両店舗98予測行、精度不足は基準在庫。S3/SQS用の限定workload identity                                     | 生成AIは本人のBedrock利用条件/モデルアクセス承認がないため無効。回答を捏造しない         |
| 5 運用・配布・復旧       | EC2 standard CPU/暗号化40GB/必要時起動/2時間自動stop、CloudFront HTTPS/private VPC origin、状態確認付きMac起動停止、ディスク一回承認、安全なログ、stage表示、DB owner隔離、秘密/state除外 | 単一マシンにHA/35日PITRなし。99.9%・本番RPO/RTOの保証/実測ではない。停止中も保管費用あり |
| 6 販売準備               | `docs/aws-sandbox.md` の再現/シード/ログイン/費用/撤去手順、README更新                                                                                                                    | 実店舗導入事例・指定機器写真・補助金登録/審査・商用資料の実物確認は未完了                |

### 作業ファイル

- `scripts/sandbox-seed.ts`: 固定local-admin/PINを使わない独立シード。synthetic-onlyのopt-in、専用tenant二重確認、実Cognito sub、0600 PIN、既存実法人/他法人subjectの拒否、設定固定、deterministic IDs、冪等/中断復旧。RLS/triggerを無効化しない。
- `scripts/sandbox-db-role.ts`: owner接続はmaintenanceのみ。plaintextパスワードをCREATE ROLE文へ入れずSCRAM verifierを生成。既存privileged roleの再利用/SQL identifier injectionを拒否。
- `infra/sandbox/`: 本番 `infra/*.tf` は変更なし。既存bootstrapバケットにstateを隔離し、hostはreleasesのみread・stateはdeny。別artifactバケットは既存APIのtenantId/keyに整合。アプリroleはSecrets Manager全deny。VPC originのTokyo物理AZ制約をzone IDで除外し、EC2 ingressはCF service-managed SGのみ。
- `infra/sandbox/host/`: タイマーをuser-data冒頭に設置。Composeは公式SHA検証。永続32GBへDocker/DBを配置。初期化は確認済みvolume IDのroot600承認ファイルと空署名/無partition/未mount検査が必要。既存ext4保持。image SHAは4MBストリーム。owner env/私有PINはAPI/workerへ渡さない。workload短期資格情報は15分更新、container→IMDS拒否。
- `scripts/sandbox-control.sh` / 3つの `.command`: explicit profile/account/region/instanceを検査して操作。EC2健康/SSM実コマンド成功を確認、stoppingをstoppedまで待機、完了を誤表示しない。
- `apps/api/src/service.ts`: tenant-scoped settingsから非秘密のデモ期間のみ表示。`worker.ts`: 未設定Bedrockの日報を実行せず通常業務を継続。
- `apps/web/src/main.tsx` / `report-period.ts` / `api-response.ts` / CSS: productionでは開発ヘッダーを送らずCognitoログイン。合成バナー、84日全体ボタン、任意のデモ初期7日。HTML504と通信失敗の原因/次の操作を表示。今日の過去売上偽装なし。
- `.gitignore` / `.dockerignore`: env variants、tfvars/plan/state/backend、PIN/鍵/私有設定/アーカイブ等を除外。env/tfvarsのexampleは保持。

### 実行済みローカル試験

ログは `.context/`。全Node試験は `.env` と `MAINTENANCE_TEST_DATABASE_URL` を設定してローカル実PostgreSQLで実行。合成シード試験は別の一時PG DBでmigration001〜006/nonowner/RLSを使い、最後に専用DBを削除した。本番DB/インメモリ代替ではない。

| 実行コマンド                                                                                      | 結果                                                                                                                                          | 証拠                                                                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV=test npx tsx --test tests/sandbox.test.ts tests/sandbox-tooling.test.ts`                | Cognito GUID修正後11 PASS。84日/504売上/168締め/840イベント、金額・返金配分・在庫・中断・並列再投入・既存実法人/外部subject保護・実Python予測 | `sandbox-guid-tests.log`。親もシード6試験を独立再実行 `sandbox-seed-independent.log`   |
| `NODE_ENV=test npm test`（全変更後の最終回帰）                                                    | 60 PASS/0 FAIL/0 SKIP、全業務/権限/実PG同時更新/冪等性/予測・production認証・HTTP案内・起動停止を回帰                                         | `sandbox-final-regression.log`                                                         |
| `npx tsx --test tests/sandbox-tooling.test.ts`                                                    | 8 PASS。productionのdev header拒否、role/SCRAM、account不一致、2hタイマー、stopping/stopped/terminated、SSM stale Onlineの再試行、秘密除外    | `sandbox-power-auth-tests.log`。AWS CLIはstubで、実AWS制御の証明とは別                 |
| `npx tsx --test tests/report-period.test.ts`                                                      | 1 PASS。callback rootでもデモ7日、未設定は今日、無効/未来日拒否、明示query期間優先                                                            | `sandbox-final-targeted.log`（toolingと計6 PASS）                                      |
| `npx tsx --test tests/api-response.test.ts`                                                       | 2 PASS。HTML502/503/504・壊れたJSON、安全な業務エラー、一般通信失敗を停止と断定しない                                                         | `sandbox-friendly-errors-tests.log`                                                    |
| `python3 -m unittest discover -s tests -p '*_test.py' -v`                                         | 4 PASS。seed完了後の再起動は非再投入、中断復旧、設定変更拒否、共通DSNからPrisma専用query排除                                                  | `sandbox-host-tests.log`。compose呼出しはmockで、実host起動とは別                      |
| `NODE_ENV=production npm run build` / デモ末日付きWeb build                                       | core/API/Web型検査・本番build成功。デモ7日/HTML504対応のWebも成功                                                                             | `sandbox-final-build.log` / `sandbox-friendly-web-build.log`                           |
| `npm run test:web -- tests/browser/sandbox.spec.ts`                                               | 2 PASS。実PGの84日/252売上（1店舗）と表示一致、今日¥0→履歴、実予測49行、HTML504操作案内                                                       | `sandbox-browser-demo.log` / `aws-sandbox-demo-local.png`                              |
| `npm run test:web`（全変更後の全ブラウザー回帰）                                                  | 16 PASS/0 FAIL、実PG/API/Chromeで2明細分納・返品・棚卸隔離照合・権限・全9画面/3サイズ・デモ集計・予測・起動待ちエラーを検証                   | `sandbox-final-web.log` / `browser-results.json`                                       |
| `.context/venv311/bin/python -m unittest discover -s forecast -v`                                 | 5 PASS。未来リーク/欠測/基準在庫/曜日平均/発注丸めを回帰                                                                                      | `sandbox-final-python.log`                                                             |
| `terraform -chdir=infra/sandbox init -backend=false`、`fmt -check -recursive`、`validate`、`test` | init/format/validate成功、provider mock 4 PASS（オンデマンド/暗号化/私有origin/MFA/IAM、未確認account/subject/release拒否）                   | `sandbox-terraform-init.log` / `sandbox-final-terraform.log`。実AWSapplyは親側の別証拠 |
| AL2023コンテナーで `dnf info awscli-2`、`bash -n`、`python3 -m py_compile`                        | awscli-2入手可、shell/Python構文成功                                                                                                          | `sandbox-al2023-awscli-package.log` / tooling試験                                      |

上記の最終ローカル試験に未解決の失敗はない。Chromeで合成データ画面 `aws-sandbox-demo-local.png` を撮影・目視確認した。これは**ローカルの合成データ画面**であり、本人のCognito認証後AWS画面の撮影ではない。Androidソースは今回変更しておらず、本節の結果をAndroidビルド/実機再試験の実施とみなさない。

### 発見した不具合と修正・再試験

1. シードのCognito subにRFC UUID検証を使っていた。実CognitoのGUID形式を拒否するため、subjectだけを保守的な16進8-4-4-4-12検証へ修正し、異なる合成GUIDで回帰。tenantはUUIDのまま。親が最終Docker imageを再ビルド/配布した。
2. AL2023の `awscli2` は存在せず初回bootstrap失敗。`awscli-2` へ修正、実repoで入手確認。**失敗中も2hタイマーはactive**と親がSSM確認。既存インスタンスへ修正版を再実行。
3. 新規EBSでも全領域ゼロの仮定が成立せず初期化ガードが停止した。既存データは破壊せず、親が新規作成時刻/空SnapshotId/32GB暗号化/専用tag/attachment/serial/空署名を確認し、対象一台だけを明示初期化。ソースも一回限り承認+署名/partition/mount検査へ修正し、全ゼロ仮定を廃止。
4. 共通DB URLの `?connection_limit=3` がpsycopgに拒否された。hostだけで標準URIへ修正し、API imageの再ビルド不要。host回帰4 PASS。子プロセス失敗の段階名・例外class/returncodeを安全に記録する。
5. 再起動時に毎回シードすると、利用者のデモ発注/返品/PIN変更と衝突して起動を妨げる。永続・私有の投入完了記録で通常restartはskip、中断時だけresume。設定の無断置換は拒否。
6. CloudFrontのHTML504をJSON parseして生の解析エラーを表示した。HTTP/Content-Typeを検査し、日本語の原因/起動待ち/再読込を表示。未認証Hosted UIの起動時に不要なsettings要求をしない。Node2/ブラウザー1の対象回帰合格。
7. 最初のローカル合成ブラウザー試験でデモバナーが見つからなかった。稼働中APIプロセスが新build前の古いコードだったため、現行成果物で再起動。UI/APIの期待値を緩めず2 PASS。初回失敗ログは `verification/failures/sandbox-browser-stale-api.log` に保存。
8. Terraform mock試験の最初の設定はcomputed値がplan時に未確定、次はmock ARNがprovider検証不適合、さらにmock apply後のteardownがdata volume保護で失敗した。実資源への影響なし。**本番のprevent_destroyは外さず**、正式な `override_during=plan` と正しいmock ARNで4 PASS。初回ログは `verification/failures/sandbox-terraform-test-*` / `sandbox-terraform-mock-*`。

### 実AWS配備の進捗（親担当による報告・この担当の直接実行ではない）

本人Macで初回40 create、phase2は0 add/3 change/0 destroy。CloudFront VPC originはDeployed、標準HTTPSのWebを配布済み。最終Docker archive SHA-256は `35a8f2a00628ff7c1920e1164ee1c060730d4eb1f403cd73613ded7972ec60d9`。共通URIの修正はhostへ配布済み（host SHA `c2fda074b25d70139487fe29abfaa19ed00eecc346c2399416759d15ef5d2a4c`）。開発authなし・生成AI無効でserviceがactiveになった。機微な実subject/email/password/PINは本書へ転記しない。

親担当が本人Mac/SSM/HTTPSで実行し、以下を報告した（ローカルmockの結果ではない）:

| 実AWS検証            | 結果                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CloudFront標準HTTPS  | `/health` 200、未認証 `/v1/settings` 401、開発ヘッダーでも401。Cognito PKCEログインフォーム到達                                                                                                                                |
| 実PG role/RLS        | `regi_app` は非所有者・NOSUPERUSER・NOBYPASSRLS。他法人0行、cashierは所属店舗だけ                                                                                                                                              |
| migration/合成データ | 001〜006適用、2店舗/8商品/504売上/168日締め/6発注/840イベント/3550在庫増減。全504売上の税・個数返金配分を再計算して一致                                                                                                        |
| 実Python/LightGBM    | 両店舗98予測行を保存。生成AI回答ではない                                                                                                                                                                                       |
| 期間集計             | 9/25〜10/1の駅前店は21売上・税込1,319,157円。今日ではなく履歴期間の合成値                                                                                                                                                      |
| 実SQS→worker→S3      | CSV job完了、暗号化S3の23,905 bytesをダウンロード成功                                                                                                                                                                          |
| 外部公開拒否         | EC2の公開IP:22/3000/5432は全てtimeout、Web bucket直接アクセス403                                                                                                                                                               |
| 実auto-stop          | 運営者がruntime timerを一時的に60秒へ縮め、製品と同じ `regi-autostop.service` から02:44:19 UTCにEC2停止を観測。EC2 stop APIによる代替ではない。Mac launcherで同じinstanceを再起動、EC2チェック/SSM Online                      |
| 予算/招待            | 実アカウントのUSD30 budgetを確認。通知のみで上限ではない。Cognito RESEND招待を要求済み（メール受信/本人認証成功の意味ではない）                                                                                                |
| stop→startの保持     | auto-stop service起動02:43:15、EC2停止観測02:44:19、Mac launcher再起動完了02:46:30 UTC。同じinstance・同じ暗号化ディスク。504売上/3550台帳/98 LightGBMと全件数不変、RLS再検証成功。runtime overrideは消え、既定2h activeに復帰 |
| 保存帳票PDF          | 実SQS→worker→S3で既存売上のレシートPDFを生成、76,462 bytesを取得し `%PDF` を確認。実プリンター試験ではない                                                                                                                     |
| 最終構成整合         | 再起動後に同じCloudFront `/health` 200。Macの最終Terraform plan exit 0、driftなし                                                                                                                                              |
| 実資格情報境界・更新 | credential serviceを手動更新してから再検証。container→IMDSは実際に拒否、API/workerにownerのMIGRATION_DATABASE_URLなし、私有PIN mountなし。更新後も件数/RLS/CSV/PDF全て成功                                                     |
| 最終正常stop         | 02:50 UTC、インストール済みMac launcherでSSM正常コンテナー停止→forceなしEC2 stop。実state=stopped、公開IPv4=null、暗号化独立32GBデータdisk保持。最終状態は停止中で、本人start操作まで再起動しない                              |

この実装担当も公開HTTPSをChromeで読み取り確認し、REGIログイン入口→実Cognito Hosted UIへPKCE遷移できた。資格情報は入力せず、ブラウザー例外0/入口の警告0/未ログインの不要API要求0（`sandbox-public-browser.log`）。実公開画面 `aws-sandbox-live-login.png` / `aws-sandbox-cognito-login.png` を撮影・目視確認。停止試験中のAPI GETは504で、これはオンデマンド停止中にバックエンドが利用できないことと整合する（`aws-sandbox-public-*.headers`）。停止中もWeb/Cognitoログインフォームは表示できる。

証拠の連絡記録: `.context/aws-deployment-state.md` のFINAL checkpointと `.context/aws-deploy/verify-deployment.js`。Macの `/Users/takuya/regi-sandbox/logs/` に `verification.json`、`persistence-verification.json`、`boundary-verification.json`、`final-stop.log` と各apply/最終planの私有記録。資格情報・パスワード・PINは転記せず、AWSアクセスキーをクラウド開発環境へコピーしていない。

本人用Mac launcherは `/Users/takuya/regi-sandbox/sandbox-start.command` / `sandbox-stop.command` / `sandbox-status.command`、隣の `START-HERE-ja.txt` に利用/招待/費用手順。公開入口は `https://d3azs6ryeibszv.cloudfront.net`。停止中もWeb/Cognitoは表示できるがAPI業務は使えず、起動後数分待つ必要がある。USD30は通知で課金上限ではない。停止中のEBS/S3/Secrets等の保管費用は残る。

この環境で実行可能なソース/ローカル回帰と実AWS起動/保持/予測/CSV/PDF/公開拒否/資格情報境界/正常停止の実装・検証は完了し、既知の未解決コード不具合はない。ただし**本人の初回パスワード変更・TOTP/MFAログイン・認証後の画面操作は未検証**で、本人の操作が必要。Bedrock生成AIは無効、実需要予測は稼働確認済み。指定実機・実プリンター、本番HA/RPO/RTO/復元訓練、実導入事例・登録審査は未完了。個人用の合成データsandbox配備を、製品完成/商用販売/補助金登録の完成と扱わない。追加AWS資源作成や自動再起動、コミット・pushは行わない。

## 個人合成sandboxの二段階認証なし対応（2026-10-02 UTC・準備時点の履歴）

ユーザーの「二段階認証はいらない」に対応。**準備時点ではソース・ローカル検証のみ完了、クラウドの変更はUNAPPLIEDで、最後に確認したCognito poolはMFA ONだった。後に親担当が実適用・受入検証を完了した（末尾参照）。** 準備ターンにはMac実行ツールがなく、開発VMにもAWS資格情報がなかった。資格情報を取得/転送して迂回したり、実装担当がAWS/Cognito更新や公開Web配布を実行したりしていない。直前節の実AWS成功記録はMFA ONの旧配備の証拠として保持する。

### 最小の変更・境界

- `apps/api/src/admin-authentication.ts`: Authの管理者ログインとAdministrationの管理操作に共通の判定を追加。通常はadminかつmfa必須。例外は `COGNITO_MFA_ENFORCED=false`、サーバー指定の `REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID` と完全一致したUUID、RLS取得のcompleted合成seed marker (`synthetic=true`/既知版) の全てを満たす管理者だけ。他法人/実法人/未完了/非管理者は拒否し、`actor.mfa=false` を変更しない。
- `apps/api/src/auth.ts` / `admin.ts`: 上記共有判定を使用。JWT RS256署名・issuer・audience・期限・ID token・法人・staff照合、PIN切替による権限縮小は維持。開発ヘッダー/署名なしtokenの認証経路を追加しない。
- `infra/sandbox/variables.tf` / `main.tf` / `outputs.tf` / `sandbox.tfvars.example`: `require_mfa=true` を既定に追加。demoが明示有効の時だけfalseを許可。OFF（OPTIONALではない）ではsoftware-token設定ブロックを省略し、runtime.requireMfa/output.require_mfaを一致させる。`infra/*.tf` の本番ON設定は変更しない。
- `infra/sandbox/host/bootstrap.py`: 旧runtimeにrequireMfaがない時もtrue。falseはsynthetic設定とUUID必須で、COGNITO_MFA_ENFORCED=falseと対象tenantの一つのopt-in envを作る。worker scopeもmfa=falseで、MFA済みの値を偽装しない。シード済みデータは再投入しない。
- `apps/web/src/main.tsx`: 「常にMFA必要」というログイン説明/ボタンを環境設定に従う説明とCognitoログインに変更。パスワード初回変更・認証自体は不要にしない。余分なWeb認証flagは追加しない。
- `tests/sandbox-mfa.test.ts` / `tests/host_bootstrap_test.py` / `infra/sandbox/tests/security.tftest.hcl`: 実PGとローカルJWKS/実RS256署名で両gate/role/tenant/false actor/署名・期限・issuer・audienceを検査。host/TFの既定ON・明示OFF・拒否条件も検査。
- `README.md` / `docs/aws-sandbox.md`: 個人用例外、未適用の警告、更新API/host/WebとCognito/runtimeを揃える引継ぎを記載。新しい配備自動化や資源追加は行わない。

### 実行済み検証

Nodeコマンドには `.env` と `MAINTENANCE_TEST_DATABASE_URL` を読み込む。全てローカル実PG/Chrome、AWS CLIは使用しない。

| 実行コマンド                                                                                                  | 結果                                                                                                                                                                                                         | 証拠（`.context/`）                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=test npx tsx --test tests/sandbox-mfa.test.ts tests/sandbox-tooling.test.ts tests/auth-web.test.ts` | 13 PASS。MFAなしsigned adminと実設定保存/mfa=false、既定prod拒否、role/PIN昇格拒否、他法人/実法人/未完了拒否。alg:none/別鍵/期限切れ/誤issuer/audience/token種別/dev headers拒否。Web PKCE/state/refresh維持 | `sandbox-password-targeted.log`                                                                                        |
| `python3 -m unittest discover -s tests -p '*_test.py' -v`                                                     | 6 PASS。既定true、明示falseのtruthful env、demo無効/UUID不正/文字列bool拒否、投入済みの保持/中断回復                                                                                                         | `sandbox-password-host.log`                                                                                            |
| `terraform -chdir=infra/sandbox fmt -recursive` / `fmt -check -recursive` / `validate` / `test`               | format/validate成功、provider mock 6 PASS。既定ONと明示OFF、runtime/output整合、PKCE/法人属性維持、false+demo無効のplan拒否                                                                                  | `sandbox-password-terraform.log`。実AWSplan/applyではない                                                              |
| `NODE_ENV=test npm test`                                                                                      | 64 PASS/0 FAIL/0 SKIP。新認証4試験と全業務/RLS/同時更新/冪等性/予測を回帰                                                                                                                                    | `sandbox-password-regression.log`                                                                                      |
| `NODE_ENV=production npm run build`                                                                           | core/API/Webの型検査・本番build成功                                                                                                                                                                          | `sandbox-password-build.log`                                                                                           |
| `npm run test:web`                                                                                            | 16 PASS。実PG/API/Chromeの全画面/分納/返品/棚卸/認可/合成集計/予測/HTMLエラー回帰。現行API buildでローカルプロセスを再起動後、もう一度全16 PASS                                                              | `sandbox-password-browser.log` / `sandbox-password-browser-current-api.log`。認証後の本物のCognitoログイン試験ではない |
| `sha256sum --check .context/mfa-prebuild-source.sha256`                                                       | API3ファイル/Web/hostの全5 snapshot一致、実装freeze後の変更なし                                                                                                                                              | `sandbox-password-code-freeze.log`                                                                                     |

最初の認証試験は3 PASS/1 FAIL。負例token fixtureのissuer/audienceが後続 `.setIssuer/.setAudience` で正常値へ上書きされ、実際には正常tokenを作っていた。負例が正しい不正claimsを保持するようfixtureだけを修正し、拒否の期待値を変えず13 PASS。`verification/failures/sandbox-password-token-fixture-first.log` を保持。

最初のTerraformは5 PASS/1 FAIL。runtime JSONのcomputed mock値が未確定で、requireMfaの配線のassertionが評価不能だった。pool.id/client.id/CloudFront.domain_name/S3.id/SQS.urlに決定的なmock値を与え、**runtime/outputのassertionを削除せず**6 PASS。`verification/failures/sandbox-password-terraform-unknown-runtime.log` を保持。どちらも修正後の回帰に未解決の失敗はない。

### 配備待ちだった時点の履歴

親担当が更新APIをローカルDockerで準備（image `800638c94865a39e43578a1f6c5b733fc5533a8617887f4d6b113783803a274f`、archive SHA `0ce49177e0168620922947149a7af3e33fcc34e96017559fd5ec1d592603dc80`、production build成功）。Webも競合しない `.context/password-only/web` に別途準備したという報告。この時点では私有の配備待ち成果物だった。後の実適用を末尾に記録する。

準備時点では、Mac/AWSアクセス復帰後に既存個人stackで `require_mfa=false` と更新image SHAをレビュー/適用し、修正版host/runtime/APIとWebを揃える必要があった。Cognito OFFだけの手動変更やactor.mfaの偽装では解決しないため、この時点では解除済みと報告しなかった。コミット/push/branch変更は実施していない。

### OFF移行の実API拒否に対するTerraform修正（同日・再適用前の履歴）

親担当のMacアクセスが復帰し、実配備を再開。最初のON→OFFで、`software_token_mfa_configuration { enabled=false }` の併記をCognitoが `InvalidParameterException` で拒否したという報告。bootstrap S3更新は成功したがCognitoはON、runtimeは旧設定のまま。本節の修正時点ではMFA解除成功としていない。実装担当は引き続きAWS/Macを操作しない。

- `infra/sandbox/main.tf`: dynamicブロックに変更し、require_mfa=trueの時だけTOTP enabled=trueを生成。falseでは空listになり、TOTP設定を完全省略。
- `infra/sandbox/tests/security.tftest.hcl`: OFFでブロック数0、ONでenabled=trueを検査。runtime/output/PKCE/法人属性のassertionは保持。
- 使用provider **v6.67.0** のOptional/noncomputed schema、更新処理・空list→nil変換と、依存SDK **v1.74.0** のnil時に送信しない処理を一次ソースで確認した。[provider](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/cognitoidp/user_pool.go)、[SDK](https://github.com/aws/aws-sdk-go-v2/blob/service/cognitoidentityprovider/v1.74.0/service/cognitoidentityprovider/api_op_SetUserPoolMfaConfig.go)
- `fmt` / `fmt -check -recursive` / `validate` 成功、Terraform provider mock **6 PASS**。証拠 `.context/sandbox-mfa-off-fix-terraform.log`。これは実AWS再適用成功の代替ではない。
- API/Web/hostは変更せず、準備済みsource snapshot全5件が引き続き一致（`sandbox-mfa-off-fix-artifact-freeze.log`）。イメージ再ビルドは不要。今回Node/Web/host全回帰は再実行しておらず、直前節の64/16/6 PASSは前回の検証記録。
- 親報告では停止中EC2の公開IP関連付け読み取りがhost置換planを提案した。破壊的planをapplyせず、既存EC2を起動してから再planすると0 add/3 update/0 destroy。`docs/aws-sandbox.md` にstart-before-planと作業後の正常stopを追記。EC2 sourceや保護設定は変更しない。

この時点で親担当へ修正済み2ファイルと試験成功を報告し、実Cognito OFF/runtime/APIの再適用・検証を引き継いだ。その後の結果と、停止せず稼働継続するユーザーの指示は次節に記録する。

## 個人合成sandbox・パスワードのみ認証の最終実AWS受入（2026-10-02 UTC）

**親担当が実適用・運用検証を完了。本人が試用するため、ユーザーの明示希望で稼働継続。最終停止済みではない。** 以下は親担当がMac/AWS/SSMで実行して報告した結果であり、実装担当のローカル試験やmockの結果とは区別する。準備時点のUNAPPLIED、ON移行失敗/再適用待ち、旧配備の02:50 UTC停止は履歴として残し、本節が現在の引継ぎ状態を示す。

| 対象・実操作                                    | 親担当の実環境結果                                                                                                                                     | 証拠・補足                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 既存stackへ修正版Terraform適用、Cognito設定取得 | MFA **OFF** を実確認。同じEC2 `i-0d919fae2ff7d3b6f` と暗号化データディスク `vol-0752243a8f7b84739` を保持                                              | OFFではTOTP設定ブロックを省略。ON既定/本番のMFA設定は変更しない                                                |
| runtime/配備成果物の更新                        | requireMfa=false、archive SHA `0ce49177e0168620922947149a7af3e33fcc34e96017559fd5ec1d592603dc80`、Mac設定保存。bootstrapをSSMでchecksum確認して更新    | bootstrap SHA先頭 `038b55`、stage ready。Web `index-DkwO6K0k.js` 配布、CloudFront invalidation Completed       |
| SSMで現行コンテナー・サービス確認               | API image `800638c94865a39e43578a1f6c5b733fc5533a8617887f4d6b113783803a274f`、service active                                                           | 受入SSM command `19887108-2811-4d7e-94e5-7ffe53f7ac67`                                                         |
| 管理者の共有認証判定・Administration guard      | 対象合成法人の管理者は **actor.mfa=falseのまま許可**。cashier/別法人は拒否。管理操作は認証guardを通り、その後の期待どおりの `PRICE_MODE_FROZEN` で終了 | データを変更せずguard通過を確認。本人のブラウザー認証済み操作の代替ではない                                    |
| 公開HTTPS/認証拒否                              | health 200、未認証401。不正token/dev headersを拒否                                                                                                     | PKCE/JWT/tenant/roleの境界を解除しない                                                                         |
| 合成データ・金額・RLS・DB資格情報境界           | 2店舗/8商品/504売上/168日締め/6発注/98予測/840受信イベント/3550在庫台帳が保持。販売金額/返金配分、RLS、非所有者regi_app境界が合格                      | 9/25〜10/1の対象店舗レポート1319157円。再seed/取引の変更なし                                                   |
| 稼働中の最終Terraform plan                      | **exit 0、変更なし**                                                                                                                                   | Mac `logs/password-only-final-plan.log`。停止中公開IP driftの置換planは適用せず、同じEC2を先に起動してからplan |
| 停止タイマー・引継ぎ                            | 2時間タイマー有効。親担当が引継ぎ時に再設定する運用。ユーザーの希望で稼働を継続                                                                        | 今回の最終stopは行わない。旧配備の自動停止/再起動/正常停止試験は前節の履歴                                     |
| Cognito利用者状態                               | AdminGetUserで **CONFIRMED**。今回reset/invitationは行わない                                                                                           | 本人のパスワードは本人管理。認証後ログイン/画面操作は未実施                                                    |

主な実検証証拠はMac `/Users/takuya/regi-sandbox/logs/password-only-live-verification.json` と `password-only-final-plan.log`。実装担当は資格情報やパスワードを取得/転送せず、親担当の報告に基づき本資料・READMEのみ更新した。今回ドキュメント更新でアプリ/host/Terraformソースの変更や追加AWS操作はしていない。

本人の入口は **https://d3azs6ryeibszv.cloudfront.net**。二段階認証はこの個人合成sandboxだけ不要で、メール/パスワード・PKCE・署名付きJWT・法人/権限チェックは維持。本人の認証後ログインと画面操作はまだ検証していない。2時間自動停止後はMac launcherで起動し、数分待って利用する。USD30は通知で課金上限ではなく、停止中のEBS/S3/Secrets等の保管料金は残る。

Bedrock生成AIは無効で、実LightGBM予測98行は保持。本番のMFA/Multi-AZ/HA/RPO/RTO仕様は変更しないが、この単一EC2 sandboxがそれらを達成したという意味ではない。指定Android実機・実プリンター・実決済、本番復元訓練、実導入実績・法務/税務レビュー・登録審査は未完了。個人sandboxの配備・受入完了を製品完成/商用販売準備/補助金登録の完了と称さない。

## ブラウザー認証のfetch呼び出し修正（2026-10-02 04:39 UTC）

本人からログイン時の `Failed to execute 'fetch' on 'Window': Illegal invocation` を受領。`BrowserAuth` が標準fetchをオブジェクトのメソッドとして呼び、WindowではなくBrowserAuthが呼び出し先のthisになっていた。既存の注入されたモック通信ではこの制約を再現できていなかった。

- `apps/web/src/auth.ts`: 既定の通信を `globalThis.fetch` へ転送する関数に変更。PKCE/state/JWT/権限検査やAWS側の認証設定は変更しない。
- `tests/browser/auth.spec.ts`: Chromeの標準fetchを置換せず、HTTP応答だけを合成応答に差し替える回帰試験を追加。認可コード交換、並列更新の一回化、保存・ログアウトを検査。修正前に同じIllegal invocationで失敗し、修正後に成功した。
- 関連Node試験7件、ブラウザー全17件が合格。Web型検査と本番ビルド成功。証拠は `.context/fetch-invocation-before.log` / `fetch-invocation-after.log` / `fetch-invocation-unit.log` / `fetch-invocation-browser-suite.log` / `fetch-invocation-build.log`。
- WebのみS3へ更新し、CloudFront invalidation `ICTSDIXRMWRUMUM90OHR8K2NOE` はCompleted。現在の配信JSは `index-BX4f8MJS.js`。EC2/API/DB/利用者パスワード/二段階認証設定/自動停止タイマーは変更していない。
- 公開された実ビルドでも、合成の認証・API応答をブラウザー内で差し替え、コード交換からダッシュボードへの遷移、URLからの認証コード除去、画面例外0を確認。これは本人の実Cognitoログイン成功を代替しない。証拠 `.context/fetch-fix/public-verification.log`。実バックエンドのhealthは200。

失敗時の認証待ち情報は消費済みのため、古いコード付きURLを再送しない。利用者は `https://d3azs6ryeibszv.cloudfront.net/` を開き直し、「ログイン」から新しい認証を開始する。パスワードの再設定・認証情報の共有は不要。

## PDF・CSVの完了表示と保存導線（2026-10-02 04:54 UTC）

本人から全PDFが出ないとの報告を受領。実AWSのジョブはcompletedで、最近の発注書PDF（71,892 bytes）・領収書PDF（76,562 bytes）・CSV（23,905 bytes）をアプリのArtifacts.download経由で実S3から取得できた。原因は、Webが非同期作成後に一度しか状態を取得せず、保存ボタンも初期状態で閉じた出力履歴内にあったこと。今回のAWS調査では取引の追加・修正やPDFの再作成は行っていない。

- 作成受付後は出力履歴を自動で開いて表示位置へ移動し、作成待ち・作成中の間だけ完了状態を自動確認する。完了すると確認を停止し、店舗・ログイン情報の変更時は前の確認結果を適用しない。通信失敗時は案内を表示して再試行する。
- 領収書PDF・発注書PDF・返還伝票PDF・CSV・一式の名称と状態を日本語化。保存ボタンはPDF/CSV/一式を区別し、一式が圧縮ファイルであることを説明する。
- 保存時は認証情報を一度取得し、APIの業務エラーを表示。ダウンロード用リンクをDOMに追加してから操作し、Blob URLを即座に無効化せず遅延解放する。ファイル名には出力IDを含める。
- 修正前のChrome回帰試験で閉じた履歴を再現して失敗。修正後はブラウザー全20件合格。遅延・一時的503からの回復・完了後の確認停止・二重要求なし・PDF/CSV/圧縮ファイルの保存・403拒否を検査。既存の発注操作試験も、手動更新なしで実APIが生成したPDFを保存し、内容の先頭とサイズを確認するところまで拡張した。
- 関連Node14件合格。飲食店の店内/持ち帰りを想定した混在税率の領収書と部分返品の元税率表示も検査。Web型検査・本番ビルド成功。
- Web `index-D6gbrG0R.js` を配信し、CloudFront invalidation `IA6M9FDWM3E4V9OH9S96BAVHQE` はCompleted。公開実ビルドでも合成API応答を使用して履歴の自動表示→完了→PDF保存を確認し、画面例外0。本人のブラウザーでの保存操作を代行したわけではない。実health200、未認証の実PDF download401、EC2 runningを確認。

証拠は `.context/pdf-before.log` / `pdf-after.log` / `pdf-browser-suite.log` / `pdf-unit.log` / `pdf-build.log` / `pdf-fix/public-verification.log`、Mac `logs/pdf-download-inspection.json`。API/DB/認証設定/停止タイマーは変更せず、既存帳票を保持した。利用手順は `docs/operations.md` のPDF・CSV保存を参照。

同時に利用者の指定により主対象を飲食店と明確化し、READMEと設計へ反映した。店内/持ち帰り・税率別帳票・適用日時付き税率履歴を優先し、未確定の将来税率を固定しない。厨房連携等を追加実装したという意味ではない。

## PDFの帳票レイアウト（2026-10-02 05:22 UTC）

単なる文字列の羅列だったPDFを、共通のA4縦レイアウトへ変更した。`apps/api/src/pdf.ts` を単体出力と一式アーカイブの両方から利用する。

- 領収書・適格請求書・発注書・返還伝票に、見出し、宛先/発行者、伝票番号、日本時間の日時、合計欄、右寄せ金額、明細表、備考、ページ番号を配置。日本語の通常/太字フォントを埋め込み、長い名称・住所を折り返す。複数ページでは帳票名・番号・表見出しを繰り返す。
- 領収書には保存済みの店内/持ち帰り、単価、値引き、税率別税込金額・税額、支払方法、預り・釣銭等を表示。返還伝票は元販売日・返還日・元税率別返金額を表示し、税額を再計算しない。発注書に未保存の税率0%を表示していた旧出力を廃止し、税区分未確定の注記を付ける。
- 取引スナップショットと発注発行時点の内容だけを使用し、現在の商品マスターで過去の金額を変更しない。既存PDFはそのまま保管し、新規出力から新しい体裁を適用する。再作成手順を運用文書へ追記した。
- PDF実ファイルをPopplerで読み取る7件の回帰試験を追加/更新。混在税率、税抜、全額値引き、部分返品、発行後改訂、JST日付繰越、整数精度、500明細、長文、ページ内の座標を検証。単体領収書の備考が不要に次ページへ移る問題を修正し、代表的な領収書・発注書・返還伝票・複数ページを画像化して目視確認した。
- Node全71件、ブラウザー全20件が合格。実PostgreSQLを使った保存設定・一式PDFの検査と、ブラウザーから保存した実発注書の文字/金額検査も成功。全体ビルド成功。Docker内の日本語PDF生成も確認した。証拠は `.context/pdf-layout/` の `full-tests.log`、`browser.log`、`build.log`、`tests.log`、PDF/PNG各種。
- 個人AWSのAPI/ワーカーをイメージ `sha256:3e1f568cd44b6087ed2cb71c60562d6d323c250df84e54a0e340fbbd63de648c` へ更新。配布アーカイブSHA-256は `cad33ca77982a9e3e790c19ab782ce7765eab8d6d3f64358714256a56fb3587b`。Terraformはruntimeパラメーター1件のみ更新、EC2・DBは再作成/再起動せず、Web・認証・自動停止タイマーも変更していない。
- 実SQSワーカーで領収書 `57d6bfed-1534-45fc-be1b-6e771e83e517`、発注書 `693cefd9-961c-4d1c-b2a6-84a506ec0036`、返還伝票 `4d5a1d1e-1c93-4928-b69e-2e2a2fb89d17` がcompletedとなり、Artifacts.downloadで実S3から取得できた。暗号化・SHA-256一致を確認して実ファイルも目視検査。旧PDF2件のSHA-256は不変。売上504件・返品4件・発注6件・締め168件・在庫台帳3,550件の件数と内容チェックサムが更新前後で一致した。追加したのは出力ジョブのみ。
- health200、未認証PDF取得401を確認。Mac証拠は `logs/pdf-layout-before.json`、`pdf-layout-after.json`、`pdf-layout-deploy.json`。本人のブラウザーでの操作や実機プリンターの検証を代替するものではない。自動停止は従来どおり2026-10-02 06:27:16 UTC（15:27:16 JST）。

## D0 第1週の基盤整備（2026-10-02・ローカル検証）

初回コミットを秘密scan0件で作成し、Prettier（幅100）とKotlin整形を挙動変更のない別コミットへ分離した。ESLint9 recommended-type-checkedは既存ファイル・ルール別警告上限を固定し、追加警告を拒否する。Node/Webの名前manifestと実行結果を照合し、skip/TODOも不合格とする。DB不要18件・実PG53件へ分離した。

CI、Dependabot、Playwright webServer、Node版指定、公式Gradle8.11.1 wrapper、digest固定multi-stage Docker（production依存、Python独立stage、非root、healthcheck）を追加。保守migration/seedの実行経路を保持した。

ローカルでNode71件（Node22でも分離18/53）、Android JVM3件・接続8件、forecast Python5件、host Python6件、Docker build/API healthy/保守import、日本語PDFを含む統合試験、両Terraform fmt/validate・sandbox mock6件、npm audit0件とCI構文検査を確認した。ブラウザー20件のwebServer起動回帰も合格し、端末強制停止後の別プロセス再開・二重売上なしを確認した。AWSへの適用・配備は今回実施しない。main保護・PRフローはGitHubでの確認待ち。ユーザーが追加承認したpushはD0の検証・修正後に実施する。
