'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMovement, movementInput } = require('../src/movement')
const { createPhysics } = require('../src/physics')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')

let preparedFixturePhysics = null
function fixture (override = () => null, { firstTickOffset = 0 } = {}) {
  let time = 20000
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, runtimeEntityId: '41', positionUpdatedAt: 'server', position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 } }
  const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
  const world = { getBlock: (x, y, z) => override(x, y, z, block) ?? block(y < 65 ? 'stone' : 'air') }
  preparedFixturePhysics ??= createPhysics({ world, version: '1.26.60' })
  const sent = []
  const predictions = []
  const errors = []
  const movement = createMovement({ client: { queue: (name, params) => {
    const stamped = sent.length === 0 ? { ...params, tick: params.tick + BigInt(firstTickOffset) } : params
    sent.push({ name, params: stamped }); return { tick: stamped.tick }
  } }, getState: () => structuredClone(state), world, physics: preparedFixturePhysics.withWorld(world), waterPhysics: preparedFixturePhysics.withWorld(world, { allowWater: true }), startGame: { current_tick: 1000n }, startGameReceivedAt: 0, version: '1.26.60', clock: () => time, onPrediction: prediction => predictions.push(prediction), onError: error => errors.push(error.message) })
  return { movement, state, sent, predictions, errors, tick: (milliseconds = 50) => { time += milliseconds } }
}

test('learning sprint default uses real native flat frames and is faster only with received hunger on a known dry route', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const rows = []
  for (const mode of ['learning', 'explicit_false', 'balanced', 'unknown', 'low', 'predicted']) {
    const f = fixture(); f.state.threatPolicy = mode === 'balanced' ? 'balanced_mining' : 'online_learning'
    if (mode !== 'unknown') f.state.vitals = { hunger: { value: mode === 'low' ? 6 : 20, source: mode === 'predicted' ? 'client_prediction' : 'server_attribute' } }
    const options = mode === 'explicit_false' ? { sprint: false } : {}
    const preview = f.movement.preview({ x: 11.5, y: 65, z: 0.5 }, options)
    assert.equal(preview.ready, true, mode)
    assert.equal(preview.sprintAllowed, mode === 'learning', mode)
    f.movement.start({ x: 11.5, y: 65, z: 0.5 }, options)
    for (let tick = 1; tick < 20; tick++) { f.tick(); t.mock.timers.tick(50) }
    const proof = f.movement.snapshot()
    rows.push({ mode, x: proof.predictedPosition.x, packets: f.sent.map(packet => structuredClone(packet)) })
    assert.equal(proof.sprintAllowed, preview.sprintAllowed)
    assert.equal(proof.sprintRouteDry, preview.sprintRouteDry)
    assert.equal(proof.serverConfirmed, false)
    assert.equal(f.sent.some(packet => packet.params.input_data.includes('sprinting')), mode === 'learning', mode)
    f.movement.stop()
  }
  // The measured sprint attribute is+30%, replacing the dependency's old
  // +113.3% fit. Reactive waypoint braking need not preserve a1-block margin.
  assert.ok(rows[0].x > rows[1].x, JSON.stringify(rows.map(row => ({ mode: row.mode, x: row.x }))))
  assert.ok(Math.max(...rows[0].packets.map(p => p.params.delta.x)) > Math.max(...rows[1].packets.map(p => p.params.delta.x)))
  for (const row of rows.slice(2)) assert.ok(Math.abs(row.x - rows[1].x) < 1e-9)
  const actual = rows[0].packets.find(packet => packet.params.input_data.includes('start_sprinting'))
  assert.ok(actual.params.input_data.includes('sprint_down'))
  const decoded = createDeserializer('1.26.60').parsePacketBuffer(createSerializer('1.26.60').createPacketBuffer(actual)).data.params
  assert.ok(decoded.input_data.includes('sprinting')); assert.ok(decoded.input_data.includes('start_sprinting'))
})

