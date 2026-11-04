'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { buildStationaryInput, createInput } = require('../src/input')

function fixture (overrides = {}) {
  const state = { phase: 'spawned', position: { x: 1, y: 66.62, z: 1 }, rotation: { pitch: 0, yaw: 0 }, health: 20 }
  const packets = []
  const input = createInput({
    version: '1.26.60',
    startGame: { current_tick: 900n, player_gamemode: 'survival', server_authoritative_block_breaking: true },
    client: { queue: (name, params) => packets.push({ name, params }) },
    getState: () => state,
    ...overrides
  })
  return { input, state, packets }
}

test('mining reach accepts only a finite point on the specified real cube face', t => {
  const { input, state } = fixture()
  t.after(() => input.stop())
  state.position = { x: -0.1, y: 65.5, z: 0.5 }
  input.start()
  const block = { x: 4, y: 65, z: 0 }
  assert.throws(() => input.sendAction('start_break', block, 4), /範囲外/)
  assert.throws(() => input.sendAction('start_break', block, 4, { hitPoint: { x: 4, y: 66.5, z: 0.5 } }), /ブロック面/)
  assert.throws(() => input.sendAction('start_break', block, 5, { hitPoint: { x: 4, y: 65.5, z: 0.5 } }), /ブロック面/)
  assert.doesNotThrow(() => input.sendAction('start_break', block, 4, { hitPoint: { x: 4, y: 65.5, z: 0.5 } }))
})

test('stationary input serializes through the installed 1.26.60 protocol without NaN vectors', () => {
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const packet = buildStationaryInput({
    position: { x: -73.5, y: 66.62, z: 86.25 }, pitch: 25, yaw: -60, tick: 901n,
    actions: [{ action: 'start_break', position: { x: -74, y: 66, z: 87 }, face: 2 }]
  })
  const encoded = serializer.createPacketBuffer({ name: 'player_auth_input', params: packet })
  const decoded = parser.parsePacketBuffer(encoded).data
  assert.equal(decoded.name, 'player_auth_input')
  assert.equal(decoded.params.tick, 901n)
  assert.deepEqual(decoded.params.input_data, ['block_action'])
  assert.equal(decoded.params.block_action[0].action, 'start_break')
  for (const name of ['move_vector', 'interact_rotation', 'analogue_move_vector', 'raw_move_vector']) {
    assert.ok(Number.isFinite(decoded.params[name].x))
    assert.ok(Number.isFinite(decoded.params[name].z))
  }
  for (const name of ['position', 'delta', 'camera_orientation']) {
    for (const value of Object.values(decoded.params[name])) assert.ok(Number.isFinite(value))
  }
  assert.deepEqual(decoded.params.move_vector, { x: 0, z: 0 })
  assert.deepEqual(decoded.params.delta, { x: 0, y: 0, z: 0 })
})

test('unsupported versions or unconfirmed authority cannot emit inputs', () => {
  assert.throws(() => fixture({ version: '1.26.51' }), /専用/)
  assert.throws(() => fixture({ startGame: { server_authoritative_block_breaking: false } }), /サーバー権威/)
  assert.throws(() => fixture({ startGame: { server_authoritative_block_breaking: true, player_gamemode: 'creative' } }), /サバイバル/)
})

test('ordinary input waits while the spawn position is unconfirmed', () => {
  const { input, state, packets } = fixture()
  state.spawnPending = true
  assert.throws(() => input.start(), /参加位置/)
  assert.equal(packets.length, 0)
})

test('input ticks catch up after long idle periods using the original start-game receive time', t => {
  let now = 1000
  const { input, packets } = fixture({ clock: () => now, startGameReceivedAt: 1000 })
  t.after(() => input.stop())
  now += 300000
  input.start()
  assert.equal(packets[0].params.tick, 6900n)
  input.stop()
  now += 15000
  input.start()
  assert.equal(packets[1].params.tick, 7200n)
})

