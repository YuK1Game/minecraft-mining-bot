'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')

function block (name, properties = {}) { return { known: true, name: `minecraft:${name}`, properties, extra: [] } }
function initial (physics, { x = 0.5, y = 65, z = 0.5, yaw = -90 } = {}) {
  return physics.fromServer({ position: { x, y: y + 1.62, z }, rotation: { pitch: 0, yaw }, gameMode: 'survival' })
}
function flatWorld (override = () => null) {
  return { getBlock: (x, y, z) => override(x, y, z) ?? block(y < 65 ? 'stone' : 'air') }
}
function run (physics, state, control, ticks) {
  for (let i = 0; i < ticks; i++) state = physics.step(state, typeof control === 'function' ? control(i) : control)
  return state
}

test('one-tick prediction is deterministic, preserves inputs, and converts feet/eye and Bedrock yaw correctly', () => {
  const physics = createPhysics({ world: flatWorld() })
  const state = initial(physics)
  const before = structuredClone(state)
  const next = physics.step(state, { forward: true })
  assert.deepEqual(state, before)
  assert.deepEqual(physics.step(state, { forward: true }), next)
  assert.ok(next.position.x > state.position.x)
  assert.ok(Math.abs(next.position.z - state.position.z) < 1e-8)
  assert.equal(next.onGround, true)
  assert.deepEqual(physics.toServerPosition(state), { x: 0.5, y: 66.62, z: 0.5 })
  assert.equal(physics.capabilities.serverAcceptanceVerified, false)
})

test('exact network properties select distinct slab and stair collision shapes; incomplete state never defaults silently', () => {
  let current = block('oak_slab', { 'minecraft:vertical_half': 'bottom' })
  const physics = createPhysics({ world: { getBlock: () => current } })
  assert.deepEqual(physics.blockAt({ x: 0, y: 65, z: 0 }).shapes, [[0, 0, 0, 1, 0.5, 1]])
  current = block('oak_slab', { 'minecraft:vertical_half': 'top' })
  assert.deepEqual(physics.blockAt({ x: 0, y: 65, z: 0 }).shapes, [[0, 0.5, 0, 1, 1, 1]])
  current = block('oak_slab')
  assert.throws(() => physics.blockAt({ x: 0, y: 65, z: 0 }), /incomplete block state/)
  current = { known: false, reason: 'not received' }
  assert.throws(() => physics.blockAt({ x: 0, y: 65, z: 0 }), /Unknown terrain/)
  current = block('does_not_exist')
  assert.throws(() => physics.blockAt({ x: 0, y: 65, z: 0 }), /incomplete block state/)
})

test('walking collides with a full-height wall instead of phasing; slab contact uses half-block geometry', () => {
  const physics = createPhysics({ world: flatWorld((x, y) => x === 2 && y >= 65 && y < 67 ? block('stone') : null) })
  const stopped = run(physics, initial(physics), { forward: true }, 45)
  assert.ok(stopped.position.x <= 1.700001)
  assert.equal(stopped.isCollidedHorizontally, true)
  assert.ok(Math.abs(stopped.position.y - 65) < 1e-6)
  const slabPhysics = createPhysics({ world: flatWorld((x, y) => x >= 1 && x <= 4 && y === 65 ? block('oak_slab', { 'minecraft:vertical_half': 'bottom' }) : null) })
  const stepped = run(slabPhysics, initial(slabPhysics), { forward: true }, 24)
  assert.ok(stepped.position.x > 1.3)
  assert.ok(Math.abs(stepped.position.y - 65.5) < 1e-6)
})

test('jump rises about 1.25 blocks, clears a one-block obstacle, and returns to solid ground', () => {
  const physics = createPhysics({ world: flatWorld() })
  let state = initial(physics)
  let maximumY = state.position.y
  for (let i = 0; i < 30; i++) {
    state = physics.step(state, { jump: i === 0 })
    maximumY = Math.max(maximumY, state.position.y)
  }
  assert.ok(maximumY > 66.1 && maximumY < 66.4)
  assert.ok(Math.abs(state.position.y - 65) < 1e-6)
  assert.equal(state.onGround, true)
  const obstacle = createPhysics({ world: flatWorld((x, y) => x === 1 && y === 65 ? block('stone') : null) })
  const crossed = run(obstacle, initial(obstacle), i => ({ forward: true, jump: i === 0 }), 35)
  assert.ok(crossed.position.x > 2)
  assert.ok(Math.abs(crossed.position.y - 65) < 1e-6)
})

