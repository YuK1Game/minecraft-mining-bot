'use strict'

// One place that notices an expedition goal that is not getting anywhere, and what follows from it.
//
// Until 2026-11-19 a stall was "nothing received has changed": the place (8-block cell), the items, the armour,
// the whole health points or the stage. Any of them moving started the clock again, so a Bot that was hit and
// healed, or walked between two cells, was never stalled (60 minutes of a virtual clock: health 20 and 19 in
// turn every four minutes, two cells in turn, or the watcher made again every four minutes by a reload, each
// gave no warning and no new decision), and a goal that really stood was decided again every ten minutes for ever.
//
// Now the goal has a ledger (goal/goal-ledger.js) and this watcher only reads it:
// - activity (the place, the health) is kept for the log line and counts for nothing;
// - progress is a result the goal is made of (dragon-goal-measure.js), a confirmed step or a mark;
// - after STALL_MS of looked-at time without progress the stall is written to the log (once per STALL_MS) and
//   to `shared.dragonStall`;
// - every RESET_MS of it the goal is decided again: what the step remembers is dropped and a step that does not
//   return is let go (`onReset`). That happens `ledger.limit` times (3, as the return's same-failure limit);
// - after that the goal is held (`onHold`): the expedition keeps only its safety steps (night, health, recovery)
//   until the hold is looked at again: its time is up (10, 20, 40, then 60 minutes), another life, connection or
//   dimension, the Bot stands somewhere else, the goal has more than it had, or the wait it was held in is over.
//   One decision is given back.
// - a wait on purpose is named by the run that waits (`wait.code`); it is not read from the text on the screen,
//   and it is over at its own limit (ledger WAITS).
// The clock, the count of decisions and the hold are in `shared` from the goal's first look, so a reload of the
// behaviour code does not start them again; the ledger's checkpoint goes into the expedition's saved record.
const STALL_MS = 5 * 60000
const RESET_MS = 10 * 60000

const minutes = ms => Math.round(ms / 60000)
const cell = (feet, size) => feet && Number.isFinite(feet.x) ? [feet.x, feet.y, feet.z].map(v => Math.floor(v / size)).join(',') : null
const activity = ({ feet, health }) => [cell(feet, 8) ?? '?', Number.isFinite(health) ? Math.floor(health) : '?'].join(';')

function createProgress ({ shared = {}, ledger, now = Date.now, log = () => {}, onReset = () => {}, onStall = () => {}, stallMs = STALL_MS, resetMs = RESET_MS } = {}) {
  // key: the goal (dragon-goal-measure.js goalKey). seen: { feet, health, value, extras, scope }.
  // run: { n, wait: { code } | null, reason }.
  function note (key, seen = {}, run = {}) {
    const at = now()
    const { goal: g, opened, previous } = ledger.open(key)
    if (opened) {
      if (previous) log(`遠征: 目的 ${previous.id} から ${g.id} に移ります（${minutes(at - previous.startedAt)} 分、成果 ${previous.results} 回）。`)
      delete shared.dragonStall
    }
    // Clear any legacy time-based hold carried over from an older checkpoint or reload.
    // Waiting for a timer does not solve terrain/supply obstacles in Minecraft.
    if (g.hold) {
      ledger.clearHold?.()
      g.hold = null
      log(`遠征: 目的 ${g.id} の旧保留を解除して、受信した状態から再開します。`)
    }
    const moved = activity(seen)
    if (g.activity !== moved) { g.activity = moved; g.activityAt = at }
    const waits = run.wait?.code ?? null
    const looked = ledger.look({ value: seen.value, extras: seen.extras, scope: seen.scope ?? null, wait: run.wait ?? null, counting: true })
    if (looked.progressed) {
      if (shared.dragonStall) log(`遠征: 目的 ${g.id} が進み始めました（${minutes(at - shared.dragonStall.since)} 分止まっていました）。`)
      delete shared.dragonStall
      return { stalledMs: 0, held: false }
    }
    const idle = g.stalledMs
    if (idle < stallMs) return { stalledMs: idle, held: false }
    const budget = `決め直し ${g.decisions} 回`
    const text = String(run.reason ?? '').replace(/。$/, '') + (run.wait?.code ? `・待ち ${run.wait.code} は期限切れ` : '')
    shared.dragonStall = { since: at - idle, reason: run.reason ?? '', goal: g.id }
    if (at - g.saidAt >= stallMs) {
      g.saidAt = at
      log(`遠征: 目的 ${g.id} が ${minutes(idle)} 分進んでいません（${text}。実行 #${run.n ?? g.runs}、最後の成果 ${g.resultAt ? minutes(at - g.resultAt) + ' 分前' : 'なし'}、最後の動き ${minutes(at - (g.activityAt ?? at))} 分前、${budget}）。`)
    }
    if (!ledger.due(resetMs)) return { stalledMs: idle, held: false }
    const { used } = ledger.decide()
    // Periodically clear exhausted failure memory so newly fixed code or changed
    // surroundings can retry without getting stuck in a time-based hold.
    if (used % ledger.limit === 0) {
      ledger.clearFailures?.()
      onStall({ code: waits ? 'WAIT_EXPIRED' : 'NO_PROGRESS', decisions: used, idleMs: idle })
    }
    const dropped = onReset({ waiting: waits })
    log(`遠征: 目的 ${g.id} の覚えていた選択を捨てて、受信した状態から決め直します（${dropped ? dropped + '・' : ''}決め直し ${used} 回目）。`)
    return { stalledMs: idle, held: false, decided: used }
  }
  return { note }
}

module.exports = { createProgress, STALL_MS, RESET_MS }
