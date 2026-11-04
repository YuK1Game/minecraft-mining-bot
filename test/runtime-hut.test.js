'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')

function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function loadRuntime (overrides) {
  const filename = path.resolve(__dirname, '../src/runtime.js')
  const nativeRequire = Module.createRequire(filename)
  const target = { exports: {} }
  const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  return target.exports.createRuntime
}

// Tests the real reloadable runtime API and ownership wiring. Controlled
// actors deliberately do not send packets, touch credentials or call HTTP.
function fixture (t, { delayedCleanup = false } = {}) {
  const calls = []
  const huts = []; const movements = []; const streams = []; const instances = []
  const gate = deferred()
  if (!delayedCleanup) gate.resolve()
  const raw = { phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', version: '1.26.60', connectionId: 'same-socket', startedAt: 'session', runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 'server', positionSource: 'start_game', selectedSlot: 0, heldItem: { slot: 0, name: 'minecraft:dirt', count: 17 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:dirt', count: 17 }] }, capabilities: {} }
  const shared = { autoWanted: false, autoOptions: {}, loadingScreenEnded: true, prediction: null, equipment: null, hutMemo: null }
  const host = {
    shared, meta: { version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: performance.now() }, apiUrl: 'http://127.0.0.1:49999',
    client: { queue: () => { throw new Error('A runtime wiring test must not send game packets') } }, cache: { replay: () => {} },
    world: { stats: () => ({ initialized: true, loadedSections: 27, version: '1.26.60' }), getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) },
    entities: { snapshot: () => [], nearby: () => [] },
    getServerState: () => structuredClone(raw),
    getState: () => ({ ...structuredClone(raw), rawSelectedSlot: raw.selectedSlot, rawServerPosition: { ...raw.position }, rawServerPositionUpdatedAt: raw.positionUpdatedAt, ...(shared.prediction ? { position: { ...shared.prediction.position }, positionSource: 'client_prediction', predicted: structuredClone(shared.prediction) } : {}) }),
    setCapabilities: values => Object.assign(raw.capabilities, values), setPrediction: prediction => { shared.prediction = structuredClone(prediction) }, setEquipmentPrediction: () => {}, allocate: () => -1, commitInventory: () => {}, noteProgress: value => calls.push({ type: 'progress', value: structuredClone(value) }), log: () => {}
  }
  const crafting = { applyPacket: () => {}, snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, availableRecipes: [] }), rawItem: () => null, preview: () => ({ ready: true }), craft: async () => ({ phase: 'completed' }), openInventory: () => ({}), closeContainer: () => { calls.push({ type: 'close_gui' }) }, cancel: () => {} }
  const mining = { preview: targets => ({ ready: true, targets }), start: targets => { calls.push({ type: 'mine', targets }); return { phase: 'completed' } }, stop: reason => { calls.push({ type: 'mine_stop', reason }); return { phase: 'stopped' } }, snapshot: () => ({ phase: 'idle' }) }
  const inventory = { snapshot: () => ({ busy: false }), applyPacket: () => {}, equip: async slot => { calls.push({ type: 'equip', slot }); return { phase: 'completed', serverConfirmed: true, slot: 0 } }, cancel: reason => calls.push({ type: 'equip_cancel', reason }) }
  const interactions = { applyPacket: () => {}, snapshot: () => ({ pendingOperation: null }), previewPlace: data => ({ ready: true, position: data.position, expectedBlock: 'minecraft:dirt' }), placeBlock: async data => { calls.push({ type: 'place', data }); return { phase: 'completed', position: data.position } }, cancel: reason => calls.push({ type: 'place_cancel', reason }) }
  const overrides = {
    './crafting': { createCrafting: () => crafting }, './mining': { createMining: () => mining }, './inventory': { createInventory: () => inventory }, './interactions': { createInteractions: () => interactions },
    './food': { createFood: () => ({ applyPacket: () => {}, snapshot: () => ({ busy: false }), cancel: () => {}, preview: () => ({ ready: false }) }), isSupportedFood: () => false },
    './input': { createInput: options => {
      const actor = { running: false, stops: 0, options }; streams.push(actor)
      return { start: () => { actor.running = true }, stop: () => { actor.running = false; actor.stops++ }, release: () => {}, stats: () => ({ running: actor.running }), lookAt: () => {}, sendAction: () => {}, sendTransaction: () => {} }
    } },
    './movement': { createMovement: options => {
      const actor = { phase: 'idle', options, stops: [] }; movements.push(actor)
      return { preview: () => ({ ready: true }), start: target => { actor.phase = 'awaiting_server_confirmation'; calls.push({ type: 'move', target }); return { phase: actor.phase } }, settle: () => ({}), stop: reason => { actor.phase = 'stopped'; actor.stops.push(reason); return { phase: 'stopped' } }, applyPacket: () => {}, snapshot: () => ({ phase: actor.phase }) }
    } },
    './hut': { createHut: options => {
      const actor = { options, busy: false, phase: 'idle', memory: structuredClone(options.memo), previews: [], executions: [], leaves: [], stops: [], work: null, cleanup: null }
      huts.push(actor)
      const snapshot = () => ({ busy: actor.busy, phase: actor.phase, memo: structuredClone(actor.memory) })
      const begin = (method, args) => { actor.busy = true; actor.phase = method === 'leaves' ? 'leaving' : 'building'; actor.cleanup = null; actor.work = deferred(); actor[method].push(structuredClone(args)); return actor.work.promise }
      return {
        preview: args => { actor.previews.push(structuredClone(args)); return { ready: true, type: 'soil_hut', id: 'hut-1', initialDirt: 17 } },
        execute: args => begin('executions', args), leave: args => begin('leaves', args),
        stop: reason => {
          actor.stops.push(reason)
          if (!actor.busy) return Promise.resolve(snapshot())
          actor.cleanup ??= gate.promise.then(() => { options.movement.stop(reason); options.mining.stop(reason); actor.busy = false; actor.phase = 'stopped'; actor.work.resolve({ phase: 'stopped' }); return snapshot() })
          return actor.cleanup
        }, snapshot, memo: () => structuredClone(actor.memory)
      }
    } }
  }
  const create = () => { const runtime = loadRuntime(overrides)(host); instances.push(runtime); return runtime }
  const runtime = create()
  t.after(async () => { gate.resolve(); for (const current of instances) await current.dispose('test_cleanup') })
  const publish = (actor, memo) => { actor.memory = structuredClone(memo); actor.options.onProgress({ type: 'hut', phase: 'predicted', memo: structuredClone(memo) }) }
  return { runtime, create, host, raw, huts, movements, streams, gate, calls, publish }
}

