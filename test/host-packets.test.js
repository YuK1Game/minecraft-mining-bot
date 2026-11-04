'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHostPacketEvents, createHostPacketReceiver, startupFuseDanger, createStartupFuseGuard, requestStartupTerrain } = require('../src/host')
const { createState } = require('../src/state')
const { createEntities } = require('../src/entities')

function client () {
  const events = new EventEmitter()
  for (const method of ['queue', 'connect', 'close', 'disconnect']) events[method] = () => { throw new Error(`Passive tests cannot ${method}`) }
  return events
}

test('packet registrations queue before client creation, are passive and deduplicate core and newly added names', () => {
  const calls = []
  const router = createHostPacketEvents({ receive: (...args) => calls.push(args) })
  assert.deepEqual(router.registerPacketEvents(['start_game', 'inventory_slot']), ['start_game', 'inventory_slot'])
  assert.deepEqual(router.registerPacketEvents(['set_time', 'completed_using_item', 'set_time', 'inventory_slot']), ['set_time', 'completed_using_item'])
  assert.equal(calls.length, 0)
  const transport = client()
  router.attachClient(transport)
  router.attachClient(transport)
  assert.deepEqual(router.registerPacketEvents(['set_entity_motion', 'start_game']), ['set_entity_motion'])
  for (const name of router.snapshot().registered) {
    assert.equal(transport.listenerCount(name), 1)
    transport.emit(name, { event: name })
  }
  assert.equal(calls.length, 5)
  assert.equal(calls.filter(([name]) => name === 'inventory_slot').length, 1)
  const snapshot = router.snapshot(); snapshot.registered.push('injected')
  assert.equal(router.snapshot().registered.includes('injected'), false)
  router.dispose()
  assert.ok(transport.eventNames().length === 0)
})

test('the stable receiver uses the current runtime, retains no disposed callback and detaches an old event client', () => {
  const deliveries = []
  let current = { applyPacket: name => deliveries.push(`first:${name}`) }
  const router = createHostPacketEvents({ receive: (name, packet) => current?.applyPacket(name, packet) })
  router.registerPacketEvents(['set_time'])
  const first = client(); const second = client()
  router.attachClient(first)
  first.emit('set_time', { time: 1 })
  current = null
  first.emit('set_time', { time: 2 })
  current = { applyPacket: name => deliveries.push(`second:${name}`) }
  router.registerPacketEvents(['set_time', 'completed_using_item'])
  first.emit('set_time', { time: 3 })
  assert.deepEqual(deliveries, ['first:set_time', 'second:set_time'])
  assert.equal(first.listenerCount('set_time'), 1)
  router.attachClient(second)
  assert.equal(first.listenerCount('set_time'), 0)
  first.emit('set_time', {})
  second.emit('completed_using_item', {})
  assert.equal(deliveries.at(-1), 'second:completed_using_item')
  router.dispose()
  second.emit('set_time', {})
  assert.equal(second.eventNames().length, 0)
  assert.throws(() => router.registerPacketEvents(['set_time']), /disposed/)
})

test('invalid batches make no partial subscriptions and receiver errors use the stable error handler once', () => {
  const errors = []
  const router = createHostPacketEvents({ receive: () => { throw new Error('current runtime failure') }, onError: error => errors.push(error.message) })
  for (const names of [['set_time', 'error'], ['set_time', '../bad'], ['set_time', null], 'set_time']) assert.throws(() => router.registerPacketEvents(names))
  assert.equal(router.snapshot().registered.length, 0)
  const transport = client()
  router.attachClient(transport)
  router.registerPacketEvents(['set_time'])
  transport.emit('set_time', {})
  assert.deepEqual(errors, ['current runtime failure'])
  assert.equal(transport.listenerCount('set_time'), 1)
  router.dispose()
})

const game = () => ({ runtime_entity_id: 41n, entity_id: 9n, dimension: 'overworld', player_gamemode: 'survival', world_gamemode: 'survival', player_position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { x: 0, z: 0 }, current_tick: 1000n })

