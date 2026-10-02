# REGI

飲食店を主対象とする、日本円・日本語の Android POS / 本部管理 / 受発注 / 仕入請求・買掛 / 在庫 / 需要予測。店内・持ち帰りの税区分、税率別の領収書、適用開始日時付き税率履歴を重視します。将来の制度変更は確定した要件に従って設定し、予定税率を固定実装しません。
承認済み仕様は `docs/implementation-plan.md`、実装・検証の実態と未達条件は `docs/implementation-status.md` を参照してください。
本リポジトリは実店舗での製品完成・一般販売・補助金登録を証明するものではありません。

## 構成

- `apps/api`: NestJS REST、Prisma トランザクション、PostgreSQL RLS、冪等性、SQS/S3 ワーカー、Bedrock 照会。
- `apps/web`: React / Vite の日本語本部画面。実 API を利用し、ブラウザー内の疑似 DB は使用しません。
- `packages/core`: TypeScript の整数円計算、最大剰余法、個数別返金配分、営業日、CSV。
- `android`: Kotlin / Compose / Room / WorkManager。会計・送信待ち・担当者・認証期限を永続化。
- `forecast`: Python / LightGBM、時系列検証、曜日平均との比較、欠測日除外、基準在庫フォールバック。
- `infra`: 東京リージョンの本番Terraform。別の `infra/sandbox` は個人用オンデマンド検証環境です。実配備の検証状況は実装statusを参照してください。

## ローカル起動

前提: Node.js 22（22.12 以上）、PostgreSQL 17、Python 3.11、JDK 17。`.nvmrc` は Node 22、`engines` は検証対象の Node 22〜24 を指定します。Android は SDK 35 / Gradle 8.11.1 が必要です。正規 Gradle wrapper が指定版を取得するため、Gradle の別途導入は不要です。

```bash
npm ci
cp .env.example .env
set -a; source .env; set +a
bash scripts/local-db.sh
npx prisma generate --schema apps/api/prisma/schema.prisma
npm run db:migrate
npm run db:seed
npm run build
npm run dev:api
```

別ターミナルで `npm run dev:web`。Web は `http://localhost:5173`、API は `http://localhost:3000`、OpenAPI は `/openapi`。
`scripts/local-db.sh` は Amazon Linux の PostgreSQL バイナリーと `postgres` OS ユーザーを想定します。Mac 等では PostgreSQL の起動を置き換えて同じ二つの DB ロールを作成してください。
`.env.example` の資格情報、シード法人・担当者・PIN はローカル検証専用です。外部公開するサーバーで使用しないでください。
`REGI_DEV_AUTH=true` は `NODE_ENV=development/test` 以外では起動時に拒否します。

`db:migrate` は pg 8 の simple query で各 SQL ファイル全体を実行し、通常はファイル単位のトランザクションにします。先頭行が `-- regi:transaction=false` のファイルだけ文単位で実行でき、`CREATE INDEX CONCURRENTLY` に対応します。このモードでは途中失敗の前に完了した文が残るため、非トランザクションの SQL は再開手順も準備してください。

000〜008 の SHA-256 を `regi_migrations.checksum` に記録し、適用済みファイルの改変・欠落は未適用 SQL の実行前に拒否します。D0の000〜007は変更せず、008で仕入金融の13表を追加しています。旧版の version のみの台帳は、承認済み001〜006の SQL が変更されていないことを確認した上で、初回だけ checksum を追加して採用します。取引や適用済み SQL は再実行しません。変更は新しい migration へ追加し、エラーを避けるために checksum を上書きしないでください。アプリロールは台帳を参照できますが更新できません。

