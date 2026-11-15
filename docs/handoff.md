# 引き継ぎ資料（2026-11-11 21:30 JST）

作業ルールは `AGENTS.md` / `CLAUDE.md` を必ず読んでから始めること。秘密情報（`.auth/`、`.env`）は読まない・出力しない。時刻は JST、報告は日本語。

## 1. いまの状態

| 項目 | 状態 |
| --- | --- |
| main | `6bb69df`（origin/main と一致）。v2.2（PR #55）を含む |
| Bot | 接続中（管理画面 `npm run dashboard` の子プロセス、http://127.0.0.1:3001）。位置 (-94.5, 97, -46.5)＝チャンク (-6,-3) の地上、HP20、耐性効果中。持ち物はホットバー0の弓（エンチャントなし）だけ |
| ローカルAPI | http://127.0.0.1:3000（`POST /action` に `{group, method, args}`、`Content-Type: application/json` 必須） |
| 露天掘りジョブ | 実行中のジョブなし。旧ジョブ `quarry_c7871ddf`（チャンク (-5,-3)、Y6 まで掘った検証ジョブ）はキャンセル済み（FINISHED） |
| 地上ラージチェスト | (-94,97,-47) と (-93,97,-47)。v2.2 初期セットのうち弓以外（貨物紫22・補給4〔青ツルハシ/空色シャベル/茶土/黄トーテム〕・剣・防具4・パン・矢）が入っている。一時箱の位置 (-96,97,-47) は空気 |
| v2.2 リセット記録 | `.local/loadout-reset-v22/<world>.json` が「弓の主手を確認」で failed のまま残っている → 次の preview は `RESET_RECOVERY_REQUIRED` になる |

## 2. 直前の作業（未完了）

1. **ブランチ `fix/v22-bow-hand-retry-20261111`**（push 済み、main 未 merge）
   - 内容: v2.2 リセットで弓を主手に選んだ直後の `/testfor @s[hasitem=…mainhand]` が `commands.generic.noTargetMatch` を返して停止した件（実Realm 21:12）。旧リセットと同じく、明示的な否定応答なら選び直して最大3回まで再確認する。主手確認前に `/enchant` は送らない。
   - 検証: `npm run check`、`npm run test:review` 679/679、focused（`test/quarry-v22-*.test.js test/quarry-four-layer.test.js test/loadout-*.test.js`）125/125 成功。`test:compare -- 6bb69df` 完了（21:40）: 新しい失敗は既知の不安定テスト `runtime-idle-escape` の1件だけ → merge してよい状態。
2. **merge 後の手順**
   1. main を fast-forward → push → Bot を再起動（`POST /disconnect`（JSON）→ 管理画面で「一覧取得」→ YuK1Game を選択 →「接続」）。`loadout-runtime-adapter.js` は遅延読み込みのため、ホットリロードでは反映されない。
   2. 地上チェストの中身を受信で確認（`chest.open` → `chest.snapshot`）。弓以外の初期セットが入っているはず。
   3. 復旧: 中身を空にする（通し番号で `/replaceitem block -94 97 -47 slot.container N minecraft:air 1`）→ 空を受信で確認 → `/execute if block <pos> minecraft:chest run setblock <pos> minecraft:air replace` で2つ撤去 → 失敗記録を `.recovered-<日時>.json` に改名して退避。Bot の弓は `/replaceitem entity @s slot.hotbar 0 minecraft:air 1` で消す。いずれも「準備段階の手作業」として記録・報告する。
   4. 立ち位置 (-95,97,-47) で `loadout preview` → 管理画面の「↻ 初期セット」→「リセットする」。無限エンチャント（`/enchant @s infinity 1`）は実Realmで未検証。結果を報告すること。
   5. 計画（チャンク (-6,-3)、底は Y-59、既定設定＝v2.2 active/four_layers）→ 開始 → 監視。停止したら即報告、止まらなくても30分ごとに Y と採掘数を報告。

## 3. 今日わかった実Realmの事実