test('startup terrain requests only use valid received position and already-announced sections', () => {
  const state = { phase: 'joined', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 } }
  const shared = { safetyWanted: true, loadingScreenEnded: false }
  const requests = []
  const world = { buildSubchunkRequest: point => ({ origin: point, requests: [{ x: 0, y: 0, z: 0 }] }) }
  const call = () => requestStartupTerrain({ state, shared, world, queue: (name, packet) => requests.push({ name, packet }), version: '1.26.60' })
  assert.equal(call(), true)
  assert.equal(requests[0].name, 'subchunk_request')
  assert.deepEqual(requests[0].packet.origin, state.position)
  state.spawnPending = true; assert.equal(call(), false); state.spawnPending = false
  state.position.y = 32769; assert.equal(call(), false); state.position.y = 66.62
  shared.loadingScreenEnded = true; assert.equal(call(), false); shared.loadingScreenEnded = false
  shared.safetyWanted = false; assert.equal(call(), false); shared.safetyWanted = true
  state.phase = 'spawned'; assert.equal(call(), false)
  assert.equal(requests.length, 1)
})

test('loading protection detects an active creeper fuse using received identity and position only', () => {
  const { state, applyPacket } = createState('startup')
  const entities = createEntities(); const shared = { safetyWanted: true, loadingScreenEnded: false }
  const deliver = (name, packet) => { applyPacket(name, packet); entities.applyPacket(name, packet) }
  state.phase = 'joined'; deliver('start_game', game())
  deliver('add_entity', { entity_type: 'minecraft:creeper', runtime_id: 13n, unique_id: 3n, position: { x: 3, y: 65, z: 0.5 }, metadata: [{ key: 'flags', value: { ignited: false, powered: false, charged: false } }, { key: 'fuse_length', value: -1 }] })
  const danger = () => startupFuseDanger(state, shared, entities.snapshot({ kind: 'all' }))
  assert.equal(danger(), null)
  deliver('set_entity_data', { runtime_entity_id: 13n, tick: 0n, metadata: [{ key: 'fuse_length', value: 27 }] })
  assert.equal(danger().runtimeId, '13')
  assert.equal(danger().fuseLength, 27)
  shared.safetyWanted = false; assert.equal(danger(), null); shared.safetyWanted = true
  shared.loadingScreenEnded = true; assert.equal(danger(), null); shared.loadingScreenEnded = false
  state.position.y = 32769; assert.equal(danger(), null)
  state.position = { x: 100, y: 66.62, z: 0.5 }; assert.equal(danger(), null)
  state.position = { x: 0.5, y: 66.62, z: 0.5 }; state.dimension = 'nether'; assert.equal(danger(), null)
  state.dimension = 'overworld'; state.dead = true; assert.equal(danger(), null)
})

