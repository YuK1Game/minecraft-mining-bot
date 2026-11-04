'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { createState } = require('../src/state')
const { createSessionCache } = require('../src/session-cache')

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Run the actual runtime factory with controlled connection-owned actors. This
// isolates ownership/lifecycle wiring without a socket or HTTP server.
function factory (overrides) {
  const filename = path.resolve(__dirname, '../src/runtime.js')
  const nativeRequire = Module.createRequire(filename)
  const target = { exports: {} }
  const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  return target.exports.createRuntime
}

function fixture (t, { delayedStop = false, probeInput = false } = {}) {
  const packets = []
  const observed = {}
  const cache = createSessionCache()
  const parsed = createState('runtime_tunneling_test')
  const extra = { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 12 } } } }, can_place_on: [], can_destroy: [] }
  const tool = { network_id: 299, count: 1, metadata: 0, has_stack_id: true, stack_id: 71, block_runtime_id: 0, extra }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  const slots = Array.from({ length: 36 }, empty)
  slots[0] = tool
  const startGame = { runtime_entity_id: 41n, entity_id: 41n, current_tick: 1000n, player_position: { x: 0.5, y: 7.62, z: 0.5 }, rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  for (const [name, packet] of [
    ['start_game', startGame],
    ['item_registry', { itemstates: [{ runtime_id: 299, name: 'minecraft:iron_pickaxe' }] }],
    ['inventory_content', { window_id: 'inventory', input: slots }],
    ['player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true }]
  ]) { cache.observe(name, packet); parsed.applyPacket(name, packet) }
  Object.assign(parsed.state, { phase: 'spawned', health: 20, connectionId: 'same-socket', version: '1.26.60' })
  const blocks = new Map()
  blocks.set('1,6,0', { known: true, name: 'minecraft:stone', properties: {}, boundingBox: 'block', diggable: true, hardness: 1.5, runtimeId: 1, extra: [] })
  const shared = { autoWanted: false, autoOptions: {}, loadingScreenEnded: true, prediction: null, equipment: null }
  let predictionId = 0
  const host = {
    meta: { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }, cache, shared, apiUrl: 'http://127.0.0.1:49999',
    client: { queue: (name, packet) => packets.push({ name, packet: structuredClone(packet) }) },
    world: {
      getBlock: (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y < 6 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 6 ? 'block' : 'empty', diggable: y < 6, hardness: y < 6 ? 1.5 : 0, runtimeId: y < 6 ? 1 : 0, extra: [] }),
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
    setPrediction: prediction => { shared.prediction = { ...structuredClone(prediction), updatedAt: `prediction-${++predictionId}` } },
    setEquipmentPrediction: () => {},
    setCapabilities: value => Object.assign(parsed.state.capabilities, value),
    allocate: () => -1,
    commitInventory: packet => parsed.applyPacket('inventory_content', packet),
    noteProgress: () => {}, log: () => {}
  }
  host.world.getArea = (center, radius) => {
    const area = []
    for (let x = center.x - radius; x <= center.x + radius; x++) for (let y = center.y - radius; y <= center.y + radius; y++) for (let z = center.z - radius; z <= center.z + radius; z++) area.push({ ...host.world.getBlock(x, y, z), position: { x, y, z } })
    return area
  }
  const gate = deferred()
  if (!delayedStop) gate.resolve()
  const childWork = deferred()
  let tunnelBusy = false
  let excavationBusy = false
  let stopPromise = null
  let controllerStopFinished = false
  const overrides = {
    './runner': {
      ...require('../src/runner'),
      createRunner: options => { observed.runner = options; return require('../src/runner').createRunner(options) }
    },
    './hut': {
      createHut: options => { observed.hut = options; return require('../src/hut').createHut(options) }
    },
    './shelter': {
      createShelter: options => { observed.shelter = options; return require('../src/shelter').createShelter(options) }
    },
    './movement': {
      createMovement: options => {
        const instance = { options, phase: 'idle', stops: 0 }
        observed.movements ??= []
        observed.movements.push(instance)
        return {
          preview: () => ({ ready: true }),
          start: () => { instance.phase = 'moving'; return { phase: 'moving' } },
          stop: () => { instance.stops++; instance.phase = 'stopped'; return { phase: 'stopped' } },
          snapshot: () => ({ phase: instance.phase }),
          settle: () => ({ phase: 'settling' }),
          applyPacket: () => {}
        }
      }
    },
    './excavation': {
      createExcavation: options => {
        observed.excavation = options
        return {
          preview: () => ({ ready: true, blocksToMine: [] }),
          execute: () => { excavationBusy = true; options.mining.start([{ x: 1, y: 6, z: 0 }]); return childWork.promise },
          stop: reason => { options.mining.stop(reason); excavationBusy = false; return Promise.resolve() },
          snapshot: () => ({ busy: excavationBusy, phase: excavationBusy ? 'clearing' : 'idle' })
        }
      }
    },
    './tunneling': {
      createTunneling: options => {
        observed.tunneling = options
        return {
          preview: () => ({ ready: true, steps: [] }),
          execute: () => { tunnelBusy = true; return childWork.promise },
          stop: reason => {
            stopPromise ??= gate.promise.then(() => { controllerStopFinished = true; tunnelBusy = false; options.movement.stop(reason); childWork.reject(new Error(reason)); return { phase: 'stopped' } })
            return stopPromise
          },
          snapshot: () => ({ busy: tunnelBusy, phase: tunnelBusy ? 'excavating' : 'idle' })
        }
      }
    }
  }
  if (probeInput) overrides['./input'] = {
    createInput: options => {
      const stream = { running: false, stops: 0, options }
      observed.streams ??= []
      observed.streams.push(stream)
      return { start: () => { stream.running = true }, stop: () => { stream.running = false; stream.stops++ }, release: () => {}, stats: () => ({ running: stream.running }), lookAt: () => {}, sendAction: () => {}, sendTransaction: () => {} }
    }
  }
  // Unstarted work is never an unhandled rejection when dispose calls stop.
  childWork.promise.catch(() => {})
  const runtime = factory(overrides)(host)
  t.after(async () => { gate.resolve(); await runtime.dispose('cleanup'); if (stopPromise) await stopPromise })
  return { runtime, replace: () => factory(overrides)(host), host, parsed, packets, observed, blocks, gate, childWork, finished: () => controllerStopFinished }
}

test('runtime can normalize server NBT Damage from its actual state descriptions before tunneling', async t => {
  const f = fixture(t)
  const tool = f.runtime.snapshot().inventory.items[0]
  assert.equal(tool.name, 'minecraft:iron_pickaxe')
  assert.equal(tool.durabilityKnown, true, 'state descriptions and raw crafting slot must share the real stack ID')
  assert.equal(tool.durabilityUsed, 12)
  assert.equal(tool.durabilityRemaining, 238)
  assert.equal(f.packets.length, 0)
})

test('owned excavation can start its child mining but external operations remain excluded', async t => {
  const f = fixture(t)
  let work
  assert.doesNotThrow(() => { work = f.runtime.operations.excavation.execute({ target: { x: 1, y: 6, z: 0 } }) })
  assert.equal(f.runtime.snapshot().mining.phase, 'mining')
  assert.throws(() => f.runtime.operations.mining.start([{ x: 1, y: 6, z: 0 }]), /掘り終わる|前の操作/)
  assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 6, z: 0.5 }), /掘り終わる|前の操作/)
  assert.equal(f.runtime.canReload(), false)
  await f.runtime.dispose('test-stop')
  f.childWork.resolve({ phase: 'stopped' })
  await Promise.allSettled([work])
})

