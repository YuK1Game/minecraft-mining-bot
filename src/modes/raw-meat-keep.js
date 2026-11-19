'use strict'

// Raw meat on the way to the furnace is not eaten as a snack.
//
// Hunger below 18 starts a meal (user 2026-11-14). The expedition hunts to cook
// 32 pieces at the home furnace, and its hunger sits at 14-17 while it walks
// and fights: every piece of raw meat was eaten within a minute of the hunt,
// before any reached the furnace (live 2026-11-19 03:35-03:55 JST: chicken 1
// and beef 5 gained, all eaten raw by 「待機中の食事」 at hunger 15-17, zero
// cooks in twenty minutes, cooked food 0 throughout). Raw beef restores 3,
// cooked 8.
//
// While the player plays with a house (its furnace), raw meat is kept when
// the Bot is neither hungry (hunger HUNGER or more: it can still sprint and
// is far from starving) nor hurt (health HEALTH or more: the expedition's own
// recovery starts at 12). Other food is eaten as before; below either bound
// the raw meat is eaten as before.
const RAW = /^minecraft:(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const HUNGER = 10, HEALTH = 12

const keeping = (shared, { hunger, health }) => shared?.playerWanted === true && shared.botMode === 'player' && !!shared.playerHouse?.origin &&
  Number.isFinite(hunger) && hunger >= HUNGER && Number.isFinite(health) && health > HEALTH

// The items a snack may take: all of them, or all but the raw meat.
function snackItems (shared, vitals, items = []) {
  return keeping(shared, vitals) ? items.filter(item => !RAW.test(item?.name ?? '')) : items
}

// The eat operation asks this rule for every food it might choose (actions/food.js setKeep), so no meal path eats
// the kept meat. A runtime built without the food module (a partial test harness) has nothing to wire.
function wire (food, shared) {
  let module = null
  try { module = food() } catch { return false }
  if (typeof module?.setKeep !== 'function') return false
  module.setKeep((item, vitals) => RAW.test(item?.name ?? '') && keeping(shared(), vitals))
  return true
}

module.exports = { wire, snackItems, keeping, RAW, HUNGER, HEALTH }
