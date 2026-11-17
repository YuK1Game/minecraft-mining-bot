'use strict'

// Where the click that opens a chest, a shulker box or a furnace goes: the
// middle of the face of the block that looks most towards the eye. One rule
// for the click itself (interactions.js) and for whoever chooses a place to
// stand before it (modes/return/return-steps.js).
const { interactionSightFailure } = require('./interaction-sight')

const NORMAL = Object.freeze([{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])

function containerFace (eye, target) {
  const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z
  const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
  const offset = NORMAL[face]
  return {
    face,
    point: { x: center.x + offset.x * 0.5, y: center.y + offset.y * 0.5, z: center.z + offset.z * 0.5 },
    clickPos: { x: 0.5 + offset.x * 0.5, y: 0.5 + offset.y * 0.5, z: 0.5 + offset.z * 0.5 }
  }
}

// Null when the open click can be sent from this eye position, or why not
// ({ code: 'OUT_OF_REACH' | 'SIGHT_BLOCKED', message }). read(pos) → block.
function openAccess (read, eye, target) {
  return interactionSightFailure(read, eye, containerFace(eye, target).point, target)
}

module.exports = { containerFace, openAccess }