test('learning sprint default vetoes a wet origin and every mixed land-water route for its whole lifetime', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const wet = fixture((x, y, z, block) => block(y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air', x >= 8 && y >= 60 && y <= 62 ? { liquid_depth: 0 } : {}))
  wet.state.position = { x: 8.50558, y: 64.91255, z: -1.96432 }; wet.state.rotation.yaw = 90
  wet.state.threatPolicy = 'online_learning'; wet.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  const wetTarget = { x: 7.5, y: 63, z: -1.5 }, options = { allowWater: true }
  assert.equal(wet.movement.preview(wetTarget, options).sprintRouteDry, false)
  wet.movement.start(wetTarget, options)
  for (let tick = 0; tick < 90 && wet.movement.snapshot().running; tick++) { wet.tick(); t.mock.timers.tick(50) }
  assert.equal(wet.movement.snapshot().sprintAllowed, false)
  assert.equal(wet.movement.snapshot().sprintReason, 'route_not_known_dry')
  assert.ok(wet.sent.every(packet => !packet.params.input_data.includes('sprinting')))
  wet.movement.stop()
  const mixed = fixture((x, y, z, block) => x >= 4 && x <= 5 && y >= 62 && y <= 64 ? block('water', { liquid_depth: 0 }) : null)
  mixed.state.threatPolicy = 'online_learning'; mixed.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  const target = { x: 8.5, y: 65, z: 0.5 }, route = mixed.movement.preview(target, options)
  assert.equal(route.ready, true, route.reason)
  assert.ok(route.waypoints.some(point => point.action === 'swim' || point.medium === 'water'))
  assert.equal(route.sprintRouteDry, false)
  mixed.movement.start(target, options)
  for (let tick = 0; tick < 10 && mixed.movement.snapshot().running; tick++) { mixed.tick(); t.mock.timers.tick(50) }
  assert.equal(mixed.movement.snapshot().sprintAllowed, false)
  assert.ok(mixed.sent.every(packet => !packet.params.input_data.includes('sprinting')))
  mixed.movement.stop()
})

test('learning sprint default rejects newly received water before queue and releases sprint when hunger permission ends', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let flooded = false
  const f = fixture((x, y, z, block) => flooded && y === 65 ? block('water', { liquid_depth: 0 }) : null)
  f.state.threatPolicy = 'online_learning'; f.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  f.movement.start({ x: 8.5, y: 65, z: 0.5 }, { allowWater: true })
  const before = f.sent.length; flooded = true; f.tick(); t.mock.timers.tick(50)
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.equal(f.sent.length, before, 'new wet physics is rejected before any navigation input is queued')
  const hungry = fixture(); hungry.state.threatPolicy = 'online_learning'; hungry.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  hungry.movement.start({ x: 8.5, y: 65, z: 0.5 })
  hungry.state.vitals.hunger.value = 6; hungry.tick(); t.mock.timers.tick(50)
  assert.equal(hungry.movement.snapshot().sprintAllowed, false)
  assert.ok(hungry.sent.at(-1).params.input_data.includes('stop_sprinting'))
  assert.ok(!hungry.sent.at(-1).params.input_data.includes('sprinting'))
  hungry.movement.stop()
})

test('learning sprint default leaves the native stationary critical hop explicitly nonsprinting', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(); f.state.threatPolicy = 'online_learning'; f.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  t.after(() => f.movement.stop())
  assert.equal(f.movement.previewHop().ready, true)
  f.movement.startHop()
  for (let tick = 0; tick < 35 && f.movement.snapshot().running; tick++) { f.tick(); t.mock.timers.tick(50) }
  assert.equal(f.movement.snapshot().sprintRequested, false)
  assert.equal(f.movement.snapshot().sprintAllowed, false)
  assert.ok(f.sent.every(packet => !packet.params.input_data.includes('sprinting')))
  assert.equal(f.sent.filter(packet => packet.params.input_data.includes('start_jumping')).length, 1)
})

