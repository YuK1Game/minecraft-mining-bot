'use strict'

// 2026-11-14 01:59 user: "クリーパーに爆破され落下しました。不死のトーテムを持っている
// 限り死ぬことはないので、過剰な待機保護をやめてください". While the received offhand holds a
// totem of undying (state.totemGuard, set by the runtime from the server's
// offhand slot only), health alone stops no work. A used totem empties the
// offhand and the ordinary minimum applies again.
const totemGuarded = state => state?.totemGuard === true && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending
// 2026-11-14 user decision (relay): while the long-trip preparation allowance
// is active and the server-received inventory (main 36, armour, offhand) is
// entirely empty, nothing can be lost; gathering and hunting may start at low
// health (a death respawns with full health). One item in hand ends it.
const emptyHandedPrep = state => state?.emptyHandedPrep === true && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending
function resourceMinHealth (state, legacy = 6) {
  if (totemGuarded(state) || emptyHandedPrep(state)) return 0
  return state?.threatPolicy === 'online_learning' && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending ? 0 : legacy
}

// 2026-11-14 decision (relay): during empty-handed long-trip preparation the
// bot does not close in on shooting enemies (live 11:02: a skeleton killed the
// bare-handed bot right after every respawn); only a non-shooting enemy within
// 3 m that can hit it may be struck. Anything in hand restores normal combat.
const SHOOTING = /^minecraft:(?:skeleton|stray|bogged|pillager|witch|blaze|ghast|evoker|illusioner|breeze|drowned|shulker|llama|trader_llama)$/
function emptyHandedTargetAllowed (state, target) {
  if (!emptyHandedPrep(state)) return true
  const name = String(target?.entityType ?? target?.name ?? '')
  if (SHOOTING.test(name)) return false
  const p = state?.position, q = target?.position
  if (!p || !q) return false
  return Math.hypot(p.x - q.x, p.y - 1.62 - q.y, p.z - q.z) <= 3
}
// Cheap, quickly regathered items that still count as "nothing to lose" during
// long-trip preparation (2026-11-14 decision a): dirt, cobblestone, gravel,
// logs, planks, sticks, a crafting table, wooden tools, plain food and seeds.
// Anything else (shulkers, armour, totems, iron or better tools...) does not.
const CHEAP = /^minecraft:(?:dirt|coarse_dirt|cobblestone|cobbled_deepslate|gravel|sand|[a-z_]+_log|[a-z_]+_planks|stick|crafting_table|wooden_(?:sword|pickaxe|axe|shovel|hoe)|(?:cooked_)?(?:beef|porkchop|chicken|mutton|rabbit|cod|salmon)|bread|apple|carrot|potato|baked_potato|beetroot|rotten_flesh|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|wheat|feather|leather|string|bone|flint|oak_sapling|spruce_sapling|birch_sapling|jungle_sapling|acacia_sapling|dark_oak_sapling)$/
const cheapItem = name => CHEAP.test(String(name ?? ''))
module.exports = { resourceMinHealth, totemGuarded, emptyHandedPrep, emptyHandedTargetAllowed, SHOOTING, cheapItem }
