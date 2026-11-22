'use strict'

// A candidate centre is 48 m or more from the home. The server announces columns around the player only,
// and the survey walk is eight level steps on received ground, so a centre the Bot cannot receive from where
// it stands stays unknown: the search deferred it, came to its end, and waited for a terrain packet that
// nothing would bring (live 2026-11-22 17:50 JST - 2026-11-23 06:53 JST: 17 centres, 8 rejected, 9 deferred
// with MINE_OBSERVATION_DEFERRED / MINE_OBSERVATION_NO_SAFE_ROUTE, 「周囲17か所の観測候補を確認しました」
// for thirteen hours, the goal early.diamond held).
//
// When the search is spent, each deferred centre is visited once: the long trip (the one way to "go to a
// place": it comes up from underground and digs or stacks where there is no walk) takes the Bot to the
// centre itself, and the centre is opened again with its walk and request budgets new, because they were
// spent from another place. One visit per centre and search (a new life starts a new search), nearest first.
// A trip that did not arrive spends the visit too. Arriving proves nothing about the terrain: the centre is
// planned from what was received, as before.
const { scope, live, save, blocked, stopped, results } = require('./mine-common')
const SPACING = 48, MAX_VISITS = 1, ARRIVED_M = 32

const centreOf = (origin, [dx, dz]) => ({ x: Math.floor(origin.x + dx * SPACING), z: Math.floor(origin.z + dz * SPACING) })
const away = (ctx, p) => { const feet = ctx.getFeet(); return feet ? Math.hypot(feet.x - p.x, feet.z - p.z) : Infinity }
// Survey walks toward a centre are for one the Bot stands near. A far one is deferred after its requests and
// left to the visit.
const withinWalk = (ctx, search, offset) => !search.origin || !offset || away(ctx, centreOf(search.origin, offset)) <= SPACING

async function visitDeferred (ctx, search, offsets) {
  if (typeof ctx.travelTo !== 'function' || !search.origin) return null
  const before = scope(ctx), visited = search.visited ??= {}
  const next = Object.values(search.deferred ?? {}).filter(wait => offsets[wait.index] && (visited[wait.index] ?? 0) < MAX_VISITS)
    .map(wait => ({ wait, centre: centreOf(search.origin, offsets[wait.index]) })).sort((a, b) => away(ctx, a.centre) - away(ctx, b.centre) || a.wait.index - b.wait.index)[0]
  if (!next) return null
  const { wait, centre } = next, index = wait.index, name = `採掘候補 ${index + 1}/${offsets.length}`
  // The visit is spent before any input is sent, so a restart cannot repeat a trip without end.
  visited[index] = (visited[index] ?? 0) + 1
  if (!await save(ctx, null, before)) { visited[index]--; return { result: blocked('MINE_CHECKPOINT', '採掘候補へ行く予定を保存します。', 'owner_released') } }
  if (away(ctx, centre) > ARRIVED_M) {
    ctx.log?.(`プレイヤーモード: ${name} は、ここからは地形を受信できないため、その場所 (${centre.x}, ${centre.z}) へ行って調べます（残り ${Math.round(away(ctx, centre))}m）`)
    let trip
    try { trip = await ctx.travelTo({ destination: centre }, { aborted: () => !live(ctx, before) }) } catch (error) {
      if (!live(ctx, before)) return { result: stopped() }
      ctx.log?.(`プレイヤーモード: ${name} への長距離移動を始められません（${String(error?.code ?? error?.message ?? error).slice(0, 80)}）。ほかの候補を先に調べます`)
      return { result: blocked('MINE_SITE_VISIT_UNAVAILABLE', '採掘候補への長距離移動を始められません。', 'position_changed') }
    }
    if (!live(ctx, before)) return { result: stopped() }
    if (away(ctx, centre) > ARRIVED_M) {
      ctx.log?.(`プレイヤーモード: ${name} の場所へ着けませんでした（残り ${Math.round(away(ctx, centre))}m、${trip?.reason ?? trip?.ended ?? '理由不明'}）。ほかの候補を先に調べます`)
      return { result: blocked('MINE_SITE_VISIT_INCOMPLETE', '採掘候補の場所へ着けませんでした。ほかの候補を先に調べます。', 'position_changed') }
    }
  }
  search.index = index
  search.wait = { revision: null, requestKey: wait.requestKey, index, code: wait.code, cells: wait.cells }
  delete search.deferred[index]
  if (!await save(ctx, null, before)) return { result: blocked('MINE_CHECKPOINT', '採掘候補に着いた記録を保存します。', 'owner_released') }
  ctx.log?.(`プレイヤーモード: ${name} の場所に着きました。ここで受信した地形から採掘場を計画し直します`)
  return { result: results.partial('MINE_SITE_VISITED', { progress: { candidate: index } }) }
}

module.exports = { visitDeferred, centreOf, withinWalk, SPACING, MAX_VISITS, ARRIVED_M }
