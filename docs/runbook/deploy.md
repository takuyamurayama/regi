# D0 sandbox 配備手順

対象は `infra/sandbox` の単一EC2です。操作は利用者のMacと承認済みAWS profileから行います。このVMではAWS apply・配備・S3操作を実施していません。初回のデータディスク準備は [sandbox構成](../aws-sandbox.md) を参照してください。通常更新でディスクの初期化承認ファイルを作り直しません。

## 配備前の確認

1. 現行branchのCIと [現状サマリー](../implementation-status.md) を確認します。ローカル試験と実AWS受入を区別します。
2. 私有control.json・tfvars・backend設定を使い、STSのaccount、東京region、既存instanceとdata volumeが承認済みの対象であることを確認します。資格情報をVMやrepositoryへコピーしません。
3. 既存EC2をMacの `bash scripts/sandbox-control.sh start` で起動してからplanします。停止中の公開IP driftを理由とした意図外置換を適用しません。
4. 未確定の管理操作・開局操作を照合します。新しいoperation hashはtop-level PINを含みませんが、旧PIN付きhashを一括書換えません。不一致は `IDEMPOTENCY_CONFLICT` で拒否します。新しいoperation IDによる自動再実行は行いません。
5. 私有tfvarsの旧 `monthly_budget_usd=30` を `10` へ明示更新します。ACTUAL80%とFORECASTED100%は通知条件で、課金上限ではありません。通知メールの受入を確認します。

## イメージとplan

Macのrepositoryで以下を実行します。archiveは私有ディレクトリへ保存し、レビューしたrelease keyへアップロードします。確認済みAWS profile・regionは各AWS操作に指定します。

```bash
set -euo pipefail
mkdir -p .private
chmod 700 .private
docker build --platform linux/amd64 --tag regi:sandbox .
docker save regi:sandbox | gzip -c > .private/regi-image.tar.gz
shasum -a 256 .private/regi-image.tar.gz
```

表示されたSHA-256を私有tfvarsの `image_sha256`、アップロード先を `image_object_key` に設定します。アーカイブのSHAとDocker image IDは別の値です。S3へアップロードした同じarchiveを使用します。

```bash
terraform -chdir=infra/sandbox init -backend-config=/absolute/path/.private/sandbox.backend.hcl
terraform -chdir=infra/sandbox validate
terraform -chdir=infra/sandbox plan -var-file=/absolute/path/.private/sandbox.tfvars -out=/absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox show /absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox apply /absolute/path/.private/sandbox.tfplan
terraform -chdir=infra/sandbox output -json deployment > /absolute/path/.private/deployment.json
```

planは適用前に確認します。D0ではbackupの東京・大阪バケット、複製IAM、hostのPutObject、Cognito削除保護、Android client、Budget、runtime、レビューしたbootstrapファイルを更新します。既存EC2、永続data volume、Cognito poolやWeb clientの置換・削除を提案するplanは止めて調査します。`prevent_destroy` を通常更新のために解除しません。

## 既存hostへの限定更新

`user_data_replace_on_change=false` のため、applyだけでは既存EC2のhost scriptsとunitsが更新されません。更新済みruntimeのbootstrap SHA一覧とMacのsource SHAを確認し、SSM Run Commandで対象instanceへ限定更新します。

既存hostにinstallerがない場合は、確認したbootstrap release keyから `install-host.sh` と `install_host.py` の2ファイルをprivateな一時ディレクトリへ取得します。両ファイルについてMacのsource SHA、更新runtimeのSHA、hostの `sha256sum` を一致させてから `/opt/regi/` へ配置します。root所有とし、shellは0700、Python helperは0600にしてから実行します。SSM command引数へDB passwordや署名鍵を入れません。初期user-data全体やディスク初期化を通常更新で再実行しません。

SSMのrootコマンドで以下を実行します。

