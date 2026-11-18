'use strict'

// Playing with a sword and no bow: an enemy that shoots and has just hit the
// Bot is charged. The melee approach beyond four blocks was admitted only for
// zombies and spiders, or after the idle protection had failed to find a way
// off; a skeleton shooting from 8-20 m was never a target, and with the play
// danger radius of 8 m it was not even a threat to walk away from (live
// 2026-11-19 06:00:47-06:01:09 JST: stone sword in the pack, a skeleton at
// 13.5 m, five arrows in 22 s, health 18 to 0; combat selected only a creeper
// to evade, the cover found no place, and the sword was never swung).
// - Only while playing, with a received sword, without a bow and arrows.
// - Only shooters (they keep their distance: waiting does not bring them in).
// - Only within CHARGE_M and within HURT_MS of a received hit, at HEALTH or more:
//   below it the low-health rules of the combat mode decide.
// The approach itself and every hit stay with the ordinary combat controllers.
const SHOOTERS = new Set(['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:pillager', 'minecraft:witch'])
const CHARGE_M = 20, HURT_MS = 10000, HEALTH = 8

function shooterCharge ({ playing, sword, bow, entityType, range, health, hurtAt, now = Date.now() }) {
  if (playing !== true || sword !== true || bow === true || !SHOOTERS.has(entityType)) return false
  if (!Number.isFinite(range) || range > CHARGE_M || !Number.isFinite(health) || health < HEALTH) return false
  const since = now - Number(hurtAt)
  return Number.isFinite(since) && since >= 0 && since <= HURT_MS
}

module.exports = { shooterCharge, SHOOTERS, CHARGE_M, HURT_MS, HEALTH }
