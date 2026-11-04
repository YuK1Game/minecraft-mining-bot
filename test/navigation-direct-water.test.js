'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')

const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
const target = { x: 3.5, y: 65, z: -1.5 }
const options = { directSurface: true, exactGoal: true, maxDistance: 5 }
function fixture ({ override = () => null, feetY = 64.5, velocity = { x: 0, y: 0, z: 0 }, allowWater = true } = {}) {
  const world = { getBlock: (x, y, z) => override(x, y, z) ?? block(y < 60 ? 'stone' : y < 65 ? 'water' : 'air', y >= 60 && y < 65 ? { liquid_depth: 0 } : {}) }
  const navigator = createNavigator({ world, allowWater })
  const initial = navigator.physics.fromServer({ position: { x: 0.5, y: feetY + 1.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' }, { velocity, onGround: false })
  return { navigator, initial }
}

test('direct water escape moves northeast on its first input instead of restarting the east-first grid leg', () => {
  const { navigator, initial } = fixture()
  const before = structuredClone(initial)
  const grid = navigator.plan(initial, target, { exactGoal: true, maxDistance: 5 })
  assert.equal(grid.ready, true, grid.reason)
  assert.ok(grid.waypoints.length > 1)
  const gridFirst = navigator.createStepper(grid, initial).next()
  assert.ok(gridFirst.predictedState.position.x > initial.position.x)
  assert.equal(gridFirst.predictedState.position.z, initial.position.z)

  const route = navigator.plan(initial, target, options)
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.directSurface, true)
  assert.deepEqual(route.waypoints, [{ position: target, action: 'swim', medium: 'water', waterSurfaceY: 65 }])
  assert.equal(route.serverConfirmed, false)
  assert.equal(route.predictionOnly, true)
  assert.ok(route.predictedTrace.length > 2 && route.predictedTrace.length <= 81)
  assert.deepEqual(route.predictedTrace[0], initial.position)
  const stepper = navigator.createStepper(route, initial, { maxTicks: 80 })
  let frame = stepper.next()
  assert.equal(frame.controls.forward, true)
  assert.notEqual(frame.controls.sprint, true)
  assert.ok(frame.predictedState.position.x > initial.position.x)
  assert.ok(frame.predictedState.position.z < initial.position.z)
  assert.ok(Math.abs(frame.predictedState.yaw - Math.atan2(3, -2) * -180 / Math.PI) < 1e-9)
  for (let index = 1; index < 80 && frame.phase === 'moving'; index++) frame = stepper.next()
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.isInWater, true)
  assert.ok(Math.hypot(frame.predictedState.position.x - target.x, frame.predictedState.position.z - target.z) <= 0.35)
  assert.deepEqual(frame.predictedState.position, route.predictedTrace.at(-1))
  assert.deepEqual(initial, before)
})

test('direct water shortcut checks intermediate and corner water, headroom, and fluid metadata', () => {
  const failures = [
    { name: 'unreceived diagonal water', x: 1, y: 64, z: -1, replacement: { known: false, reason: 'not received' } },
    { name: 'lava under a footprint corner', x: 1, y: 64, z: -1, replacement: block('lava', { liquid_depth: 0 }) },
    { name: 'solid at body height', x: 1, y: 65, z: -1, replacement: block('stone') },
    { name: 'unknown corner headroom', x: 1, y: 66, z: -1, replacement: { known: false, reason: 'not received' } },
    { name: 'different corner surface', x: 1, y: 65, z: -1, replacement: block('water', { liquid_depth: 0 }) },
    { name: 'falling water', x: 1, y: 64, z: -1, replacement: block('water', { liquid_depth: 8 }) },
    { name: 'incomplete liquid state', x: 1, y: 64, z: -1, replacement: block('water') }
  ]
  for (const fault of failures) {
    const { navigator, initial } = fixture({ override: (x, y, z) => x === fault.x && y === fault.y && z === fault.z ? fault.replacement : null })
    const route = navigator.plan(initial, target, options)
    assert.notEqual(route.directSurface, true, fault.name)
  }
})

test('water shortcut keeps avoidance along the diagonal and its predicted vertical bob', () => {
  const { navigator, initial } = fixture()
  // Both endpoints are outside this circle; the direct diagonal crosses it.
  const crossing = { id: 'enemy', position: { x: 2, y: 66.4, z: -0.5 }, minDistance: 0.55, padding: 0.1 }
  assert.ok(Math.hypot(initial.position.x - crossing.position.x, initial.position.y + 1.62 - crossing.position.y, initial.position.z - crossing.position.z) > 0.65)
  assert.ok(Math.hypot(target.x - crossing.position.x, target.y + 1.62 - crossing.position.y, target.z - crossing.position.z) > 0.65)
  assert.notEqual(navigator.plan(initial, target, { ...options, avoidance: [crossing] }).directSurface, true)
  // The nominal rising connector clears this small sphere below the swimmer,
  // but the actual first falling physics steps approach it and must be refused.
  const falling = fixture({ velocity: { x: 0, y: -0.25, z: 0 } })
  const below = { id: 'below', position: { x: 0.5, y: 65, z: 0.5 }, minDistance: 0.9, padding: 0 }
  assert.equal(navigator.plan(initial, target, { ...options, avoidance: [below] }).directSurface, true)
  assert.notEqual(falling.navigator.plan(falling.initial, target, { ...options, avoidance: [below] }).directSurface, true)
})

test('water shortcut stays explicitly bounded to the received surface and preserves bobbing feet', () => {
  const f = fixture({ feetY: 64.35 })
  const route = f.navigator.plan(f.initial, target, options)
  assert.equal(route.directSurface, true)
  assert.equal(route.origin.y, 64.35)
  assert.equal(route.predictedTrace[0].y, 64.35)
  assert.notEqual(f.navigator.plan(f.initial, { ...target, y: 64.5 }, options).directSurface, true)
  assert.notEqual(f.navigator.plan(f.initial, { x: 5.5, y: 65, z: 0.5 }, { ...options, maxDistance: 6 }).directSurface, true)
  assert.equal(f.navigator.plan(f.initial, target, { directSurface: true }).ready, false)
  assert.notEqual(f.navigator.plan({ ...f.initial, isInLava: true }, target, options).directSurface, true)
  const submerged = fixture({ feetY: 63.2 })
  assert.notEqual(submerged.navigator.plan(submerged.initial, target, options).directSurface, true)
  const dry = fixture({ allowWater: false })
  assert.equal(dry.navigator.plan(dry.initial, target, options).ready, false)
})
