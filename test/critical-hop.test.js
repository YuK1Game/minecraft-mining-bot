'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = (() => {
  if (!process.env.MOVEMENT_TEST_SOURCE) return require('../src/movement')
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
  const filename = path.resolve(__dirname, '../src/movement.js')
  const loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(path.resolve(process.env.MOVEMENT_TEST_SOURCE), 'utf8'), filename)
  return loaded.exports
})()
const { previewCriticalHop, createCriticalHopStepper } = require('../src/critical-hop')

let unknownHead = false
const world = { getBlock: (x, y, z) => unknownHead && y === 68 && x === 0 && z === 0 ? { known: false } : { known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' } }
const physics = createPhysics({ world, version: '1.26.60' })
const navigator = createNavigator({ world, version: '1.26.60', physics })
const fresh = () => ({ phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, positionUpdatedAt: 1, positionSource: 'server_post_move', rotation: { yaw: 0, pitch: 0 } })
const verifyStanding = state => navigator.verifyOrigin(state)

test('native stationary hop has one jump, a descending airborne interval and full landing', () => {
  const initial = physics.fromServer(fresh())
  const proof = previewCriticalHop({ physics, initial, verifyStanding })
  assert.equal(proof.ready, true, proof.reason)
  const stepper = createCriticalHopStepper({ physics, initial, verifyStanding })
  const frames = []
  for (let n = 0; n < 32; n++) { const f = stepper.next(); frames.push(f); if (f.phase === 'awaiting_server_confirmation') break }
  assert.equal(frames.filter(f => f.controls.jump).length, 1)
  assert.ok(frames.some(f => f.predictedState.onGround === false && f.predictedState.velocity.y < 0))
  const firstDescendingTick = frames.findIndex((f, index) => index > 0 && !f.predictedState.onGround && f.predictedState.velocity.y < -0.001 && Math.fround(f.packetPosition.y) < Math.fround(frames[index - 1].packetPosition.y)) + 1
  assert.equal(proof.firstDescendingTick, firstDescendingTick)
  assert.ok(proof.firstDescendingTick > 1 && proof.firstDescendingTick < proof.ticks)
  assert.equal(frames.at(-1).predictedState.onGround, true)
  assert.deepEqual(frames.at(-1).predictedState.position, initial.position)
})

test('unknown apex headspace and actual water cannot authorize a critical hop', () => {
  const initial = physics.fromServer(fresh())
  unknownHead = true
  try { assert.equal(previewCriticalHop({ physics, initial, verifyStanding }).ready, false) } finally { unknownHead = false }
  assert.equal(previewCriticalHop({ physics, initial: { ...initial, isInWater: true }, verifyStanding }).ready, false)
})

test('Movement exposes only actual queued-hop receipt evidence and stop revokes it', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const state = fresh(); let elapsed = 0; const packets = []
  // Movement receives the Runtime's pinned motion origin; its private native
  // state advances while working predictions are published to other actors.
  const movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: () => structuredClone(state), client: { queue (name, packet) { packets.push(packet); return { tick: packet.tick } } } })
  t.after(() => movement.stop())
  const initial = movement.startHop({ aimPoint: { x: 1.5, y: 66, z: 0.5 } })
  assert.equal(initial.criticalHopId, 1)
  assert.equal(initial.route.operation, 'critical_hop')
  let descending = null
  for (let n = 0; n < 32 && movement.snapshot().phase === 'moving'; n++) { elapsed += 50; t.mock.timers.tick(50); const s = movement.snapshot(); if (!s.onGround && s.velocity.y < 0) descending = s }
  assert.ok(descending, JSON.stringify(movement.snapshot()))
  assert.equal(descending.queuedReceiptConfirmed, true)
  assert.equal(descending.queuedTick, descending.tick)
  assert.ok(Number.isFinite(descending.queuedAt))
  assert.equal(packets.filter(p => p.input_data.includes('start_jumping')).length, 1)
  movement.stop()
  assert.equal(movement.snapshot().queuedReceiptConfirmed, false)
})

test('a queue without a returned receipt cannot provide critical evidence', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => 0, getState: fresh, client: { queue () {} } })
  t.after(() => movement.stop())
  assert.equal(movement.startHop().queuedReceiptConfirmed, false)
})

test('confirmed living critical health can still jump, while death cannot', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const state = fresh(); state.health = 1
  const movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => 0, getState: () => state, client: { queue: (name, packet) => ({ tick: packet.tick }) } })
  t.after(() => movement.stop())
  assert.equal(movement.previewHop().ready, true)
  movement.startHop(); movement.stop()
  state.health = 0; state.dead = true
  assert.equal(movement.previewHop().ready, false)
})