`000_roles` は `regi_app` の LOGIN と非特権設定を検査し、未作成なら SCRAM verifier で作成します。未作成ロールを作る初回だけ CREATE ROLE が可能な管理接続と `DATABASE_URL` のアプリパスワードが必要です。通常の migration には既存 `regi_owner` を使い、API には `regi_app` だけを渡します。ローカルでは `scripts/local-db.sh`、Docker では初期化 SQL、sandbox では既存の秘密ファイルによる role bootstrap が先にロールを用意します。この VM では AWS apply・配備を行いません。

Docker では `docker compose up --build db migrate api worker`。シードは `docker compose run --rm api npm run db:seed`。
ホストの PostgreSQL と 5432 番ポートが競合する場合は、ホスト DB を停止するか Compose のポートを変更してください。
本部 Web はホストから `npm run dev:web` で起動します。Compose のローカルワーカーは API コンテナーとは別ファイル領域を使用するため、ローカル帳票は API の非同期実行からダウンロードします。本番は共有 S3 を使用します。

## 操作

1. Android の設定に API URL と登録端末 ID を入力し、初回同期します。エミュレーターからホスト API は `http://10.0.2.2:3000`。
2. 担当者を選び PIN 認証し、釣銭準備金を入力して開局。開局イベントもオフライン送信待ちへ保存します。
3. 商品追加 → 値引き・支払方法 → 支払い開始。外部決済は保存後に端末を操作し、成功確認番号を記録します。
4. 不明結果は確認待ちとして保持。売上確定は Room トランザクションで会計・イベント・端末連番を保存します。
5. 保存後に LAN 印刷。失敗時は履歴から再印刷し、売上を再作成しません。
6. 本部で発注下書き → 承認 → 発行 → 分納入荷。返品は元販売店舗のオンライン管理者操作で数量を予約します。
7. 現金返金は返金を支出する営業中開局に記録します。元取引の開局へ遡って現金を減らしません。
8. 端末締めは暫定。店舗日締めは全端末の同期・未完了解消後に確定。棚卸では全端末を停止したまま差分を記録します。

本部の「仕入請求」で原書類・税率別明細を保存し、入荷との照合、債務確定、相手方確認、部分支払、減額、返金、訂正、固定時点の出力へ進めます。物品返品と請求の減額は別々の事実として記録します。管理者・本部が金融操作、店長が担当店舗の閲覧・下書き・物品返品を行い、レジ担当へ原資料を公開しません。詳細は [仕入請求・買掛管理](docs/architecture/purchase-finance.md) を参照してください。

画面は `/dashboard`、`/products`、`/purchases/orders`、`/purchases/suppliers`、`/purchases/invoices`、`/purchases/invoices/<UUID>`、`/purchases/payables`、`/purchases/returns`、`/inventory`、`/sales`、`/shifts`、`/ai`、`/sync`、`/settings` に直接アクセスできます。店舗・期間はqueryへ保存します。応答が不明な操作は同じ操作IDで再確認し、再読込後は「保存結果を照会」で保存済みか確認できます。結果不明のまま別IDを自動発行しません。

CSV 商品取込見出し: `sku,jan,name,price,cost,taxCode,stockManaged`。`stockManaged` は `true/false`、金額は整数円。1回最大5,000行、法人合計50,000SKU。取込は一括トランザクションです。
Web の「商品・価格」で登録商品を選ぶと版番号付き更新ができます。適用開始日時を指定すると価格を予約します。

本部Webは白基調のモダンな管理画面です。読みやすい通常フォント、細い単線枠、丸みのあるカード、控えめなブルーを採用し、ダッシュボードの「ショートカット」から商品・発注・在庫・取引の実画面へ進めます。ドット文字・二重枠・ゲーム風カーソルを外し、フォントのダウンロードも不要です。店舗のイラストとSVGアイコンはオリジナル。発光・キラキラ・AI風グラデーションは使用せず、金額は円、支払比率は実集計、業務名・権限・予測の根拠や利用枠は明示的な表示を維持します。本部画面はスマホ・タブレットにも対応し、横長の表は表の中でスクロールできます。キーボードのフォーカス、メインへのスキップリンク、動きを減らす端末設定に対応。読み込み中は売上ゼロではなく「—」を表示します。

