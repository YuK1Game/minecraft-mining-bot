'use strict'

// The expedition leaves a cave before a long trip.
//
// A long trip walks the open surface only. The ordinary play climbs out first
// (player-recovery.js), the expedition's trips did not: from a cave every trip
// ended where it began (live 2026-11-19 10:43-10:48 JST: from y=30, 41 below
// the house, 「歩ける中継点が見つかりません」 and CHUNK_TRAVEL_NO_ROUTE walked=0.0m
// more than twenty times in five minutes, to the house, to food sources and to
// search points alike, and nothing climbed).
// - Under received natural ground (player-surface.js underCover) and the
//   destination further than NEAR_M: the shared way up (own tunnel, a walk to
//   the open sky, or straight up) runs first, then the trip starts.
// - A climb that left it under cover is not tried again from the same cell
//   for REST_MS; the trip is started as before and its own answer stands.
// - The same climb is not repeated without end: a climb that left it under cover is one failure of the goal
//   (goal/goal-ledger.js, by the cell and the climb's own code). After three from one cell that way is spent
//   until the Bot stands somewhere else; before, the rest of a minute was all, and the memory was lost with
//   every reload of the behaviour code. Out of the cave is one confirmed step of the goal.
const NEAR_M = 20, REST_MS = 60000

// goal: () => the expedition's goal port ({ fail, spent, step }), or null.
function createTripRise ({ covered, climb, getFeet, log = () => {}, now = Date.now, restMs = REST_MS, goal = () => null } = {}) {
  let failed = null, said = null
  const cell = () => { const f = getFeet(); return f ? `${Math.floor(f.x)},${Math.floor(f.y)},${Math.floor(f.z)}` : null }
  const failure = code => ({ stage: 'rise', code, state: { cell: cell() } })
  return async function rise (destination = null, climbNow = climb) {
    const feet = getFeet()
    if (!feet || covered() !== true) return { rose: false, code: 'OPEN_SKY' }
    if (destination && Number.isFinite(destination.x) && Number.isFinite(destination.z) && Math.hypot(destination.x - feet.x, destination.z - feet.z) <= NEAR_M) return { rose: false, code: 'NEAR' }
    const at = cell()
    if (goal()?.spent(failure('STILL_COVERED'))) {
      if (said !== at) { said = at; log(`遠征: この場所（${at}）からの地上への登りは3回とも出られなかったため、場所が変わるまで登りません`) }
      return { rose: false, code: 'SPENT' }
    }
    if (failed && failed.cell === at && now() - failed.at < restMs) return { rose: false, code: 'RESTING' }
    log(`遠征: 地下（y=${Math.floor(feet.y)}）にいるため、長距離移動の前に地上へ出ます`)
    let out = null
    try { out = await climbNow() } catch (error) { log(`遠征: 地上へ出られませんでした（${String(error?.message ?? error).slice(0, 120)}）`) }
    if (covered() === true) {
      failed = { cell: cell(), at: now() }
      const noted = cell() === at && !/INTERRUPTED/.test(out?.reason ?? '') ? goal()?.fail(failure('STILL_COVERED')) : null
      log(`遠征: まだ地下にいます${noted ? `（この場所から ${noted.count} 回目${/^[A-Z_]+$/.test(out?.reason ?? '') ? '・' + out.reason : ''}）` : ''}。長距離移動をこのまま始めます`)
      return { rose: false, code: 'STILL_COVERED' }
    }
    failed = null
    goal()?.step('rise')
    return { rose: true, code: 'ROSE' }
  }
}

module.exports = { createTripRise, NEAR_M, REST_MS }
