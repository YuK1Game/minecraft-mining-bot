'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createRuntime } = (() => {
  if (!process.env.RUNTIME_TEST_SOURCE) return require('../src/runtime')
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
  const filename = path.resolve(__dirname, '../src/runtime.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(path.resolve(process.env.RUNTIME_TEST_SOURCE), 'utf8'), filename)
  return loaded.exports
})()
const { createSessionCache } = require('../src/session-cache')

const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
function fixture (t) {
  let time = 1000
  let lastTick = -1n
  t.mock.timers.enable({ apis: ['setInterval'] })
  t.mock.method(performance, 'now', () => time)
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Physics integration tests must not use HTTP') })
  const packets = []
  const predictions = []
  const connections = []
  const instances = []
  const raw = { phase: 'spawned', health: 20, dead: false, gameMode: 'survival', dimension: 'overworld', runtimeEntityId: '41', version: '1.26.60', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: '2026-10-31T00:00:00.000Z', rotation: { pitch: 17, yaw: 73 }, selectedSlot: 0, inventory: { known: true, items: [] }, capabilities: {} }
  const game = { current_tick: 1000n, runtime_entity_id: 41n, player_position: { ...raw.position }, rotation: { x: 17, z: 73 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  const cache = createSessionCache()
  cache.observe('start_game', game)
  cache.observe('item_registry', { itemstates: [] })
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty) })
  cache.observe('player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true })
  const shared = { loadingScreenEnded: true, autoWanted: false, autoOptions: {}, prediction: null, motionSource: null, equipment: null }
  const host = {
    client: { queue: (name, data) => {
      const params = structuredClone(data)
      if (name === 'player_auth_input') { if (params.tick <= lastTick) params.tick = lastTick + 1n; lastTick = params.tick }
      packets.push({ name, params })
      return name === 'player_auth_input' ? { tick: params.tick } : undefined
    }, close: () => connections.push('close'), disconnect: () => connections.push('disconnect'), connect: () => connections.push('connect') },
    cache, shared, meta: { version: '1.26.60', startGame: game, startGameReceivedAt: time },
    apiUrl: 'http://127.0.0.1:49999',
    world: { getBlock: (x, y, z) => ({ known: true, name: y <= 64 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y <= 64 ? 'block' : 'empty', position: { x, y, z }, runtimeId: y <= 64 ? 1 : 0, properties: {}, extra: [] }), stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 27 }) },
    entities: { snapshot: () => [], nearby: () => [] },
    getServerState: () => structuredClone(raw),
    getState: () => {
      const result = structuredClone(raw)
      result.rawServerPosition = structuredClone(raw.position)
      result.rawServerPositionUpdatedAt = raw.positionUpdatedAt
      result.rawSelectedSlot = raw.selectedSlot
      if (shared.prediction) {
        result.position = structuredClone(shared.prediction.position)
        result.positionSource = 'client_prediction'
        result.positionServerConfirmed = false
        result.positionUpdatedAt = shared.prediction.updatedAt
        result.predicted = structuredClone(shared.prediction)
      }
      return result
    },
    setPrediction: (value, source) => {
      shared.motionSource = source
      shared.prediction = { ...structuredClone(value), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date().toISOString() }
      predictions.push({ source, value: structuredClone(shared.prediction) })
    },
    setCapabilities: values => Object.assign(raw.capabilities, values),
    setEquipmentPrediction: () => { throw new Error('No equipment request is allowed in physics tests') },
    allocate: () => { throw new Error('No item transaction is allowed in physics tests') },
    commitInventory: () => { throw new Error('Physics cannot change observed inventory') },
    log: () => {}, noteProgress: () => {}
  }
  const create = () => { const value = createRuntime(host); instances.push(value); return value }
  const advance = milliseconds => {
    assert.equal(milliseconds % 50, 0)
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) { time += 50; t.mock.timers.tick(50) }
  }
  function receivePlayer (runtime, packet) {
    // Only this explicit received-player path updates raw server observations.
    // Tests of Runtime's vehicle/stale gate below do not fabricate a raw event.
    raw.position = structuredClone(packet.position)
    raw.positionSource = 'correct_player_move_prediction'
    raw.positionUpdatedAt = new Date(Date.parse('2026-10-31T00:00:00.000Z') + time).toISOString()
    shared.prediction = null; shared.motionSource = null
    runtime.applyPacket('correct_player_move_prediction', structuredClone(packet))
  }
  t.after(async () => { for (const runtime of instances) await runtime.dispose('test_cleanup') })
  return { host, raw, shared, packets, predictions, connections, create, advance, receivePlayer }
}
const inputs = f => f.packets.filter(packet => packet.name === 'player_auth_input')
const correction = (overrides = {}) => ({ prediction_type: 'player', position: { x: 0.5, y: 70.62, z: 0.5 }, delta: { x: 0.08, y: 0.33, z: -0.04 }, on_ground: false, tick: 1002n, rotation: { x: 0, z: 0 }, ...overrides })