test('explicit water recovery sends normal float controls and reaches a bank without altering raw server pose', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement, state, sent, predictions, tick } = fixture((x, y, z, block) => block(y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air', x >= 8 && y >= 60 && y <= 62 ? { liquid_depth: 0 } : {}))
  t.after(() => movement.stop())
  state.position = { x: 8.50558, y: 64.91255, z: -1.96432 }
  state.rotation.yaw = 90
  const before = structuredClone(state)
  const target = { x: 7.5, y: 63, z: -1.5 }
  assert.equal(movement.preview(target).ready, false)
  assert.equal(sent.length, 0)
  assert.equal(movement.preview(target, { allowWater: true }).ready, true)
  movement.start(target, { allowWater: true })
  for (let index = 0; index < 160 && movement.snapshot().phase === 'moving'; index++) { tick(); t.mock.timers.tick(50) }
  const result = movement.snapshot()
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.onGround, true)
  assert.equal(result.predictedFeet.y, 63)
  assert.equal(result.physicsState.isInWater, false)
  assert.equal(result.serverConfirmed, false)
  assert.ok(predictions.some(prediction => prediction.physicsState.isInWater))
  assert.ok(sent.some(packet => packet.params.input_data.includes('want_up')))
  assert.ok(sent.every(packet => !packet.params.input_data.includes('start_swimming')))
  assert.deepEqual(state, before)
})

test('emergency health relaxation is explicit per operation and still stops immediately on damage or death', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  f.state.health = 3.43
  const target = { x: 2.5, y: 65, z: 0.5 }
  assert.equal(f.movement.preview(target).ready, false)
  assert.equal(f.movement.preview(target, { emergency: 'true' }).ready, false)
  assert.equal(f.movement.preview(target, { emergency: true }).ready, true)
  assert.throws(() => f.movement.start(target), /health/)
  f.movement.start(target, { emergency: true })
  assert.equal(f.movement.snapshot().emergency, true)
  assert.equal(f.movement.snapshot().phase, 'moving')
  f.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 3.43 }] })
  assert.equal(f.movement.snapshot().phase, 'moving')
  const sent = f.sent.length
  f.state.health = 3
  f.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 3 }] })
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.equal(f.sent.length, sent)
  assert.throws(() => f.movement.start(target), /health/, 'a prior emergency does not authorize ordinary movement')
  f.state.health = 0
  assert.equal(f.movement.preview(target, { emergency: true }).ready, false)
})

test('an explicit low-health allowance moves at half a heart without emergency behaviour and still refuses a dead or unknown player', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  f.state.health = 0.5
  const target = { x: 2.5, y: 65, z: 0.5 }
  assert.equal(f.movement.preview(target).ready, false)
  assert.equal(f.movement.preview(target, { allowLowHealth: 'true' }).ready, false)
  assert.equal(f.movement.preview(target, { allowLowHealth: true }).ready, true)
  f.movement.start(target, { allowLowHealth: true })
  assert.equal(f.movement.snapshot().phase, 'moving'); assert.equal(f.movement.snapshot().emergency, false)
  f.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 0.5 }] })
  assert.equal(f.movement.snapshot().phase, 'moving')
  f.movement.stop()
  assert.throws(() => f.movement.start(target), /health/, 'the allowance does not carry over to an ordinary move')
  for (const change of [s => { s.health = 0 }, s => { s.health = undefined }, s => { s.dead = true }]) {
    const g = fixture(); g.state.health = 0.5; change(g.state)
    assert.equal(g.movement.preview(target, { allowLowHealth: true }).ready, false)
  }
})

test('sprint input requires opt-in and known hunger above six; a hunger update releases sprint without stopping movement', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  const target = { x: 8.5, y: 65, z: 0.5 }
  assert.equal(f.movement.preview(target, { sprint: 'true' }).ready, false)
  assert.equal(f.movement.preview(target, { sprint: null }).ready, false)
  for (const hunger of [undefined, 6, 0]) {
    f.state.vitals = hunger === undefined ? {} : { hunger: { value: hunger, source: 'server_attribute' } }
    const preview = f.movement.preview(target, { sprint: true })
    assert.equal(preview.ready, true)
    assert.equal(preview.sprintRequested, true)
    assert.equal(preview.sprintAllowed, false)
  }
  f.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  f.movement.start(target, { sprint: true })
  assert.equal(f.movement.snapshot().sprintAllowed, true)
  assert.ok(f.sent.some(packet => packet.params.input_data.includes('start_sprinting')))
  f.state.vitals.hunger.value = 6
  f.tick(); t.mock.timers.tick(50)
  assert.equal(f.movement.snapshot().sprintAllowed, false)
  assert.equal(f.movement.snapshot().phase, 'moving')
  assert.ok(f.sent.at(-1).params.input_data.includes('stop_sprinting'))
  assert.ok(!f.sent.at(-1).params.input_data.includes('sprinting'))
  f.state.vitals.hunger.value = 20
  f.tick(); t.mock.timers.tick(50)
  assert.equal(f.movement.snapshot().sprintAllowed, true)
  f.movement.stop()
  const count = f.sent.length
  f.movement.start(target)
  assert.equal(f.movement.snapshot().sprintRequested, false)
  assert.ok(f.sent.slice(count).every(packet => !packet.params.input_data.includes('sprinting')))
})

