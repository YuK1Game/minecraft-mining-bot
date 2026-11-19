'use strict'

// Standing on the centre of a block before a pillar step.
//
// The pillar step asks the server for the feet within 0.12 of the block's
// centre before anything is placed. A walk of a few centimetres does not move
// the Bot, so an off-centre body is walked one step to a free block beside
// (level, one up, one down) and back. Shared by the climb out of the
// underground (player-climb.js) and the dig-and-stack route
// (player-build-walk.js; real Realm 2026-11-19 12:34-12:45 JST: the first
// stacked step beside the house entrance ended eight times in a row with
// ASCENT_POSITION_UNCONFIRMED before any block was placed).

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const OFF = 0.06

async function centreOnColumn ({ column, base, feet, block, walk, aborted = () => false, tries = 4 }) {
  const centre = { x: column.x + 0.5, y: base, z: column.z + 0.5 }
  const off = () => { const at = feet(); return at ? Math.hypot(at.x - centre.x, at.z - centre.z) : 0 }
  if (off() <= OFF || aborted()) return off() <= OFF
  const isAir = found => found?.known === true && AIR.test(found.name ?? '')
  const solid = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox === 'block' }
  const room = (x, y, z) => solid(x, y - 1, z) && isAir(block(x, y, z)) && isAir(block(x, y + 1, z))
  // Level, one step up (room over the own head) or one step down.
  const stand = cell => room(cell.x, base, cell.z) ? base : isAir(block(column.x, base + 2, column.z)) && room(cell.x, base + 1, cell.z) ? base + 1 : room(cell.x, base - 1, cell.z) && isAir(block(cell.x, base + 1, cell.z)) ? base - 1 : null
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: column.x + dx, z: column.z + dz })).map(cell => ({ ...cell, y: stand(cell) })).filter(cell => cell.y !== null)
  for (const side of sides.slice(0, tries)) {
    if (aborted()) break
    await walk({ x: side.x + 0.5, y: side.y, z: side.z + 0.5 })
    await walk(centre)
    if (off() <= OFF) return true
  }
  return off() <= OFF
}

module.exports = { centreOnColumn, OFF }
