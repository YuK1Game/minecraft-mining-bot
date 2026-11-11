# 露天掘り開始の実行引継ぎ（2026-11-11）

## 最新の追記（23:43 JST）

- 23:15、地上ラージチェストに無限の弓を含むv2.2初期セットを構築し、受信で確認した。初期化の再実行やチェストの消去は不要。
- 現ジョブは `quarry_b0914778-d19a-41a9-9f60-689c5c89dc0b`。対象 `(-6,-3)`、下端 `Y=-59`、`active/four_layers`。保存済み状態は `PAUSED`、採掘数0。
- `loadout.checkpoint.index=1`。剣は両側照合で受領確認済み。弓はチェスト27→手持ち1の転送記録 `intent` が残っている。記録を消したり、弓を重複して引き出したりしない。
- 保存済み受信イベントでは、弓の要求 `-5` は成功応答とチェスト側の空更新を受信。手持ちの詳細は後の全枠再同期で受信した。通常の `withdrawItem` が10秒で確認失敗になる原因と整合する。
- `src/quarry-v22-chest-work.js` を修正。失敗後は実在庫の再受信とチェストの開き直しで数量・NBT・ブロックIDを照合し、適用済みの転送だけを進める。未変化・不一致・再受信失敗では記録を保持して停止する。20秒の再同期制限の待機は1回だけで、中断・死亡・接続変更を監視する。新しい回帰テスト12件成功。
- v2.2関連・初期セット・Runtimeアダプター計148件成功。構文確認は627ファイル＋ダッシュボード内1スクリプト成功。安全回帰と全件比較は確認中（完了結果は下の旧記録と区別する）。
- 管理画面は、正しいローカルHost/Originで `GET /` のトップページ遷移に限り cross-site を許可する修正を用意した。API・POST・iframe等の保護は維持。サーバーはホットリロード非対応のため、画面修正の反映は管理画面の再起動が必要。
- 23:39:53、既存の起動ログに `Nginx proxy is restarting` と `Server closed connection: closed` が記録された。この作業では切断・プロセス停止・再起動を送っていない。
- このターンからの `GET http://127.0.0.1:3000/status` と `:3001/` は、TCPソケット作成時のアクセス拒否（EACCES相当）。これはAPIの応答でも、管理画面403でもない。復帰したかは未確認。別の起動経路で通信制限を迂回しない。

操作可能になったら、まず現在の接続とジョブを取得する。同じジョブの保存済み `intent` を維持して `quarry.resume()` し、弓の照合→残りの装備受領→採掘を確認する。開始を返しただけでは完了とせず、サーバーの空気更新に基づく `ledger.minedBlocks` 増加を確認する。

以下は22:36時点からの過去の引継ぎであり、現在の在庫や接続の証拠に使わない。

## 過去の到達状況

- 目標はチャンク `(-6,-3)`（X=-96〜-81、Z=-48〜-33）、下端 `Y=-59`。
- 弓の主手確認リトライは PR #56 で GitHub の main に統合済み。ローカルは `.git` 書込み制限のため HEAD が `da9873f`、修正2ファイルが作業ツリーに残る。無条件に破棄しない。
- 22:36 JST の再確認では、現在の実行環境から `127.0.0.1:3000` と `:3001` に接続できなかった。移動・採掘開始は未実施。
- 直前の Bot 起動では Realms 一覧取得が `connect EACCES ...:443` で失敗した。権限昇格も現セッションの設定で拒否される。別の起動方法や中継でこの制限を迂回しない。
- 保存された dashboard の最終観測は22:15 JST。現在の接続・位置・所持品の証拠には使わない。

## 接続できる環境での既存APIによる手順

汎用操作はローカル `POST http://127.0.0.1:3000/action`、`Content-Type: application/json`、本文は `{group,method,args}`。ブラウザー向けの汎用プロキシは追加しない。接続済みBotを操作し、二重起動しない。

1. `GET /status` で `spawned`・生存・ロード完了・同じ接続/次元/life・所持品受信済み・未確定転送なしを確認する。
2. 初期セットの失敗記録が残っていれば、地上チェストの現物を開いて54枠を受信し、資料の準備段階の手作業で復旧する。未確認の箱を削除しない。記録を `completed` に書き換えない。自動復旧APIは存在しない。
3. 安全な歩行経路を `movement.preview(target, {allowWater:false, exactGoal:true})` で確認し、同じ引数の `movement.start` で必要な移動を行う。既定の移動距離上限は12m。目線Yと足元Yを混同しない。
4. `quarry.confirmPosition(feet)` の受信応答で位置を確認できる。`feet` は X/Z が整数+0.5、Yが整数の座標。予測位置や受付応答だけで到着扱いにしない。
5. `loadout.preview()` の対象・箱座標を確認し、120秒以内に `loadout.start({token,confirm:"REPLACE_SURFACE_CHEST"})`。同一操作の `loadout.status()` が `completed` かつ `serverConfirmed:true` になるまで完了扱いにしない。準備開始前は主所持品36枠・防具4枠・オフハンドが実受信で空である必要がある。
6. 次の設定を `quarry.plan` に渡す。初期化後のBotは空で正常。開始処理で登録済みの地上箱から34スタックを受領して防具を装備する。

```json
{
  "group": "quarry",
  "method": "plan",
  "args": [{
    "target": {"chunks": [{"x": -6, "z": -3}]},
    "yBottom": -59,
    "inventory": {
      "pickupMode": "active",
      "depositWhen": "four_layers",
      "minFreeSlots": 3
    }
  }]
}
```

`ready`、対象チャンク、下端、問題一覧、homeChestを確認する。未受信地形は `quarry.requestTerrain()` 後、実受信してから再評価する。安全条件を緩めない。

```json
{"group":"quarry","method":"start","args":[]}
```

7. `quarry.status()` と受信状態を監視する。開始受付や `MINING` 表示だけで採掘成功とせず、同じ接続/lifeで受信した空気に基づく `ledger.minedBlocks` の増加を確認する。停止理由を確認してから対処する。`STOPPING`、保存失敗、例外待ちを強制解除しない。

## 現行の管理画面との相違

`src/dashboard-control.js` の計画は `passive/full` または `active/capacity` を明示生成するため、v2.2の `active/four_layers` をUIから選べない。上記の明示設定が必要。下端を浅くして開始条件を通す変更は行わない。

## 検証結果

- 構文627ファイル＋ダッシュボード内1スクリプト成功。v2.2/four-layer/loadoutの関連125件成功。
- GitHubのUbuntu/Windows安全回帰・戦闘性能チェック成功。
- 全件比較CIは失敗。baselineは255失敗・2キャンセル、currentは260失敗・2キャンセル。追加5件は未変更の `test/runtime-idle-escape.test.js` にある。不安定テストのあるファイルと一致するが、全件成功や差分なしとは扱わない。

参照: `docs/handoff-20261111.md`、`src/runtime.js` の loadout/quarry/chest/movement、`src/quarry-v22-reset.js`、`src/dashboard-control.js`。
