'use strict'

// The most of one item that one slot holds (1.26.60), or null where it is not known.
//
// A transfer that would put more than this into a slot is refused by the server. The chest module chose the slot
// to deposit into by "the same item, and 64 or fewer afterwards", for every item but a shulker box. A boat, a tool,
// a piece of armour (1) or an egg, a bucket, an ender pearl, a sign (16) with the same item already lying in the
// chest went onto that slot, the server refused, and the empty slots beside it were never tried.
//
// Real Realm 2026-11-20, house (9877, 64, 10138), chests A (9880, 65, 10139) and B (9882, 65, 10141): the long trip
// makes a boat from logs in hand and the return to the base banks it. The return's deposit was refused
// (「収納に失敗: TRANSFER_REJECTED サーバーがチェストへの移動を拒否しました。」, three times a chest) at A 18:18
// (B stored it 87 ms after it opened), at A 22:24 (B stored), at A and B 22:38, 22:52 and 2026-11-21 00:06-00:07; then
// 「使えるチェストがなく、新しいチェストを作る木がありません」 and the return was held, an oak boat in hand.
// The returns of 12:29, 12:41, 14:40, 21:39 and 22:15 stored with nothing refused. The log has 「ボートを作ります」 for
// oak at 11:29 and 16:37, (oak 21:02, before the deaths of 21:35,) birch at 21:42 and 22:16, oak at 22:30, and no line
// that says a boat was made. If each of them made one, the order fits chest by chest: the first boat of a kind goes
// into A, the second is refused at A and goes into B, the third is refused at both. Inferred: the chests' slots and
// the server's status code are not in the log.
//
// The table is minecraft-data's; its entry for a dyed shulker box (64) is wrong, a shulker box never stacks.
const items = require('minecraft-data')('bedrock_1.26.60').itemsByName
const SHULKER = /(^|_)shulker_box$/

function stackLimit (name) {
  const short = String(name ?? '').replace(/^minecraft:/, '')
  if (SHULKER.test(short)) return 1
  const limit = items[short]?.stackSize
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 64 ? limit : null
}

module.exports = { stackLimit }
