'use strict'

// The player's starter house (modes/house/) is not dug through by the
// planners: its built blocks (all but the door, which the house build takes
// down itself) read as natural: false in the planning view, which the
// tunneling and excavation searches never mine (real Realm 2026-11-17 15:06
// JST: right after the last floor block was placed, a tunnel to an ore was
// planned from inside the house and mined three floor blocks and the ground
// under them). Walking, standing and the ordinary mining action are unchanged.
const { placements } = require('../modes/house/house-blueprint')
const AIR = /^minecraft:(?:air|cave_air|void_air)$/

function createHouseProtection (getHouse) {
  let origin = null, cells = new Set()
  function current () {
    const at = getHouse()?.origin
    if (!at || ![at.x, at.y, at.z].every(Number.isSafeInteger)) { origin = null; cells = new Set(); return cells }
    if (origin && origin.x === at.x && origin.y === at.y && origin.z === at.z) return cells
    origin = { ...at }
    cells = new Set(placements(at).filter(step => step.item !== 'oak_door').flatMap(step => step.cells).filter(Boolean).map(cell => `${cell.x},${cell.y},${cell.z}`))
    return cells
  }
  return function overlay (block, x, y, z) {
    if (block?.known !== true || block.natural === false || AIR.test(block.name ?? '') || !current().has(`${x},${y},${z}`)) return block
    return { ...block, natural: false, houseBlock: true }
  }
}

module.exports = { createHouseProtection }
