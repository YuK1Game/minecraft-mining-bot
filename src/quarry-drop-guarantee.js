'use strict'

const { blockRule, nameOf, toolOf } = require('./quarry-rules')
const { maxStack, SLOTS } = require('./quarry-inventory')

// Capacity needs an upper bound, collection a lower bound. These tables
// describe normal survival breaks of the observed target (explosions,
// gravity chains and multi-block plants require independent receipts).
const soil = new Set(['dirt', 'coarse_dirt', 'dirt_with_roots', 'rooted_dirt', 'mud', 'sand', 'red_sand', 'soul_sand', 'soul_soil'])
const silkSoil = new Set(['grass_block', 'podzol', 'mycelium'])
const surfaceItems = new Set(['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'red_mushroom', 'brown_mushroom'])
const tree = /^(?:stripped_)?(?:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:log|wood)|(?:crimson|warped)_(?:stem|hyphae))$/
const regularLeaves = /^(oak|spruce|birch|jungle|acacia|dark_oak|cherry|pale_oak)_leaves$/
const simpleId = /^(?:minecraft:)?[a-z][a-z0-9_]{0,95}$/
const item = (name, count = 1) => ({ name, count })
const fail = reason => ({ ok: false, reason })

function rule (source, alternatives, capacityAlternatives = alternatives) {
  return { ok: true, alternatives, capacityAlternatives, optional: alternatives.some(a => a.length === 0), source }
}

function silkRule (silk, normal, preserved, source) {
  if (silk === true) return rule(source, [[preserved]])
  if (silk === false) return rule(source, [[normal]])
  return rule(source, [[normal], [preserved]])
}

function deriveDropGuarantee (target, tool) {
  if (!target || target.known === false || typeof target.name !== 'string' || !simpleId.test(target.name)) return fail('DROP_RULE_UNKNOWN')
  const name = nameOf(target.name), block = blockRule(name)
  if (block.kind !== 'dig' || target.protected || target.protectionSource) return fail('DROP_TARGET_NOT_DIGGABLE')
  const held = target.tool ?? tool
  const type = held?.kind ?? toolOf(held)?.kind
  const tier = held?.tier ?? toolOf(held)?.tier
  if (block.needs && (type !== block.needs || !Number.isSafeInteger(tier) || tier < block.tier || tier > 4)) return fail('DROP_TOOL_NOT_CONFIRMED')
  const silk = type === 'hand' ? false : held?.silk
  if (silk != null && typeof silk !== 'boolean') return fail('DROP_TOOL_NOT_CONFIRMED')

  if (name === 'leaf_litter') {
    if (type !== 'hand') return fail('DROP_TOOL_NOT_CONFIRMED')
    const props = target.properties
    if (!props || Array.isArray(props) || Object.keys(props).length !== 2 || !Number.isInteger(props.growth) || props.growth < 0 || props.growth > 3 || !['north', 'south', 'east', 'west'].includes(props['minecraft:cardinal_direction']) || !Number.isInteger(target.runtimeId) || target.runtimeId < 0 || target.runtimeId > 0xffffffff) return fail('DROP_RULE_UNKNOWN')
    // Isolated BDS1.26.60: 12 empty-hand and20 held-shulker normal breaks
    // received state -> air -> item entities -> fresh main: growth +1 items.
    return rule('observed_bds_1_26_60_leaf_litter', [[item('leaf_litter', props.growth + 1)]])
  }

  // Mojang Bedrock 1.21.70.23: bush drops itself only with shears or Silk
  // Touch. The received 1.26.60 hand-broken bush has no other possible drop.
  if (name === 'bush') {
    if (type === 'shears' || silk === true) return rule('bedrock_bush_harvest', [[item('bush')]])
    if (type && silk === false) return rule('bedrock_bush_no_drop', [[]])
    return fail('DROP_TOOL_NOT_CONFIRMED')
  }

  if (name === 'snow') return silkRule(silk, item('snowball', 4), item('snow'), 'full_snow_shovel')
  if (name === 'clay') return silkRule(silk, item('clay_ball', 4), item('clay'), 'clay')
  if (silkSoil.has(name)) return silkRule(silk, item('dirt'), item(name), 'silk_soil')
  if (name === 'grass_path' || name === 'dirt_path') return silkRule(silk, item('dirt'), item('grass_path'), 'bedrock_dirt_path')
  if (name === 'farmland') return rule('farmland', [[item('dirt')]])
  if (soil.has(name) || tree.test(name) || surfaceItems.has(name)) return rule('self_drop', [[item(name)]])
  if (block.needs === 'pickaxe') {
    const normal = item(block.drops[0])
    return normal.name === name ? rule('harvest_pickaxe', [[normal]]) : silkRule(silk, normal, item(name), 'harvest_pickaxe')
  }
  if (name === 'gravel') {
    if (silk === true) return rule('gravel', [[item('gravel')]])
    if (silk === false && held?.fortune >= 3) return rule('gravel', [[item('flint')]])
    return rule('gravel', [[item('gravel')], [item('flint')]])
  }
  if (regularLeaves.test(name) || ['mangrove_leaves', 'azalea_leaves', 'azalea_leaves_flowered'].includes(name)) {
    if (silk === true || type === 'shears') return rule('harvest_leaves', [[item(name)]])
    const normal = [item('stick', 2)]
    if (['oak_leaves', 'dark_oak_leaves'].includes(name)) normal.push(item('apple'))
    if (regularLeaves.test(name)) normal.push(item(name.replace(/_leaves$/, '_sapling')))
    if (name.startsWith('azalea_')) normal.push(item(name === 'azalea_leaves' ? 'azalea' : 'flowering_azalea'))
    if (silk === false) return rule('chance_leaves', [[]], [normal])
    return rule('chance_or_silk_leaves', [[], [item(name)]], [normal, [item(name)]])
  }
  // These optional outcomes are established for non-sheared, unenchanted
  // hand harvesting. Other tools and multi-cell plants are unclassified.
  if (type === 'hand') {
    if (name === 'short_grass' || name === 'fern') return rule('hand_vegetation', [[]], [[item('wheat_seeds')]])
    // Bedrock's observed two-cell plants can disappear together. Zero seeds
    // is legitimate; the upper bound reserves two per requested cell and is
    // deliberately conservative if both halves were included in a batch.
    if (name === 'tall_grass' || name === 'large_fern') return rule('hand_double_vegetation', [[]], [[item('wheat_seeds', 2)]])
    if (name === 'deadbush' || name === 'dead_bush') return rule('hand_dead_bush', [[]], [[item('stick', 2)]])
    if (['vine', 'seagrass', 'glow_lichen'].includes(name)) return rule('hand_no_drop', [[]])
  }
  return fail('DROP_RULE_UNKNOWN')
}

function inventoryTotals (items) {
  if (!Array.isArray(items) || items.length > SLOTS) return null
  const seen = new Set(), amounts = new Map()
  for (const row of items) {
    if (!row || !Number.isInteger(row.slot) || row.slot < 0 || row.slot >= SLOTS || seen.has(row.slot) ||
        typeof row.name !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,120}$/.test(row.name) ||
        !Number.isSafeInteger(row.count) || row.count < 1 || row.count > maxStack(row.name)) return null
    seen.add(row.slot)
    const name = nameOf(row.name)
    amounts.set(name, (amounts.get(name) ?? 0) + row.count)
  }
  return amounts
}

