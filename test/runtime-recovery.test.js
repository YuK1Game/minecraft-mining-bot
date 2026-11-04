'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { setTimeout: sleep } = require('node:timers/promises')
const { createState } = require('../src/state')
const { createSessionCache } = require('../src/session-cache')
const { createRecovery } = require('../src/recovery')

function deferred () {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function until (predicate, reason) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${reason}`)
    await sleep(5)
  }
}
function loadRuntime (overrides) {
  const filename = path.resolve(__dirname, '../src/runtime.js')
  const nativeRequire = Module.createRequire(filename)
  const target = { exports: {} }
  const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  return target.exports.createRuntime
}

function fixture (t, { delayedStop = false } = {}) {
  const cache = createSessionCache()
  const parsed = createState('runtime_recovery_test')
  const startGame = { runtime_entity_id: 41n, entity_id: 41n, current_tick: 1000n, player_position: { x: 8.50558, y: 64.91255, z: -1.96432 }, rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  for (const [name, packet] of [
    ['start_game', startGame],
    ['item_registry', { itemstates: [] }],
    ['inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty) }],
    ['player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true }]
  ]) { cache.observe(name, packet); parsed.applyPacket(name, packet) }
  Object.assign(parsed.state, { phase: 'spawned', health: 3.43, connectionId: 'same-socket', version: '1.26.60' })
  const packets = []
  const shared = { autoWanted: false, autoOptions: {}, loadingScreenEnded: true, prediction: null, equipment: null }
  const movements = []
  const recoveries = []
  const gate = deferred()
  if (!delayedStop) gate.resolve()
  let stamp = 0
  const host = {
    meta: { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }, cache, shared, apiUrl: 'http://127.0.0.1:49999',
    client: { queue: (name, packet) => packets.push({ name, packet: structuredClone(packet) }) },
    world: {
      getBlock: (x, y, z) => {
        const name = y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air'
        return { known: true, position: { x, y, z }, name: `minecraft:${name}`, properties: name === 'water' ? { liquid_depth: 0 } : {}, boundingBox: name === 'stone' || name === 'sand' ? 'block' : 'empty', extra: [] }
      },
      stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 27 })
    },
    entities: { snapshot: () => [], nearby: () => [] },
    getServerState: parsed.snapshot,
    getState: () => {
      const state = parsed.snapshot()
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = state.positionUpdatedAt
      state.rawSelectedSlot = state.selectedSlot
      if (shared.prediction) { state.position = structuredClone(shared.prediction.position); state.positionSource = 'client_prediction'; state.positionUpdatedAt = shared.prediction.updatedAt; state.positionServerConfirmed = false; state.predicted = structuredClone(shared.prediction) }
      return state
    },
    setPrediction: prediction => { shared.prediction = { ...structuredClone(prediction), updatedAt: `working-${++stamp}` } },
    setEquipmentPrediction: () => {}, setCapabilities: value => Object.assign(parsed.state.capabilities, value),
    allocate: () => -1, commitInventory: packet => parsed.applyPacket('inventory_content', packet), noteProgress: () => {}, log: () => {}
  }
  const overrides = {
    './movement': {
      createMovement: options => {
        const actor = { phase: 'idle', starts: [], stops: [], options }
        movements.push(actor)
        return {
          preview: () => ({ ready: true }),
          start: (target, flags) => { actor.phase = 'moving'; actor.starts.push({ target: structuredClone(target), flags }); return { phase: actor.phase } },
          stop: reason => { actor.phase = 'stopped'; actor.stops.push(reason); return gate.promise.then(() => ({ phase: 'stopped' })) },
          snapshot: () => ({ phase: actor.phase }),
          applyPacket: () => {}, settle: () => ({ phase: 'settling' })
        }
      }
    },
    './recovery': {
      createRecovery: options => {
        // Retain the actual bounded supervisor/replanning implementation.
        const controller = createRecovery({ ...options, pollMs: 10 })
        const actor = { controller, options, stops: [] }
        recoveries.push(actor)
        return { ...controller, stop: reason => { actor.stops.push(reason); return controller.stop(reason) } }
      }
    }
  }
  const runtime = loadRuntime(overrides)(host)
  t.after(async () => { gate.resolve(); await runtime.dispose('test_cleanup') })
  function arrive (actor = movements.at(-1)) {
    const target = actor.starts.at(-1).target
    actor.options.onPrediction({ position: { x: target.x, y: target.y + 1.62, z: target.z }, physicsState: { position: { ...target }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, isInWater: false }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, source: 'client_prediction', serverConfirmed: false })
    actor.phase = 'awaiting_server_confirmation'
  }
  return { runtime, host, parsed, movements, recoveries, gate, arrive, packets }
}

test('damage stops movement while retaining the actual recovery supervisor for a fresh bounded replan', async t => {
  const f = fixture(t)
  const raw = f.parsed.snapshot()
  const work = f.runtime.operations.recovery.execute()
  await until(() => f.movements[0].starts.length === 1, 'initial emergency move')
  const actor = f.recoveries[0]
  f.parsed.state.health = 2.7
  await f.runtime.stopActions('ダメージを検知しました。')
  assert.deepEqual(actor.stops, [])
  assert.equal(actor.controller.snapshot().busy, true)
  assert.equal(f.movements[0].phase, 'stopped')
  assert.equal(f.runtime.canReload(), false)
  await until(() => f.movements[0].starts.length === 2, 'supervisor replan after damage')
  assert.equal(actor.controller.snapshot().replans, 1)
  assert.equal(actor.controller.snapshot().attempts, 2)
  assert.equal(f.recoveries.length, 1, 'replanning retains the same bounded supervisor')
  f.arrive()
  const result = await work
  assert.equal(result.escaped, true)
  assert.equal(result.health, 2.7)
  assert.equal(result.healed, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.parsed.state.position, raw.position)
  assert.deepEqual(f.packets, [])
})

test('explicit stop and death abort recovery and await its owned movement cleanup', async t => {
  for (const reason of ['ユーザーが停止しました。', '死亡を確認しました。', 'ダメージを検知しました']) {
    const f = fixture(t, { delayedStop: true })
    const work = f.runtime.operations.recovery.execute()
    await until(() => f.movements[0].starts.length === 1, 'recovery starts before stop')
    const rejection = assert.rejects(work, error => error.message === reason)
    if (reason.includes('死亡')) { f.parsed.state.health = 0; f.parsed.state.dead = true }
    let cleaned = false
    const stopping = f.runtime.stopActions(reason).then(() => { cleaned = true })
    await new Promise(resolve => setImmediate(resolve))
    try {
      assert.equal(cleaned, false)
      assert.deepEqual(f.recoveries[0].stops, [reason])
      assert.equal(f.recoveries[0].controller.snapshot().phase, 'stopped')
      assert.equal(f.runtime.canReload(), false)
    } finally { f.gate.resolve(); await stopping; await rejection }
    assert.equal(f.recoveries[0].controller.snapshot().busy, false)
  }
})

test('dispose aborts a manual recovery and does not finish before delayed cleanup has drained', async t => {
  const f = fixture(t, { delayedStop: true })
  const work = f.runtime.operations.recovery.execute()
  await until(() => f.movements[0].starts.length === 1, 'manual recovery start')
  const rejection = assert.rejects(work, /hot_reload/)
  let disposed = false
  const disposal = f.runtime.dispose('hot_reload').then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(disposed, false)
    assert.deepEqual(f.recoveries[0].stops, ['hot_reload'])
    assert.throws(() => f.runtime.operations.movement.start({ x: 7.5, y: 63, z: -1.5 }, { emergency: true }), /更新/)
  } finally { f.gate.resolve(); await disposal; await rejection }
  assert.equal(f.recoveries[0].controller.snapshot().busy, false)
})

test('spawn cancels old recovery and delayed old cleanup cannot stop or publish into the new motion generation', async t => {
  const f = fixture(t, { delayedStop: true })
  const work = f.runtime.operations.recovery.execute()
  await until(() => f.movements[0].starts.length === 1, 'old recovery start')
  const rejection = assert.rejects(work, /スポーン/)
  const old = f.recoveries[0]
  const oldMovement = f.movements[0]
  f.runtime.onSpawn()
  assert.equal(f.recoveries.length, 2)
  assert.equal(old.controller.snapshot().phase, 'stopped')
  assert.equal(f.movements[1].stops.length, 0)
  assert.throws(() => old.options.movement.start({ x: 7.5, y: 63, z: -1.5 }, { emergency: true }), /スポーン前/)
  const before = structuredClone(f.host.shared.prediction)
  oldMovement.options.onPrediction({ position: { x: 100, y: 100, z: 100 } })
  assert.deepEqual(f.host.shared.prediction, before)
  f.gate.resolve()
  await rejection
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(oldMovement.stops.length > 0)
  assert.equal(f.movements[1].stops.length, 0)
  assert.deepEqual(f.recoveries[1].stops, [])
})
