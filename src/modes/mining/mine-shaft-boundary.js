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

module.exports = { shaftBoundary, shaftEntryBackingUsable, shaftLandingHasAnchor }
