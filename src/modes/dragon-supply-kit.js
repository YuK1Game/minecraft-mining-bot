'use strict'

const { toolOf } = require('../quarry/quarry-rules')

const FOOD = /^minecraft:(?:bread|baked_potato|cooked_(?:beef|porkchop|mutton|chicken|salmon|cod|rabbit))$/
const ITEMS = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'iron_pickaxe', 'shield']
const home = [['iron_pickaxe', 1], ['food', 32], ...ITEMS.filter(name => name !== 'iron_pickaxe').map(name => [name, 1]), ['bucket', 1]]
const spare = [...ITEMS.map(name => [name === 'iron_pickaxe' ? 'diamond_pickaxe' : name, 1]), ['bow', 1], ['arrow', 64], ['water_bucket', 1], ['food', 32], ['cobblestone', 128]]
const active = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_pickaxe', 'diamond_sword', 'shield', 'water_bucket', 'bow'].map(name => [name, 1])
const end = [...active, ['food', 32], ['arrow', 128], ['cobblestone', 128]]
const nether = [['golden_boots', 1], ['shield', 1], ['flint_and_steel', 1], ['bow', 1], ['arrow', 32], ['food', 32], ['cobblestone', 128]]
const bare = name => String(name).replace(/^minecraft:/, '')
const full = name => 'minecraft:' + bare(name)
function matches (name, item) {
  if (!item?.name || !item.count || item.durabilityRemaining != null && item.durabilityRemaining <= 1) return false
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
  if (!item?.count || item.durabilityRemaining != null && item.durabilityRemaining <= 1) return 0
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
module.exports = { home, spare, end, nether, combined, matches, count, full, bare, workingPickTier, hasWorkingPick, homeCarryNeed }
