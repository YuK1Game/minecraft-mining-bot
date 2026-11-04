# 統合版 Bot の実装参考

確認日: 2026-11-01。対象は統合版 1.26.60 の Realms に別アカウントで接続する Bot。README の機能一覧と、実際の実装・検証範囲を区別する。

## 通信と Realms

- [PrismarineJS/bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) は統合版の通信と認証を提供する。現在の Bot でも利用している。
- [接続 API](https://github.com/PrismarineJS/bedrock-protocol/blob/master/docs/API.md) は Realm ID や招待コードを指定する方法を説明している。対象アカウントは Realm の所有者または招待済みである必要がある。
- [Mojang の統合版プロトコル資料](https://mojang.github.io/bedrock-protocol-docs/) は、移動、サブチャンク、採掘を確認するための一次資料。対応するゲームバージョンの資料を選び、実際のサーバーでも検証する。

## 自律行動の参考

- [Pix3lPirat3/mineflayer の Bedrock アダプター](https://github.com/Pix3lPirat3/mineflayer/tree/b24015aeeec68a5c94f54444f104f0e563595a30/lib/bedrock_plugins) は現行構成に近い参考実装。MIT。[提案 #4145](https://github.com/PrismarineJS/mineflayer/issues/4145) は公式 BDS での検証を報告しているが、公式 Mineflayer への採用済みを意味しない。
  - [地形受信](https://github.com/Pix3lPirat3/mineflayer/blob/b24015aeeec68a5c94f54444f104f0e563595a30/lib/bedrock_plugins/blocks.js#L234): 成功したサブチャンクを順次利用し、失敗した応答と全空気の成功応答を区別する。
  - [採掘](https://github.com/Pix3lPirat3/mineflayer/blob/b24015aeeec68a5c94f54444f104f0e563595a30/lib/bedrock_plugins/digging.js): 入力フレームに採掘動作を載せ、ブロック更新を待つ構成が参考になる。ただし同実装の未取得ブロックを空気とみなす完了判定は採用しない。
  - 現在の依存ライブラリも同作者の [prismarine-physics 統合版ブランチ](https://github.com/Pix3lPirat3/prismarine-physics/tree/e6181bf79c19db3eafc8a589e984f7ba623556f6) に固定済み。[PR #152](https://github.com/PrismarineJS/prismarine-physics/pull/152) は実験段階で、完全な水中物理の保証ではない。
- [oomph-ac/bedsim](https://github.com/oomph-ac/bedsim/tree/9c12b344afdea7939b983fa15a762592aa179351) は Go 製の統合版移動シミュレーター。MIT。水、衝突、入力の再現を照合する参考。Node.js の依存として導入していない。通常の浮上移動と泳ぐ姿勢を分け、速度定数だけを変更しない。
- [airscro/mineflayer-for-bedrock](https://github.com/airscro/mineflayer-for-bedrock/tree/46d7b3640ba8376b53bcb919b75b622bd1fe1449) は統合版の bedrock-protocol を使う開発中のフレームワーク。package.json は MIT と記載するが、確認時の tree に独立した LICENSE 本文がなく、直接コピー時は条件を再確認する。
  - [敵の追跡](https://github.com/airscro/mineflayer-for-bedrock/blob/main/lib/plugins/entities.js): 受信したエンティティの追加、移動、削除から周囲を把握する構成を参考にする。
  - [経路探索](https://github.com/airscro/mineflayer-for-bedrock/blob/main/lib/plugins/pathfinder.js): A* の目標判定や、歩行・段差・落下・水中移動の候補分けが参考になる。ただし取得できないブロックを通行可能として扱う箇所があるため、そのまま移植しない。
  - [採取](https://github.com/airscro/mineflayer-for-bedrock/blob/main/lib/plugins/collect_block.js): 対象発見、接近、採掘、ドロップへの移動という段取りが参考になる。ただし一定時間の待機後に回収数を増やすため、ダイヤ獲得の判定には使わず、サーバーから届いた持ち物を確認する。
  - [防衛](https://github.com/airscro/mineflayer-for-bedrock/blob/main/lib/plugins/guard.js): 敵の距離に基づく検知・対象選択が参考になる。一方、近くの敵を追跡して攻撃する単純な処理であり、クリーパーや複数の敵を含む現在の状況で安全とは未検証。
  - 実コードでは Realm 設定の引き渡しと現行サブチャンク要求がなく、移動入力の形式も現行版と一致しない。接続・移動部分を置き換える候補にはしない。検索に残る旧 torzodmc URL は確認時 404。
- [TheNotEasy/mineflayer-bedrock-public の Bedrock ブランチ](https://github.com/TheNotEasy/mineflayer-bedrock-public/tree/8c731f53538068a136ea55d08b512ee5f55d7d26) は MIT。ただし master と Bedrock ブランチは別物。確認した対応上限は 1.21.80 で、採掘・クラフト・設置に未接続部分があるため、現行 Realm 用には導入しない。
- [bottleofarts-dev/bedrock-bot](https://github.com/bottleofarts-dev/bedrock-bot) は統合版向けの採掘・戦闘 Bot。検出した敵の移動量が大きい場合に経路を再計算する [戦闘処理](https://github.com/bottleofarts-dev/bedrock-bot/blob/main/src/combat.js) が参考になる。装備や敵の状態の確認は現在の Bot の条件を維持する。
- [miked06/baritone-bedrock](https://github.com/miked06/baritone-bedrock) は Windows 版統合版ゲーム内で動く実装。鉱石探索、適切な高度への下降、枝掘りなどの考え方が参考になる。DLL をゲームに注入する方式で対応バージョンも限定されており、独立アカウントで Realms に接続する現在の構成とは異なる。ライセンスは LGPL-3.0。

## 現在の実装への適用方針

1. 既存の統合版接続と、実際に受信した敵・地形・持ち物の情報を使う。
2. 未受信の地形や不明な敵を安全と推測しない。移動候補は実際の統合版サーバーで段差、水、複数の敵を再現して確認する。
3. 採掘の成否はブロックの変化に加え、サーバーが通知した持ち物で確認する。Realm 上のダイヤを確認するまでは目標未達成とする。
4. 外部コードをコピー・依存関係として導入する場合は、対応バージョン、ライセンスと実際の挙動を確認する。導入済みと明記した物理依存以外は設計上の参考。

## 照合からの反映

- `src/input-replay.js` / `src/movement.js`: [Mojang の移動仕様](https://github.com/Mojang/bedrock-protocol-docs/blob/main/additional_docs/PlayerMovementOverview.md) に沿い、補正対象の入力時刻へ戻して送信済み入力を現在まで再現する。サーバー受信位置と予測位置は分離する。bedsim の状態再現処理とも照合し、自分のテレポート・リスポーン確定・次元変更・切断では停止中も履歴を破棄するよう補強。他プレイヤーの更新と通常の補正履歴は維持する。
- `src/world.js`: 上記 Bedrock アダプターの地形受信処理と照合し、失敗応答を受信成功と扱わない。調査要求は未試行→最も古い試行の順に変更し、失敗時は 5・10・20・30 秒（上限）の待ち時間を設けた。近傍の移動用要求は従来の 5 秒周期を維持し、未受信の地形は未知のまま扱う。履歴は件数制限と次元変更時の初期化で制限する。外部コードの直接コピーはない。
- Java 版の通常 Mineflayer、Baritone、Voyager を統合版対応済みとして導入しない。統合版対応を名乗る Fork でも、対象ブランチ・ゲーム版・実コードを個別に確認する。

## Skeleton escape model — 2026-11-01

- [Mojang's Bedrock Skeleton behavior](https://github.com/Mojang/bedrock-samples/blob/main/behavior_pack/entities/skeleton.json), checked on this date, sets ranged attack maximum distance to 15 in the base, normal and hard configurations. The sampled format version is 1.26.50.
- [Microsoft's ranged attack reference](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/entityreference/examples/entitygoals/minecraftbehavior_ranged_attack?view=minecraft-bedrock-stable) defines `attack_range` as the distances within which that behavior can attack.
- Model inference: retain the bot's 18-block threat classification while testing an explicit secondary-Skeleton escape floor of 17, with at most one block of concession. This remains two blocks beyond the sampled ranged behavior; it does not establish the behavior of server customizations or arrows already in flight.
- Captured-terrain counterfactual: yaw0/drive9 first lands fully supported after 14 frames; the minimum Skeleton range is 17.05694. With Creeper pursuit at 0.1m/tick, its range is 5.20835 at landing and 4.80710 after coast. This 17-block concession was not implemented; it remains an offline experiment.

## User behavior rules — 2026-11-01

- Automatic `online_learning` uses the existing buffered 14-block drowned / 18-block skeleton profile at positive health, and a 14-block witch profile. The [pinned drowned sample](https://github.com/Mojang/bedrock-samples/blob/15701fa9c13923f12662984c32c124327e40e3d3/behavior_pack/entities/drowned.json) has ranged maximum10; the [witch sample](https://github.com/Mojang/bedrock-samples/blob/15701fa9c13923f12662984c32c124327e40e3d3/behavior_pack/entities/witch.json) has attack_radius10. These are avoidance choices with margins, not guarantees. Extra work margin is0 in this explicitly selected mode; manual balanced mode retains its previous rules.
- Melee selects a confirmed owned Bedrock weapon, requests one native stationary hop, and attacks during a fresh receipt-backed descending frame. The server determines critical damage and target death.
- Ranged attacks use normal Bedrock charge/release and observed projectiles; tipped arrows and confirmed Infinity are handled without inventing consumed arrows.
- Portable beds require confirmed placement ownership, own sleep/wake metadata and actual server day before retrieval. Only the bot's confirmed bed is mined.
- Water recovery follows its scoped active destination; otherwise it selects a received shore whose feet height equals the sea surface. Unsupported deep/vertical targets explicitly require a dedicated route.
