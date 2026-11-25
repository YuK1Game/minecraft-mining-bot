# AGENTS.md

このリポジトリで作業する AI エージェント（Claude Code、Codex など）向けの運用ルールと全体設計の概要です。
コンテキスト圧迫と切り捨てを防ぐため、**個別の詳細仕様・実Realmでの経緯記録は `docs/` 配下に分離**しています。作業前に必ず該当する領域の資料を確認してください。

## 編集対象ごとの参照ドキュメント

| 触る領域 | 先に読むドキュメント |
| --- | --- |
| プレイヤーモード・ブランチマイニングの個別ルール・実機経緯 | [docs/player-mode-rules.md](docs/player-mode-rules.md) / [docs/player-branch-mining.md](docs/player-branch-mining.md) / [docs/player-roadmap.md](docs/player-roadmap.md) |
| プレイヤーモードの帰還・結果コード・失敗記憶 | [docs/player-return.md](docs/player-return.md) |
| 戦闘モード（数値仕様・剣/弓/クリーパー/低体力） | [docs/combat-mode-spec.md](docs/combat-mode-spec.md) |
| 管理画面の操作・安全境界・デバッグツール | [docs/dashboard-controls.md](docs/dashboard-controls.md) |
| 露天掘り（洞窟・下限脱出・補給・シュルカー専用） | [docs/quarry-caves.md](docs/quarry-caves.md) / [docs/quarry-bedrock-exit.md](docs/quarry-bedrock-exit.md) / [docs/loadout-reset.md](docs/loadout-reset.md) |
| 品質改善計画・CI 構成・テスト棚卸し | [docs/quality-plan.md](docs/quality-plan.md) / [docs/ci.md](docs/ci.md) / [docs/README.md](docs/README.md) |
| 利用者向け手順・コマンド一覧 | [README.md](README.md) |

## プロダクト概要

**minecraft-realms-bot** は、Minecraft 統合版（Bedrock）**1.26.60** の Realm に、別の Microsoft アカウント（現在は `HouchiChan`）として参加する Node.js 製自律 Bot です。2つのモードを持ちます。

1. **露天掘りモード（`/quarry`）**: 指定範囲を上から1層ずつ露天掘りし、回収した資材をシュルカーボックスへ収納します（2026年11月4〜5日に実Realmで5,000ブロック以上確認。完了検証継続中）。
2. **プレイヤーモード（`src/modes/`・管理画面の「🧭 プレイヤー」）**: 手ぶらから拠点の家（7×7）を建築し、計画済みブランチマイニングで装備を整え、ネザー・地下要塞・エンダードラゴン討伐までを自律進行します（[docs/player-roadmap.md](docs/player-roadmap.md)）。

- 接続を保持したまま行動コードをホットリロードできる構成です（`src/host/host.js` が接続を持ち、`src/runtime.js` と行動モジュールを差し替える）。
- 対象 Realm はサンドボックスで、Bot アカウントはオペレーター権限を持ち、常に昼に設定されています。デバッグ目的のゲーム内コマンドは使用可ですが、露天掘り・プレイヤーモードの本処理ではコマンドによるブロック削除・アイテム生成・ワープは禁止です。
- 旧サバイバル（`src/survival/`）の実装は一部残っていますが、統合ダッシュボードの目標表示には使いません。

## 主要機能と設計の要点

