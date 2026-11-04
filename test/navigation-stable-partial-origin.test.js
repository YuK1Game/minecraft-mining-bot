'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { evaluateThreats } = require('../src/threats')
const observed = require('./fixtures/land-stable-partial-origin.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function fixture () {
  const map = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  const world = { getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false } }
  const navigator = createNavigator({ world })
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, positionSource: 'client_prediction', position: copy(observed.position), predicted: copy(observed.predicted), rotation: { yaw: 0, pitch: 0 }, threatPolicy: 'balanced_mining' }
  const evaluation = evaluateThreats(state, observed.enemies, { observationRadius: 32 })
  const avoidance = [...evaluation.threats, ...evaluation.outsideDanger].map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerous ? actor.distance : actor.dangerRadius, padding: 0.5 }))
  return { map, world, navigator, state, initial: navigator.physics.fromServer(state), avoidance }
}
const options = avoidance => ({ stablePartialOrigin: true, emergency: true, exactGoal: true, directFlat: true, maxDistance: 8, maxExpanded: 800, avoidance })

test('stable partial contact is explicitly an origin and neutral settling cannot certify a full arrival there', () => {
  const f = fixture()
  assert.equal(f.navigator.physics.hasSupport(f.initial.position), true)
  assert.equal(f.navigator.verifyOrigin(f.initial), false)
  assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), true)
  const settler = f.navigator.createSettler(f.initial, { maxTicks: 40, maxDrop: 1, maxHorizontal: 1 })
  let settled
  for (let tick = 0; tick < 40; tick++) { settled = settler.next(); if (settled.phase !== 'settling') break }
  assert.equal(settled.phase, 'awaiting_server_confirmation')
  assert.equal(settled.predictedState.onGround, true)
  assert.deepEqual(settled.predictedState.position, f.initial.position)
  assert.equal(f.navigator.verifyOrigin(settled.predictedState), false)
  const self = f.navigator.plan(f.initial, f.initial.position, options(f.avoidance))
  assert.equal(self.ready, false, 'origin authorization never turns the same partial target into a complete arrival')
})

test('actual stable partial origin takes the existing one-block dry continuation with all actor floors intact', () => {
  for (const seed of ['predicted', 'correction', 'raw']) {
    const f = fixture()
    const initial = seed === 'predicted' ? f.initial : seed === 'correction' ? copy(observed.correctionInitial) : f.navigator.physics.fromServer({ ...f.state, position: observed.rawServerPosition, positionSource: 'server', predicted: null })
    assert.equal(f.navigator.verifyOrigin(initial, { stablePartialOrigin: true }), true, seed)
    const avoidance = f.avoidance.map(actor => ({ ...actor, minDistance: actor.id === '8' ? distance(actor.position, eye(initial.position)) : actor.minDistance }))
    assert.equal(f.navigator.plan(initial, observed.target, { ...options(avoidance), stablePartialOrigin: false }).ready, false)
    const route = f.navigator.plan(initial, observed.target, options(avoidance))
    assert.equal(route.ready, true, `${seed}: ${route.reason}`)
    assert.equal(route.stablePartialOrigin, true)
    assert.equal(route.waypoints.length, 1)
    assert.deepEqual(route.waypoints[0].position, observed.target)
    const stepper = f.navigator.createStepper(route, initial, { maxTicks: 40, sprint: false })
    let frame
    for (let tick = 0; tick < 40; tick++) {
      frame = stepper.next()
      for (const actor of avoidance) assert.ok(distance(actor.position, frame.packetPosition) >= actor.minDistance - 1e-4, `${seed}, actor ${actor.id}, tick ${tick}`)
      assert.equal(frame.predictedState.isInWater, false)
      assert.equal(frame.predictedState.isInLava, false)
      if (frame.phase !== 'moving') break
    }
    assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
    assert.equal(f.navigator.verifyOrigin(frame.predictedState), true, 'the destination has full received support')
    assert.ok(frame.predictedState.position.z > 24.6)
    assert.equal(frame.predictedState.position.y, 68)
  }
})

test('partial origin rejects airborne, falling, drifting, unknown, body, head, fluid and secondary-layer uncertainty', () => {
  for (const mode of ['airborne', 'falling', 'drifting', 'unknown', 'head', 'body', 'water', 'lava', 'secondary']) {
    const f = fixture()
    if (mode === 'airborne') f.initial.onGround = false
    if (mode === 'falling') f.initial.velocity.y = -0.3
    if (mode === 'drifting') f.initial.velocity.z = 0.5
    if (mode === 'unknown') f.map.set('-17,68,24', { known: false })
    if (mode === 'head') f.map.set('-17,70,23', { known: false })
    if (mode === 'body') f.map.set('-17,69,24', { known: true, name: 'minecraft:stone', properties: {}, extra: [] })
    if (mode === 'water' || mode === 'lava') f.map.set('-17,68,24', { known: true, name: `minecraft:${mode}`, properties: { liquid_depth: 0 }, extra: [] })
    if (mode === 'secondary') f.map.get('-17,68,24').extra = [{ known: false }]
    assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), false, mode)
    assert.equal(f.navigator.plan(f.initial, observed.target, options(f.avoidance)).ready, false, mode)
  }
})

test('a stable origin alone cannot authorize unknown landing support or an actor crossing the simulated first arc', () => {
  const unknown = fixture()
  unknown.map.set('-17,68,25', { known: false })
  assert.equal(unknown.navigator.verifyOrigin(unknown.initial, { stablePartialOrigin: true }), true)
  assert.equal(unknown.navigator.plan(unknown.initial, observed.target, options(unknown.avoidance)).ready, false)
  const blocked = fixture()
  const crossing = { id: 'first-arc', position: { x: -16.5, y: 70.62, z: 24.320379157002147 }, minDistance: 0.15, padding: 0 }
  assert.equal(blocked.navigator.verifyOrigin(blocked.initial, { stablePartialOrigin: true }), true)
  assert.equal(blocked.navigator.plan(blocked.initial, observed.target, options([...blocked.avoidance, crossing])).ready, false)
})

test('Movement forwards explicit partial-origin permission to preview and execution without changing ordinary defaults', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(); const sent = []; let time = 0
  const movement = createMovement({ client: { queue: (name, packet) => { sent.push({ name, packet }); return { tick: packet.tick } } }, getState: () => copy(f.state), world: f.world, startGame: { current_tick: 1n }, startGameReceivedAt: 0, version: '1.26.60', clock: () => time })
  t.after(() => movement.stop())
  const ordinary = { ...options(f.avoidance), stablePartialOrigin: false }
  assert.equal(movement.preview(observed.target, ordinary).ready, false)
  assert.equal(movement.preview(observed.target, { ...ordinary, stablePartialOrigin: 'true' }).ready, false)
  assert.equal(movement.preview(observed.target, options(f.avoidance)).ready, true)
  assert.equal(sent.length, 0)
  movement.start(observed.target, options(f.avoidance))
  for (let tick = 0; tick < 40 && movement.snapshot().phase === 'moving'; tick++) { time += 50; t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation')
  assert.equal(movement.snapshot().physicsState.position.y, 68)
  assert.ok(sent.length > 0)
  assert.deepEqual(f.state.position, observed.position)
})