test('fallback player mode inherits the world mode and only inherited survival is allowed', () => {
  const inheritedMode = worldMode => ({ current_tick: 900n, player_gamemode: 'fallback', world_gamemode: worldMode, server_authoritative_block_breaking: true })
  assert.doesNotThrow(() => fixture({ startGame: inheritedMode('survival') }))
  assert.doesNotThrow(() => fixture({ startGame: { ...inheritedMode(0), player_gamemode: 5 } }))
  assert.throws(() => fixture({ startGame: inheritedMode('creative') }), /サバイバル/)
  assert.throws(() => fixture({ startGame: inheritedMode(undefined) }), /サバイバル/)
})

test('actions are sent once at the next 20Hz tick; stopping aborts an active break and removes the timer', async t => {
  const { input, packets } = fixture()
  t.after(() => input.stop())
  t.mock.timers.enable({ apis: ['setInterval'] })
  input.start()
  assert.equal(packets.length, 1)
  assert.equal(packets[0].params.tick, 901n)
  input.sendAction('start_break', { x: 1, y: 66, z: 2 }, 2)
  assert.equal(packets.length, 1)
  t.mock.timers.tick(50)
  assert.equal(packets.length, 2)
  assert.equal(packets[1].params.block_action[0].action, 'start_break')
  t.mock.timers.tick(50)
  assert.equal(packets.length, 3)
  assert.equal(packets[2].params.block_action, null)
  input.stop()
  assert.equal(packets[3].params.block_action[0].action, 'abort_break')
  assert.equal(input.stats().running, false)
  t.mock.timers.tick(500)
  assert.equal(packets.length, 4)
})

test('lookAt computes Minecraft orientation and invalid or distant actions are refused', () => {
  const { input, state } = fixture()
  const orientation = input.lookAt({ x: 2, y: state.position.y, z: 1 })
  assert.equal(orientation.pitch, -0)
  assert.equal(orientation.yaw, -90)
  input.start()
  try {
    assert.throws(() => input.sendAction('creative_player_destroy_block', { x: 1, y: 66, z: 2 }, 2))
    assert.throws(() => input.sendAction('start_break', { x: 100, y: 66, z: 100 }, 2), /範囲外/)
    assert.throws(() => input.sendAction('start_break', { x: 1.1, y: 66, z: 2 }, 2), /整数/)
    assert.throws(() => input.sendAction('start_break', { x: 1, y: 66, z: 2 }, 7), /0〜5/)
  } finally { input.stop() }
})

test('inventory intent is marked sent only after its next input tick is queued, never when an unsent queue is cancelled', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { input, packets } = fixture()
  t.after(() => input.stop())
  let sent = 0
  const transaction = { legacy: {}, actions: [], data: {} }
  input.start()
  input.sendTransaction(transaction, { onSent: () => sent++ })
  assert.equal(sent, 0)
  input.stop()
  assert.equal(sent, 0)
  input.start()
  input.sendTransaction(transaction, { onSent: () => sent++ })
  t.mock.timers.tick(50)
  assert.equal(sent, 1)
  assert.ok(packets.at(-1).params.input_data.includes('item_interact'))
  t.mock.timers.tick(50)
  assert.equal(sent, 1)
})

test('death or disconnect stops scheduled input without an uncaught timer error', t => {
  const errors = []
  const { input, state, packets } = fixture({ onError: error => errors.push(error.message) })
  t.after(() => input.stop())
  t.mock.timers.enable({ apis: ['setInterval'] })
  input.start()
  state.health = 0
  t.mock.timers.tick(50)
  assert.equal(input.stats().running, false)
  assert.equal(packets.length, 1)
  assert.equal(errors.length, 1)
})

