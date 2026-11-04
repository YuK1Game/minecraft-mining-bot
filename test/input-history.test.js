'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInputHistory } = require('../src/input-history')

const scope = { profile: 'player', realmId: 'realm', dimension: 'overworld', connectionId: 'connection', startedAt: 'life', runtimeEntityId: '1', generation: 1 }
const state = (x = 0) => ({ position: { x, y: 65, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, gameMode: 'survival', controls: {}, effects: {}, attributes: {}, isInWater: false, isInLava: false })
const eye = value => ({ ...value.position, y: value.position.y + 1.62 })
function fixture () {
  let time = 1000; let known = true
  const physics = { toServerPosition: eye, blockAt: () => ({ known, name: 'minecraft:air' }), step: (previous, controls) => ({ ...structuredClone(previous), position: { ...previous.position, x: previous.position.x + (controls.forward ? 0.2 : 0) }, controls }) }
  const history = createInputHistory({ physics, now: () => time })
  const record = (tick, x, overrides = {}) => history.recordQueued({ tick, receiptConfirmed: true, modeled: true, controls: { forward: tick > 10 }, yaw: 0, pitch: 0, predictedState: state(x), packetPosition: eye(state(x)), scope, health: 12, queuedAt: time, producer: tick > 10 ? 'navigation' : 'idle', ...overrides })
  const anchor = (overrides = {}) => history.observeAnchor({ tick: 10, physicsState: state(), rawPosition: eye(state()), rawStamp: time, scope, health: 12, receivedAt: time, ...overrides })
  const witness = (x, overrides = {}) => history.witness({ scope, health: 12, position: eye(state(x)), ...overrides })
  record(10, 0)
  return { history, record, anchor, witness, time: value => { time = value }, unknown: () => { known = false } }
}

test('exact correction replays retained idle and navigation queues while raw remains historical', () => {
  const f = fixture()
  f.record(11, 0, { controls: {}, producer: 'idle' })
  for (let tick = 12; tick <= 20; tick++) f.record(tick, (tick - 11) * 0.2)
  assert.equal(f.witness(1.8).ready, false, 'an unanchored ledger is not a proof')
  assert.equal(f.anchor().ready, true)
  const before = f.history.snapshot()
  const result = f.witness(1.8)
  assert.equal(result.ready, true, result.reason)
  assert.ok(Math.abs(result.expectedPosition.x - 1.8) < 1e-9)
  assert.equal(result.anchor.rawPosition.x, 0)
  assert.equal(result.firstTick, '11')
  assert.equal(result.lastTick, '20')
  assert.equal(result.queuedTicks, 10)
  assert.equal(result.navigationQueued, 9)
  assert.equal(result.predictionOnly, true)
  assert.equal(result.serverConfirmed, false)
  const after = f.history.snapshot()
  assert.deepEqual({ ...after, lastWitness: before.lastWitness }, before, 'witnessing does not refresh the anchor or ledger')
  result.physicsState.position.x = 99
  result.anchor.rawPosition.x = 99
  assert.equal(f.witness(1.8).ready, true, 'returned metadata is detached')
})

test('queued receipts, exact retained anchor and every intermediate tick are required', () => {
  const gap = fixture(); gap.anchor(); gap.record(12, 0.4)
  assert.equal(gap.witness(0.4).reason, 'history_gap')
  const receipt = fixture(); receipt.anchor(); receipt.record(11, 0.2, { receiptConfirmed: false })
  assert.equal(receipt.witness(0.2).reason, 'queue_receipt_missing')
  const modeled = fixture(); modeled.anchor(); modeled.record(11, 0.2, { modeled: false })
  assert.equal(modeled.witness(0.2).reason, 'unmodeled_input')
  const missing = fixture(); missing.record(11, 0.2)
  assert.equal(missing.anchor({ tick: 9 }).reason, 'anchor_input_missing')
  const zero = fixture()
  assert.equal(zero.anchor({ tick: 0 }).reason, 'invalid_anchor')
  const noProgress = fixture(); noProgress.anchor()
  assert.equal(noProgress.witness(0).reason, 'queued_progress_missing')
})

test('fixed anchor lease, recent queues and eighty-tick ceiling do not renew at leg boundaries', () => {
  const f = fixture(); f.anchor(); f.record(11, 0.2)
  f.time(1201)
  assert.equal(f.witness(0.2).reason, 'queued_input_stale')
  f.time(5000); f.record(12, 0.4)
  assert.equal(f.witness(0.4).ready, true, 'the exact four-second boundary is allowed')
  f.time(5001); f.record(13, 0.6)
  assert.equal(f.witness(0.6).reason, 'anchor_stale')
  const ticks = fixture(); ticks.anchor()
  for (let tick = 11; tick <= 90; tick++) ticks.record(tick, (tick - 10) * 0.2)
  assert.equal(ticks.witness(16).ready, true)
  ticks.record(91, 16.2)
  assert.equal(ticks.witness(16.2).reason, 'tick_limit')
})

test('working contradiction, received correction contradiction and unknown world fail closed', () => {
  const current = fixture(); current.anchor(); current.record(11, 0.2)
  assert.equal(current.witness(1).reason, 'prediction_contradiction')
  const recorded = fixture(); recorded.anchor(); recorded.record(11, 1)
  assert.equal(recorded.witness(1).reason, 'prediction_contradiction')
  const correction = fixture()
  assert.equal(correction.anchor({ physicsState: state(0.8), rawPosition: eye(state(0.8)) }).reason, 'authoritative_contradiction')
  const unknown = fixture(); unknown.anchor(); unknown.record(11, 0.2); unknown.unknown()
  assert.equal(unknown.witness(0.2).reason, 'unknown_world')
})

test('damage including later healing, scope and movement state changes invalidate a witness', () => {
  const damaged = fixture(); damaged.anchor(); damaged.record(11, 0.2, { health: 11 }); damaged.record(12, 0.4)
  assert.equal(damaged.witness(0.4).reason, 'damage')
  const health = fixture(); health.anchor(); health.record(11, 0.2)
  assert.equal(health.witness(0.2, { health: 11 }).reason, 'damage')
  const generation = fixture(); generation.anchor(); generation.record(11, 0.2)
  assert.equal(generation.witness(0.2, { scope: { ...scope, generation: 2 } }).reason, 'scope_changed')
  const changed = fixture(); changed.anchor(); changed.record(11, 0.2, { predictedState: { ...state(0.2), effects: { speed: 1 } } })
  assert.equal(changed.witness(0.2).reason, 'movement_state_changed')
  changed.history.invalidate('lifecycle_changed')
  assert.equal(changed.witness(0.2).reason, 'lifecycle_changed')
})

test('production dry physics replays queued controls from the exact authoritative post-tick pose', () => {
  const { createPhysics } = require('../src/physics')
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  const physics = createPhysics({ world })
  const history = createInputHistory({ physics, now: () => 1000 })
  let predicted = physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } })
  const saved = []
  for (let tick = 100; tick <= 115; tick++) {
    const controls = { forward: tick >= 103 }
    predicted = physics.step(predicted, controls)
    saved.push({ tick, controls, state: structuredClone(predicted) })
    assert.equal(history.recordQueued({ tick, receiptConfirmed: true, modeled: true, controls, yaw: predicted.yaw, pitch: predicted.pitch, predictedState: predicted, packetPosition: physics.toServerPosition(predicted), scope, health: 12, queuedAt: 1000, producer: controls.forward ? 'navigation' : 'idle' }).accepted, true)
  }
  const corrected = saved[2]
  const rawPosition = { ...physics.toServerPosition(corrected.state), x: corrected.state.position.x + 0.04 }
  const received = physics.fromServer({ position: rawPosition, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } }, { velocity: corrected.state.velocity, onGround: corrected.state.onGround })
  assert.equal(history.observeAnchor({ tick: corrected.tick, physicsState: received, rawPosition, rawStamp: 1000, scope, health: 12, receivedAt: 1000 }).ready, true)
  let expected = { ...structuredClone(corrected.state), position: { ...received.position }, velocity: { ...received.velocity }, onGround: received.onGround, velocitySource: 'server_correction' }
  for (const frame of saved.slice(3)) expected = physics.step({ ...expected, yaw: frame.state.yaw, pitch: frame.state.pitch }, frame.controls)
  const result = history.witness({ scope, health: 12, position: physics.toServerPosition(predicted) })
  assert.equal(result.ready, true, result.reason)
  assert.deepEqual(result.expectedPosition, physics.toServerPosition(expected))
  assert.deepEqual(result.physicsState.position, expected.position)
  assert.equal(result.anchorTick, '102')
  assert.equal(result.queuedTicks, 13)
  assert.deepEqual(result.anchor.rawPosition, rawPosition)
  assert.equal(result.serverConfirmed, false)
})

