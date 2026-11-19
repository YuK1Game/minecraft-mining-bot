'use strict'

// A creeper evade that found no standpoint is not claimed again at once.
// A creeper inside its shot distance is selected without the ordinary backoff,
// and a failed evade marks it cornered; without a bow, between the cornered
// strike band and the evaded distance, the only mode left is the same evade.
// Live 2026-11-19 10:10:35-10:10:40 JST: 「戦闘開始: target=creeper mode=evade」
// about 15 times in five seconds at 5.2-5.9 m (41 failed evades in 25 minutes),
// every one 「No known retreat standpoint」, each claim cancelling the walk in
// progress.
// - After a failed evade the same creeper is not claimed for an evade again
//   for REST_MS, unless it is primed or has come CLOSER_M nearer since.
// - Only the evade is rested: a strike or a shot stays available at once.
const REST_MS = 1000, CLOSER_M = 0.5

function createEvadeRest ({ clock = Date.now, restMs = REST_MS, closer = CLOSER_M, limit = 64 } = {}) {
  const failed = new Map()
  return {
    note (key, distance) {
      failed.delete(key)
      failed.set(key, { until: clock() + restMs, distance })
      while (failed.size > limit) failed.delete(failed.keys().next().value)
    },
    resting (key, distance, primed = false) {
      const entry = failed.get(key)
      if (!entry) return false
      if (primed || clock() >= entry.until || !(distance > entry.distance - closer)) { failed.delete(key); return false }
      return true
    }
  }
}

module.exports = { createEvadeRest, REST_MS, CLOSER_M }