test('dispose waits for a manual tunneling cleanup before the next runtime may use the shared actor', async t => {
  const f = fixture(t, { delayedStop: true })
  const work = f.runtime.operations.tunneling.execute({ target: { x: 3, y: 0, z: 0 } })
  const rejected = assert.rejects(work, /reload/)
  let disposed = false
  const disposing = f.runtime.dispose('reload').then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(disposed, false, 'manual owned cleanup must finish before dispose resolves')
    assert.equal(f.finished(), false)
    assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 6, z: 0.5 }), /更新/)
  } finally {
    f.gate.resolve()
    await disposing
    await rejected
  }
  assert.equal(f.finished(), true)
})

test('tunneling reads the newest host working pose and full physics metadata while server observations remain unchanged', async t => {
  const f = fixture(t)
  const original = f.parsed.snapshot()
  const prediction = { position: { x: 1.5, y: 7.62, z: 0.5 }, velocity: { x: 0.02, y: -0.0784, z: 0 }, onGround: true, physicsState: { position: { x: 1.5, y: 6, z: 0.5 }, velocity: { x: 0.02, y: -0.0784, z: 0 }, onGround: true }, source: 'client_prediction', serverConfirmed: false }
  f.observed.movements[0].options.onPrediction(prediction)
  const current = f.observed.tunneling.getState()
  assert.equal(current.positionSource, 'client_prediction')
  assert.equal(current.positionUpdatedAt, 'prediction-1')
  assert.deepEqual(current.position, prediction.position)
  assert.deepEqual(current.predicted.physicsState, prediction.physicsState)
  assert.deepEqual(current.rawServerPosition, original.position)
  assert.equal(current.rawServerPositionUpdatedAt, original.positionUpdatedAt)
  f.runtime.operations.movement.preview({ x: 2.5, y: 6, z: 0.5 })
  const seeded = f.observed.movements[0].options.getState()
  assert.deepEqual(seeded.position, prediction.position)
  assert.deepEqual(seeded.predicted.physicsState, prediction.physicsState)
  assert.deepEqual(f.parsed.snapshot(), original)
})

