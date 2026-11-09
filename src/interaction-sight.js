'use strict'

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const sightPassable = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || block.name === 'minecraft:torch' && block.boundingBox === 'empty')

// Shared by the actual interaction and site previews. The clicked support
// itself is solid; only the intervening cells need to be clear.
function interactionSightError (read, eye, point, clicked, { plannedClearance = null } = {}) {
  const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
  if (!Number.isFinite(distance) || distance > 4.5) return '操作対象が手の届く範囲外です。'
  const steps = Math.max(1, Math.ceil(distance / 0.05))
  for (let step = 0; step < steps; step++) {
    const ratio = step / steps
    const pos = {
      x: Math.floor(eye.x + (point.x - eye.x) * ratio),
      y: Math.floor(eye.y + (point.y - eye.y) * ratio),
      z: Math.floor(eye.z + (point.z - eye.z) * ratio)
    }
    if (pos.x === clicked.x && pos.y === clicked.y && pos.z === clicked.z) continue
    const block = read(pos)
    // Only read-only proposals pass this callback. Live interactions never do.
    if (!sightPassable(block) && !plannedClearance?.(block, pos)) return '操作対象への視線が遮られているか、未取得です。'
  }
  return null
}

function canSeePlacementFloor (read, eye, position, options) {
  const point = { x: position.x + 0.5, y: position.y, z: position.z + 0.5 }
  const support = { x: position.x, y: position.y - 1, z: position.z }
  return interactionSightError(read, eye, point, support, options) === null
}

module.exports = { canSeePlacementFloor, interactionSightError, sightPassable }
