'use strict'

// The expedition's mine and the starter jobs: who has the player while the Bot stands inside the mine.
// The starter jobs (house repair, the return to the base, the first tools) know nothing of the mine: their way to
// the surface digs straight up or mines a stair, and from a branch floored with slabs neither begins. The mine's
// own way out is its ladder (mine-route.js `leaveMine`), and only the expedition's steps take it. So the
// expedition keeps the player until the Bot is out of the mine, and hands it over at the entrance.
// Live 2026-11-24 03:34:34-03:52 JST, plan 4cb5a6d99dac0652de75, feet (9841.52, 31.50, 10094.50) on the last slab
// of upper:branch-19-left: the hourly review of the held house repair gave the player to the starter jobs.
// 「真上へ掘る途中で止まりました（0段、PILLAR_ASCENT_POSITION_UNCONFIRMED…）」 32 times, 「掘る・積む道もありません
// （BUILD_ROUTE_SEARCH_LIMIT…）」 31 times, the return gave up (CLIMB_FAILED), 「地上へ出られないため、拠点の家を
// 建てられません」; the feet did not move for eighteen minutes. The shaft's ladder was 19 m north.
const { insideMine } = require('./mining/mine-location')

const branchOf = record => record?.stage === 'early' ? record.early?.mine?.branch ?? null : null

// Whether the Bot stands in the dug part of its own mine now (received position, the mine's own reading).
function inOwnMine ({ runtime, getFeet, record }) {
  const branch = branchOf(record)
  if (!branch?.plan || !branch.shaft) return false
  try { return insideMine({ runtime, getFeet }, branch) } catch { return false }
}

// The step that takes the ladder out; null when the Bot is not inside (the starter jobs have the player then).
async function leaveOwnMine (ctx) {
  if (!inOwnMine({ runtime: ctx.runtime, getFeet: ctx.getFeet, record: ctx.memory })) return null
  return require('./mining/mine-controller').beforeSurfaceSupply(ctx)
}

module.exports = { inOwnMine, leaveOwnMine }
