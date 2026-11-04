'use strict'

function resourceMinHealth (state, legacy = 6) {
  return state?.threatPolicy === 'online_learning' && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending ? 0 : legacy
}

module.exports = { resourceMinHealth }
