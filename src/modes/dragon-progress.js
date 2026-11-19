'use strict'

// One place that notices an expedition step that is not getting anywhere. Until now a stalled step was found
// by a person reading the log (live 2026-11-19: 「集めた材料を本拠点で調理します。」 for 20 minutes, the food hunt
// pinned to 64 for hours). A step makes progress when something received changes: where the Bot stands
// (8-block cell), what it holds, what it wears, its health, or the stage. The text of the step is not progress.
// After STALL_MS without progress the stall is written to the log (once per STALL_MS) and to `shared.dragonStall`;
// after RESET_MS the step's remembered choices are dropped (`onReset`) so the step decides again from what is received.
// It is looked at on every tick of the expedition, so a step that never returns is seen as well; that step is
// let go at RESET_MS (`abandon`). Waiting on purpose (night in bed, loading) is reported after three times as long
// and drops nothing.
const STALL_MS = 5 * 60000
const RESET_MS = 10 * 60000
const WAIT_FACTOR = 3

const cell = feet => feet && Number.isFinite(feet.x) ? [feet.x, feet.y, feet.z].map(v => Math.floor(v / 8)).join(',') : '?'
const stock = items => (items ?? []).filter(row => row?.name && row.count > 0).map(row => row.name + ':' + row.count).sort().join('|')

function signature ({ feet, items, worn, health, stage }) {
  return [cell(feet), stock(items), (worn ?? []).map(row => row?.name).filter(Boolean).sort().join('|'), Number.isFinite(health) ? Math.floor(health) : '?', stage ?? ''].join(';')
}

function createProgress ({ shared = {}, now = Date.now, log = () => {}, onReset = () => {}, stallMs = STALL_MS, resetMs = RESET_MS } = {}) {
  let last = null, since = 0, saidAt = 0, resetAt = 0
  function clear () { last = null; since = saidAt = resetAt = 0; delete shared.dragonStall }
  // Called after every step. Returns how long nothing has changed.
  function note (seen, { reason = '', waiting = false } = {}) {
    const at = now(), sig = signature(seen)
    if (sig !== last) {
      if (shared.dragonStall) log('遠征: 進み始めました（' + Math.round((at - since) / 60000) + ' 分止まっていました）。')
      clear()
      last = sig; since = at
      return 0
    }
    const idle = at - since
    // A wait on purpose (a night in bed is about ten minutes) is given three times as long, and nothing is dropped for it.
    if (idle < (waiting ? stallMs * WAIT_FACTOR : stallMs)) return idle
    shared.dragonStall = { since, reason }
    if (at - saidAt >= stallMs) {
      saidAt = at
      log('遠征: ' + Math.round(idle / 60000) + ' 分、場所・持ち物・体力が変わっていません（' + reason + '）。')
    }
    if (!waiting && idle >= resetMs && at - resetAt >= resetMs) {
      resetAt = at
      const dropped = onReset()
      log('遠征: 覚えていた選択を捨てて、受信した状態から決め直します' + (dropped ? '（' + dropped + '）' : '') + '。')
    }
    return idle
  }
  return { note, clear }
}

module.exports = { createProgress, signature, STALL_MS, RESET_MS, WAIT_FACTOR }
