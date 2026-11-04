'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createPhysics } = require('../src/physics')
const { evaluateThreats } = require('../src/threats')
const capture = require('./fixtures/knockback-short-grass-origin.json')
const registry = require('prismarine-registry')('bedrock_1.26.60')
const block = (name, extra = []) => ({ known: true, name: `minecraft:${name}`, properties: {}, extra })
const capturedBlocks = new Map(capture.blocks.map(([x, y, z, name]) => [`${x},${y},${z}`, block(name)]))
const grassKey = '-11,66,29'
const target = { x: -10.65, y: 67, z: 28.35 }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const eye = p => ({ ...p, y: p.y + 1.62 })

function fixture () {
  const replacements = new Map()
  const world = { getBlock: (x, y, z) => replacements.get(`${x},${y},${z}`) ?? capturedBlocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside received capture' } }
  const physics = createPhysics({ world, registry })
  const navigator = createNavigator({ world, physics })
  return { replacements, world, physics, navigator, initial: structuredClone(capture.physicsState) }
}

test('captured knockback origin is a stable dry partial ledge despite empty short grass below one edge', () => {
  const f = fixture(); const before = structuredClone(f.initial)
  assert.equal(capture.observedAt, '2026-10-31T18:58:19.203Z')
  assert.equal(f.physics.blockAt({ x: -11, y: 66, z: 29 }).name, 'short_grass')
  assert.deepEqual(f.physics.blockAt({ x: -11, y: 66, z: 29 }).shapes, [])
  assert.equal(f.physics.hasSupport(f.initial.position), true)
  assert.equal(f.navigator.verifyOrigin(f.initial), false, 'short grass does not supply full support')
  assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), true)
  let neutral = structuredClone(f.initial)
  for (let tick = 0; tick < 8; tick++) {
    neutral = f.physics.step(neutral, {})
    assert.deepEqual(neutral.position, before.position)
    assert.equal(neutral.onGround, true)
    assert.equal(neutral.isInWater, false)
    assert.equal(neutral.isInLava, false)
  }
  const unsafeArrival = f.navigator.plan(f.initial, f.initial.position, { maxDistance: 1, maxExpanded: 32, exactGoal: true, stablePartialOrigin: true })
  assert.equal(unsafeArrival.ready, false, 'the partial origin is not a fully supported arrival')
  assert.deepEqual(f.initial, before)
})

test('ordinary guarded recenter from the exact capture restores full support and moves away from the skeleton', () => {
  const f = fixture(); const before = structuredClone(f.initial)
  const threats = evaluateThreats({ position: capture.position, health: 12, threatPolicy: 'balanced_mining' }, capture.actors, { observationRadius: 32 })
  assert.deepEqual(threats.threats.map(actor => actor.runtimeId), ['8'])
  const primary = threats.threats[0]
  const actors = [...threats.threats, ...threats.outsideDanger]
  const avoidanceFor = point => actors.map(actor => {
    const minDistance = actor.dangerous ? actor.distance : actor.dangerRadius
    return { id: actor.runtimeId, position: actor.position, minDistance, padding: Math.min(0.5, Math.max(0, distance(actor.position, eye(point)) - minDistance)) }
  })
  const options = { maxDistance: 2, maxExpanded: 64, exactGoal: true, stablePartialOrigin: true, avoidance: avoidanceFor(target) }
  const route = f.navigator.plan(f.initial, target, options)
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.origin, before.position)
  assert.deepEqual(route.waypoints.map(w => w.action), ['walk'])
  assert.equal(route.serverConfirmed, false)
  const stepper = f.navigator.createStepper(route, f.initial, { maxTicks: 40, sprint: false })
  let frame; let previous = before.position; let previousDistance = primary.distance; let fullAt = null
  for (let tick = 1; tick <= 40; tick++) {
    frame = stepper.next()
    const state = frame.predictedState
    assert.equal(state.onGround, true)
    assert.equal(state.isInWater, false)
    assert.equal(state.isInLava, false)
    assert.equal(state.position.y, before.position.y)
    // The measured1.26.60 walking profile moves up to.21586blocks per20Hz
    // tick; the old.15 ceiling encoded the dependency's slower fitted speed.
    assert.ok(Math.hypot(state.position.x - previous.x, state.position.z - previous.z) < 0.216, 'movement uses calibrated bounded physical ticks')
    const separation = distance(primary.position, eye(state.position))
    assert.ok(separation >= previousDistance - 1e-9)
    if (f.navigator.verifyOrigin(state) && fullAt === null) fullAt = tick
    previous = state.position; previousDistance = separation
    if (frame.phase !== 'moving') break
  }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(fullAt, 4, 'calibrated walking reaches the same proven full support one tick earlier')
  assert.equal(f.navigator.verifyOrigin(frame.predictedState), true)
  // The calibrated controller settles31mm from the chosen landing instead
  // of preserving the old fitted model's extra coasting separation.
  assert.ok(distance(frame.predictedState.position, { x: -10.624439409711089, y: 67, z: 28.367588756547416 }) < 1e-9)
  assert.ok(distance(frame.predictedState.position, target) < 0.05)
  assert.ok(previousDistance > primary.distance)
  const toward = { x: -9.5, y: 67, z: 28.5 }
  assert.equal(f.navigator.plan(f.initial, toward, { ...options, avoidance: avoidanceFor(toward) }).ready, false)
  assert.deepEqual(f.initial, before)
})