test('runtime retains the corrected present prediction after historical input replay', t => {
  const f = fixture(t); f.raw.connectionId = 'runtime-replay'
  const runtime = f.create()
  runtime.resumeRequested(); f.advance(50)
  runtime.operations.movement.start({ x: 7.5, y: 65, z: 0.5 })
  f.advance(200)
  const movement = f.predictions.filter(value => value.source === 'navigation')
  const historical = movement[1].value; const present = movement.at(-1).value
  const count = inputs(f).length
  const packet = correction({ position: historical.position, delta: historical.velocity, on_ground: historical.onGround, tick: BigInt(historical.tick) })
  f.receivePlayer(runtime, packet)
  assert.equal(runtime.snapshot().movement.inputReplay.accepted, true)
  assert.equal(runtime.snapshot().lastServerCorrection.reconciliation, 'rewind_replay')
  assert.deepEqual(f.raw.position, historical.position)
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(f.shared.prediction.position[axis] - present.position[axis]) < 1e-6, axis)
  assert.notDeepEqual(f.shared.prediction.position, historical.position)
  assert.equal(inputs(f).length, count)
  assert.equal(f.shared.prediction.serverConfirmed, false)
})

test('real runtime seeds the received jump velocity into the next neutral 20Hz frame without rewriting raw pose', t => {
  const f = fixture(t)
  const runtime = f.create()
  assert.equal(f.packets.length, 0)
  runtime.resumeRequested(); f.advance(50)
  const packet = correction()
  const beforePackets = inputs(f).length
  f.receivePlayer(runtime, packet)
  const rawReceived = structuredClone(f.raw)
  const rebased = f.predictions.at(-1)
  assert.equal(rebased.source, 'server_physics_rebase')
  assert.deepEqual(rebased.value.position, packet.position)
  assert.deepEqual(rebased.value.velocity, packet.delta)
  assert.equal(rebased.value.onGround, false)
  assert.equal(rebased.value.physicsState.onGround, false)
  assert.equal(rebased.value.physicsState.velocitySource, 'supplied')
  assert.equal(rebased.value.serverCorrection.reconciliation, 'immediate_without_history')
  assert.equal(rebased.value.serverCorrection.temporalScope, 'packet_tick')
  assert.equal(rebased.value.serverCorrection.tick, '1002')
  assert.equal(inputs(f).length, beforePackets, 'receiving a correction itself must not send input')
  f.advance(50)
  const next = inputs(f).at(-1).params
  assert.equal(inputs(f).length, beforePackets + 1)
  assert.ok(next.position.y > packet.position.y, 'the supplied upward motion must survive instead of falling from a zero seed')
  assert.ok(next.delta.y > 0.1)
  assert.ok(next.delta.x > 0 && next.delta.z < 0)
  assert.equal(f.shared.prediction.physicsState.onGround, false)
  assert.notEqual(f.shared.prediction.physicsState.velocitySource, 'model-initialized')
  assert.deepEqual(f.raw, rawReceived)
  assert.equal(next.pitch, 17)
  assert.equal(next.yaw, 73)
  assert.deepEqual(f.connections, [])
  assert.ok(f.packets.every(packet => packet.name === 'player_auth_input'))
})

test('a descending correction retains its downward motion rather than reinitializing airborne velocity to zero', t => {
  const f = fixture(t)
  const runtime = f.create()
  const packet = correction({ delta: { x: 0.02, y: -0.35, z: 0.01 } })
  f.receivePlayer(runtime, packet)
  assert.equal(f.packets.length, 0, 'passive construction and correction handling send nothing')
  runtime.resumeRequested()
  const first = inputs(f).at(-1).params
  assert.ok(first.position.y < packet.position.y - 0.2)
  assert.ok(first.delta.y < -0.3)
  assert.deepEqual(f.raw.position, packet.position)
  assert.deepEqual(f.raw.rotation, { pitch: 17, yaw: 73 })
})

test('Runtime ignores a vehicle or stale correction seed and leaves the current accepted player seed intact', t => {
  const f = fixture(t)
  const runtime = f.create()
  f.receivePlayer(runtime, correction())
  const accepted = structuredClone(f.shared.prediction)
  const raw = structuredClone(f.raw)
  const publications = f.predictions.length
  for (const packet of [correction({ prediction_type: 'vehicle', position: { x: 999, y: 999, z: 999 }, tick: 1003n }), correction({ tick: 1001n }), correction({ tick: 1002n }), correction({ delta: { x: 0, y: NaN, z: 0 }, tick: 1003n })]) {
    runtime.applyPacket('correct_player_move_prediction', packet)
    assert.deepEqual(f.shared.prediction, accepted)
    assert.deepEqual(f.raw, raw)
  }
  assert.equal(f.predictions.length, publications)
  assert.equal(f.shared.lastPhysicsCorrectionTick, '1002')
  assert.equal(f.packets.length, 0)
})

