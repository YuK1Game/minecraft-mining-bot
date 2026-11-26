'use strict'

// The parent goal of a piece of unattended work, and what it has to show for itself.
//
// A goal (「本拠点の装備をそろえる」) is worked on by many runs of a step, many plans and, across a reload, by
// many copies of the code. What belongs to the goal is kept here, in `shared` (and, as a checkpoint, on disk),
// apart from all of them:
// - who it is: a stable id while the goal stays the same (`key`), whatever is planned again;
// - when it began, and when it last made progress;
// - how long it has been looked at without progress (`stalledMs`). Only time that was looked at counts: a
//   restart, another owner of the player or a long gap adds GAP_MS at most, so a goal is neither forgiven nor
//   condemned for time nobody worked on it;
// - how often it was decided again without a result (`decisions`), and whether it is held.
//
// Progress is a received result that the goal is made of, never activity:
// - `value`: one number for what the goal has (dragon-goal-measure.js). A new best that has stood CONFIRM_MS
//   is a result: it clears the stall, the steps and the decisions. Updates that arrive apart (the chest's
//   slots before the inventory) are not counted while they disagree;
// - a step (`step(key)`): something confirmed on the way (arrived at the furnace, out of the cave, the first
//   wood since the last result). Each key counts once until the next result, KEYS at most;
// - a mark (`mark(key, n)`): closer than ever to one destination by MARK_M. A round trip sets no new mark.
// Health, the place and unrelated items are not passed in at all.
//
// A wait on purpose is named (`wait.code`) and has its own limit; past the limit it counts as a stall like
// any other time. The time a code may wait is counted from the last progress, so a wait that comes back does
// not start a new allowance.
//
// Failures of one way (same step, target, code and state) are counted with the return's failure memory
// (return-failures.js): SAME times, or a loop through two or three of them, and that way is spent until
// its state changes. The count belongs to one connection, dimension and life.
//
// Another life, connection or dimension (`scope`): what was measured there is measured again from what is
// received now (`best`, steps, marks). The goal's clock, its decisions and its holds stay, and so does the
// most it ever had (`top`): a result below it clears the stall but gives no decisions back.
const { createFailureMemory, failureKey } = require('../return/return-failures')

const GAP_MS = 10000, CONFIRM_MS = 3000, DECISIONS = 3, SAME = 3, KEYS = 16, MARK_M = 16, EPS = 1e-6
const HOLD_MS = [10, 20, 40, 60].map(minutes => minutes * 60000)
// How long each named wait may stand without progress before it counts as a stall.
const WAITS = Object.freeze({ DAWN: 15 * 60000, DIMENSION: 120000, WORLD: 120000, STATE: 120000, OWNER: 300000, CHECKPOINT: 60000 })

