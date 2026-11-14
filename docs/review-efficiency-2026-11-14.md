# 実装の共通化・重複処理削減（2026-11-14）

> 追記：この報告は03:21 JST時点の記録です。残っていた4件への追加改修、PR #72のマージ、その後のPR #76と最終比較は[追加報告](review-efficiency-followup-2026-11-14.md)を参照してください。以下の過去の結果は当時の記録として保持しています。

## 対象

レビューで挙がった7項目を改修した。未知の情報と操作の所有権を維持し、同じ同期判断中に繰り返していた観測・計算を減らす変更である。

- 基準commit: `83d3a7895c04cc47858870050a7187480e17002b`
- 公開した実装commit: `0fe492b012affc0b010c0910c10e0aad2161d522`
- ローカル検証commit: `00b4f45f29feed0a0e4cc73ef3b6d0593127ed92`
- 両者の実装tree: `335aad32988223d36accd8e981a301d917edeeed`（Gitで追跡する内容の一致を確認済み）
- [PR #72](https://github.com/YuK1Game/minecraft-mining-bot/pull/72)

作業中にmainへ入ったトーテム・食事・箱の回収前保存・補給箱bindingの再発見・event loop停止の記録は基準側の変更として取り込んだ。競合したRuntimeと戦闘coordinatorは両方の処理を保持した。これらを今回の効率化による成果として数えていない。

## 実装

| 項目 | 主なファイル | 変更と保持した条件 |
| --- | --- | --- |
| 未知の到達判定 | [threat-reachability.js](../src/threat-reachability.js) | 身体・足場が未受信なら探索の不確実性を保持。到達可能はtrue、既知の遮断はfalse、不明はnull。既知の水が自分を支持する条件も維持 |
| モブ定義 | [mob-catalog.js](../src/mob-catalog.js)、entities/threats/combat系 | 観測分類・危険評価・戦闘方針・攻撃経路・認識距離の元定義を集約。55種の既存戦闘プロファイルを維持し、shulkerの受信分類を接続。中立・未知の種別を自動で敵対扱いしない |
| 射線の重複 | [combat-exposure.js](../src/combat-exposure.js)、[combat-coordinator.js](../src/combat-coordinator.js) | 同期判断1回の間だけ地形の射線読取を共有。所有権・HP・敵対性・移動状態などの判断結果は共有しない |
| 収納地点の計画 | [quarry-portable-storage.js](../src/quarry-portable-storage.js) | 計画中のentity一覧を1回、移動プレビューを立ち位置ごとに1回取得。同じ候補選択を保ち、実行前には再確認 |
| 入れ子操作の中断 | [operation-scope.js](../src/operation-scope.js) | 外側の採掘と内側の装備操作のpending frameを分ける。子の完了で外側の中断先を失わず、owner tokenが一致する操作だけを停止 |
| 軽量な状態取得 | [chest.js](../src/chest.js)、[runtime-observation-views.js](../src/runtime-observation-views.js)、[runtime.js](../src/runtime.js)、[furnace.js](../src/furnace.js) | メタデータだけ必要な判定にstatusを使用。同じ判断内のcontroller snapshotは1回。内容・NBT・転送確認には完全なsnapshotを残す |
| 再同期待機 | [inventory-refresh.js](../src/inventory-refresh.js)、quarry-supplies/v22-chest-work/Runtime | 共有の最終要求時刻から残り時間を求める。100ms刻みの中断・scope確認と、待機ループの45秒上限を共通化。ヘルパー1呼び出しあたりrate limitの再試行は最大1回 |

### 再利用の範囲

射線のキーにはscope、Botと標的の正確な座標、runtime/unique ID、種別・次元、world revisionと読取関数の一致を含める。world revisionが得られなければ再利用しない。`withDecision()` の同期呼び出し終了・例外時に破棄し、Promiseを返しても次のawaitへ持ち越さない。次のtick・継続ガードでは観測をやり直す。

収納の共有も同期の`planSite()`内だけで完結する。計画後にactorが現れる結合テストでは実行時の設置を拒否する。シュルカーを壊してから実受信で回収が確定するまでの戦闘保留も維持している。

### 再同期の互換性

`RESYNC_RATE_LIMIT` に`retryAfterMs`が明示されていればその値（0を含む）を使用する。hintがなくてもhookが正の残り時間を返せばその時間を待つ。待ち時間を報告できずhookが常に0の旧ポート、またはhookを持たない旧ポートは従来どおり20秒待つ。

再試行の上限は共通ヘルパー1呼び出しの範囲であり、補給処理全体の回復・再開回数を表すものではない。45秒上限は待機ループの制限で、refreshInventory自体の応答待ちを45秒で打ち切る保証ではない。送信成功や古い受信を、新しい在庫確認の成功証拠にしない。

最初の全件比較で旧ポートの互換性回帰を検出し、既存テストの期待値を変更せず修正した。helper/supplies/v22/auto-recoveryの関連4ファイル89件が成功した。

## 同じfixtureで確認した処理量

実処理モジュールを接続したオフラインの結合fixtureでの回数。実Realmの速度倍率やCPU削減率へは換算しない。

| 条件 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 収納地点を1回計画する移動プレビュー | 232回 | 29回 |
| 同じ収納計画のentity snapshot | 233回 | 1回 |
| canReload 100回での完全chest snapshot | 100回 | 0回 |
| 同条件の完全crafting snapshot | 100回 | 0回 |
| 同条件のcombat snapshot | 300回 | 100回 |
| 同期判断内で同じ10m射線を2回評価するblock read | 80回 | 40回 |

同じ立ち位置・設置セルを選択すること、次の判断では新しい状態を読むこと、実行前の再確認を確認した。再同期fixtureでは、最後の要求から10秒経過していれば残り10秒だけ待ち、要求は1回だった。

主な結合テストは [Runtime](../test/review-runtime-efficiency.test.js)、[Combat](../test/review-combat-integration.test.js)、[Storage](../test/quarry-storage-efficiency.test.js)、[Operation scope](../test/operation-scope.test.js)、[Inventory refresh](../test/inventory-refresh.test.js)。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| ローカル構文確認 | 697ファイル＋ダッシュボード内1スクリプト成功 |
| ローカル安全回帰 | 1,417件：1,367成功、49失敗、0取消、1スキップ |
| ローカル改修版の全件 | 5,376件：4,929成功、441失敗、4取消、2スキップ |
| ローカル最新基準との最終比較 | 実行環境の障害で完了未確認 |
| CIのQuarry v2.2重点検証 | 122件すべて成功 |
| CIの安全回帰（Ubuntu / Windows） | 両方とも1,417件：1,367成功、49失敗、0取消、1スキップ。両OSの失敗したテスト名は一致 |
| CI全件・基準83d3a78 | 5,409件：4,874成功、530失敗、3取消、2スキップ |
| CI全件・改修版0fe492b | 5,456件：4,994成功、456失敗、4取消、2スキップ |
| CIの厳密な失敗差分比較 | **未合格。failure type/codeを含む差分が4件残る** |

CIでは両版を同じNode v24.22.2と依存で比較した。失敗件数の減少を、そのまま修正した不具合数とはしていない。ローカルとCIではNodeのpatch versionや実行環境が異なり、総テスト数も異なるため別々に掲載している。

証跡: [全件比較・安全回帰のCI](https://github.com/YuK1Game/minecraft-mining-bot/actions/runs/43478302209)、[重点検証のCI](https://github.com/YuK1Game/minecraft-mining-bot/actions/runs/43478302355)、[機械可読の検証記録](review-efficiency-2026-11-14-results.json)。全件CIのcomplete-suite-comparison artifactには元のTAPと比較JSONが保存されている。

### 実行条件と実行環境の中断

ローカルはNode v24.22.1。コードを固定して構文確認・安全回帰の後、改修版と基準版を同じcheckoutで順番に実行した。ローカルでworktreeは作成していない。全件の両版には同じ`--test-force-exit --test-concurrency=2 --test-timeout=30000 --test-reporter=tap`を使用した。

既存の失敗テストがinterval/pollingを残すため`--test-force-exit`を使用している。失敗や30秒timeoutは結果に残し、テストは省略していない。比較スクリプトのrunSuiteにも同じオプションを反映した。

2026-11-14 03:12 JSTごろ、ローカル実行環境が利用不能になった。改修版の全件結果は取得できたが、その後の基準版の完了、作業ブランチへの復帰、最終JSONの回収は確認できない。ローカル最終比較を完了扱いにしていない。改修コードはその前にGitHubへ保存済みだった。

GitHub ActionsはNode v24.22.2を使用。既存workflowで動いていたCIを読み取り、結果を回収した。ローカルとCIの集計は混ぜていない。環境障害後に新しいコード改修は行っていない。この文書だけを実装commitの後へ追加している。

### 既存の経路・退避テスト

旧基準9e5ced5の完全比較では、当初の新しい失敗差分7件のうち、再同期互換性1件と断片eval/ソース文字列依存のテスト2件を修正した。残る4件は基準から失敗している同じテストだった。

| 対象 | 旧基準での失敗 | 改修後に確認した内容 |
| --- | --- | --- |
| bounded jump: smooth_005 | 初回jump前にIdle escape danger changed | 初回jump後、次の経路をIdle escape remaining path danger changedで拒否。表面のTypeErrorはテストが未取得resultを参照した二次エラー |
| bounded jump: smooth_010 | 同上 | 同上 |
| healthy unarmed respawn ledge | no_known_away_route | 追跡済み個体が安全viewから除外され、Partial escape actor no longer observedで停止 |
| real supervisor healthy unarmed ledge | observing / escapes=0の期待値不一致 | 固定Dateの既存fixtureで30秒timeout。内部の全因果は未確定 |

threat-reachabilityだけを旧基準へメモリ上で差し替えると4件とも基準側の失敗へ戻り、到達判定の変更との関連を確認した。bounded jumpの2件では初回jump後の残余経路の拒否へ進んだことを確認した。supervisorのtimeoutの内部因果は未確定である。

ledgeではraw catalogueに同じUIDの個体があり、既知の射線遮蔽で安全viewから除外されていた。個体の観測と危険評価の区別には改善余地がある。今回、このRuntime/Guardの挙動、距離下限・残余経路・未知の拒否条件は変更していない。

最新基準83d3a78とのCI比較でも、差分として列挙されたのは上記4件と一致した。厳密な比較の終了コードは失敗であり、差分ゼロ・全件成功とはしていない。旧基準での診断結果と、今回のCIで得た失敗シグネチャは区別して記録している。

## 反映と残る確認

entities.jsとそこから参照するモブ定義は接続側で読み込まれるため、受信分類変更の反映にはBot本体の再起動が必要。Runtimeのホットリロードだけでは分類変更まで反映されない。

実Realmでの長時間採掘・戦闘・箱回収と、実際のtick時間・CPU/メモリ負荷は未検証。この作業ではmainへのマージと稼働Botの再起動・実Realm操作を行っていない。

## 工程別の時間

集計時点：2026-11-14T03:21:21+09:00。開始は2026-11-14T02:01:49.764073+09:00。この時点までの時計上の経過は **1時間19分31秒**。

| 工程 | 担当分を合算した時間（並行作業を含む） |
| --- | ---: |
| 調査 | 23分27秒 |
| 改修・記録作成 | 26分25秒 |
| テスト・検証待ち・結果確認 | 1時間14分37秒 |
| 合計 | 2時間4分29秒 |

02:59:39 JST時点の終了済み工程集計に、rootの最終検証工程（02:58:23.137090〜03:20:13）と、その後03:21:21までの記録作成を加算した。03:21:21以降の文書公開・最終応答の時間はこの表に含めていない。

時刻はJST。工程時間はCPU時間ではなく、待機・結果確認を含む実経過時間。担当の合算には並行作業を含むため、時計上の経過とは異なる。rootの改修工程に含まれる短い関連テスト、最終検証待ち中のPR・報告書準備など、混在区間は推測で分割していない。中断した検証に費やした時間は含むが、検証完了とは扱っていない。

工程の元記録はローカルの.local/development-timing/*.jsonl。環境障害で終了行を追記できないため、最終検証工程の終了はこの報告の確認時刻で補足している。追加の報告書レビューは開始行のみ保存され終了未記録なので、担当別の時間には推定加算していない。未測定の準備・引き継ぎ時間も推定していない。
