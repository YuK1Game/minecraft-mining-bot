'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createInput } = require('../src/input')
const { createMovement } = require('../src/movement')
const { createInputHistory } = require('../src/input-history')
const { createPhysics } = require('../src/physics')
function factories () {
  const text = fs.readFileSync(path.resolve(__dirname, '../src/runtime.js'), 'utf8')
  const start = text.indexOf('function queuedWireConnection ('), end = text.indexOf('function createRuntime (host)', start)
  assert.ok(start > 0 && end > start)
  const factory = new Function(text.slice(start, end) + '\nreturn { createActualQueuedWireClock, queuedWireConnection }')()
  assert.equal((text.match(/getQueuedCursor: queuedCursor/g) ?? []).length, 2, 'both real Runtime senders must use the selector')
  return factory
}
function hostQueue (client) {
  const text = fs.readFileSync(path.resolve(__dirname, '../src/host.js'), 'utf8'), start = text.indexOf('  const connection = { queue (name, packet) {'), end = text.indexOf('  const respawnTerrainHandoff', start)
  return new Function('client', `let stopping = false, lastInputTick = -1n;\n${text.slice(start, end)}\nreturn { client: connection, lastTick: () => lastInputTick }`)(client)
}
const state = () => ({ connectionId: 'connection', startedAt: '2026-11-01T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, phase: 'spawned', gameMode: 'survival', health: 12, position: { x: .5, y: 66.62, z: .5 }, rotation: { yaw: -90, pitch: 0 } })

test('actual queue tap precedes modeled callbacks, survives reload/life and never renews duplicate or backward receipts', t => {
  let now = 100, receipt = { tick: 1003n }, raw = state()
  t.mock.method(Date, 'now', () => now)
  const { createActualQueuedWireClock, queuedWireConnection } = factories(), shared = {}, client = { queue: () => receipt }
  const clock = createActualQueuedWireClock({ client, shared, getState: () => raw }), scope = queuedWireConnection(raw), wrapped = client.queue
  client.queue('player_auth_input', {});
  assert.deepEqual(clock.cursor(null, scope, 1003n), { tick: '1003', queuedAt: 100 })
  assert.equal(shared.actualQueuedWireClock.serverConfirmed, false)
  now = 150; raw.lifecycle.deathId++; raw.dimension = 'nether'; raw.runtimeEntityId = '2'
  const reloaded = createActualQueuedWireClock({ client, shared, getState: () => raw })
  assert.equal(client.queue, wrapped)
  assert.deepEqual(reloaded.cursor(null, scope, 1003n), { tick: '1003', queuedAt: 100 }, 'new life/reload does not fake enqueue freshness')
  client.queue('player_auth_input', {}); assert.equal(shared.actualQueuedWireClock.queuedAt, 100)
  receipt = { tick: 1002n }; client.queue('player_auth_input', {}); assert.equal(shared.actualQueuedWireClock.tick, '1003')
  receipt = { tick: 1004n }; client.queue('player_auth_input', {}); assert.equal(shared.actualQueuedWireClock.queuedAt, 150)
  assert.deepEqual(reloaded.cursor({ tick: '1003', queuedAt: 150 }, scope, 1004n), { tick: '1004', queuedAt: 150 })
  raw = { ...raw, connectionId: 'different' }
  assert.throws(() => clock.cursor(null, scope, 1005n), /connection changed/)
  const different = createActualQueuedWireClock({ client, shared, getState: () => raw }), differentScope = queuedWireConnection(raw)
  assert.equal(different.cursor(null, differentScope, 1005n), null)
  assert.equal(different.snapshot(), null)
})

test('missing/invalid receipts and unknown connection cannot create an actual wire clock or mask an invalid modeled cursor', t => {
  t.mock.method(Date, 'now', () => 100)
  const { createActualQueuedWireClock, queuedWireConnection } = factories()
  for (const receipt of [undefined, {}, { tick: null }, { tick: 'invalid' }, { tick: -1n }, { tick: 1n << 64n }, { tick: 1.5 }, { tick: Number.MAX_SAFE_INTEGER + 1 }]) {
    const raw = state(), shared = {}, client = { queue: () => receipt }, clock = createActualQueuedWireClock({ client, shared, getState: () => raw })
    client.queue('player_auth_input', {})
    assert.equal(shared.actualQueuedWireClock, undefined)
    assert.equal(clock.cursor(null, queuedWireConnection(raw), 1004n), null)
  }
  const raw = { ...state(), connectionId: null }, shared = {}, client = { queue: () => ({ tick: 1003n }) }, clock = createActualQueuedWireClock({ client, shared, getState: () => raw })
  client.queue('player_auth_input', {}); assert.equal(shared.actualQueuedWireClock, undefined)
  const normal = state(), client2 = { queue: () => ({ tick: 1003n }) }, valid = createActualQueuedWireClock({ client: client2, shared: {}, getState: () => normal })
  client2.queue('player_auth_input', {})
  assert.deepEqual(valid.cursor({ tick: 'invalid', queuedAt: 100 }, queuedWireConnection(normal), 1004n), { tick: 'invalid', queuedAt: 100 })
})

test('stale clock stays stale until wall tick overtakes it, then ordinary cold start queues one actual frame without fabricated catchup', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = 100, logical = 150, simulated = 0
  t.mock.method(Date, 'now', () => now)
  const { createActualQueuedWireClock, queuedWireConnection } = factories(), raw = state(), wire = [], host = hostQueue({ queue: (name, packet) => wire.push(packet.tick) }), shared = {}
  const clock = createActualQueuedWireClock({ client: host.client, shared, getState: () => raw }), scope = queuedWireConnection(raw)
  host.client.queue('player_auth_input', { tick: 1003n })
  now = 351
  const getCursor = () => clock.cursor({ tick: '1003', queuedAt: 100 }, scope, 1000n + BigInt(logical / 50))
  assert.equal(getCursor().queuedAt, 100)
  const input = createInput({ client: host.client, getState: () => raw, getQueuedCursor: getCursor, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => logical, frameProvider: () => { simulated++; return { position: raw.position, delta: { x: 0, y: 0, z: 0 } } } })
  t.after(() => input.stop(false))
  assert.throws(() => input.start(), /handoff timer stalled/)
  assert.equal(simulated, 0); assert.equal(wire.length, 1)
  logical = 200
  assert.equal(getCursor(), null)
  input.start()
  assert.equal(simulated, 1); assert.deepEqual(wire, [1003n, 1004n])
  assert.equal(shared.actualQueuedWireClock.queuedAt, 351, 'freshness comes only from the new actual queued frame')
})

test('future enqueue time and five due ticks retain the existing200ms/four-tick rejection without any send', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = 100, logical = 400, simulated = 0
  t.mock.method(Date, 'now', () => now)
  const { createActualQueuedWireClock, queuedWireConnection } = factories(), raw = state(), packets = [], client = { queue: (name, p) => { packets.push(p); return { tick: p.tick } } }
  const clock = createActualQueuedWireClock({ client, shared: {}, getState: () => raw }), scope = queuedWireConnection(raw)
  client.queue('player_auth_input', { tick: 1003n })
  const input = createInput({ client, getState: () => raw, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => logical, getQueuedCursor: () => clock.cursor(null, scope, 1000n + BigInt(logical / 50)), frameProvider: () => { simulated++; return { position: raw.position, delta: { x: 0, y: 0, z: 0 } } } })
  now = 99
  assert.throws(() => input.start(), /handoff timer stalled/)
  now = 100
  assert.throws(() => input.start(), /Too many queued input handoff ticks/)
  assert.equal(packets.length, 1); assert.equal(simulated, 0)
})

