# 0003: Go判断前は単一EC2のTier S sandboxを維持する

日付: 2026-10-02。状態: 採用。

### 背景

ユーザーは月額数千円以下、使う時だけ起動、2時間自動停止を希望している。商用展開、常時稼働、SLA、独自ドメイン、MDM、Tier Mへの投資判断は未確定である。既存sandboxは東京のt3a.smallでAPI/worker/PostgreSQL17を実行し、暗号化gp3の8GiB OSと32GiBデータを保持する。

### 決定

`infra/sandbox` を唯一のD0環境として維持し、`infra/` のTier M構成は変更しない。Savings Plans/Reserved Instancesは導入しない。CloudFront VPC origin経由のHTTPSとCognitoを維持し、EC2の3000/22/5432を直接公開しない。API/workerは非特権regi_app、maintenanceは別のowner資格を使用する。

稼働中の毎時、起動直後、停止直前に整合snapshotからpg_dumpを取得し、東京のversioned private S3へ保存し、大阪へ非同期replicationする。current/noncurrent objectの保持期間は35日とし、TLS/SSE-S3/public block/破棄防止を適用する。hostのbackup権限は専用prefixへのPutObjectに限定する。復元は別DBで検証してから切り替え、旧DBを保持する。 `aws s3 cp` の代わりに、応答から両version IDを記録できる `aws s3api put-object` を使用し、AES256を明示する。単一uploadのD0上限は保守的に5,000,000,000bytes（5GB）とし、超過は失敗として記録する。hostへGet/List/Delete権限は加えない。

Budgetは10 USD、ACTUAL80%とFORECASTED100%の通知を設定する。Budget通知は課金上限・自動停止の保証ではない。停止中約650円/月の見積りは、東京gp3容量40GiB、secret1件、少量のS3、1USD=150円等の条件付き概算として記載する。起動時間、backupサイズ・version数、複製転送、税、為替によって増える。

### 帰結と検証

単一host/ディスク障害ではサービス停止が発生する。稼働中の正常な毎時backupは1時間以内のRPOを目標とするが、停止中は最後の成功backup、backup失敗中はその前の成功backupが復元点になる。大阪replicationの遅延・失敗も復元可能時刻へ影響し、同期複製や確定SLAを意味しない。RTOは実復元訓練で測定する。

Terraform fmt/validate/provider mockと独立DBのbackup/restore試験を実施し、Macからの実AWS適用後に毎時実行・replication・復元・請求を確認する。実時間受入前に達成済みと記録しない。将来のTier M移行はGo後の別判断とする。