test('same-connection onSpawn preserves tick ordering and accepts the next new correction without a stale physics seed', t => {
  const f = fixture(t)
  const runtime = f.create()
  runtime.resumeRequested(); f.advance(50)
  f.receivePlayer(runtime, correction())
  f.advance(50)
  const previousTick = inputs(f).at(-1).params.tick
  runtime.onSpawn()
  assert.equal(f.shared.lastPhysicsCorrectionTick, '1002')
  runtime.resumeRequested()
  f.advance(50)
  assert.ok(inputs(f).at(-1).params.tick > previousTick)
  const next = correction({ tick: inputs(f).at(-1).params.tick, delta: { x: 0, y: 0.2, z: 0 } })
  f.receivePlayer(runtime, next)
  assert.equal(f.shared.lastPhysicsCorrectionTick, String(next.tick))
  assert.deepEqual(f.shared.prediction.velocity, next.delta)
  assert.deepEqual(f.connections, [])
})

test('hot reload keeps the correction seed in the stable host and never revives an old sender', async t => {
  const f = fixture(t)
  const first = f.create()
  f.receivePlayer(first, correction())
  await first.dispose('hot_reload')
  const sent = f.packets.length
  const second = f.create()
  assert.equal(f.packets.length, sent)
  assert.equal(f.shared.lastPhysicsCorrectionTick, '1002')
  second.resumeRequested()
  const initial = inputs(f).at(-1).params
  assert.ok(initial.delta.y > 0.1)
  assert.ok(initial.position.y > 70.62)
  const afterResume = inputs(f).length
  f.advance(150)
  assert.equal(inputs(f).length - afterResume, 3)
  assert.deepEqual(f.raw.position, correction().position)
  assert.deepEqual(f.connections, [])
})

test('confirmed respawn pauses idle input, discards ocean physics and preserves same-connection tick ordering', async t => {
  const f = fixture(t); const runtime = f.create()
  runtime.resumeRequested(); f.advance(50)
  f.receivePlayer(runtime, correction())
  runtime.applyPacket('set_entity_motion', { runtime_entity_id: 41n, velocity: { x: 0.3, y: 0.4, z: -0.2 }, tick: 1003n })
  f.advance(50)
  const previousTick = inputs(f).at(-1).params.tick
  f.raw.position = { x: -16.5, y: 66.62, z: 21.5 }
  f.raw.positionSource = 'server_post_move'; f.raw.positionUpdatedAt = 'new-respawn'
  f.shared.respawnTerrain = { pending: true }
  await runtime.onRespawn({ serverConfirmed: true, position: f.raw.position, deathId: 1 })
  assert.equal(f.shared.prediction, null)
  assert.equal(f.shared.lastServerMotion, null)
  assert.equal(f.shared.lastServerCorrection, null)
  assert.equal(f.shared.lastPhysicsCorrectionTick, '1002')
  assert.equal(f.shared.lastMotionTick, '1003')
  const count = inputs(f).length
  const read = f.host.world.getBlock
  f.host.world.getBlock = () => { throw new Error('Destination terrain has not arrived') }
  runtime.resumeRequested(); f.advance(150)
  assert.equal(inputs(f).length, count)
  assert.throws(() => runtime.operations.movement.start({ x: -15.5, y: 65, z: 21.5 }), /リスポーン先/)
  f.host.world.getBlock = read
  f.shared.respawnTerrain.pending = false
  runtime.resumeRequested(); f.advance(50)
  const next = inputs(f).slice(count)
  assert.ok(next.length > 0)
  assert.ok(next[0].params.tick > previousTick)
  assert.equal(next[0].params.position.x, -16.5)
  assert.equal(next[0].params.position.z, 21.5)
  assert.equal(next[0].params.delta.x, 0)
  assert.equal(next[0].params.delta.z, 0)
  assert.deepEqual(f.connections, [])
})

test('terrain wait records new server motion order without trying to seed unknown destination physics', async t => {
  const f = fixture(t); const runtime = f.create()
  f.shared.respawnTerrain = { pending: true }
  await runtime.onRespawn({ serverConfirmed: true })
  f.host.world.getBlock = () => { throw new Error('Unknown destination') }
  assert.doesNotThrow(() => runtime.applyPacket('correct_player_move_prediction', correction({ tick: 1010n })))
  assert.doesNotThrow(() => runtime.applyPacket('set_entity_motion', { runtime_entity_id: 41n, velocity: { x: 0.1, y: 0.2, z: 0.3 }, tick: 1011n }))
  assert.equal(f.shared.lastPhysicsCorrectionTick, '1010')
  assert.equal(f.shared.lastMotionTick, '1011')
  assert.equal(f.shared.prediction, null)
  assert.equal(inputs(f).length, 0)
})
