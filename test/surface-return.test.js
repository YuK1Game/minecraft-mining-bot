'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createPhysics } = require('../src/physics'), { createMovement } = require('../src/movement')
const { createInput } = require('../src/input')
const file = path.resolve(__dirname, '../src/surface-return.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file)); loaded._compile(fs.readFileSync(process.env.SURFACE_RETURN_TEST_SOURCE ?? file, 'utf8'), file)
const { createSurfaceReturn, planObservedGroundReturn, proveReturnCover, returnScope } = loaded.exports
const capture = require('./fixtures/surface-return-0f5e.json'), copy = v => structuredClone(v), key = p => [p.x, p.y, p.z].join(',')
const received = new Map(capture.blocks.map(b => [key(b.position), b]))
const capturedWorld = { getBlock: (x, y, z) => received.get([x, y, z].join(',')) ?? { known: false, position: { x, y, z } } }
const prepared = createPhysics({ world: capturedWorld, version: '1.26.60' })

function fixture (t, mutate = null, { neutral = false, settleCursor = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, owner = true, motionOrigin = null, wire = null
  const epoch = Date.parse(capture.state.positionUpdatedAt), state = copy(capture.state), changes = new Map(), frames = [], packets = [], neutralFrames = [], starts = [], landings = []
  state.rotation = { yaw: state.predicted.physicsState.yaw, pitch: 0 }
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const world = { getBlock: (x, y, z) => changes.get([x, y, z].join(',')) ?? capturedWorld.getBlock(x, y, z) }, physics = prepared.withWorld(world)
  const client = { queue: (name, packet) => { packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } }
  const queued = frame => { if (frame.receiptConfirmed) wire = { tick: String(frame.tick), queuedAt: frame.queuedAt, source: 'actual_client_queue_receipt', scope: JSON.stringify([state.connectionId, state.startedAt]) } }
  const publish = prediction => {
      const stamp = new Date(epoch + elapsed).toISOString()
      state.position = copy(prediction.position); state.positionSource = 'client_prediction'; state.positionUpdatedAt = stamp
      state.predicted = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: stamp }
      mutate?.({ state, changes, frames, packets, movement, setOwner: v => { owner = v } })
  }
  const movement = createMovement({ world, physics, version: '1.26.60', getState: () => motionOrigin ?? copy(state), clock: () => elapsed, startGame: { current_tick: 1000n }, startGameReceivedAt: 0, client,
    ...(neutral ? { getQueuedCursor: () => wire } : {}), onQueuedFrame: frame => { frames.push(copy(frame)); queued(frame) }, onPrediction: publish })
  const input = neutral ? createInput({ client, getState: () => copy(state), version: '1.26.60', clock: () => elapsed, startGame: { current_tick: 1000n, server_authoritative_block_breaking: true, player_gamemode: 'survival' }, startGameReceivedAt: 0, getQueuedCursor: () => wire,
    onQueuedFrame: frame => { neutralFrames.push(copy(frame)); queued(frame) }, frameProvider: () => { const next = physics.step(copy(state.predicted.physicsState), {}), eye = physics.toServerPosition(next); return { position: eye, delta: next.velocity, controls: {}, predictedState: next, commitPrediction: () => publish({ position: eye, feetPosition: next.position, velocity: next.velocity, onGround: next.onGround, physicsState: next }) } } }) : null
  const ownedMovement = { preview: (...args) => movement.preview(...args), start: (...args) => { input?.stop(false); motionOrigin = copy(state); starts.push(copy(state)); return movement.start(...args) }, stop: (...args) => { const before = movement.snapshot(); if (before.phase === 'awaiting_server_confirmation') landings.push(copy(before.physicsState)); const result = movement.stop(...args); motionOrigin = null; input?.start(); return result } }
  const controller = createSurfaceReturn({ getState: () => copy(state), world, physics, movement: ownedMovement, getMovement: () => movement.snapshot(), ...(neutral ? { getQueuedCursor: () => settleCursor ? settleCursor(wire, epoch + elapsed) : wire } : {}), canAct: () => owner, clock: () => epoch + elapsed, delay: async (ms, signal) => { if (signal?.aborted) throw signal.reason; elapsed += ms; t.mock.timers.tick(ms); await Promise.resolve(); if (signal?.aborted) throw signal.reason } })
  input?.start()
  t.after(async () => { await controller.stop('Test cleanup'); input?.stop(false); movement.stop('Test cleanup') })
  return { state, world, physics, movement, input, controller, frames, neutralFrames, starts, landings, packets, changes, setOwner: v => { owner = v } }
}

test('actual new-connection received ground discovers a two-step Native ascent with explicit cover and intact canonical radii', () => {
  const state = copy(capture.state), before = copy(state), plan = planObservedGroundReturn({ state, world: capturedWorld, physics: prepared })
  assert.equal(plan.ready, true, plan.code); assert.equal(plan.surfaceReached, false)
  assert.deepEqual(plan.target, { x: -43.5, y: -4, z: 13.5 }); assert.equal(plan.waypoints.length, 2); assert.equal(plan.frames.length, 22)
  assert.ok(plan.scope.includes('0f5e63ea-4116-4720-b087-a86bb9859290')); assert.ok(!plan.scope.includes('85a7e65e'))
  assert.equal(plan.canonical.find(c => c.id === '13651').minDistance, 10); assert.equal(plan.canonical.find(c => c.id === '13650').minDistance, 5)
  assert.ok(plan.exceptions.every(e => ['minecraft:skeleton', 'minecraft:zombie'].includes(e.actor.entityType)))
  assert.equal(plan.frames.at(-1).predictedState.onGround, true); assert.equal(plan.serverConfirmed, false); assert.deepEqual(state, before)
})

test('real Movement queues the scoped covered prefix and returns only current partial ascent, with no inventory or surface credit', async t => {
  const f = fixture(t), inventory = copy(f.state.inventory), raw = copy(f.state.rawServerPosition)
  const result = await f.controller.execute({ maxLegs: 1 })
  const modeled = f.frames.filter(f => f.modeled && f.receiptConfirmed)
  assert.equal(modeled.length, 22); assert.equal(result.phase, 'predicted'); assert.equal(result.surfaceReached, false); assert.equal(result.serverConfirmed, false)
  assert.equal(result.feetPosition.y, -4); assert.equal(f.movement.snapshot().running, false)
  assert.ok(result.coverExceptions.some(e => e.id === '13651' && e.canonicalRadius === 10))
  assert.deepEqual(f.state.inventory, inventory); assert.deepEqual(f.state.rawServerPosition, raw)
})

test('cover requires every complete known ray and never exempts creepers or unknown actors', () => {
  const state = copy(capture.state), actor = state.entities.find(e => e.runtimeId === '13651')
  assert.equal(proveReturnCover({ world: capturedWorld, eye: state.position, actor }).ready, true)
  const unknown = { getBlock: (x, y, z) => x === -41 && y === -1 && z === 15 ? { known: false, position: { x, y, z } } : capturedWorld.getBlock(x, y, z) }
  assert.equal(proveReturnCover({ world: unknown, eye: state.position, actor }).ready, false)
  assert.equal(proveReturnCover({ world: capturedWorld, eye: state.position, actor: { ...actor, entityType: 'minecraft:creeper' } }).ready, false)
  const bad = copy(state); bad.entityStats.unknownPositions++
  assert.throws(() => planObservedGroundReturn({ state: bad, world: capturedWorld, physics: prepared }), /unknown/i)
})

test('a modeled outdoor standing point needs a complete received sky column, not a numeric surface height', async () => {
  const base = copy(capture.state); base.position = { x: 0.5, y: 1.62, z: 0.5 }; base.positionSource = 'start_game'; base.rawServerPosition = copy(base.position); base.predicted = null; base.entities = []; base.entityStats = { unknownPositions: 0 }
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < 0 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [], boundingBox: y < 0 ? 'block' : 'empty' }) }, physics = prepared.withWorld(world)
  const movement = { preview: () => assert.fail('Already outdoor'), start: () => assert.fail('Already outdoor'), stop: () => {} }
  const controller = createSurfaceReturn({ getState: () => copy(base), world, physics, movement, getMovement: () => ({ running: false }), canAct: () => true })
  const result = await controller.execute({ maxLegs: 1 })
  assert.equal(result.surfaceReached, true); assert.equal(result.surfaceProof.scope, returnScope(base)); assert.equal(result.serverConfirmed, false)
  const roof = { getBlock: (x, y, z) => y === 100 ? { ...world.getBlock(x, y, z), name: 'minecraft:stone', boundingBox: 'block' } : world.getBlock(x, y, z) }
  assert.notEqual(planObservedGroundReturn({ state: base, world: roof, physics: prepared.withWorld(roof) }).surfaceReached, true)
})

