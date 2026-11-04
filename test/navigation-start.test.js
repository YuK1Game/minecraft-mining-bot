'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')

const block = name => ({ known: true, name: `minecraft:${name}`, properties: {}, extra: [] })
function fixture ({ override = () => null, floor = 65, x = 0.05, z = 0.05 } = {}) {
  const world = { getBlock: (x, y, z) => override(x, y, z) ?? block(y < floor ? 'stone' : 'air') }
  const navigator = createNavigator({ world })
  const observed = { position: { x, y: floor + 1.62, z }, rotation: { yaw: 180, pitch: 0 }, gameMode: 'survival' }
  return { navigator, observed, initial: navigator.physics.fromServer(observed, { onGround: true }) }
}

test('an off-centre escape origin moves forward without first returning to its grid centre', () => {
  // These received coordinates produced a 0.329-block backwards first leg.
  const { navigator, initial, observed } = fixture({ floor: 72, x: -24.500436782836914, z: 15.17119849845767 })
  const before = structuredClone(initial)
  const target = { x: -24.5, y: 72, z: 14.5 }
  const route = navigator.plan(initial, target, { maxDistance: 2 })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.waypoints.length, 1)
  assert.deepEqual(route.waypoints[0].position, target)
  const stepper = navigator.createStepper(route, initial)
  let frame = stepper.next()
  assert.ok(frame.predictedState.position.z < initial.position.z)
  for (let index = 1; index < 100 && frame.phase === 'moving'; index++) frame = stepper.next()
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.ok(Math.abs(frame.predictedState.position.z - target.z) < 0.25)
  assert.equal(frame.serverConfirmed, false)
  assert.deepEqual(initial, before)
  assert.equal(observed.position.z, 15.17119849845767)
})

test('a directly supported diagonal start uses ordinary physics and keeps the received pose unchanged', () => {
  const { navigator, initial, observed } = fixture()
  const before = structuredClone(initial)
  const target = { x: 1.5, y: 65, z: 0.5 }
  const route = navigator.plan(initial, target, { maxDistance: 3 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.waypoints.map(point => point.position), [target])
  const stepper = navigator.createStepper(route, initial)
  let frame = stepper.next()
  assert.ok(frame.predictedState.position.x > initial.position.x)
  assert.ok(frame.predictedState.position.z > initial.position.z)
  for (let index = 1; index < 150 && frame.phase === 'moving'; index++) frame = stepper.next()
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.ok(Math.hypot(frame.predictedState.position.x - target.x, frame.predictedState.position.z - target.z) < 0.25)
  assert.equal(frame.serverConfirmed, false)
  assert.deepEqual(initial, before)
  assert.deepEqual(observed.position, { x: 0.05, y: 66.62, z: 0.05 })
})

test('a direct diagonal over void, unknown or water retains the safe original centre route', () => {
  for (const kind of ['void', 'unknown', 'water']) {
    const { navigator, initial } = fixture({ override: (x, y, z) => x === 1 && y === 64 && z === -1 ? kind === 'unknown' ? { known: false, reason: 'not received' } : block(kind === 'void' ? 'air' : 'water') : null })
    const route = navigator.plan(initial, { x: 1.5, y: 65, z: 0.5 }, { maxDistance: 3 })
    assert.equal(route.ready, true, `${kind}: ${route.reason}`)
    assert.deepEqual(route.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 }, kind)
    assert.ok(route.waypoints.length >= 2)
  }
})

test('a direct diagonal cannot clip a real wall that the original centre route avoids', () => {
  const { navigator, initial } = fixture({ override: (x, y, z) => x === 1 && y === 65 && z === -1 ? block('stone') : null })
  const route = navigator.plan(initial, { x: 1.5, y: 65, z: 0.5 }, { maxDistance: 3 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 })
})

test('jump, ungrounded and water state origins retain their initial centre', () => {
  const terrace = fixture({ override: (x, y) => x >= 1 && y === 65 ? block('stone') : null })
  const rising = terrace.navigator.plan(terrace.initial, { x: 1.5, y: 66, z: 0.5 }, { maxDistance: 3 })
  assert.equal(rising.ready, true, rising.reason)
  assert.deepEqual(rising.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 })
  assert.equal(rising.waypoints[1].action, 'jump')
  for (const flags of [{ onGround: false }, { isInWater: true }, { isInLava: true }]) {
    const { navigator, initial } = fixture()
    const route = navigator.plan({ ...initial, ...flags }, { x: 1.5, y: 65, z: 0.5 }, { maxDistance: 3 })
    assert.equal(route.ready, true, route.reason)
    assert.deepEqual(route.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 })
  }
})
