'use strict'

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const sightPassable = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || block.name === 'minecraft:torch' && block.boundingBox === 'empty')
// Leaf litter is a layer one sixteenth high on the floor of its cell (the same fact as combat/aim.js LITTER_TOP):
// the part of a line that is higher than that in the cell does not touch it. A click's line ends on a floor, so
// each point of the line is asked by its own height. Live 2026-11-20 03:49-03:55 JST: standing in a litter cell,
// the line from the eye (1.62 above that cell's floor) to the floor of every cell beside it was "blocked" by the
// Bot's own cell, and no crafting table could be put down for six minutes.
const LITTER_TOP = 0.125
const overLitter = (block, height) => block?.known === true && block.name === 'minecraft:leaf_litter' && block.boundingBox === 'empty' && !block.extra?.length && height >= LITTER_TOP

// Shared by the actual interaction and site previews. The clicked support
// itself is solid; only the intervening cells need to be clear.
// Null when the click can be sent, or why not: { code, message }. The code is
// what a caller decides on (OUT_OF_REACH: stand closer; SIGHT_BLOCKED: stand
// somewhere else); the message is for the log.
function interactionSightFailure (read, eye, point, clicked, { plannedClearance = null } = {}) {
  const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
  if (!Number.isFinite(distance) || distance > 4.5) return { code: 'OUT_OF_REACH', message: '操作対象が手の届く範囲外です。' }
  const steps = Math.max(1, Math.ceil(distance / 0.05))
  for (let step = 0; step < steps; step++) {
    const ratio = step / steps
    const y = eye.y + (point.y - eye.y) * ratio
    const pos = {
      x: Math.floor(eye.x + (point.x - eye.x) * ratio),
      y: Math.floor(y),
      z: Math.floor(eye.z + (point.z - eye.z) * ratio)
    }
    if (pos.x === clicked.x && pos.y === clicked.y && pos.z === clicked.z) continue
    const block = read(pos)
    // Only read-only proposals pass this callback. Live interactions never do.
    if (!sightPassable(block) && !overLitter(block, y - pos.y) && !plannedClearance?.(block, pos)) return { code: 'SIGHT_BLOCKED', message: '操作対象への視線が遮られているか、未取得です。' }
  }
  return null
}
const interactionSightError = (read, eye, point, clicked, options) => interactionSightFailure(read, eye, point, clicked, options)?.message ?? null

function canSeePlacementFloor (read, eye, position, options) {
  const point = { x: position.x + 0.5, y: position.y, z: position.z + 0.5 }
  const support = { x: position.x, y: position.y - 1, z: position.z }
  return interactionSightError(read, eye, point, support, options) === null
}

module.exports = { canSeePlacementFloor, interactionSightError, interactionSightFailure, sightPassable }