## 検証

```bash
set -a; source .env; set +a
export MAINTENANCE_TEST_DATABASE_URL="$MIGRATION_DATABASE_URL"
python3.11 -m venv .context/venv311
.context/venv311/bin/pip install -r forecast/requirements.txt
npm run format:check
npm run lint
npm run typecheck
npm run test:manifest
NODE_ENV=test npm run test:unit
NODE_ENV=test npm run test:integration
NODE_ENV=production npm run build
npm run test:web
npm run test:web:manifest
.context/venv311/bin/python -m unittest discover -s forecast -v
NODE_ENV=test python3.11 -m unittest discover -s tests -p '*_test.py' -v
NODE_ENV=test npx tsx scripts/restore-test.ts
NODE_ENV=test REGI_LOAD_BASEURL=http://localhost:3000 npx tsx scripts/load-test.ts
```

`test:unit` は DB 不要の core / ai-plan / presentation / report-period / api-response / auth-web と仕入金融・画面状態・URLの12ファイル（現時点47件）。`test:integration` は残りのファイルを実 PostgreSQL で順次実行します（現時点132件、実PDFとsandboxツール試験も含む）。`npm test` は両方をまとめて実行する互換コマンドです。通常の確認では分離実行か一括実行のどちらかを選べます。

`tests/manifest.txt` は既存 Node 71件・ブラウザー20件とD0追加を保持し、現在の Node 179件・ブラウザー48件の名前・ファイル一覧です。`test:manifest` は TypeScript AST から複数行・ネストした試験と JSON fixture の名前を含む一覧を作り直して比較し、各 Node ランナーと `test:web:manifest` は実行結果とも比較します。削除・skip・TODO・失敗は合格にできません。新規試験の追加時は一覧の変更をレビューし、`npm run test:manifest:update` で明示更新してください。ブラウザーの一部だけを実行した時は、全48件の実行確認である `test:web:manifest` は使用しません。

Web 操作試験は migration・seed 済みの DB と Google Chrome (`/usr/bin/google-chrome`) を前提とします。Playwright の `webServer` が API と Web を起動して終了時に停止します。ローカルでは既存のサーバーを再利用できるため、変更後は現行 build で再起動してください。CI では再利用せず、毎回起動します。

ESLint 9 の `recommended-type-checked` を全 TypeScript に適用し、API の `no-explicit-any` は警告から開始します。既存コードの型不明値・Promise 等の診断は `eslint-baseline.json` にファイル・ルール別の上限を記録し、警告として残しています。`npm run lint` は新規ファイルのエラーと警告数の増加を拒否します。警告の詳細は `.context/lint-results.json` で確認でき、既存警告の解消は今後の対象箇所から進めます。既存警告がゼロになったという意味ではありません。`typecheck` は API/Web/core に加え、scripts と tests も型検査します。
PDF の出力・検証には Noto Sans CJK の日本語フォントと Poppler (`pdftotext`) が必要です。Amazon Linux は `sudo dnf install -y google-noto-sans-cjk-ttc-fonts poppler-utils`。フォントの配置が異なる環境では `JAPANESE_FONT` に `NotoSansCJK-Regular.ttc` のパスを指定します。Docker イメージには日本語フォントを同梱しています。
削除試験を含む `npm test` には、ローカル限定の `MAINTENANCE_TEST_DATABASE_URL` を `.env` の `MIGRATION_DATABASE_URL` と同じ所有者接続に設定してください。通常 API には所有者接続を渡しません。
共有する実PostgreSQLスキーマへの保守DDLと業務試験が競合しないよう、試験ファイルは順次実行します。各試験内の同時再送・同時入荷・返金の競合検証は並列のままです。
hostのbackup/restore試験も独立した一時DBで000〜007と追加テーブルを復元します。別試験で000〜008・仕入金融13表・原スナップショット・逆記録を実dumpから照合します。PG17のpg_dump/pg_restoreを使用してください。CIではPython試験stepの `POSTGRES_TEST_CONTAINER` でserviceと同じPG17クライアントを選びます。実AWSは呼ばずuploadはstubです。
復元・負荷試験はローカル専用の試験データを追加します。復元試験は `.context/restore-test.dump` と別の `regi_restore_*` DB を残します。
負荷試験では100端末のストレスを再現するため SQL で専用端末を作成し、通常の2台/店舗の登録制限を試験 fixture に限って迂回します。
本番 DB に試験コマンドを実行してはいけません。
合成シード試験はローカルPostgreSQLの管理接続（既定 `postgres`）で専用の一時DBを作成・削除します。接続を変更する場合は `SANDBOX_TEST_ADMIN_DATABASE_URL` にローカル限定の管理URLを設定します。Python環境は上記 `.context/venv311` を共通利用します。

