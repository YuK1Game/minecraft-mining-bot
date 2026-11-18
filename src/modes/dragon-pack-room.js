'use strict'

// Room in a full inventory under the expedition.
//
// While the expedition owns the work, the ordinary jobs for a full inventory
// (player-storage.js, player-discard.js) do not run. Taking rubble out of the
// full reserve chest (dragon-reserve-room.js), mining and hunting fill the 36
// slots, and then nothing more can be picked up or dug: real Realm 2026-11-19
// 03:04-03:09 JST, 36/36 slots (cobblestone 64x9, cobbled deepslate 64x3,
// diorite, granite, andesite, leaf litter, ...), the trip home dug its step and
// was refused 「DIG_START_FAILED: 持ち物が満杯です。」 every ten seconds, no cooked
// food made.
//
// With 35 or more slots taken, the stacks the ordinary discard would throw
// (player-discard.js: stone beyond the cobblestone/dirt reserve, weaker tools,
// saplings ...) are thrown from a spot 3-6 m away, as there. Flint and feathers
// stay: the expedition makes its arrows from them. A throw counts only by the
// server's answer. Nothing to throw, or no spot: one log line a minute and the
// step goes on.
const { throwable, discardJunk } = require('./player-discard')

const FULL = 35, AGAIN_MS = 60000
const KEPT = /^minecraft:(?:flint|feather)$/

function crowded (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return false
  const taken = new Set((inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot))
  return taken.size >= FULL
}

// The inventory as the discard may see it: without what the expedition still uses.
const offered = inventory => inventory?.known === true ? { ...inventory, items: (inventory.items ?? []).filter(item => !KEPT.test(item?.name ?? '')) } : inventory

async function packRoom ({ shared, getInventory, getFeet, drop, walk, why = () => null, cells, log = () => {}, now = Date.now }) {
  const seen = getInventory()
  if (!crowded(seen)) return null
  if (now() < Number(shared.dragonPackAt ?? 0)) return null
  const view = () => offered(getInventory())
  if (!throwable(view()).length) { shared.dragonPackAt = now() + AGAIN_MS; log('プレイヤーモード: 持ち物が満杯ですが、捨てられる物がありません'); return null }
  const thrown = await discardJunk({ drop, walk, why, cells, getInventory: view, getFeet, shared, say: text => log(`プレイヤーモード: ${text}`), now })
  if (!thrown) { shared.dragonPackAt = now() + AGAIN_MS; return null }
  return { phase: 'waiting', reason: `持ち物が満杯のため、いらない物を ${thrown} 枠捨てました。` }
}

module.exports = { packRoom, crowded, FULL }
