'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createInputHistory } = require('../src/input-history')
const { createInput } = require('../src/input')
const { createMovement } = require('../src/movement')

const scope = { profile: 'player', realmId: 'realm', dimension: 'overworld', connectionId: 'connection', startedAt: 'life', runtimeEntityId: '1', generation: 1 }
function fixture (t) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = 0; let clockOffset = 0; let actualTick = -1n; let prediction = null; let motionOrigin = null; let receiptOffset = 0n; let receiptMissing = false
  t.mock.method(Date, 'now', () => time)
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  const physics = createPhysics({ world })
  const base = { ...scope, phase: 'spawned', gameMode: 'survival', health: 12, position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 'raw', rotation: { yaw: -90, pitch: 0 } }
  const working = () => prediction ? { ...structuredClone(base), position: { ...prediction.position }, positionSource: 'client_prediction', positionUpdatedAt: String(time), predicted: structuredClone(prediction) } : structuredClone(base)
  const history = createInputHistory({ physics, now: () => time })
  const packets = []; const records = []
  const client = { queue: (name, packet) => {
    actualTick = (packet.tick > actualTick ? packet.tick : actualTick + 1n) + receiptOffset
    packets.push({ name, packet: { ...packet, tick: actualTick }, queuedAt: time })
    return receiptMissing ? null : { tick: actualTick }
  } }
  const onQueuedFrame = frame => { records.push(frame); history.recordQueued({ ...frame, scope }) }
  const common = { client, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => time + clockOffset, onQueuedFrame, getQueuedCursor: () => history.snapshot().cursor }
  const input = createInput({ ...common, getState: working, frameProvider: () => {
    const controls = { jump: false }
    const physical = physics.step(physics.fromServer(working()), controls)
    const position = physics.toServerPosition(physical)
    return { position, delta: physical.velocity, controls, predictedState: physical, commitPrediction: () => { prediction = { position, physicsState: physical } } }
  } })
  const movement = createMovement({ ...common, getState: () => motionOrigin ?? working(), world, onPrediction: value => { prediction = value } })
  t.after(() => { input.stop(false); movement.stop() })
  return { input, movement, history, packets, records, working, physics, advance: milliseconds => { time += milliseconds; t.mock.timers.tick(milliseconds) }, elapse: milliseconds => { time += milliseconds }, shiftClock: milliseconds => { clockOffset += milliseconds }, startMovement: target => { motionOrigin = working(); return movement.start(target, { emergency: true }) }, endMovement: () => { movement.stop('Route ended'); motionOrigin = null }, anchor: () => history.observeAnchor({ tick: actualTick, physicsState: prediction.physicsState, rawPosition: prediction.position, rawStamp: time, receivedAt: time, scope, health: 12 }), witness: () => history.witness({ scope, health: 12, position: working().position }), offset: value => { receiptOffset = value }, missing: () => { receiptMissing = true } }
}

test('real idle to navigation to idle starts queue every bounded missing tick with host-monotonic receipts', t => {
  const f = fixture(t)
  f.input.start()
  f.advance(100)
  assert.equal(f.anchor().ready, true)
  const anchor = f.history.snapshot().anchorTick
  f.input.stop(false)
  f.elapse(150)
  const beforeNavigation = f.records.length
  f.startMovement({ x: 1.5, y: 65, z: 0.5 })
  assert.equal(f.records.length - beforeNavigation, 3, 'all three initial movement ticks were modeled and queued')
  for (let count = 0; count < 80 && f.movement.snapshot().phase === 'moving'; count++) f.advance(50)
  assert.equal(f.movement.snapshot().phase, 'awaiting_server_confirmation')
  f.endMovement()
  const beforeIdle = f.records.length
  f.elapse(150)
  f.input.start()
  assert.equal(f.records.length - beforeIdle, 3, 'all three resumed neutral physics ticks were queued')
  for (let index = 1; index < f.records.length; index++) assert.equal(f.records[index].tick, f.records[index - 1].tick + 1n)
  assert.ok(f.records.every(frame => frame.modeled && frame.receiptConfirmed))
  const proof = f.witness()
  assert.equal(proof.ready, true, proof.reason)
  assert.equal(proof.anchorTick, anchor, 'handoffs never replace or renew the correction anchor')
  assert.equal(proof.physicsTrace.length, proof.queuedTicks + 1)
  assert.ok(proof.physicsTrace.length <= 81)
  assert.equal(proof.physicsTrace[0].tick, proof.anchorTick)
  assert.deepEqual(proof.physicsTrace.at(-1).position, proof.expectedPosition)
  assert.deepEqual(proof.anchor.physicsState, proof.physicsTrace[0].physicsState)
  assert.equal(Object.hasOwn(f.history.snapshot(), 'physicsTrace'), false)
})

