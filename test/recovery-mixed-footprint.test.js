'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRecovery } = require('../src/recovery')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { evaluateThreats } = require('../src/threats')
const capture = require('./fixtures/recovery-mixed207.json')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const base = new Map(capture.blocks.map(block => [key(block.position), block]))
const unseen = { known: false, reason: 'outside preserved terrain' }
const prepared = createPhysics({ world: { getBlock: (x, y, z) => base.get(`${x},${y},${z}`) ?? unseen }, allowWater: true })
const normalBlock = (name, position, properties = {}) => ({ known: true, name: `minecraft:${name}`, position, properties, boundingBox: ['air', 'water', 'lava'].includes(name) ? 'empty' : 'block', extra: [] })

function fixture (t, { actors = false, destination = null, beforeStart = null, onYield = null, provided = [] } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, prediction = copy(capture.state.predicted), motionOrigin = null, frames = 0, changed = false
  const epoch = Date.parse(capture.capturedAt ?? capture.observedAt)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const state = copy(capture.state)
  if (!actors) { state.entities = []; state.hostiles = [] }
  const changes = new Map(), calls = [], packets = [], predictions = []
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? base.get(`${x},${y},${z}`) ?? unseen }
  const physics = prepared.withWorld(world)
  const navigator = createNavigator({ world, physics, allowWater: true })
  const working = () => ({ ...copy(state), ...(prediction ? { position: copy(prediction.position), predicted: copy(prediction), positionSource: 'client_prediction', positionUpdatedAt: prediction.updatedAt ?? state.positionUpdatedAt } : {}) })
  const actual = createMovement({ world, waterPhysics: physics, version: '1.26.60', getState: () => motionOrigin ?? working(), startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed,
    client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } },
    onPrediction: value => { prediction = { ...copy(value), updatedAt: `queued-${++frames}` }; predictions.push(copy(prediction)) }
  })
  const movement = {
    preview: (target, options) => { calls.push({ kind: 'preview', target: copy(target), options: { ...options, avoidance: copy(options.avoidance) } }); return actual.preview(target, options) },
    start: (target, options) => { calls.push({ kind: 'start', target: copy(target), options: { ...options, avoidance: copy(options.avoidance) } }); motionOrigin = working(); return actual.start(target, options) },
    stop: reason => actual.stop(reason)
  }
  let intent = copy(destination)
  const recovery = createRecovery({ getState: working, world, movement, getMovement: actual.snapshot, physics,
    getAvoidance: () => copy(provided), getDestination: () => copy(intent),
    timeoutMs: 3000, phaseTimeoutMs: 2000, pollMs: 50, clock: () => epoch + elapsed,
    delay: async milliseconds => {
      elapsed += milliseconds
      if (milliseconds === 1 && onYield) onYield(state)
      if (milliseconds === 50 && !changed && beforeStart) { changed = true; beforeStart({ state, changes, setDestination: value => { intent = copy(value) } }) }
      t.mock.timers.tick(milliseconds)
    }
  })
  t.after(() => actual.stop('Test cleanup'))
  return { state, working, world, physics, navigator, recovery, actual, calls, packets, predictions, changes, getDestination: () => copy(intent) }
}

test('preserved mixed floor has no centre water surface but proves a bounded native shore recenter', t => {
  const f = fixture(t), original = copy(f.working())
  const initial = f.physics.fromServer(original)
  assert.equal(initial.onGround, true)
  assert.equal(initial.isInWater, false)
  assert.equal(f.physics.waterSurface(initial.position), null, 'The legacy centre-surface requirement rejected this exact geometry')
  assert.equal(f.world.getBlock(-6, 62, 22).name, 'minecraft:stone')
  assert.equal(f.world.getBlock(-6, 62, 23).name, 'minecraft:water')
  const preview = f.recovery.preview()
  assert.equal(preview.ready, true, preview.reason)
  assert.equal(preview.mode, 'shore_recenter')
  const chosen = preview.candidates[0]
  assert.equal(chosen.shoreRecenter, true)
  assert.ok(Math.hypot(chosen.position.x - initial.position.x, chosen.position.z - initial.position.z) <= 1.2)
  assert.ok(Math.abs(chosen.position.y - initial.position.y) <= 1e-4)
  const route = f.navigator.plan(initial, chosen.position, { partialRecenter: true, shoreRecenter: true, maxDistance: 2, maxExpanded: 64 })
  assert.equal(route.ready, true, route.reason)
  const stepper = f.navigator.createStepper(route, initial, { maxTicks: 40, sprint: false })
  let frame, ticks = 0
  do { frame = stepper.next(); ticks++; assert.equal(frame.predictedState.isInWater, false); assert.ok(Math.abs(frame.predictedState.position.y - initial.position.y) <= 1e-4); assert.notEqual(frame.controls.sprint, true) } while (frame.phase === 'moving' && ticks < 40)
  assert.equal(ticks, 8)
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(f.navigator.verifyOrigin(frame.predictedState), true)
  assert.equal(frame.serverConfirmed, false)
  assert.equal(f.packets.length, 0, 'Both Recovery and Nav previews remain passive')
  assert.deepEqual(f.working(), original)
})

