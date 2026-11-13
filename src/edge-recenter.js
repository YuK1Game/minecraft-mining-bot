'use strict'

// A dry land pose half over an edge (some footprint corners above air) fails
// every "full standing" proof, and ordinary route planning will not start from
// it. List nearby cell centers at the same feet height whose full footprint is
// supported, for the navigator's bounded partial-recenter step (0.2..1.2m).
// This is a candidate list only; the native preview still decides.
const HALF_WIDTH = 0.2999
const MIN_STEP = 0.2
const MAX_STEP = 1.2
const { finitePoint: finite } = require('./vec3')
const open = b => b?.known === true && b.boundingBox === 'empty' && !(b.extra ?? []).length && !/(?:lava|fire|water|cactus|magma|powder_snow|sweet_berry)/.test(String(b.name ?? ''))
const solid = b => b?.known === true && b.boundingBox === 'block' && !(b.extra ?? []).length && !/(?:lava|magma|cactus|campfire)/.test(String(b.name ?? ''))

function fullySupported (world, feet) {
  const y = Math.round(feet.y)
  for (const dx of [-HALF_WIDTH, HALF_WIDTH]) for (const dz of [-HALF_WIDTH, HALF_WIDTH]) {
    const x = Math.floor(feet.x + dx), z = Math.floor(feet.z + dz)
    if (!solid(world.getBlock(x, y - 1, z)) || !open(world.getBlock(x, y, z)) || !open(world.getBlock(x, y + 1, z))) return false
  }
  return true
}

function landEdgeRecenterTargets (world, feet) {
  if (!finite(feet) || Math.abs(feet.y - Math.round(feet.y)) > 1e-4 || fullySupported(world, feet)) return []
  const y = Math.round(feet.y), out = []
  for (let x = Math.floor(feet.x) - 1; x <= Math.floor(feet.x) + 1; x++) for (let z = Math.floor(feet.z) - 1; z <= Math.floor(feet.z) + 1; z++) {
    const position = { x: x + 0.5, y, z: z + 0.5 }, distance = Math.hypot(position.x - feet.x, position.z - feet.z)
    if (distance < MIN_STEP || distance > MAX_STEP || !fullySupported(world, position)) continue
    out.push({ position, distance })
  }
  return out.sort((a, b) => a.distance - b.distance || a.position.x - b.position.x || a.position.z - b.position.z)
}

module.exports = { landEdgeRecenterTargets, fullySupported }