test('spawn reinitialization force-stops the old idle base stream before enabling its replacement', async t => {
  const f = fixture(t, { probeInput: true })
  f.runtime.resumeRequested()
  const old = f.observed.streams[0]
  assert.equal(old.running, true)
  f.runtime.onSpawn()
  assert.equal(old.running, false, 'release is insufficient because the old idle timer must end')
  assert.ok(old.stops > 0)
  assert.equal(f.observed.streams.length, 2)
  f.runtime.resumeRequested()
  assert.equal(f.observed.streams.filter(stream => stream.running).length, 1)
  assert.equal(f.observed.streams[1].running, true)
})

test('old delayed cleanup and prediction callbacks remain bound to the old motion generation after spawn', async t => {
  const f = fixture(t, { delayedStop: true })
  const oldMovement = f.observed.movements[0]
  const oldTunnel = f.observed.tunneling
  const work = f.runtime.operations.tunneling.execute({ target: { x: 3, y: 0, z: 0 } })
  const rejected = assert.rejects(work, /スポーン/)
  f.runtime.onSpawn()
  const replacement = f.observed.movements[1]
  assert.ok(replacement)
  assert.equal(replacement.stops, 0)
  const prediction = structuredClone(f.host.shared.prediction)
  oldMovement.options.onPrediction({ position: { x: 100, y: 100, z: 100 } })
  assert.deepEqual(f.host.shared.prediction, prediction, 'old model results cannot replace the current working pose')
  assert.throws(() => oldTunnel.movement.start({ x: 1.5, y: 6, z: 0.5 }), /スポーン前/)
  f.gate.resolve()
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(oldMovement.stops > 0)
  assert.equal(replacement.stops, 0, 'late old cleanup must not stop the new movement controller')
})

