'use strict'

// What the expedition's reserve chest holds, as last received by anyone who opened it.
//
// The goal's value counts the kit that lies in the reserve chest (dragon-goal-measure.js). Until 2026-11-20 that was a
// copy the expedition took when it opened the chest itself (dragon-supplies.js `reserve`). The reserve chest is the
// base's chest too: after a death the return takes the pickaxe and the armour out of it (player-base-kit.js
// `restockable`). The copy went on counting them in the chest while they were carried and worn, so the first look
// of the new life measured them twice, and that sum became what every later gain had to beat.
//
// Real Realm 2026-11-20, house (9877, 64, 10138), reserve chest (9880, 65, 10139): deaths 21:35:06 and 21:35:46; the
// return took the kit out 21:36-21:37 (the iron pickaxe, helmet, chestplate and leggings were carried and worn from
// 21:37:30); the expedition opened the chest again at 23:12:25. From 23:02 to 23:22 seven iron ingots, two more raw
// iron and a second helmet were made, and the goal counted no result (「最後の成果 140 分前」, 決め直し 2/3 at
// 23:22, 3/3 at 23:32, held at 23:42 with a trip home 28 m short of the house; the value at the hold, 1071, is the
// received state counted once). What the ledger held as its best in between is not in the saved record: inferred.
//
// Now the copy keeps where the chest is and which names were counted, and the counts are read on every look from the
// one memory of received chest contents (return/container-ports.js, `shared.playerChestMemory`), which every opener of
// a chest writes: the expedition, the return, the storage. A large chest is remembered under the half that was
// opened, so the later record of the house's pair is the one read.
const { count } = require('./dragon-supply-kit')
const { chestPairs } = require('./house/house-large-chests')

const key = at => `${at.x},${at.y},${at.z}`
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

// The expedition has just received the chest at `at`: `slots`, counted for `names`.
function noteReserve (shared, at, names, slots) {
  shared.dragonReserveSeen = { at: { x: at.x, y: at.y, z: at.z }, names: [...names], counts: Object.fromEntries(names.map(name => [name, count(name, slots)])) }
  return shared.dragonReserveSeen
}

// { name: count } of the reserve chest as last received; null while it was never read.
function reserveCounts (shared) {
  const seen = shared?.dragonReserveSeen
  if (!seen) return null
  const memory = shared.playerChestMemory
  if (!seen.at || !Array.isArray(seen.names) || !memory?.seen) return seen.counts ?? null
  let halves = [seen.at]
  try { halves = (shared.playerHouse?.origin ? chestPairs(shared.playerHouse.origin) : []).map(pair => pair.map(step => step.position)).find(pair => pair.some(at => same(at, seen.at))) ?? halves } catch { /* No blueprint pair: the chest's own cell. */ }
  let slots = null, newest = -Infinity
  for (const at of halves) {
    const found = memory.seen.get(key(at)), when = memory.at?.get(key(at)) ?? 0
    if (found && when > newest) { slots = found; newest = when }
  }
  return slots ? Object.fromEntries(seen.names.map(name => [name, count(name, slots)])) : seen.counts ?? null
}

module.exports = { noteReserve, reserveCounts }