test('sprint and emergency permissions remain independent and sprint frames serialize through the real codec', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  f.state.health = 4
  f.state.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  const target = { x: 8.5, y: 65, z: 0.5 }
  assert.throws(() => f.movement.start(target, { sprint: true }), /health/)
  f.movement.start(target, { sprint: true, emergency: true })
  assert.equal(f.movement.snapshot().emergency, true)
  assert.equal(f.movement.snapshot().sprintRequested, true)
  const sprint = f.sent.find(packet => packet.params.input_data.includes('sprinting'))
  assert.ok(sprint)
  const codec = createSerializer('1.26.60')
  const parsed = createDeserializer('1.26.60').parsePacketBuffer(codec.createPacketBuffer(sprint)).data.params
  assert.ok(parsed.input_data.includes('sprinting'))
  assert.ok(parsed.input_data.includes('start_sprinting'))
})

test('movement preview has no side effects; execution serializes model input with current ticks and distinct predictions', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement, state, sent, predictions, tick } = fixture()
  t.after(() => movement.stop())
  const before = structuredClone(state)
  assert.equal(movement.preview({ x: 3.5, z: 0.5 }).ready, true)
  assert.equal(sent.length, 0)
  movement.start({ x: 3.5, z: 0.5 })
  assert.equal(sent[0].params.tick, 1400n)
  const serializer = createSerializer('1.26.60')
  const deserializer = createDeserializer('1.26.60')
  const packet = deserializer.parsePacketBuffer(serializer.createPacketBuffer(sent[0])).data.params
  assert.deepEqual(packet.move_vector, { x: 0, z: 1 })
  assert.ok(packet.input_data.includes('up'))
  assert.ok(packet.input_data.includes('vertical_collision'))
  assert.ok(packet.position.x > state.position.x)
  for (let index = 0; index < 200 && movement.snapshot().phase === 'moving'; index++) { tick(); t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation', movement.snapshot().reason)
  assert.equal(movement.snapshot().serverConfirmed, false)
  assert.equal(movement.snapshot().running, false)
  assert.deepEqual(state, before)
  assert.ok(predictions.length > 1)
  assert.equal(predictions[0].source, 'client_prediction')
  assert.equal(predictions[0].serverConfirmed, false)
  const finalCount = sent.length
  tick(500); t.mock.timers.tick(500)
  assert.equal(sent.length, finalCount)
})

test('movement preview and start use the same copied avoidance plan and malformed constraints cannot emit input', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  const target = { x: 4.5, y: 65, z: 0.5 }
  const circle = { id: 'actor', position: { x: 2.5, y: 66.62, z: 0.5 }, minDistance: 1, padding: 0.5 }
  const options = { avoidance: [circle] }
  const preview = f.movement.preview(target, options)
  assert.equal(preview.ready, true, preview.reason)
  assert.ok(preview.waypoints.some(point => Math.abs(point.position.z - 0.5) >= 1.5))
  assert.equal(f.sent.length, 0)
  f.movement.start(target, options)
  assert.deepEqual(f.movement.snapshot().route.avoidance, preview.avoidance)
  assert.deepEqual(f.movement.snapshot().route.waypoints, preview.waypoints)
  circle.position.x = 999
  assert.equal(f.movement.snapshot().route.avoidance[0].position.x, 2.5)
  for (let i = 0; i < 200 && f.movement.snapshot().phase === 'moving'; i++) { f.tick(); t.mock.timers.tick(50) }
  assert.equal(f.movement.snapshot().phase, 'awaiting_server_confirmation', f.movement.snapshot().reason)
  assert.ok(f.predictions.every(p => Math.hypot(p.position.x - 2.5, p.position.y - 66.62, p.position.z - 0.5) >= 1 - 1e-4))
  const malformed = fixture()
  t.after(() => malformed.movement.stop())
  assert.equal(malformed.movement.preview(target, { avoidance: null }).ready, false)
  assert.throws(() => malformed.movement.start(target, { avoidance: null }), /avoidance policy/)
  assert.equal(malformed.sent.length, 0)
})