test('hut API forwards read-only preview and execute/leave/stop while excluding external actions from owned work', async t => {
  const f = fixture(t)
  assert.equal(f.runtime.canReload(), true)
  assert.equal(f.runtime.operations.hut.preview({ radius: 0 }).type, 'soil_hut')
  assert.deepEqual(f.huts[0].previews, [{ radius: 0 }])
  assert.equal(f.calls.length, 0)
  const work = f.runtime.operations.hut.execute({ maxActions: 8, site: { id: 'hut-1' } })
  const actor = f.huts[0]
  assert.deepEqual(actor.executions[0], { maxActions: 8, site: { id: 'hut-1' } })
  assert.equal(f.runtime.snapshot().hut.busy, true)
  assert.equal(f.runtime.canReload(), false)
  assert.throws(() => f.runtime.operations.mining.start([{ x: 1, y: 65, z: 0 }]), /前の操作/)
  assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 }), /前の操作/)
  await assert.rejects(f.runtime.operations.inventory.equip(0), /前の操作/)
  assert.throws(() => f.runtime.operations.interactions.placeBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0 }), /前の操作/)
  assert.doesNotThrow(() => actor.options.mining.start([{ x: 1, y: 65, z: 0 }]))
  assert.doesNotThrow(() => actor.options.movement.preview({ x: 1.5, y: 65, z: 0.5 }))
  assert.doesNotThrow(() => actor.options.movement.start({ x: 1.5, y: 65, z: 0.5 }))
  await actor.options.inventory.equip(0)
  await actor.options.interactions.placeBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0 })
  assert.equal(typeof actor.options.inventory.cancel, 'function')
  assert.equal(typeof actor.options.interactions.cancel, 'function')
  await f.runtime.operations.hut.stop('end build'); await work
  assert.equal(actor.busy, false)
  const leave = f.runtime.operations.hut.leave({ maxActions: 3 })
  assert.deepEqual(actor.leaves[0], { maxActions: 3 })
  await f.runtime.operations.hut.stop('end leave'); await leave
  assert.equal(f.runtime.canReload(), true)
})

