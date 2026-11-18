'use strict'

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

function createDragonRuntime (ports) {
  const { runtime, shared, root, getBlock } = ports
  const raw = runtime.raw
  const state = createDragonState({ root, shared, getState: raw, getBlock,
    getLife: () => runtime.host().getLife?.(), getWorldId: () => runtime.host().meta?.startGame?.seed })
  const legacyNeeded = memory => earlyObjective({ inventory: shared.inventoryUncertain ? null : raw().inventory,
    worn: runtime.armor?.(), house: shared.playerHouse, memory }).legacy === true
  async function run (record, signal, recoverHealth) {
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
    if (recoverHealth && dim !== 'end') {
      if (ports.threatened()) {
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
  return { ...expedition, record: state.record }
}
module.exports = { createDragonRuntime }
