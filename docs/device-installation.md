# 端末導入・配布

対象機器: Galaxy Tab Active5 Pro、Epson TM-m30III-H LAN。
現物は本環境に未接続。エミュレーターおよびTCP sink試験と実機合格を混同しない。

## 初期導入

1. 店舗LANを業務用に分離し、プリンターの固定IP/9100番対応・ファームウェア・用紙幅を現物で確認。
2. 本部管理者のCognito/MFAログイン後に端末を登録。店舗2台、法人5店舗/10台、スタッフ100名の上限を確認。
3. Androidリリース版を同じ署名でインストール。本番はHTTPSとCognitoを利用し、debugの開発認証を利用しない。
4. API URL、Cognito Hosted UI URL/public client IDを設定し、ブラウザーのPKCE/MFAログインを開始する。`regipos://oauth` をCognito callbackへ登録する。Android設定で店舗を選択し端末登録、または登録済み端末IDで初回同期。refresh tokenはKeystore暗号化で保存する。手動token入力はdebug版だけ。PIN担当者を選択し、オンライン認証の権限を縮小する。本物のCognitoとの疎通は実アカウント接続後に検証する。
5. 商品検索・JAN・税区分・価格・税込/税抜設定、開局、現金・外部端末の成功確認、釣銭、LAN印刷を確認。
6. 通信を切り、再起動後の確認待ち会計・未送信を確認。72時間と期限切れの境界、復旧再送、在庫の一致を実機で検査。
7. 返品/発注/在庫調整/棚卸は Android の「店舗業務」または本部画面からオンラインで実施。元記録を検索し、返品可能残数・入荷残数を確認して複数明細を選択する。管理者用Cognito資格情報が必要で、PINだけでは管理者権限を得られない。棚卸は全端末販売停止・同期を維持し、隔離原記録を実査と照合する。

## 署名付き配布

```bash
export REGI_KEYSTORE_PATH=/secure/location/regi-distribution.jks
export REGI_KEYSTORE_PASSWORD=...  # 値は秘密管理ツールから供給
export REGI_KEY_ALIAS=...
export REGI_KEY_PASSWORD=...
android/gradlew -p android assembleRelease
```

署名鍵が未指定なら release は unsigned。debug APKを本番配布物と呼ばない。
パスワードをシェル履歴・CIログ・リポジトリへ保存しない。CIは秘密変数をマスクし、artifact署名を `apksigner verify` で確認する。
APKをMDM/管理された経路で配布し、端末のアンインストール・データ消去を店舗権限から制限する。Androidアプリ単体でOSによるデータ消去を完全には防げない。

## 印刷確認票

- 税率別端数、値引き、合計、預り/釣銭、元販売日/返還日、長い商品名、日本語文字の実印字。
- 用紙切れ、LAN断、印刷中断、再印刷。再印刷で売上が増えないこと。
- EpsonのLAN設定、カット、用紙幅、TCPラスターデータへの対応。実機の確認前に「Epson動作保証」と表示しない。
- プリンターへ送信完了した事実と、実際の紙への印字完了を区別する。現在のTCP実装は双方向の用紙/印字完了ステータス確認を実装していない。