test('hut progress is connection-owned and replays into the next runtime without letting disposed callbacks overwrite it', async t => {
  const f = fixture(t)
  const memo = { version: 1, kind: 'soil_hut', site: { id: 'hut-1' }, stepIndex: 7, placements: [{ position: { x: 1, y: 65, z: 0 }, item: 'minecraft:dirt', count: 1, serverConfirmed: true }] }
  f.publish(f.huts[0], memo)
  assert.deepEqual(f.host.shared.hutMemo, memo)
  assert.deepEqual(f.runtime.snapshot().hut.memo, memo)
  await f.runtime.dispose('hot_reload')
  const next = f.create()
  assert.deepEqual(f.huts[1].options.memo, memo)
  assert.deepEqual(next.snapshot().hut.memo, memo)
  f.publish(f.huts[0], { version: 1, site: { id: 'old-late-write' } })
  assert.deepEqual(f.host.shared.hutMemo, memo)
  const prediction = structuredClone(f.host.shared.prediction)
  f.movements[0].options.onPrediction({ position: { x: 100, y: 100, z: 100 } })
  assert.deepEqual(f.host.shared.prediction, prediction)
  assert.throws(() => f.huts[0].options.movement.start({ x: 1.5, y: 65, z: 0.5 }), /スポーン前|更新/)
})

test('stopActions waits for delayed manual hut cleanup and reload remains blocked until it finishes', async t => {
  const f = fixture(t, { delayedCleanup: true })
  const work = f.runtime.operations.hut.execute({ maxActions: 8 })
  let finished = false
  const stopping = f.runtime.stopActions('explicit stop').then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(finished, false)
    assert.equal(f.runtime.canReload(), false)
    assert.ok(f.huts[0].stops.includes('explicit stop'))
    assert.throws(() => f.runtime.operations.hut.execute({}), /前の操作/)
  } finally { f.gate.resolve(); await stopping; await work }
  assert.equal(f.runtime.snapshot().hut.busy, false)
  assert.equal(f.runtime.canReload(), true)
})

test('dispose waits for hut cleanup and immediately fences late progress while the cleanup is pending', async t => {
  const f = fixture(t, { delayedCleanup: true })
  const memo = { version: 1, site: { id: 'hut-1' }, stepIndex: 4 }
  f.publish(f.huts[0], memo)
  const work = f.runtime.operations.hut.execute({})
  let disposed = false
  const disposal = f.runtime.dispose('hot_reload').then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(disposed, false)
    f.publish(f.huts[0], { site: { id: 'during-dispose' } })
    assert.deepEqual(f.host.shared.hutMemo, memo)
    assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 }), /更新/)
    assert.ok(f.streams[0].stops > 0)
    assert.equal(f.streams[0].running, false)
  } finally { f.gate.resolve(); await disposal; await work }
  assert.equal(f.runtime.snapshot().hut.busy, false)
})

test('spawn force-stops the old base stream and late old hut cleanup cannot stop the replacement input or movement', async t => {
  const f = fixture(t, { delayedCleanup: true })
  f.runtime.resumeRequested()
  assert.equal(f.streams[0].running, true)
  const work = f.runtime.operations.hut.execute({})
  const old = f.huts[0]
  f.runtime.onSpawn()
  assert.equal(f.streams[0].running, false)
  assert.equal(f.huts.length, 2)
  assert.equal(f.movements[1].stops.length, 0)
  f.runtime.resumeRequested()
  assert.equal(f.streams[1].running, true)
  assert.throws(() => old.options.mining.start([{ x: 1, y: 65, z: 0 }]), /スポーン前/)
  f.gate.resolve(); await work
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.movements[1].stops.length, 0)
  assert.equal(f.streams[1].running, true)
  assert.equal(f.runtime.snapshot().hut.busy, false)
})
