'use strict'

// Long travel's own respawn bed (long-travel-runtime.js travelRespawnBed).
// Live 2026-11-17 12:04-12:08 JST: a trip from the player's house placed its bed
// inside the house, moved the respawn point off the house bed, failed to take
// the bed back, and the bed closed the doorway from inside.
// - While the player's house exists, its bed is the respawn point: long travel
//   places no bed of its own.
// - A trip bed still standing is mined again under its own record (every 30 s,
//   5 tries); then the house bed sets the respawn point again.

const houseOwnsSpawn = shared => !!shared?.playerHouse?.origin

async function recoverLeftover ({ shared, getBlock, mine, log = () => {}, now = Date.now }) {
  const rec = shared.travelBed
  if (!rec?.foot) return false
  const isBed = p => !!p && getBlock(p.x, p.y, p.z)?.name === 'minecraft:bed'
  if (!isBed(rec.foot)) { if (!isBed(rec.head)) shared.travelBed = null; return false }
  const memo = shared.travelBedLeftover ??= { at: 0, tries: 0 }
  if (now() - memo.at < 30000 || memo.tries >= 5) return false
  memo.at = now(); memo.tries++
  let why = null
  try { await mine(rec.foot, rec.key) } catch (error) { why = String(error?.message ?? error).slice(0, 80) }
  if (isBed(rec.foot)) { log(`長距離移動: 置いたままのベッド (${rec.foot.x}, ${rec.foot.y}, ${rec.foot.z}) を回収できません（${memo.tries}回目${why ? `: ${why}` : ''}）`); return false }
  shared.travelBed = null; memo.tries = 0
  if (shared.playerHouse?.spawn) shared.playerHouse = { ...shared.playerHouse, spawn: false }
  log(`長距離移動: 置いたままのベッド (${rec.foot.x}, ${rec.foot.y}, ${rec.foot.z}) を壊しました`)
  return true
}

module.exports = { houseOwnsSpawn, recoverLeftover }