test('jump and stance edges occur once and never include contradictory or wrong-shaped input vectors', () => {
  const predicted = { onGround: true, isCollidedHorizontally: true }
  const first = movementInput({ forward: true, left: true, jump: true, sprint: true, sneak: true }, {}, predicted)
  assert.ok(first.flags.includes('start_jumping'))
  assert.ok(first.flags.includes('start_sprinting'))
  assert.ok(first.flags.includes('start_sneaking'))
  assert.ok(first.flags.includes('horizontal_collision'))
  assert.ok(Math.abs(Math.hypot(first.vector.x, first.vector.z) - 1) < 1e-10)
  const held = movementInput({ jump: true, sprint: true }, { jump: true, sprint: true }, {})
  assert.ok(!held.flags.includes('start_jumping'))
  assert.ok(!held.flags.includes('start_sprinting'))
  const released = movementInput({}, { sprint: true, sneak: true }, {})
  assert.ok(released.flags.includes('stop_sprinting'))
  assert.ok(released.flags.includes('stop_sneaking'))
  assert.deepEqual(released.vector, { x: 0, z: 0 })
})

test('one-block terrain jump generates real jump intent and stops at an unconfirmed predicted destination', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement, sent, tick } = fixture((x, y, z, block) => x >= 1 && y === 65 ? block('stone') : null)
  t.after(() => movement.stop())
  movement.start({ x: 2.5, y: 66, z: 0.5 })
  for (let index = 0; index < 240 && movement.snapshot().phase === 'moving'; index++) { tick(); t.mock.timers.tick(50) }
  assert.ok(sent.some(packet => packet.params.input_data.includes('start_jumping')))
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation', movement.snapshot().reason)
  assert.ok(Math.abs(movement.snapshot().predictedFeet.y - 66) < 1e-5)
})

test('authoritative corrections, damage and disconnect stop without sending stale position predictions', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const correction = fixture()
  correction.movement.start({ x: 3.5, z: 0.5 })
  correction.movement.applyPacket('move_player', { runtime_id: 999, position: { x: 100, y: 66.62, z: 0 } })
  assert.equal(correction.movement.snapshot().phase, 'moving')
  const before = correction.sent.length
  correction.movement.applyPacket('correct_player_move_prediction', { position: { x: 0.6, y: 66.62, z: 0.5 }, on_ground: true })
  assert.equal(correction.movement.snapshot().phase, 'replan_required')
  assert.equal(correction.sent.length, before)
  correction.tick(); t.mock.timers.tick(50)
  assert.equal(correction.sent.length, before)
  const damage = fixture()
  damage.movement.start({ x: 3.5, z: 0.5 })
  const count = damage.sent.length
  damage.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 19 }] })
  assert.equal(damage.movement.snapshot().phase, 'failed')
  assert.equal(damage.sent.length, count)
  assert.equal(damage.errors.length, 1)
  const disconnected = fixture()
  disconnected.movement.start({ x: 3.5, z: 0.5 })
  disconnected.state.phase = 'disconnected'
  disconnected.tick(); t.mock.timers.tick(50)
  assert.equal(disconnected.movement.snapshot().phase, 'failed')
})

