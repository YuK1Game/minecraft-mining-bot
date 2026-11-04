# AGENTS.md

このリポジトリで作業する AI エージェント（Claude Code、Codex など）向けの概要です。利用者向けの詳しい手順は `README.md`、戦闘の数値仕様は `docs/combat-mode-spec.md` を参照してください。

## プロダクト概要

**minecraft-realms-bot** は、Minecraft 統合版（Bedrock）**1.26.60** の Realm に、別の Microsoft アカウント（現在は `HouchiChan`）として参加し、サバイバルを自律的に進める Node.js 製の Bot です。

- 最終目標: **拠点・武器 → 食料と生存 → 石・鉄の道具 → ダイヤモンド1個以上の実取得**。
- 現状: 鉄のツルハシ作成までは実ワールドで確認済み。**ダイヤモンドは未取得**で、完成したサバイバル Bot ではありません。
- 接続を保持したまま行動コードをホットリロードできる構成です（`src/host.js` が接続を持ち、`src/runtime.js` と行動モジュールを差し替える）。
- 対象 Realm はサンドボックスで、Bot アカウントはオペレーター権限を持ち、常に昼に設定されています。デバッグ目的のゲーム内コマンド（`/summon`、`/give`、`/tp`、`/fill`、`/effect` など）は使用可。ただし露天掘りモードの本処理では、コマンドでのブロック削除・アイテム生成は禁止です。

## 対応している機能

| 分野 | 内容 | 主なファイル |
| --- | --- | --- |
| 接続・認証 | Microsoft 認証（`.auth/` にキャッシュ）、Realm 一覧・選択、異常終了時の自動再接続（指数バックオフ、10分で最大5回） | `src/host.js`, `src/realms.js`, `scripts/keep-alive.js` |
| ホットリロード | 行動コード保存で自動反映。構文・初期化エラー時は旧コードを維持。クラフト・設置中は安全な切替点まで待つ | `src/hotreload.js`, `src/lifecycle.js` |
| 観測 | エンティティ・敵・地形（サブチャンク）・持ち物・体力/空腹の受信。未受信ブロック（`known:false`）を空気扱いしない | `src/entities.js`, `src/threats.js`, `src/world.js`, `src/inventory.js` |
| 移動 | 経路探索、物理予測（実験的 Bedrock 版 prismarine-physics）、段差・ジャンプ、水際、警戒付き経路移動と退避 | `src/navigation.js`, `src/movement.js`, `src/physics.js`, `src/guarded-route.js`, `src/escape-policy.js` |
| 拠点 | 斜面の避難所、平地の土小屋（土17個）の建築・閉鎖・退出・帰還、保管庫（チェスト）の建設と収納 | `src/shelter*.js`, `src/hut*.js`, `src/depot-*.js`, `src/chest.js` |
| クラフト・精錬 | 板材・作業台・棒・木剣・石剣・ツルハシ類、かまどでの精錬（鉄のツルハシまで確認済み） | `src/crafting.js`, `src/furnace.js`, `src/starter-gear.js` |
| 採掘・探索 | 1回最大8ブロックの採掘、隣接セル掘削、トンネル、鉱石探索、ダイヤ計画 | `src/mining.js`, `src/excavation.js`, `src/tunneling.js`, `src/prospecting.js`, `src/diamond-*.js` |
| 食料・生存 | 動物の狩りと回収、食事、待機保護（自衛・小屋閉鎖・退避・非常停止）、低体力時の水場退避、正規リスポーン | `src/foraging.js`, `src/food.js`, `src/idle-safety.js`, `src/recovery.js` |
| 自律実行 | 目標（`diamond` など）に向けた計画と工程選択、失敗キャッシュ、進捗記録の保存・復元 | `src/autonomy.js`, `src/planner.js`, `src/survival-planner.js`, `src/mission-memory.js`, `src/mission-journal.js` |
| **戦闘モード** | 下記参照 | `src/combat-coordinator.js` ほか |
| **露天掘りモード** | 下記参照 | `src/quarry-*.js` |
| ローカル API | `127.0.0.1:3000`。`/status`、`/agent/start|stop|tick`、移動・採掘・クラフト・戦闘、`POST /action`（group/method/args） | `src/api.js` |
| ダッシュボード | `127.0.0.1:3001`。状態表示（表示専用）と `/logs` のライブログ（JST、戦闘・エラーで絞り込み） | `scripts/dashboard.js`, `scripts/lib/dashboard-state.js`, `dashboard/index.html` |

### 戦闘モード

自動実行と同時に有効になる、リアルタイムの自律戦闘です。入口は `src/user-behaviors.js` → `src/combat-coordinator.js`（50ms ごとに判定）。詳細と数値は `docs/combat-mode-spec.md`。

