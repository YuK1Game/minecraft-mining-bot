'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics'), { createMovement } = require('../src/movement'), { createNavigator } = require('../src/navigation')
const { previewCriticalHop } = require('../src/critical-hop'), { descendingCriticalFrame } = require('../src/melee-combat')
const captured = require('./fixtures/critical-real-descent.json')
const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', extra: [], properties: {} }) }
const physics = createPhysics({ world, version: '1.26.60' }), navigator = createNavigator({ world, version: '1.26.60', physics })
const state = () => ({ phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 1, rotation: { yaw: 0, pitch: 0 } })
function pair (previous, current, hopId) { return { criticalHopId: hopId, previous: { criticalHopId: hopId, ...previous, packetY: Math.fround(previous.position.y), onGround: previous.physicsState.onGround }, current: { criticalHopId: hopId, ...current, packetY: Math.fround(current.position.y), onGround: current.physicsState.onGround }, deltaY: Math.fround(current.position.y) - Math.fround(previous.position.y) } }
function snapshot (index) { const current = captured.frames[index], previous = captured.frames[index - 1]; return { criticalHopId: captured.criticalHopId, route: { operation: 'critical_hop' }, phase: 'moving', running: true, queuedReceiptConfirmed: current.receiptConfirmed, queuedTick: current.tick, queuedAt: current.queuedAt, predictedPosition: current.position, onGround: current.physicsState.onGround, velocity: current.physicsState.velocity, physicsState: current.physicsState, criticalHopQueuedPair: pair(previous, current, captured.criticalHopId) } }
function allowed (movement) { return descendingCriticalFrame(movement, captured.criticalHopId, { wallNow: movement.queuedAt, workingPosition: movement.predictedPosition }) }

test('actual BDS first-negative-velocity frame still rose .003m and is denied; next actual -.075m frame is eligible only', () => {
  const rising = snapshot(1), falling = snapshot(2)
  assert.ok(rising.physicsState.velocity.y < 0); assert.ok(rising.criticalHopQueuedPair.deltaY > 0)
  assert.ok(Math.abs(captured.frames[1].inputPositionDeltaY - 0.003016261509046103) < 1e-12)
  assert.equal(allowed(rising), false)
  assert.ok(falling.criticalHopQueuedPair.deltaY < 0); assert.ok(falling.physicsState.velocity.y < 0)
  assert.equal(allowed(falling), true)
  assert.equal(captured.observedFirstNegativeVelocityAttemptDamage, captured.observedGroundSwordDamage, 'captured experiment showed no enhanced damage at the still-rising tick')
})

test('missing, unconfirmed, stale, nonadjacent or prior-hop queued evidence cannot authorize a critical attempt', () => {
  for (const mutate of [m => { m.criticalHopQueuedPair = null }, m => { m.criticalHopQueuedPair.previous.receiptConfirmed = false }, m => { m.criticalHopQueuedPair.current.receiptConfirmed = false }, m => { m.criticalHopQueuedPair.previous.queuedAt -= 300 }, m => { m.criticalHopQueuedPair.previous.tick = String(BigInt(m.queuedTick) - 2n) }, m => { m.criticalHopQueuedPair.previous.criticalHopId++ }, m => { m.criticalHopQueuedPair.current.criticalHopId++ }, m => { m.criticalHopQueuedPair.deltaY = -999 }, m => { m.criticalHopQueuedPair.current.position.y -= 1 }, m => { m.criticalHopQueuedPair.current.packetY -= 1 }, m => { m.queuedAt += 1 }, m => { m.physicsState.velocity.y = 0.1; m.velocity.y = 0.1 }, m => { m.phase = 'stopped' }]) {
    const motion = structuredClone(snapshot(2)); mutate(motion); assert.equal(allowed(motion), false)
  }
})

test('forecast and actual Movement postpone the falling window to truly lower consecutive queued packet Y', t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let elapsed = 0
  const packets = [], movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: state, client: { queue (name, packet) { packets.push(packet); return { tick: packet.tick } } } })
  t.after(() => movement.stop()); const first = movement.startHop(), all = [movement.snapshot()]
  while (movement.snapshot().phase === 'moving') { elapsed += 50; t.mock.timers.tick(50); all.push(movement.snapshot()) }
  const firstNegative = all.findIndex(m => m.onGround === false && m.velocity.y < -0.001), firstFalling = all.findIndex(m => m.onGround === false && m.velocity.y < -0.001 && m.criticalHopQueuedPair?.deltaY < 0)
  assert.equal(firstFalling, firstNegative + 1); assert.equal(first.route.firstDescendingTick, firstFalling + 1)
  assert.ok(all[firstNegative].criticalHopQueuedPair.deltaY > 0); assert.ok(all[firstFalling].criticalHopQueuedPair.deltaY < 0)
  assert.equal(all[firstFalling].criticalHopQueuedPair.current.tick, all[firstFalling].queuedTick)
  assert.equal(all[firstFalling].criticalHopQueuedPair.current.packetY, Math.fround(packets[firstFalling].position.y))
  assert.equal(movement.snapshot().physicsState.onGround, true)
  const forecast = previewCriticalHop({ physics, initial: physics.fromServer(state()), verifyStanding: s => navigator.verifyOrigin(s) })
  assert.equal(forecast.firstDescendingTick, firstFalling + 1)
})

test('new runs, missing queue receipts and stops reset pair ownership before another hop', t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let elapsed = 0, count = 0
  const movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: state, client: { queue (name, packet) { return ++count === 3 ? undefined : { tick: packet.tick } } } })
  t.after(() => movement.stop()); movement.startHop(); assert.equal(movement.snapshot().criticalHopQueuedPair, null)
  elapsed += 50; t.mock.timers.tick(50); assert.ok(movement.snapshot().criticalHopQueuedPair)
  elapsed += 50; t.mock.timers.tick(50); assert.equal(movement.snapshot().criticalHopQueuedPair, null)
  elapsed += 50; t.mock.timers.tick(50); assert.equal(movement.snapshot().criticalHopQueuedPair, null)
  elapsed += 50; t.mock.timers.tick(50); assert.ok(movement.snapshot().criticalHopQueuedPair)
  movement.stop(); assert.equal(movement.snapshot().criticalHopQueuedPair, null)
  const next = movement.startHop(); assert.equal(next.criticalHopId, 2); assert.equal(next.criticalHopQueuedPair, null)
})