function checkDropGuarantees (targets, tool, receipt = {}) {
  const requirements = [], allocation = []
  const reject = reason => ({ ok: false, reason, requirements, allocation: [] })
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) return reject('DROP_TARGETS_INVALID')
  const before = inventoryTotals(receipt?.beforeItems), after = inventoryTotals(receipt?.afterItems)
  if (!before || !after) return reject('DROP_INVENTORY_INVALID')
  const positions = new Set()
  for (const target of targets) {
    const p = target?.position
    if (!p || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) <= 30000000)) return reject('DROP_TARGETS_INVALID')
    const key = [p.x, p.y, p.z].join(',')
    if (positions.has(key)) return reject('DROP_TARGETS_INVALID')
    positions.add(key)
    const requirement = deriveDropGuarantee(target, tool)
    if (!requirement.ok) return reject(requirement.reason)
    requirements.push(requirement)
  }
  const available = new Map()
  for (const [name, count] of after) available.set(name, Math.max(0, count - (before.get(name) ?? 0)))
  // At most eight targets and two alternatives each. Backtrack if an
  // ambiguous block would otherwise consume the only item a later one needs.
  function allocate (i) {
    if (i === requirements.length) return true
    for (const bundle of requirements[i].alternatives) {
      if (bundle.some(d => (available.get(d.name) ?? 0) < d.count)) continue
      for (const d of bundle) available.set(d.name, available.get(d.name) - d.count)
      allocation.push(bundle)
      if (allocate(i + 1)) return true
      allocation.pop()
      for (const d of bundle) available.set(d.name, available.get(d.name) + d.count)
    }
    return false
  }
  return allocate(0) ? { ok: true, requirements, allocation } : reject('DROP_GAIN_MISSING')
}

module.exports = { deriveDropGuarantee, checkDropGuarantees }
