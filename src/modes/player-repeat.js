'use strict'

// Player mode: the same stop is not answered the same way twice. A restart
// plans from the beginning and, from the same place with the same inventory,
// picks the same work and stops for the same reason; a pause before it only
// slows that loop (user, 2026-11-16 19:58 JST: 「なんで失敗したことを再実行しよう
// としてるの…失敗したものとは別の対応する必要があるんじゃないの？」).
// - A stop is "the same" when its stop code, the work it was doing (type,
//   resource, target) and the place (an 8-block cell) are the same as the
//   stop before it, within ten minutes.
// - The first time the run starts again at once: the autonomy has already put
//   what failed on its exclusion list where it keeps one (ore, table, furnace,
//   dropped item).
// - The second time the Bot goes somewhere else, about 16 m away (underground:
//   straight up to the surface). From another place the plan sees other
//   ground, other ore and other ways.
// - From the third time it walks far, 96 m, turning 60 degrees each time.
const WINDOW_MS = 600000
const CELL = 8

const cellOf = point => point && [point.x, point.y, point.z].every(Number.isFinite) ? [point.x, point.y, point.z].map(value => Math.floor(value / CELL)).join(',') : '?'
const targetOf = decision => { const point = decision?.resourceTarget ?? decision?.target; return point && [point.x, point.y, point.z].every(Number.isFinite) ? `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}` : '' }

function signature (snapshot, position) {
  const decision = snapshot?.lastDecision ?? {}
  // Without a stop code the reason tells stops apart; digits (coordinates, counts) are left out.
  const why = snapshot?.stopCode ?? String(snapshot?.reason ?? '').replace(/[-\d.,]+/g, '#').slice(0, 80)
  return [why, decision.type ?? '', decision.resource ?? decision.stage ?? '', targetOf(decision), cellOf(position)].join('|')
}

// What to do about this stop: 'again' (start again at once), 'near' (go about
// 16 m away, or up to the surface), 'far' (walk 96 m).
function createRepeat ({ now = Date.now } = {}) {
  let last = null, count = 0, at = 0
  function note (snapshot, position) {
    const key = signature(snapshot, position)
    count = key === last && now() - at <= WINDOW_MS ? count + 1 : 1
    last = key; at = now()
    return { count, step: count === 1 ? 'again' : count === 2 ? 'near' : 'far' }
  }
  return { note, reset: () => { last = null; count = 0 }, count: () => count }
}

// A point `metres` from the Bot, away from where the failed work was (or along `turn`).
function elsewhere (position, decision, metres = 16, turn = 0) {
  const point = decision?.resourceTarget ?? decision?.target
  const away = point && [point.x, point.z].every(Number.isFinite) && Math.hypot(point.x + 0.5 - position.x, point.z + 0.5 - position.z) > 0.5
    ? Math.atan2(position.z - point.z - 0.5, position.x - point.x - 0.5) : 0
  const angle = away + turn
  return { x: Math.floor(position.x + Math.cos(angle) * metres), z: Math.floor(position.z + Math.sin(angle) * metres) }
}

module.exports = { createRepeat, signature, elsewhere }