```bash
set -euo pipefail
/opt/regi/install-host.sh --refresh
systemctl daemon-reload
systemctl restart regi
systemctl is-active regi
systemctl is-enabled regi-backup.timer
systemctl list-timers regi-backup.timer
```

installerはruntimeで指定したファイル集合をSHA確認してから更新します。取得失敗・不一致はそのまま続行せず調査します。`systemctl restart regi` はowner migrationと新イメージ検証を実行するため、固定のbootstrap段階ログでreadyまで確認します。Docker imageのarchive SHA不一致では起動しません。`000〜007` のSQLを配備時に編集しません。

仕入金融を含む追加releaseは `008_purchase_finance` を適用します。適用前の成功backupを確認し、既存000〜007のchecksumが変わっていないこと、適用後の008が `f672d5a8cc0ee32b3a446814f9a19cda5007477955bf6e2f493e3d891f003d72` と一致することを記録します。全13金融表のFORCE RLSと、既存の売上・在庫・端末連番を保持します。rollbackのために008を削除したり原請求・台帳を改変したりしません。

本部Webも [sandboxのWeb公開手順](../aws-sandbox.md) で更新します。正規URLのCloudFront functionはAPI/health/assetsを変更せず、Webの直接アクセス・再読込を処理します。APIイメージだけの更新で新画面が配布済みとは扱いません。

## 配備後の受入

| 項目                                                                    | 実測・記録欄 |
| ----------------------------------------------------------------------- | ------------ |
| 実施者、Mac profile、STS対象account一致                                 | 未実施       |
| commit、CI URL、archive SHA、release key                                | 未実施       |
| planの意図外置換・削除なし、既存instance/data volume保持                | 未実施       |
| runtime・host file SHA・bootstrap ready・稼働image                      | 未実施       |
| HTTPS health200、未認証API401、Web本人ログイン                          | 未実施       |
| 000〜007 checksum、appのNOSUPERUSER/NOBYPASSRLS                         | 未実施       |
| 008 checksum、金融13表のFORCE RLS、既存売上/在庫/連番保持               | 未実施       |
| 仕入請求deep linkの再読込、同操作者の保存結果照会、レジ担当の原資料拒否 | 未実施       |
| 起動直後・毎時・停止直前の成功dump/manifest pair                        | 未実施       |
| 東京・大阪のversion ID、SHA、複製到着時刻                               | 未実施       |
| Budget10 USD・ACTUAL80%/FORECASTED100%の宛先と通知                      | 未実施       |
| Web client1日・Android client30日refresh/callback設定                   | 未実施       |
| Android管理者再ログイン、原会計/outbox保持                              | 未実施       |
| 時計試験と別の実sandbox累計1週間・実Cognito長期同期                     | 未実施       |

Androidの設定にはdeploymentの `android_client_id` とCognito domainを入力します。Web clientの既存refresh tokenを流用しません。client切替時は会計を保持し、管理者がPKCEで再ログインします。未送信・要確認・確認待ちの件数を照合してから営業します。

backupの完了記録にはdumpとmanifestのSHA・snapshot UUID・両version IDが必要です。大阪複製は非同期なので、設定の存在だけで復元可能と判定しません。実backupと [復元訓練](restore.md) のRPO/RTOを記録します。配備後に問題があれば原データを保持し、失敗したbootstrap段階・health・固定ログを確認して同じreleaseを調査します。

backupは整合snapshotから `pg_dump -Fc` → gzip → SSE-S3のアップロードを行います。同世代のdump/manifestのVersionIdを応答から固定するため、`aws s3 cp` に代えて `aws s3api put-object` を使用します。単一uploadのD0上限は5,000,000,000bytes（5GB）。超過・240秒以内に完了しないbackupは失敗と記録し、正常停止は継続するため、次の復元点は最後の成功backupになります。実データ量でサイズと時間を受け入れ、上限超過時はMac運用担当が容量・復元方式を再評価します。[AWS単一PUTの上限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)