test('real Input/Movement/history release handoff waits then queues1004 once, with no overlapping producer, extra simulation or false witness', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = 0, prediction = null, origin = null, simulations = 0
  t.mock.method(Date, 'now', () => time)
  const { createActualQueuedWireClock, queuedWireConnection } = factories(), scope = { profile: 'probe', realmId: '1', dimension: 'overworld', connectionId: 'connection', startedAt: 'start', runtimeEntityId: '1', generation: 1 }
  const raw = { ...state(), ...scope, realm: { id: '1' }, positionSource: 'server_post_move', positionUpdatedAt: 0 }
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
  const physics = createPhysics({ world, version: '1.26.60' }), history = createInputHistory({ physics, now: () => time }), wire = [], records = [], host = hostQueue({ queue: (name, packet) => wire.push({ name, tick: String(packet.tick) }) }), shared = {}
  const clock = createActualQueuedWireClock({ client: host.client, shared, getState: () => raw }), connection = queuedWireConnection(raw)
  const working = () => prediction ? { ...structuredClone(raw), position: prediction.position, predicted: structuredClone(prediction), positionSource: 'client_prediction', positionServerConfirmed: false } : structuredClone(raw)
  const queued = frame => { assert.equal(shared.actualQueuedWireClock.tick, String(frame.tick), 'actual receipt is recorded BEFORE modeled-history invalidation'); records.push({ tick: String(frame.tick), modeled: frame.modeled }); history.recordQueued({ ...frame, scope }) }
  const cursor = () => clock.cursor(history.snapshot().cursor, connection, 1000n + BigInt(time / 50))
  const common = { client: host.client, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: cursor, onQueuedFrame: queued }
  const input = createInput({ ...common, getState: working, frameProvider: () => { simulations++; const p = physics.step(physics.fromServer(working()), {}), position = physics.toServerPosition(p); return { position, delta: p.velocity, physicsState: p, controls: p.controls, commitPrediction: () => { prediction = { position, physicsState: p, serverConfirmed: false } } } } })
  const movement = createMovement({ ...common, world, physics, getState: () => origin ?? working(), onPrediction: p => { prediction = p } })
  t.after(() => { input.stop(false); movement.stop() })
  input.start(); input.stop(false)
  time = 50; origin = working(); movement.start({ x: 3.5, y: 65, z: .5 }, { sprint: false })
  time = 100; t.mock.timers.tick(50); movement.stop('active handoff')
  assert.equal(history.snapshot().cursor, null); assert.equal(history.snapshot().lastReset, 'unmodeled_input')
  assert.equal(shared.actualQueuedWireClock.tick, '1003')
  const before = simulations
  input.start(); assert.equal(simulations, before); assert.equal(wire.length, 3)
  time = 150; t.mock.timers.tick(50); assert.equal(simulations, before)
  time = 200; t.mock.timers.tick(50)
  assert.equal(simulations, before + 1)
  assert.deepEqual(wire.map(p => p.tick), ['1001', '1002', '1003', '1004'])
  assert.deepEqual(records.map(p => p.modeled), [true, true, false, true])
  assert.equal(input.stats().receiptMismatches.length, 0)
  const witness = history.witness({ scope, health: 12, position: working().position })
  assert.equal(witness.ready, false); assert.equal(history.snapshot().anchorTick, null)
  assert.equal(shared.actualQueuedWireClock.serverConfirmed, false); assert.equal(prediction.serverConfirmed, false)
  t.diagnostic('OldSource: request1002→Host1004→reject. FixedSource: wait atwall1002/1003→one sim/request/actual1004; history witness remains invalid.')
  if (process.env.WIRE_CLOCK_PROOF_PATH) fs.writeFileSync(process.env.WIRE_CLOCK_PROOF_PATH, JSON.stringify({ wire, records, simulations, clock: shared.actualQueuedWireClock, history: history.snapshot(), witness, noExtraSimulationForRelease: true, serverConfirmed: false }, null, 2) + '\n')
})