- **接続・認証・二重起動ガード**: Microsoft 認証（`.auth/`）、Realm 一覧・選択、異常終了時の自動再接続（`scripts/keep-alive.js`）、同一プロフィールでの二重接続を防ぐロック（`src/host/process-lock.js`）。
- **ホットリロード**: 行動コード保存で自動反映（`src/host/hotreload.js`）。構文・初期化エラー時は旧コードを維持。クラフト・設置中は安全な切替点を待つ。保存のないファイル通知では再反映しない。
- **観測と持ち物一元管理**: 未受信ブロック（`known:false`）を空気扱いしない。メイン36・防具4・オフハンド・カーソルは `host.shared.inventoryStore` で一元管理し、未受信枠は空ではなく「?」。
- **共有状態スコープとスケジューラ**: ライフサイクル別の共有状態（`src/common/shared-scopes.js`：`persistent`/`session`/`life`/`mode`）と共通タイマー管理（`src/common/runtime-scheduler.js`）。
- **戦闘モード**: 接続中は既定で有効（50ms周期、`src/combat/combat-coordinator.js`）。接敵時は戦闘を最優先（例外: 自分のシュルカーを壊してから回収確定までのみ保留）。攻撃が届く敵（経路・3本射線）のみ迎撃。不死のトーテム保持中は体力で止めない。満腹度18未満で食事。速く積極的に戦う方針を維持。
- **露天掘りモード**: 掘り抜き優先（`pickupMode:"passive", depositWhen:"full"`）。木・葉は採取しない（長距離移動準備の `woodHarvestAllowance` のみ例外）。道具耐久は既定で残り1を予備として保持。洞窟があっても止めない。終了時は初期セットチェストへ全返却＋隣接土柱で地上復帰。
- **プレイヤーモード**: 目的と操作の分離（[docs/player-return.md](docs/player-return.md)）、進捗台帳（`src/modes/goal/goal-ledger.js`）、判断ログ（`src/modes/decision-journal.js`）、停滞時の診断スナップショット自動保存（`src/modes/incident-snapshot.js` → `.local/incidents/`）、作業調停（`src/modes/work-dispatcher.js`）。時間で状況が変わらないため時間待ちの保留（`NO_PROGRESS` hold）には入らず、一定時間進捗がなければ記憶していた選択・失敗履歴を捨てて決め直しを継続する。鉄以下のツール（木・金・石・銅・鉄）は使い捨てとし耐久0まで使い切る（ダイヤ・ネザライトは耐久予備を保持）。拠点周辺の湧き潰し（`player-base-lighting.js`）・松明16本在庫目標（`player-torch-supply.js`）・仮設チェスト記憶と集約（`player-field-chests.js`）、開いたチェストの座標と中身のサーバー別記録（`player-chest-index.js` → `.local/chest-index/realm-<id>.json`。空きを記録したチェストから開く）、本拠点48m以内では家のかまどを使い仮設かまどを置かない決まり（`station-yard.js`）を備える。
- **ローカル API / 統合ダッシュボード**: `:3000`（`src/host/api.js`）と `:3001`（`scripts/dashboard.js`、`dashboard/`）。Host/Origin/一時トークン検査と固定コマンド許可リストを維持。

## ディレクトリ構成

```
src/            Bot 本体（直下は main.js と runtime.js のみ）
  main.js         プロセスの入口
  runtime.js      ホットリロードされる行動の入口（約367KB。これ以上育てない）
  host/           接続側（変更時は Bot の再起動が必要。ホットリロード対象外）
                  host.js / api.js / hotreload.js / lifecycle.js / process-lock.js /
                  world.js / entities.js / dashboard-control.js / dashboard-debug.js ほか
  runtime/        runtime.js から移したモジュール群（*-runtime.js）、runtime-ports.js、
                  event-loop-stall.js / stall-profile.js、idle-escape/
                  ※ 抽出モジュールは rt.<名前> / rt.require(...) / rt.__dirname を維持すること
  common/         共通部品（durable-json / life-identity / shared-scopes / runtime-scheduler / work-spans ほか）
  combat/         戦闘モード（combat-coordinator / combat-profiles / combat-exposure / melee / ranged / knockback-reach）
  movement/       入力・物理予測・経路探索・警戒付き移動・サーバー位置照合・build-route
  travel/         長距離移動（long-travel / coarse-route / chunk-travel / night-stop / travel-detour）
  inventory/      持ち物の記録と検査（inventory-store / inventory-inspection / durability）
  actions/        ゲーム操作（mining / interactions / crafting / furnace / chest / food / armor / house-placement）
  safety/         待機保護（idle-safety / escape/）・復帰（recovery）・退避・house-protection
  quarry/         露天掘り（quarry-job / storage/ / exit/）
  loadout/        初期セットリセット・v2.2受領・ラージチェスト手動全収納
  modes/          プレイヤーモード（mode-runtime / dragon-* / player-* / work-dispatcher / incident-snapshot /
                  goal/ / house/ / mining/ / return/）
  survival/       旧サバイバル（autonomy / planner / runner / 小屋・避難所・ダイヤ計画）
scripts/        keep-alive.js / dashboard.js / check.js / review-tests.js / player-tests.js /
                compare-tests.js / audit-tests.js / extract-runtime-block.js / extract-stage.js
dashboard/      統合ダッシュボード（index.html / control.{js,css} / mode.{js,css} / debug.{js,css}）
test/           node --test 自動テスト（fixtures/ に実測データ）
docs/           仕様・計画・運用ルール記録（docs/README.md に一覧）
.local/         実行時の状態・ログ・診断スナップショット・時間記録（Git 管理外）
.auth/ .env     認証キャッシュと設定（Git 管理外。読まない・出力しない・コミットしない）
```

## 実行とテスト（Node.js 24 以降）