test('handoff wall-clock stall sends no fabricated catchup for either sender', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  f.elapse(201)
  const before = f.packets.length
  assert.throws(() => f.input.start(), /handoff timer stalled/)
  assert.throws(() => f.startMovement({ x: 1.5, y: 65, z: 0.5 }), /handoff timer stalled/)
  assert.equal(f.packets.length, before)
  assert.equal(f.witness().reason, 'queued_progress_missing')
})

test('a host receipt gap cannot be represented by one simulated navigation tick', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  f.elapse(50); f.offset(3n)
  const before = f.packets.length
  const status = f.startMovement({ x: 1.5, y: 65, z: 0.5 })
  assert.equal(status.phase, 'failed')
  assert.match(status.reason, /receipt is invalid/)
  assert.equal(f.packets.length - before, 1)
  assert.equal(f.witness().reason, 'history_gap')
})

test('an absent actual queue receipt cannot commit a modeled resumed input', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  const before = f.working().position
  f.elapse(50); f.missing()
  assert.throws(() => f.input.start(), /receipt does not cover/)
  assert.equal(f.history.snapshot().cursor, null)
  assert.equal(f.witness().reason, 'queue_receipt_missing')
  assert.deepEqual(f.working().position, before)
})

test('the four-tick and 200ms seam boundary queues four real frames, while cancellation still invalidates', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  f.elapse(200)
  const before = f.records.length
  f.startMovement({ x: 2.5, y: 65, z: 0.5 })
  assert.equal(f.records.length - before, 4)
  assert.equal(f.witness().ready, true)
  f.endMovement()
  assert.equal(f.witness().reason, 'unmodeled_input')
  f.elapse(100); f.input.start()
  assert.equal(f.witness().ready, false, 'a resumed idle frame cannot restore the discarded correction anchor')
})

test('five due seam ticks reject even when the wall-clock age is only 200ms', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  f.elapse(200); f.shiftClock(50)
  const before = f.packets.length
  assert.throws(() => f.input.start(), /Too many queued input handoff ticks/)
  assert.throws(() => f.startMovement({ x: 1.5, y: 65, z: 0.5 }), /Too many queued movement handoff ticks/)
  assert.equal(f.packets.length, before)
})

test('direct active-break stop queues the missing neutral tick before its abort', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.elapse(100)
  f.input.stop()
  assert.deepEqual(f.packets.map(packet => packet.packet.tick), [1001n, 1002n, 1003n, 1004n])
  assert.equal(f.packets[1].packet.block_action[0].action, 'start_break')
  assert.equal(f.packets[2].packet.block_action, null)
  assert.equal(f.packets[3].packet.block_action[0].action, 'abort_break')
  assert.ok(f.records.every(frame => frame.modeled && frame.receiptConfirmed))
  assert.equal(f.input.stats().lastError, null)
  assert.equal(f.input.stats().running, false)
  assert.equal(f.witness().ready, true)
})

test('direct active-break stop forces one genuine abort frame in the same clock bucket', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.input.stop()
  assert.deepEqual(f.packets.map(packet => packet.packet.tick), [1001n, 1002n, 1003n])
  assert.equal(f.packets.at(-1).packet.block_action[0].action, 'abort_break')
  assert.equal(f.records.at(-1).modeled, true)
  assert.equal(f.witness().ready, true)
})

test('direct abort at the four-tick and 200ms boundary queues neutral frames then its abort', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.elapse(200)
  f.input.stop()
  assert.deepEqual(f.packets.map(packet => packet.packet.tick), [1001n, 1002n, 1003n, 1004n, 1005n, 1006n])
  assert.ok(f.packets.slice(2, -1).every(packet => packet.packet.block_action === null))
  assert.equal(f.packets.at(-1).packet.block_action[0].action, 'abort_break')
  assert.equal(f.witness().ready, true)
})

test('direct abort refuses five due ticks without fabricating an abort or queued proof', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.elapse(200); f.shiftClock(50)
  const before = f.packets.length
  f.input.stop()
  assert.equal(f.packets.length, before)
  assert.match(f.input.stats().lastError, /Too many queued input handoff ticks/)
  assert.equal(f.witness().ready, false)
})

test('direct abort refuses a 201ms stall without fabricating an abort or queued proof', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.elapse(201)
  const before = f.packets.length
  f.input.stop()
  assert.equal(f.packets.length, before)
  assert.match(f.input.stats().lastError, /handoff timer stalled/)
  assert.equal(f.witness().ready, false)
})

test('direct abort stops catchup after a missing receipt and cannot publish queued proof', t => {
  const f = fixture(t)
  f.input.start(); f.input.sendAction('start_break', { x: 1, y: 65, z: 0 }, 1); f.advance(100); f.anchor()
  f.elapse(100); f.missing()
  const before = f.packets.length
  f.input.stop()
  assert.equal(f.packets.length - before, 1, 'the missing first neutral receipt prevents the later abort tick')
  assert.equal(f.packets.at(-1).packet.block_action, null)
  assert.match(f.input.stats().lastError, /receipt does not cover/)
  assert.equal(f.witness().reason, 'queue_receipt_missing')
})