test('the captured raw airborne position remains ineligible and no wall repair is introduced', () => {
  const f = fixture()
  const raw = f.physics.fromServer({ position: capture.rawServerPosition, gameMode: 'survival' })
  assert.equal(raw.onGround, false)
  assert.equal(f.physics.hasSupport(raw.position), false)
  assert.equal(f.navigator.verifyOrigin(raw, { stablePartialOrigin: true }), false)
  assert.equal(f.physics.repairHorizontalContact(f.initial, raw), null)
})

test('partial vegetation space still rejects unknown geometry, secondary layers and hazards', () => {
  const f = fixture()
  for (const replacement of [
    { known: false, reason: 'not received' },
    block('short_grass', [{ known: false, reason: 'secondary layer not received' }]),
    block('short_grass', [{ known: true, name: 'minecraft:water', properties: { liquid_depth: 0 } }]),
    block('short_grass', [{ known: true, name: 'minecraft:stone', properties: {} }]),
    block('cobweb'), block('cactus'), block('fire'),
    { ...block('water'), properties: { liquid_depth: 0 } }
  ]) {
    f.replacements.set(grassKey, replacement)
    assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), false, JSON.stringify(replacement))
    assert.equal(f.navigator.plan(f.initial, target, { maxDistance: 2, maxExpanded: 64, exactGoal: true, stablePartialOrigin: true }).ready, false)
  }
})

test('short grass cannot substitute for real contact or forgive a nonempty collision shape', () => {
  const f = fixture()
  const nonemptyPhysics = { ...f.physics, blockAt: point => {
    const value = f.physics.blockAt(point)
    return `${value.position.x},${value.position.y},${value.position.z}` === grassKey ? { ...value, shapes: [[0, 0, 0, 1, 1, 1]] } : value
  } }
  const nonempty = createNavigator({ world: f.world, physics: nonemptyPhysics })
  assert.equal(nonempty.verifyOrigin(f.initial, { stablePartialOrigin: true }), false)
  f.replacements.set('-11,66,28', block('short_grass'))
  f.replacements.set('-10,66,28', block('short_grass'))
  assert.equal(f.physics.hasSupport(f.initial.position), false)
  assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), false)
  assert.equal(f.navigator.plan(f.initial, target, { maxDistance: 2, maxExpanded: 64, exactGoal: true, stablePartialOrigin: true }).ready, false)
})
