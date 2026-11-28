'use strict'

// Neutral idle frames keep the player floating in water or sneaking on a ladder
// while airborne so mid-ladder stops and placements never slide down between operations.
function idleFrameControls (physicsState, world, floating) {
  const fp = physicsState.position
  const onLadder = !floating && !physicsState.onGround &&
    world.getBlock(Math.floor(fp.x), Math.floor(fp.y + 1e-4), Math.floor(fp.z))?.name === 'minecraft:ladder'
  const wasJumping = physicsState.controls?.jump === true
  const wasSneaking = physicsState.controls?.sneak === true
  const controls = onLadder ? { sneak: true } : { jump: !!floating }
  const inputFlags = floating
    ? ['jumping', 'want_up', ...(!wasJumping ? ['start_jumping'] : [])]
    : onLadder
      ? ['sneaking', 'sneak_down', ...(!wasSneaking ? ['start_sneaking'] : [])]
      : []
  return { controls, inputFlags }
}

module.exports = { idleFrameControls }