test('water is disabled by default; explicit experimental water model sinks or rises without claiming live validation', () => {
  const ocean = { getBlock: (x, y) => block(y < 60 ? 'stone' : y < 75 ? 'water' : 'air', y >= 60 && y < 75 ? { liquid_depth: 0 } : {}) }
  const disabled = createPhysics({ world: ocean })
  assert.throws(() => initial(disabled), /Water prediction/)
  const physics = createPhysics({ world: ocean, allowWater: true })
  const state = initial(physics, { y: 65 })
  const sunk = run(physics, state, {}, 15)
  const risen = run(physics, state, { forward: true, jump: true }, 15)
  assert.equal(sunk.isInWater, true)
  assert.ok(sunk.position.y < state.position.y)
  assert.ok(risen.position.y > state.position.y)
  assert.ok(risen.position.x > state.position.x)
  assert.equal(physics.capabilities.water, 'experimental-basic-buoyancy-unverified')
  assert.equal(physics.capabilities.fastSwimmingPose, false)
})

test('unknown collision shapes, solid waterlogging and unsupported poses fail safely', () => {
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const withoutStoneShapes = { ...registry, blockCollisionShapes: { ...registry.blockCollisionShapes, blocks: { ...registry.blockCollisionShapes.blocks, stone: undefined } } }
  const missing = createPhysics({ world: flatWorld(), registry: withoutStoneShapes })
  assert.throws(() => initial(missing), /Unknown collision shape/)
  const wet = createPhysics({ world: { getBlock: () => ({ ...block('stone'), extra: [block('water', { liquid_depth: 0 })] }) }, allowWater: true })
  assert.throws(() => wet.blockAt({ x: 0, y: 0, z: 0 }), /Waterlogged/)
  const physics = createPhysics({ world: flatWorld() })
  const state = initial(physics)
  assert.throws(() => physics.step({ ...state, flying: true }), /Unsupported movement pose/)
  assert.throws(() => physics.step(state, { teleport: true }), /Unsupported control/)
  assert.throws(() => physics.step({ ...state, position: { x: NaN, y: 65, z: 0 } }), /finite/)
})

