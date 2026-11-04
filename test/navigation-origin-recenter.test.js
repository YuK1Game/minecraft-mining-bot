'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createPhysics } = require('../src/physics')
const { createMovement } = require('../src/movement')
const { createInputHistory } = require('../src/input-history')
const capture = require('./fixtures/navigation-origin203.json')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const base = new Map(capture.blocks.map(block => [key(block.position), block]))
const unknown = { known: false, reason: 'not in the captured terrain' }
const prepared = createPhysics({ world: { getBlock: (x, y, z) => base.get(`${x},${y},${z}`) ?? unknown } })
function fixture () {
  const changes = new Map()
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? base.get(`${x},${y},${z}`) ?? unknown }
  const physics = prepared.withWorld(world)
  const navigator = createNavigator({ world, physics })
  const initial = physics.fromServer(copy(capture.state))
  return { world, physics, navigator, initial, changes, plan: options => navigator.plan(initial, capture.target, options) }
}
function run (stepper, limit = 140) {
  const frames = []
  for (let index = 0; index < limit; index++) { const frame = stepper.next(); frames.push(frame); if (frame.phase !== 'moving') break }
  return frames
}

test('the unchanged captured legacy route still reproduces fifty-two neutral ticks and no-progress failure', () => {
  const f = fixture()
  assert.equal(f.navigator.verifyOrigin(f.initial), false)
  assert.equal(f.navigator.verifyOrigin(f.initial, { stablePartialOrigin: true }), true)
  for (const sprint of [false, true]) {
    const legacy = copy(capture.legacyRoute); delete legacy.originRecenter
    const frames = run(f.navigator.createStepper(legacy, f.initial, { maxTicks: 100, sprint }))
    assert.equal(frames.length, 52)
    assert.equal(frames.at(-1).phase, 'failed')
    assert.match(frames.at(-1).reason, /no progress/i)
    assert.ok(frames.every(frame => !frame.controls.forward && !frame.controls.sprint))
    assert.ok(frames.every(frame => key(frame.predictedState.position) === key(f.initial.position)))
  }
})

test('ordinary captured navigation reuses six explicit recenter frames before continuing to the full goal', () => {
  const f = fixture(), before = copy(f.initial), route = f.plan()
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.originRecenter?.partialRecenter, true)
  const connector = f.navigator.plan(f.initial, route.waypoints[0].position, { partialRecenter: true, maxDistance: 2, maxExpanded: 64, avoidance: route.avoidance })
  assert.equal(connector.ready, true, connector.reason)
  assert.deepEqual(route.originRecenter.predictedTrace, connector.predictedTrace)
  assert.deepEqual(route.originRecenter.avoidance, route.avoidance)
  const prefix = run(f.navigator.createStepper(connector, f.initial, { maxTicks: 40, sprint: false }))
  assert.equal(prefix.length, 6)
  const outer = f.navigator.createStepper(route, f.initial, { maxTicks: 100, sprint: true })
  const frames = run(outer)
  for (let index = 0; index < prefix.length; index++) {
    assert.deepEqual(frames[index].predictedState, prefix[index].predictedState)
    assert.deepEqual(frames[index].controls, prefix[index].controls)
    assert.equal(frames[index].steps, index + 1)
    assert.equal(frames[index].phase, 'moving')
    assert.equal(frames[index].settled, false)
    assert.notEqual(frames[index].controls.sprint, true)
    assert.equal(f.navigator.verifyOrigin(frames[index].predictedState), true, 'The first actual emitted recenter tick already restores the complete footprint')
  }
  assert.ok(frames.length > 6 && frames.length < 100)
  assert.equal(frames.at(-1).phase, 'awaiting_server_confirmation', frames.at(-1).reason)
  assert.ok(Math.hypot(frames.at(-1).predictedState.position.x - capture.target.x, frames.at(-1).predictedState.position.z - capture.target.z) <= 0.35)
  assert.equal(frames.at(-1).serverConfirmed, false)
  assert.deepEqual(f.initial, before)
})

test('full origins and explicit recenter mode do not receive another origin prefix', () => {
  const f = fixture(), route = f.plan(), full = copy(f.initial)
  full.position = copy(route.waypoints[0].position)
  const ordinary = f.navigator.plan(full, capture.target)
  assert.equal(ordinary.ready, true, ordinary.reason)
  assert.equal(ordinary.originRecenter, undefined)
  const explicit = f.navigator.plan(f.initial, route.waypoints[0].position, { partialRecenter: true, maxDistance: 2, maxExpanded: 64 })
  assert.equal(explicit.ready, true)
  assert.equal(explicit.originRecenter, undefined)
})