test('a far covered NPC remains a strict circle instead of an unnecessary frozen-pose exception', () => {
  const state = copy(capture.state), actor = { runtimeId: '99901', uniqueId: '-99901', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: -37.5, y: 4, z: 21.5 } }
  state.entities.push(actor)
  // A controlled known stone extension/room tests selection only. It is not
  // additional received terrain in the historical live fixture.
  const world = { getBlock: (x, y, z) => {
    const existing = received.get([x, y, z].join(',')); if (existing) return existing
    const empty = x >= -39 && x <= -36 && y >= 4 && y <= 6 && z >= 20 && z <= 23
    return { known: true, position: { x, y, z }, name: empty ? 'minecraft:air' : 'minecraft:stone', boundingBox: empty ? 'empty' : 'block', extra: [], properties: {} }
  } }
  assert.equal(proveReturnCover({ world, eye: state.position, actor }).ready, true)
  const plan = planObservedGroundReturn({ state, world, physics: prepared.withWorld(world) })
  assert.equal(plan.ready, true); assert.ok(plan.canonical.some(c => c.id === actor.runtimeId && c.minDistance === 5))
  assert.ok(!plan.exceptions.some(c => c.id === actor.runtimeId), 'an uncrossed outside boundary does not require a cover exception')
})

test('a same-UID covered NPC moving safely outside its current circle does not interrupt real queued ascent', async t => {
  let changed = false
  const f = fixture(t, ({ state, frames }) => { if (!changed && frames.filter(f => f.modeled).length === 3) { changed = true; const a = state.entities.find(a => a.runtimeId === '13730'); a.position = { x: -10, y: 0, z: 40 }; a.positionUpdatedAt = new Date(Date.now()).toISOString() } })
  const result = await f.controller.execute({ maxLegs: 1 })
  assert.equal(changed, true); assert.equal(result.phase, 'predicted'); assert.equal(result.feetPosition.y, -4)
  assert.equal(f.frames.filter(f => f.modeled && f.receiptConfirmed).length, 22)
})