test('a frame provider is passive until start, runs once per frame and supplies finite serialized physics without mutating raw state', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const frames = []
  const { input, state, packets } = fixture({ frameProvider: ({ state, rotation, tick }) => {
    frames.push({ rotation: { ...rotation }, tick })
    state.position.x = 999 // The provider only receives a detached observation.
    return { position: { x: 1.1, y: 66.62, z: 1 }, delta: { x: 0, y: -0.0784, z: 0 }, inputFlags: ['vertical_collision', 'vertical_collision'], physicsState: { position: { x: 1.1, y: 65, z: 1 }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, isCollidedHorizontally: true } }
  } })
  t.after(() => input.stop())
  assert.equal(frames.length, 0)
  assert.equal(packets.length, 0)
  input.lookAt({ x: 2, y: state.position.y, z: 1 })
  assert.equal(frames.length, 0)
  input.start()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].rotation.yaw, -90)
  assert.equal(frames[0].tick, packets[0].params.tick)
  assert.equal(state.position.x, 1)
  assert.equal(state.rotation.yaw, 0)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packets[0])).data.params
  assert.ok(Math.abs(decoded.position.x - 1.1) < 1e-6)
  assert.ok(Math.abs(decoded.delta.y + 0.0784) < 1e-6)
  assert.equal(decoded.input_data.filter(flag => flag === 'vertical_collision').length, 1)
  assert.ok(decoded.input_data.includes('horizontal_collision'))
  t.mock.timers.tick(50)
  assert.equal(frames.length, 2)
  assert.equal(packets.length, 2)
})

test('provider flags cannot invent payload roles or remove actual block and transaction roles', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { input, packets } = fixture({ frameProvider: ({ state }) => ({ position: state.position, delta: { x: 0, y: -0.0784, z: 0 }, inputFlags: ['vertical_collision', 'block_action', 'item_interact', 'item_stack_request', 'client_predicted_vehicle'] }) })
  t.after(() => input.stop())
  input.start()
  assert.deepEqual(packets[0].params.input_data, ['vertical_collision'])
  const target = { x: 1, y: 66, z: 2 }
  input.sendAction('start_break', target, 1)
  let sent = 0
  input.sendTransaction({ legacy: { legacy_request_id: 0, legacy_transactions: null }, actions: [], data: {
    action_type: 'click_block', trigger_type: 'player_input', block_position: target, face: 1,
    hotbar_slot: 0, hand: 'main_hand', held_item: { network_id: 0 }, player_pos: { x: 1, y: 66.62, z: 1 },
    click_pos: { x: 0.5, y: 1, z: 0.5 }, block_runtime_id: 1, client_prediction: 'success', client_cooldown_state: 'off'
  } }, { onSent: () => { assert.ok(packets.at(-1).params.transaction); sent++ } })
  t.mock.timers.tick(50)
  assert.equal(sent, 1)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packets.at(-1))).data.params
  assert.ok(decoded.input_data.includes('vertical_collision'))
  assert.ok(decoded.input_data.includes('block_action'))
  assert.ok(decoded.input_data.includes('item_interact'))
  assert.ok(!decoded.input_data.includes('item_stack_request'))
  assert.ok(!decoded.input_data.includes('client_predicted_vehicle'))
  assert.equal(decoded.block_action[0].action, 'start_break')
  assert.equal(decoded.transaction.data.face, 1)
})

test('invalid provider data is rejected before queueing and a provider failure does not re-enter it to abort an old target', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  assert.throws(() => fixture({ frameProvider: 1 }), /同期関数/)
  for (const invalid of [
    { position: { x: NaN, y: 66, z: 1 }, delta: { x: 0, y: 0, z: 0 } },
    { position: { x: 1, y: 66, z: 1 }, delta: { x: 0, y: Infinity, z: 0 } },
    { position: { x: 1, y: 66, z: 1 }, delta: { x: 0, y: 0, z: 0 }, inputFlags: ['not_a_real_flag'] },
    { position: { x: 1, y: 66, z: 1 }, delta: { x: 0, y: 0, z: 0 }, physicsState: { velocity: { x: 0, y: NaN, z: 0 } } }
  ]) {
    const errors = []
    const instance = fixture({ frameProvider: () => invalid, onError: error => errors.push(error.message) })
    assert.throws(() => instance.input.start())
    assert.equal(instance.packets.length, 0)
    assert.equal(instance.input.stats().running, false)
    assert.equal(errors.length, 1)
  }
  let calls = 0
  let notified = 0
  const errors = []
  const { input, packets } = fixture({ frameProvider: ({ state }) => {
    if (++calls === 3) throw new Error('unknown neutral trajectory')
    return { position: state.position, delta: { x: 0, y: -0.0784, z: 0 } }
  }, onError: error => errors.push(error.message) })
  input.start()
  input.sendAction('start_break', { x: 1, y: 66, z: 2 }, 1)
  t.mock.timers.tick(50)
  input.sendTransaction({ legacy: {}, actions: [], data: {} }, { onSent: () => notified++ })
  t.mock.timers.tick(50)
  assert.equal(calls, 3)
  assert.equal(packets.length, 2)
  assert.equal(notified, 0)
  assert.equal(input.stats().running, false)
  assert.equal(errors.length, 1)
  t.mock.timers.tick(500)
  assert.equal(calls, 3)
})

