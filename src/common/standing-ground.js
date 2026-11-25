'use strict'

// Natural full blocks the Bot may stand on, pick drops up from and set a work
// block on. One list for the survival modules: each used to keep its own copy
// without the ores, so inside an ore vein there was no ground at all (real
// Realm 2026-11-16 05:00 JST: on a floor of coal ore the mined coal lay two
// steps away with "No known safe body-range stance can reach this drop", the
// exploration had 0 candidates, and a held crafting table had no cell).
// Redstone ore glows (lit_*) once touched or stood on; it is the same floor.
const ORE_GROUND = [...['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'].flatMap(name => [`${name}_ore`, `deepslate_${name}_ore`]), 'lit_redstone_ore', 'lit_deepslate_redstone_ore']
const STANDING_GROUND = Object.freeze(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'dirt_with_roots', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dripstone_block', 'smooth_basalt', 'clay', 'moss_block', ...ORE_GROUND])

const ORE_NAME = /^(?:minecraft:)?(?:lit_)?(?:deepslate_)?(?:coal|iron|copper|gold|lapis|redstone|diamond|emerald)_ore$/
// For the modules that test ground by a pattern of their own (with planks, logs, stations).
const isOreGround = name => ORE_NAME.test(String(name ?? ''))

// Gravel and sand that rest on received solid ground are ground too: the
// Bot standing on them takes no support away (real Realm 2026-11-17 00:34-00:38
// JST: on a gravel pile at y=-20 every tunnel plan answered "Settle on known
// dry land" and the planner asked to scan the body cells again, 46 times in
// five minutes). Only the block under the feet is meant: digging beside or
// under loose blocks keeps its own checks.
const LOOSE = new Set(['gravel', 'sand', 'red_sand'])
const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const isLoose = name => LOOSE.has(bare(name))
// read(x, y, z) -> received block. True when the loose block at (x, y, z)
// sits on a column of loose blocks (8 at most) that ends on a received full block.
function settledLoose (read, x, y, z, depth = 8) {
  for (let step = 1; step <= depth; step++) {
    const below = read(x, y - step, z)
    if (below?.known !== true || below.boundingBox !== 'block' || below.extra?.length) return false
    if (!isLoose(below.name)) return !/(?:water|lava|concrete_powder$|anvil$|scaffolding)/.test(bare(below.name))
  }
  return false
}

module.exports = { STANDING_GROUND, ORE_GROUND, isOreGround, isLoose, settledLoose }
