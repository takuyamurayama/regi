# 0001: D0を既存実装の段階的な堅牢化として進める

日付: 2026-10-02。状態: 採用（D0のユーザー承認による）。

### 背景

REGIはローカル実PostgreSQL、Web、Androidで業務操作を検証できる。Go判断前に必要なのは、障害時に売上原記録を残す同期契約、運用可能なmigration、無人同期用の端末資格、復元可能なbackup、継続的な検証である。既存APIは単一Businessクラスを中心にしており、広範囲の構造改修とこれらの正しさを同時に変更すると、原因を限定した回帰試験が難しくなる。

### 決定

承認済みD0を基盤→migration/同期→終端状態/端末資格→backup/運用の順に実装する。全体Prettier整形は意味的変更と別commitにし、blameで無視できるようにする。振る舞いを変える障害・却下・payload制限はRed→Greenの試験で固定し、既存試験の期待値を緩めない。テスト一覧と実行結果をCIで照合し、skip/todoを通常の成功と扱わない。

ESLintはrecommended-type-checkedを用い、新規ファイルにはstrictな検査を適用する。既存高密度コードのunsafe/any等は、review済みのファイル・rule別baseline件数で増加を拒否する段階導入とする。これは既存コードの完全な型安全性を意味しない。

初回D0にはTier M変更、Room schema変更、Web/Android構造改修、新機能を含めない。D0検証・push後の画面とURL改善、登録要件に必要な追加機能は、その後のユーザー指示により承認されている。実装順と既存テストの維持は継続し、未受入の外部条件を完了と扱わない。実AWS適用・配備はMacの承認済みprofileで行い、VMのfmt/validate/mockから稼働・請求・復元受入の実測結果を推定しない。

### 帰結と検証

変更範囲と回帰原因を絞り、既存営業フローの原記録を保持する。単一Businessクラスとlegacy lint警告は残り、Go後の保守投資判断が必要になる。ローカルの障害注入、実PG、HTTP、Web、Android、host script、Terraform mockを組み合わせ、CIと実sandboxの未完条件は実装statusに分けて記録する。D0は商用SLAや補助金登録の承認を表すものではない。
