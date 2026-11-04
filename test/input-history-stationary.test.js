'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createInputHistory } = require('../src/input-history')

const scope = { profile: 'player', realmId: 'realm', dimension: 'overworld', connectionId: 'connection', startedAt: 'life', runtimeEntityId: '1', generation: 1 }
function fixture ({ partial = false, observe = true } = {}) {
  let time = 1000; let tick = 1000; let health = 12; let terrain = 'normal'
  const rawPosition = { x: partial ? -0.1 : 0.5, y: 66.6200104, z: 0.5 }
  const world = { getBlock: (x, y, z) => {
    const solid = terrain === 'collision' && y === 65 || terrain !== 'unsupported' && y < 65 && (!partial || x < 0)
    return { known: terrain !== 'unknown', position: { x, y, z }, name: solid ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: solid ? 'block' : 'empty', extra: [] }
  } }
  const physics = createPhysics({ world })
  let physical = physics.fromServer({ position: rawPosition, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } })
  const history = createInputHistory({ physics, now: () => time })
  const observation = { rawPosition, rawStamp: 1000, scope, health, receivedAt: 1000 }
  if (observe) history.observeStationaryRaw(observation)
  const submit = (controls = {}, overrides = {}) => {
    time += 50; tick++
    return history.recordQueued({ tick, receiptConfirmed: true, modeled: true, controls, yaw: -90, pitch: 0, predictedState: structuredClone(physical), packetPosition: physics.toServerPosition(physical), scope, health, queuedAt: time, producer: Object.values(controls).some(Boolean) ? 'navigation' : 'idle', ...overrides })
  }
  const queue = (controls = {}, overrides = {}) => { physical = physics.step(physical, controls); return submit(controls, overrides) }
  const neutral = count => { for (let index = 0; index < count; index++) queue() }
  const witness = overrides => history.witness({ scope, health, position: physics.toServerPosition(physical), ...overrides })
  return { history, physics, observation, rawPosition, queue, submit, neutral, witness, terrain: value => { terrain = value }, health: value => { health = value }, time: value => { time = value }, tick: value => { tick = value }, resetPose: () => { physical = physics.fromServer({ position: rawPosition, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } }) } }
}

test('five-minute raw stationary checkpoint permits later queued movement beyond raw displacement tolerance', () => {
  const f = fixture()
  f.neutral(3000); f.health(13.9); f.neutral(3000)
  assert.equal(f.history.snapshot().stationary.neutralFrames, 8)
  assert.equal(f.witness().reason, 'stationary_motion_not_started')
  const checkpointTick = f.history.snapshot().stationary.checkpointTick
  for (let index = 0; index < 14; index++) f.queue({ forward: true })
  const proof = f.witness()
  assert.equal(proof.ready, true, proof.reason)
  assert.equal(proof.anchor.kind, 'stationary_raw_checkpoint')
  assert.equal(proof.anchor.derived, true)
  assert.equal(proof.anchor.checkpointTick, checkpointTick)
  assert.equal(proof.anchorTick, checkpointTick)
  assert.equal(proof.anchor.rawStamp, 1000)
  assert.equal(proof.anchor.receivedAt, 1000)
  assert.equal(proof.anchor.leaseAt, 301050)
  assert.deepEqual(proof.anchor.rawPosition, f.rawPosition)
  assert.ok(proof.expectedPosition.x - f.rawPosition.x > 0.75)
  assert.equal(proof.predictionOnly, true)
  assert.equal(proof.serverConfirmed, false)
  assert.equal(f.history.snapshot().count, 81)
  const leaseAt = proof.anchor.leaseAt
  f.neutral(10)
  assert.equal(f.witness().anchor.leaseAt, leaseAt)
  f.time(leaseAt + 4000); f.queue()
  assert.equal(f.witness().reason, 'anchor_stale')
  assert.equal(f.history.observeStationaryRaw(f.observation).reason, 'stationary_raw_not_new')
})

test('real partial shape contact remains eligible after eight stable independent neutral steps', () => {
  const f = fixture({ partial: true })
  f.neutral(8); f.queue({ forward: true })
  const proof = f.witness()
  assert.equal(proof.ready, true, proof.reason)
  assert.equal(proof.anchor.physicsState.onGround, true)
  assert.equal(proof.anchor.kind, 'stationary_raw_checkpoint')
})

test('shadow poses, unsupported feet, body collision and unknown terrain cannot bootstrap', () => {
  const shadow = fixture()
  shadow.queue({}, { packetPosition: { ...shadow.rawPosition, x: shadow.rawPosition.x + 0.01 } })
  shadow.neutral(10); shadow.queue({ forward: true })
  assert.equal(shadow.witness().ready, false)
  assert.equal(shadow.history.snapshot().stationary.disabledReason, 'stationary_pose_changed')
  for (const terrain of ['unsupported', 'collision', 'unknown']) {
    const f = fixture(); f.terrain(terrain); f.submit()
    assert.equal(f.witness().ready, false, terrain)
    assert.ok(f.history.snapshot().stationary.disabledReason, terrain)
  }
})

test('eight neutral frames must precede the first motion, without any gap or environment change', () => {
  const early = fixture(); early.neutral(7); early.queue({ forward: true }); early.resetPose(); early.neutral(12)
  assert.equal(early.witness().reason, 'stationary_non_neutral_prefix')
  const gap = fixture(); gap.neutral(4); gap.tick(1005); gap.queue(); gap.neutral(8)
  assert.equal(gap.witness().reason, 'stationary_history_gap')
  const environment = fixture(); environment.neutral(8)
  const changed = environment.physics.fromServer({ position: environment.rawPosition, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } })
  changed.effects = { speed: { amplifier: 1 } }
  environment.submit({}, { predictedState: changed })
  assert.equal(environment.witness().reason, 'stationary_environment_changed')
})

