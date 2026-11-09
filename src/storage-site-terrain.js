'use strict'

// Pure terrain checks shared by supply proposals and actual portable storage.
// A proposal never makes a plant into air: only explicit, bounded preparation
// inside the quarry may remove it and actual placement always requires air.
const { blockRule, nameOf, AIR } = require('./quarry-rules')
const PLANTS = new Set(['short_grass', 'tallgrass', 'fern', 'dead_bush', 'deadbush', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'brown_mushroom', 'red_mushroom', 'short_dry_grass'])
const FALLING_FLOORS = new Set(['sand', 'red_sand', 'gravel'])
const PARTIAL_OR_HARMFUL = /^(?:mud|farmland|grass_path|dirt_path|soul_sand|snow|magma|bamboo)$/
const known = b => b?.known === true && typeof b.name === 'string'
const plainAir = b => known(b) && AIR.has(nameOf(b)) && !b.extra?.length
const clearableSitePlant = b => known(b) && b.boundingBox === 'empty' && !b.extra?.length && !b.protected && !b.protectionSource && PLANTS.has(nameOf(b)) && blockRule(b.name).plant === true
const passableSiteBody = b => plainAir(b) || clearableSitePlant(b)
function describeBlock (b) {
  return { block: known(b) ? b.name : null, ...(b?.extra?.length ? { extra: b.extra.slice(0, 3).map(v => typeof v?.name === 'string' ? v.name : 'unknown') } : {}) }
}
function supportIssue (read, feet) {
  // Sand/gravel is a floor only when its entire received stack ends in a
  // stable full block. Unknown, floating, or deeper stacks are not assumed safe.
  for (let depth = 1; depth <= 8; depth++) {
    const position = { x: feet.x, y: feet.y - depth, z: feet.z }, b = read(position)
    const issue = cause => ({ cause, position, part: 'support', ...describeBlock(b) })
    if (!known(b)) return issue('SUPPORT_UNKNOWN')
    if (b.extra?.length) return issue('SUPPORT_EXTRA_LAYER')
    if (b.boundingBox !== 'block') return issue('SUPPORT_NOT_SOLID')
    const name = nameOf(b), rule = blockRule(b.name)
    if (FALLING_FLOORS.has(name)) continue
    if (PARTIAL_OR_HARMFUL.test(name) || rule.gravity || rule.plant || rule.leaves) return issue('SUPPORT_UNSAFE')
    if (name === 'bedrock' || /_planks$/.test(name) || rule.kind === 'dig' && !/_log$|_wood$|_stem$|_hyphae$|_roots$/.test(name)) return null
    return issue('SUPPORT_UNSUPPORTED')
  }
  return { cause: 'SUPPORT_DEPTH_LIMIT', position: { ...feet, y: feet.y - 8 }, part: 'support' }
}
module.exports = { plainAir, clearableSitePlant, passableSiteBody, describeBlock, supportIssue }
