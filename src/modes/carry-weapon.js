'use strict'

// The expedition carries a weapon.
//
// The first sword is made by the starter jobs (wood, then stone). After that the expedition has the player, and its
// kit asks for an iron sword only after the four pieces of armour (dragon-supply-kit.js `home`: 48 ingots for the
// two sets). A stone sword lasts 131 hits. When it broke nothing made another: with no weapon the fight does not
// start, and 「武器がないため敵から離れます」 is all that is left (player-flee.js).
// Live 2026-11-20 JST (house at (9877,64,10138)): the stone sword had 37 uses at 20:32 and struck its last blow at
// 21:10:23 (58 blows on zombies and creepers from 20:58). Until 21:39 the bag held no weapon, with more than 160
// cobblestone, sticks and a crafting table in it. 21:34:57 「武器がないため敵から離れます（体力 19.8、creeper 7.5m）」,
// 21:35:00 the creeper's blast 2.8 m away, 21:35:06 dead. The next sword was made at 21:39 by the starter jobs,
// after the second death.
//
// The rule, as for the pickaxe that digs rock (dig-tool.js `diggerWanted`): with no weapon in the bag (the same
// reading as the flight's, player-flee.js `unarmed`) and the cobblestone for a stone sword carried, one is made
// before other work: 'make' with the wood for its stick (and for a table, when none is carried or stands near),
// 'wood' with too little (the caller fetches a log where that is a short walk). Otherwise false.
const { unarmed } = require('./player-flee')

const COBBLE = 2, STICK_PLANKS = 2, TABLE_PLANKS = 4

// items: the received inventory rows. held(name): the count of a kit name ('cobblestone', 'stick', 'planks', 'log').
// table(): a crafting table is carried or stands near (asked only of a bag with no weapon and the cobblestone).
function weaponWanted (items, held, { table = () => false } = {}) {
  if (!Array.isArray(items) || !unarmed({ items }) || held('cobblestone') < COBBLE) return false
  const wood = held('planks') + 4 * held('log')
  return wood >= (held('stick') >= 1 ? 0 : STICK_PLANKS) + (table() ? 0 : TABLE_PLANKS) ? 'make' : 'wood'
}

module.exports = { weaponWanted }
