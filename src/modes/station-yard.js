'use strict'

// Near the house, the furnace is the house's own one.
//
// A furnace needed on the surface was put down wherever the Bot stood when no furnace was within a few blocks
// (dragon-supplies.js `station`, mining/mine-supplies.js `station`). Each later need stood somewhere else, so the
// ground between the house and the mine entrance filled with single furnaces (live 2026-11-20 to 2026-11-25: 41
// placed furnaces in .local/player-workstations.json, 13 of them later unreachable for recovery). Within YARD_M of
// the house on the overworld and on its level, the house's furnace is used instead and no portable one is placed.
// A walk there that brings the Bot no nearer is a failure for the goal's ledger; after three the house's furnace is
// left and the old way (a furnace nearby, or the held one put down) is taken again.
const YARD_M = 48, RISE_M = 16, GAIN_M = 2
const TRIAL = { stage: 'station-yard', target: 'home-furnace', code: 'HOME_FURNACE_UNREACHED' }

const flat = (a, b) => Math.hypot(a.x + 0.5 - b.x, a.z + 0.5 - b.z)

function dimensionOf (ctx) {
  try { return (ctx.runtime?.mineState?.() ?? ctx.runtime?.raw?.())?.dimension ?? null } catch { return null }
}

// Whether a furnace need here goes to the house's furnace.
function homeFurnaceFirst (ctx) {
  const origin = ctx.shared?.playerHouse?.origin, feet = ctx.getFeet?.()
  if (!origin || !feet || dimensionOf(ctx) !== 'overworld') return false
  if (flat(origin, feet) > YARD_M || Math.abs(feet.y - origin.y) > RISE_M) return false
  if (ctx.goal?.spent?.(TRIAL) === true) return false
  try { return require('./dragon-home-use').homeTarget(ctx, 'furnace').state === 'standing' } catch { return false }
}

// To the house's furnace: { at } when it can be opened from where the Bot stands, { reason, result } while on the
// way, null when the house's furnace is not the one to use.
async function homeFurnace (ctx) {
  if (!homeFurnaceFirst(ctx)) return null
  const { homeTarget } = require('./dragon-home-use')
  const target = homeTarget(ctx, 'furnace').at, before = ctx.getFeet?.()
  const home = await require('./dragon-home-iron').homeStation(ctx, 'furnace')
  if (home.at) return { at: home.at }
  const after = ctx.getFeet?.()
  if (!ctx.cancelled?.() && target && before && after && flat(target, before) - flat(target, after) < GAIN_M) {
    const noted = ctx.goal?.fail?.(TRIAL, { paceMs: 10000 })
    if (noted?.exhausted) ctx.log?.('プレイヤーモード: 本拠点のかまどへ3回近づけなかったため、近くのかまどか持っているかまどを使います')
  }
  return { reason: home.reason ?? '本拠点のかまどへ向かいます。', result: home.result ?? null }
}

module.exports = { homeFurnaceFirst, homeFurnace, YARD_M, TRIAL }