```bash
export ANDROID_HOME=/path/to/android-sdk
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
android/gradlew -p android assembleDebug testDebugUnitTest
bash scripts/android-test.sh
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
terraform -chdir=infra/sandbox init -backend=false
terraform -chdir=infra/sandbox fmt -check -recursive
terraform -chdir=infra/sandbox validate
terraform -chdir=infra/sandbox test
```

同一 JSON fixture を TypeScript と Kotlin が読み、双方で10,000ケースの保存則を検査します。
Android 接続試験はホスト API を利用し、毎回独立した試験法人・端末を実PostgreSQLに作成します。以前の失敗試験の未送信連番と運用データを混ぜません。Room 再オープン、外部決済確認待ち、72時間失効とオンライン認証更新、PKCE/state/refresh、複数明細の実画面操作、TCP 印刷 sink、永続Room DBの50,000SKU（JAN・商品名・部分一致検索）を検査します。実機・実プリンターの代替証明ではありません。

`ANDROID_SERIAL=emulator-5556 bash scripts/android-restart-test.sh` は確認待ち会計を保存し、`am force-stop` 後に異なるプロセスIDで確認・同期を再開して二重売上がないことを検査します。エミュレーターのserialは `adb devices` の実際の値を指定してください。APIと `DATABASE_URL` が必要です。専用試験runnerはandroidTest APKにだけ含まれ、製品release APKへ入りません。

この Conductor VM では Android SDK が `.context/android-sdk`、Python 環境が `.context/venv311` にあります。`export ANDROID_HOME="$PWD/.context/android-sdk"` と `android/local.properties` を設定して wrapper を実行します。Terraform が PATH にない場合は `.context/terraform/terraform` を使用してください。

## CI と main 保護

`.github/workflows/ci.yml` は format・ESLint・全層型検査・DB不要試験・実 PG17 統合試験・Chrome 操作・Python・本番 build・`npm audit --audit-level=high`・Docker build・両 Terraform root の fmt/validate・sandbox provider mock・gitleaks のソース検査を実行します。CI の DB 資格情報は使い捨てのローカル試験用です。AWS 資格情報は渡しません。Android は JVM/接続試験をローカルで実行し、emulator CI は今回の範囲外です。Dependabot は npm / Actions / Docker / Terraform / Gradle / pip を週次確認します。

このブランチのpushは、テストと修正で問題がないと判断した後に行う承認を受けています。PR作成・main保護設定は別途ユーザーの確認後にMacまたはGitHubで実施します。このVMからAWSへの配備は行いません。最初の PR で CI が全て成功したことを確認し、GitHub の Settings → Rules → Rulesets で `main` を対象に次を設定します。

