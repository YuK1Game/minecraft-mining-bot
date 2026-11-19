'use strict'

const { failed } = require('./return/return-result')

// The wait and the outcome the run before answered still stand for this long into the next run: a step that
// answers at once is asked again every two seconds, and between two answers a run is under way.
const CARRY_MS = 5000

// Only one adventure action may own the player. The ordinary survival crew
// keeps its existing scheduler until its house and equipment goals are met.
//
// What is shown (`status()`: a phase and a text for the screen) and what a run is doing (`runState()`) are kept
// apart. The shown text is made from the run and is never read back to decide anything: until 2026-11-19 an
// exception was shown as 「waiting」, the watcher took the shown phase for a wait on purpose, and the phase of
// the run before stood while the next run hung (run 1 throws, run 2 never returns: 60 minutes of a virtual
// clock without one new decision).
// - Each run has a number and begins with nothing inherited: no wait, no outcome.
// - A wait on purpose is named by a code (`wait: { code }` in the step's answer, or `ports.wait(code)` while
//   it runs); the limit of each code is the ledger's (goal/goal-ledger.js WAITS).
// - An exception is an outcome (`failed`, STEP_THREW), shown as 「recovering」, and is not a wait.
function createDragonExpedition ({ state, raw, active, legacyNeeded, legacyBusy, legacyIdle, stopLegacy, run, lifeKey = () => null, loading = () => false, finish = () => {}, log = () => {}, now = Date.now }) {
  let job = null, displayed = null, recoveringHealth = false, previousHealth = null
  let currentController = null, fence = null, acting = false, stepSince = 0
  let runs = 0, live = null, last = null
  const status = () => displayed
  // The run under way, or the last one: its number, its named wait and its outcome.
  function runState () {
    const at = now()
    if (!live) return { n: runs, running: false, ms: 0, wait: last?.wait ?? null, outcome: last?.outcome ?? null }
    const ms = at - live.since
    return { n: live.n, running: true, ms, wait: live.wait ?? (ms < CARRY_MS ? last?.wait ?? null : null), outcome: ms < CARRY_MS ? last?.outcome ?? null : null }
  }
  const pause = (mine, code, reason) => { if (mine) mine.wait = { code }; show('waiting', reason) }
  function owns () {
    if (!active()) return false
    if (job) return true
    let record
    try { record = state.record() } catch (error) {
      last = { wait: null, outcome: failed('RECORD_UNREADABLE', { detail: error.message }) }
      show('recovering', String(error.message))
      return true
    }
    const dimension = raw()?.dimension
    if (!record) return dimension != null
    if (record.recovery || record.stage !== 'early' || dimension === 'nether' || dimension === 'end') return true
    return !legacyNeeded(record)
  }
  function show (phase, reason) {
    if (!displayed || displayed.phase !== phase || displayed.reason !== reason) log(`プレイヤーモード: ${reason}`)
    displayed = { phase, reason }
  }
  function cancel () {
    currentController?.abort()
    displayed = null
    recoveringHealth = false
    previousHealth = null
  }
  // Called during long actions too. Stop the underlying motion before another
  // owner can begin work, and never commit an interrupted action as progress.
  function ready (current) {
    return !loading() && current?.phase === 'spawned' && !current.dead && !current.isDead && !current.lifecycle?.dead && !current.spawnPending &&
      Number.isFinite(current.health) && current.health > 0 && current.inventory?.known === true && !current.inventory.uncertain
  }
  function guard () {
    if (!acting || !currentController || currentController.signal.aborted) return
    const current = raw()
    const hurt = Number.isFinite(previousHealth) && current?.health < previousHealth && current.health <= 12
    if (hurt) recoveringHealth = true
    const changed = fence !== lifeKey() || !active() || !ready(current)
    if (changed || hurt) {
      currentController.abort()
      // A hit alone must not end a fight that already owns the input.
      stopLegacy('遠征中の入力を解除して状態を再確認します。', { hurtOnly: !changed })
    }
    previousHealth = current?.health
  }
  async function execute (controller, mine) {
    await state.observe()
    const record = state.record()
    if (controller.signal.aborted || !active() || fence !== lifeKey()) return
    if (!record) return pause(mine, 'WORLD', 'ワールドと現在地の受信を待っています。')
    if (record.stage === 'complete') { finish(); return show('completed', 'ドラゴン戦を終え、現世への帰還を確認しました。') }
    const seen = raw()
    if (!ready(seen)) return pause(mine, 'STATE', '復帰地点・体力・所持品の再受信を待っています。')
    if (legacyBusy()) return pause(mine, 'OWNER', '進行中の移動・収納・戦闘が終わるのを待っています。')
    if (!legacyIdle()) {
      mine.wait = { code: 'OWNER' }
      stopLegacy('通常作業を終えて、ドラゴン遠征に移ります。')
      return
    }
    previousHealth = seen.health
    if (seen.health <= 12) recoveringHealth = true
    if (seen.health >= 18) recoveringHealth = false
    const before = JSON.stringify(record)
    acting = true
    const result = await run(record, controller.signal, recoveringHealth, { n: mine.n, wait: code => { if (live === mine) mine.wait = code ? { code } : null } })
    // Given up while it ran (abandon): another step owns the flags now.
    if (controller !== currentController) return
    // The worker can finish between timer ticks. Recheck the same receipts at
    // the commit boundary, including the inventory and loading state.
    guard()
    acting = false
    if (controller.signal.aborted || !active()) return
    const saved = before === JSON.stringify(record) || await state.save(record)
    if (controller.signal.aborted || !active() || fence !== lifeKey() || loading()) return
    if (saved === false) return pause(mine, 'CHECKPOINT', '現在のワールド・次元・復帰状態を再確認しています。')
    mine.wait = result?.wait?.code ? { code: result.wait.code } : null
    mine.outcome = result?.result ?? null
    if (result?.reason) show(result.phase ?? 'working', result.reason)
    if (record.stage === 'complete') finish()
  }
  function tick () {
    if (!active()) { cancel(); return false }
    if (job) { guard(); return true }
    if (!owns()) {
      displayed = null
      // The first life and a later death must be observable even while the
      // original home-building and mining jobs own the action loop.
      void state.observe().catch(error => log(String(error.message)))
      return false
    }
    const controller = new AbortController()
    currentController = controller
    fence = lifeKey()
    const entry = live = { n: ++runs, since: now(), wait: null, outcome: null }
    const mine = execute(controller, entry).catch(error => {
      // An exception is an outcome with a code, not a wait on purpose.
      entry.wait = null
      entry.outcome = failed('STEP_THREW', { detail: error?.message ?? error })
      if (active() && !controller.signal.aborted) show('recovering', String(error.message ?? error).slice(0, 160))
    }).finally(() => {
      // A step that was given up (abandon) must not clear the one that replaced it.
      if (job !== mine) return
      acting = false
      job = null
      currentController = null
      last = { wait: entry.wait, outcome: entry.outcome }
      live = null
    })
    job = mine
    stepSince = now()
    return true
  }
  // A step that never returns (an await nothing answers) is let go: its signal is aborted, every
  // operation it still holds is stopped, and the next tick starts a new step (dragon-progress.js).
  function abandon (reason) {
    if (!job) return false
    currentController?.abort()
    job = null
    currentController = null
    acting = false
    last = { wait: null, outcome: failed('STEP_ABANDONED', { detail: reason }) }
    live = null
    stopLegacy(reason)
    return true
  }
  // Whether a step can still send: it runs, and was not aborted. A step that only observes, saves or
  // cleans up sends nothing, so nobody who takes the input waits for it (control-owner.js handoff).
  const sending = () => Boolean(job) && acting && !!currentController && !currentController.signal.aborted
  return { owns, tick, guard, cancel, abandon, status, runState, sending, busy: () => Boolean(job), stepMs: () => job ? now() - stepSince : 0, settled: () => job ?? Promise.resolve() }
}

module.exports = { createDragonExpedition }
