'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRecovery } = require('../src/recovery')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { knownSurfaceBody } = require('../src/low-health-water')
const { evaluateThreats } = require('../src/threats')
const captured = require('./fixtures/recovery352-hard-radius.json')
const copy = value => structuredClone(value)
const key = point => `${point.x},${point.y},${point.z}`
const rows = new Map(captured.blocks.map(block => [key(block.position), block]))
const unknown = { known: false }
const receivedWorld = { getBlock: (x, y, z) => rows.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? unknown }
const prepared = createPhysics({ world: receivedWorld, allowWater: true, version: '1.26.60' })

// Evaluate the actual Runtime callback instead of restating its policy in the
// test. The host's unknown-actor count remains the captured known observation.
const runtimeSource = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
const recoveryStart = runtimeSource.indexOf('recovery = createRecovery(')
const avoidanceStart = runtimeSource.indexOf('getAvoidance: state => {', recoveryStart) + 'getAvoidance: state => {'.length
const avoidanceEnd = runtimeSource.indexOf('\n    }, onProgress:', avoidanceStart)
assert.ok(recoveryStart >= 0 && avoidanceStart > recoveryStart && avoidanceEnd > avoidanceStart)
const runtimeAvoidance = new Function('evaluateThreats', 'host', `return state => {${runtimeSource.slice(avoidanceStart, avoidanceEnd)}\n}`)(evaluateThreats, { entities: { stats: () => ({ unknownPositions: 0 }) } })

function segmentMargin (from, to, circles) {
  let minimum = Infinity
  for (const circle of circles) {
    const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
    const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
    const ratio = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * delta.x + (circle.position.y - from.y) * delta.y + (circle.position.z - from.z) * delta.z) / length)) : 0
    minimum = Math.min(minimum, Math.hypot(circle.position.x - from.x - ratio * delta.x, circle.position.y - from.y - ratio * delta.y, circle.position.z - from.z - ratio * delta.z) - circle.minDistance - (circle.padding ?? 0))
  }
  return minimum
}

function pureTrace (state, padding) {
  const initial = prepared.fromServer(state), circles = captured.circles.map(circle => ({ ...copy(circle), padding }))
  const nav = createNavigator({ world: receivedWorld, physics: prepared, allowWater: true })
  const options = { allowWater: true, emergency: true, directSurface: true, exactGoal: true, maxDistance: 12, maxExpanded: 500, avoidance: circles }
  const route = nav.plan(initial, captured.forwardRelay, options)
  assert.equal(route.ready, true, route.reason)
  const stepper = nav.createStepper(route, initial, { maxTicks: 120, sprint: false })
  let previous = { ...initial.position, y: initial.position.y + 1.62 }, minimum = Infinity, violation = null, last
  const trace = []
  for (let tick = 1; tick <= 121; tick++) {
    last = stepper.next()
    const physical = last.predictedState, eye = { ...physical.position, y: physical.position.y + 1.62 }
    const margin = segmentMargin(previous, eye, circles)
    minimum = Math.min(minimum, margin)
    assert.equal(knownSurfaceBody(prepared, physical.position, 63), true)
    if (margin < -1e-4 && !violation) violation = { tick, margin }
    trace.push(last)
    previous = eye
    if (last.phase !== 'moving' || violation) break
  }
  return { trace, last, minimum, violation, initial, circles }
}