1. pull request を必須にする。別のレビュー担当がいる場合は承認1件以上を必須にする。
2. status check を必須にし、実際の CI で表示された `Quality and unit`、`PostgreSQL and browser`、`Docker build`、`Terraform (infra)`、`Terraform (infra/sandbox)`、`Source secrets` を選ぶ。merge 前に最新 main との一致を必須にする。
3. force push と branch deletion を禁止し、会話の解決を必須にする。通常の変更で管理者 bypass を使わない。

CI の remote 成功・PR フロー・main 保護の完了は GitHub 側の確認結果を記録してください。ローカルの緑だけで D0-6 の外部条件を完了扱いにしません。整形コミットを blame から外す場合は `git config blame.ignoreRevsFile .git-blame-ignore-revs` を使用できます。

## 本番設定

`REGI_DEV_AUTH` を削除し、`NODE_ENV=production`、Cognito issuer/client、32バイト以上の `RECOVERY_SIGNING_SECRET`、アプリ専用 `DATABASE_URL`、S3、SQS、日本国内 Bedrock 推論プロファイルを設定してください。
`COGNITO_CLIENT_ID` は必須の Web client ID、`COGNITO_ANDROID_CLIENT_ID` は Android 専用 client ID です。API は同じ issuer の署名付き ID token に対し両方の audience を許可し、法人・担当者・MFA を検証します。Android の値が未設定または空なら Web のみを許可するため、既存 Web 配備から段階的に更新できます。sandbox は Web の refresh 1日を維持し、Android は `regipos://oauth` の public client / Authorization Code + PKCE / refresh 30日を追加します。Android 設定には `deployment.android_client_id` を使い、切替後は管理者が再ログインします。
Terraform の `recovery_signing_secret_arn` には別途作成した署名鍵 Secret の ARN を指定します。ECS が値を注入し、鍵そのものをソースや tfvars に保存しません。
`COGNITO_MFA_ENFORCED=true` は、Terraform のようにユーザープールの MFA が **ON** であることを運用者が検証した場合だけ使用します。JWT の署名・issuer・audience・ID token 種別・法人・staff subject は API が検証します。
本部の Hosted UI は `VITE_COGNITO_DOMAIN` / `VITE_COGNITO_CLIENT_ID` をビルド時に指定し、Authorization Code + PKCE を利用します。
Android の refresh 30日は初回ログインからの有効期間です。更新を続けても期限は延長されません。ローカルの時計を進める試験と期限切れ表示、Mac からの配備後の実時間同期は別々に記録します。30日経過後も無人同期できるとの判定は行いません。更新手順と外部検証は `docs/aws-sandbox.md` を参照してください。
回収トークンは端末・認証期間に限定した署名付き資格情報です。期限内イベントの回収にだけ利用でき、新しい認証・商品取得・管理者操作には使えません。署名鍵をローテーションする場合は既存回収資格情報の期限・未送信端末を先に確認します。
Bedrock 未接続・技術失敗は利用枠を戻し、販売・仕入・通常の集計は停止しません。

## レビューで強化した業務境界

