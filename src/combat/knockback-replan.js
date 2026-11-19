'use strict'

// An approach that ended because the server changed the Bot's velocity was knocked back by a hit, not refused by
// the terrain. The runtime stops the movement with this one reason (runtime.js, set_entity_motion); the same text
// is matched in idle-escape/escape-port-surface.js. Ending the claim there left the Bot standing between arrows:
// every arrow cancelled the walk at the archer, the claim ended APPROACH_NOT_READY and the sword was never swung
// (live 2026-11-19 12:04:58-12:05:11 JST: two skeletons 6-8 m away, health 13 to 0, 22 failed idle escapes).
const KNOCKBACK_REASON = 'サーバーから速度の変更を受信したため再計画します。'
const REPLANS = 6

function knockedBack (result) {
  const text = String(result?.error?.message ?? result?.value?.reason ?? '')
  return text.includes(KNOCKBACK_REASON)
}

// True while this claim may plan the approach again from fresh observations.
function replanAfterKnockback (lease, result) {
  if (!lease || !knockedBack(result)) return false
  lease.knockbackReplans = (lease.knockbackReplans ?? 0) + 1
  return lease.knockbackReplans <= REPLANS
}

module.exports = { KNOCKBACK_REASON, REPLANS, knockedBack, replanAfterKnockback }