function fixture (t, { phase = 'seed', onModeled = null, mutateFrame = null, afterGuard = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const state = copy(captured.states[phase]), epoch = Date.parse(state.positionUpdatedAt), changes = new Map(), calls = [], packets = [], queued = [], predictions = []
  let elapsed = 0, prediction = copy(state.predicted), origin = null, intent = copy(captured.destination), changed = false
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const world = { getBlock: (x, y, z) => changes.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? receivedWorld.getBlock(x, y, z) }
  const physics = prepared.withWorld(world)
  const working = () => ({ ...copy(state), position: copy(prediction.position), predicted: copy(prediction), positionSource: 'client_prediction', positionUpdatedAt: prediction.updatedAt })
  let actual
  actual = createMovement({ world, waterPhysics: physics, version: '1.26.60', getState: () => origin ?? working(), startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed,
    client: { queue: (name, packet) => { packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } },
    onPrediction: value => { prediction = { ...copy(value), updatedAt: new Date(epoch + elapsed).toISOString() }; predictions.push(copy(prediction)) },
    onQueuedFrame: frame => { queued.push(copy(frame)); if (frame.modeled && onModeled) onModeled({ state, changes, frame, queued, working, abort: () => controller.abort(new Error('Controlled cancellation')) }) }
  })
  const controller = new AbortController()
  const movement = {
    preview: (target, options) => { calls.push({ kind: 'preview', target: copy(target), options }); return actual.preview(target, options) },
    start: (target, options) => {
      calls.push({ kind: 'start', target: copy(target), options })
      origin = working()
      const beforeInput = options.beforeInput
      return actual.start(target, { ...options, beforeInput: beforeInput ? frame => {
        if (!changed && mutateFrame?.({ state, changes, frame, working })) changed = true
        const accepted = beforeInput(frame)
        afterGuard?.({ frame, accepted })
        return accepted
      } : undefined })
    }, stop: reason => actual.stop(reason)
  }
  const recovery = createRecovery({ getState: working, world, movement, physics, getMovement: actual.snapshot, getAvoidance: runtimeAvoidance, getDestination: () => ({ position: copy(intent) }), flatShoreOnly: true,
    timeoutMs: 20000, phaseTimeoutMs: 6000, pollMs: 50, clock: () => epoch + elapsed, delay: async milliseconds => { elapsed += milliseconds; t.mock.timers.tick(milliseconds) } })
  t.after(() => actual.stop('Test cleanup'))
  return { state, world, physics, recovery, actual, calls, packets, queued, predictions, changes, working, controller, getDestination: () => copy(intent) }
}

test('Runtime Recovery uses zero padding only in online learning, while canonical radii and balanced padding remain intact', () => {
  const state = copy(captured.states.seed), canonical = evaluateThreats(state, state.entities, { observationRadius: 32 })
  assert.equal(canonical.threats.length, 0)
  const learning = runtimeAvoidance(state)
  assert.equal(learning.length, 18)
  for (const circle of learning) {
    assert.equal(circle.padding, 0)
    assert.equal(circle.minDistance, canonical.outsideDanger.find(actor => actor.runtimeId === circle.id).dangerRadius)
  }
  const balanced = { ...copy(state), threatPolicy: 'balanced_mining', position: { x: 1000, y: 100, z: 1000 } }
  const balancedCircles = runtimeAvoidance(balanced)
  assert.ok(balancedCircles.length > 0)
  assert.ok(balancedCircles.every(circle => circle.padding === 0.5))
})

test('captured three actual bobbing phases prove complete Native water legs with all hard-radius swept eye segments', () => {
  const expected = { before: 51, seed: 55, after: 52 }
  for (const phase of ['before', 'seed', 'after']) {
    const actualSeed = copy(captured.states[phase].predicted.physicsState)
    const proof = pureTrace(captured.states[phase], 0)
    assert.equal(proof.last.phase, 'awaiting_server_confirmation', proof.last.reason)
    assert.equal(proof.trace.length, expected[phase])
    assert.equal(proof.violation, null)
    assert.ok(proof.minimum > 0.05)
    assert.equal(proof.last.predictedState.isInWater, true)
    assert.equal(proof.last.serverConfirmed, false)
    assert.deepEqual(captured.states[phase].predicted.physicsState, actualSeed)
    const old = pureTrace(captured.states[phase], 0.5)
    assert.ok(old.violation, 'Old padding control must independently fail before completion')
  }
})

test('hard-inadmissible land does not starve direction-only forward water candidates or change explicit intent', t => {
  const f = fixture(t), before = f.getDestination(), preview = f.recovery.preview()
  assert.equal(preview.ready, true, preview.reason)
  assert.ok(preview.candidates.every(candidate => key(candidate.position) !== key(captured.unsafeShore)))
  assert.ok(preview.candidates.some(candidate => key(candidate.position) === key(captured.forwardRelay)))
  assert.ok(preview.candidates.every(candidate => candidate.medium === 'water'))
  assert.deepEqual(preview.destination, before)
  assert.deepEqual(f.getDestination(), before)
  assert.equal(f.packets.length, 0)
})

test('real Recovery and Movement preserve the explicit destination and report only a queued predicted water waypoint', async t => {
  const f = fixture(t), before = f.getDestination(), result = await f.recovery.execute({}, { signal: f.controller.signal })
  assert.equal(result.phase, 'predicted')
  assert.equal(result.mode, 'water_waypoint')
  assert.equal(result.partial, true)
  assert.equal(result.reachedWaypoint, true)
  assert.notEqual(result.reachedDestination, true)
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.collected, false)
  assert.deepEqual(f.getDestination(), before)
  assert.ok(f.queued.filter(frame => frame.modeled).length > 20)
  let previous = captured.states.seed.position
  for (const frame of f.queued.filter(frame => frame.modeled)) {
    assert.equal(frame.receiptConfirmed, true)
    assert.ok(segmentMargin(previous, frame.packetPosition, captured.circles.map(circle => ({ ...circle, padding: 0 }))) >= -1e-4)
    assert.equal(knownSurfaceBody(f.physics, frame.predictedState.position, 63), true)
    previous = frame.packetPosition
  }
})

