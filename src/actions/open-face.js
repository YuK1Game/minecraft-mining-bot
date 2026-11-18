'use strict'

// Where the click that opens a chest, a shulker box or a furnace goes: the
// middle of a face of the block that looks towards the eye. One rule for the
// click itself (interactions.js) and for whoever chooses a place to stand
// before it (modes/return/return-steps.js).
//
// The face that looks most towards the eye comes first. With the received
// blocks at hand (`read`), the other faces that look towards the eye are
// tried when the line to that one is closed or out of reach. A furnace in a
// niche beside the feet has stone on it: from 1.62 above the floor its top is
// the face most towards the eye, and its side, one arm away, is open (real
// Realm 2026-11-18 20:13-20:20 JST: the expedition's furnace stood in the wall
// niche of a one-wide tunnel, every open click chose the top and ended with
// 「操作対象への視線が遮られているか、未取得です。」, unlogged, every two seconds).
const { interactionSightFailure } = require('./interaction-sight')

const NORMAL = Object.freeze([{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])

function faceAt (center, face) {
  const offset = NORMAL[face]
  return {
    face,
    point: { x: center.x + offset.x * 0.5, y: center.y + offset.y * 0.5, z: center.z + offset.z * 0.5 },
    clickPos: { x: 0.5 + offset.x * 0.5, y: 0.5 + offset.y * 0.5, z: 0.5 + offset.z * 0.5 }
  }
}

function containerFace (eye, target, read = null) {
  const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z
  const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
  const first = faceAt(center, face)
  if (!read || !interactionSightFailure(read, eye, first.point, target)) return first
  // The eye is in front of a face when it is beyond that face's plane.
  const others = [[dy, dy > 0 ? 1 : 0], [dx, dx > 0 ? 5 : 4], [dz, dz > 0 ? 3 : 2]]
    .filter(([distance, other]) => Math.abs(distance) > 0.5 && other !== face)
    .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
  for (const [, other] of others) {
    const next = faceAt(center, other)
    if (!interactionSightFailure(read, eye, next.point, target)) return next
  }
  return first
}

// Null when the open click can be sent from this eye position, or why not
// ({ code: 'OUT_OF_REACH' | 'SIGHT_BLOCKED', message }). read(pos) → block.
function openAccess (read, eye, target) {
  return interactionSightFailure(read, eye, containerFace(eye, target, read).point, target)
}

module.exports = { containerFace, openAccess }