test('a historical player correction replays sent inputs to the present without sending or rewriting raw state', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(); f.state.connectionId = 'replay-test'
  t.after(() => f.movement.stop())
  f.movement.start({ x: 8.5, y: 65, z: 0.5 })
  for (let n = 0; n < 4; n++) { f.tick(); t.mock.timers.tick(50) }
  const historical = structuredClone(f.predictions[1]); const present = structuredClone(f.predictions.at(-1))
  const raw = structuredClone(f.state); const count = f.sent.length
  const receipt = f.movement.applyPacket('correct_player_move_prediction', { prediction_type: 'player', position: historical.position, delta: historical.velocity, on_ground: historical.onGround, tick: BigInt(historical.tick) })
  assert.equal(receipt.replayed, true)
  assert.equal(f.movement.snapshot().phase, 'replan_required')
  assert.equal(f.movement.snapshot().inputReplay.replayedTicks, 3)
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(f.predictions.at(-1).position[axis] - present.position[axis]) < 1e-6, axis)
  assert.notDeepEqual(f.predictions.at(-1).position, historical.position)
  assert.deepEqual(f.movement.snapshot().lastAuthoritativePosition, historical.position)
  assert.equal(f.sent.length, count)
  assert.deepEqual(f.state, raw)
  assert.equal(f.predictions.at(-1).serverConfirmed, false)
})

test('input history follows the host stamped tick rather than an older requested tick', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(undefined, { firstTickOffset: 3 }); f.state.connectionId = 'stamped-replay'
  t.after(() => f.movement.stop())
  f.movement.start({ x: 8.5, y: 65, z: 0.5 })
  for (let n = 0; n < 8; n++) { f.tick(); t.mock.timers.tick(50) }
  assert.equal(f.predictions[0].tick, String(f.sent[0].params.tick))
  const historical = f.predictions[1]
  const result = f.movement.applyPacket('correct_player_move_prediction', { prediction_type: 'player', position: historical.position, delta: historical.velocity, on_ground: historical.onGround, tick: BigInt(historical.tick) })
  assert.equal(result.replayed, true)
  assert.equal(f.movement.snapshot().inputReplay.currentTick, String(f.sent.at(-1).params.tick))
})

test('idle own lifecycle resets discard old same-scope input history; remote and ordinary updates preserve it', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const events = [
    { name: 'own teleport', packetName: 'move_player', packet: { runtime_id: 41n, mode: 'teleport' }, cleared: true },
    { name: 'own respawn ready', packetName: 'respawn', packet: { runtime_entity_id: 41n, state: 1 }, cleared: true },
    { name: 'confirmed zero-ID respawn lifecycle hook', packetName: 'respawn', packet: { runtime_entity_id: 0n, state: 1 }, confirmed: true, cleared: true },
    { name: 'connection close', packetName: 'close', packet: {}, cleared: true },
    { name: 'dimension change', packetName: 'change_dimension', packet: { dimension: 0 }, cleared: true },
    { name: 'remote teleport', packetName: 'move_player', packet: { runtime_id: 999n, mode: 'teleport' }, cleared: false },
    { name: 'remote respawn', packetName: 'respawn', packet: { runtime_entity_id: 999n, state: 1 }, cleared: false },
    { name: 'ordinary own movement', packetName: 'move_player', packet: { runtime_id: 41n, mode: 'normal' }, cleared: false },
    { name: 'respawn preparation', packetName: 'respawn', packet: { runtime_entity_id: 41n, state: 0 }, cleared: false }
  ]
  for (const event of events) {
    const f = fixture(); f.state.connectionId = 'same-connection'
    t.after(() => f.movement.stop())
    f.movement.start({ x: 8.5, y: 65, z: 0.5 })
    for (let n = 0; n < 4; n++) { f.tick(); t.mock.timers.tick(50) }
    const old = structuredClone(f.predictions[2])
    const correction = frame => ({ prediction_type: 'player', position: frame.position, delta: frame.velocity, on_ground: frame.onGround, tick: BigInt(frame.tick) })
    assert.equal(f.movement.applyPacket('correct_player_move_prediction', correction(f.predictions[1])).replayed, true, event.name)
    assert.equal(f.movement.snapshot().running, false, 'the reset arrives while idle')
    const latest = structuredClone(f.predictions.at(-1))
    Object.assign(f.state, { position: latest.position, positionSource: 'client_prediction', predicted: latest })
    const count = f.sent.length
    f.movement.applyPacket(event.packetName, { ...event.packet, position: latest.position })
    if (event.confirmed) f.movement.resetLifecycle('Host confirmed respawn with runtime ID zero')
    assert.equal(f.sent.length, count, `${event.name} must not emit a packet`)
    f.tick()
    f.movement.start({ x: 8.5, y: 65, z: 0.5 })
    const result = f.movement.applyPacket('correct_player_move_prediction', correction(old))
    const replay = f.movement.snapshot().inputReplay
    if (event.cleared) {
      assert.notEqual(result?.replayed, true, event.name)
      assert.equal(replay.accepted, false, event.name)
      assert.equal(replay.code, 'HISTORY_MISSING', event.name)
    } else {
      assert.equal(result?.replayed, true, event.name)
      assert.equal(replay.accepted, true, event.name)
      assert.equal(replay.replayedTicks, 3, event.name)
    }
    f.movement.stop()
  }
})