test('working prediction preserves airborne velocity and flags across reconstruction without changing raw observations', () => {
  const physics = createPhysics({ world: flatWorld() })
  const seed = { ...initial(physics), position: { x: 0.6, y: 65.478686, z: 0.5 }, velocity: { x: 0.02, y: -0.23, z: 0 }, onGround: false, jumpTicks: 7, controls: { jump: false, forward: true }, yaw: -45 }
  const position = physics.toServerPosition(seed)
  const snapshot = { position, positionSource: 'client_prediction', rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival', predicted: { position, physicsState: seed } }
  const resumed = physics.fromServer(snapshot)
  assert.deepEqual(resumed.velocity, seed.velocity)
  assert.equal(resumed.velocitySource, 'client_prediction')
  assert.equal(resumed.onGround, false)
  assert.equal(resumed.jumpTicks, 7)
  assert.equal(resumed.controls.forward, true)
  assert.equal(resumed.yaw, -45)
  const raw = physics.fromServer({ ...snapshot, positionSource: 'correct_player_move_prediction' })
  assert.equal(raw.velocitySource, 'model-initialized')
  assert.equal(raw.velocity.y, 0)
  const corrected = physics.fromServer(snapshot, { velocity: { x: 0, y: -0.1, z: 0 }, onGround: false })
  assert.equal(corrected.velocitySource, 'supplied')
  assert.equal(corrected.jumpTicks, 0)
})

test('float32 standing height is recognized and mismatched full prediction state is refused', () => {
  const physics = createPhysics({ world: flatWorld() })
  const standing = initial(physics, { y: 65.00001037597656 })
  assert.equal(standing.onGround, true)
  const position = { x: 0.5, y: 66.62, z: 0.5 }
  assert.throws(() => physics.fromServer({ position, positionSource: 'client_prediction', gameMode: 'survival', predicted: { position, physicsState: { ...standing, position: { x: 50, y: 65, z: 0.5 } } } }), /metadata does not match/)
})

test('a float32 pose above known river water falls into contact and rises with ordinary held jump without snapping', () => {
  const world = { getBlock: (x, y) => block(y < 60 ? 'stone' : y <= 62 ? 'water' : 'air', y >= 60 && y <= 62 ? { liquid_depth: 0 } : {}) }
  const physics = createPhysics({ world, allowWater: true })
  const eye = { x: 8.50558, y: 64.91255, z: -1.96432 }
  const state = physics.fromServer({ position: eye, gameMode: 'survival' })
  const original = structuredClone(state)
  const surface = physics.waterSurface(state.position)
  assert.equal(surface.surfaceY, 63)
  assert.equal(surface.waterY, 62)
  assert.equal(surface.aboveSurface, true)
  assert.ok(Math.abs(state.position.y - 63.29255) < 1e-10)
  assert.equal(state.onGround, false)
  assert.equal(state.isInWater, false)
  let predicted = state
  let minimum = state.position.y
  let wet = false
  for (let index = 0; index < 100; index++) {
    predicted = physics.step(predicted, { jump: true })
    minimum = Math.min(minimum, predicted.position.y)
    wet ||= predicted.isInWater
  }
  assert.equal(wet, true)
  assert.ok(minimum > 61 && minimum < 62.6)
  assert.ok(predicted.position.y > minimum + 0.7 && predicted.position.y < 63.5)
  assert.deepEqual(state, original)
  assert.deepEqual(eye, { x: 8.50558, y: 64.91255, z: -1.96432 })
  assert.equal(physics.waterSurface({ ...state.position, y: 63.6 }), null)
  assert.equal(physics.waterSurface({ ...state.position, y: 60.2 }), null, 'a submerged head is outside surface recovery')
  assert.equal(createPhysics({ world }).waterSurface(state.position), null)
})

test('water surface inspection preserves unknown and lava rejection', () => {
  for (const replacement of [{ known: false, reason: 'not received' }, block('lava', { liquid_depth: 0 })]) {
    const physics = createPhysics({ world: { getBlock: (x, y) => y === 62 ? replacement : block('air') }, allowWater: true })
    assert.throws(() => physics.waterSurface({ x: 8.5, y: 63.29255, z: -1.9 }), /Unknown terrain|Lava/)
  }
})

test('float32 standing poses at every Overworld integer height keep full known support without changing received coordinates', () => {
  let floor = -64
  const world = { getBlock: (x, y, z) => block(y < floor ? 'stone' : 'air') }
  const physics = createPhysics({ world })
  let adjusted = 0
  for (floor = -64; floor <= 319; floor++) for (const [x, z] of [[0.5, 0.5], [-0.25, 0.05]]) {
    const received = { position: { x, y: Math.fround(floor + 1.62), z }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' }
    const originalReceived = structuredClone(received)
    const state = physics.fromServer(received)
    const originalState = structuredClone(state)
    assert.equal(state.onGround, true, `network contact at ${floor}`)
    assert.equal(state.position.y, received.position.y - 1.62)
    let next = physics.step(state, {})
    if (next.contactAdjustment) {
      adjusted++
      assert.equal(next.contactAdjustment.source, 'known_full_footprint_shape_contact')
      assert.ok(next.contactAdjustment.deltaY > 0 && next.contactAdjustment.deltaY <= 1e-4)
      assert.equal(next.contactAdjustment.toY, floor)
    }
    next = run(physics, next, {}, 3)
    assert.equal(next.position.y, floor, `neutral floor at ${floor}, ${x},${z}`)
    assert.equal(next.onGround, true, `grounded after neutral steps at ${floor}`)
    assert.deepEqual(state, originalState)
    assert.deepEqual(received, originalReceived)
  }
  assert.ok(adjusted > 200, 'covers float32 values rounded below the supporting plane')
})

test('contact tolerance also follows real half-slab shapes and preserves a normal jump from that surface', () => {
  const physics = createPhysics({ world: { getBlock: (x, y) => y === 37 ? block('oak_slab', { 'minecraft:vertical_half': 'bottom' }) : block(y < 37 ? 'stone' : 'air') } })
  const raw = { position: { x: 0.5, y: Math.fround(37.5 + 1.62), z: 0.5 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } }
  const state = physics.fromServer(raw)
  const before = structuredClone(state)
  const neutral = physics.step(state, {})
  assert.equal(neutral.position.y, 37.5)
  assert.equal(neutral.onGround, true)
  const jumping = physics.step(state, { jump: true })
  assert.ok(jumping.position.y > 37.9 && jumping.position.y < 38)
  assert.equal(jumping.onGround, false)
  assert.deepEqual(state, before)
})

test('larger overlap, partial support, unknown cells and ordinary airborne motion never receive a floor adjustment', () => {
  const physics = createPhysics({ world: { getBlock: (x, y) => block(y < 37 ? 'stone' : 'air') } })
  const base = physics.fromServer({ position: { x: 0.5, y: Math.fround(38.62), z: 0.5 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } })
  const deep = { ...base, position: { ...base.position, y: 37 - 0.00011 } }
  assert.equal(physics.step(deep, {}).contactAdjustment, null)
  const rising = { ...base, velocity: { x: 0, y: 0.1, z: 0 } }
  assert.equal(physics.step(rising, {}).contactAdjustment, null)
  const air = { ...base, position: { ...base.position, y: 37.25 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false }
  const falling = run(physics, air, {}, 2)
  assert.equal(falling.contactAdjustment, null)
  assert.ok(falling.position.y < air.position.y)
  const partial = createPhysics({ world: { getBlock: (x, y) => block(x === 0 && y === 36 ? 'stone' : 'air') } })
  const edge = { ...base, position: { x: 0.95, y: base.position.y, z: 0.5 } }
  assert.equal(partial.step(edge, {}).contactAdjustment, null, 'one supported corner cannot normalize the full footprint')
  const unknown = createPhysics({ world: { getBlock: (x, y) => x === 1 && y === 36 ? { known: false, reason: 'not received' } : block(y < 37 ? 'stone' : 'air') } })
  assert.throws(() => unknown.step(edge, {}), /Unknown terrain/)
})

function dryDescentAboveWater (replacement = block('water', { liquid_depth: 0 })) {
  // Minimal geometry from the recorded descent: the player falls onto stone
  // at Y63; water is another full block below that floor, outside its body.
  const world = { getBlock: (x, y, z) => x === -9 && y === 62 && z === 14 ? replacement : block((x === -9 && z === 14 && y >= 64 && y <= 66) || (x === -8 && z === 14 && y >= 65 && y <= 67) ? 'air' : 'stone') }
  const seed = { position: { x: -8.43054131805662, y: 64.76636799395752, z: 14.50440286415122 }, velocity: { x: -0.02007055808580115, y: -0.230527368912964, z: 0 }, yaw: 92.75444743605524, pitch: 0, gameMode: 'survival', onGround: false, isInWater: false, isInLava: false, controls: {}, effects: {}, attributes: {} }
  return { world, seed }
}

test('dry collision lookahead can read known water below its full stone floor without enabling water navigation', () => {
  const { world, seed } = dryDescentAboveWater()
  const original = structuredClone(seed)
  const physics = createPhysics({ world })
  assert.equal(physics.capabilities.water, 'disabled')
  for (const controls of [{ forward: true }, {}, { back: true }]) {
    let state = seed
    for (let tick = 0; tick < 3; tick++) {
      state = physics.step(state, controls)
      assert.equal(state.isInWater, false)
    }
    assert.equal(state.position.y, 64)
    assert.equal(state.onGround, true)
  }
  // Even after the engine has cached this template, public water reads cannot
  // bypass the caller's dry-navigation policy.
  assert.throws(() => physics.blockAt({ x: -9, y: 62, z: 14 }), /Water prediction/)
  assert.deepEqual(physics.blockAt({ x: -9, y: 63, z: 14 }).shapes, [[0, 0, 0, 1, 1, 1]])
  assert.deepEqual(seed, original)
})

test('ordinary dry navigation completes a one-block descent over buried water and keeps raw inputs unchanged', () => {
  const { world } = dryDescentAboveWater()
  const navigator = createNavigator({ world })
  const snapshot = { position: { x: -7.494613819817454, y: 66.62, z: 14.509319320827943 }, rotation: { yaw: 90, pitch: 0 }, gameMode: 'survival' }
  const initialState = navigator.physics.fromServer(snapshot)
  const original = structuredClone({ snapshot, initialState })
  const route = navigator.plan(initialState, { x: -8.5, y: 64, z: 14.5 }, { maxDistance: 2 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initialState)
  let result
  for (let tick = 0; tick < 160; tick++) {
    result = stepper.next()
    assert.equal(result.predictedState.isInWater, false)
    if (result.phase !== 'moving') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.predictedState.position.y, 64)
  assert.equal(result.predictedState.onGround, true)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual({ snapshot, initialState }, original)
})

test('the engine-only water reader still rejects actual water contact for a dry prediction', () => {
  const world = { getBlock: (x, y) => block(y === 65 ? 'water' : y < 64 ? 'stone' : 'air', y === 65 ? { liquid_depth: 0 } : {}) }
  const physics = createPhysics({ world })
  const seed = initial(physics, { y: 64.7 })
  const original = structuredClone(seed)
  assert.equal(seed.isInWater, false)
  assert.throws(() => physics.step(seed, {}), /Water prediction/)
  assert.deepEqual(seed, original)
  const enabled = createPhysics({ world, allowWater: true })
  assert.equal(enabled.step(seed, {}).isInWater, true, 'actual contact is detected, rather than guessed from a broadphase read')
})

test('buried lava, unknown terrain and unsupported or unknown secondary layers remain forbidden during dry lookahead', () => {
  for (const [replacement, pattern] of [
    [block('lava', { liquid_depth: 0 }), /Lava/],
    [{ known: false, reason: 'unreceived buried cell' }, /Unknown terrain/],
    [{ ...block('stone'), extra: [block('water', { liquid_depth: 0 })] }, /Waterlogged/],
    [{ ...block('air'), extra: [{ ...block('water', { liquid_depth: 0 }), known: false }] }, /Unknown terrain/]
  ]) {
    const { world, seed } = dryDescentAboveWater(replacement)
    const physics = createPhysics({ world })
    const second = run(physics, seed, {}, 2)
    assert.throws(() => physics.step(second, {}), pattern)
  }
})
