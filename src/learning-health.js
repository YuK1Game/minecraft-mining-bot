'use strict'

// 2026-11-14 01:59 user: "クリーパーに爆破され落下しました。不死のトーテムを持っている
// 限り死ぬことはないので、過剰な待機保護をやめてください". While the received offhand holds a
// totem of undying (state.totemGuard, set by the runtime from the server's
// offhand slot only), health alone stops no work. A used totem empties the
// offhand and the ordinary minimum applies again.
const totemGuarded = state => state?.totemGuard === true && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending
function resourceMinHealth (state, legacy = 6) {
  if (totemGuarded(state)) return 0
  return state?.threatPolicy === 'online_learning' && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending ? 0 : legacy
}

module.exports = { resourceMinHealth, totemGuarded }