- Android設定のCognitoログインでブラウザーPKCEを開始します。端末登録はオンライン管理者権限、PIN切替はその権限を縮小するだけです。レジ担当者がPINで管理者へ昇格することはできません。refresh tokenはAndroid Keystoreで暗号化し、ログアウトしても会計・未送信記録は保持します。
- Androidの登録済みRoom DBは別端末・別店舗へ付け替えません。会計・履歴を保持したまま別の店舗を登録する場合は新しい端末を使用します。同じ担当者の通信断・再接続ではPINによる権限縮小を保持し、アカウント変更時は古い担当者を解除します。
- 通常同期で商品bootstrapとは独立した認証leaseを更新します。進行中外部会計は開始時lease・金額を保持し、以前のleaseの期限内に成立したイベントも回収できます。オンライン接続があるだけで古いleaseを無期限延長せず、サーバーが更新を承認します。サーバー時刻と端末単調時計を併用し、端末再起動時に時刻基準を再確立します。
- 棚卸開始から確定までサーバーが店舗をロックします。開始後に届いた売上は原記録を隔離・保持します。実査で全隔離イベントを照合した理由を記録し、確定後に在庫減少が実査数へ既に含まれていたか個別承認して再検証します。含まれていた売上には別の照合台帳を追加し、二重に在庫を減らしません。
- 更新は販売者発行のEd25519署名付き情報が必要です。販売者の隔離環境で `npx tsx scripts/issue-renewal.ts <法人UUID> <契約参照> <署名期限ISO日時> <秘密鍵ファイル>` を実行し、顧客画面は署名情報だけを登録します。API/Terraformの `RENEWAL_PUBLIC_KEY` / `renewal_public_key` は公開鍵のみ。秘密鍵をAPI・リポジトリへ保存しません。
- AIの月5,000回は日本時間の暦月です。5分の処理所有権で異常終了を回復し、枠は一度だけ返却します。質問は許可済み構造化指標・期間・商品比較へ解決し、自由SQL/更新/PIN照会は拒否します。`DAILY_JOBS=true` と `WORKER_SCOPES`（法人/有効スタッフID）を設定したワーカーは日締め済みの日の予測・日報を生成します。Bedrock未接続の失敗は指数バックオフし、日報も利用枠に含めます。
- 本部の一式出力は取引CSV、保存スナップショットJSON、在庫JSON、確定帳票PDFを `tar.gz` にまとめます。S3/ワーカーの所有権と再実行を管理し、期限切れ処理も回復できます。契約終了後30日まで閲覧・出力可、90日後削除の手順は運用資料を参照してください。

運用・署名配布・復旧・登録資料は `docs/operations.md`、`docs/device-installation.md`、`docs/sales/` を参照してください。

## 個人AWS・合成データ

必要な時だけ起動する単一EC2、CloudFront標準HTTPS、Cognito認証、2時間自動停止の手順は `docs/aws-sandbox.md` を参照してください。将来用のMulti-AZ構成はD0で変更しません。D0はBudget10 USD（ACTUAL80%/FORECASTED100%の通知）で、旧私有tfvarsの30 USDはMacから明示変更が必要です。通知は課金上限ではなく、停止中も永続ディスク等の料金が残ります。条件付き約650円/月の見積は同資料を参照してください。毎時backupと配備・復元訓練は [配備runbook](docs/runbook/deploy.md)・[復元runbook](docs/runbook/restore.md) に従います。
`npm run db:seed:sandbox` は明示opt-in、専用法人UUIDの二重確認、実Cognito subject、非公開PINファイルを要求し、84日/2店舗/504売上の架空データを冪等投入します。開発シードの固定認証/PINをAWSで使いません。Webは `VITE_DEMO_HISTORY_END` のあるデモビルドだけ末尾7日を初期表示し、常時「実在の販売実績ではありません」と示します。通常ビルドは今日のままです。Bedrockは既定で無効、生成回答の代用品は作りません。
個人の合成sandboxだけ `require_mfa=false` でメール/パスワードのみを選べます。既定値はtrue、本番MFAは変更しません。明示したtenant UUIDと完了した合成シードをAPIの両管理者gateで確認し、mfa=falseを偽装せず、JWT/PKCE/法人/権限の検査を維持します。**旧版について2026-10-02に親担当からAWS適用・Cognito MFA OFF・API/host/Web検証合格の報告がありました。今回のD0ソースを配備した結果ではありません。本人の認証後ログイン操作は未検証**です。過去の入口は https://d3azs6ryeibszv.cloudfront.net 。現在の稼働状態は今回のVMから照会していません。履歴は [実装履歴](docs/history/2026-10-02.md)、現状は [サマリー](docs/implementation-status.md) を参照してください。既存環境のTerraform更新は先に同じEC2を起動してplanし、置換・削除を提案するplanは適用しません。実機・商用本番・Bedrock生成AIの完成を意味しません。
