'use strict'

// Player mode: a finished house that lost blocks is built again.
//
// The house record says done once and nothing looked at the blocks again. A
// creeper blast (real Realm 2026-11-19 01:34 JST) took the door, the floor
// behind it and the ground in front; for ten hours every walk in and out of
// the house was a special case (door exit by a dug way, the door step as an
// island, the furnace reached by a bridge) and the house stayed broken.
// - Near the house (NEAR_M), with every blueprint cell received, the steps
//   not standing are counted (house-blueprint.js `remaining`).
// - Missing steps seen twice, CONFIRM_MS apart, reopen the build: the record
//   is set to not done and the ordinary build (house-build.js, the same
//   placements and materials) puts the blocks back.
// - A repair not finished within GIVE_UP_MS is closed again (done), so the
//   rest of the play is not held by a block that cannot be placed; it is
//   looked at again after AGAIN_MS.
// - Unreceived cells are never counted as missing.
const { placements, remaining } = require('./house-blueprint')

const NEAR_M = 16, CONFIRM_MS = 4000, GIVE_UP_MS = 20 * 60000, AGAIN_MS = 60 * 60000

function createHouseDamage ({ shared, getBlock, getFeet, log = () => {}, now = Date.now } = {}) {
  let seenAt = null, seenCount = 0
  function tick () {
    const house = shared.playerHouse
    if (!house?.origin) return null
    const repair = shared.playerHouseRepair ?? null
    if (house.done !== true) {
      // Reopened before a reload or a restart (the record keeps `spawn` from the finished house): the same time limit, counted from now.
      if (!repair && house.spawn === true) { shared.playerHouseRepair = { open: true, since: now() }; return null }
      // An open repair that ran out of time is closed; the build's own record of what is left stays.
      if (repair?.open === true && now() - repair.since >= GIVE_UP_MS) {
        shared.playerHouse = { ...house, done: true }
        shared.playerHouseRepair = { open: false, since: repair.since, gaveUpAt: now() }
        log(`プレイヤーモード: 家の修理が ${Math.round(GIVE_UP_MS / 60000)} 分で終わらないため、いったん打ち切ります（${Math.round(AGAIN_MS / 60000)} 分後に見直します）`)
        return 'gave_up'
      }
      return null
    }
    if (repair?.open === true) { shared.playerHouseRepair = { open: false, since: repair.since, finishedAt: now() }; log('プレイヤーモード: 家の修理が終わりました'); return 'repaired' }
    if (repair?.gaveUpAt != null && now() - repair.gaveUpAt < AGAIN_MS) return null
    const feet = getFeet(), o = house.origin
    if (!feet || Math.hypot(feet.x - (o.x + 3.5), feet.z - (o.z + 3.5)) > NEAR_M) { seenAt = null; return null }
    const steps = placements(o)
    if (!steps.every(step => step.cells.every(cell => getBlock(cell.x, cell.y, cell.z)?.known === true))) { seenAt = null; return null }
    const left = remaining(getBlock, o)
    if (!left.length) { seenAt = null; return null }
    if (seenAt === null || left.length !== seenCount) { seenAt = now(); seenCount = left.length; return null }
    if (now() - seenAt < CONFIRM_MS) return null
    seenAt = null
    shared.playerHouse = { ...house, done: false }
    shared.playerHouseRepair = { open: true, since: now(), steps: left.length }
    const items = [...new Set(left.map(step => step.item))].slice(0, 5).join('・')
    log(`プレイヤーモード: 家が壊れています（${left.length} 手: ${items}）。設計図どおりに直します`)
    return 'reopened'
  }
  return { tick }
}

module.exports = { createHouseDamage, NEAR_M, CONFIRM_MS, GIVE_UP_MS, AGAIN_MS }