function createGoalLedger ({ shared, slot = 'dragonGoal', now = Date.now, world = () => null, restore = () => null,
  gapMs = GAP_MS, confirmMs = CONFIRM_MS, decisions: limit = DECISIONS, waits = WAITS, holdMs = HOLD_MS } = {}) {
  const failures = createFailureMemory({ now, saved: shared[slot + 'Failures'] })
  const keep = () => { shared[slot + 'Failures'] = failures.serialize() }
  const goal = () => shared[slot] ?? null

  function fresh (key, seq) {
    const at = now()
    return { key, seq, id: key + '#' + seq, world: world(), startedAt: at, progressAt: at, resultAt: null, seenAt: at, stalledMs: 0, decidedStall: 0, saidAt: 0,
      waited: {}, best: null, top: null, cand: null, seen: null, base: null, steps: [], marks: {}, results: 0, decisions: 0, holds: 0, hold: null, runs: 0, scopes: 0, scope: undefined }
  }
  // What a checkpoint holds, read back after a restart: the clock and the budget, not what was measured.
  function revive (saved) {
    const at = now(), g = fresh(saved.key, saved.seq)
    for (const name of ['startedAt', 'progressAt', 'resultAt', 'top', 'results', 'decisions', 'holds', 'runs', 'scopes']) if (Number.isFinite(saved[name])) g[name] = saved[name]
    g.stalledMs = Number.isFinite(saved.stalledMin) ? saved.stalledMin * 60000 : 0
    // The stall the last decision was made at: without it a restart would decide again at once.
    g.decidedStall = Number.isFinite(saved.decidedMin) ? Math.min(g.stalledMs, saved.decidedMin * 60000) : 0
    if (saved.hold && Number.isFinite(saved.hold.until)) g.hold = { ...saved.hold }
    g.seenAt = at
    return g
  }
  // The goal for `key`: the same one while the key stays, a new one otherwise. A reload finds it in `shared`,
  // a restart in the checkpoint; another world's goal is not taken over.
  function open (key) {
    let g = goal(), previous = null
    if (!g) {
      const saved = restore()
      if (saved && saved.key === key && saved.world === world() && Number.isSafeInteger(saved.seq)) { g = shared[slot] = revive(saved); shared[slot + 'Seq'] = Math.max(Number(shared[slot + 'Seq']) || 0, saved.seq) }
    }
    if (g && g.key === key && g.world === world()) return { goal: g, opened: false, previous }
    previous = g
    const seq = (Number(shared[slot + 'Seq']) || 0) + 1
    shared[slot + 'Seq'] = seq
    g = shared[slot] = fresh(key, seq)
    return { goal: g, opened: true, previous }
  }

  function progressed (g, result) {
    const at = now()
    g.progressAt = at
    g.stalledMs = 0; g.decidedStall = 0
    if (!result) return
    g.resultAt = at
    g.results++
    g.waited = {}; g.steps = []; g.marks = {}; g.base = null
    g.hold = null
    // The budget comes back only for more than the goal ever had: what a death took and the next life
    // gathers again clears the stall, not the count of decisions.
    if (g.top === null || g.best > g.top + EPS) { g.top = g.best; g.decisions = 0; g.holds = 0 }
    failures.progress(); keep()
  }

  // One look at the goal. value: what it has (null while the inventory is not received). extras: support
  // materials by name. wait: { code } when the run waits on purpose. counting: false while nothing should be
  // counted against it (held).
  function look ({ value = null, extras = null, scope = null, wait = null, counting = true } = {}) {
    const g = goal()
    if (!g) return { progressed: false }
    const at = now(), gap = Math.min(Math.max(0, at - g.seenAt), gapMs)
    g.seenAt = at
    if (g.scope !== scope) {
      if (g.scope !== undefined) g.scopes++
      g.scope = scope; g.best = null; g.cand = null; g.base = null; g.steps = []; g.marks = {}
      failures.prune(scope); keep()
    }
    let result = false, stepped = false
    g.seen = Number.isFinite(value) ? value : null
    if (Number.isFinite(value)) {
      if (g.best === null) { g.best = value; if (g.top === null) g.top = value }
      else if (value > g.best + EPS) {
        g.cand = g.cand ? { value: Math.min(g.cand.value, value), since: g.cand.since } : { value, since: at }
        if (at - g.cand.since >= confirmMs) { g.best = g.cand.value; g.cand = value > g.best + EPS ? { value, since: at } : null; result = true }
      } else g.cand = null
    }
    if (result) progressed(g, true)
    if (extras) {
      g.base ??= { ...extras }
      for (const name of Object.keys(extras)) if (extras[name] > (g.base[name] ?? 0) && step('more:' + name)) stepped = true
    }
    if (!result && !stepped && counting) {
      const code = wait?.code
      if (code && (g.waited[code] ?? 0) < (waits[code] ?? 0)) g.waited[code] = (g.waited[code] ?? 0) + gap
      else g.stalledMs += gap
    }
    return { progressed: result || stepped, result }
  }

  function step (key) {
    const g = goal()
    if (!g || g.steps.includes(key) || g.steps.length >= KEYS) return false
    g.steps.push(key)
    progressed(g, false)
    return true
  }
  function mark (key, value, by = MARK_M) {
    const g = goal()
    if (!g || !Number.isFinite(value)) return false
    const old = g.marks[key]
    if (old === undefined) { if (Object.keys(g.marks).length < KEYS) g.marks[key] = value; return false }
    if (!(value <= old - by)) return false
    g.marks[key] = value
    progressed(g, false)
    return true
  }

  // One failure of one way. `exhausted`: the same failure SAME times, or a loop through several.
  // paceMs: a way that is asked every two seconds fails once per this long at most (one try is that long of trying).
  const paced = new Map()
  function fail (failure, { paceMs = 0 } = {}) {
    const scope = goal()?.scope ?? null, key = failureKey(failure), at = now()
    if (paceMs > 0 && at - (paced.get(key) ?? -Infinity) < paceMs) { const count = failures.count(failure, scope); return { key, count, cycle: false, exhausted: count >= SAME } }
    paced.set(key, at)
    if (paced.size > 64) paced.delete(paced.keys().next().value)
    const noted = failures.note({ scope, ...failure })
    keep()
    return { ...noted, exhausted: noted.count >= SAME || noted.cycle }
  }
  const spent = failure => failures.count(failure, goal()?.scope ?? null) >= SAME

  // Decided again from what is received now: the goal is measured from here (`rebase`), so what was used up
  // on the way (food eaten, a tool broken) and is gathered again counts as a result of the work after the
  // decision. Such a result clears the stall and gives no decision back (`top`).
  const rebase = (g, value = g.seen) => { if (Number.isFinite(value)) { g.best = value; g.cand = null } }
  function decide () {
    const g = goal()
    g.decisions++
    g.decidedStall = g.stalledMs
    rebase(g)
    return { used: g.decisions, left: Math.max(0, limit - g.decisions) }
  }
  const due = resetMs => { const g = goal(); return !!g && !g.hold && g.stalledMs - g.decidedStall >= resetMs }
  function hold (code, basis = {}) {
    const g = goal(), at = now()
    g.holds++
    g.hold = { code, since: at, until: at + holdMs[Math.min(g.holds, holdMs.length) - 1], basis: { ...basis, scope: g.scope } }
    return g.hold
  }
  // Whether the goal is still held. It is looked at again when its time is up, in another life, connection or
  // dimension, when the Bot stands somewhere else, when the goal has more than it had, or when the wait it was
  // held in (another owner of the input, the night) is over. One decision is given back.
  function held ({ cell = null, value = null, scope = null, wait = null, mineWorkReconciled = false } = {}) {
    const g = goal(), h = g?.hold
    if (!h) return { held: false }
    const basis = h.basis ?? {}
    const code = now() >= h.until ? 'TIME' : scope !== basis.scope ? 'SCOPE' : basis.wait && wait !== basis.wait ? 'WAIT_OVER'
      : cell !== null && basis.cell != null && cell !== basis.cell ? 'MOVED'
      : Number.isFinite(value) && Number.isFinite(basis.value) && value > basis.value + EPS ? 'GAINED' : h.code === 'NO_PROGRESS' && mineWorkReconciled ? 'MINE_WORK_RECONCILED' : null
    if (!code) return { held: true, hold: h }
    g.hold = null
    g.decisions = Math.max(0, limit - 1)
    g.stalledMs = 0; g.decidedStall = 0; g.seenAt = now()
    // More than it had when it was held is a result of its own; anything else is measured from here.
    if (code !== 'GAINED') rebase(g, value)
    return { held: false, released: code }
  }
  function clearHold () { const g = goal(); if (!g?.hold) return false; g.hold = null; return true }
  function clearFailures () { failures.progress(); keep() }
  function forget (failure) { failures.forget?.(failure); keep() }
  const run = () => { const g = goal(); return g ? ++g.runs : 0 }
  function checkpoint () {
    const g = goal()
    if (!g) return null
    const minute = at => Number.isFinite(at) ? at - at % 60000 : at
    // Whole minutes for what moves with every mark: the record is written when the checkpoint changes.
    return { key: g.key, seq: g.seq, world: g.world, startedAt: g.startedAt, progressAt: minute(g.progressAt), resultAt: minute(g.resultAt), top: g.top, stalledMin: Math.floor(g.stalledMs / 60000), decidedMin: Math.floor(g.decidedStall / 60000),
      results: g.results, decisions: g.decisions, holds: g.holds, runs: g.runs - g.runs % 50, scopes: g.scopes, hold: g.hold ? { code: g.hold.code, since: g.hold.since, until: g.hold.until, basis: g.hold.basis } : null }
  }
  return { goal, open, look, step, mark, fail, spent, decide, due, hold, held, clearHold, clearFailures, forget, run, checkpoint, limit }
}

module.exports = { createGoalLedger, WAITS, GAP_MS, CONFIRM_MS, DECISIONS, SAME, KEYS, MARK_M, HOLD_MS }