test('changed floor, head space, actual origin or actor circle invalidates the prefix before execution', () => {
  for (const mode of ['floor', 'head', 'origin', 'actor']) {
    const f = fixture(), route = f.plan(), initial = copy(f.initial)
    assert.equal(route.ready, true, route.reason)
    if (mode === 'floor') f.changes.set('-20,70,-14', { known: false })
    if (mode === 'head') f.changes.set('-20,72,-14', { known: false })
    if (mode === 'origin') initial.position.x += 0.05
    if (mode === 'actor') {
      const circles = [{ id: 'current-actor', position: { x: -19.8, y: 72.62, z: -13.5 }, minDistance: 0.4, padding: 0 }]
      route.avoidance = circles; route.originRecenter.avoidance = copy(circles)
    }
    assert.throws(() => f.navigator.createStepper(route, initial, { maxTicks: 100, sprint: true }), /partial|origin|support|known|avoidance|safe|unknown/i, mode)
  }
})

test('live prefix terrain loss, outer budget exhaustion, stop and correction never produce arrival', () => {
  const live = fixture(), stepper = live.navigator.createStepper(live.plan(), live.initial, { maxTicks: 100, sprint: true })
  stepper.next(); stepper.next()
  live.changes.set('-20,70,-14', { known: false })
  const failed = stepper.next()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.serverConfirmed, false)
  const budget = fixture(), limited = run(budget.navigator.createStepper(budget.plan(), budget.initial, { maxTicks: 5, sprint: true }))
  assert.equal(limited.length, 6)
  assert.equal(limited.at(-1).phase, 'failed')
  assert.match(limited.at(-1).reason, /tick limit/i)
  assert.ok(limited.every(frame => frame.phase !== 'awaiting_server_confirmation'))
  for (const mode of ['stop', 'correction']) {
    const f = fixture(), current = f.navigator.createStepper(f.plan(), f.initial, { maxTicks: 100, sprint: true })
    const first = current.next(), pose = copy(first.predictedState)
    const terminal = mode === 'stop' ? current.stop('Interrupted prefix') : current.reconcile(pose)
    assert.equal(terminal.phase, mode === 'stop' ? 'stopped' : 'replan_required')
    assert.deepEqual(current.next().predictedState, pose)
    assert.equal(current.next().serverConfirmed, false)
  }
})

test('real Movement keeps prefix frames moving and records ordinary queued history without tick or producer reset', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(), state = copy(capture.state), before = copy(state), records = [], packets = [], predictions = []
  let elapsed = 0
  t.mock.method(Date, 'now', () => Date.parse(capture.capturedAt) + elapsed)
  const scope = { profile: 'bot', realmId: '21225335', dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: state.runtimeEntityId, generation: 1 }
  const history = createInputHistory({ physics: f.physics, now: Date.now })
  const movement = createMovement({ world: f.world, physics: f.physics, version: '1.26.60', getState: () => copy(state), startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed,
    client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } },
    onQueuedFrame: frame => { records.push(copy(frame)); history.recordQueued({ ...frame, scope }) },
    onPrediction: prediction => predictions.push(copy(prediction))
  })
  t.after(() => movement.stop('Test cleanup'))
  movement.start(capture.target, { sprint: true })
  for (let count = 0; count < 100 && movement.snapshot().phase === 'moving'; count++) { elapsed += 50; t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation', movement.snapshot().reason)
  assert.equal(movement.snapshot().serverConfirmed, false)
  assert.ok(records.length > 6)
  assert.ok(predictions.slice(0, 6).every(prediction => prediction.phase === 'moving' && prediction.settled === false))
  assert.ok(records.slice(0, 6).every(record => !record.controls.sprint && f.navigator.verifyOrigin(record.predictedState)))
  assert.ok(records.every(record => record.producer === 'navigation' && record.modeled && record.receiptConfirmed))
  for (let index = 1; index < records.length; index++) assert.equal(records[index].tick, records[index - 1].tick + 1n)
  assert.equal(history.snapshot().navigationQueued, records.length)
  assert.equal(history.snapshot().latestTick, String(records.at(-1).tick))
  assert.equal(history.witness({ scope, health: state.health, position: predictions.at(-1).position }).ready, false, 'A successful local queue receipt is not an authoritative server anchor')
  const count = packets.length; movement.stop('Normal route ended')
  assert.equal(packets.length, count, 'Normal terminal cleanup adds no opaque release')
  assert.deepEqual(state, before)
})
