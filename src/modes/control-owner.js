'use strict'

// Who holds the Bot's input when enemies are near. One rule, read by all of:
// combat's work guard, the flee (player-flee.js), the cover (player-cover.js)
// and the expedition's guard.
//
// The rule used to be spread over those four as exceptions added one death at
// a time (the flee not within 3.5 m, the cover not within 6 m of a fight that
// held the input two seconds ago, the stand-down not for a hostile in contact,
// the guard not for a hit alone). Each left the next gap open; the last one,
// live 2026-11-19 17:19:16-17:19:22 JST: seven sword hits killed a skeleton,
// the fight took the next one at 5.5 m, health fell to 6.5, the flee started
// on that skeleton at 7.8 m, combat ended on PLAYER_FLEE and the Bot died
// walking away with the iron helmet it had just made.
//
// Order of ownership:
// 1. A fight that is on. Armed, and combat holds the input with a claim that
//    has lasted (SETTLED_MS), or that follows a fight which ended well
//    (the target died or was left for a nearer one). No walk away starts.
//    Combat's own low-health policy ends the fight (HP_RETREAT, HP_DISENGAGE:
//    the user's confirmed rule); once it has, the walk may start at once.
// 2. A walk away or out of the line of fire that has started (the claim).
//    Combat picks no target, except one in contact while armed.
// 3. The work.
//
// Claims that end at once, one after the other ("no stance", "not a threat",
// "no way to evade"), are not a fight: after such an end a new claim counts
// only once it has lasted. Between two targets of a real fight the input is
// free for a moment; for GAP_MS that still counts.
const CONTACT_M = 3.5, SETTLED_MS = 400, GAP_MS = 700, FAIL_MS = 3000
const ENDED_WELL = new Set(['TARGET_DEAD', 'TARGET_REMOVED', 'TARGET_CHANGED', 'NEAR_HOSTILE_PRIORITY', 'CREEPER_EVADED', 'PROFILE_HIT_LIMIT'])

// What the owner reads of combat's snapshot (combat-coordinator.js).
function fightOf (combat) {
  if (!combat) return null
  return { busy: combat.busy === true, claimId: combat.claim?.claimId ?? null, endedId: combat.lastResult?.claimId ?? null, code: combat.lastResult?.code ?? null }
}

function inContact (target, state) {
  const at = target?.position, me = state?.position
  if (!at || !me) return false
  return Math.hypot(at.x - me.x, at.y - (me.y - 1.62), at.z - me.z) <= CONTACT_M
}

// The combat side of rule 2. `armed` may be a function: it is only asked in contact.
function standsDown ({ shared, target, state, armed, now = Date.now() }) {
  if (!(shared?.playerFlee?.until > now)) return false
  return !(inContact(target, state) && (typeof armed === 'function' ? armed() : armed) === true)
}

function createControlOwner ({ shared, fight = () => null, held = () => false, now = Date.now }) {
  // The claim seen in the last sample, and the last fight that ended.
  let seen = null, ended = null, heldAt = -Infinity
  function sample () {
    const read = fightOf(fight()), at = now()
    if (read?.endedId != null && read.endedId !== ended?.id) ended = { id: read.endedId, code: read.code, at }
    if (read?.busy) {
      if (seen?.id !== read.claimId) seen = { id: read.claimId, since: at }
      heldAt = at
    } else seen = null
    return read
  }
  // Rule 1. Unarmed there is nothing to fight with.
  function fighting (armed) {
    if (armed !== true) return false
    const read = sample(), at = now()
    const well = !ended || ENDED_WELL.has(ended.code)
    if (read?.busy) return at - seen.since >= SETTLED_MS || well || at - ended.at > FAIL_MS
    return !!ended && well && at - heldAt <= GAP_MS
  }
  // Rule 2: `who` is 'flee' or 'cover'.
  const claim = (who, ms) => { shared.playerFlee = { who, until: now() + ms } }
  const release = who => { if (shared.playerFlee && (shared.playerFlee.who ?? who) === who) shared.playerFlee = null }
  const walking = () => shared.playerFlee ? shared.playerFlee.who ?? 'flee' : null
  return { sample, fighting, claim, release, walking, held: () => held() === true }
}

module.exports = { createControlOwner, standsDown, inContact, fightOf, CONTACT_M, SETTLED_MS, GAP_MS, FAIL_MS }
