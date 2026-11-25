'use strict'

// What the expedition's current goal is, and one number for how much of it is there (goal/goal-ledger.js).
//
// The goal's key stays the same while the expedition works toward the same thing, whatever step runs:
// `early.home_reserve`, `early.nether_kit`, `nether`, `stronghold`, `end`.
//
// The value counts only received things the goal is made of:
// - the kit's items held, worn or seen in the reserve chest, and what they are made from down to what is
//   mined or hunted (dragon-supply-recipes.js). A raw thing is worth 1; smelting, cooking and crafting add
//   0.5 to the sum of the parts, so making the product from its parts is a gain and never a loss;
// - each item counts up to what the kit can use, so a pack full of something is not progress;
// - the steps the saved record has confirmed (spawnReady, reserveReady, the Nether gate, …), 1000 each.
// Eating, a death or a broken tool lower it; the ledger counts a new best only.
// Support materials (wood, cobblestone, fuel, the stations, a stone pickaxe) are not in the value: using them
// up must not hide the next gain. They are returned apart (`extras`), and the first more of each since the
// last result is one step of the goal.
// Health, the place and every other item are not looked at.
const { ingredient, smelted } = require('./dragon-supply-recipes')
const { home, nether, end, spare, combined, matches } = require('./dragon-supply-kit')
const { GEAR } = require('../survival/diamond-gear')

const RAW_FOOD = /^minecraft:(?:beef|porkchop|chicken|rabbit|mutton|salmon|cod)$/
const SUPPORT = ['log', 'planks', 'stick', 'cobblestone', 'coal', 'charcoal', 'crafting_table', 'furnace', 'chest', 'stone_pickaxe', 'wooden_pickaxe']
const EXTRA = [['blaze_rod', 8], ['ender_pearl', 20], ['ender_eye', 20], ['gold_ingot', 48], ['obsidian', 14], ['diamond', 32]]
// Keys of the saved record that are choices and counters, not confirmed steps.
const VOLATILE = new Set(['gather', 'supplySearch', 'foodSearch', 'cookSaidAt', 'plots', 'returning', 'mine', 'returnAttempt', 'reserveAt', 'reserveIron'])
const STEP = 1000

const worth = new Map()
function value (name) {
  if (worth.has(name)) return worth.get(name)
  let v = 1
  if (SUPPORT.includes(name)) v = 0
  else if (name === 'food') v = 2
  else if (name === 'wheat') v = 0.5
  else if (ingredient[name]) v = Object.entries(ingredient[name]).reduce((sum, [part, need]) => sum + value(part) * need, 0.5)
  else if (smelted[name]) v = value(smelted[name]) + 0.5
  worth.set(name, v)
  return v
}
// How many of each thing the kit can use: its items, and their parts all the way down.
function uses (kit) {
  const cap = new Map()
  const add = (name, amount) => {
    if (SUPPORT.includes(name)) return
    cap.set(name, (cap.get(name) ?? 0) + amount)
    if (name === 'food') { add('raw_food', amount); add('wheat', amount * 3) } else if (ingredient[name]) for (const [part, need] of Object.entries(ingredient[name])) add(part, need * amount)
    else if (smelted[name]) add(smelted[name], amount)
  }
  for (const [name, amount] of kit) add(name, amount)
  return cap
}
const KITS = { 'early.home_reserve': combined(home, home), 'early.diamond': GEAR.map(piece => [piece.output, 1]), 'early.nether_kit': combined(nether, spare), late: combined(nether, end, spare, EXTRA) }
const caps = new Map()
const capsOf = key => { const kit = KITS[key] ?? (key.startsWith('early.') ? [] : KITS.late); if (!caps.has(key)) caps.set(key, uses(kit)); return caps.get(key) }

const holds = (name, row) => name === 'raw_food' ? RAW_FOOD.test(row.name) && row.count > 0 : matches(name, row)
const amount = (name, rows) => rows.reduce((sum, row) => sum + (holds(name, row) ? row.count : 0), 0)

// objective: earlyObjective()'s answer for the early stage. null while it cannot be told (inventory not received).
function goalKey (record, objective = null) {
  if (!record) return null
  if (record.stage !== 'early') return record.stage
  if (!objective || objective.id === 'observe' || objective.legacy) return null
  return 'early.' + objective.id
}

// items: the received inventory rows (null while not received). worn: the received armour rows.
// reserve: { name: count } as last received from the reserve chest. Answers { value, extras } or null.
function measure ({ key, items, worn = [], reserve = null, record = null }) {
  if (!key || !Array.isArray(items)) return null
  const rows = [...items, ...(worn ?? []).filter(row => row?.name).map(row => ({ ...row, count: 1 }))]
  let total = 0
  for (const [name, cap] of capsOf(key)) {
    const have = amount(name, rows) + (name === 'raw_food' ? 0 : Math.max(0, Number(reserve?.[name]) || 0))
    total += value(name) * Math.min(have, cap)
  }
  const part = record?.[record.stage]
  if (part && typeof part === 'object') for (const name of Object.keys(part)) if (!VOLATILE.has(name) && part[name] && typeof part[name] !== 'number') total += STEP
  const extras = {}
  for (const name of SUPPORT) extras[name] = amount(name, items)
  return { value: total, extras }
}

module.exports = { goalKey, measure, value, uses, STEP }
