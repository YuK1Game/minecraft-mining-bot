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
//
// Rule 2 is a lease (shared.playerFlee = { who, id, gen, scope, until }):
// - acquire() checks the fight and the holder and records the new holder in
//   one step, with no await between. The run that is refused sends nothing.
//   A walk does not take the input from another walk: the first one keeps it
//   until it lets go (live case before: a cover started at health 9, health
//   fell to 7 while it walked, the flee overwrote its claim and both ran).
// - Each lease has its own id and generation. Only the run that acquired it
//   releases it, and an old run cannot clear the holder that came after it.
// - The lease is checked where the operation is called (send, guard, signal):
//   a run that lost it (replaced, run out, another connection, dimension or
//   life, play stopped, or the fight took the input in contact) is refused
//   there and sends nothing more. The time limit only bounds a run that never
//   returns; it revokes that run's lease, it is not taken as proof that the
//   input came back.
// - Every reader decides whether a holder is valid with holderOf().
// - Before the first operation the new holder sees the old input returned
//   (handoff): what could still send is asked to stop, and the walk starts
//   only once nothing can. Saving and cleaning up are not waited for. At the
//   deadline the answer is HANDOFF_INCOMPLETE and no operation is sent.
const { guardDragonOperations } = require('./dragon-ports')

const CONTACT_M = 3.5, SETTLED_MS = 400, GAP_MS = 700, FAIL_MS = 3000, HANDOFF_MS = 3000
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

// The valid holder of the walk's lease, or null. The one reading of it: combat's work guard, the
// flee, the cover and the lease itself all ask here. `scope` (a value or a function, asked only
// when a record is there) is the reader's connection, dimension and life (common/life-key.js).
function holderOf (shared, { now = Date.now(), scope } = {}) {
  const record = shared?.playerFlee
  if (!record || !(record.until > now)) return null
  if (scope !== undefined && record.scope !== undefined && record.scope !== (typeof scope === 'function' ? scope() : scope)) return null
  return record
}

// The combat side of rule 2. `armed` may be a function: it is only asked in contact.
function standsDown ({ shared, target, state, armed, now = Date.now(), scope }) {
  if (!holderOf(shared, { now, scope })) return false
  return !(inContact(target, state) && (typeof armed === 'function' ? armed() : armed) === true)
}

// What can still send, from the parts the caller knows: { name: { on, stop } }. A part that
// cannot be read counts as holding.
function holdOf (parts) {
  return {
    holding: () => Object.keys(parts).filter(name => { try { return parts[name].on() === true } catch { return true } }),
    interrupt: (left, reason) => {
      for (const name of left) {
        try { const ended = parts[name]?.stop?.(reason); if (typeof ended?.catch === 'function') ended.catch(() => {}) } catch { /* Still holding: the deadline answers. */ }
      }
    }
  }
}

const refusal = code => Object.assign(new Error('操作権がないため、この操作は送りません。'), { code })

function createControlOwner ({ shared, fight = () => null, held = () => false, now = Date.now, scope = () => null, active = () => true, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // The claim seen in the last sample, and the last fight that ended.
  let seen = null, ended = null, heldAt = -Infinity
  function sample () {
    const read = fightOf(fight()), at = now()
    if (read?.endedId != null && read.endedId !== ended?.id) ended = { id: read.endedId, code: read.code, at }
    if (read?.busy) {
      if (seen?.id !== read.claimId) seen = { id: read.claimId, since: at }
      heldAt = at
    } else seen = null
    // A holder of another connection, dimension or life, or of a play that stopped, holds nothing.
    const record = shared.playerFlee
    if (record?.id != null && (record.scope !== scope() || !active())) shared.playerFlee = null
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
  const holder = () => holderOf(shared, { now: now(), scope })
  const walking = () => { const record = holder(); return record ? record.who ?? 'flee' : null }

  function leaseOf (record) {
    // Why this run may not send, or null while it holds the input.
    const lost = () => {
      const current = shared.playerFlee
      if (current?.id !== record.id) return current ? 'LEASE_REPLACED' : 'LEASE_RELEASED'
      if (!(record.until > now())) return 'LEASE_EXPIRED'
      if (record.scope !== scope()) return 'SCOPE_CHANGED'
      if (!active()) return 'NOT_ACTIVE'
      // After the handoff combat holds the input only for a hostile in contact (rule 2).
      if (record.handed === true && held() === true) return 'FIGHT_HOLDS_INPUT'
      return null
    }
    const lease = {
      id: record.id, who: record.who, gen: record.gen,
      lost, live: () => lost() === null,
      renew: ms => { if (lost() !== null) return false; record.until = now() + ms; return true },
      release: () => { if (shared.playerFlee?.id !== record.id) return false; shared.playerFlee = null; return true },
      // The boundary: the operation is called only by the run that still holds the input.
      send: call => { const code = lost(); if (code) throw refusal(code); return call() },
      // The same boundary for a group of operations and for a step that takes an abort signal.
      guard: operations => guardDragonOperations(operations, () => lost() !== null, () => refusal(lost() ?? 'LEASE_RELEASED')),
      signal: () => ({ get aborted () { return lost() !== null } })
    }
    return lease
  }

  // Rule 2: `who` is 'flee' or 'cover'. Check and record are one step.
  function acquire (who, { ms, armed = false } = {}) {
    if (!active()) return { acquired: false, code: 'NOT_ACTIVE', holder: null }
    if (fighting(armed)) return { acquired: false, code: 'FIGHT_ON', holder: null }
    const current = holder()
    if (current) return { acquired: false, code: 'INPUT_HELD', holder: { who: current.who ?? 'flee', id: current.id ?? null } }
    const gen = (Number(shared.playerFleeGen) || 0) + 1
    shared.playerFleeGen = gen
    const record = { who, id: `${who}#${gen}`, gen, scope: scope(), until: now() + ms }
    shared.playerFlee = record
    return { acquired: true, code: 'ACQUIRED', holder: { who, id: record.id }, lease: leaseOf(record) }
  }

  // The old input is seen returned before the new holder's first operation. `holding()` names
  // what can still send (the work, a trip, an expedition step, a motion in flight, the fight);
  // `interrupt(left)` asks those to stop, once, through the existing stops (holdOf). Their
  // promises are not awaited: what is waited for is that nothing can send, not that the old job ended.
  async function handoff (lease, { holding = () => [], interrupt = () => {} } = {}, { reason = null, deadlineMs = HANDOFF_MS, pollMs = 100 } = {}) {
    const end = now() + deadlineMs
    let asked = false
    // The polls are counted as well, so a clock that stands still cannot keep this waiting.
    for (let polls = Math.ceil(deadlineMs / pollMs); ; polls--) {
      const code = lease.lost()
      if (code) return { ok: false, code, holding: [] }
      const left = holding()
      if (!left.length) { if (shared.playerFlee?.id === lease.id) shared.playerFlee.handed = true; return { ok: true, code: 'HANDED_OVER', holding: [] } }
      if (now() >= end || polls <= 0) return { ok: false, code: 'HANDOFF_INCOMPLETE', holding: left }
      if (!asked) { asked = true; try { lease.send(() => interrupt(left, reason)) } catch { /* Still holding: the deadline answers. */ } }
      await sleep(pollMs)
    }
  }
  return { sample, fighting, acquire, handoff, walking, held: () => held() === true }
}

module.exports = { createControlOwner, standsDown, holderOf, holdOf, inContact, fightOf, CONTACT_M, SETTLED_MS, GAP_MS, FAIL_MS, HANDOFF_MS }