- 32m 以内の敵対モブから、敵ごとのプロファイル（`src/combat-profiles.js`、53種）・経路（`src/threat-reachability.js`）・射線で標的を1体選ぶ。
- **剣**（3.0m 以内）: クリティカルのジャンプは使わず連打（実測約180ms 間隔）。`src/melee-combat.js`, `src/melee-weapons.js`
- **弓**（6〜32m）: 20tick で即発射・即次弾、偏差撃ち、射線確保の短距離移動。`src/ranged-combat.js`, `src/bow-ballistics.js`, `src/aim.js`
- **クリーパー**: 近ければ1回叩いて離脱、中距離は後退、8m 以上（段差時 6.5m）で射撃。近づかない。
- **低体力**: HP40% 未満で撤退状態、60% で解除。6m 以内に2体以上かつ3m 以内に敵がいなければ離脱、それ以外は押し切る（ユーザー確認済みの方針）。
- 防具の自動装備（`src/armor.js`）、食事との両立、待機保護との切替。
- ユーザーは「速く、積極的に戦う」挙動を望んでいます。判断を遅くする変更や、安易な撤退を増やす変更は避けてください。
- 旧来の `src/combat.js` は自律実行の `defend`（剣）経路です。
- 戦闘が自分で接近・射線確保の移動をしている間は、被弾しても移動を止めない（`state.combatMotion`。低体力・死亡時の停止は維持）。毒などの継続ダメージで接近が毎回中断されないため。
- 動く弓標的は、射線の判定が揺れても最大0.9秒・8回まで撃ち直しを続ける（SIGHT_STALE の猶予）。
- 弓の引き絞り解除でホットバーを切り替えたときは、その選択をローカルにも記録する（サーバーは自分の mob_equipment を返さないため。ずれると「ツルハシ表示なのに素手速度」になる）。
- 「HP60%未満で遠距離の敵が複数なら離脱」は試したが、開けた場所で逆効果だったため採用していない。

### 露天掘りモード（仕様書 v1.2 第1〜4段階）

指定チャンクを上の層から1層ずつ掘り下げ、指定チェストへ搬入します。ターミナルの `/quarry` か、`POST /action` の `group: "quarry"` で操作します。

```
/quarry plan here chest=10,64,-3     # 現在のチャンクを計画（ワールドは変更しない）
/quarry plan <cx> <cz> [<cx2> <cz2>] [bottom=Y] [top=Y] [chest=x,y,z] [combat=off]
/quarry start | pause | resume | stop | cancel | accept | status | load <jobId>
```

- 通常の採掘のみ。1回最大8ブロック、30秒以内に回収。道具は採掘可否 → ドロップ方針 → 耐久で選び、耐久の予備（最大値の10%か8回の多い方）を残す。
- 鉱石・コンテナ・スポナー等や拠点の保護セルは壊さず保留。水・溶岩は塞ぐ（外周1ブロックは止水用の設置のみ許可）。
- 体力70%/40% で退避、90% で再開。戦闘連携は近接10m・クリーパー16m・遠距離24m で開始、中断地点から水平8m 以内でのみ戦う。
- ジョブ状態は採掘ごとに `.local/quarry/<jobId>.json` へ保存。ホットリロードでは一時停止して自動再開。Bot の再起動後も、完了・手動停止でない最新のジョブを15秒ごとのタイマーで読み込み、復旧できる停止理由なら再開する。
- ACTION_FAILED は30秒おきに最大3回自動再開（最後の自動再開から10分で回数リセット）。歩行経路のない立ち位置は回避して再計画。
- 回収は期限（20秒）・保留数（24個）・層の移動時。拾える範囲（左右1.3・上下0.5）に入る足場を選び、拾えないアイテムは60秒スキップ。採掘は8ブロックを1回の指示にまとめる。
- 一時的な採掘拒否（静止を確認できない・面が見えない）はセルを保留にせず立ち位置を変える。同じセルが3回拒否されたら保留し、その層を離れる前に1回だけ再挑戦する。
- 再開は最も深く掘った層から。それより上の層の残りは `EARLIER_LAYER_LEFTOVER` として記録し、引き返して掘らない（後でまとめて対応）。
- 預け入れで穴を出る前に、チェスト周囲24mにウィッチがいるか敵が3体以上なら最大20秒だけ待つ。
- チェストがすべて満杯なら、登録済みチェストの周り6マス以内に新しいチェストを置く（候補8か所まで試す）。歩いて行けないチェストは満杯扱いで飛ばす。
- 露天掘りの移動・採掘の窓口は呼ぶたびに現在のものを使う（テレポート・リスポーン後も止まらない）。
- 階段は、前の穴の下から始めるジョブでも本当の地面まで届くよう計画する。サーバーに持ち替えを拒否された・採掘が道具の想定より極端に遅い（SLOW_BREAK）時は、持ち物をサーバーから取り直す。
- 死亡数には「一時停止中に再接続で life が変わった」記録（whilePaused）も含まれる。実際の死亡はリスポーンのログで確認する。
- 実行中は自律実行と手動操作を止める。`/stop` は露天掘りも一時停止。
- 2026-11-04〜05 に実 Realm で長時間運転（チャンク (-4,2)、y63→y-59 の途中、5,000ブロック以上）。昼固定はランタイムの監視で再設定される。