test('a moved same-UID NPC with newly open cover rejects the next modeled input before queueing', async t => {
  let changed = false
  const f = fixture(t, ({ state, frames }) => { if (!changed && frames.filter(f => f.modeled).length === 3) { changed = true; const a = state.entities.find(a => a.runtimeId === '13651'); a.position = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }; a.positionUpdatedAt = new Date(Date.now()).toISOString() } })
  await assert.rejects(f.controller.execute({ maxLegs: 1 }), error => error.code === 'REPLAN_REQUIRED')
  assert.equal(changed, true); assert.equal(f.frames.filter(f => f.modeled && f.receiptConfirmed).length, 3)
  assert.equal(f.controller.snapshot().surfaceReached, false)
})

test('actual queued neutral physics settles residual landing drift before a second graph leg', async t => {
  const f = fixture(t, null, { neutral: true }), inventory = copy(f.state.inventory)
  const result = await f.controller.execute({ maxLegs: 2, up: 1 })
  assert.equal(result.phase, 'predicted'); assert.equal(result.legs, 2); assert.equal(result.feetPosition.y, -4)
  assert.ok(f.neutralFrames.length >= 6, 'both waits observed actual Input queue receipts')
  assert.equal(result.settle.stableFrames, 3)
  assert.ok(f.neutralFrames.every(frame => frame.receiptConfirmed && frame.modeled && frame.producer === 'input'))
  const firstLanding = f.physics.toServerPosition(f.landings[0]), settledNextStart = f.starts[1].position
  const drift = Math.hypot(firstLanding.x - settledNextStart.x, firstLanding.y - settledNextStart.y, firstLanding.z - settledNextStart.z)
  assert.ok(drift > 1e-4 && drift < 0.4, JSON.stringify({ drift, firstLanding, settledNextStart, firstVelocity: f.landings[0].velocity, starts: f.starts.length }))
  assert.deepEqual(f.state.inventory, inventory); assert.equal(result.surfaceReached, false); assert.equal(result.serverConfirmed, false)
})

test('missing, stale, future or other-connection cursor metadata cannot manufacture a settled receipt', async t => {
  for (const [name, settleCursor] of [
    ['missing', () => null],
    ['stale', wire => wire && { ...wire, queuedAt: wire.queuedAt - 1000 }],
    ['future', (wire, now) => wire && { ...wire, queuedAt: now + 1000 }],
    ['other_connection', wire => wire && { ...wire, scope: JSON.stringify(['old-connection', 'old-session']) }]
  ]) await t.test(name, async t => {
    const f = fixture(t, null, { neutral: true, settleCursor })
    await assert.rejects(f.controller.execute({ maxLegs: 2, up: 1 }), error => error.code === 'SETTLE_TIMEOUT')
    assert.equal(f.starts.length, 0); assert.equal(f.frames.filter(frame => frame.modeled).length, 0)
    assert.ok(f.neutralFrames.length > 0, 'real Input continued; only untrusted settle metadata was rejected')
  })
})
