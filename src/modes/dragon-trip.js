'use strict'

// One long trip of the expedition, owned by the step that asked for it.
//
// A long trip runs by itself once started (leg after leg, src/travel/long-travel.js).
// The expedition used to start one and return, and its next two-second step ran
// between two legs: hunting, cooking or a dug walk began while the trip was still
// walking, and each refused the other (live 2026-11-18 20:30-20:35 JST: with
// raw meat in hand the food step and a trip to a search point took turns for five
// minutes, 「CHUNK_TRAVEL_BUSY」 and 「前の操作が完了するまで待ってください。」,
// 60-70 m from the base; 18:19-18:31 JST the same between the mine walk and a trip).
//
// Here the step keeps the trip until it ends:
// - a trip nobody is watching (left by an interrupted step) is cancelled first;
// - the step waits for its own trip (operation id), so nothing else of the
//   expedition starts meanwhile;
// - it cancels the trip when the step is cancelled, when what the trip was looking
//   for has come into view (`until`), or when the trip has not come STALL_M closer
//   for STALL_MS (never while the night pit holds it);
// - a trip that is no longer its own is left alone.
//
// What the trip tells its goal (goal/goal-ledger.js; `goal` and `destination` are optional):
// - closer to this destination than ever is a mark, the arrival one confirmed step. A walk to and fro sets neither;
// - a trip that stalled or ended short is one failure of this way from this place. After three the trip is not
//   started from here again (`ended: 'spent'`): the step decides without it until the Bot stands somewhere else.
//   A trip that is refused at once (another operation is ending) is asked again two seconds later: one failure
//   per PACE_MS at most, so three refusals in six seconds do not spend the way.
const STALL_MS = 240000, STALL_M = 8, POLL_MS = 500, PACE_MS = 60000
const cell = (at, size) => at && Number.isFinite(at.x) && Number.isFinite(at.z) ? `${Math.floor(at.x / size)},${Math.floor(at.z / size)}` : null

async function expeditionTrip ({ start, status, cancel, cancelled = () => false, until = null, resting = () => false, log = () => {},
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), stallMs = STALL_MS, pollMs = POLL_MS, goal = null, destination = null, getFeet = () => null } = {}) {
  const stop = async () => { try { await cancel() } catch { /* The trip ends by itself; the next step reads its state. */ } }
  const place = cell(destination, 16)
  const failure = () => ({ stage: 'trip', target: place, code: 'TRIP_FAILED', state: { from: cell(getFeet(), 16) } })
  if (goal && place && goal.spent(failure())) return { ...(status() ?? {}), ended: 'spent' }
  if (status()?.busy === true) await stop()
  const begun = await start()
  const id = begun?.operationId ?? status()?.operationId ?? null
  const mine = () => { const trip = status(); return trip?.busy === true && (trip.operationId ?? null) === id }
  let best = Infinity, bestAt = now(), why = null
  while (mine()) {
    if (cancelled()) { why = 'cancelled'; break }
    let found = false
    try { found = typeof until === 'function' && until() === true } catch { /* Not in view. */ }
    if (found) { why = 'found'; break }
    const left = status()?.remaining
    if (place && Number.isFinite(left)) goal?.mark('trip:' + place, left)
    if (resting() || (Number.isFinite(left) && left < best - STALL_M)) { if (Number.isFinite(left)) best = Math.min(best, left); bestAt = now() }
    if (now() - bestAt >= stallMs) { why = 'stalled'; break }
    await sleep(pollMs)
  }
  if (why && mine()) {
    const left = status()?.remaining
    if (why === 'stalled') log(`遠征: 長距離移動が ${Math.round(stallMs / 60000)} 分進まないため、取り消して次の判断へ進みます（残り ${Number.isFinite(left) ? Math.round(left) : '?'}m）`)
    if (why === 'found') log(`遠征: 探していたものが見つかったため、長距離移動を取り消します（残り ${Number.isFinite(left) ? Math.round(left) : '?'}m）`)
    await stop()
  }
  const final = status() ?? {}
  if (goal && place && why !== 'cancelled' && why !== 'found') {
    if (final.phase === 'arrived') goal.step('arrived:' + place)
    else {
      const noted = goal.fail(failure(), { paceMs: PACE_MS })
      if (noted.exhausted) log(`遠征: ${Math.floor(destination.x)}, ${Math.floor(destination.z)} への長距離移動は、この場所から ${noted.count} 回とも着かなかったため、場所が変わるまで始めません（${final.reason ?? why ?? '理由不明'}）`)
    }
  }
  return { ...final, ended: why ?? 'finished' }
}

module.exports = { expeditionTrip, STALL_MS, STALL_M }