test('runtime retains scoped return floors across hot reload without allowing stale-generation callbacks to write', async t => {
  const f = fixture(t)
  f.parsed.state.realm = { id: '42', name: 'test' }
  f.runtime.onSpawn()
  const first = f.observed.tunneling
  const origin = { x: 0, y: 5, z: 0 }
  const next = { x: 1, y: 4, z: 0 }
  assert.deepEqual(first.getPreservedFloors(), [])
  assert.equal(f.host.shared.tunnelFloors, undefined, 'constructing the controller must not create speculative receipts')
  first.onPreserveFloor(origin)
  first.onPreserveFloor(next)
  first.onPreserveFloor(origin)
  const retained = first.getPreservedFloors()
  assert.deepEqual(retained, [origin, next])
  retained[0].y = 100
  assert.deepEqual(first.getPreservedFloors(), [origin, next], 'callers cannot mutate the stored journal')
  await f.runtime.dispose('hot-reload')
  const second = f.replace()
  t.after(() => second.dispose('cleanup'))
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), [origin, next])
  assert.equal(f.observed.tunneling.world.getBlock(origin.x, origin.y, origin.z).protectionSource, 'tunnel_floor', 'the actual replacement factory initializes its reader before a current planning read')
  const before = structuredClone(f.host.shared.tunnelFloors)
  assert.throws(() => first.onPreserveFloor({ x: 9, y: 0, z: 9 }), /スポーン前/)
  assert.deepEqual(f.host.shared.tunnelFloors, before)
  const old = f.observed.tunneling
  second.onSpawn()
  assert.throws(() => old.getPreservedFloors(), /スポーン前/)
  assert.throws(() => old.onPreserveFloor({ x: 9, y: 0, z: 9 }), /スポーン前/)
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), [origin, next])
})

test('floor journals remain isolated by profile, Realm and dimension and never evict floors at capacity', async t => {
  const f = fixture(t)
  const initial = f.observed.tunneling
  initial.onPreserveFloor({ x: 0, y: 5, z: 0 })
  const originalScope = JSON.stringify(['runtime_tunneling_test', null, 'overworld'])
  const original = structuredClone(f.host.shared.tunnelFloors.scopes[originalScope])
  f.parsed.state.realm = { id: '42', name: 'other' }
  assert.throws(() => initial.getPreservedFloors(), /ワールドが変わった/)
  assert.throws(() => initial.onPreserveFloor({ x: 1, y: 4, z: 0 }), /ワールドが変わった/)
  f.runtime.onSpawn()
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), [])
  f.observed.tunneling.onPreserveFloor({ x: 3, y: 4, z: 0 })
  const realmScope = JSON.stringify(['runtime_tunneling_test', '42', 'overworld'])
  assert.deepEqual(f.host.shared.tunnelFloors.scopes[originalScope], original)
  assert.deepEqual(f.host.shared.tunnelFloors.scopes[realmScope].floors, [{ x: 3, y: 4, z: 0 }])
  f.parsed.state.dimension = 'nether'
  assert.throws(() => f.observed.tunneling.getPreservedFloors(), /ワールドが変わった/)
  f.runtime.onSpawn()
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), [])
  f.parsed.state.profile = 'another-profile'
  f.runtime.onSpawn()
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), [])
  const scope = JSON.stringify(['another-profile', '42', 'nether'])
  const full = Array.from({ length: 1024 }, (_, x) => ({ x, y: 5, z: 4 }))
  f.host.shared.tunnelFloors.scopes[scope] = { floors: structuredClone(full) }
  assert.throws(() => f.observed.tunneling.onPreserveFloor({ x: 1024, y: 5, z: 4 }), /保存上限/)
  assert.deepEqual(f.observed.tunneling.getPreservedFloors(), full)
  assert.doesNotThrow(() => f.observed.tunneling.onPreserveFloor(full[0]), 'an existing receipt does not consume additional capacity')
  f.host.shared.tunnelFloors.scopes[scope] = { floors: null }
  assert.throws(() => f.observed.tunneling.getPreservedFloors(), /不正/)
})

