# 統合版 Bot の参考実装

確認日: 2026-10-31。Realm で使うため、統合版の通信方式と実ワールドでの確認を優先する。

## 接続と採掘の仕様

- [PrismarineJS/bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) は統合版の通信・認証ライブラリ。この Bot でも使用している。Bot の移動や生存行動を完成させるライブラリではない。
- [Mojang: Server-authoritative block breaking](https://mojang.github.io/bedrock-protocol-docs/guides/block-breaking-overview/) は統合版の採掘処理の公式説明。破壊要求やクライアント側の予測を実際の採掘成功とみなさず、サーバーからのブロック更新と持ち物の変化を確認する。文書の表示対象バージョンと Realm のバージョンは別途確認する。

## 自律 Bot の設計例

- [chase-west/minecraft-bot](https://github.com/chase-west/minecraft-bot) は統合版の通信、ワールド観測、移動、採掘、戦闘、目標選択を分けた実装。調査時のコミットは `f5c5d33eeef525c4f5333d41127c32503fabecab`、MIT License。作者の説明では Realm 認証には対応していないため、接続部分の置き換えには使えない。
- [経路探索](https://github.com/chase-west/minecraft-bot/blob/f5c5d33eeef525c4f5333d41127c32503fabecab/src/pathfinding/astar.ts) は歩行・ジャンプ・落下・斜め移動の候補を分ける。特に斜め方向は、両側の通路を確認して角への衝突を避ける設計が参考になる。現在の Bot の探索と物理予測も含め、実地確認前に仮想地形で比較する。
- 同実装の[地形判定](https://github.com/chase-west/minecraft-bot/blob/f5c5d33eeef525c4f5333d41127c32503fabecab/src/pathfinding/safety.ts) は未取得ブロックを非固体として扱うため、頭上や足元の空間判定をそのまま採用しない。現在の Bot は未受信を未知として扱う。
- 同実装の[戦闘と逃走](https://github.com/chase-west/minecraft-bot/blob/f5c5d33eeef525c4f5333d41127c32503fabecab/src/actions/combat.ts) は攻撃間隔と退避の分離が参考になる。一方、敵が観測リストから消えると討伐とみなし、逃走方向の地形検証もない。未観測・消失だけでは討伐と断定せず、特にクリーパーには距離・周囲・退避路を確認する現在の方針を維持する。
- [deepslate-bedrock/prismarine-bedrock](https://github.com/deepslate-bedrock/prismarine-bedrock) は統合版向けの実験的 Bot 実装。[API 一覧](https://github.com/deepslate-bedrock/prismarine-bedrock/blob/main/docs/API.md)にはブロック、敵、持ち物、採掘、イベントや一部の Java 版向けプラグイン互換層がある。互換層はすべてのプラグインの動作を保証せず、Realm と本 Bot のバージョンでの動作も未検証。導入・コード流用時はライセンスを個別に確認する。

## 継続時の判断

既存の Realm 接続と実測済みの処理を維持し、上記の候補をオフラインの再現テストで検証してから必要な部分を反映する。予測、サーバーで確認した行動、持ち物への実取得はそれぞれ区別する。泳ぎや敵の安全な対処を含め、参考実装の存在は Realm での動作確認を意味しない。