test('startup fuse online notification is deferred, deduplicated and revoked when the observed condition changes', () => {
  for (const mode of ['notify', 'disabled', 'loaded', 'disarmed', 'replaced', 'new_epoch', 'closing']) {
    const state = { phase: 'joined', runtimeEntityId: '1', dimension: 'overworld', position: { x: 0, y: 66, z: 0 } }
    const shared = { safetyWanted: true, loadingScreenEnded: false, safetyEnableEpoch: 1 }
    const actors = [{ runtimeId: '2', uniqueId: '3', entityType: 'minecraft:creeper', hostile: true, alive: true, primed: true, positionKnown: true, dimension: 'overworld', position: { x: 3, y: 65, z: 0 }, fuseLength: 27 }]
    let closing = false; let notifications = 0; let stops = 0; const queue = []
    const guard = createStartupFuseGuard({ getState: () => state, getShared: () => shared, getActors: () => actors, isStopping: () => closing, onDanger: () => { notifications++ }, stop: () => { stops++ }, schedule: callback => queue.push(callback) })
    guard.observe(); guard.observe()
    assert.equal(queue.length, 1, mode)
    if (mode === 'disabled') shared.safetyWanted = false
    if (mode === 'loaded') shared.loadingScreenEnded = true
    if (mode === 'disarmed') actors[0].primed = false
    if (mode === 'replaced') actors[0].uniqueId = '4'
    if (mode === 'new_epoch') shared.safetyEnableEpoch++
    if (mode === 'closing') closing = true
    queue[0]()
    assert.equal(notifications, mode === 'notify' ? 1 : 0, mode)
    assert.equal(stops, 0, mode)
    if (mode === 'notify') { guard.observe(); assert.equal(queue.length, 1, 'a still-lit fuse is reported only once') }
  }
})
const correction = (changes = {}) => ({ prediction_type: 'player', position: { x: 2.5, y: 70.62, z: 3.5 }, delta: { x: 0.1, y: -0.2, z: 0.3 }, on_ground: false, tick: 100n, ...changes })
function fixture () {
  const { state, applyPacket, snapshot } = createState('offline-packet-test')
  state.phase = 'spawned'; state.health = 20
  const shared = { loadingScreenEnded: true, prediction: null, motionSource: null, equipment: null, lastPhysicsCorrectionTick: '9000' }
  const meta = { version: '1.26.60' }
  const calls = []
  let current = { applyPacket: (name, packet) => calls.push({ module: 'runtime_first', name, packet }), stopActions: reason => calls.push({ module: 'stop', reason }) }
  const receiver = createHostPacketReceiver({ state, shared, meta, cache: { observe: name => calls.push({ module: 'cache', name }) }, applyState: (name, packet) => { calls.push({ module: 'state', name }); applyPacket(name, packet) }, world: { applyPacket: name => calls.push({ module: 'world', name }) }, entities: { applyPacket: name => calls.push({ module: 'entities', name }) }, getLifecycle: () => ({ applyPacket: name => calls.push({ module: 'lifecycle', name }) }), getCurrent: () => current, clock: () => 1234 })
  receiver.receive('start_game', game())
  calls.splice(0)
  const prediction = () => { shared.prediction = { position: { x: 50, y: 80, z: 50 }, marker: 'keep me if rejected' }; shared.motionSource = 'navigation' }
  prediction()
  return { receiver, state, shared, meta, calls, snapshot, prediction, replace: () => { current = { applyPacket: name => calls.push({ module: 'runtime_second', name }), stopActions: () => {} } } }
}

test('the real host pipeline gates vehicle, invalid and duplicate corrections before raw state, prediction or module delivery', () => {
  const f = fixture()
  const raw = f.snapshot()
  const prediction = structuredClone(f.shared.prediction)
  for (const packet of [correction({ prediction_type: 'vehicle' }), correction({ prediction_type: 99 }), correction({ position: { x: NaN, y: 1, z: 2 } }), correction({ delta: { x: 0, y: Infinity, z: 0 } }), correction({ on_ground: 1 }), correction({ tick: -1n }), correction({ tick: 1n << 64n })]) {
    assert.equal(f.receiver.receive('correct_player_move_prediction', packet).accepted, false)
    assert.deepEqual(f.snapshot(), raw)
    assert.deepEqual(f.shared.prediction, prediction)
    assert.equal(f.shared.motionSource, 'navigation')
    assert.equal(f.calls.length, 0)
  }
  assert.equal(f.receiver.snapshot().lastCorrectionTick, null)
  const accepted = f.receiver.receive('correct_player_move_prediction', correction())
  assert.equal(accepted.accepted, true)
  assert.deepEqual(f.state.position, correction().position)
  assert.equal(f.shared.prediction, null)
  assert.equal(f.shared.motionSource, null)
  assert.deepEqual(f.calls.map(call => call.module), ['cache', 'state', 'world', 'entities', 'lifecycle', 'runtime_first'])
  f.calls.splice(0); f.prediction()
  const actual = f.snapshot()
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction()).code, 'STALE_CORRECTION')
  assert.deepEqual(f.snapshot(), actual)
  assert.ok(f.shared.prediction)
  assert.equal(f.calls.length, 0)
})

