'use strict'

// Player mode: stand in the middle of the block before trying again.
// The planners take the body as "standing on known ground" only when every
// cell its 0.6-wide footprint touches is clear. Pressed against a wall or at
// the rim of a hole the footprint reaches into a neighbouring cell, and each
// planner then answers "settle first" without moving (real Realm 2026-11-16
// 17:25-18:08 JST: at the rim of a hole and 0.0002 inside a wall cell, 23
// stops in a row on 「足元の確認」 and "Settle on known dry land before
// approaching ore", the Bot never moved). After a stopped run the Bot walks
// to the centre of its own cell; when the short walk does not move it, one
// step to a free cell beside it and back. Nothing is mined or placed.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const REACH = 0.2 // from the centre, the footprint (half width 0.3) reaches the cell border
const SKIN = 1e-3
const OFF = 0.06
const { offGrid } = require('./low-block')

const finite = point => !!point && [point.x, point.y, point.z].every(Number.isFinite)
const solid = found => found?.known === true && found.boundingBox === 'block'
const air = found => found?.known === true && AIR.test(found.name ?? '')

// The Bot's own cell when it can be stood in and the body reaches out of it; null otherwise.
function offCentre (getBlock, feet) {
  if (!finite(feet) || Math.abs(feet.y - Math.round(feet.y)) > 0.01) return null
  const cell = { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) }
  const dx = Math.abs(feet.x - cell.x - 0.5), dz = Math.abs(feet.z - cell.z - 0.5)
  if (dx < REACH - SKIN && dz < REACH - SKIN) return null
  if (!solid(getBlock(cell.x, cell.y - 1, cell.z)) || !air(getBlock(cell.x, cell.y, cell.z)) || !air(getBlock(cell.x, cell.y + 1, cell.z))) return null
  return cell
}

// ports: the scaffold's hands (player-scaffold-ports.js); only feet, block and walk are used.
async function settle ({ ports, aborted = () => false }) {
  const { feet, block, walk } = ports
  // On a chest or another low block: one step down beside it (modes/low-block.js).
  // Hanging a little above the floor (the prediction stopped mid-fall, live
  // 2026-11-17 21:27-21:35 JST: 0.23 above netherrack with onGround false, the
  // step-down found no low block and every base trip leg failed for eight
  // minutes): the ordinary landing first, then the step-down.
  const landed = async () => typeof ports.land === 'function' && await ports.land() && !offGrid(feet())
  if (offGrid(feet())) {
    const at = feet(), here = block(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
    if (air(here) && await landed()) return { ok: true, landed: true }
    if (typeof ports.stepOff === 'function' && await ports.stepOff()) return { ok: true, steppedOff: true }
    if (!air(here) && await landed()) return { ok: true, landed: true }
    return { ok: false, reason: 'STILL_ON_LOW_BLOCK', detail: ports.why?.() ?? null }
  }
  const cell = offCentre(block, feet())
  if (!cell) return { ok: false, reason: 'NOT_NEEDED' }
  const centre = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
  const off = () => { const at = feet(); return finite(at) ? Math.hypot(at.x - centre.x, at.z - centre.z) : Infinity }
  await walk(centre)
  if (off() <= OFF) return { ok: true, cell, stepped: false }
  if (aborted()) return { ok: false, reason: 'ABORTED', cell }
  const room = (x, y, z) => solid(block(x, y - 1, z)) && air(block(x, y, z)) && air(block(x, y + 1, z))
  const head = air(block(cell.x, cell.y + 2, cell.z))
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = cell.x + sx, z = cell.z + sz
    // Level, one step up (room over the own head) or one step down (room to step back up).
    const y = room(x, cell.y, z) ? cell.y : head && room(x, cell.y + 1, z) ? cell.y + 1 : room(x, cell.y - 1, z) && air(block(x, cell.y + 1, z)) ? cell.y - 1 : null
    if (y === null) continue
    await walk({ x: x + 0.5, y, z: z + 0.5 })
    if (aborted()) return { ok: false, reason: 'ABORTED', cell }
    await walk(centre)
    break
  }
  return off() <= OFF ? { ok: true, cell, stepped: true } : { ok: false, reason: 'STILL_OFF_CENTRE', cell, off: off(), detail: ports.why?.() ?? null }
}

module.exports = { settle, offCentre, offGrid }
