# 品質改善の計画と状況

性能・可読性・保守性・信頼性（堅牢性）・使いやすさの5つの軸で、何が済み、何が残っているかをまとめます。数値は計測した時点のものです。更新するときはこのファイルを書き換えます（履歴は Git）。

## 進め方

- 実機のログ、実際の画面、CI の記録から測って優先順位を決める。推測で直さない。
- 大きいファイルに処理を足さない。新しい機能は専用のモジュールに置く（`AGENTS.md` の「大きいファイルを育てない」）。
- 同じ種類の不具合を個別の条件分岐で直し続けない。3件目の前に共通の原因を直す。
- 動作を変えない移し替えと、動作を変える修正は別のコミットにする。

## 現在の状況

| 軸 | 状況 | 根拠 |
| --- | --- | --- |
| 信頼性 | 安全回帰（`npm run test:review`）は失敗 0件。CI の全件比較は完走し、誤検知の原因3つ（時間切れ、基準側の結果欠落、負荷で結果が変わるテスト）に対処済み | CI の実行結果 |
| 信頼性 | 全件比較には既存失敗が残る。今回の基準 `083b482` のCIでは、厳格レーン以外に失敗373件・中断3件・スキップ1件を報告。全件成功と「新しい失敗なし」を区別する | [基準のCI実行](https://github.com/YuK1Game/minecraft-mining-bot/actions/runs/44907039273)、下の「残っていること」 |
| 信頼性 | 共通 Runtime fixture の初期化エラー（12ファイル・71件）を修復。分割モジュールの元のスコープを保ち、実処理への観測・依存の差し替えを共通化。対象12ファイルは手元で81成功・失敗0・既存スキップ1、共通scene本体も24件成功 | `test/helpers/runtime-fixture.js`、`docs/ci.md` の対象検証。全件の残数はCIレポートで確認 |
| 信頼性 | 所持品の応答照合、資材を温存する経路、中断後の操作防止、条件変更時の再探索、炉内の残り物と食料探索を修正。落ちた資材への通路探索は共通セルキーへ統一し、既存除外テストを厳格レーンへ戻す | `docs/inventory-navigation-food.md`、変更に対応する結合回帰 |
| 信頼性 | ホットリロードは、削除・改名したモジュールがあっても読み込みを続け、スポーン後に初めて読み込まれたモジュールも保存時に反映する | `test/hotreload-removed-module.test.js` |
| 信頼性 | プレイヤーモードの帰還（拠点へ戻って収納する）を、目的と操作を分けた形に作り直した。途中の失敗・戦闘・反映・再起動で目的が消えず、同じ失敗は3回までで別の方法か保留へ移る。結果は状態とコードで返し、日本語の文で判断しない。専用レーン `npm run test:player` は 0件失敗（時間切れ・スキップ・未実行も失敗に数える）。実Realmでの確認状況は変更ごとの報告に書く | `docs/player-return.md`、`test/player-return.test.js`（S1〜S14） |
| 可読性 | `src/runtime.js` は 8,712行（833KB）→ 4,133行（382KB）。長距離移動・露天掘り・待機保護・操作権・API の操作一覧・旧自律実行の配線を6つのモジュールへ移した | 移した部分を戻すと分割前のソースと一致 |
| 可読性 | `src/quarry/quarry-job.js` は 4,655行（374KB）→ 3,628行（273KB）。収納・補給・脱出と最終確認・設置の照合を4つのモジュールへ移した。計画と採掘の中心は残している | 移した部分を戻すと分割前のソースと完全に一致 |
| 可読性 | `src` を役割ごとのディレクトリ（host / runtime / common / combat / movement / travel / inventory / actions / safety / quarry / loadout / survival）へ分けた。直下は `main.js` と `runtime.js` だけ | `AGENTS.md` のディレクトリ構成 |
| 可読性 | `src/safety/idle-safety.js` は 157KB → 41KB（退避・保護を別モジュールへ）、`src/quarry/storage/quarry-portable-storage.js` は 147KB → 49KB（収納の実行・設置の照合を別モジュールへ）、`src/survival/runner.js` は 107KB → 63KB（移動・採掘・回収を別モジュールへ） | 関連テストの結果が分割前と同じ |
| 可読性 | 800〜1,000行あった3つの関数を段階ごとのモジュールへ分けた。シュルカー収納の実行 `storeCarried` は9段階（`src/quarry/storage/store/`）、待機保護の退避 `escapeOrStop` は12段階（`src/safety/escape/`）、退避ポート `escape` は6段階（`src/runtime/idle-escape/`）。元の関数は段階を順に呼ぶ 60〜100行になり、各段階は 30〜240行。`scripts/extract-stage.js` による機械的な移し替えで、動作は変えていない | 段階を元の位置へ戻したソースが分割前と一致（差は再代入される変数の宣言の書き方だけ）。全件テストの結果が分割前と同じ。`test/extract-stage.test.js` |
| 保守性 | 構文確認は約1秒。大きいファイルの増加を `npm run check` が表示する。`runtime.js` の分割は `scripts/extract-runtime-block.js` で機械的に行える | `scripts/size-budget.json` |
| 性能 | 地形参照（`world.getBlock`）は1回 約1,500ns → 120〜200ns（合成データ）。処理の停止の記録に作業名が出る | `npm run benchmark:world` |
| 使いやすさ | 画面の「今していること」に長距離移動を表示。ログ欄は時刻を表示し、同じ行の繰り返しをまとめる。未使用のスタイル定義 252件を削除 | `test/dashboard-*.test.js` |
| 使いやすさ | `dashboard/index.html` の重複旧ダークテーマCSSを削除し約5.8KB削減（基準を76KBへ引き下げ）。モード切替に連動したヘッダー／タイトル表記、判断ログ（`判断:`）の識別表示、活動欄・詳細モーダルへの直近判断連動を追加 | `dashboard/index.html`、`dashboard/mode.js`、`test/dashboard-decision-view.test.js` |
| 保守性 | `AGENTS.md`（約420KB）からプレイヤーモード・ブランチマイニングの詳細経緯を `docs/player-mode-rules.md` へ分離し、`AGENTS.md` を約9KBのルール＋索引へ軽量化。テスト棚卸しスクリプト `npm run test:audit` を追加 | `AGENTS.md`、`docs/player-mode-rules.md`、`scripts/audit-tests.js` |
| 信頼性 | 同一プロフィールでの二重起動を防ぐロック（`src/host/process-lock.js`）、`host.shared` のライフサイクル別スコープ（`src/common/shared-scopes.js`）、共通タイマースケジューラ（`src/common/runtime-scheduler.js`）、停滞・保留時の診断スナップショット自動保存（`src/modes/incident-snapshot.js` → `.local/incidents/`）を導入。`idle-safety-runtime.js` の直接 `require` を `rt.require` へ修復し `runtime-source-helper.test.js` を復旧 | `test/review-process-lock.test.js`、`test/review-shared-scopes.test.js`、`test/review-runtime-scheduler.test.js`、`test/player-incident-snapshot.test.js`、`test/runtime-source-helper.test.js` |
| 自律性 | プレイヤーモード段階0の未着手3項目（拠点半径16m・8m間隔の湧き潰し、松明16本の常備在庫と木炭フォールバック、仮設チェストの場所記憶と集約）および作業調停（`work-dispatcher.js`）・ネザー〜エンドのステージ別ドライラン検証を実装 | `src/modes/player-base-lighting.js`、`player-torch-supply.js`、`player-field-chests.js`、`work-dispatcher.js`、`test/player-stage0-foundations.test.js`、`test/dragon-stage-dryrun.test.js` |

## ボトルネック監査の品質修正（2026-11-26）

- 採掘の操作予定・受信結果はそれぞれ耐久保存する一方、ドラゴン遠征の計画・過去の採掘場と、露天掘りのセル記録を不変の参照ファイルへ分離した。露天掘りはセル記録の版が変わらなければ複製も書き直しもしない。共有の `checkpoint-parts.js` がサイズ上限、ハッシュ照合、参照先の先行保存、原子的な本体更新、不要な旧版の整理を担う。別の保存世代が参照先を整理した場合も存在を照合し、露天掘りの読み取りは保存と同じキューを取得する。旧形式の読み取りを維持し、壊れた参照先から新規ジョブへ黙って戻さない。操作後の保存失敗では未完了操作を保持する。`review-checkpoint-parts.test.js` は実際の採掘操作窓口とファイルI/Oをつなぎ、保存前の入力禁止・受信後の保存失敗・世代間の読み書き・移行を検証する。
- 管理画面は必要な概要だけを取得し、詳細な診断スナップショットは明示的な `/status` に残した。表示用の露天掘り集計は区画ごとの地形依存で再利用し、完了判定は現状を独立して走査する。`review-dashboard-summary.test.js` は実HTTPの取得経路、無関係な地形更新で走査0件、対象1区画の変更でその4096セルだけの再走査、取消時の実行権譲渡を検証する。

- `runtime-ports.js` を待機保護・戦闘操作権・API操作・長距離移動の4つの本番 factory に接続した。`runtime-port-contracts.js` が環境・観測・ライフサイクル・持ち物・移動・保護・作業の依存を宣言する。既存の `rt.*` と相対 `rt.require` は維持し、値は毎回現在のクロージャーから読む。機械的抽出で付いていた setter をそのまま渡さず、実際に代入する変数だけを書き込み可にした（待機保護8、戦闘操作権9、API操作6、長距離移動5）。`review-runtime-port-writes.test.js` が本番ソースと委譲先の構文木を解析し、前後の増減演算・複合代入・分割代入も含めて権限の過不足を検査する。解析器は既存と同じ TypeScript 4.9.5 を直接の開発依存へ固定した。共有 Host・受信状態関数・破棄状態の差し替えは拒否する。読み取り依存の数そのものはまだ多く、各ポート内部の責務を小さくする余地は残る。
- 持ち物ポートは本番の inventory controller を関数として呼ばず、受信状態の inventory と操作 controller を分けて扱う。
- 無視される `.local/` の helper に依存していた5つのテストファイルを復旧し、厳格な安全回帰レーンへ入れた。手動操作 helper は `scripts/lib/operator-helpers.js` として管理し、正確な期限付き操作権・保護の優先・Nativeプレビュー・開始印による後始末を検証する。イベントループ回帰はソース変換パッチを適用せず、現在の Runtime と分割モジュールを共通 fixture で読み込む。
- テストの `.local/staged/` フォールバックも取り除いた。`test/review-test-dependencies.test.js` は `test:audit -- --strict` と同じ依存監査を毎回実行する。以前の監査が見落とした `../.local/` の文字列参照も検出する。過去の比較失敗を許容する仕組みで読み込み失敗が隠れないよう、復旧したファイルは全件成功を要求する。
- 診断スナップショットを schema 2 にした。地形はブロック状態の palette と全セルの16bit index で保存し、既知の空気、未知セルの座標、階段の向き、液体の追加レイヤーを保持する。`incident-terrain.js` の `replayTerrain` で同じ `getBlock` を再生でき、実 navigator の判断も比較する。保存範囲外と旧 schema の省略セルは未知のままにする。ファイル数とcooldownを維持し、半径は16までに制限する。

## 包括改善パッケージ（2026-11-26 追記）

- **空間コンテキスト調停の共通化**: `src/modes/spatial-context.js` を追加し、現在地（`branch_mine` / `starter_house` / `water` / `underground` / `base_yard` / `open_surface` / `nether` / `end`）の判定と事前退出ステップを一元化した。`work-dispatcher.js` と `dragon-mine-exit.js` から参照し、ブランチマイニング坑道内にいる間に地上前提の補助タスクが割り込んで真上掘りする事故を構造的に抑止した。
- **調達タスクの Result コード・失敗記憶の統一**: `src/modes/supply-task-runner.js` を追加し、`player-food.js`・`house-sand.js`・`house-wool.js`・`player-water.js` を帰還と同じ `return-result.js` / `return-failures.js` 契約（構造化 `lastOutcome` と同一条件3回失敗での自動抑止）へ統合した。あわせて帰還収納 `return-steps.js` で `mayMerge` 判定時に同一チェストを再試行し続ける `STAGE_LOOP` を防止した。
- **診断 CLI とインシデント再現基盤**: `src/common/diagnose-report.js`（`npm run diagnose`）と `src/modes/incident-replay.js`（`npm run incident:fixture`）を追加し、UI を増やさずに最新インシデント・目標台帳・判断ログ・周辺危険セルの読取確認と schema-2 スナップショットからの再現テスト生成を行えるようにした。
- **世代スコープ付き中断トークンと長距離経路評価の統合**: `shared-scopes.js` のスコープ変更通知に連動する `src/common/lifecycle-signal.js` と `runtime-scheduler.js` の `signal` 対応を導入。長距離移動は `src/travel/travel-cost-policy.js` に危険地帯・射撃モブ集団・ソフト近接ペナルティ・水場/屋根下/夜間コストを集約し、`coarse-route.js` と `long-travel-runtime.js` を一本化した。
- **旧サバイバル依存の分離と巨大モジュールのスリム化**: 共通スコープを `src/common/world-scope.js`、ダイヤ装備進行を `src/modes/player-diamond-gear.js` へ分離し、`src/modes/` から `src/survival/` への直接 `require` を 0 件にした（`audit-tests.js --strict` で常時検証）。また `idle-safety-runtime.js` の残り3ブロック（`partialEscape` / `clearEscape` / `onEmergencyStop`）と `quarry-job.js` の計画ブロック（`quarry-job-plan.js`）を機械抽出し、`size-budget.json` の上限をそれぞれ **128.9KB → 76.5KB（▲52.4KB）**、**265.8KB → 248.5KB（▲17.3KB）** へ引き下げた。
- **比較レーンの分類と厳格レーンへの昇格**: `audit-tests.js` に比較専用テストの内訳分類を追加し、高速・100%合格を確認した現役テスト37本（ダッシュボード・長距離移動・広域経路・v2.2露天掘り・クラフト・かまど・水中退避等）を `test:review` 厳格レーンへ昇格させた（厳格レーン合計 308 → 350 ファイル）。
- **追加改善パッケージ（2026-11-27 追記）**:
  - **帰還 `verify` の未開放チェスト除外と拠点石炭調達**: `src/modes/return/return-steps.js` の `verify` 段階で `CONTAINER_OPEN_REFUSED` / `CONTAINER_CONTENTS_UNKNOWN` となったチェストを `goal.unopened`（到達不能は `goal.unreached`）へ記録・除外し、別チェストへフォールバックできるよう修正（`test/player-incident-regression.test.js`）。あわせて `src/modes/house/house-supply.js`・`src/runtime/autonomy-runtime.js` に石炭2の採掘（`houseCoalInput` / `planCoal`）を組み込んだ。
  - **診断 CLI のインシデント傾向集計**: `src/common/diagnose-report.js` に保存済みインシデント全体の種別件数・頻出目標・平均停滞秒数の集計を追加（`npm run diagnose`）。
  - **現役サブシステムテスト 155 本の厳格レーン昇格**: 比較レーンの現役サブシステム 185 本から高速・100% 合格を確認した 155 本を `test:review` へ昇格（厳格レーン合計 350 → 506 ファイル、現役比較レーン 185 → 30）。
  - **`src/runtime.js` からの旧サバイバル Depot 配線分離**: `src/runtime.js` の 3114〜3451 行（`observeDepotSky` / `runDepotResource` / `ownedCampBootstrap` / `dispatchDepotIntent` / `depotPrebuild` / `depotMission`）を `src/runtime/legacy-depot-runtime.js` へ機械抽出し、`size-budget.json` の `src/runtime.js` 上限を **370.7KB → 342.0KB（▲28.7KB）** へ引き下げた。

## 残っていること（優先順）

| 順 | 内容 | 軸 | 補足 |
| --- | --- | --- | --- |
| 1 | 移した部分と元のクロージャーの間のやり取り（アクセサの一覧）を減らす | 可読性・保守性 | 4つの主要factoryには用途別のportと明示write権限を導入済み。`idle-safety-runtime.js` と `quarry-job.js` の大型関数抽出も完了したため、次は段階間で共有する `vars` / アクセサを値受け渡しへ寄せる |
| 2 | 比較レーン残り（440ファイル）の段階的整理 | 信頼性 | 37本を厳格レーンへ昇格済み。残りは旧サバイバル118・露天掘り比較69・Runtime比較68・現役サブシステム185に分類済みのため、現役サブシステムからの追加昇格と旧サバイバル退役を進める |
| 3 | 旧サバイバル（小屋・ダイヤ直掘り計画）のランナー退役 | 可読性 | `src/modes/` からの直接 `require` は 0 件化済み。序盤採取の実行委譲も段階的に `src/modes/` 側へ移す |
| 4 | ネザー・地下要塞・エンド戦の実Realm通し検証 | 自律性・信頼性 | ドライラン検証と `incident-replay.js` による即座の回帰テスト化基盤は整備済み。実Realmでの通し観測と微調整を進める |

## 確認のしかた

- 構文と大きいファイルの増加: `npm run check`
- 安全回帰: `npm run test:review`
- プレイヤーモード: `npm run test:player`（全テストが実行されて合格した時だけ成功。既存の失敗で外しているファイルは実行のたびに理由と一緒に表示する）
- 全件の失敗の比較: 変更の前後で `node --test --test-force-exit --test-concurrency=2 --test-timeout=30000 --test-reporter=tap` を実行し、失敗したテストの一覧を比べる（`npm run test:compare` は、基準の結果が残っていない時に一時的な Git ワークツリーを作るため、この PC では使わない。CI では使う。仕組みは `ci.md`）
- `runtime.js` から移した部分が元のソースと一致すること: `test/runtime-source-helper.test.js`