test('integer health packets do not invent healing above a matching precise attribute', () => {
  const f = fixture()
  const attribute = value => ({ runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: value }] })
  f.receiver.receive('update_attributes', attribute(9.631)); f.calls.splice(0)
  f.receiver.receive('set_health', { health: 10 })
  assert.equal(f.state.health, 9.631)
  assert.equal(f.state.healthSource, 'update_attributes')
  f.receiver.receive('update_attributes', attribute(9.631))
  assert.equal(f.calls.some(call => call.module === 'stop'), false)
  f.receiver.receive('update_attributes', attribute(9.5))
  assert.equal(f.state.health, 9.5)
  assert.equal(f.calls.filter(call => call.module === 'stop').length, 1, 'real precise decrease must stop active work')
  f.calls.splice(0); f.receiver.receive('set_health', { health: 9 })
  assert.equal(f.state.health, 9)
  assert.equal(f.state.healthSource, 'set_health')
  assert.equal(f.calls.filter(call => call.module === 'stop').length, 1, 'a lower integer remains a real decrease')
})

test('tick zero cannot lower the host high-water mark and runtime replacement or shared helper edits cannot reset it', () => {
  const f = fixture()
  f.receiver.receive('correct_player_move_prediction', correction({ tick: 500n }))
  f.replace()
  f.shared.lastPhysicsCorrectionTick = '0'
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 400n })).code, 'STALE_CORRECTION')
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 0n, position: { x: 8, y: 75, z: 9 } })).accepted, true)
  assert.equal(f.receiver.snapshot().lastCorrectionTick, '500')
  f.shared.lastPhysicsCorrectionTick = '9999999999999999'
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 499n })).code, 'STALE_CORRECTION')
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 501n })).accepted, true)
  assert.equal(f.calls.at(-1).module, 'runtime_second')
  assert.equal(f.shared.lastPhysicsCorrectionTick, '9999999999999999')
})

test('only a new start_game epoch resets correction order, while dimension, respawn and other actors cannot do so', () => {
  const f = fixture()
  f.receiver.receive('correct_player_move_prediction', correction({ tick: 500n }))
  f.receiver.receive('change_dimension', { dimension: 1, position: { x: 0, y: 75, z: 0 } })
  f.prediction()
  const before = structuredClone(f.shared.prediction)
  f.receiver.receive('respawn', { runtime_entity_id: 99n, state: 1, position: { x: 9, y: 90, z: 9 } })
  assert.deepEqual(f.shared.prediction, before)
  assert.equal(f.receiver.snapshot().lastCorrectionTick, '500')
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 10n })).code, 'STALE_CORRECTION')
  f.receiver.receive('start_game', game())
  assert.equal(f.receiver.snapshot().lastCorrectionTick, null)
  assert.equal(f.receiver.receive('correct_player_move_prediction', correction({ tick: 2n })).accepted, true)
  assert.equal(f.receiver.snapshot().lastCorrectionTick, '2')
  assert.equal(f.meta.startGameReceivedAt, 1234)
})

test('dynamically registered packets still pass the connection pipeline once and reach the latest runtime', () => {
  const f = fixture()
  const router = createHostPacketEvents({ receive: f.receiver.receive })
  router.registerPacketEvents(['inventory_slot', 'completed_using_item'])
  const transport = client()
  router.attachClient(transport)
  router.registerPacketEvents(['inventory_slot', 'set_entity_motion'])
  f.replace()
  transport.emit('set_entity_motion', { runtime_entity_id: 123n, velocity: { x: 0, y: -0.1, z: 0 } })
  assert.equal(f.calls.filter(call => call.module === 'runtime_second').length, 1)
  assert.equal(f.calls.filter(call => call.module === 'entities').length, 1)
  assert.ok(f.calls.every(call => call.name === 'set_entity_motion'))
  router.dispose()
})
