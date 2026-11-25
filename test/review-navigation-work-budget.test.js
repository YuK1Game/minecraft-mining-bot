'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createWorld } = require('../src/host/world')
const { createNavigator } = require('../src/movement/navigation')
const { createMovement } = require('../src/movement/movement')
const { cooperativeMovement } = require('../src/movement/cooperative-movement')
const registry = require('prismarine-registry')('bedrock_1.26.60')

function scene () {
  const blocksByRuntimeId = Object.fromEntries(['air', 'stone'].map((name, index) => [index, { ...registry.blocksByName[name], stateId: registry.blocksByName[name].minStateId }]))
  const world = createWorld({ maxSections: 128, registry: { blocksByRuntimeId, blockStates: registry.blockStates, handleStartGame () {} } })
  world.applyPacket('start_game', { dimension: 'overworld' })
  const section = (x, y, z, id = 0) => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from([9, 1, y & 255, 1, id * 2]) }] })
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) { section(x, 3, z, 1); section(x, 4, z) }
  const block = (x, y, z, id) => world.applyPacket('update_block', { position: { x, y, z }, block_runtime_id: id, layer: 0 })
  const state = { phase: 'spawned', profile: 'offline', realm: { id: 'test' }, connectionId: 'connection', startedAt: '2026-11-20T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 }, dimension: 'overworld', health: 20, gameMode: 'survival', positionUpdatedAt: 'received', position: { x: 0.5, y: 65.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 } }
  let reads = 0
  const getBlock = world.getBlock
  world.getBlock = (...args) => { reads++; return getBlock(...args) }
  const navigator = createNavigator({ world }), initial = navigator.physics.fromServer(state)
  const packets = []
  const movement = createMovement({ client: { queue: (name, packet) => { packets.push({ name, packet }); return { tick: packet.tick } } }, getState: () => structuredClone(state), world, physics: navigator.physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => 1000 })
  return { world, section, block, state, navigator, initial, movement, packets, reads: () => reads }
}
const target = { x: 10.5, y: 64, z: 0.5 }

test('ordinary synchronous planning has a time bound and cooperative planning keeps the 24-block limit', async t => {
  const f = scene(); let ticks = 0
  t.mock.method(performance, 'now', () => { ticks += 121; return ticks })
  const bounded = f.navigator.plan(f.initial, target)
  assert.equal(bounded.code, 'NAVIGATION_TIME_LIMIT')
  assert.equal(bounded.ready, false)
  assert.equal(f.packets.length, 0)
})

test('ordinary native planning yields repeatedly and a stopped pending preparation cannot queue input', async t => {
  const f = scene()
  for (let z = -8; z <= 8; z++) for (let y = 64; y < 68; y++) f.block(6, y, z, 1)
  let ticks = 0, turns = 0, running = true
  t.mock.method(performance, 'now', () => { ticks += 0.05; return ticks })
  const pulse = () => { if (running) { turns++; setImmediate(pulse) } }
  setImmediate(pulse)
  try {
    const route = await f.movement.previewAsync({ x: 20.5, y: 64, z: 0.5 }, { maxDistance: 24, maxExpanded: 5000 })
    assert.equal(route.ready, true, route.reason)
    assert.ok(turns > 1, 'the real ordinary planner releases the event loop between node batches')
    assert.notEqual(route.planningOnly, true)
    assert.equal(f.packets.length, 0)
    const pending = f.movement.previewAsync({ x: 0.5, y: 64, z: 10.5 }, { maxDistance: 24 })
    f.movement.stop('owner cancelled during planning')
    await assert.rejects(pending, { code: 'NAVIGATION_CONTEXT_CHANGED' })
    assert.equal(f.packets.length, 0)
  } finally { running = false; f.movement.stop() }
})

test('navigation geometry survives unrelated real packets and cached reads retain their dependency witness', () => {
  const f = scene(), options = { maxDistance: 12 }
  assert.equal(f.navigator.plan(f.initial, target, options).ready, true)
  const first = f.reads()
  f.navigator.plan(f.initial, target, options)
  const same = f.reads() - first
  f.world.applyPacket('block_entity_data', { position: { x: 1000, y: 64, z: 1000 } })
  f.section(100, 4, 100)
  const before = f.reads(), witness = f.world.observeTerrain()
  assert.equal(witness.run(() => f.navigator.plan(f.initial, target, options)).ready, true)
  assert.equal(f.reads() - before, same, 'unrelated global revisions do not decode the route geometry again')
  assert.ok(first > same * 3)
  f.block(1, 64, 0, 1)
  assert.equal(witness.current(), false, 'the outer witness includes the original cached block reads')
  const changed = f.reads()
  f.navigator.plan(f.initial, target, options)
  assert.ok(f.reads() - changed > same)
})

