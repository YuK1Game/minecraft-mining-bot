'use strict'

const { placementSupportOk } = require('../quarry/storage/storage-site-terrain')
const { bottomCobblestoneSlab } = require('../common/cobblestone-slab')
const FACE = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|pointed_dripstone|sand$|gravel$|concrete_powder$/
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const fail = code => { throw Object.assign(new Error(code), { code }) }

function ladderAt (getBlock, point) {
  const b = getBlock(point.x, point.y, point.z), face = b?.properties?.facing_direction
  if (b?.known !== true || b.name !== 'minecraft:ladder' || b.extra?.length || !Number.isInteger(face) || face < 2 || face > 5) return null
  const offset = FACE[face], supportPosition = { x: point.x - offset.x, y: point.y, z: point.z - offset.z }
  const support = getBlock(supportPosition.x, supportPosition.y, supportPosition.z)
  if (!placementSupportOk(support)) return null
  return { position: { ...point }, face, supportPosition, block: b, support }
}

function safeBody (getBlock, physics, feet) {
  for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) for (let y = Math.floor(feet.y + 1e-7); y <= Math.floor(feet.y + 1.8 - 1e-7); y++) {
    const raw = getBlock(x, y, z)
    if (raw?.known !== true || raw.extra?.length || HAZARD.test(raw.name ?? '')) fail('LADDER_BODY_UNSAFE')
    const block = physics.blockAt({ x, y, z })
    if (block.shapes.some(box => feet.x + 0.3 > x + box[0] + 1e-6 && feet.x - 0.3 < x + box[3] - 1e-6 && feet.z + 0.3 > z + box[2] + 1e-6 && feet.z - 0.3 < z + box[5] - 1e-6 && feet.y + 1.8 > y + box[1] + 1e-6 && feet.y < y + box[4] - 1e-6)) fail('LADDER_BODY_OBSTRUCTED')
  }
  return true
}

function landingAt (getBlock, physics, feet) {
  if (!finite(feet)) return false
  try { safeBody(getBlock, physics, feet) } catch { return false }
  const y = Math.floor(feet.y - 1e-5)
  for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
    const raw = getBlock(x, y, z)
    if (!placementSupportOk(raw) && !bottomCobblestoneSlab(raw)) return false
    const shapes = physics.blockAt({ x, y, z }).shapes
    if (!shapes.some(b => Math.abs(y + b[4] - feet.y) < 1e-4 && x + b[0] <= Math.max(x, feet.x - 0.3) + 1e-7 && x + b[3] >= Math.min(x + 1, feet.x + 0.3) - 1e-7 && z + b[2] <= Math.max(z, feet.z - 0.3) + 1e-7 && z + b[5] >= Math.min(z + 1, feet.z + 0.3) - 1e-7)) return false
  }
  return true
}

function ladderPlan (request, getBlock, physics) {
  const { from: origin, to, column } = request ?? {}
  if (!finite(origin) || !finite(to) || !column || !Number.isSafeInteger(column.x) || !Number.isSafeInteger(column.z) || Math.abs(to.y - origin.y) > 192) fail('LADDER_INVALID_REQUEST')
  // A normal walk may settle off-centre while its whole body remains on the
  // received landing. Keep that actual origin for both the server witness
  // and physics. Its cell centre describes only the route's adjacency.
  const from = { ...origin }, fromCell = { x: Math.floor(origin.x) + 0.5, y: origin.y, z: Math.floor(origin.z) + 0.5 }
  if (Math.hypot(fromCell.x - origin.x, fromCell.z - origin.z) > 0.2) fail('LADDER_ORIGIN_NOT_CENTRED')
  const centre = { x: column.x + 0.5, z: column.z + 0.5 }
  for (const p of [fromCell, to]) {
    const dx = Math.abs(p.x - centre.x), dz = Math.abs(p.z - centre.z)
    if (dx + dz > 1.001 || Math.min(dx, dz) > 0.001 || Math.abs(p.x - Math.floor(p.x) - 0.5) > 0.001 || Math.abs(p.z - Math.floor(p.z) - 0.5) > 0.001) fail('LADDER_LANDING_NOT_ADJACENT')
  }
  if (!landingAt(getBlock, physics, from)) fail('LADDER_ORIGIN_UNSUPPORTED')
  if (!landingAt(getBlock, physics, to)) fail('LADDER_TARGET_UNSUPPORTED')
  const columnLevel = p => {
    const y = Math.ceil(p.y), halfStep = y - p.y
    return Math.hypot(p.x - centre.x, p.z - centre.z) > 0.1 && halfStep > 0.001 && halfStep <= 0.55 && landingAt(getBlock, physics, { ...centre, y }) ? y : p.y
  }
  const climbFromY = columnLevel(fromCell), climbToY = columnLevel(to)
  const minY = Math.floor(Math.min(climbFromY, climbToY) + 1e-5), maxY = Math.ceil(Math.max(climbFromY, climbToY) - 1e-5)
  let facing = null
  for (let y = minY; y <= maxY; y++) {
    const rung = ladderAt(getBlock, { ...column, y })
    if (!rung || facing !== null && facing !== rung.face) fail('LADDER_CONTINUITY_UNCONFIRMED')
    facing = rung.face
  }
  safeBody(getBlock, physics, from)
  return { column: { ...column }, centre, from, to: { ...to }, minY, maxY, facing, climbToY, direction: Math.sign(climbToY - climbFromY) }
}

module.exports = { FACE, ladderAt, ladderPlan, landingAt, safeBody, finite, fail }
