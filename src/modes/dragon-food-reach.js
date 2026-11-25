'use strict'

// Food sources the expedition's hunt could not walk to.
//
// The hunt (survival/foraging.js) takes the nearest animal or dropped food it
// has received, and when it finds no stand to walk to, it rests that one for
// 15 s and returns without a word. The expedition's food step asked again every
// two seconds: the same few sources took turns, nothing moved and nothing was
// logged, and each search trip ended at once because "a food source is in view"
// (real Realm 2026-11-18 21:37-21:48 JST: seven minutes at one spot south of the
// house showing 「狩りで得た肉を確認して調理します。」, with a cow 16 blocks below,
// sheep 21-31 m off and a chicken record 35 minutes old on the overhang; then
// five trips in 16 s, each cancelled after 0.5 s as 「探していたものが見つかったため」).
//
// Here: a hunt that neither walked, hit nor gained food is a miss for its
// source. After MISSES misses the source is walked to once by a long trip, the
// hunt is tried again from there, and after MISSES more misses the source is
// left alone for REST_MS: it is no longer "in view" for the search.
//
// A hunt that walked but neither hit nor gained food is a chase. CHASES chases
// in a row for one source leave it alone the same way, without the trip (the
// bot is already beside it). Real Realm 2026-11-19 02:15-02:27 JST: a pig in a
// one-deep ditch under vines; the bot walked round it for minutes, every hunt
// "walked", so no miss was ever counted.
const MISSES = 2, CHASES = 3, REST_MS = 5 * 60000, NEAR_M = 6

function foodReach (shared, { now = Date.now } = {}) {
  const held = shared.dragonFoodMiss ??= {}
  for (const id of Object.keys(held)) if (now() - held[id].at >= REST_MS) delete held[id]
  const entry = id => held[String(id)] ?? null
  // The source is not hunted from here: walked to once, or left alone.
  const given = id => (entry(id)?.count ?? 0) >= MISSES
  // A source that already failed to reach once must not cancel a search trip when its short foraging cooldown expires.
  const missed = id => (entry(id)?.count ?? 0) > 0
  // What a finished hunt says about its source. Returns the entry on the miss that gives it up.
  // `feet`: where the Bot stands after the hunt. A chase that ended nearer its source than the last one is
  // progress, not a miss: a hunt batch ends after a fixed number of steps, and an animal that walks off is closed
  // on over several batches (live 2026-11-26 03:13-07:01 JST: chicken, cow, pig and sheep each given up after
  // 「このbatchの陸上移動上限に達しました。」, and the Bot walked 400 m and more to other sources at 9-12 health).
  function note (result, feet = null) {
    const target = result?.target
    if (target?.runtimeId == null) return null
    const id = String(target.runtimeId)
    if (result.foodGained > 0 || result.hits > 0) { if (held[id]) { held[id].count = 0; held[id].chases = 0 } return null }
    const seen = held[id] ??= { count: 0, chases: 0, at: now(), tripped: false }
    const at = target.position, gap = at && feet && [at.x, at.z, feet.x, feet.z].every(Number.isFinite) ? Math.hypot(at.x - feet.x, at.z - feet.z) : null
    const closer = gap !== null && Number.isFinite(seen.gap) && gap < seen.gap - 1
    if (gap !== null) seen.gap = gap
    if (result.steps > 0) {
      seen.count = 0; seen.chases = closer ? 0 : (seen.chases ?? 0) + 1; seen.at = now()
      if (seen.chases < CHASES) return null
      Object.assign(seen, { count: MISSES, chases: 0, tripped: true, chased: true })
      return seen
    }
    seen.count++; seen.at = now()
    return seen.count === MISSES ? seen : null
  }
  // Where to walk for a given-up source, once, when it is not close by.
  function trip (target, feet) {
    const seen = entry(target?.runtimeId), at = target?.position
    if (!seen || seen.tripped || !at || !feet || Math.hypot(at.x - feet.x, at.z - feet.z) <= NEAR_M) return null
    return { x: Math.floor(at.x), z: Math.floor(at.z) }
  }
  // The trip is over: the hunt gets its tries again from the new place.
  function walked (id) { const seen = entry(id); if (seen) { seen.tripped = true; seen.count = 0; seen.at = now() } }
  return { given, missed, note, trip, walked }
}

module.exports = { foodReach, MISSES, CHASES, REST_MS, NEAR_M }
