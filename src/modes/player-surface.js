'use strict'

// Player mode: come up to the surface before looking for a tree.
// The search for wood walks toward a tree by its column (x, z). From a tunnel
// the nearest trees stand right overhead: the walk "arrives" without moving
// and the Bot paces below them (real Realm 2026-11-16 05:58-06:10 JST: twelve
// minutes at y 62-65 under oak logs at y 71-79, three trips, no log).
// While received solid ground lies above the head, the trip therefore goes
// to a point 48 m away instead; the long travel's route from a covered start
// leads to the first place under open sky, and the trip ends there.
const TREE = /_(?:leaves|log|wood|stem)$|leaf_litter/
const AHEAD_M = 48
const SCAN_UP = 64

// Whether received solid ground (not a tree's crown) lies above the head.
function underCover (getBlock, position) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite) || typeof getBlock !== 'function') return false
  const x = Math.floor(position.x), z = Math.floor(position.z), top = Math.floor(position.y) + 1
  for (let y = top; y < top + SCAN_UP; y++) {
    const block = getBlock(x, y, z)
    if (block?.known !== true) return false
    if (block.boundingBox === 'block' && !TREE.test(block.name ?? '')) return true
  }
  return false
}

// A point far enough that the walk has to leave the tunnel: toward the tree when one is known, else along the heading.
function surfaceAhead (position, tree, heading) {
  const dx = tree ? tree.x + 0.5 - position.x : 0, dz = tree ? tree.z + 0.5 - position.z : 0
  const angle = tree && Math.hypot(dx, dz) >= 2 ? Math.atan2(dz, dx) : Number.isFinite(heading) ? heading : 0
  return { x: Math.round(position.x + Math.cos(angle) * AHEAD_M), z: Math.round(position.z + Math.sin(angle) * AHEAD_M) }
}

module.exports = { underCover, surfaceAhead }