test('runtime gives tunneling and internal resource observations a base-protected view while construction retains the raw world', async t => {
  const f = fixture(t)
  f.parsed.state.realm = { id: '42', name: 'test' }
  const wall = { x: -10, y: 67, z: 10 }
  const roof = { x: -9, y: 69, z: 11 }
  f.blocks.set('-10,67,10', { known: true, position: wall, name: 'minecraft:grass_block', properties: {}, runtimeId: 321, boundingBox: 'block', extra: [] })
  f.blocks.set('-9,69,11', { known: true, position: roof, name: 'minecraft:dirt', properties: {}, runtimeId: 123, boundingBox: 'block', extra: [] })
  f.host.shared.hutMemo = { version: 1, kind: 'soil_hut', established: true, scope: { realmId: '42', dimension: 'overworld' }, site: { type: 'soil_hut', center: { x: -9, y: 67, z: 11 }, forward: { x: 0, z: 1 } }, placements: [{ position: wall, item: 'minecraft:dirt', count: 1, serverConfirmed: true }] }
  const before = f.parsed.snapshot()
  assert.notEqual(f.observed.tunneling.world, f.host.world)
  assert.equal(f.observed.hut.world, f.host.world, 'own door reopening must retain raw construction access')
  assert.equal(f.observed.shelter.world, f.host.world)
  const protectedRoof = f.observed.tunneling.world.getBlock(roof.x, roof.y, roof.z)
  assert.equal(protectedRoof.protected, true)
  assert.equal(protectedRoof.protectionSource, 'bot_base')
  assert.equal(protectedRoof.runtimeId, 123)
  const observed = await f.observed.runner.request('GET', '/blocks?x=-10&y=67&z=10&radius=0')
  assert.equal(observed.blocks[0].protected, true)
  assert.equal(observed.blocks[0].name, 'minecraft:grass_block')
  assert.equal(observed.blocks[0].runtimeId, 321)
  assert.equal(f.blocks.get('-10,67,10').protected, undefined)
  assert.equal(f.observed.hut.world.getBlock(roof.x, roof.y, roof.z).protected, undefined)
  assert.deepEqual(f.observed.tunneling.world.getRawBlock(roof.x, roof.y, roof.z), f.host.world.getBlock(roof.x, roof.y, roof.z))
  assert.deepEqual(f.parsed.snapshot(), before)
  f.host.shared.hutMemo = { ...f.host.shared.hutMemo, placements: [] }
  assert.equal(f.observed.tunneling.world.getBlock(roof.x, roof.y, roof.z).protected, undefined)
  f.host.shared.hutMemo = { ...f.host.shared.hutMemo, placements: [{ position: wall, item: 'minecraft:dirt', count: 1, serverConfirmed: true }] }
  f.parsed.state.realm = { id: 'another-realm' }
  const wrongWorld = await f.observed.runner.request('GET', '/blocks?x=-10&y=67&z=10&radius=0')
  assert.equal(wrongWorld.blocks[0].protected, undefined)
})

