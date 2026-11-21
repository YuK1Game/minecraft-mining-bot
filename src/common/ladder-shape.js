'use strict'

const { placementSupportOk } = require('../quarry/storage/storage-site-terrain')
const { bottomCobblestoneSlab } = require('./cobblestone-slab')
// Collision/selection plates from the pinned Bedrock 1.26.60 block states.
// A rung is never transparent by name alone: facing and a full backing block
// must be received, and rays touching its 3/16-thick plate remain blocked.
const SHAPES = {
  2: { box: [0, 0, 13 / 16, 1, 1, 1], wall: [0, 1] },
  3: { box: [0, 0, 0, 1, 1, 3 / 16], wall: [0, -1] },
  4: { box: [13 / 16, 0, 0, 1, 1, 1], wall: [1, 0] },
  5: { box: [0, 0, 0, 3 / 16, 1, 1], wall: [-1, 0] }
}
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))

function rayMissesBox (box, position, eye, point) {
  if (!finite(position) || !finite(eye) || !finite(point)) return false
  let entry = 0, exit = 1
  for (const [index, axis] of ['x', 'y', 'z'].entries()) {
    const min = position[axis] + box[index], max = position[axis] + box[index + 3], delta = point[axis] - eye[axis]
    if (Math.abs(delta) < 1e-12) {
      if (eye[axis] < min - 1e-9 || eye[axis] > max + 1e-9) return true
      continue
    }
    const a = (min - eye[axis]) / delta, b = (max - eye[axis]) / delta
    entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
    if (entry > exit + 1e-9) return true
  }
  return false
}

function ladderRayClear (block, position, eye, point, read) {
  if (block?.known !== true || block.name !== 'minecraft:ladder' || block.extra?.length || !finite(position) || typeof read !== 'function') return false
  const face = block.properties?.facing_direction
  const shape = Number.isInteger(face) ? SHAPES[face] : null
  if (!shape || !placementSupportOk(read({ x: position.x + shape.wall[0], y: position.y, z: position.z + shape.wall[1] }))) return false
  return rayMissesBox(shape.box, position, eye, point)
}

// The known lower half remains opaque; only the empty upper half can carry a
// view from a mine's permanent landing into the next shaft working level.
function bottomSlabRayClear (block, position, eye, point) {
  return bottomCobblestoneSlab(block) && rayMissesBox([0, 0, 0, 1, 0.5, 1], position, eye, point)
}

module.exports = { ladderRayClear, bottomSlabRayClear }