| コマンド | 内容 |
| --- | --- |
| `npm start` | 接続してコード更新を監視（`/quarry`・`/auto`・`/mode`・`/status`・`/stop`・`/reload`・`/quit`） |
| `npm run auto` / `auto:once` | プレイヤーモードで遠征を開始・再開（`auto` は異常終了時自動再接続） |
| `npm run dashboard` | 統合ダッシュボード起動（`http://127.0.0.1:3001`） |
| `npm run check` | 全JS・ダッシュボードHTMLの構文確認（約1秒）と `scripts/size-budget.json` の増加警告 |
| `npm run test:fast` | 開発中の高速ユニット確認（重いワールド模擬を除いた厳格テスト抜粋・高並列） |
| `npm run test:review` | 安全回帰・互換テスト厳格レーン（失敗1件でも不合格） |
| `npm run test:player` | プレイヤーモード厳格レーン（全件実行・合格必須） |
| `npm run test:audit` | テストレーン分類・`.local/*.cjs` 依存・旧サバイバル参照の棚卸し |
| `npm run test:compare -- <SHA>` | 厳格レーン以外の全件を基準コミットと比較（ユーザーPCでは実行しない。CI用） |
| `npm run benchmark:world` / `benchmark:combat` | 地形参照・戦闘探索の速度計測（接続不要） |

テストの注意:
- 厳格レーン（`test:review` / `test:player`）は常に 0 件失敗を維持する。全件比較には変更前からの既存失敗が残るため、「全件成功」と「新しい失敗なし」を区別する。
- CI の速さを保つ（[docs/ci.md](docs/ci.md)）: 1ファイル単独30秒超は原因修正か `.partN.test.js` 分割、来ないものを上限まで待つテストは足さない。テストの合格はゲーム内達成の証明ではない。

## 作業時の必須ルール

- **接続と作業を維持する**: 利用者の指示がない限り Bot をオフラインへ戻さない。行動コードはホットリロードで反映し、収納・回収の安全な切替点を待つ。未確認の成果を作って再開しない。
- **サーバー由来の情報だけを成果とする**: 送信・時間経過・プレビュー・予測位置・ドロップ消滅だけでは成功扱いにしない。採掘は受信空気、設置はブロック更新＋消費、回収・クラフトは実インベントリ変化で確定する。
- **未知を安全と見なさない**: 未受信の地形・未確認の持ち物・一覧にない敵は安全側に倒す。
- **再起動が必要な変更を明示する**: `src/host/`、認証・通信、依存、`.env` の変更はホットリロードされないため、再起動が必要と必ず伝える。
- **大きいファイルを育てない**: `scripts/size-budget.json` の対象ファイル（`src/runtime.js`・`src/quarry/quarry-job.js`・`dashboard/index.html` 等）に新機能の処理を足さない。専用モジュールへ分離し、サイズを下げたら基準値も下げる。機械的抽出は `scripts/extract-runtime-block.js` / `scripts/extract-stage.js` を使う。
- **同じ種類の不具合を個別分岐で直し続けない**: 3件目の前に共通原因を部品として直す。個別対処を足した場合は場所と理由をコミットメッセージに残す。
- **ドキュメントのファイル名に日付を付けない**: `docs/` は内容を表す名前にし、更新は同じファイルを書き換える（履歴は Git）。追加時は `docs/README.md` へ1行足す。
- **変更前は Git で残す／ワークツリーを作らない**: `backup/` へのコピーは禁止。`git worktree add` は使わず `G:\Projects\MinecraftBot` 内でブランチを短く切って作業する。作業前に `git status` を確認する。
- **秘密情報**: `.auth/`、`.env` は読まない・出力しない・コミットしない（公開リポジトリ）。
- **ユーザーとのやり取り**: 日本語・時刻は **JST（UTC+9）**。
- **ダッシュボード UI 方針**:
  - 補足文を増やさず、レイアウト・階層・アイコン・状態表示で直感的に伝える。
  - **メッセージ用の新領域や頼まれていないボタンを足さない**（状態・エラーは「今していること」欄・既存バッジ・ログに出す）。
  - **ファーストビューですべて収まるレイアウト**を維持し、コントロール見出しは折りたたみにしない。
  - 開始・再開・一時停止にブラウザーの確認ダイアログを出さない（キャンセルのみ維持）。汎用 `/action` プロキシやシェル実行は作らない。
- **開発順序と時間記録**:
  1. 変更対象の入口から実処理・受信結果までの小さな結合検証を先に通す。
  2. 改修中は関連テストで素早く確認し、完了後に `npm run check`・`npm run test:review`・`npm run test:player` をまとめて実行する。
  3. 調査・改修・テストの工程別時間（JST）を `.local/development-timing/<task>.jsonl` へ記録する。