for (const kind of ['life', 'head', 'abort']) test(`fresh ${kind} change stops modeled input before the next queue`, async t => {
  let changed = false, countAtChange = null
  const f = fixture(t, { onModeled: ({ state, changes, frame, queued, abort }) => {
    if (changed) return
    changed = true; countAtChange = queued.filter(value => value.modeled).length
    if (kind === 'life') state.lifecycle.deathId++
    if (kind === 'head') changes.set(key({ x: Math.floor(frame.packetPosition.x), y: Math.floor(frame.packetPosition.y), z: Math.floor(frame.packetPosition.z) }), unknown)
    if (kind === 'abort') abort()
  } })
  await assert.rejects(f.recovery.execute({}, { signal: f.controller.signal }))
  assert.equal(changed, true)
  assert.equal(f.queued.filter(frame => frame.modeled).length, countAtChange)
  assert.deepEqual(f.getDestination(), captured.destination)
})

test('a newly observed actor crossing an otherwise safe eye segment is rejected before that frame queues', async t => {
  let crossed = false, checked = false, queuedBefore = null
  const f = fixture(t, { mutateFrame: ({ state, frame, working }) => {
    const from = working().position, to = frame.packetPosition, dx = to.x - from.x, dz = to.z - from.z, horizontal = Math.hypot(dx, dz)
    if (horizontal < 0.09) return false
    const radius = 5, offset = Math.sqrt((radius + 0.000025) ** 2 - horizontal ** 2 / 4)
    const position = { x: (from.x + to.x) / 2 - dz / horizontal * offset, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 + dx / horizontal * offset }
    assert.ok(Math.hypot(position.x - from.x, position.y - from.y, position.z - from.z) > radius)
    assert.ok(Math.hypot(position.x - to.x, position.y - to.y, position.z - to.z) > radius)
    state.entities.push({ runtimeId: '999999', uniqueId: '-999999', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, positionSource: 'move_entity', dimension: state.dimension, position })
    crossed = true; queuedBefore = f.queued.filter(value => value.modeled).length
    return true
  }, afterGuard: ({ accepted }) => {
    if (!crossed || checked) return
    checked = true
    assert.equal(accepted, false, 'the actual Recovery frame guard must reject the swept crossing')
    f.controller.abort(new Error('Stop the controlled test after observing the rejected actor frame'))
  } })
  await assert.rejects(f.recovery.execute({}, { signal: f.controller.signal }))
  assert.equal(crossed, true)
  assert.equal(checked, true)
  assert.equal(f.queued.filter(frame => frame.modeled).length, queuedBefore)
})

test('online learning requires full initial scope before movement can own input', async t => {
  const f = fixture(t)
  f.state.connectionId = ''
  await assert.rejects(f.recovery.execute(), error => error.code === 'SCOPE_UNKNOWN')
  assert.equal(f.queued.length, 0)
  assert.equal(f.calls.filter(call => call.kind === 'start').length, 0)
})

test('the queued packet eye must match the actual predicted feet before any frame is accepted', async t => {
  let checked = false
  const f = fixture(t, { mutateFrame: ({ frame }) => { frame.packetPosition.y += 0.01; return true }, afterGuard: ({ accepted }) => {
    if (checked) return
    checked = true
    assert.equal(accepted, false)
    f.controller.abort(new Error('Controlled mismatch observed'))
  } })
  await assert.rejects(f.recovery.execute({}, { signal: f.controller.signal }))
  assert.equal(checked, true)
  assert.equal(f.queued.filter(frame => frame.modeled).length, 0)
})

test('balanced generic Recovery keeps its ordinary movement options without the learning-only frame guard', async t => {
  let cancelled = false
  const f = fixture(t, { onModeled: ({ abort }) => { if (!cancelled) { cancelled = true; abort() } } })
  f.state.threatPolicy = 'balanced_mining'
  f.state.entities = [] // Explicit controlled actor-free policy comparison.
  await assert.rejects(f.recovery.execute({}, { signal: f.controller.signal }))
  const start = f.calls.find(call => call.kind === 'start')
  assert.ok(start)
  assert.equal(start.options.beforeInput, undefined)
  assert.equal(start.options.allowWater, true)
  assert.equal(start.options.emergency, true)
  assert.equal(start.options.maxDistance, 12)
  assert.equal(start.options.maxExpanded, 500)
})
