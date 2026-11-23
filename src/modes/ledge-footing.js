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
//
// The shore's rim. The own cell has a floor, and an edge of the body reaches over a column of water one block down.
// The planner's check of the ground under the body reads every column the body reaches, and a dry plan reads no
// water: the same refusal, though the body stands on a whole block. The water exit does not see it either (the water
// is a block under foot height: the body is dry).
// Real Realm 2026-11-23 19:08-19:25 JST (main d7ede2a): on a sand bar in the pond south-east of the house, feet
// (9892.705, 63.000, 10173.460) on the sand (9892, 62, 10173), the cell east of it water: the body reached 0.005 over
// it. Every leg of the long trips (「Navigation made no progress」), every dig-and-stack route (「0 歩目のあと・The
// starting footprint has no known safe support」, 「NO_BUILD_ROUTE・調べたマス 2」, ASCENT_POSITION_UNCONFIRMED) ended
// where it began.
// The way off is the same connector with the shore's reading (`shoreRecenter`, the recovery's own step,
// safety/recovery.js): planned by the navigator that reads water, onto a full stand at the same height, and any
// predicted frame in water ends it (movement.js).
const { low } = require('./low-block')
const { water } = require('../movement/wet-cell')

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

// On the grid, and a column the 0.6-wide body reaches holds received water one block under the feet.
function overWater (block, feet) {
  if (!finite(feet) || Math.abs(feet.y - Math.round(feet.y)) > 0.01) return false
  const y = Math.round(feet.y) - 1
  for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
    const found = block(x, y, z)
    if (found?.known === true && water(found)) return true
  }
  return false
}

// No walk is planned from here: one of the two rims.
const adrift = (block, feet) => onRim(block, feet) || overWater(block, feet)

// The shore step's own frame guard: every frame dry. Without one the runtime gives a move that reads water the swim's
// guard, which ends it while any hostile is near; this step never leaves dry ground, as no ordinary walk does.
const dryFrame = frame => frame?.predictedState?.isInWater !== true && frame?.predictedState?.isInLava !== true
const LEVEL = { partialRecenter: true, maxDistance: 2, maxTicks: 40 }
const SHORE = { ...LEVEL, shoreRecenter: true, allowWater: true, beforeInput: dryFrame }

// The stands one connector reaches, level ones first, then one lower; nearest to `toward` (or to the feet) first.
// Over water only level stands (the feet's own cell among them): the step down does not read water.
function footings (block, feet, toward = null) {
  if (!adrift(block, feet)) return []
  const at = cellOf(feet), shore = overWater(block, feet)
  const air = (x, y, z) => { const found = block(x, y, z); return found?.known === true && AIR.test(found.name ?? '') && !found.extra?.length }
  const floor = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox === 'block' && !low(found) }
  const room = (x, y, z) => floor(x, y - 1, z) && air(x, y, z) && air(x, y + 1, z)
  const cost = stand => toward && Number.isFinite(toward.x) && Number.isFinite(toward.z) ? Math.hypot(stand.x - toward.x, stand.z - toward.z) : Math.hypot(stand.x - feet.x, stand.z - feet.z)
  const level = [], lower = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const x = at.x + dx, z = at.z + dz, flat = Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z)
    if (flat < NEAR || flat > FAR) continue
    if (room(x, at.y, z)) level.push({ target: { x: x + 0.5, y: at.y, z: z + 0.5 }, options: shore ? { ...SHORE } : { ...LEVEL } })
    else if (!shore && room(x, at.y - 1, z) && air(x, at.y + 1, z)) lower.push({ target: { x: x + 0.5, y: at.y - 1, z: z + 0.5 }, options: { partialDrop: true, maxDistance: 2, maxTicks: 40 } })
  }
  const near = (a, b) => cost(a.target) - cost(b.target)
  return [...level.sort(near), ...lower.sort(near)].slice(0, TRIES)
}

module.exports = { onRim, overWater, adrift, footings }