test('async preview is reused by the real start without a second A* search or accepting mutated preview data', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const spans = require('../src/common/work-spans'), wrap = spans.wrap
  let synchronousPlans = 0
  t.mock.method(spans, 'wrap', (name, fn) => wrap(name, (...args) => { if (name === 'navigation.plan') synchronousPlans++; return fn(...args) }))
  const f = scene(), preview = await f.movement.previewAsync(target)
  assert.equal(preview.ready, true)
  preview.target.x = 999; preview.waypoints.length = 0
  f.world.applyPacket('block_entity_data', { position: { x: 1000, y: 64, z: 1000 } })
  f.section(100, 4, 100)
  const started = f.movement.startPrepared(target)
  assert.equal(synchronousPlans, 0)
  assert.equal(started.phase, 'moving')
  assert.equal(started.route.target.x, target.x)
  assert.ok(started.route.waypoints.length > 0)
  assert.equal(f.packets.length, 1)
  assert.equal(started.serverConfirmed, false)
  f.movement.stop()
})

test('a warm prepared route still calls the caller guard and rejects it before the activation boundary', async () => {
  const f = scene(); let guards = 0, activations = 0
  const bridge = cooperativeMovement({ start: (where, options) => { activations++; return f.movement.start(where, options) } }, { movement: f.movement, prepare () {}, check () {} })
  assert.equal((await bridge.previewAsync(target)).ready, true)
  await assert.rejects(bridge.startAsync(target, { check: () => { guards++; return false } }), { code: 'NAVIGATION_CONTEXT_CHANGED' })
  assert.ok(guards > 0)
  assert.equal(activations, 0); assert.equal(f.packets.length, 0)
  let allowed = true
  const pending = f.movement.startAsync(target, { check: () => allowed })
  allowed = false
  await assert.rejects(pending, { code: 'NAVIGATION_CONTEXT_CHANGED' })
  assert.equal(f.packets.length, 0, 'a cache hit does not hide the guard change at the await boundary')
})

test('separate async plans reuse section geometry and still fence changes through the outer observer', async () => {
  const f = scene(), next = { x: 9.5, y: 64, z: 0.5 }
  await f.navigator.planAsync(f.initial, target)
  const before = f.reads()
  f.world.applyPacket('block_entity_data', { position: { x: 1000, y: 64, z: 1000 } })
  f.section(100, 4, 100)
  const witness = f.world.observeTerrain()
  assert.equal((await f.navigator.planAsync(f.initial, next, { observe: witness })).ready, true)
  assert.ok(f.reads() - before < 20, 'the production async path keeps earlier decoded geometry')
  f.block(2, 64, 0, 1)
  assert.equal(witness.current(), false)
})

test('prepared bridge activation cannot substitute a new detour after a caller validated the preview', async () => {
  const f = scene(), bridge = cooperativeMovement({ start: (where, options) => f.movement.start(where, options) }, { movement: f.movement, prepare () {}, check () {} })
  const validated = await bridge.previewAsync(target)
  assert.equal(validated.ready, true)
  assert.ok(validated.waypoints.every(point => point.position.z === 0.5))
  for (let z = -1; z <= 1; z++) for (let y = 64; y <= 66; y++) f.block(4, y, z, 1)
  assert.throws(() => bridge.startPrepared(target), { code: 'NAVIGATION_CONTEXT_CHANGED' })
  assert.equal(f.packets.length, 0)
  const replanned = await bridge.previewAsync(target)
  assert.equal(replanned.ready, true)
  assert.ok(replanned.waypoints.some(point => point.position.z !== 0.5), 'a new route requires a new caller safety validation')
})

for (const mode of ['terrain', 'life', 'position', 'velocity', 'health', 'avoidance', 'reader', 'expired']) test(`prepared route refuses changed ${mode} before sending`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = scene(), options = {}
  assert.equal((await f.movement.previewAsync(target, options)).ready, true)
  if (mode === 'terrain') f.block(4, 64, 0, 1)
  if (mode === 'life') f.state.lifecycle.deathId++
  if (mode === 'position') f.state.position.x += 0.1
  if (mode === 'velocity') {
    f.state.positionSource = 'client_prediction'
    f.state.predicted = { position: { ...f.state.position }, physicsState: { ...f.initial, velocity: { x: 0.1, y: 0, z: 0 } } }
  }
  if (mode === 'health') f.state.health--
  if (mode === 'avoidance') options.avoidance = [{ id: 'new-enemy', position: { x: 5.5, y: 65.62, z: 0.5 }, minDistance: 3 }]
  if (mode === 'reader') { const read = f.world.getBlock; f.world.getBlock = (...args) => read(...args) }
  if (mode === 'expired') { const later = performance.now() + 501; t.mock.method(performance, 'now', () => later) }
  assert.throws(() => f.movement.startPrepared(target, options), { code: 'NAVIGATION_CONTEXT_CHANGED' })
  assert.equal(f.packets.length, 0)
})

test('the cooperative production bridge rechecks ownership after preview and preserves the final live frame guard', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = scene(); let owned = true, activated = 0
  const ports = cooperativeMovement({ start: (where, options) => { activated++; return f.movement.start(where, options) } }, { movement: f.movement, prepare () {}, check: () => { if (!owned) throw new Error('COMBAT_PRIORITY') } })
  const pending = ports.startAsync(target)
  owned = false
  await assert.rejects(pending, /COMBAT_PRIORITY/)
  assert.equal(activated, 0); assert.equal(f.packets.length, 0)
  owned = true
  const started = await ports.startAsync(target, { beforeInput: () => false })
  assert.equal(activated, 1)
  assert.equal(started.phase, 'failed')
  assert.equal(f.packets.length, 0, 'reuse never bypasses the current actor/input guard')
})
