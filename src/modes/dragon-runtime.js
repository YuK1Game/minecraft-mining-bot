'use strict'

const { packRoom, crowded } = require('./dragon-pack-room')
const { createDragonExpedition } = require('./dragon-expedition')
const { createDragonState } = require('./dragon-state')
const { earlyObjective, runDragonEarly } = require('./dragon-early')
const { stepNether } = require('./dragon-nether')
const { createDragonStronghold } = require('./dragon-stronghold')
const { runDragonEndStep } = require('./dragon-end')
const { hasFood } = require('./player-food')
const { recoverDragon } = require('./dragon-recovery')
const { createDragonSupplies } = require('./dragon-supplies')
const { nightHome } = require('./dragon-night')
const { threatWait } = require('./dragon-threat-wait')
const { createProgress } = require('./dragon-progress')

function createDragonRuntime (ports) {
  const { runtime, shared, root, getBlock } = ports
  const raw = runtime.raw
  const state = createDragonState({ root, shared, getState: raw, getBlock,
    getLife: () => runtime.host().getLife?.(), getWorldId: () => runtime.host().meta?.startGame?.seed })
  const legacyNeeded = memory => earlyObjective({ inventory: shared.inventoryUncertain ? null : raw().inventory,
    worn: runtime.armor?.(), house: shared.playerHouse, memory }).legacy === true
  let stepRecord = null
  async function run (record, signal, recoverHealth) {
    stepRecord = record
    return step(record, signal, recoverHealth)
  }
  async function step (record, signal, recoverHealth) {
    const ctx = ports.stepPorts(signal)
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
    if (recoverHealth && dim !== 'end') {
      // An enemy that stands near without hitting for twenty seconds no longer holds the meal and the hunt
      // (live 2026-11-19 01:21-01:34 JST: thirteen minutes at health 7 with no food, then a creeper).
      const hit = Date.now() - Number(shared.travelLastDamageAt ?? 0) < 10000
      if (ports.threatened() && threatWait(shared, 'recover', { fighting: hit, slot: 'dragonRecoverWait' })) {
        await runtime.travel().retreatFromHostiles()
        return { phase: 'recovering', reason: '被弾したため、攻撃を中断して退避します。' }
      }
      if (ctx.operations.food.preview().ready) await ctx.operations.food.eat()
      else if (!hasFood(runtime.inventory())) {
        if (dim === 'nether' && record.nether.gate) {
          record.nether.returning = 'supplies'
          return stepNether(ctx)
        }
        if (record.recovery) return recoverDragon(ctx, record)
        if (dim === 'overworld' && shared.playerHouse?.origin) return supplies.acquire('food', 1)
      }
      return { phase: 'recovering', reason: '安全な場所で食事を取り、体力18以上への回復を待ちます。' }
    }
    if (record.recovery || record.lootRecovery) {
      const recovery = await recoverDragon(ctx, record)
      if (!recovery.done) return { phase: 'recovering', reason: recovery.reason }
    }
    if (dim === 'end') {
      const result = await runDragonEndStep(ctx, record.end, opts)
      record.stage = 'end'
      return result
    }
    if (record.stage === 'end') {
      if (dim !== 'overworld') return { phase: 'waiting', reason: 'エンド出撃所のある現世への復帰を待ちます。' }
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
    if (dim !== 'overworld') return { phase: 'waiting', reason: '現在の次元を確認しています。' }
    if (record.stage === 'stronghold') {
      const result = await stronghold.step(record, opts)
      if (result.patch) Object.assign(record, result.patch)
      if (result.ready) { record.stronghold.prepared = true; record.stage = 'end' }
      return result
    }
    const result = await runDragonEarly(ctx)
    if (result.done) { record.early.finished = true; record.stage = 'nether' }
    return result
  }
  const expedition = createDragonExpedition({ ...ports, state, raw, run, legacyNeeded })
  // What a stalled step forgets (dragon-progress.js): the pinned kit item, the home-approach rests, and the step itself.
  const progress = createProgress({ shared, log: ports.log, onReset: () => {
    const dropped = [stepRecord?.early?.gather && 'gather ' + stepRecord.early.gather.name, shared.dragonHomeWalk && 'homeWalk', shared.dragonHomeInner && 'homeInner',
      expedition.abandon('進まない遠征の1歩をやめて、状態を再確認します。') && 'step'].filter(Boolean)
    if (stepRecord?.early) delete stepRecord.early.gather
    delete shared.dragonHomeWalk; delete shared.dragonHomeInner
    return dropped.join('・')
  } })
  // Looked at on every tick, not after a step: a step that never returns is a stall too.
  function tick () {
    const owned = expedition.tick()
    if (!owned) { progress.clear(); return owned }
    const now = raw(), armor = runtime.armor?.(), shown = expedition.status(), stepMs = expedition.stepMs()
    progress.note({ feet: now?.position, items: shared.inventoryUncertain ? null : now?.inventory?.items, worn: armor?.known ? armor.worn : null, health: now?.health, stage: stepRecord?.stage },
      { reason: (shown?.reason ?? '') + (stepMs >= 60000 ? '・同じ1歩が ' + Math.round(stepMs / 1000) + ' 秒' : ''), waiting: shown?.phase === 'waiting' || shown?.phase === 'completed' })
    return owned
  }
  return { ...expedition, tick, record: state.record }
}
module.exports = { createDragonRuntime }