test('damage, force, unmodeled input and lifecycle changes require a new authoritative observation', () => {
  const damage = fixture(); damage.neutral(8); damage.health(11); damage.queue(); damage.health(12); damage.neutral(8)
  assert.equal(damage.witness().reason, 'stationary_damage')
  for (const reason of ['server_motion', 'scope_changed', 'lifecycle_changed']) {
    const f = fixture(); f.neutral(8); f.history.invalidate(reason)
    assert.equal(f.history.observeStationaryRaw(f.observation).reason, 'stationary_raw_not_new')
    f.neutral(8); f.queue({ forward: true })
    assert.equal(f.witness().ready, false, reason)
  }
  const unmodeled = fixture(); unmodeled.neutral(8); unmodeled.submit({}, { modeled: false }); unmodeled.neutral(8); unmodeled.queue({ forward: true })
  assert.equal(unmodeled.witness().reason, 'unmodeled_input')
  const rescope = fixture(); rescope.neutral(8); rescope.queue({}, { scope: { ...scope, generation: 2 } })
  assert.equal(rescope.witness().ready, false)
})

test('a soft input failure before motion requires eight fresh neutral receipts without reobserving raw', () => {
  const f = fixture(); f.neutral(8); f.history.invalidate('input_failed')
  assert.equal(f.history.snapshot().stationary.neutralFrames, 0)
  assert.equal(f.history.observeStationaryRaw(f.observation).reason, 'stationary_raw_not_new')
  f.neutral(7)
  assert.equal(f.witness().reason, 'stationary_neutral_pending')
  f.neutral(1); f.queue({ forward: true })
  assert.equal(f.witness().ready, true)
  const consumed = fixture(); consumed.neutral(8); consumed.queue({ forward: true }); consumed.history.invalidate('input_failed'); consumed.resetPose(); consumed.neutral(8)
  assert.equal(consumed.witness().ready, false)
  assert.equal(consumed.history.observeStationaryRaw(consumed.observation).reason, 'stationary_raw_not_new')
})

test('only a demonstrably neutral missing receipt permits fresh stationary coverage', () => {
  const neutral = fixture(); neutral.neutral(8); neutral.submit({}, { receiptConfirmed: false }); neutral.neutral(8); neutral.queue({ forward: true })
  assert.equal(neutral.witness().ready, true)
  const moving = fixture(); moving.neutral(8); moving.queue({ forward: true }, { receiptConfirmed: false }); moving.resetPose(); moving.neutral(8)
  assert.equal(moving.witness().ready, false)
})

test('moving prefix cannot be hidden by observing an older raw pose and exact correction is preferred', () => {
  const prefix = fixture({ observe: false }); prefix.queue({ forward: true }); prefix.resetPose(); prefix.neutral(100)
  assert.equal(prefix.history.observeStationaryRaw(prefix.observation).reason, 'stationary_moving_prefix', 'moving history remains disqualifying after its frames leave the bounded ring')
  const f = fixture(); f.neutral(8); f.queue({ forward: true })
  assert.equal(f.history.observeStationaryRaw(f.observation).reason, 'stationary_raw_not_new')
  const tick = f.history.snapshot().latestTick
  const current = f.witness()
  const rawPosition = current.expectedPosition
  const physicsState = current.physicsState
  assert.equal(f.history.observeAnchor({ tick, physicsState, rawPosition, rawStamp: 1450, receivedAt: 1450, scope, health: 12 }).ready, true)
  f.queue({ forward: true })
  assert.equal(f.witness().anchor.kind, 'server_correction')
  assert.equal(f.witness().anchor.derived, false)
})

test('a genuinely new authoritative raw can enable fresh neutral proof after hard invalidation', () => {
  const f = fixture(); f.neutral(8); f.history.invalidate('server_motion'); f.resetPose()
  assert.equal(f.history.observeStationaryRaw(f.observation).reason, 'stationary_raw_not_new')
  assert.equal(f.history.observeStationaryRaw({ ...f.observation, rawStamp: 1400, receivedAt: 1400 }).reason, 'stationary_neutral_pending')
  f.neutral(8); f.queue({ forward: true })
  assert.equal(f.witness().ready, true)
  assert.equal(f.witness().anchor.rawStamp, 1400)
})

test('actual own-pose and confirmed-respawn packet times tolerate processing lag without weakening force fences', () => {
  for (const reason of ['authoritative_lifecycle_or_pose_changed', 'authoritative_respawn_cleanup']) {
    const f = fixture(); f.neutral(8); f.time(1402)
    f.history.invalidate(reason, { observedAt: 1400 })
    assert.equal(f.history.observeStationaryRaw({ ...f.observation, rawStamp: 1400, receivedAt: 1400 }).reason, 'stationary_neutral_pending', reason)
    f.neutral(8); f.queue({ forward: true })
    assert.equal(f.witness().ready, true, reason)
  }
  const force = fixture(); force.neutral(8); force.time(1450); force.history.invalidate('server_motion')
  force.time(1452); force.history.invalidate('authoritative_lifecycle_or_pose_changed', { observedAt: 1400 })
  assert.equal(force.history.observeStationaryRaw({ ...force.observation, rawStamp: 1400, receivedAt: 1400 }).reason, 'stationary_raw_precedes_invalidation')
  const cancellation = fixture(); cancellation.neutral(8); cancellation.time(1450)
  cancellation.history.invalidate('actions_stopped', { observedAt: 1400 })
  assert.equal(cancellation.history.observeStationaryRaw({ ...cancellation.observation, rawStamp: 1400, receivedAt: 1400 }).reason, 'stationary_raw_precedes_invalidation', 'a cancellation cannot opt into an old packet-time boundary')
})
