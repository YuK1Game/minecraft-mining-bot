'use strict'

const { air, solid } = require('./mine-common')
const { clearableSitePlant } = require('../../quarry/storage/storage-site-terrain')

const shaftEntryBackingUsable = block => solid(block) || air(block) || clearableSitePlant(block)

// The same outside wall cells are budgeted by the planner and checked by the
// constructor. Ground-level access stays open; underground doorways are only
// opened by the executor after their adjoining corridor is received as safe.
function shaftBoundary (plan, { minY = plan?.shaft?.bottomY, maxY = plan?.shaft?.topY - 1 } = {}) {
  const shaft = plan?.shaft
  if (!shaft?.columns?.length || !Number.isInteger(minY) || !Number.isInteger(maxY)) return []
  const columns = new Set(shaft.columns.map(p => `${p.x},${p.z}`)), walls = new Map()
  const bottom = Math.max(minY, shaft.bottomY), top = Math.min(maxY, shaft.topY - 1)
  for (let y = bottom; y <= top; y++) for (const p of shaft.columns) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, z = p.z + dz
      if (!columns.has(`${x},${z}`)) walls.set(`${x},${y},${z}`, { x, y, z })
    }
  }
  return [...walls.values()]
}

// The cell above this floor is the next rung and will be open. Check the
// same lower and side attachment faces the placement port can actually use.
function shaftLandingHasAnchor (read, target) {
  const blocks = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    .map(([dx, dy, dz]) => read({ x: target.x + dx, y: target.y + dy, z: target.z + dz }))
  if (blocks.some(solid)) return true
  return blocks.every(block => block?.known === true) ? false : null
}

// The shaft is dug straight down, so it is only planned through rock: a received cell of its four columns,
// or of the floor under their bottom, that is not a full block is a cave (air, a cave plant, a liquid) the
// shaft would hang in. A cave beside the shaft (its outside wall, the ladder's backing) is sealed as before.
// User, 2026-11-23 13:51 JST: 「直下ぼりする場所は、下に空洞のない場所を選ぶようにしてください」.
// Live 2026-11-23 12:03-12:39 JST, plan 0bc096c1f571cda9c1fe: the shaft at (9884..9885, 10126..10127)
// reached depth 52 above a cave (three of its columns air at y50, all four at y47-49); the landing floor
// (9885,50,10126) had no face to place against.
function shaftVoids (plan, read, { maxY = plan?.shaft?.topY - 2 } = {}) {
  const shaft = plan?.shaft, voids = []
  if (!shaft?.columns?.length || !Number.isInteger(maxY)) return voids
  for (let y = shaft.bottomY - 1; y <= maxY; y++) for (const column of shaft.columns) {
    const p = { x: column.x, y, z: column.z }, b = read(p)
    if (b?.known === true && b.boundingBox !== 'block') voids.push(p)
  }
  return voids
}

module.exports = { shaftBoundary, shaftEntryBackingUsable, shaftLandingHasAnchor, shaftVoids }