test('confirmed tunnel floors decorate both planning reads and resource selection while Native standing and traversal stay physical', async t => {
  const f = fixture(t)
  f.parsed.state.realm = { id: '42', name: 'test' }
  f.runtime.onSpawn()
  f.blocks.delete('1,6,0')
  const floor = { x: 1, y: 5, z: 0 }, alternative = { x: 2, y: 6, z: 1 }
  f.blocks.set('2,6,1', { ...f.host.world.getBlock(2, 5, 1), position: alternative })
  const scope = JSON.stringify([f.parsed.state.profile, '42', 'overworld'])
  f.host.shared.tunnelFloors = { version: 1, scopes: { [scope]: { floors: [floor] } } }
  const view = f.observed.tunneling.world, before = structuredClone(f.host.shared.tunnelFloors)
  const decorated = view.getBlock(floor.x, floor.y, floor.z)
  assert.equal(decorated.protected, true); assert.equal(decorated.protectionSource, 'tunnel_floor')
  assert.equal(decorated.name, 'minecraft:stone'); assert.equal(decorated.boundingBox, 'block')
  assert.equal(f.host.world.getBlock(floor.x, floor.y, floor.z).protected, undefined)
  assert.equal(f.observed.hut.world.getBlock(floor.x, floor.y, floor.z).protected, undefined)
  const page = await f.observed.runner.request('GET', '/blocks?x=1&y=5&z=0&radius=3')
  assert.equal(page.blocks.find(b => b.position.x === 1 && b.position.y === 5 && b.position.z === 0).protectionSource, 'tunnel_floor')
  const { nextBootstrapAction } = require('../src/planner')
  const pointKey = p => `${p.x},${p.y},${p.z}`
  const candidates = page.blocks.map(b => b.name === 'minecraft:stone' && ![pointKey(floor), pointKey(alternative)].includes(pointKey(b.position)) ? { ...b, protected: true } : b)
  const item = { slot: 0, name: 'minecraft:stone_pickaxe', count: 1 }
  const state = { ...f.parsed.snapshot(), inventory: { known: true, items: [item] }, heldItem: item, selectedSlot: 0 }
  const options = { stoneCount: 1 }, capabilities = { break_block: true }
  const selected = nextBootstrapAction(state, { blocks: candidates, capabilities }, options)
  assert.equal(selected.type, 'mine_stone'); assert.deepEqual(selected.target, alternative)
  const unprotected = candidates.map(b => pointKey(b.position) === pointKey(floor) ? { ...b, protected: false, protectionSource: undefined } : b)
  assert.deepEqual(nextBootstrapAction(state, { blocks: unprotected, capabilities }, options).target, floor, 'negative control reproduces selection of the forbidden return floor')
  const physics = f.observed.movements.at(-1).options.physics.withWorld(view)
  const { createNavigator } = require('../src/navigation')
  const navigator = createNavigator({ world: view, physics, version: '1.26.60' }), initial = physics.fromServer(f.parsed.snapshot())
  assert.equal(navigator.verifyOrigin(initial), true)
  const route = navigator.plan(initial, { x: 2.5, y: 6, z: 0.5 }, { directFlat: true, exactGoal: true, maxDistance: 4 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial), frames = []
  for (let n = 0; n < 40; n++) { const frame = stepper.next(); frames.push(frame); if (frame.phase !== 'moving') break }
  assert.equal(frames.at(-1).phase, 'awaiting_server_confirmation')
  assert.ok(frames.every(frame => frame.predictedState.onGround))
  assert.deepEqual(f.host.shared.tunnelFloors, before, 'planning never mutates ownership receipts')
})

test('floor-view cache follows immutable receipt revisions and malformed or changing scope fails closed', async t => {
  const f = fixture(t)
  f.parsed.state.realm = { id: '42', name: 'test' }; f.runtime.onSpawn()
  const scope = JSON.stringify([f.parsed.state.profile, '42', 'overworld']), point = { x: 1, y: 5, z: 0 }
  f.host.shared.tunnelFloors = { version: 1, scopes: { [scope]: { floors: [point] } } }
  const view = f.observed.tunneling.world
  assert.equal(view.getBlock(1, 5, 0).protected, true)
  const full = Array.from({ length: 1024 }, (_, x) => ({ x, y: 5, z: 0 }))
  f.host.shared.tunnelFloors.scopes[scope] = { floors: full }
  assert.equal(view.getBlock(1, 5, 0).protected, true)
  const start = performance.now()
  for (let n = 0; n < 1000; n++) assert.equal(view.getBlock(1, 5, 0).protected, true)
  const elapsed = performance.now() - start
  assert.ok(elapsed < 150, 'cached 1024-floor reads must remain below the unchanged200ms input budget: ' + elapsed)
  t.diagnostic(`1000 planning reads with1024 validated floors: ${elapsed.toFixed(2)}ms`)
  for (const floors of [null, [{ x: 0.5, y: 5, z: 0 }], [{ x: 1, y: 400, z: 0 }]]) {
    f.host.shared.tunnelFloors.scopes[scope] = { floors }
    assert.throws(() => view.getBlock(1, 5, 0), /帰路の床/)
    await assert.rejects(async () => f.observed.runner.request('GET', '/blocks?x=1&y=5&z=0&radius=0'), /帰路の床/)
  }
  f.host.shared.tunnelFloors.scopes[scope] = { floors: [point] }
  f.parsed.state.realm = null
  assert.throws(() => view.getBlock(1, 5, 0), error => error.code === 'TUNNEL_FLOOR_SCOPE_UNKNOWN')
  f.parsed.state.realm = { id: '43' }
  assert.throws(() => view.getBlock(1, 5, 0), /ワールドが変わった/)
  f.runtime.onSpawn()
  assert.equal(f.observed.tunneling.world.getBlock(1, 5, 0).protected, undefined, 'another known Realm does not inherit old floors')
  assert.deepEqual(f.host.shared.tunnelFloors.scopes[scope].floors, [point])
})