test('actual captured late Skeleton remains an unchanged canonical threat and forbids the new recovery mode', t => {
  const f = fixture(t, { actors: true })
  const canonical = evaluateThreats(f.working(), f.working().entities, { observationRadius: 32 })
  assert.ok(canonical.threats.some(actor => actor.runtimeId === '7153' && actor.dangerRadius === 10))
  const preview = f.recovery.preview()
  assert.equal(preview.ready, false)
  assert.equal(preview.code, 'NEARBY_THREAT')
  assert.equal(f.packets.length, 0)
  assert.equal(f.calls.filter(call => call.kind === 'start').length, 0)
})

test('cooperative mixed-footprint preview rejects a life change during its existing candidate yield', async t => {
  let changed = false
  const f = fixture(t, { onYield: state => { if (!changed) { changed = true; state.lifecycle.deathId++ } } })
  const preview = await f.recovery.previewAsync()
  assert.equal(changed, true, 'The actual candidate generator yielded before completing its proof')
  assert.equal(preview.ready, false)
  assert.equal(preview.code, 'SESSION_CHANGED')
  assert.equal(f.packets.length, 0)
  assert.equal(f.calls.filter(call => call.kind === 'start').length, 0)
})

test('real Movement queues the eight native recenter frames with both explicit flags and grants only local predicted progress', async t => {
  const f = fixture(t), before = copy(f.state)
  const result = await f.recovery.execute()
  assert.equal(result.phase, 'predicted')
  assert.equal(result.mode, 'shore_recenter')
  assert.equal(result.partial, true)
  assert.equal(result.reachedWaypoint, true)
  assert.equal(result.reachedDestination, false)
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.collected, false)
  const start = f.calls.find(call => call.kind === 'start')
  assert.ok(start)
  assert.equal(start.options.partialRecenter, true)
  assert.equal(start.options.shoreRecenter, true)
  assert.equal(start.options.allowWater, true)
  assert.equal(start.options.sprint, false)
  assert.equal(start.options.maxDistance, 2)
  assert.equal(start.options.maxExpanded, 64)
  assert.equal(start.options.maxTicks, 40)
  assert.equal(f.packets.length, 8)
  assert.ok(f.predictions.every(prediction => prediction.physicsState.onGround && !prediction.physicsState.isInWater))
  assert.ok(f.packets.every(({ packet }) => !packet.input_data.includes('start_jumping') && !packet.input_data.includes('sprinting')))
  for (let index = 1; index < f.packets.length; index++) assert.equal(f.packets[index].packet.tick, f.packets[index - 1].packet.tick + 1n)
  assert.equal(f.navigator.verifyOrigin(f.actual.snapshot().physicsState), true)
  assert.deepEqual(f.state, before)
})

test('a local recenter preserves the original three-dimensional destination and all supplied padding', async t => {
  const destination = { x: -2.5, y: 65, z: 19.5 }
  const circle = { id: 'provided', position: { x: 20, y: 64.62, z: 22 }, minDistance: 3, padding: 0.5 }
  const f = fixture(t, { destination, provided: [circle] })
  f.state.entities = [{ runtimeId: '990', uniqueId: '-990', entityType: 'minecraft:skeleton', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 25, y: 64.62, z: 22 } }]
  const result = await f.recovery.execute()
  assert.equal(result.phase, 'predicted')
  assert.equal(result.reachedDestination, false)
  assert.equal(result.escaped, false)
  assert.deepEqual(f.getDestination(), destination)
  const start = f.calls.find(call => call.kind === 'start')
  const preview = f.calls.filter(call => call.kind === 'preview').at(-1)
  assert.deepEqual(start.options.avoidance, preview.options.avoidance)
  assert.deepEqual(start.options.avoidance.find(actor => actor.id === 'provided'), circle)
  assert.equal(start.options.avoidance.find(actor => actor.id === '990').minDistance, 10)
})

test('unknown mixed support, lava, body obstruction or missing life cannot produce a recovery plan', async t => {
  for (const mode of ['unknown', 'lava', 'body', 'life']) await t.test(mode, t => {
    const f = fixture(t)
    if (mode === 'unknown') f.changes.set('-6,62,23', { known: false })
    if (mode === 'lava') f.changes.set('-6,62,23', normalBlock('lava', { x: -6, y: 62, z: 23 }, { liquid_depth: 0 }))
    if (mode === 'body') f.changes.set('-6,64,22', normalBlock('stone', { x: -6, y: 64, z: 22 }))
    if (mode === 'life') delete f.state.lifecycle.deathId
    assert.equal(f.recovery.preview().ready, false, mode)
    assert.equal(f.packets.length, 0)
  })
})

test('life, session, destination or world changes in the existing before-start gap send no stale movement', async t => {
  for (const mode of ['life', 'session', 'destination', 'world']) await t.test(mode, async t => {
    const f = fixture(t, { destination: { x: -2.5, y: 65, z: 19.5 }, beforeStart: ({ state, changes, setDestination }) => {
      if (mode === 'life') state.lifecycle.deathId++
      if (mode === 'session') state.connectionId = 'another-life-session'
      if (mode === 'destination') setDestination({ x: 10, y: 65, z: 10 })
      if (mode === 'world') changes.set('-6,62,22', { known: false })
    } })
    await assert.rejects(f.recovery.execute({ maxAttempts: 1 }))
    assert.equal(f.packets.length, 0, mode)
    assert.notEqual(f.recovery.snapshot().escaped, true)
    assert.notEqual(f.recovery.snapshot().reachedDestination, true)
  })
})
