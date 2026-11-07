'use strict'

// Shared only by planning and executing the one-block fluid-source roof
// operation. Walking and ordinary mining retain their own footing policies.
const HAZARDS = /(?:water|lava|bubble_column|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding|fire|magma|cactus|campfire|powder_snow|cobweb|pointed_dripstone)/

function fluidRoofNeighbourSafe (block) {
  return block?.known === true && typeof block.name === 'string' && block.name.length > 0 && !block.extra?.length && !HAZARDS.test(block.name.replace(/^minecraft:/, ''))
}

module.exports = { fluidRoofNeighbourSafe }
