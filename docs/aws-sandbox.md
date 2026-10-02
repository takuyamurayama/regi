# 個人AWS・必要な時だけ起動する検証環境

この環境は**架空データだけを扱う個人検証用**です。単一EC2のため、本番仕様のMulti-AZ、99.9%、RPO 5分/RTO 4時間、35日PITRを満たす構成ではありません。`infra/` の本番設定は変更せず、別の `infra/sandbox/` を使用します。実決済・顧客データ・実店舗運用には使用しないでください。

**最新の確認（2026-10-02 UTC）：親担当が個人用のパスワードのみ認証をAWSへ適用し、実Cognito MFA OFF、更新API/host/Web、権限・データ保持の受入検証に合格しました。** 同じEC2とデータディスクを保持し、最終Terraform planは変更なし。本人の認証後ログイン・画面操作は未検証です。Cognito利用者はCONFIRMEDで、今回パスワードの再設定や招待は行っていません。実装担当はAWS/Macを操作せず、資格情報も受け取っていません。

**ユーザーの明示希望により、引継ぎ時は稼働を継続します。停止済みではありません。** 2時間自動停止は有効で、親担当が引継ぎ時にタイマーを再設定する運用です。入口は https://d3azs6ryeibszv.cloudfront.net 。過去の02:50 UTC停止記録は旧配備の履歴で、今回の最終状態ではありません。実検証の詳細と証拠は `docs/implementation-status.md` の末尾を参照してください。

## 構成と費用

- 東京の `t3a.small`、CPUクレジットstandard、暗号化gp3のOS 8GB + 永続データ32GB。API、ワーカー、PostgreSQL 17はDockerで稼働。DBは非所有者・NOSUPERUSER・NOBYPASSRLSの `regi_app` でアクセスします。
- CloudFront標準ドメインのHTTPS、Webは非公開S3/OAC、APIはVPC originでEC2の**プライベートDNS**へ接続。EC2 ingressはCloudFrontのサービス管理SGから3000だけ。SSH・DB・公開IPへのAPIアクセスは許可しません。公開IPv4は外向き通信専用で、Elastic IPは使用しません。
- CognitoのHosted UI、Authorization Code + PKCE、メール/パスワード。管理者MFA/TOTPは既定で必須。明示指定した架空データの個人sandboxだけMFAなしを選べます。顧客が変更できる属性に法人IDを含めません。開発ヘッダー認証・固定パスワード・公開デモログインは使用しません。
- 最初のuser-data処理で**2時間後の自動停止タイマー**を有効化。`shutdown` はterminateではなくstop。正常起動前に失敗しても停止タイマーは残ります。起動操作を繰り返すと、その時点から2時間へ延長します。
- USD30の通知は**AWSアカウント全体の予算アラートで、課金の上限ではありません**。停止中もEBS、S3、Secrets Managerなどの保管費用は残ります。稼働時間、通信、ログ、AI、税により総額は変わります。常時稼働を前提としません。

CloudFront VPC originにはIGWと利用可能なIPv4が必要です。東京の物理AZ `apne1-az3` は対象外なので、AZ名ではなくzone IDで除外します。公開HTTP originへのフォールバックは設けません。[AWS公式のVPC origin制約](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)

## 事前準備・アカウント確認

AWS操作は、承認済みプロフィールを持つMac側だけで行います。資格情報ファイルを読んだり、クラウド開発VMへ転送したりしません。Node 22以上でWebをビルドできる別環境と、Terraform 1.10以上、AWS CLI v2、Python 3、Docker amd64ビルド環境が必要です。MacのDockerが使えなければ、開発VMでイメージを作り、Mac発行の短時間・単一キー用presigned PUTでアップロードできます。URLも資格情報相当なのでログへ出さず、期限後に破棄します。

1. Macで `aws --profile <承認済みprofile> --region ap-northeast-1 sts get-caller-identity` のAccountを確認します。`expected_account_id` と異なる場合は停止します。
2. 別管理のbootstrap S3バケットを用意します。非公開、Block Public Access、暗号化、バージョン管理、TLS必須。Terraform stateとreleaseを分け、EC2には `releases/*` の読み取りだけを許可し、`state/*` は明示拒否します。スタックは既存バケットを作成・削除しません。
3. `.private/` に0600の `sandbox.tfvars` と `sandbox.backend.hcl` を保存します。`infra/sandbox/sandbox.tfvars.example` をコピーし、アカウント・通知メール・既存バケットを確認済みの値へ変更。初回は `image_sha256=""`、demo無効、Bedrock無効のままにします。

