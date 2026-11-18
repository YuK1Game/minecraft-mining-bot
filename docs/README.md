# docs の一覧

ファイル名に日付は付けません。内容を更新するときは同じファイルを書き換え、以前の内容は Git の履歴で確認します。

## 仕様

| ファイル | 内容 |
| --- | --- |
| [combat-mode-spec.md](combat-mode-spec.md) | 戦闘モードの数値仕様（標的選択、剣・弓、クリーパー、低体力時の方針） |
| [dashboard-controls.md](dashboard-controls.md) | 管理画面からの接続・ワールド選択・露天掘りの操作と、その安全上の制約 |
| [loadout-reset.md](loadout-reset.md) | シュルカー専用収納と初期セットリセットの仕様・移行 |
| [manual-chest-deposit.md](manual-chest-deposit.md) | ラージチェストへの手動全収納 |
| [quarry-caves.md](quarry-caves.md) | 露天掘りの洞窟対応 |
| [quarry-bedrock-exit.md](quarry-bedrock-exit.md) | ワールド下限まで掘るときの帰還入口 |
| [quarry-lower-landing.md](quarry-lower-landing.md) | 採掘上限と地上着地点の高さの分離 |
| [quarry-supply-approach.md](quarry-supply-approach.md) | 補給前に採掘エリアへ移動する手順 |
| [quarry-worksite-terrain.md](quarry-worksite-terrain.md) | 補給作業地点の地形判定と停止原因の診断 |

## 計画と記録

| ファイル | 内容 |
| --- | --- |
| [quality-plan.md](quality-plan.md) | 品質改善の計画と現在の状況（性能・可読性・保守性・信頼性・使いやすさ） |
| [ci.md](ci.md) | CI が実行する内容、基準の結果の使い回しと3分割、遅かった原因と計測値、速さを保つための決まり |
| [review-hardening.md](review-hardening.md) | コードレビュー対応の記録と、`npm run test:review` / `test:compare` の読み方、実Realmで未実施の確認項目 |
| [review-efficiency.md](review-efficiency.md) | 実装の共通化・重複処理削減の記録（検証結果は [review-efficiency-results.json](review-efficiency-results.json)） |
| [handoff.md](handoff.md) | 作業の引き継ぎ資料（その時点の状態と残課題） |
| [quarry-start-handoff.md](quarry-start-handoff.md) | 露天掘り開始の実行引継ぎと、その後の追記 |
| [player-roadmap.md](player-roadmap.md) | プレイヤーモードのロードマップ（エンダードラゴン討伐までの段階と、松明での湧き潰しなど全段階に共通の決まり） |
| [player-return.md](player-return.md) | プレイヤーモードの帰還（拠点へ戻って収納する）の設計: 目的と操作の分離、段階と終了条件、結果のコード、再試行の上限、受け入れシナリオ |

## 参考資料

| ファイル | 内容 |
| --- | --- |
| [bedrock-bot-references.md](bedrock-bot-references.md) | 統合版 Bot の実装参考 |
| [bedrock-references.md](bedrock-references.md) | 統合版 Bot の参考実装と通信仕様 |

作業ルールと機能の概要はリポジトリ直下の `AGENTS.md`、利用者向けの手順は `README.md` にあります。
