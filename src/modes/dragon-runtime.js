'use strict'

const { packRoom, crowded } = require('./dragon-pack-room')
const { createDragonExpedition } = require('./dragon-expedition')
const { createDragonState } = require('./dragon-state')
const { objectiveNow, runDragonEarly } = require('./dragon-early')
const { stepNether } = require('./dragon-nether')
const { createDragonStronghold } = require('./dragon-stronghold')
const { runDragonEndStep } = require('./dragon-end')
const { recoverDragon } = require('./dragon-recovery')
const { createDragonSupplies } = require('./dragon-supplies')
const { nightHome } = require('./dragon-night')
const { heal } = require('./dragon-heal')
const { finishTree } = require('./dragon-tree')
const { createProgress } = require('./dragon-progress')
const { createGoalLedger } = require('./goal/goal-ledger')
const { goalKey, measure } = require('./dragon-goal-measure')

const HELD = '進まない目的を保留しています。場所・持ち物・接続が変わった時か、時間をおいて見直します。'
const LET_GO_MS = 60000
const cell16 = feet => feet && Number.isFinite(feet.x) ? [feet.x, feet.y, feet.z].map(v => Math.floor(v / 16)).join(',') : '?'

function createDragonRuntime (ports) {
  const { runtime, shared, root, getBlock } = ports
  const raw = runtime.raw
  const state = createDragonState({ root, shared, getState: raw, getBlock,
    getLife: () => runtime.host().getLife?.(), getWorldId: () => runtime.host().meta?.startGame?.seed })
  const legacyNeeded = memory => objectiveNow({ runtime, shared, memory }).legacy === true
  let stepRecord = null, unpin = false
  // The parent goal of the work (goal/goal-ledger.js): its clock, its budget and its hold are in `shared`, and
  // its checkpoint is saved with the record, so neither a reload nor a restart starts them again.
  const now = ports.now ?? Date.now
  const ledger = createGoalLedger({ shared, now, world: () => state.scope(), restore: () => { try { return state.snapshot()?.goal ?? null } catch { return null } } })
  // What a step may tell its goal: a confirmed step, a mark, a failure of one way (`spent` after three), a wait on purpose.
  const goal = { step: key => ledger.step(key), mark: (key, value, by) => ledger.mark(key, value, by), fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure),
    reached: kind => ledger.step(kind + '@' + cell16(raw()?.position)) }
  async function run (record, signal, recoverHealth, live = {}) {
    stepRecord = record
    ledger.run()
    // The choice a decision dropped is taken out of the record this run saves (the run before holds a copy of its own).
    if (unpin) { unpin = false; if (record.early) delete record.early.gather }
    const result = await step(record, signal, recoverHealth, live)
    const mark = ledger.checkpoint()
    if (mark) record.goal = mark
    return result
  }
  async function step (record, signal, recoverHealth, live) {
    const ctx = ports.stepPorts(signal)
    ctx.goal = { ...goal, wait: code => live.wait?.(code) }
    const dim = raw().dimension
    if (record.stage !== 'early') shared.dragonGoldBoots = dim === 'nether' || record.stage === 'nether'
    const opts = { signal, aborted: ctx.cancelled }
    const supplies = createDragonSupplies(ctx)
    Object.assign(ctx, { supplies, memory: record, rt: runtime, ports: ctx.hands, active: () => !ctx.cancelled(), ...opts })
    const stronghold = createDragonStronghold(ctx)
    // From dusk the overworld part before the Nether goes home to its bed (dragon-night.js).
    if (dim === 'overworld' && record.stage === 'early' && !record.recovery && !(recoverHealth && ports.threatened())) {
      const night = await nightHome(ctx, { clock: () => runtime.travel?.()?.travelClock?.() })
      if (night) return night
    }
    // A full inventory first throws its rubble away (dragon-pack-room.js): nothing else makes room under the expedition.
    if (dim === 'overworld' && !recoverHealth && ctx.drop && crowded(shared.inventoryUncertain ? null : runtime.inventory()) && !ports.threatened()) {
      const packed = await packRoom({ shared, getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), getFeet: ctx.getFeet, drop: ctx.drop, walk: ctx.walk, why: () => ctx.hands.why?.(), cells: ctx.cells, log: ctx.log })
      if (packed) return packed
    }
    // The wait for health: a meal, the regeneration, or the way to food (dragon-heal.js).
    if (recoverHealth && dim !== 'end') {
      // Healing is the work now: more health than at any time since the last result is a mark, a hit and a heal in turn is none.
      ledger.mark('health', 20 - Number(raw().health), 2)
      return heal({ ctx, record, dim, shared, runtime, threatened: ports.threatened, supplies, nether: stepNether, recover: recoverDragon })
    }
    if (record.recovery || record.lootRecovery) {
      const recovery = await recoverDragon(ctx, record)
      if (!recovery.done) return { phase: 'recovering', reason: recovery.reason }
    }
    // No weapon in the bag: a stone sword is made of what is carried before other work (carry-weapon.js).
    if (dim === 'overworld' && record.stage === 'early') {
      const way = supplies.weapon()
      if (way && !ports.threatened()) return supplies.arm(way)
    }
    // A tree that was begun is cut down to its last log before other work (dragon-tree.js).
    if (dim === 'overworld' && (shared.playerTree || shared.playerScaffoldDebt) && !ports.threatened()) {
      const felling = await finishTree(ctx)
      if (felling) return felling
    }
    // A held goal keeps the steps above (night, room in the pack, health, recovery) and nothing else. Only in the
    // overworld: in the Nether and in the End standing still is the danger, the work goes on and the hold only
    // keeps the watcher from deciding again.
    if (ledger.goal()?.hold && dim === 'overworld') return { phase: 'waiting', reason: HELD }
    if (dim === 'end') {
      const result = await runDragonEndStep(ctx, record.end, opts)
      record.stage = 'end'
      return result
    }
    if (record.stage === 'end') {
      if (dim !== 'overworld') return { phase: 'waiting', reason: 'エンド出撃所のある現世への復帰を待ちます。', wait: { code: 'DIMENSION' } }
      const result = record.end.returnAttempt ? await runDragonEndStep(ctx, record.end, opts) : {}
      if (result.phase === 'complete') {
        record.stage = 'complete'
        return { phase: 'completed', reason: result.reason }
      }
      return stronghold.enter(record, opts)
    }
    if (dim === 'nether' || record.stage === 'nether') {
      const result = await stepNether(ctx)
      if (result.done && raw().dimension === 'overworld') { record.nether.finished = true; record.stage = 'stronghold'; shared.dragonGoldBoots = false }
      return result
    }
    if (dim !== 'overworld') return { phase: 'waiting', reason: '現在の次元を確認しています。', wait: { code: 'DIMENSION' } }
    if (record.stage === 'stronghold') {
      const result = await stronghold.step(record, opts)
      if (result.patch) Object.assign(record, result.patch)
      if (result.ready) { record.stronghold.prepared = true; record.stage = 'end' }
      return result
    }
    const result = await (ports.early ?? runDragonEarly)(ctx)
    if (result.done) { record.early.finished = true; record.stage = 'nether' }
    return result
  }
  const expedition = createDragonExpedition({ ...ports, now, state, raw, run, legacyNeeded })
  // What a goal decided again forgets (dragon-progress.js): the pinned kit item, the home-approach rests, and the step itself.
  const progress = createProgress({ shared, ledger, now, log: ports.log, onReset: ({ waiting = null } = {}) => {
    // Only a step that has not returned for LET_GO_MS is let go: one that answers every two seconds is asked again anyway.
    const letGo = expedition.stepMs() >= LET_GO_MS && expedition.abandon('進まない遠征の1歩をやめて、状態を再確認します。') && 'step'
    // A wait past its limit (another owner, the night) is only looked at again; the step's choices are for work that stood.
    if (waiting) return [letGo].filter(Boolean).join('・')
    const dropped = [stepRecord?.early?.gather && 'gather ' + stepRecord.early.gather.name, shared.dragonHomeWalk && 'homeWalk', shared.dragonHomeInner && 'homeInner', letGo].filter(Boolean)
    unpin = true
    delete shared.dragonHomeWalk; delete shared.dragonHomeInner
    return dropped.join('・')
  }, onHold: () => { expedition.abandon('進まない目的を保留します。') } })
  // The goal the expedition works toward now; null while it cannot be told (nothing received yet).
  function keyNow () {
    let record = stepRecord
    if (!record) { try { record = state.snapshot() } catch { return null } }
    if (!record || state.scope() == null) return null
    if (record.stage !== 'early') return { key: goalKey(record), record }
    const objective = objectiveNow({ runtime, shared, memory: record })
    // No objective of its own to name (the inventory is not received, or the expedition owns the player only to
    // recover what a death left): the goal it had goes on.
    return { key: goalKey(record, objective) ?? ledger.goal()?.key ?? 'early.recover', record }
  }
  // Looked at on every tick, not after a step: a step that never returns is a stall too. While another owner has
  // the player nothing is counted and nothing is cleared: the same goal goes on when the expedition has it again.
  function tick () {
    const owned = expedition.tick()
    if (!owned) return owned
    const at = keyNow()
    if (!at?.key) return owned
    const seen = raw(), armor = runtime.armor?.(), shown = expedition.status(), live = expedition.runState(), stepMs = expedition.stepMs()
    // Measured only from a received inventory and received armour; while either is open, nothing is counted as a result.
    const items = shared.inventoryUncertain || seen?.inventory?.known !== true || seen.inventory.uncertain ? null : seen.inventory.items
    const sized = armor && armor.known !== true ? null : measure({ key: at.key, items, worn: armor?.worn ?? [], reserve: shared.dragonReserveSeen?.counts, record: at.record })
    progress.note(at.key, { feet: seen?.position, health: seen?.health, value: sized?.value ?? null, extras: sized?.extras ?? null, scope: ports.lifeKey?.() ?? null },
      { n: live.n, wait: live.wait, reason: String(shown?.reason ?? '').replace(/。$/, '') + (live.outcome ? '・結果 ' + live.outcome.status + '/' + live.outcome.code : '') + (stepMs >= 60000 ? '・同じ1歩が ' + Math.round(stepMs / 1000) + ' 秒' : '') })
    return owned
  }
  return { ...expedition, tick, record: state.record, goal }
}
module.exports = { createDragonRuntime }
