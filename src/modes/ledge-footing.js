'use strict'

// Standing on the rim of a block: the feet on a whole-block height, the body's centre over received air, only an
// edge of the 0.6-wide body on something solid. The grid planner starts a walk from a cell with a floor and answers
// 「The starting footprint has no known safe support」 here; the routes that dig and stack plan from the same cell and
// find nothing either. Nothing moves the body off the rim by itself.
// Real Realm 2026-11-20 04:20-04:36 JST (main 055da21): a creeper's knockback put the Bot on the 0.025 lip of the
// grass block under a single chest (-4896, 75, -4982) south of the house (a chest is 0.025 narrower than its cell on
// each side); feet (-4895.755, 75.0, -4982.275), the own cell (-4896, 75, -4983) and the one under it air. For 16
// minutes every walk, every dig-and-stack route (「0 歩目のあと・The starting footprint has no known safe support」,
// 「調べたマス 2」 18 times), the trips to a tree, to food and to the base did not move it.
// The way off is one of the navigation's two short simulated connectors (movement/navigation.js): `partialRecenter`
// onto a full stand at the same height, or `partialDrop` onto one a block lower (the own cell first). The planner
// simulates the whole step before any input; this only names the stands worth asking for.
const { low } = require('./low-block')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const NEAR = 0.2, FAR = 1.2 // what the two connectors take (navigation.js)
const TRIES = 6

const finite = point => !!point && [point.x, point.y, point.z].every(Number.isFinite)
const cellOf = feet => ({ x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) })

// On the grid, and the block under the feet's own cell is received as no floor. Unknown below is not a rim.
function onRim (block, feet) {
  if (!finite(feet) || Math.abs(feet.y - Math.round(feet.y)) > 0.01) return false
  const at = cellOf(feet), below = block(at.x, at.y - 1, at.z)
  return below?.known === true && below.boundingBox !== 'block'
}

// The stands one connector reaches, level ones first, then one lower; nearest to `toward` (or to the feet) first.
function footings (block, feet, toward = null) {
  if (!onRim(block, feet)) return []
  const at = cellOf(feet)
  const air = (x, y, z) => { const found = block(x, y, z); return found?.known === true && AIR.test(found.name ?? '') && !found.extra?.length }
  const floor = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox === 'block' && !low(found) }
  const room = (x, y, z) => floor(x, y - 1, z) && air(x, y, z) && air(x, y + 1, z)
  const cost = stand => toward && Number.isFinite(toward.x) && Number.isFinite(toward.z) ? Math.hypot(stand.x - toward.x, stand.z - toward.z) : Math.hypot(stand.x - feet.x, stand.z - feet.z)
  const level = [], lower = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const x = at.x + dx, z = at.z + dz, flat = Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z)
    if (flat < NEAR || flat > FAR) continue
    if (room(x, at.y, z)) level.push({ target: { x: x + 0.5, y: at.y, z: z + 0.5 }, options: { partialRecenter: true, maxDistance: 2, maxTicks: 40 } })
    else if (room(x, at.y - 1, z) && air(x, at.y + 1, z)) lower.push({ target: { x: x + 0.5, y: at.y - 1, z: z + 0.5 }, options: { partialDrop: true, maxDistance: 2, maxTicks: 40 } })
  }
  const near = (a, b) => cost(a.target) - cost(b.target)
  return [...level.sort(near), ...lower.sort(near)].slice(0, TRIES)
}

module.exports = { onRim, footings }