## ディレクトリ構成

```
src/            Bot 本体（約110モジュール）
  main.js         エントリポイント
  host.js         接続・認証・ターミナルコマンド（/status /auto /stop /reload /quit /quarry）。変更時は再起動が必要
  runtime.js      ホットリロードされる行動の中心（約550KB）
  api.js          ローカル HTTP API
  quarry-*.js     露天掘りモード（region / rules / inventory / planner / combat-bridge / job / runtime-adapter / cli）
scripts/        keep-alive.js（再接続監視）、dashboard.js（:3001）、check.js（構文確認）
dashboard/      ダッシュボード HTML
test/           node --test のテスト。fixtures/ に BDS 実測データ（数MB 級）、helpers/quarry-sim.js
docs/           combat-mode-spec.md（戦闘仕様）、bedrock-*.md（参考資料）
.local/         実行時の状態・ログ・進捗記録（Git 管理外）
.auth/ .env     認証キャッシュと設定（Git 管理外。読まない・コミットしない）
backup/         変更前ファイルのバックアップ（Git 管理外）
```

## 実行とテスト

Node.js **24 以降**が必要です（`--env-file-if-exists` を使用）。

| コマンド | 内容 |
| --- | --- |
| `npm install` | 依存の導入（prismarine-physics は GitHub のコミット固定） |
| `npm run auto` | 接続して自律実行。異常終了時は自動再接続 |
| `npm run auto:once` | 自律実行を1回だけ（再接続なし） |
| `npm start` | 接続のみ。自律実行はターミナルで `/auto` |
| `npm run realms` | 参加可能な Realm の一覧 |
| `npm run dashboard` | 進捗画面とライブログ（http://127.0.0.1:3001、`/logs`） |
| `npm run check` | `src/*.js` の構文確認 |
| `npm test` | `node --test` による自動テスト |

設定は `.env`（`BOT_PROFILE`、`REALM_ID`、`MINECRAFT_VERSION`、`API_PORT`）。雛形は `.env.example`。

テストに関する注意:

- 一部のテストは Git 管理外の `.local/*.cjs` や未コミットのモジュールに依存しており、ユーザーの PC 以外では全件は通りません。**変更前から失敗しているテストがある**ため、変更の前後で失敗数を比較し、新しい失敗を増やしていないことを確認してください。
- テストの合格はゲーム内での達成の証明ではありません。

## 作業時のルール

- **サーバー由来の情報だけを成果とする**: 入力の送信、時間経過、プレビューの成功、予測位置への到着、ドロップの消滅だけで成功扱いにしない。回収・クラフトは実際の持ち物の変化、採掘は受信した空気、設置はブロック更新と消費の両方で確認する。ダイヤの完了判定はサーバーから届いた持ち物にダイヤがある時だけ。
- **未知を安全と見なさない**: 未受信の地形・未確認の持ち物・一覧にない敵は安全側に倒す。
- **再起動が必要な変更を明示する**: `host.js`、`entities.js` など接続側で読み込むモジュール、認証・通信、依存、`.env` の変更はホットリロードされない。ユーザーに再起動が必要と伝える。
- **既存コードを変える前にバックアップ**: ローカル作業ではこれまで `backup/<内容>-<日付>/` に変更前のファイルを保存している。
- **秘密情報**: `.auth/`、`.env` は読まない・出力しない・コミットしない。リポジトリは公開です。
- **ユーザーとのやり取りは日本語**で、時刻は **JST（UTC+9）** で書く。
- ローカル作業フォルダ（Windows の `G:\Projects\MinecraftBot`）は Git 管理ではなく、GitHub（`YuK1Game/minecraft-mining-bot`）へは手動で同期している。どちらが新しいかを確認してから作業する。
- 参考実装や通信仕様は `docs/bedrock-bot-references.md`、`docs/bedrock-references.md` を参照。
