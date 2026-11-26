'use strict'

// The expedition's use of one thing in its house (the bed, a large chest, a furnace, the table, the entrance).
//
// The house's record says what was last observed of the whole house; a job never uses a thing because of it.
// It reads the thing's received blocks now (house/house-facilities.js):
// - standing: go there and use it through the existing steps (the walk in, the open click, the 54 slots, the
//   cook). When the blueprint has two (large chest A and B, two furnaces) the other one is used while the first
//   is broken, or after the job's own use of the first failed three times (`spent`, the goal's ledger);
// - unknown (cells not received): go to it, and decide when its blocks are received;
// - broken: the observation is written down and the repair of that one thing is asked for
//   (house/house-repair.js `needHouse`). The ordinary build puts it back and the job goes on from there; a
//   repair that was tried and held is not asked for again and again (the answer is a blocked result).
const { facility, LABEL } = require('./house/house-facilities')
const { needHouse } = require('./house/house-repair')
const { blocked } = require('./return/return-result')

const NEAR_M = 12
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z

// Where the thing is looked for: the standing one (the one used before first), else the blueprint's.
function homeTarget (ctx, name, { prefer = null, spent = () => false } = {}) {
  return facility(ctx.getBlock, ctx.shared.playerHouse.origin, name, { prefer, spent })
}

// At the house: may the job use the thing now? { ok: true, at, alternative } or { ok: false, state, reason, result }.
function homeUse (ctx, name, options = {}) {
  const seen = homeTarget(ctx, name, options), label = LABEL[name]
  if (seen.state === 'standing') return { ok: true, at: seen.at, alternative: seen.alternative }
  const no = (reason, result) => ({ ok: false, state: seen.state, at: seen.at, reason, result })
  if (seen.state === 'unknown') return no(`本拠点の${label}のブロックの受信を待ちます。`, blocked('HOME_FACILITY_UNKNOWN', { kind: 'terrain_received' }))
  if (seen.state === 'spent') return no(`本拠点の${label}は立っていますが使えなかったため、場所か状態が変わるまで保留します。`, blocked('HOME_FACILITY_SPENT', { kind: 'time', ms: 120000 }))
  const asked = needHouse(ctx.shared, ctx.getBlock, name, { now: (ctx.now ?? Date.now)(), log: ctx.log })
  return asked.state === 'held'
    ? no(`本拠点の${label}が壊れていて、修理は保留中です（材料か家の様子が変わった時に見直します）。`, blocked('HOME_FACILITY_HELD', { kind: 'supplies_changed' }))
    : no(`本拠点の${label}が壊れているため、そこを先に直します。`, blocked('HOME_FACILITY_REPAIR', { kind: 'time' }))
}

// A walk into the house that did not arrive, beside a doorway whose floor is received as gone: the entrance is
// asked for (the way that digs and stacks stays the other way in, dragon-early-home.js).
function entranceNeed (ctx) {
  const origin = ctx.shared.playerHouse?.origin, feet = ctx.getFeet?.()
  if (!origin || !feet || Math.hypot(feet.x - (origin.x + 3.5), feet.z - (origin.z + 6.5)) > NEAR_M) return null
  if (facility(ctx.getBlock, origin, 'entrance').state !== 'broken') return null
  return needHouse(ctx.shared, ctx.getBlock, 'entrance', { now: (ctx.now ?? Date.now)(), log: ctx.log })
}

module.exports = { homeTarget, homeUse, entranceNeed, same }