test('bounded last-witness diagnostics describe failures without becoming proof or changing history', () => {
  const f = fixture()
  assert.equal(f.history.snapshot().lastWitness, null)
  f.anchor(); f.record(11, 0.2)
  const before = f.history.snapshot()
  const result = f.witness(0.2)
  assert.equal(Object.hasOwn(result, 'lastWitness'), false)
  const successful = f.history.snapshot().lastWitness
  assert.deepEqual(successful, { ready: true, reason: null, revision: before.revision, anchorTick: '10', lastTick: '11', queuedTicks: 1, observedAt: 1000, anchorAgeMs: 0, latestQueuedAgeMs: 0 })
  assert.ok(Buffer.byteLength(JSON.stringify(successful)) < 1024)
  successful.reason = 'cannot_mutate_saved_diagnostic'
  assert.equal(f.history.snapshot().lastWitness.reason, null)
  f.time(1201); f.witness(0.2)
  assert.equal(f.history.snapshot().lastWitness.reason, 'queued_input_stale')
  assert.equal(f.history.snapshot().lastWitness.latestQueuedAgeMs, 201)
  f.time(5001); f.witness(0.2)
  assert.equal(f.history.snapshot().lastWitness.reason, 'anchor_stale')
  assert.equal(f.history.snapshot().lastWitness.anchorAgeMs, 4001)
  f.history.invalidate('lifecycle_changed')
  assert.equal(f.history.snapshot().lastWitness, null)
  const gap = fixture(); gap.anchor(); gap.record(12, 0.4); gap.witness(0.4)
  assert.equal(gap.history.snapshot().lastWitness.reason, 'history_gap')
  const contradiction = fixture(); contradiction.anchor(); contradiction.record(11, 0.2); contradiction.witness(1)
  assert.equal(contradiction.history.snapshot().lastWitness.reason, 'prediction_contradiction')
})
