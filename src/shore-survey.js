'use strict'

const { setImmediate: yieldTurn } = require('node:timers/promises')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const HAZARD = /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/

// An observation-only survey. A returned candidate is not a checked route or
// proof of a safe arrival: movement must perform its own full preview/guard.
async function surveyShore ({ world, position, radius = 32, valid = () => true }) {
  if (typeof world?.getBlock !== 'function' || !position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis])) || !Number.isInteger(radius) || radius < 1 || radius > 64 || typeof valid !== 'function') throw new Error('Invalid shore survey')
  const cx = Math.floor(position.x); const cz = Math.floor(position.z); const feetY = position.y - 1.62
  const baseY = Math.floor(feetY); const points = []; let checked = 0; let unknown = 0
  for (let x = cx - radius; x <= cx + radius; x++) for (let z = cz - radius; z <= cz + radius; z++) {
    if (++checked % 64 === 0) { await yieldTurn(); if (!valid()) throw new Error('Shore survey ended because the session changed') }
    const distance = Math.hypot(x + 0.5 - position.x, z + 0.5 - position.z)
    if (distance > radius) continue
    // A coastline can stand several blocks above the swimmer. Observe up to
    // the next section without claiming that the bank is climbable.
    for (let y = baseY - 1; y <= baseY + 16; y++) {
      const floor = world.getBlock(x, y, z)
      if (!floor?.known) { unknown++; continue }
      if (floor.boundingBox !== 'block' || HAZARD.test(floor.name) || (floor.extra ?? []).length) continue
      const foot = world.getBlock(x, y + 1, z); const head = world.getBlock(x, y + 2, z)
      if (!foot?.known || !head?.known) { unknown++; continue }
      if (floor.boundingBox !== 'block' || HAZARD.test(floor.name) || (floor.extra ?? []).length || !AIR.has(foot.name) || !AIR.has(head.name) || (foot.extra ?? []).length || (head.extra ?? []).length) continue
      points.push({ x: x + 0.5, y: y + 1, z: z + 0.5, distance, floor: floor.name })
      break
    }
  }
  if (!valid()) throw new Error('Shore survey ended because the session changed')
  points.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z)
  return { origin: { ...position }, radius, candidates: points.slice(0, 20), knownCandidateCount: points.length, unknownSamples: unknown, checkedColumns: checked, observationOnly: true }
}

module.exports = { surveyShore }
