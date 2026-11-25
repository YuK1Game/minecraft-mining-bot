'use strict'

const { toolOf } = require('../quarry/quarry-rules')
const { ingredient } = require('./dragon-supply-recipes')

const FOOD = /^minecraft:(?:bread|baked_potato|cooked_(?:beef|porkchop|mutton|chicken|salmon|cod|rabbit))$/
const ITEMS = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'iron_pickaxe', 'shield']
const SPARE_CRAFTED = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield']
// The first kit at home: armour and a sword come before the food, and the food is a small first stock.
// The kit is held twice (one in the chest, one carried). With 32 food second in the list the Bot hunted for
// 64 cooked food with a stone sword and no armour, and every death sent it back to wooden tools
// (live 2026-11-19: deaths 01:09, 01:34, 07:44, 11:01 JST, cooked food never above 7).
const HOME_FOOD = 8
const home = [['iron_pickaxe', 1], ...ITEMS.filter(name => name !== 'iron_pickaxe').map(name => [name, 1]), ['food', HOME_FOOD], ['bucket', 1]]
const spare = [...ITEMS.map(name => [name === 'iron_pickaxe' ? 'diamond_pickaxe' : name, 1]), ['bow', 1], ['arrow', 64], ['water_bucket', 1], ['food', 32], ['cobblestone', 128]]
// Compressed stronghold departure materials for the spare outpost chest:
// replace the 6 unstackable iron/shield pieces with stackable iron ingots (27),
// planks (12, covering shield 6 + sticks 2 + torch/stick margin 4) and 1 crafting
// table, then craft the full `spare` kit at the stronghold outpost chest.
const spareCompact = [['iron_ingot', 27], ['planks', 12], ['crafting_table', 1], ['diamond_pickaxe', 1], ['bow', 1], ['arrow', 64], ['water_bucket', 1], ['food', 32], ['cobblestone', 128]]
const active = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_pickaxe', 'diamond_sword', 'shield', 'water_bucket', 'bow'].map(name => [name, 1])
const end = [...active, ['food', 32], ['arrow', 128], ['cobblestone', 128]]
const nether = [['golden_boots', 1], ['shield', 1], ['flint_and_steel', 1], ['bow', 1], ['arrow', 32], ['food', 32], ['cobblestone', 128]]
const bare = name => String(name).replace(/^minecraft:/, '')
const full = name => 'minecraft:' + bare(name)
function toolUsable (item) {
  if (item?.durabilityRemaining == null) return true
  const tool = toolOf(item)
  if (tool && tool.tier <= 3) return item.durabilityRemaining >= 0
  return item.durabilityRemaining > 1
}
function matches (name, item) {
  if (!item?.name || !item.count || !toolUsable(item)) return false
  if (name === 'food') return FOOD.test(item.name)
  if (name === 'bed') return /^(?:minecraft:)(?:bed|[a-z_]+_bed)$/.test(item.name)
  if (name === 'planks') return /_planks$/.test(item.name)
  if (name === 'log') return /_(?:log|stem)$/.test(item.name)
  return item.name === full(name)
}
const count = (name, items) => items.filter(row => matches(name, row)).reduce((sum, row) => sum + row.count, 0)
// Amount of this exact item that must stay in main inventory while stocking
// a second kit. A worn piece or a working higher-tier equivalent covers it.
function homeCarryNeed (name, amount, main, worn) {
  let alternatives = []
  if (name.startsWith('iron_')) alternatives = ['diamond_', 'netherite_'].map(prefix => prefix + name.slice(5))
  if (name === 'bucket') alternatives = ['water_bucket']
  const better = alternatives.reduce((n, item) => n + count(item, [...main, ...worn]), 0)
  return Math.max(0, amount - count(name, worn) - better)
}

function workingPickTier (item) {
  if (!item?.count || !toolUsable(item)) return 0
  const tool = toolOf(item)
  return tool?.kind === 'pickaxe' ? tool.tier : 0
}
function hasWorkingPick (items, tier) {
  const minimum = toolOf(tier + '_pickaxe').tier
  return items.some(item => workingPickTier(item) >= minimum)
}

const combined = (...lists) => {
  const amounts = new Map()
  for (const [name, value] of lists.flat()) amounts.set(name, (amounts.get(name) ?? 0) + value)
  return [...amounts]
}

// Combined `end` combat kit plus compact outpost spare materials. Any unstackable
// spare piece already held beyond the active `end` kit reduces the ingots/planks
// requested so the Bot never mines redundant iron or wood.
function compactReserveKit (items = [], worn = []) {
  const carried = [...items, ...worn]
  const endMap = new Map(end)
  const extraParts = []
  let iron = 0, planks = 0, sticks = 0, needsCraft = false
  for (const [name, amount] of spare) {
    if (!SPARE_CRAFTED.includes(name)) {
      extraParts.push([name, amount])
      continue
    }
    const activeNeed = endMap.get(name) ?? 0
    const spareHave = Math.max(0, count(name, carried) - activeNeed)
    const missing = Math.max(0, amount - spareHave)
    if (missing <= 0) continue
    needsCraft = true
    const recipe = ingredient[name] ?? {}
    iron += (recipe.iron_ingot ?? 0) * missing
    planks += (recipe.planks ?? 0) * missing
    sticks += (recipe.stick ?? 0) * missing
  }
  const stickPlanks = sticks > 0 ? Math.ceil(sticks / 4) * 2 : 0
  if (iron > 0) extraParts.push(['iron_ingot', iron])
  if (planks + stickPlanks > 0) extraParts.push(['planks', planks + stickPlanks + 4])
  if (needsCraft) extraParts.push(['crafting_table', 1])
  return combined(end, extraParts)
}

module.exports = { home, spare, spareCompact, end, nether, combined, compactReserveKit, matches, count, full, bare, workingPickTier, hasWorkingPick, homeCarryNeed }
