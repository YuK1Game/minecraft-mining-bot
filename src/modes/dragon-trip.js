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
const STALL_MS = 240000, STALL_M = 8, POLL_MS = 500

async function expeditionTrip ({ start, status, cancel, cancelled = () => false, until = null, resting = () => false, log = () => {},
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), stallMs = STALL_MS, pollMs = POLL_MS } = {}) {
  const stop = async () => { try { await cancel() } catch { /* The trip ends by itself; the next step reads its state. */ } }
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
  return { ...(status() ?? {}), ended: why ?? 'finished' }
}

module.exports = { expeditionTrip, STALL_MS, STALL_M }