test('asynchronous provider results fail safely and queue errors never invoke the transaction send callback', async t => {
  const asynchronous = fixture({ frameProvider: () => Promise.reject(new Error('invalid async provider')) })
  assert.throws(() => asynchronous.input.start(), /同期した/)
  assert.equal(asynchronous.packets.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.enable({ apis: ['setInterval'] })
  const queued = []
  const errors = []
  let notified = 0
  const { input } = fixture({ client: { queue: (name, params) => { if (params.transaction) throw new Error('queue failed'); queued.push({ name, params }) } }, frameProvider: ({ state }) => ({ position: state.position, delta: { x: 0, y: -0.0784, z: 0 } }), onError: error => errors.push(error.message) })
  input.start()
  input.sendTransaction({ legacy: {}, actions: [], data: {} }, { onSent: () => notified++ })
  t.mock.timers.tick(50)
  assert.equal(queued.length, 1)
  assert.equal(notified, 0)
  assert.equal(input.stats().running, false)
  assert.equal(errors.length, 1)
})

test('release cancels unsent actions and transaction reservations without interrupting neutral input ticks', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { input, packets } = fixture()
  t.after(() => input.stop())
  let sent = 0
  input.start()
  input.sendAction('start_break', { x: 1, y: 66, z: 2 }, 1)
  input.sendTransaction({ legacy: {}, actions: [], data: {} }, { onSent: () => sent++ })
  input.release()
  assert.equal(input.stats().running, true)
  assert.equal(input.stats().queuedActions, 0)
  t.mock.timers.tick(50)
  assert.equal(sent, 0)
  assert.equal(packets[1].params.block_action, null)
  assert.equal(packets[1].params.transaction, null)
  assert.ok(!packets[1].params.input_data.includes('item_interact'))
  t.mock.timers.tick(50)
  assert.equal(packets.length, 3)
})

test('release queues exactly one next-tick abort and continues idle frames until force-stop', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { input, packets } = fixture()
  input.start()
  input.sendAction('start_break', { x: 1, y: 66, z: 2 }, 1)
  t.mock.timers.tick(50)
  input.release()
  input.release()
  assert.equal(packets.length, 2)
  assert.equal(input.stats().queuedActions, 1)
  t.mock.timers.tick(50)
  assert.equal(packets[2].params.block_action[0].action, 'abort_break')
  assert.equal(input.stats().target, null)
  input.release()
  t.mock.timers.tick(50)
  assert.equal(packets[3].params.block_action, null)
  assert.equal(packets.flatMap(packet => packet.params.block_action ?? []).filter(action => action.action === 'abort_break').length, 1)
  assert.equal(input.stats().running, true)
  input.stop()
  t.mock.timers.tick(500)
  assert.equal(packets.length, 4)
})

test('release followed by a new target sends abort then start in one ordered input frame', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { input, packets } = fixture()
  t.after(() => input.stop())
  const first = { x: 1, y: 66, z: 2 }
  const second = { x: 2, y: 66, z: 1 }
  input.start()
  input.sendAction('start_break', first, 1)
  t.mock.timers.tick(50)
  input.release()
  input.sendAction('start_break', second, 4)
  assert.equal(packets.length, 2)
  assert.equal(input.stats().queuedActions, 2)
  t.mock.timers.tick(50)
  assert.equal(packets.length, 3)
  assert.deepEqual(packets[2].params.block_action.map(action => action.action), ['abort_break', 'start_break'])
  assert.deepEqual(packets[2].params.block_action[0].position, first)
  assert.deepEqual(packets[2].params.block_action[1].position, second)
  assert.deepEqual(input.stats().target, second)
})