- ラージチェストへの `/replaceitem block` は、どちらのブロックに対しても 54枠の通し番号で扱われる（片側27枠ずつではない）。`6bb69df` で判定・対応済み。
- 死亡したまま再接続してリスポーンすると、チェスト操作に必要な「生存回」の確認が取れず、`チェスト操作には…lifeの確認が必要です` で拒否される。生きた状態で再接続すれば解消（コード修正は未実施）。
- 昼固定の監視は、ワールド時刻の受信があるときしか働かない。再起動後に夜になり、空手・防具なしで待機していた Bot が 20:49 に死亡した。待機時は短くする／`/effect @s resistance` を付ける／`/time set day`。
- `/tp` は「閉じ込められた時の最後の手段」かつ準備段階の介入として記録すること。
- 同じアカウントで別の Bot（Codex 側）が動くと位置が動く・ログが混ざる。開始前に `node` プロセスを確認すること（13:09〜13:16 に混入あり）。

## 4. 本日 main に入った主な変更

| commit / ブランチ | 内容 |
| --- | --- |
| `e35db7d` feat/quarry-isolation-plan-20261111 | 孤立防止: 作業層の下8層の地形を先に受信、掘る順で降り口を残す、空洞の上の層は掘る前に `LAYER_ISOLATION_RISK` で停止 |
| `5db6e8a` fix/quarry-supply-room-20261111 | 補給の空き枠確保で、24個までの束を掘った後のマスに戻す（別の立ち位置も使う） |
| `f93c00c` PR #55 v2.2 | 地下完結収納・鉱石採掘・4層回収・ラージチェスト初期セットほか（別の書き手が実装）。テストを v2.2 方針に合わせて修正 |
| `7e2deac` fix/v22-reset-finished-job-20261111 | キャンセル済み（FINISHED）ジョブの記録が v2.2 リセットを妨げないように |
| `6bb69df` fix/v22-chest-combined-slots-20261111 | ラージチェストの通し番号の判定 |

未 merge で残すブランチ: `feat/quarry-safe-drop-20261111`（不採用の作りかけ）、`feat/quarry-v22-optin-20261111`（不採用の退避）。

## 5. 検証の決まり

- テストは時間上限付きで実行（個別 `node --test --test-timeout=60000`、全体最大15分、`test:compare` は最大40分）。複数の全体テストを同時に走らせない（負荷で止まる・不安定化する）。
- 毎回: `npm run check`、`npm run test:review`、v2.2 focused、`npm run test:compare -- <main の SHA>`（新しい失敗が増えていないこと）。
- force push・rebase はしない。merge コミットで統合する。この環境には `gh` がないので、PR の作成・本文更新はできない（コーディネーター側で実施）。
- 作業用 worktree（`G:\Projects\mmb-*-wt`）は node_modules をメインへのジャンクションにしている。削除するときは、先にジャンクションだけを外してから `git worktree remove`（`--force` なし）。

## 6. 残っている課題

- v2.2 の実Realm検証（無限弓の付与、54枠からの受領・装備、トーテム補充、4層回収、最終格納とログアウト）。
- (-5,-3) の穴の中 (-65,6,-48) に、旧ジョブの補給箱（青）が置いたまま残っている。
- 死亡後の再接続で生存回が確定しない件のコード修正。
- 昼固定の監視を、時刻の受信がなくても再接続時に一度は設定するよう改善。
- 二重接続の排他ロック・操作APIの呼び出し元の記録（ユーザー確認待ち）。
- 管理画面の「採掘開始」ボタンが効かなかった件（11/11 の検証はローカル API から開始した）。
- 旧ジョブ quarry_1dcad7f8（PROTECTED_ORE 115）と quarry_10676559 の例外受諾。受諾はユーザーの操作に限る。
- 弓で急な上向きの角度を撃つと RANGE になる件。
- 孤立防止の降り口の候補に、B2（壁に沿って階段状に掘り下げる）をまだ加えていない。

## 補足（作業の進め方）

- ユーザーの方針は「今後は私の判断は不要」。作業上の判断は自分で行い、結果を報告する。ただし、採掘の底を Y-59 より浅くするなど、目標そのものを変える判断はユーザーに確認する。
- ユーザーとのやり取りは日本語で、時刻は JST で書く。停止したら、すぐに原因を報告する。
- 既知の不安定なテスト: `test/runtime-idle-escape.test.js`、`test/idle-safety-armed-continuation.test.js`、quarry-job の「full chest」（単独で実行すると成功する）。test:compare は1本ずつ実行する。