test('a confirmed lifecycle reset stops an active sender without releasing its previous predicted frame', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(); t.after(() => f.movement.stop())
  f.movement.start({ x: 8.5, y: 65, z: 0.5 })
  f.tick(); t.mock.timers.tick(50)
  const count = f.sent.length
  f.movement.resetLifecycle('Confirmed respawn')
  f.tick(); t.mock.timers.tick(50)
  assert.equal(f.sent.length, count)
  assert.equal(f.movement.snapshot().running, false)
  assert.equal(f.movement.snapshot().route, null)
  assert.equal(f.movement.snapshot().physicsState, null)
})

test('bounded timer catchup preserves ordered ticks while stalls and unknown route changes abort', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const jitter = fixture()
  t.after(() => jitter.movement.stop())
  jitter.movement.start({ x: 3.5, z: 0.5 })
  jitter.tick(151.5); t.mock.timers.tick(50)
  assert.equal(jitter.movement.snapshot().phase, 'moving')
  assert.deepEqual(jitter.sent.slice(0, 4).map(packet => packet.params.tick), [1400n, 1401n, 1402n, 1403n])
  jitter.movement.stop()
  const delayed = fixture()
  t.after(() => delayed.movement.stop())
  delayed.movement.start({ x: 3.5, z: 0.5 })
  delayed.tick(100); t.mock.timers.tick(50)
  assert.deepEqual(delayed.sent.slice(0, 3).map(packet => packet.params.tick), [1400n, 1401n, 1402n])
  delayed.tick(500); t.mock.timers.tick(50)
  assert.equal(delayed.movement.snapshot().phase, 'failed')
  assert.equal(delayed.movement.snapshot().lastTimerGapMs, 500)
  const restart = fixture()
  t.after(() => restart.movement.stop())
  restart.movement.start({ x: 3.5, z: 0.5 })
  restart.movement.stop()
  const releasedTick = restart.sent.at(-1).params.tick
  restart.movement.start({ x: 3.5, z: 0.5 })
  assert.equal(restart.sent.at(-1).params.tick, releasedTick)
  restart.tick(100); t.mock.timers.tick(50)
  assert.ok(restart.sent.at(-1).params.tick > releasedTick)
  assert.equal(new Set(restart.sent.map(packet => packet.params.tick.toString())).size, restart.sent.length)
  let unknown = false
  const changing = fixture((x, y, z) => unknown && x >= 1 ? { known: false, reason: 'not received' } : null)
  changing.movement.start({ x: 3.5, z: 0.5 })
  unknown = true
  changing.tick(); t.mock.timers.tick(50)
  assert.equal(changing.movement.snapshot().phase, 'failed')
})

test('late timer phase can cross four ordered input ticks within the unchanged 200ms wall bound', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  f.tick(49)
  f.movement.start({ x: 8.5, z: 0.5 })
  f.tick(161.97); t.mock.timers.tick(50)
  assert.equal(f.movement.snapshot().phase, 'moving')
  assert.deepEqual(f.sent.map(packet => packet.params.tick), [1400n, 1401n, 1402n, 1403n, 1404n])
  assert.ok(Math.abs(f.movement.snapshot().lastTimerGapMs - 161.97) < 1e-8)
  for (const name of ['beforeInputMs', 'queueMs']) assert.ok(Number.isFinite(f.movement.snapshot().maxFrameTimings[name]))
  const count = f.sent.length
  f.tick(201); t.mock.timers.tick(50)
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.equal(f.movement.snapshot().reason, 'Movement input timer stalled')
  assert.equal(f.sent.length, count, 'more than 200ms still cannot emit catch-up input')
})

