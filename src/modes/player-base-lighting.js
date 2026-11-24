'use strict'

// Stage-0 surface & base-perimeter spawn-proofing (docs/player-roadmap.md):
// Places torches around the built base (radius 16 blocks, 8-block spacing) and
// on dark surface ground at night. Counts only received blocks; never treats
// unreceived blocks as air or solid ground.

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const BAD_FLOOR = /leaves|sand$|gravel$|crafting_table|furnace|chest|bed$|door$|water|lava|glass/
const BASE_LIGHT_RADIUS = 16
const BASE_LIGHT_SPACING = 8

function isNightClock (clock) {
  if (!clock || typeof clock !== 'object') return false
  if (clock.night === true || clock.dusk === true) return true
  const tod = Number(clock.timeOfDay ?? clock.dayTime)
  return Number.isFinite(tod) && tod >= 12000 && tod < 23500
}

function insideFootprint (origin, cell) {
  if (!origin) return false
  return cell.x >= origin.x && cell.x <= origin.x + 6 &&
    cell.z >= origin.z && cell.z <= origin.z + 6 &&
    cell.y >= origin.y && cell.y <= origin.y + 5
}

// Deterministic 8-block grid points within horizontal radius 16 of the base center.
function baseLightGrid (origin, { radius = BASE_LIGHT_RADIUS, spacing = BASE_LIGHT_SPACING } = {}) {
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isFinite)) return []
  const cx = Math.floor(origin.x) + 3
  const cz = Math.floor(origin.z) + 3
  const points = []
  const steps = Math.floor(radius / spacing)
  for (let gx = -steps; gx <= steps; gx++) {
    for (let gz = -steps; gz <= steps; gz++) {
      const dx = gx * spacing
      const dz = gz * spacing
      if (dx === 0 && dz === 0) continue
      if (Math.hypot(dx, dz) > radius + 0.01) continue
      points.push({ x: cx + dx, y: Math.floor(origin.y), z: cz + dz })
    }
  }
  return points
}

// Finds the received open surface cell near `column` within dy [-3, +4].
function surfaceCellAt (getBlock, column, origin = null) {
  for (const dy of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const cell = { x: column.x, y: column.y + dy, z: column.z }
    if (origin && insideFootprint(origin, cell)) continue
    const here = getBlock(cell.x, cell.y, cell.z)
    const below = getBlock(cell.x, cell.y - 1, cell.z)
    if (here?.known === true && AIR.test(here.name ?? '') && !here.extra?.length &&
        below?.known === true && below.boundingBox === 'block' && !BAD_FLOOR.test(below.name ?? '')) {
      return cell
    }
  }
  return null
}

// Returns the nearest unlit base-perimeter grid spot reachable near `feet`.
function findDarkBaseSpot ({ getBlock, origin, feet, torchNear, radius = BASE_LIGHT_RADIUS, spacing = BASE_LIGHT_SPACING, near = 8, maxReach = 3.5, lost = new Set() }) {
  if (!origin || !feet || typeof getBlock !== 'function' || typeof torchNear !== 'function') return null
  const grid = baseLightGrid(origin, { radius, spacing })
  const candidates = []
  for (const col of grid) {
    const spot = surfaceCellAt(getBlock, col, origin)
    if (!spot) continue
    const key = `${spot.x},${spot.y},${spot.z}`
    if (lost.has(key)) continue
    if (torchNear(getBlock, spot, near)) continue
    const dist = Math.hypot(spot.x + 0.5 - feet.x, spot.y - feet.y, spot.z + 0.5 - feet.z)
    if (dist <= maxReach) candidates.push({ spot, dist })
  }
  candidates.sort((a, b) => a.dist - b.dist)
  return candidates[0]?.spot ?? null
}

// Returns true when surface lighting should be considered (nighttime or within base perimeter).
function shouldLightSurface ({ feet, origin = null, clock = null, radius = BASE_LIGHT_RADIUS } = {}) {
  if (!feet) return false
  if (isNightClock(clock)) return true
  if (origin && [origin.x, origin.z].every(Number.isFinite)) {
    const cx = origin.x + 3, cz = origin.z + 3
    if (Math.hypot(feet.x - cx, feet.z - cz) <= radius + 4) return true
  }
  return false
}

module.exports = {
  BASE_LIGHT_RADIUS,
  BASE_LIGHT_SPACING,
  isNightClock,
  baseLightGrid,
  surfaceCellAt,
  findDarkBaseSpot,
  shouldLightSurface
}