backend設定例（秘密の資格情報は入れない）:

```hcl
bucket       = "<既存の非公開bootstrapバケット>"
key          = "state/regi-sandbox.tfstate"
region       = "ap-northeast-1"
use_lockfile = true
encrypt      = true
```

Macの承認済みprofileを指定し、planを**私有ファイル**へ保存します。state/plan/実tfvars/backendはソース配布へ含めません。プランが検証環境外の資源を変更しないことを確認してから、承認したplanだけをapplyします。

**既存stackの更新は、先にMac launcherで既存EC2を起動してからplanします。** 停止中はproviderが公開IPの関連付けをfalseと読む場合があり、`associate_public_ip_address=false→true` を理由にhost置換を提案することがあります。その破壊的planをapplyしないでください。既存instanceを起動・正常性確認後にplanを作り直し、意図しないcreate/destroyがないことを確認します。今回の親検証では起動後の更新planは0 add/3 update/0 destroy、適用後の最終planはexit 0・変更なしでした。instance/dataの破棄や保護解除で回避しません。通常は作業後にlauncherで正常停止しますが、今回はユーザーが試用のため稼働継続を明示したので、2時間自動停止を有効にしたまま引き継ぎます。

```bash
umask 077
export AWS_PROFILE=<承認済みprofile>
terraform -chdir=infra/sandbox init -backend-config=/absolute/path/.private/sandbox.backend.hcl
terraform -chdir=infra/sandbox validate
terraform -chdir=infra/sandbox plan -var-file=/absolute/path/.private/sandbox.tfvars -out=/absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox apply /absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox output -json deployment > /absolute/path/.private/deployment.json
```

初回CloudFront作成には時間がかかります。EC2にはまだ検証済みイメージもDBの初期化承認もなく、アプリは実行されません。これは安全な待機状態です。user-dataの変更は既存インスタンスで自動再実行されないため、レビューした修正版を非公開S3経由・SSMで再実行してください。設定の再applyだけで修復済みと判断しないでください。

## データディスクの一回限り初期化承認

「blkidが失敗した」だけでformatしません。EBSの未使用領域が全てゼロとも仮定しません。初回の作成後、**Macの運営者**がAWSのDescribeVolumesで次を確認してください。

- deploymentの `persistent_volume` と完全一致。作成時刻が今回のapplyで、SnapshotIdが空、32GB・暗号化・対象スタックのタグ付き。
- Attachmentsはこのdeploymentのinstanceと `/dev/sdf` だけ。他用途の既存volumeやsnapshot由来なら、承認せず調査します。
- SSMの `lsblk` / `wipefs --no-act --json` で正しいNVMe serialのディスクを確認。OSの8GBディスクではなく、ファイルシステム・署名・パーティション・マウントがないこと。

確認後だけ、SSMのrootシェルで `/opt/regi/initialize-data-volume.approval` を**0600・root所有**で作り、確認したvolume ID一行を記入します。修正版user-dataを再実行すると、完全一致・署名なし・パーティションなし・未マウントを再検査し、承認ファイルを消費してからext4を作ります。途中で失敗したら再調査が必要です。EC2 IAMへDescribe権限を追加する必要はありません。既存ext4は初期化せず保持し、別のファイルシステムは拒否します。

32GBディスクがmountされなければDockerを起動しません。Docker layers、PostgreSQL、私有設定は全てこの永続ディスクへ配置します。8GBのOSへDBや544MBのイメージを展開する構成ではありません。

## イメージとDBのbootstrap

開発VMなどDockerの動く環境で、追跡外の秘密ファイルを除外してビルドします。MacのNode 16やDocker停止状態に依存しません。

```bash
docker build --platform linux/amd64 -t regi:sandbox .
docker save regi:sandbox | gzip > /private/path/regi-app.tar.gz
sha256sum /private/path/regi-app.tar.gz
```

Macから確認済みbootstrapバケットの `releases/<sandbox名>/app-<版>.tar.gz` へアップロードし、そのキーとSHA-256を私有tfvarsへ設定します。S3上のアーカイブが正しいことを確認してからapplyし、SSMで `regi.service` を再起動します。ハッシュ不一致ではdocker load・アプリ実行をしません。SHA計算は4MBずつのストリーム処理で、2GBメモリへ全アーカイブを読みません。

