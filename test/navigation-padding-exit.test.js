'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { evaluateThreats } = require('../src/threats')

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const eye = point => ({ ...point, y: point.y + 1.62 })
function segmentDistance (point, from, to) {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
  const ratio = length ? Math.max(0, Math.min(1, ((point.x - from.x) * delta.x + (point.y - from.y) * delta.y + (point.z - from.z) * delta.z) / length)) : 0
  return distance(point, { x: from.x + delta.x * ratio, y: from.y + delta.y * ratio, z: from.z + delta.z * ratio })
}
function corridor (lastZ = 2, position = { x: 0.5, y: 66.62, z: 0.5 }) {
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 && x === 0 && z >= 0 && z <= lastZ ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) }
  const navigator = createNavigator({ world })
  return { navigator, initial: navigator.physics.fromServer({ position, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } }, { onGround: true }) }
}

test('two outward graph steps can gradually leave padding without crossing the gained distance', () => {
  const f = corridor()
  const actor = { id: 'actor', position: { x: -2.5, y: 66.62, z: 0.5 }, minDistance: 3, padding: 0.5 }
  const first = { x: 0.5, y: 65, z: 1.5 }
  assert.ok(distance(actor.position, eye(first)) < actor.minDistance + actor.padding)
  const route = f.navigator.plan(f.initial, { x: 0.5, y: 65, z: 2.5 }, { maxDistance: 3, avoidance: [actor] })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.waypoints.map(w => w.position), [first, { x: 0.5, y: 65, z: 2.5 }])
  let previous = f.initial.position
  for (const { position } of route.waypoints) {
    const required = Math.max(actor.minDistance, Math.min(actor.minDistance + actor.padding, distance(actor.position, eye(previous))))
    assert.ok(segmentDistance(actor.position, eye(previous), eye(position)) >= required - 1e-4)
    previous = position
  }
  assert.ok(distance(actor.position, eye(previous)) > actor.minDistance + actor.padding)
})

test('inside padding an approaching edge or chord cannot spend previously gained separation', () => {
  for (const actorZ of [1, 1.5]) {
    const f = corridor(1)
    const actor = { id: 'actor', position: { x: -2.5, y: 66.62, z: actorZ }, minDistance: 3, padding: 0.5 }
    const target = { x: 0.5, y: 65, z: 1.5 }
    const fromDistance = distance(actor.position, eye(f.initial.position))
    assert.ok(segmentDistance(actor.position, eye(f.initial.position), eye(target)) >= actor.minDistance, 'the fixed hard floor alone would admit this segment')
    assert.ok(segmentDistance(actor.position, eye(f.initial.position), eye(target)) < fromDistance - 1e-4, 'the chord or approach loses separation')
    const route = f.navigator.plan(f.initial, target, { directFlat: true, exactGoal: true, maxDistance: 2, avoidance: [actor] })
    assert.equal(route.ready, false)
  }
})

test('an origin outside padding cannot reenter it through the exact target connector', () => {
  const f = corridor(0)
  const actor = { id: 'actor', position: { x: -3.06, y: 66.62, z: 0.5 }, minDistance: 3, padding: 0.5 }
  const target = { x: 0.35, y: 65, z: 0.5 }
  assert.ok(distance(actor.position, eye(f.initial.position)) > 3.5)
  assert.ok(distance(actor.position, eye(target)) > 3)
  assert.ok(distance(actor.position, eye(target)) < 3.5)
  const route = f.navigator.plan(f.initial, target, { directFlat: true, exactGoal: true, maxDistance: 2, avoidance: [actor] })
  assert.equal(route.ready, false)
  assert.match(route.reason, /exact target connector/)
})

test('the initial true-origin connector retains its fixed hard floor inside padding', () => {
  const f = corridor(2, { x: 0.75, y: 66.62, z: 0.5 })
  const actor = { id: 'actor', position: { x: -2.5, y: 66.62, z: 0.5 }, minDistance: 2.95, padding: 0.5 }
  const route = f.navigator.plan(f.initial, { x: 0.5, y: 65, z: 2.5 }, { maxDistance: 3, avoidance: [actor] })
  assert.equal(route.ready, true, route.reason)
})

test('the captured valid land state previews and fully simulates through the same received geometry', () => {
  const observed = require('./fixtures/land-gradual-padding-exit.json')
  const map = new Map(observed.blocks.map(([x, y, z, name, properties]) => [`${x},${y},${z}`, { known: true, name, properties, extra: [] }]))
  const world = { getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false } }
  const before = structuredClone(observed)
  const actors = evaluateThreats(observed.state, observed.enemies, { observationRadius: 32 })
  assert.equal(actors.threats.length, 1)
  const primary = actors.threats[0]
  const avoidance = [...actors.threats, ...actors.outsideDanger].map(actor => {
    const minDistance = actor.dangerous ? actor.distance : actor.dangerRadius
    return { id: actor.runtimeId, position: actor.position, minDistance, padding: Math.min(0.5, Math.max(0, distance(actor.position, eye(observed.target)) - minDistance)) }
  })
  const first = { x: -16.5, y: 70, z: 22.5 }
  const firstGain = distance(primary.position, eye(first)) - primary.distance
  assert.ok(firstGain > 0.33 && firstGain < 0.34, 'the first graph step cannot exit the half-block pad alone')
  const sent = []
  const movement = createMovement({ client: { queue: (...packet) => sent.push(packet) }, getState: () => structuredClone(observed.state), world, version: '1.26.60', startGame: { current_tick: 1n } })
  const options = { emergency: true, allowWater: false, directFlat: true, exactGoal: true, maxDistance: 8, maxExpanded: 800, avoidance }
  const route = movement.preview(observed.target, options)
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.waypoints.length, 6)
  assert.deepEqual(route.waypoints[0].position, first)
  assert.equal(movement.preview(observed.lastRejectedTarget, options).ready, true)
  assert.equal(sent.length, 0)
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer(observed.state)
  const stepper = navigator.createStepper(route, initial, { maxTicks: 80, sprint: false })
  let frame; let previous = initial.position
  for (let tick = 0; tick < 80; tick++) {
    frame = stepper.next()
    const next = frame.predictedState.position
    for (const actor of avoidance) {
      const fromDistance = distance(actor.position, eye(previous))
      const required = Math.max(actor.minDistance, Math.min(actor.minDistance + actor.padding, fromDistance))
      assert.ok(segmentDistance(actor.position, eye(previous), eye(next)) >= required - 1e-4, `actor ${actor.id}, tick ${tick}`)
    }
    assert.equal(frame.predictedState.isInWater, false)
    assert.equal(frame.predictedState.isInLava, false)
    previous = next
    if (frame.phase !== 'moving') break
  }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.ok(distance(primary.position, frame.packetPosition) > primary.distance + 3)
  assert.equal(frame.serverConfirmed, false)
  assert.deepEqual(observed, before)
})
