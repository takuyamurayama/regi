# 個人AWS・必要な時だけ起動する検証環境

この環境は**架空データだけを扱う個人検証用**です。単一EC2のため、本番仕様のMulti-AZ、99.9%、RPO 5分/RTO 4時間、35日PITRを満たす構成ではありません。`infra/` の本番設定は変更せず、別の `infra/sandbox/` を使用します。実決済・顧客データ・実店舗運用には使用しないでください。

**D0変更のAWS受入は未実施です。** このVMにはAWS資格情報がなく、Android client、バックアップ／大阪複製、Cognito削除保護、Budget10 USDの実apply・S3到達・復元訓練はMacの運営者が実施します。ローカル試験と実AWS受入を [現状サマリー](implementation-status.md) と [配備手順](runbook/deploy.md) で区別してください。

D0着手前の配備記録（2026-10-02 UTC）では、親担当が個人用のパスワードのみ認証を適用し、Cognito MFA OFF、更新API/host/Web、権限・データ保持を確認しています。当時は同じEC2とデータディスクを保持し、ユーザー希望により2時間自動停止を有効にしたまま稼働継続で引き継ぎました。本人のHosted UIログイン・画面操作は未検証です。入口は https://d3azs6ryeibszv.cloudfront.net 。これは過去配備の記録で、現在の稼働状態やD0配備済みを意味しません。Mac launcherで状態を確認してください。

## 構成と費用

- 東京の `t3a.small`、CPUクレジットstandard、暗号化gp3のOS 8GB + 永続データ32GB。API、ワーカー、PostgreSQL 17はDockerで稼働。DBは非所有者・NOSUPERUSER・NOBYPASSRLSの `regi_app` でアクセスします。
- CloudFront標準ドメインのHTTPS、Webは非公開S3/OAC、APIはVPC originでEC2の**プライベートDNS**へ接続。EC2 ingressはCloudFrontのサービス管理SGから3000だけ。SSH・DB・公開IPへのAPIアクセスは許可しません。公開IPv4は外向き通信専用で、Elastic IPは使用しません。
- CognitoのHosted UI、Authorization Code + PKCE、メール/パスワード。管理者MFA/TOTPは既定で必須。明示指定した架空データの個人sandboxだけMFAなしを選べます。顧客が変更できる属性に法人IDを含めません。開発ヘッダー認証・固定パスワード・公開デモログインは使用しません。
- 最初のuser-data処理で**2時間後の自動停止タイマー**を有効化。`shutdown` はterminateではなくstop。正常起動前に失敗しても停止タイマーは残ります。起動操作を繰り返すと、その時点から2時間へ延長します。
- 稼働中の毎時・起動直後・停止直前にPostgreSQLのdumpと同一snapshotのmanifestを東京の専用S3へ保存し、大阪へ非同期複製します。両バケットは非公開・SSE-S3・versioning・TLS必須。current35日＋noncurrent35日の独立ライフサイクルで、未完multipartを1日後に回収します。停止中は最後の成功backupが復元点です。
- Terraformでは永続ディスク・両backupバケット・Cognito poolを `prevent_destroy` で保護し、poolの `deletion_protection="ACTIVE"` を設定します。pool／bucketの通常更新で保護を解除しません。
- Budgetは既定**10 USD、ACTUAL80%／FORECASTED100%のAWSアカウント全体の通知**で、課金上限や自動停止ではありません。停止中も保管費用が残り、稼働時間、通信、ログ、AI、為替、税により総額が変わります。旧私有tfvarsの `monthly_budget_usd=30` はMacで `10` に変更してからapplyしてください。

CloudFront VPC originにはIGWと利用可能なIPv4が必要です。東京の物理AZ `apne1-az3` は対象外なので、AZ名ではなくzone IDで除外します。公開HTTP originへのフォールバックは設けません。[AWS公式のVPC origin制約](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)

### 費用の条件（2026-10-02確認、税別、1 USD＝150円の例）

