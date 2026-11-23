'use strict'

// The inventory the chest work of the player mode acts on (storing a full pack, the return to the base).
//
// The chest operation (actions/chest.js) is refused while any of the 36 main slots has no received stack. The
// host's rows (`state.inventory`) say nothing of that: after a respawn the single inventory record forgets every
// slot of the life before, the rows read "known, nothing held", and the slots come back with the idle resync
// (runtime.js inventoryStoreResyncTick, three seconds of missing slots at the earliest).
//
// Live 2026-11-23 15:39:25 and 15:41:26 JST, house (9877,64,10138), both times after a death: the return for the
// kit began 2.7 s and 2.4 s after the respawn, beside the base chest. 「チェスト (9880, 65, 10139) から取り出せません
// でした（CONTAINER_OPEN_REFUSED: 持ち物全体の実スタックIDが必要です。）」 for both halves within 10 ms; the refusal was
// charged to the chests, the return walked out of the door to another chest, could not come back to the first
// (CHEST_UNREACHED ×4), and the Bot met zombies and skeletons outside with nothing in its hands. It died again
// 100 s later.
//
// Here the chest work reads the same fact as the chest operation: its inventory is the received rows, and null
// (not received: wait, decide nothing) while a main slot has no received stack.
const { validRaw } = require('../actions/chest')

function mainReceived (rawItem) {
  try { for (let slot = 0; slot < 36; slot++) if (!validRaw(rawItem(slot))) return false } catch { return false }
  return true
}

// `uncertain()`: an unconfirmed transfer is open. `rawItem(slot)`: the received stack of a main slot, or null.
// `inventory()`: the host's rows.
function createChestPack ({ uncertain, rawItem, inventory }) {
  return () => uncertain() || !mainReceived(rawItem) ? null : inventory()
}

module.exports = { createChestPack, mainReceived }
