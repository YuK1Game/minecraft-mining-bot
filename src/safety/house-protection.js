'use strict'

// The player's starter house (modes/house/) is not dug through by the
// planners: its built blocks (all but the door, which the house build takes
// down itself) read as natural: false in the planning view, which the
// tunneling and excavation searches never mine (real Realm 2026-11-17 15:06
// JST: right after the last floor block was placed, a tunnel to an ore was
// planned from inside the house and mined three floor blocks and the ground
// under them). Walking, standing and the ordinary mining action are unchanged.
const { placements } = require('../modes/house/house-blueprint')
const { ringColumns, DEPTH } = require('../modes/house/house-yard')
const AIR = /^minecraft:(?:air|cave_air|void_air)$/

function createHouseProtection (getHouse, { includeYardRing = false } = {}) {
  let origin = null, cells = new Set()
  function current () {
    const at = getHouse()?.origin
    if (!at || ![at.x, at.y, at.z].every(Number.isSafeInteger)) { origin = null; cells = new Set(); return cells }
    if (origin && origin.x === at.x && origin.y === at.y && origin.z === at.z) return cells
    origin = { ...at }
    cells = new Set(placements(at).filter(step => step.item !== 'oak_door').flatMap(step => step.cells).filter(Boolean).map(cell => `${cell.x},${cell.y},${cell.z}`))
    if (includeYardRing) {
      for (const col of ringColumns(at)) for (let y = at.y - 1; y > at.y - 1 - DEPTH; y--) cells.add(`${col.x},${y},${col.z}`)
    }
    return cells
  }
  return function overlay (block, x, y, z) {
    if (block?.known !== true || block.natural === false || AIR.test(block.name ?? '') || !current().has(`${x},${y},${z}`)) return block
    return { ...block, natural: false, houseBlock: true }
  }
}

// The yard: the ground the house stands in. The gathering takes the nearest stone with an open side, and its own
// protection was the blueprint's box: the stone under the floor and beside the walls was outside it. Real Realm
// 2026-11-23 (house origin 9877,64,10138): the cobblestone for the mine's supplies (11:50-12:03 JST 0 -> 63,
// 16:15-16:18 JST 26 -> 87) came out of the ground north, east and south of the walls, down to y 57; at 16:20 the
// house stood on an island and the return to its chest found no way in.
// A cell is in the yard within YARD.around cells of the 7x7 footprint, from YARD.down below the floor to YARD.up
// above it. Logs are not ground: a tree beside the house is cut whole, as before. Deeper rock is the mine's.
// Who gathers material from the world asks this (dragon-supply-gather.js `unavailable`); the way into and out
// of the house (the dig-and-stack walk) and the house build do not.
const YARD = { around: 8, down: 12, up: 3, size: 7 }
const LOG = /_(?:log|stem)$/
function inYard (origin, p, block = null) {
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isFinite) || LOG.test(block?.name ?? '')) return false
  return p.x >= origin.x - YARD.around && p.x <= origin.x + YARD.size - 1 + YARD.around &&
    p.z >= origin.z - YARD.around && p.z <= origin.z + YARD.size - 1 + YARD.around &&
    p.y >= origin.y - YARD.down && p.y <= origin.y + YARD.up
}

module.exports = { createHouseProtection, inYard, YARD }
