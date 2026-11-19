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
// A roof of built blocks (the house) is not ground: inside the house the Bot
// is on the surface (real Realm 2026-11-17 11:57 JST: after banking in the
// house, the sand search took the slab roof for cover and tried to dig up
// through it, the bed and the walls).
const BUILT = /_(?:planks|slab|stairs|door|trapdoor|bed|wool|carpet|fence|fence_gate)$|^minecraft:(?:glass|glass_pane|.*_stained_glass(?:_pane)?|chest|crafting_table|furnace|torch|lantern)$/
const AHEAD_M = 48
const SCAN_UP = 64

// Whether received solid ground (not a tree's crown) lies above the head.
function underCover (getBlock, position) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite) || typeof getBlock !== 'function') return false
  const x = Math.floor(position.x), z = Math.floor(position.z), top = Math.floor(position.y) + 1
  for (let y = top; y < top + SCAN_UP; y++) {
    const block = getBlock(x, y, z)
    if (block?.known !== true) return false
    if (BUILT.test(block.name ?? '')) continue // (a mineshaft's planks under rock are still cover: the rock above counts)
    if (block.boundingBox === 'block' && !TREE.test(block.name ?? '')) return true
  }
  return false
}

// Whether who stands at (x, y, z) has the open sky over the head: nothing but
// received open cells or a tree's crown above (`roof`: built blocks too).
// Terrain is received 16 to 31 cells over the Bot's own height (one section
// above its own, host.js), so from below the cells high over a hill are never
// received: SKY_KNOWN received open cells with nothing received above them
// count as the sky (real Realm 2026-11-19 19:00 JST: from y 65 under ground at
// y 79-82, every column ended unreceived at y 96 and none was "the sky").
// Fewer than that, or ground anywhere in what is received, is not the sky.
const SKY_KNOWN = 8
function openAbove (getBlock, x, y, z, { roof = false, scanUp = SCAN_UP, need = SKY_KNOWN } = {}) {
  let seen = 0
  for (let up = y + 2; up < y + 2 + scanUp; up++) {
    const found = getBlock(x, up, z)
    if (found?.known !== true) return seen >= need
    if (found.boundingBox === 'block' && !TREE.test(found.name ?? '') && !(roof && BUILT.test(found.name ?? ''))) return false
    seen++
  }
  return true
}

// A point far enough that the walk has to leave the tunnel: toward the tree when one is known, else along the heading.
function surfaceAhead (position, tree, heading) {
  const dx = tree ? tree.x + 0.5 - position.x : 0, dz = tree ? tree.z + 0.5 - position.z : 0
  const angle = tree && Math.hypot(dx, dz) >= 2 ? Math.atan2(dz, dx) : Number.isFinite(heading) ? heading : 0
  return { x: Math.round(position.x + Math.cos(angle) * AHEAD_M), z: Math.round(position.z + Math.sin(angle) * AHEAD_M) }
}

module.exports = { underCover, surfaceAhead, openAbove, BUILT, SKY_KNOWN }