test('four-tick recovery validates each proposed frame and stops the remaining catchup on rejection', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(); let checked = 0
  t.after(() => f.movement.stop())
  f.tick(49)
  f.movement.start({ x: 8.5, z: 0.5 }, { beforeInput: () => ++checked < 3 })
  f.tick(161.97); t.mock.timers.tick(50)
  assert.equal(checked, 3)
  assert.deepEqual(f.sent.map(packet => packet.params.tick), [1400n, 1401n])
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.match(f.movement.snapshot().reason, /frame guard/)
  f.tick(); t.mock.timers.tick(50)
  assert.equal(f.sent.length, 2)
})

test('water execution needs explicit opt-in and remains prediction-only', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement, tick, sent } = fixture((x, y, z, block) => x >= 1 && y >= 60 && y <= 64 ? block('water', { liquid_depth: 0 }) : null)
  t.after(() => movement.stop())
  assert.equal(movement.preview({ x: 3.5, z: 0.5 }, { maxDistance: 4 }).ready, false)
  movement.start({ x: 3.5, z: 0.5 }, { allowWater: true, maxDistance: 4 })
  for (let index = 0; index < 240 && movement.snapshot().phase === 'moving'; index++) { tick(); t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation', movement.snapshot().reason)
  assert.equal(movement.snapshot().allowWater, true)
  assert.equal(movement.snapshot().serverConfirmed, false)
  assert.ok(!sent.some(packet => packet.params.input_data.includes('start_swimming')))
})

test('neutral settle repairs a server-corrected midair pose and completes only after supported grounding', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement, state, sent, predictions, tick } = fixture()
  t.after(() => movement.stop())
  state.position = { x: 0.5, y: 67.098686, z: 0.5 }
  state.positionSource = 'correct_player_move_prediction'
  assert.equal(movement.preview({ x: 2.5, z: 0.5 }).settleRequired, true)
  const started = movement.settle({ maxDrop: 1 })
  assert.equal(started.phase, 'settling')
  assert.equal(started.onGround, false)
  for (let i = 0; i < 25 && movement.snapshot().phase === 'settling'; i++) { tick(); t.mock.timers.tick(50) }
  const result = movement.snapshot()
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.onGround, true)
  assert.equal(result.settled, true)
  assert.equal(result.predictedFeet.y, 65)
  assert.equal(result.serverConfirmed, false)
  assert.equal(state.position.y, 67.098686)
  assert.ok(sent.every(packet => packet.params.move_vector.x === 0 && packet.params.move_vector.z === 0))
  assert.ok(predictions.every(prediction => prediction.physicsState))
  assert.equal(predictions.at(-1).physicsState.onGround, true)
})

test('reconstructed movement retains a jump velocity through hot-reload metadata before neutral landing', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const first = fixture((x, y, z, block) => x >= 1 && y === 65 ? block('stone') : null)
  first.movement.start({ x: 2.5, y: 66, z: 0.5 })
  const prediction = first.predictions.at(-1)
  assert.equal(prediction.onGround, false)
  assert.ok(prediction.velocity.y > 0)
  first.movement.stop('hot reload')
  const resumed = fixture((x, y, z, block) => x >= 1 && y === 65 ? block('stone') : null)
  t.after(() => resumed.movement.stop())
  resumed.state.position = prediction.position
  resumed.state.positionSource = 'client_prediction'
  resumed.state.predicted = prediction
  const started = resumed.movement.settle({ maxDrop: 2 })
  assert.ok(started.velocity.y > 0, 'The previous upward velocity must not reset to zero')
  for (let i = 0; i < 80 && resumed.movement.snapshot().phase === 'settling'; i++) { resumed.tick(); t.mock.timers.tick(50) }
  const result = resumed.movement.snapshot()
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.settled, true)
  assert.equal(result.onGround, true)
  const landedPrediction = resumed.predictions.at(-1)
  resumed.state.position = landedPrediction.position
  resumed.state.predicted = landedPrediction
  const nextPlan = resumed.movement.preview({ x: 2.5, y: 66, z: 0.5 })
  assert.equal(nextPlan.ready, true, nextPlan.reason)
})
