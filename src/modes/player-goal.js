'use strict'

// Player mode: what to play for next. The survival autonomy ends its run when
// the diamond count of its objective is in the received inventory (real Realm
// 2026-11-16 08:07 JST: one diamond, then 「目標数のダイヤモンドを…確認しました」
// over and over). Each start therefore asks for the next step of the ladder:
// 3 (pickaxe), 5 (sword), 13 (chestplate), 29 (the rest of the armour), then
// eight more each time. The crafting of that gear is a later stage
// (docs/player-roadmap.md, stage 4); an unreceived inventory keeps the first goal.
const LADDER = [1, 3, 5, 13, 29]

function diamondGoal (inventory) {
  if (inventory?.known !== true) return LADDER[0]
  const have = (inventory.items ?? []).filter(item => item?.name === 'minecraft:diamond' && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  return LADDER.find(count => count > have) ?? have + 8
}

// The start options with the next goal; other objectives pass unchanged.
function nextObjective (options, inventory) {
  if (options?.objective !== 'diamond') return options
  return { ...options, diamondCount: Math.max(diamondGoal(inventory), 1) }
}

module.exports = { diamondGoal, nextObjective, LADDER }