| 対象                                 | 公式単価と仮定                                      | 概算             |
| ------------------------------------ | --------------------------------------------------- | ---------------- |
| 東京gp3 40GiB（OS8＋data32）         | 0.096 USD/GiB-month                                 | 576円/月         |
| Secrets Manager 1 secret             | 0.40 USD/secret-month、APIは別                      | 60円/月          |
| 東京／大阪S3 Standard                | 各0.025 USD/GiB-month、両地域の全versions合計を計上 | 保管量による     |
| 東京→大阪の通常複製転送              | 0.09 USD/GiB                                        | 新規複製量による |
| 両地域S3 Tier1 requests              | 各0.0047 USD/1,000回、multipart追加回数を含む       | request数による  |
| 起動中のt3a.small Linux＋public IPv4 | 0.0245＋0.005 USD/h                                 | 約4.425円/h      |

固定の停止中保管基礎は **636円/月**。全S3保管量を `S` GiB-month、当月の大阪向け複製量を `D` GiB、両地域のTier1 request合計を `N` とすると、追加概算は `150×(0.025×S＋0.09×D＋0.0047×N/1000)` 円です。web/artifacts/bootstrap/state、dump/manifestのcurrent／noncurrent版を全て含め、GET、その他API、通信、無料枠超過は別に確認します。

