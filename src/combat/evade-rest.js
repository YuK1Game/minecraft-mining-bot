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
// - The rest doubles with each failed evade in a row for the same creeper
//   (1, 2, 4, 8 s, at most REST_MAX_MS); a streak ends after STREAK_MS with
//   no failure. One second alone left about 20 starts a minute (live
//   2026-11-19 12:49 JST: 23 「mode=evade」 starts, 21 「No known retreat
//   standpoint」 in one minute, the walk in progress cancelled each time).
const REST_MS = 1000, CLOSER_M = 0.5, REST_MAX_MS = 10000, STREAK_MS = 30000

function createEvadeRest ({ clock = Date.now, restMs = REST_MS, closer = CLOSER_M, limit = 64, restMax = REST_MAX_MS, streakMs = STREAK_MS } = {}) {
  const failed = new Map()
  return {
    note (key, distance) {
      const last = failed.get(key), now = clock()
      const streak = last && now - last.at < streakMs ? last.streak + 1 : 1
      failed.delete(key)
      failed.set(key, { at: now, until: now + Math.min(restMax, restMs * 2 ** (streak - 1)), distance, streak })
      while (failed.size > limit) failed.delete(failed.keys().next().value)
    },
    resting (key, distance, primed = false) {
      const entry = failed.get(key)
      if (!entry) return false
      // Primed or nearer: forgotten, and the streak with it. After its time the entry stays, for the streak.
      if (primed || !(distance > entry.distance - closer)) { failed.delete(key); return false }
      if (clock() >= entry.until) return false
      return true
    }
  }
}

module.exports = { createEvadeRest, REST_MS, CLOSER_M, REST_MAX_MS, STREAK_MS }
