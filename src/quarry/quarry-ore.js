'use strict'

// Known Bedrock ore families. Unknown or future names remain protected by
// quarry-rules. A tier is the minimum harvest tier, not the preferred pickaxe.
const definitions = [
  { names: ['coal_ore', 'deepslate_coal_ore'], tier: 1, drop: 'coal', minimum: 1, maximum: 1 },
  { names: ['iron_ore', 'deepslate_iron_ore'], tier: 2, drop: 'raw_iron', minimum: 1, maximum: 1 },
  { names: ['copper_ore', 'deepslate_copper_ore'], tier: 2, drop: 'raw_copper', minimum: 2, maximum: 5 },
  { names: ['gold_ore', 'deepslate_gold_ore'], tier: 3, drop: 'raw_gold', minimum: 1, maximum: 1 },
  { names: ['redstone_ore', 'deepslate_redstone_ore', 'lit_redstone_ore', 'lit_deepslate_redstone_ore'], tier: 3, drop: 'redstone', minimum: 4, maximum: 5, additiveFortune: true },
  { names: ['lapis_ore', 'deepslate_lapis_ore'], tier: 2, drop: 'lapis_lazuli', minimum: 4, maximum: 9 },
  { names: ['diamond_ore', 'deepslate_diamond_ore'], tier: 3, drop: 'diamond', minimum: 1, maximum: 1 },
  { names: ['emerald_ore', 'deepslate_emerald_ore'], tier: 3, drop: 'emerald', minimum: 1, maximum: 1 },
  { names: ['nether_quartz_ore'], tier: 1, drop: 'quartz', minimum: 1, maximum: 1 },
  { names: ['nether_gold_ore'], tier: 1, drop: 'gold_nugget', minimum: 2, maximum: 6 },
  { names: ['ancient_debris'], tier: 4, drop: 'ancient_debris', minimum: 1, maximum: 1, fortune: false, silk: false }
]
const ORES = new Map()
for (const def of definitions) {
  for (const name of def.names) {
    ORES.set(name, Object.freeze({ ...def, name }))
  }
}
function nameOf (name) { return String(name ?? '').replace(/^minecraft:/, '') }
function oreDefinition (name) { return ORES.get(nameOf(name)) ?? null }
function oreRule (name) {
  const ore = oreDefinition(name)
  if (!ore) return null
  return {
    kind: 'dig', ore: true, tool: 'pickaxe', needs: 'pickaxe',
    tier: ore.tier, drops: ore.silk === false ? [ore.drop] : [ore.drop, ore.name],
    maxDrop: ore.maximum * (ore.fortune === false ? 1 : 4), fortune: ore.fortune !== false,
    silkKeeps: ore.silk !== false, gravity: false
  }
}
function oreDropRange (name, { silk = false, fortune = 0 } = {}) {
  const ore = oreDefinition(name)
  if (!ore || !Number.isInteger(fortune) || fortune < 0 || fortune > 3) return null
  if (silk && ore.silk !== false) return { name: ore.name, min: 1, max: 1 }
  if (ore.fortune === false || fortune === 0) return { name: ore.drop, min: ore.minimum, max: ore.maximum }
  // Vanilla Fortune selects a multiplier from 1..fortune+1. Redstone is an
  // additive special case: its drop range is 4..(5+fortune).
  return { name: ore.drop, min: ore.minimum, max: ore.additiveFortune ? ore.maximum + fortune : ore.maximum * (fortune + 1) }
}
module.exports = { oreDefinition, oreRule, oreDropRange }