例えば `S=1、D=1、N=400` なら約653.53円/月で、**停止中約650円は少量backup・上記為替の条件付き概算**です。実測請求額や上限を示しません。単純に10%税を加える例では約719円。停止でcompute課金は止まりますがEBSは残り、自動割当public IPv4は解放されます。Elastic IPは保持しません。[AWS stop/start仕様](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html)、[VPC料金](https://aws.amazon.com/vpc/pricing/)。

35＋35日の設定では固有hour keyも約70日残り得ます。毎時100MiBの圧縮dumpを70日保管した例では両地域合計約328GiBとなり、S3 storageだけ約1,230円/月、複製転送料等はさらに加算されます。起動・停止時の上書き版、manifest、他bucketも計上します。Budget通知を受けたらMacから両地域の保持量・複製量・account全体の請求を確認します。

地域単価は公式Price Listの [東京EC2/EBS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-northeast-1/index.csv)、[東京S3](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-northeast-1/index.csv)、[大阪S3](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-northeast-3/index.csv)、[東京Data Transfer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-northeast-1/index.csv)で確認しました。料金区分・税の扱いは [EBS](https://aws.amazon.com/ebs/pricing/)、[S3](https://aws.amazon.com/s3/pricing/)、[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) の公式料金を参照してください。

## 事前準備・アカウント確認

AWS操作は、承認済みプロフィールを持つMac側だけで行います。資格情報ファイルを読んだり、クラウド開発VMへ転送したりしません。Node 22以上でWebをビルドできる別環境と、Terraform 1.10以上、AWS CLI v2、Python 3、Docker amd64ビルド環境が必要です。MacのDockerが使えなければ、開発VMでローカルbuild／検証したarchiveをMacへ移し、S3へのuploadはMacだけから実施します。VMへAWS資格情報やpresigned URLを渡しません。

1. Macで `aws --profile <承認済みprofile> --region ap-northeast-1 sts get-caller-identity` のAccountを確認します。`expected_account_id` と異なる場合は停止します。
2. 別管理のbootstrap S3バケットを用意します。非公開、Block Public Access、暗号化、バージョン管理、TLS必須。Terraform stateとreleaseを分け、EC2には `releases/*` の読み取りだけを許可し、`state/*` は明示拒否します。スタックは既存バケットを作成・削除しません。
3. `.private/` に0600の `sandbox.tfvars` と `sandbox.backend.hcl` を保存します。`infra/sandbox/sandbox.tfvars.example` をコピーし、アカウント・通知メール・既存バケットを確認済みの値へ変更。既存の `monthly_budget_usd=30` 指定は `10` に直します。初回は `image_sha256=""`、demo無効、Bedrock無効のままにします。大阪providerも同じ `expected_account_id` に制限されます。

backend設定例（秘密の資格情報は入れない）:

```hcl
bucket       = "<既存の非公開bootstrapバケット>"
key          = "state/regi-sandbox.tfstate"
region       = "ap-northeast-1"
use_lockfile = true
encrypt      = true
```

Macの承認済みprofileを指定し、planを**私有ファイル**へ保存します。state/plan/実tfvars/backendはソース配布へ含めません。プランが検証環境外の資源を変更しないことを確認してから、承認したplanだけをapplyします。

**既存stackの更新は、先にMac launcherで既存EC2を起動してからplanします。** 停止中はproviderが公開IPの関連付けをfalseと読む場合があり、`associate_public_ip_address=false→true` を理由にhost置換を提案することがあります。その破壊的planをapplyしないでください。既存instanceを起動・正常性確認後にplanを作り直し、意図しないcreate/destroyがないことを確認します。D0着手前の旧配備では、起動後の更新planが0 add/3 update/0 destroy、適用後に変更なしだった記録があります。今回のD0 planはMacで未取得です。instance/dataの破棄や保護解除で回避せず、作業後の起動／停止状態と2時間タイマーを受入表へ記録します。

```bash
umask 077
export AWS_PROFILE=<承認済みprofile>
terraform -chdir=infra/sandbox init -backend-config=/absolute/path/.private/sandbox.backend.hcl
terraform -chdir=infra/sandbox validate
terraform -chdir=infra/sandbox plan -var-file=/absolute/path/.private/sandbox.tfvars -out=/absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox apply /absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox output -json deployment > /absolute/path/.private/deployment.json
```

初回CloudFront作成には時間がかかります。EC2にはまだ検証済みイメージもDBの初期化承認もなく、アプリは実行されません。これは安全な待機状態です。既存EC2は `user_data_replace_on_change=false` のためapplyだけでhostが更新されません。[配備手順](runbook/deploy.md)に従い、Macで既知SHAとruntimeを照合したinstaller2ファイルから `install-host.sh --refresh` を実行し、限定したhostファイル・unitsを更新して `systemctl restart regi` します。通常更新でuser-data全体やディスク初期化を再実行しません。

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
shasum -a 256 /private/path/regi-app.tar.gz
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

**旧配備の適用結果（D0着手前）:** 更新APIイメージとSHA、修正版host/bootstrap.py、Cognito対応Webを準備した後、Macの承認済み環境でCognito OFF/runtimeの変更planを確認して適用した記録があります。旧APIはMFAなしの管理者を拒否するため、Cognitoだけ先にOFFにして完了扱いにしないでください。hostはアプリ/workerのMFA値もfalseで起動し、既存デモ履歴を再投入しません。この旧配備で親担当はruntime.requireMfa=false、更新API image、bootstrapのstage ready、Web配布とCloudFront invalidation完了を確認しました。合成法人管理者のmfa=falseで共有判定が通り、非管理者/別法人/不正token/dev headersは拒否されています。本人のHosted UIログイン・管理画面操作は別途必要です。初回パスワード変更はCognitoが要求する場合に本人が行いますが、旧配備の利用者はCONFIRMEDで再設定・再招待はしていません。これはD0変更の配備済みを意味せず、実装担当は追加のAWS接続/資格情報を取得して自動実行しません。

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

## Android 専用 Cognito client（D0 C82）

`infra/sandbox/` は既存の Web client（refresh 1日）を保持し、同じ user pool に Android client を追加します。Android は client secret なし、Authorization Code + PKCE、`openid` / `profile`、callback `regipos://oauth`、ID/access token 1時間、refresh token 30日です。法人属性を更新する権限は付与しません。カスタム URI callback は [Cognito の app client 仕様](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html)に対応します。

deployment の `client_id` は Web、`android_client_id` は Android です。SSM runtime の `clientId` / `androidClientId` を host がそれぞれ `COGNITO_CLIENT_ID` / `COGNITO_ANDROID_CLIENT_ID` として API/worker の私有環境ファイルへ渡します。API は Web client を必須とし、Android の設定が未追加・空の旧 runtime では Web audience のみを許可します。設定を追加しても JWT の署名・issuer・期限・ID token 種別・法人・担当者・MFA の検査を維持します。

この変更は VM で fmt/validate/provider mock と署名付き JWT/実 PG 試験まで検証します。以下の更新は AWS 資格情報のある **Mac の運営者**が実施し、結果を記録してください。

1. [配備手順](runbook/deploy.md)で更新イメージ／SHA、私有tfvars、Android client・backup・Budgetを含むplanをレビューしapplyします。既存 user pool/Web client/EC2/永続ディスクの置換・削除を提案するplanは適用しません。
2. deploymentを更新し、既存hostにinstallerが無ければ `install-host.sh` と `install_host.py` の両方を既知SHAで確認して配置します。runtimeの `bootstrapSha256` は13ファイルの限定集合です。`install-host.sh --refresh` による全ファイル検証・units更新後、SSMで `systemctl restart regi` します。裸のbootstrap.pyだけのcopyで完了扱いにしません。
3. `bootstrap-stage.json` の `ready`、HTTPS `/health`、既存Webログインを確認します。Android設定へdeploymentの `cognito_domain` と **`android_client_id`** を入力し、管理者がPKCEで再ログインします。旧Web clientのrefresh tokenをAndroid clientへ流用せず、会計・未送信記録を保持します。
4. Android audienceのAPI同期・lease更新と、別audience／不正署名の拒否を確認します。日時・client種別・成功/失敗・pending/review件数を記録し、JWT/refresh token/PINを含めません。

refresh token は **初回ログインから30日で失効**し、更新や rotation でも初回の期限は延長されません。[AWS の refresh token 仕様](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)に従い、30日の有効期間内の無人更新と、期限切れ `invalid_grant` で tokens を破棄し「管理者の再ログインが必要」を常時表示することを別々に検証します。D0-4 の「30日以上」を30日経過後も継続できる保証として完了扱いにはしません。

ローカルの時計を進める試験の成功は実 Cognito の30日受入試験を代替しません。Mac から配備後、sandbox の2時間自動停止を維持した起動時間内で1週間の実時間同期を開始し、ログイン時刻・各日の同期/lease 更新・pending/review・再ログイン要求の有無を記録します。実 AWS の結果と30日境界の扱いは D0 判定時の未完外部条件として記録してください。初回ログインからの期間、運用停止時間、通信断による同期遅延を区別します。

## Web配布と初回表示

deployment.jsonの `cognito_domain` / `client_id` で別途Webをビルドします。これらは公開クライアント設定で、AWSキーではありません。デモ用の履歴末日も指定すると、Cognito callbackがrootへ戻っても最後の7日が初期表示になります。日付は過去のまま表示し、今日の売上を偽装しません。通常製品は `VITE_DEMO_HISTORY_END` を設定せず、今日を初期表示します。

```bash
VITE_COGNITO_DOMAIN=<deploymentのcognito_domain> \
VITE_COGNITO_CLIENT_ID=<deploymentのclient_id> \
VITE_DEMO_HISTORY_END=<demoのend_day> \
NODE_ENV=production npm run build -w @regi/web
```

ビルド済み `apps/web/dist/` だけをMacへ転送し、deploymentのWebバケットへ非公開のままuploadします。index.htmlは `no-cache`、hash付きassetsはimmutableで長期cacheにします。変更後はCloudFront invalidationを行い、古いログイン設定が残っていないことを確認します。API Dockerイメージの再作成は不要です。ブラウザーへdev headers、AWSキー、デモPIN、owner URLを埋め込みません。

Webの正規URLは `/dashboard`、`/products`、`/purchases/orders`、`/inventory`、`/sales`、`/shifts`、`/ai`、`/sync`、`/settings` と、仕入管理の `/purchases/invoices`・`/purchases/invoices/<UUID>`・`/purchases/payables`・`/purchases/returns`・`/purchases/suppliers` です。店舗・期間はquery、請求の原記録IDはpathへ保存します。従来の `/?page=発注・入荷&storeId=...` はWebが同じ店舗・期間の正規URLへ置換します。

`infra/sandbox/web-route-rewrite.js` の CloudFront Function は **default Web behavior の viewer-request だけ**に関連付け、既知のWeb pathのGET/HEADを `/index.html` へ書き換えます。queryや認証情報には触れず、`/v1/*`・`/health` のAPI behavior、assets、未知pathと他methodは変更しません。URI変更は元のbehavior／originを変えない仕様なので、APIには関数を付けず、distribution全体のcustom error responseも設定しません。APIの403/413/500をHTML200へ変換しないことをmockで検査します。[AWSのevent仕様](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html)、[viewer-request rewriteの公式例](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_url_rewrite_single_page_apps_section.html)

Macの運営者はWeb配布と同じ変更でTerraform planを確認し、このFunctionの作成とdefault behavior関連付けをapplyしてください。適用・invalidation後に、正規URLの直接起動と再読み込み、ブラウザーの戻る/進む、旧 `?page=` URL、請求IDのdeep linkを確認します。APIの未認証403等とassetsは元の応答を保つことも確認し、結果を記録します。VMでは実Functionソースのunit試験とprovider mockまで検証し、AWSへの適用・CloudFront配信確認は行いません。

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

停止は削除ではありません。D0では `backup.sh` と `regi-backup.timer` を追加し、稼働中毎時・起動直後・停止直前に `pg_dump -Fc` →gzip→東京S3の `pg/YYYY/MM/DD/HH.dump.gz` と対応manifestをSSE-S3で保存します。dumpとmanifestの件数・migration版／checksum・RLSは同じexported snapshotから取得し、version ID・SHA・snapshotを照合して復元pairを決めます。同hourの上書き版もversioningで保管します。停止前backupが失敗しても2時間自動停止を続行し、失敗を受入記録へ残します。

東京と大阪は同じ確認済みaccount内の専用バケットで、`pg/` のlive replicationのみを設定します。delete marker複製は無効、source既存物の自動backfillは行いません。replication roleはsource設定／対象version読取とdestinationの `s3:ReplicateObject` に限定し、hostの新規権限は東京 `pg/*` の **`s3:PutObject` だけ**です。アプリroleにbackup権限、hostにGet/List/Delete／大阪writeを付与しません。タグはbackupに使用せず複製tag読取も追加しません。[AWSの複製権限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/setting-repl-config-perm-overview.html)。

両bucketのTLS Denyは通常の `Bool` で `aws:SecureTransport=false` **かつ** `aws:PrincipalIsAWSService=false` とし、人／IAM roleのHTTPを拒否します。AWS間requestでnetwork contextが欠落する場合の扱いは [公式TLS policy](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html#example-bucket-policies-tls) に従います。`BoolIfExists` により欠落したTLS contextを拒否しません。service例外は追加Allowではなく、非公開設定と最小replication権限を維持します。

current expiration35日＋noncurrent expiration35日は、全versionsを作成後35日以内に物理削除する保証ではありません。通常の固有hour keyも約70日保管され得て、replication Pending/Failedはさらに長く残る場合があります。lifecycleは非同期で、両regionへ独立に設定します。未完multipartは1日後に回収し、全object版が無いexpired delete markerは別ruleで除去します。[S3 versioned expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)。

毎時成功中のRPO目標は1時間ですが、停止中・backup障害中は最後の成功点、大阪は複製到着まで復元可能ではありません。[復元手順](runbook/restore.md)でMacの運営者がversion固定したdump／manifestを取得・私有転送し、別の空DBへ復元して全public件数・migration checksum・role／ACL・FORCE RLS／policyを検証してから切り替えます。月1回の訓練で実測RPO／RTOを記録し、実AWSでの初回訓練は未実施です。本構成はMulti-AZやPITRの代替ではありません。

data volume・両backup bucket・Cognito poolはTerraformの `prevent_destroy` で保護し、CognitoはAWS側deletion protectionもACTIVEです。S3 Object Lockやoperatorの全version削除禁止を意味しません。撤去時は必要データ・復元pairを取り出し、本人の明示承認・保管期限・料金を確認してから保護解除planを再レビューします。両regionの全versions／delete markers／未完uploads、CloudFront/VPC origin、EC2、秘密情報、SQS、予算通知を含め残資源を確認してください。別管理bootstrap bucketとstateは `terraform destroy` では消えません。承認なしに自動cleanupやディスク消去を行いません。

## ローカルで再実行した試験

`README.md` のローカルDB/Python環境を先に準備してください。シード試験はローカル管理接続で独立した一時DBを作成し、アプリ用role・全migration・実RLSで検査して最後に一時DBを削除します。本番URLを拒否します。AWS操作コマンドの試験はstub、Terraform試験はprovider mockで、実配備の代わりではありません。

2026-10-02のD0ローカル検証ではNode112件・Web20件・Python27件・sandbox Terraform mock10件が合格しました。SHA13ファイルはruntimeと初回user-dataの両方で現host sourceと照合し、両Terraform rootのfmt／validateも成功しています。リモートGitHub CI、実AWSの毎時backup／大阪複製／復元訓練・Budget通知・Cognito実時間同期は未受入です。最終結果と外部受入の記録は [現状サマリー](implementation-status.md) を参照してください。

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
