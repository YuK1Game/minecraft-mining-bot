'use strict'

// Who hit the Bot: the one reading of "this mob attacked us", for the fight's choice of target
// (combat-coordinator.js) and for the attack-access evaluation (combat-exposure.js).
//
// Before 2026-11-19 each of the two read the evidence for itself. The evaluation counted a neutral mob that was
// within PROVOKED_DISTANCE of a health drop as the attacker; the coordinator's candidate scan still asked for a
// received `hostile === true` first, so a neutral mob never reached that evaluation (live 2026-11-19 11:36 and
// 23:34:43-23:34:47 JST: an enderman 1.8-2.6 m away hit three times for 7 each, no fight started, two deaths;
// reproduced on the real coordinator: 0 claims).
//
// - A mob the server lists as hostile: it hit us when the Bot lost health within PROVOKED_WINDOW_MS and it is
//   within PROVOKED_DISTANCE. (The rule both readers had.)
// - A neutral mob (enderman, wolf, iron golem, piglin ...) is never fought for standing near. It is the attacker
//   when, at the health drop, it is within PROVOKED_DISTANCE and either the server sent its attack start
//   (`arm_swing`) around that moment, or it is the nearest mob there and no hostile mob stands within that
//   distance to explain the hit. It stays the attacker for ANGER_MS after its last such hit, so that a fight in
//   progress does not end between two of its swings or when a zombie walks up; nothing else keeps it.
// - The health drop is the received one (shared.recentDamageNoPrimary); the mobs are the received actors.
//   Damage that no mob did (a fall, fire) beside a neutral mob with no hostile near is read as that mob's hit:
//   the server does not say who did the damage.
const { PROVOKED_WINDOW_MS, PROVOKED_DISTANCE } = require('./combat-profiles')

const ANGER_MS = 10000
const SWING_MS = 1500
const SWINGS = new Set(['arm_swing', 4])
const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite)

function createProvocation ({ recentDamageAt = null, actors = () => [], now = Date.now } = {}) {
  let read = null // the health drop already looked at
  const attackers = new Map() // uniqueId -> until (ms)
  const key = actor => actor?.uniqueId == null ? null : String(actor.uniqueId)
  function range (state, actor) {
    if (!finite(state?.position) || !finite(actor?.position)) return Infinity
    return Math.hypot(actor.position.x - state.position.x, actor.position.y - (state.position.y - 1.62), actor.position.z - state.position.z)
  }
  function struckAt () {
    const at = Number(typeof recentDamageAt === 'function' ? recentDamageAt() : NaN), age = now() - at
    return Number.isFinite(at) && age >= 0 && age <= PROVOKED_WINDOW_MS ? at : null
  }
  const swung = (actor, at) => SWINGS.has(actor.lastEvent?.event) && Math.abs(Number(actor.lastEvent.time) - at) <= SWING_MS
  // Reads a new health drop once: which neutral mob did it, by what was received at that moment.
  function note (state) {
    const at = struckAt()
    for (const [id, until] of attackers) if (until < now()) attackers.delete(id)
    if (at === null || at === read) return
    read = at
    let near
    try { near = actors().filter(actor => actor?.kind === 'mob' && actor.alive === true && actor.positionKnown !== false && key(actor) !== null && range(state, actor) <= PROVOKED_DISTANCE) } catch { return }
    const neutral = near.filter(actor => actor.hostile !== true)
    const known = neutral.filter(actor => attackers.has(key(actor)) || swung(actor, at))
    const blamed = known.length ? known : near.some(actor => actor.hostile === true) ? [] : neutral.sort((a, b) => range(state, a) - range(state, b)).slice(0, 1)
    for (const actor of blamed) attackers.set(key(actor), at + ANGER_MS)
  }
  // True while this mob counts as the one that hit the Bot.
  function by (state, actor) {
    if (!actor || range(state, actor) > PROVOKED_DISTANCE) return false
    if (actor.hostile === true) return struckAt() !== null
    note(state)
    return (attackers.get(key(actor)) ?? -Infinity) >= now()
  }
  return { by, snapshot: () => ({ read, attackers: [...attackers.entries()] }) }
}

// A mob the fight may take: one the server lists as hostile, or the neutral mob that hit the Bot (`by` is the `by` above).
// The candidate scan (combat-coordinator.js eligible) and the root's lease (user-control-runtime.js acquireUserControl)
// both ask this. Until 2026-11-21 the root asked for `hostile === true` by itself: the scan chose the enderman that
// was hitting the Bot and the root refused each claim (live 03:48:39-03:48:51 JST: 75 claims in 11 s, each ended
// ACQUIRE_DENIED after 3 ms, no swing, death).
const fought = (actor, state, by) => actor?.kind === 'mob' && (actor.hostile === true || typeof by === 'function' && by(state, actor) === true)

module.exports = { createProvocation, fought, ANGER_MS, SWING_MS }
