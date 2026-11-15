'use strict'

// Natural full blocks the Bot may stand on, pick drops up from and set a work
// block on. One list for the survival modules: each used to keep its own copy
// without the ores, so inside an ore vein there was no ground at all (real
// Realm 2026-11-16 05:00 JST: on a floor of coal ore the mined coal lay two
// steps away with "No known safe body-range stance can reach this drop", the
// exploration had 0 candidates, and a held crafting table had no cell).
const ORE_GROUND = ['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'].flatMap(name => [`${name}_ore`, `deepslate_${name}_ore`])
const STANDING_GROUND = Object.freeze(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', ...ORE_GROUND])

const ORE_NAME = /^(?:minecraft:)?(?:deepslate_)?(?:coal|iron|copper|gold|lapis|redstone|diamond|emerald)_ore$/
// For the modules that test ground by a pattern of their own (with planks, logs, stations).
const isOreGround = name => ORE_NAME.test(String(name ?? ''))

module.exports = { STANDING_GROUND, ORE_GROUND, isOreGround }
