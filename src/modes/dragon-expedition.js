'use strict'

// Only one adventure action may own the player. The ordinary survival crew
// keeps its existing scheduler until its house and equipment goals are met.
function createDragonExpedition ({ state, raw, active, legacyNeeded, legacyBusy, legacyIdle, stopLegacy, run, lifeKey = () => null, loading = () => false, finish = () => {}, log = () => {} }) {
  let job = null, displayed = null, recoveringHealth = false, previousHealth = null
  let currentController = null, fence = null, acting = false, stepSince = 0
  const status = () => displayed
  function owns () {
    if (!active()) return false
    if (job) return true
    let record
    try { record = state.record() } catch (error) {
      show('waiting', String(error.message))
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
  async function execute (controller) {
    await state.observe()
    const record = state.record()
    if (controller.signal.aborted || !active() || fence !== lifeKey()) return
    if (!record) return show('waiting', 'ワールドと現在地の受信を待っています。')
    if (record.stage === 'complete') { finish(); return show('completed', 'ドラゴン戦を終え、現世への帰還を確認しました。') }
    const current = raw()
    if (!ready(current)) {
      return show('waiting', '復帰地点・体力・所持品の再受信を待っています。')
    }
    if (legacyBusy()) return show('waiting', '進行中の移動・収納・戦闘が終わるのを待っています。')
    if (!legacyIdle()) {
      stopLegacy('通常作業を終えて、ドラゴン遠征に移ります。')
      return
    }
    previousHealth = current.health
    if (current.health <= 12) recoveringHealth = true
    if (current.health >= 18) recoveringHealth = false
    const before = JSON.stringify(record)
    acting = true
    const result = await run(record, controller.signal, recoveringHealth)
    // Given up while it ran (abandon): another step owns the flags now.
    if (controller !== currentController) return
    // The worker can finish between timer ticks. Recheck the same receipts at
    // the commit boundary, including the inventory and loading state.
    guard()
    acting = false
    if (controller.signal.aborted || !active()) return
    const saved = before === JSON.stringify(record) || await state.save(record)
    if (controller.signal.aborted || !active() || fence !== lifeKey() || loading()) return
    if (saved === false) return show('waiting', '現在のワールド・次元・復帰状態を再確認しています。')
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
    const mine = execute(controller).catch(error => {
      if (active() && !controller.signal.aborted) show('waiting', String(error.message ?? error).slice(0, 160))
    }).finally(() => {
      // A step that was given up (abandon) must not clear the one that replaced it.
      if (job !== mine) return
      acting = false
      job = null
      currentController = null
    })
    job = mine
    stepSince = Date.now()
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
    stopLegacy(reason)
    return true
  }
  return { owns, tick, guard, cancel, abandon, status, busy: () => Boolean(job), stepMs: () => job ? Date.now() - stepSince : 0, settled: () => job ?? Promise.resolve() }
}

module.exports = { createDragonExpedition }
