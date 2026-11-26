'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createDragonExpedition } = require('../src/modes/dragon-expedition')
const { createDragonContinuation } = require('../src/modes/dragon-continuation')
const { createMineTools } = require('../src/modes/mining/mine-tools')
const results = require('../src/modes/return/return-result')
const { createWorld } = require('./helpers/dragon-goal-world')

function scene (run) {
  const raw = { phase: 'spawned', health: 20, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 }, inventory: { known: true, items: [] } }
  const record = { stage: 'early' }, timers = new Map(), state = { life: 'a', active: true, owner: false, at: 1000, priority: 'day', terrainRevision: 1, inventoryRevision: 1 }
  let n = 0, runs = 0, job
  const continuation = createDragonContinuation({ active: () => state.active, tick: () => job.tick(),
    schedule: (fn, ms) => { const id = ++n; timers.set(id, { fn, at: state.at + ms }); return id }, unschedule: id => timers.delete(id) })
  job = createDragonExpedition({ state: { observe: async () => {}, record: () => record, save: async () => true }, raw: () => raw, active: () => state.active,
    legacyNeeded: () => false, legacyBusy: () => state.owner, legacyIdle: () => true, lifeKey: () => state.life, stopLegacy: () => {},
    retryState: () => ({ inventoryRevision: state.inventoryRevision, terrainRevision: state.terrainRevision, priority: state.priority }), now: () => state.at,
    onStepDone: continuation.onStepDone, run: async (...args) => { runs++; return run(raw, state, ...args) } })
  const tick = async () => { job.tick(); await job.settled() }
  const pass = async ms => {
    const until = state.at + ms
    for (;;) {
      const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!entry || entry[1].at > until) break
      timers.delete(entry[0]); state.at = entry[1].at; entry[1].fn(); await job.settled()
      if (runs > 100) assert.fail('unbounded continuation loop')
    }
    state.at = until
  }
  return { raw, state, job, timers, tick, pass, runs: () => runs, continuation }
}

test('real tool supply result cannot schedule a fast loop or repeat on unchanged receipts, and resumes after a usable tool is received', async () => {
  let acquisitions = 0
  const f = scene(async raw => {
    const tools = createMineTools({ cancelled: () => false, runtime: { raw: () => raw }, supplies: { acquire: async () => { acquisitions++ } } },
      { inventory: () => raw.inventory, done: (code, evidence) => ({ ...results.completed(code, { evidence }), serverConfirmed: true }) })
    const result = await tools({ request: { resource: 'raw_iron' } })
    return { reason: '道具を確認します。', result }
  })
  await f.tick()
  assert.equal(f.job.runState().outcome.code, 'MINE_TOOL_SUPPLY')
  await f.pass(10000)
  for (let i = 0; i < 5; i++) await f.tick()
  assert.equal(f.runs(), 1)
  assert.equal(acquisitions, 1)
  assert.equal(f.timers.size, 0)
  f.raw.inventory.items.push({ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 20 })
  f.state.inventoryRevision++
  await f.tick()
  assert.equal(f.job.runState().outcome.code, 'MINE_TOOL_READY')
  assert.equal(acquisitions, 1)
  assert.equal(f.timers.size, 1, 'confirmed working results still continue promptly')
  f.state.active = false
  await f.pass(400)
  assert.equal(f.runs(), 2, 'a queued continuation cannot act after stop')
})

test('a receipt during the blocked step permits the next decision, but unchanged supply stops after that decision', async () => {
  const f = scene(async (raw, state) => {
    if (state.inventoryRevision === 1) { raw.inventory.items.push({ slot: 0, name: 'minecraft:stick', count: 2 }); state.inventoryRevision++ }
    return { reason: 'ツルハシの材料を確認します。', result: results.blocked('MINE_TOOL_SUPPLY', { kind: 'inventory_update' }) }
  })
  await f.tick(); await f.tick(); await f.tick()
  assert.equal(f.runs(), 2)
  assert.equal(f.timers.size, 0)
})

test('a nested terrain prerequisite keeps its own retry condition through tool preparation', async () => {
  let acquisitions = 0
  const f = scene(async raw => {
    const tools = createMineTools({ cancelled: () => false, runtime: { raw: () => raw }, supplies: { acquire: async () => {
      acquisitions++
      return { done: false, result: results.blocked('MINE_TERRAIN_REQUESTED', { kind: 'terrain_received' }) }
    } } }, { inventory: () => raw.inventory })
    return { reason: '材料の採掘地形を確認します。', result: await tools({ request: { resource: 'raw_iron' } }) }
  })
  await f.tick(); await f.tick()
  assert.equal(f.runs(), 1)
  assert.equal(f.job.runState().outcome.code, 'MINE_TERRAIN_REQUESTED')
  f.state.terrainRevision++
  await f.tick()
  assert.equal(acquisitions, 2, 'terrain receipt can resume the prerequisite without inventing an inventory change')
  assert.equal(f.timers.size, 0)
})

test('interrupted/cancelled outcomes never expedite; released owner, received safety changes and explicit reconsideration remain live', async () => {
  let status = 'interrupted'
  const f = scene(async () => ({ reason: status, result: status === 'blocked' ? results.blocked('SUPPLY', { kind: 'inventory_update' }) : results[status]('STOPPED') }))
  await f.tick(); assert.equal(f.timers.size, 0)
  f.state.owner = true; await f.tick(); assert.equal(f.runs(), 1)
  f.state.owner = false; await f.tick(); assert.equal(f.runs(), 2)
  status = 'cancelled'; await f.tick(); await f.tick(); assert.equal(f.runs(), 3)
  assert.equal(f.timers.size, 0)
  f.job.cancel(); status = 'blocked'; await f.tick(); await f.tick(); assert.equal(f.runs(), 4)
  f.state.priority = 'night'; await f.tick(); assert.equal(f.runs(), 5)
  f.raw.health = 11; await f.tick(); assert.equal(f.runs(), 6)
  f.job.reconsider(); await f.tick(); assert.equal(f.runs(), 7)
  f.state.life = 'b'; await f.tick(); assert.equal(f.runs(), 8)
})

test('real goal watchdog reconsiders a blocked task without a time-based hold and does not spam its action between decisions', async t => {
  const w = await createWorld(t, { step: async () => ({ reason: '工具の受信を待ちます。', result: results.blocked('MINE_TOOL_SUPPLY', { kind: 'inventory_update' }) }) })
  await w.pass(9 * 60000)
  assert.equal(w.calls, 1)
  await w.pass(2 * 60000)
  assert.equal(w.calls, 2)
  assert.equal(w.goal().decisions, 1)
  assert.equal(w.goal().hold, null)
  w.have('stick', 2)
  await w.pass(10000)
  assert.equal(w.calls, 3)
})

test('a wait of a kind the watcher does not follow (position_changed) is looked at again after a minute', () => {
  const { createExpeditionRetry, LOOK_AGAIN_MS } = require('../src/modes/dragon-retry')
  let at = 0
  const retry = createExpeditionRetry({ raw: () => ({ position: { x: 1, y: 2, z: 3 }, inventory: { known: true, items: [] } }), lifeKey: () => 'life', legacyBusy: () => false, legacyIdle: () => true, loading: () => false, now: () => at })
  retry.arm({ status: 'blocked', retry: { kind: 'position_changed' } }, retry.snapshot())
  at = LOOK_AGAIN_MS - 1
  assert.equal(retry.ready(), false)
  at = LOOK_AGAIN_MS
  assert.equal(retry.ready(), true)
})