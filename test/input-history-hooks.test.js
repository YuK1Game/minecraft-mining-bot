'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInput } = require('../src/input')
const { createMovement } = require('../src/movement')

const state = () => ({ phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 12, runtimeEntityId: '1', positionUpdatedAt: 'raw', position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 } })
const physical = () => ({ position: { x: 0.5, y: 65, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, yaw: -90, pitch: 0, onGround: true, gameMode: 'survival', controls: { jump: false } })
function inputFixture ({ receipt = { tick: 1234n }, queueFailure = false } = {}) {
  const calls = []; const queued = []
  const input = createInput({ version: '1.26.60', startGame: { current_tick: 100n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => 0, getState: state, client: { queue: () => { calls.push('queue'); if (queueFailure) throw new Error('queue failed'); return receipt } }, frameProvider: () => ({ position: state().position, delta: physical().velocity, predictedState: physical(), controls: { jump: false }, commitPrediction: () => calls.push('commit') }), onQueuedFrame: frame => { calls.push('receipt'); queued.push(frame) } })
  return { input, calls, queued }
}

test('idle evidence and prediction commit follow successful queue acceptance with actual receipt tick', t => {
  const f = inputFixture()
  t.after(() => f.input.stop(false))
  f.input.start()
  assert.deepEqual(f.calls, ['queue', 'receipt', 'commit'])
  assert.equal(f.queued[0].tick, 1234n)
  assert.equal(f.queued[0].receiptConfirmed, true)
  assert.equal(f.queued[0].modeled, true)
  assert.equal(f.queued[0].producer, 'input')
  assert.deepEqual(f.queued[0].packetPosition, state().position)
  assert.deepEqual(f.queued[0].predictedState, physical())
})

test('failed queue cannot publish prediction or evidence; absent receipt stays explicitly unconfirmed', t => {
  const failed = inputFixture({ queueFailure: true })
  assert.throws(() => failed.input.start(), /queue failed/)
  assert.deepEqual(failed.calls, ['queue'])
  assert.equal(failed.queued.length, 0)
  const noReceipt = inputFixture({ receipt: null })
  t.after(() => noReceipt.input.stop(false))
  noReceipt.input.start()
  assert.equal(noReceipt.queued[0].tick, null)
  assert.equal(noReceipt.queued[0].receiptConfirmed, false)
  assert.deepEqual(noReceipt.calls, ['queue', 'receipt', 'commit'])
})

test('navigation evidence uses actual receipt and active unsimulated release invalidates only its witness', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const queued = []; const events = []; let tick = 200n
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
  const movement = createMovement({ version: '1.26.60', startGame: { current_tick: 100n }, startGameReceivedAt: 0, clock: () => 0, world, getState: state, client: { queue: () => { events.push('queue'); return { tick: tick++ } } }, onQueuedFrame: frame => { events.push('receipt'); queued.push(frame) }, onPrediction: () => events.push('prediction') })
  t.after(() => movement.stop())
  movement.start({ x: 2.5, y: 65, z: 0.5 }, { emergency: true })
  assert.deepEqual(events, ['queue', 'receipt', 'prediction'])
  assert.equal(queued[0].tick, 200n)
  assert.equal(queued[0].modeled, true)
  assert.equal(queued[0].producer, 'navigation')
  movement.stop('cancel active motion')
  assert.equal(queued.at(-1).tick, 201n)
  assert.equal(queued.at(-1).modeled, false)
  assert.deepEqual(queued.at(-1).controls, {})
  assert.equal(movement.snapshot().phase, 'stopped')
})

test('normal terminal navigation cleanup sends no unsimulated release', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const queued = []; let time = 0
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
  const movement = createMovement({ version: '1.26.60', startGame: { current_tick: 100n }, startGameReceivedAt: 0, clock: () => time, world, getState: state, client: { queue: (name, packet) => ({ tick: packet.tick }) }, onQueuedFrame: frame => queued.push(frame) })
  t.after(() => movement.stop())
  movement.start({ x: 1.5, y: 65, z: 0.5 }, { emergency: true })
  for (let index = 0; index < 100 && movement.snapshot().phase === 'moving'; index++) { time += 50; t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation')
  const count = queued.length
  movement.stop('Route ended')
  assert.equal(queued.length, count)
  assert.ok(queued.every(frame => frame.modeled === true))
})