hostは初回だけ安全な乱数でowner/appパスワード・回収署名鍵・担当者PINを作成し、専用Secrets Managerへ保存します。Terraformには値を渡さず、state/planにも保存しません。DB作成→`sandbox-db-role.ts` によるSCRAM role作成→全SQL migration→必要ならdemo seed→Python予測→API/workerの順に実行します。ownerの接続情報と私有PINファイルはmaintenanceコンテナーだけに渡します。API/workerは `maintenance.env` と私有ディレクトリを受け取りません。

hostはSTSで専用workload roleの短期資格情報を取得して15分ごとに更新します。アプリの `credential_process` はExpiration付きファイルを読み、Secrets Manager全操作は明示拒否。コンテナーからIMDSへの通信も拒否します。ホストIAMとアプリIAMは別です。Docker socketやhostのAWS credentialsをアプリへmountしません。

PrismaとPythonが共有する `DATABASE_URL` に `connection_limit` などPrisma専用クエリは付けません。PostgreSQL/psycopgでも解釈可能なURIを使用します。bootstrapのログは固定の段階名・例外クラス・終了コードだけを記録し、例外本文や子プロセスstderrの資格情報は出力しません。`/opt/regi/bootstrap-stage.json` で最新段階を確認できます。

## Cognito管理者と合成データ

管理者はCognitoで本人メールを使って作成し、`custom:tenant_id` を**デモ専用の新しいUUID**へ設定します。初回パスワードはCognitoの安全な経路で本人へ渡し、リポジトリ・SSMログ・チャットに記録しません。初回パスワード変更は必須です。既定の `require_mfa=true` ではTOTP登録も行います。`require_mfa=false` を適用した個人sandboxだけTOTPは不要です。法人属性はimmutableで、アプリクライアントから更新できません。

### 個人sandboxだけMFAなしにする設定

`require_mfa` の既定値は **true** で、本番 `infra/` のMFA ON設定は変更しません。個人sandboxの私有tfvarsで `demo.enabled=true` と対象tenant/subを確認した上で、**明示的に** `require_mfa=false` にします。demo無効のままfalseを指定するplanは拒否します。

この設定はCognitoを **OFF** にします。OPTIONALは既にMFAを登録した利用者へ追加認証を要求し得るため使用しません。[AWSのMFA設定仕様](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html)

