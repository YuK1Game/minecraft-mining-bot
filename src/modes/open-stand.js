'use strict'

// A place to stand from which a block inside the house (a furnace, a chest)
// can be opened. Within four blocks is not enough: the open click needs a
// clear line to a face of the block (actions/open-face.js, the rule the click
// itself uses), and from outside the door the walls are in the way (real
// Realm 2026-11-18 23:15-23:26 JST: one block south of the open door, 3.6 m
// from the home furnace, every cook ended with 「操作対象への視線が遮られているか、
// 未取得です。」 for eleven minutes; the furnace's free face looks into the room).
const { openAccess } = require('../actions/open-face')
const { low } = require('./low-block')

const EYE = 1.62, RANGE = 3, TRIES = 4

function createOpenStand ({ getBlock, getFeet, walk }) {
  const read = pos => getBlock(pos.x, pos.y, pos.z)
  const firm = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox === 'block' && !low(found) }
  const free = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox !== 'block' && !/water|lava/.test(found.name ?? '') }
  const opensFrom = (stand, target) => !openAccess(read, { x: stand.x, y: stand.y + EYE, z: stand.z }, target)
  const here = target => { const feet = getFeet(); return !!feet && opensFrom(feet, target) }
  // Standable cells around the target from whose middle the open click has a line, nearest to the Bot first.
  function stands (target) {
    const feet = getFeet(), found = []
    if (!feet) return found
    for (let dx = -RANGE; dx <= RANGE; dx++) for (let dz = -RANGE; dz <= RANGE; dz++) for (const dy of [0, -1, 1]) {
      const x = target.x + dx, y = target.y + dy, z = target.z + dz
      if (!firm(x, y - 1, z) || !free(x, y, z) || !free(x, y + 1, z)) continue
      const stand = { x: x + 0.5, y, z: z + 0.5 }
      if (opensFrom(stand, target)) found.push(stand)
    }
    const far = stand => Math.hypot(stand.x - feet.x, stand.y - feet.y, stand.z - feet.z)
    return found.sort((a, b) => far(a) - far(b)).slice(0, TRIES)
  }
  // True when the Bot ends where the block can be opened.
  async function go (target, aborted = () => false) {
    if (here(target)) return true
    for (const stand of stands(target)) {
      if (aborted()) return false
      try { await walk(stand) } catch {}
      if (here(target)) return true
    }
    return false
  }
  return { here, stands, go }
}

module.exports = { createOpenStand }
