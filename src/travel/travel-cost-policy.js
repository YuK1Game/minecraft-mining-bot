'use strict'

// Unified cost & hazard evaluation policy for wide-area long-distance travel.
// Consolidates remembered danger zones, live ranged hostiles (single vs group),
// failed local-walk cells, water/cover/night multipliers, and soft proximity
// penalties into a single deterministic evaluator used by `coarse-route.js`
// and `long-travel-runtime.js`.
const { activeZones } = require('./danger-zones')

const SOFT_BLOCK = /dirt|grass_block|gravel|sand|clay|snow|mud|podzol|mycelium|farmland/

function buildShooterCircles (shooters = [], feet = null) {
  if (!Array.isArray(shooters) || !shooters.length || !feet) return []
  const valid = shooters.filter(q => q && Number.isFinite(q.x) && Number.isFinite(q.z))
  return valid.map(q => {
    const group = valid.filter(o => Math.hypot(o.x - q.x, o.z - q.z) <= 16).length >= 3
    const baseRadius = group ? 32 : 20
    const distFromFeet = Math.hypot(q.x - feet.x, q.z - feet.z)
    const hardRadius = Math.min(baseRadius, distFromFeet - 2)
    return { x: q.x, z: q.z, hardRadius, softRadius: baseRadius + 8 }
  }).filter(c => c.hardRadius > 1)
}

function buildDangerCircles (dangerZones = [], feet = null, destination = null, now = Date.now) {
  if (!Array.isArray(dangerZones) || !dangerZones.length || !feet) return []
  const zones = activeZones(dangerZones, destination, now)
  const out = []
  for (const zone of zones) {
    const distFromFeet = Math.hypot(zone.x - feet.x, zone.z - feet.z)
    if (distFromFeet > 320) continue
    const hardRadius = Math.min(zone.r, distFromFeet - 2)
    if (hardRadius <= 1) continue
    out.push({ x: zone.x, z: zone.z, hardRadius, softRadius: hardRadius + 10 })
  }
  return out
}

function createTravelCostPolicy ({
  dangerZones = [],
  shooters = [],
  feet = null,
  destination = null,
  badCells = null,
  nightShelter = false,
  waterMultiplier = 10,
  coveredMultiplier = 5,
  now = Date.now
} = {}) {
  const shooterCircles = buildShooterCircles(shooters, feet)
  const dangerCircles = buildDangerCircles(dangerZones, feet, destination, now)
  const blockedCache = new Map()
  const penaltyCache = new Map()

  function isHardAvoided (x, z) {
    const key = `${x},${z}`
    if (blockedCache.has(key)) return blockedCache.get(key)
    const cx = x + 0.5
    const cz = z + 0.5
    let hit = false
    for (const circle of dangerCircles) {
      const dx = cx - circle.x
      const dz = cz - circle.z
      if (dx * dx + dz * dz <= circle.hardRadius * circle.hardRadius) { hit = true; break }
    }
    if (!hit) {
      for (const circle of shooterCircles) {
        const dx = cx - circle.x
        const dz = cz - circle.z
        if (dx * dx + dz * dz <= circle.hardRadius * circle.hardRadius) { hit = true; break }
      }
    }
    blockedCache.set(key, hit)
    return hit
  }

  function has (colKey) {
    if (badCells?.has?.(colKey)) return true
    const sep = colKey.indexOf(',')
    if (sep < 0) return false
    const x = Number(colKey.slice(0, sep))
    const z = Number(colKey.slice(sep + 1))
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false
    return isHardAvoided(x, z)
  }

  function columnPenalty (x, z) {
    const key = `${x},${z}`
    if (penaltyCache.has(key)) return penaltyCache.get(key)
    const cx = x + 0.5
    const cz = z + 0.5
    let extra = 0
    for (const circle of dangerCircles) {
      const dist = Math.hypot(cx - circle.x, cz - circle.z)
      if (dist < circle.softRadius && dist > circle.hardRadius) {
        extra += ((circle.softRadius - dist) / (circle.softRadius - circle.hardRadius)) * 3
      }
    }
    for (const circle of shooterCircles) {
      const dist = Math.hypot(cx - circle.x, cz - circle.z)
      if (dist < circle.softRadius && dist > circle.hardRadius) {
        extra += ((circle.softRadius - dist) / (circle.softRadius - circle.hardRadius)) * 4
      }
    }
    if (nightShelter) extra += 0.5
    penaltyCache.set(key, extra)
    return extra
  }

  function stepCost ({ diagonal = false, water = false, covered = false, dy = 0, x = 0, z = 0 } = {}) {
    const base = (diagonal ? 1.414 : 1) * (water ? waterMultiplier : 1) * (covered ? coveredMultiplier : 1)
    return base + (dy > 0 ? 0.5 : 0) + columnPenalty(x, z)
  }

  function digStepCost (cells = [], { x = 0, z = 0 } = {}) {
    const digCost = cells.reduce((sum, cell) => sum + (SOFT_BLOCK.test(String(cell?.name ?? '')) ? 2 : 6), 0)
    return 1 + digCost + columnPenalty(x, z)
  }

  return {
    has,
    isHardAvoided,
    columnPenalty,
    stepCost,
    digStepCost,
    stats: () => ({ dangerCircles: dangerCircles.length, shooterCircles: shooterCircles.length })
  }
}

module.exports = {
  createTravelCostPolicy,
  buildShooterCircles,
  buildDangerCircles
}