OFFでは `software_token_mfa_configuration` を**ブロックごと省略**します。`enabled=false` を含むブロックでも、ONからOFFへ移行する実APIはMFA設定の同時指定として拒否しました。使用するprovider v6.67.0は空listをnilへ変換し、依存SDK v1.74.0はnilのフィールドを送信しません。ONの既定だけTOTP enabled=trueのブロックを生成します。[providerの変換処理](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/cognitoidp/user_pool.go)、[SDKの送信処理](https://github.com/aws/aws-sdk-go-v2/blob/service/cognitoidentityprovider/v1.74.0/service/cognitoidentityprovider/api_op_SetUserPoolMfaConfig.go)

runtime/outputのrequireMfaは同じ値にし、hostは次だけをアプリへ設定します:

- `COGNITO_MFA_ENFORCED=false`。MFA済みと偽って扱わない。
- `REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID=<対象デモ法人UUID>`。サーバー運用者のopt-inであり、ブラウザー入力/HTTPヘッダーでは切り替えられない。

Authの管理者ログインとAdministrationの管理操作は同じ判定を使用します。MFAなしを許可するのは、このUUIDと一致し、RLSで取得した `demo-seed` がcompletedかつ `synthetic=true` / `version=regi-synthetic-v1` の法人管理者だけです。別法人・実法人・未完了シード・非管理者は許可しません。`actor.mfa=false` はそのまま保持します。JWT署名/issuer/audience/期限/ID token/法人/staff/PINによる権限縮小、PKCE/state/refreshの検査は無効化しません。

**更新手順と今回の適用結果:** 更新APIイメージとSHA、修正版host/bootstrap.py、Cognito対応Webを準備した後、Macの承認済み環境でCognito OFF/runtimeの変更planを確認して適用します。旧APIはMFAなしの管理者を拒否するため、Cognitoだけ先にOFFにして完了扱いにしないでください。hostはアプリ/workerのMFA値もfalseで起動し、既存デモ履歴を再投入しません。今回は親担当がこれらを実適用し、runtime.requireMfa=false、更新API image、bootstrapのstage ready、Web配布とCloudFront invalidation完了を確認しました。合成法人管理者のmfa=falseで共有判定が通り、非管理者/別法人/不正token/dev headersは拒否されました。本人のHosted UIログイン・管理画面操作は別途必要です。初回パスワード変更はCognitoが要求する場合に本人が行いますが、今回の利用者はCONFIRMEDで再設定・再招待はしていません。実装担当は追加のAWS接続/資格情報を取得して自動実行しません。

AdminGetUserの**実際の `sub`** をdemoのadministrator_subjectに使用します。Cognito subはGUIDの形でもRFC UUIDのversion/variantを満たさない場合があるため、外部subjectは16進の8-4-4-4-12形式で検証します。法人IDは引き続きUUID検証を行います。

私有tfvarsのdemoを明示的に有効化します。`end_day` は今日より前の日本時間営業日で、データを作り直すたびに勝手に変更しません。

```hcl
demo = {
  enabled               = true
  tenant_id             = "<確認済みのデモ専用UUID>"
  administrator_subject = "<この法人管理者の実Cognito sub>"
  end_day               = "<今日より前のYYYY-MM-DD>"
}
```

既存の実法人への投入、他法人のstaff subjectの取り込み、異なる設定での上書きは拒否します。再送・中断後再実行・並列実行は冪等です。業務トランザクション・RLS・immutable triggerを無効化しません。担当者PINは非公開ファイル/Secrets Manager内だけに保存し、シード結果には出力しません。
hostは成功後に永続ディスクの非公開 `demo-seed-completed.json` を保存し、通常の再起動では合成履歴を再投入しません。利用者がデモ発注・返品・PIN等を変更しても、過去の投入処理で起動を妨げません。中断時は完了記録がないため冪等再開します。完了後にtenant/subject/end_dayを変更した設定は自動置換せず拒否します。復元や完了記録破損時は、DBと記録の整合を運営者が確認してから再開してください。

独立したCLI起動が必要なときだけ、アプリ用DB URLと以下を明示します（通常はhostが設定します）:

```bash
export REGI_SANDBOX_SEED=synthetic-only
export REGI_SANDBOX_TENANT_ID=<新しいデモ法人UUID>
export REGI_SANDBOX_CONFIRM_TENANT=<同じUUID>
export REGI_SANDBOX_ADMIN_SUBJECT=<実Cognito-sub>
export REGI_SANDBOX_ADMIN_PIN_FILE=<0600の非公開PINファイル>
export REGI_SANDBOX_END_DAY=<今日より前の営業日>
npm run db:seed:sandbox
```

投入内容は84営業日、2店舗、8商品（サービス1）、価格履歴16、仕入先2、売上504、日締め168、端末締め168、受信イベント840、発注6（下書き2/分納2/完了2）、入荷4、確定返品2、確認待ち返品2です。在庫台帳・標準原価・税率・個数返金額を業務処理で保存します。会社名・店名・商品名・帳票はデモ表示、決済参照は合成と明記。実決済の成功や実店舗の導入実績を意味しません。

各店舗に**実Python/LightGBM処理**を実行し、完了日だけのデータから7日×7在庫商品×2店舗＝98予測行を保存します。時系列検証で曜日平均を上回らなければ基準在庫方式と表示します。未接続Bedrockの文章を捏造しません。生成AIは既定で無効。利用条件・モデルアクセス・EULAなどを本人が別途確認するまでは、有効化/申請しません。

## Web配布と初回表示

deployment.jsonの `cognito_domain` / `client_id` で別途Webをビルドします。これらは公開クライアント設定で、AWSキーではありません。デモ用の履歴末日も指定すると、Cognito callbackがrootへ戻っても最後の7日が初期表示になります。日付は過去のまま表示し、今日の売上を偽装しません。通常製品は `VITE_DEMO_HISTORY_END` を設定せず、今日を初期表示します。

```bash
VITE_COGNITO_DOMAIN=<deploymentのcognito_domain> \
VITE_COGNITO_CLIENT_ID=<deploymentのclient_id> \
VITE_DEMO_HISTORY_END=<demoのend_day> \
NODE_ENV=production npm run build -w @regi/web
```

ビルド済み `apps/web/dist/` だけをMacへ転送し、deploymentのWebバケットへ非公開のままuploadします。index.htmlは `no-cache`、hash付きassetsはimmutableで長期cacheにします。変更後はCloudFront invalidationを行い、古いログイン設定が残っていないことを確認します。API Dockerイメージの再作成は不要です。ブラウザーへdev headers、AWSキー、デモPIN、owner URLを埋め込みません。

合成データの期間と「実在の販売実績ではありません」を常時表示します。「デモ期間を表示」で84日全体を選べます。期間を今日へ変えると実際に今日成立した取引だけになり、過去売上を今日へ移しません。返品日は別集計なので今日の返品があれば純売上がマイナスになる場合があります。

## 検証・起動・停止

公開する前にMac/ブラウザーで以下を実測します。plan/validateとmock testだけでAWS疎通成功と判断しません。

1. HTTPSで `/health` は200、未認証の `/v1/settings` は401。開発ヘッダーを送っても通らない。
2. Cognitoで本人ログイン、初回パスワード変更（MFA必須設定ならTOTPも）、正しいデモ法人・2店舗を取得。今日とデモ期間の数字を切り替え、API集計と一致すること。パスワードのみ設定では管理者actorがmfa=falseのままで、管理操作ができること。
3. 2明細以上の発注・分納・返品と再送で二重計上なし。需要予測98行と方式/更新日時、実S3帳票出力を確認。実店舗の決済は行わない。
4. EC2の公開IP:3000/22/5432へ接続できない。S3直接公開不可、owner roleとworkloadの権限境界、停止タイマーactiveを確認。
5. stop→startで履歴・件数が保持され、再seedで増えない。CloudFront URLは変わらず、起動時に2時間タイマーが有効になる。

`docs/sandbox-control.json.example` を `$HOME/regi-sandbox/.private/control.json` にコピーし、deployment.jsonのaccount/region/instance/web_urlと、承認済み `aws_profile` を記入します。0600にし、資格情報は入れません。全コマンドはSTSでアカウント一致を確認してから操作します。

```bash
bash scripts/sandbox-control.sh status
bash scripts/sandbox-control.sh start
bash scripts/sandbox-control.sh stop
```

Macでは `scripts/sandbox-start.command` / `sandbox-stop.command` / `sandbox-status.command` をダブルクリックできます。startはEC2正常性チェック後、SSMのOnline表示だけでなく実コマンド成功を確認してタイマーを再設定し、サービス起動とHTTPS画面を開きます。stopはSSMでコンテナーを正常停止してからEC2をstopし、既にstoppingの場合もstoppedまで待ちます。状態を再確認できなければ停止完了と表示しません。SSMが利用できなくてもforce stopはせず、警告の上で通常stopを要求します。再起動後の完全なアプリ準備には数分かかる場合があります。HTMLの502/503/504は起動待ち・再読み込みの案内を表示し、一般的なネットワーク失敗をサーバー停止と断定しません。

## 保管・復旧・撤去

停止は削除ではありません。単一ディスク故障や誤削除に対する自動バックアップはこの安価構成では設定しません。必要なら本人の追加費用承認の上、停止/DB整合を確認したEBS snapshotや暗号化したpg_dumpを私有領域へ保管し、別環境で復元を試験します。本番のRPO/RTO達成とは区別します。

data volumeはTerraformの `prevent_destroy` で保護しています。削除時はデータを必要な形式で取り出し、本人の明示承認・snapshot要否・料金を確認した上で保護解除してplanを再レビューします。CloudFront/VPC origin、EC2、S3のversion、秘密情報、SQS、予算通知を含め残資源を確認してください。別管理のbootstrapバケットとstateは `terraform destroy` では消えません。stateやreleaseの残留も別途確認します。承認なしに自動cleanupやディスク消去を行いません。

## ローカルで再実行した試験

`README.md` のローカルDB/Python環境を先に準備してください。シード試験はローカル管理接続で独立した一時DBを作成し、アプリ用role・全migration・実RLSで検査して最後に一時DBを削除します。本番URLを拒否します。AWS操作コマンドの試験はstub、Terraform試験はprovider mockで、実配備の代わりではありません。

```bash
set -a; source .env; set +a
export MAINTENANCE_TEST_DATABASE_URL="$MIGRATION_DATABASE_URL"
NODE_ENV=test npx tsx --test --test-concurrency=1 tests/sandbox.test.ts tests/sandbox-tooling.test.ts tests/report-period.test.ts
NODE_ENV=test npm test
python3 -m unittest discover -s tests -p '*_test.py' -v
NODE_ENV=production npm run build
npm run test:web
terraform -chdir=infra/sandbox init -backend=false
terraform -chdir=infra/sandbox fmt -check -recursive
terraform -chdir=infra/sandbox validate
terraform -chdir=infra/sandbox test
```
