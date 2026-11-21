'use strict'

// This is the received Bedrock state, not the item's name or a guessed shape.
const bottomCobblestoneSlab = block => block?.known === true && block.name === 'minecraft:cobblestone_slab' && block.properties?.['minecraft:vertical_half'] === 'bottom' && !block.extra?.length

function bottomSlabFooting (world, state) {
  const eye = state?.position
  if (!eye || !['x', 'y', 'z'].every(axis => Number.isFinite(eye[axis]))) return false
  const feetY = eye.y - 1.62, level = Math.round(feetY - 0.5)
  if (Math.abs(feetY - level - 0.5) > 0.05 || state.onGround === false) return false
  const physical = state.predicted?.physicsState ?? state.physicsState
  if (physical && (physical.onGround !== true || !physical.velocity || Math.hypot(physical.velocity.x, physical.velocity.z) > 0.02 || physical.velocity.y < -0.12 || physical.velocity.y > 0.05)) return false
  for (let x = Math.floor(eye.x - 0.3 + 1e-7); x <= Math.floor(eye.x + 0.3 - 1e-7); x++) {
    for (let z = Math.floor(eye.z - 0.3 + 1e-7); z <= Math.floor(eye.z + 0.3 - 1e-7); z++) {
      if (!bottomCobblestoneSlab(world.getBlock(x, level, z))) return false
    }
  }
  return true
}

module.exports = { bottomCobblestoneSlab, bottomSlabFooting }
