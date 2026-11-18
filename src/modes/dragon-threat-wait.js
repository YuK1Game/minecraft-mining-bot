'use strict'

// How long a step of the expedition waits for an enemy it does not fight itself.
//
// While the expedition owns the player, the ordinary crew does not run: nothing
// walks away from an enemy, and the plan's twenty-second limit on waiting for
// one (autonomy.js threatWaitMs) does not apply. A step that only waits when a
// safety check names a threat waits for as long as the enemy stands there.
// Real Realm 2026-11-18 21:16-21:19 JST: under the overhang west of the house,
// with no food, the food step answered 「敵への対処・回避を食料探しより優先して
// ください。」 every two seconds; combat had no target, and nothing moved.
//
// Here the wait is counted per reason: it starts again after GAP_MS without
// the refusal and while combat has the controls (the fight is the answer), and
// it is over after WAIT_MS. The step then does what it does when the place
// has nothing for it: it goes somewhere else.
const WAIT_MS = 20000, GAP_MS = 6000

// True while the step should go on waiting.
// `slot` keeps a second wait apart from the first (the low-health retreat in dragon-runtime.js).
function threatWait (shared, key, { now = Date.now, fighting = false, slot = 'dragonThreatWait' } = {}) {
  const at = now(), held = shared[slot]
  if (!held || held.key !== key || at - held.seen > GAP_MS || fighting) { shared[slot] = { key, since: at, seen: at }; return true }
  held.seen = at
  return at - held.since < WAIT_MS
}

module.exports = { threatWait, WAIT_MS, GAP_MS }
