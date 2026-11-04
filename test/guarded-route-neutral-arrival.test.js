'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createInput } = require('../src/input')
const { createMovement } = require('../src/movement')
const { createGuardedRoute } = require('../src/guarded-route')
const capture = require('./fixtures/ordinary-terminal-coast.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const baseBlocks = new Map(capture.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
const prepared = createPhysics({ world: { getBlock: (x, y, z) => baseBlocks.get(`${x},${y},${z}`) ?? { known: false } } })

function fixture (t, mode = 'valid') {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, tick = 1000n, origin = null
  const epoch = Date.parse(capture.observedAt)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const blocks = new Map(baseBlocks)
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const physics = prepared.withWorld(world), navigator = createNavigator({ world, physics })
  let prediction = { position: eye(capture.initialPhysicsState.position), physicsState: copy(capture.initialPhysicsState) }
  const state = { profile: 'guard-coast', realm: { id: '42' }, dimension: 'overworld', connectionId: 'offline', startedAt: 'coast-life', runtimeEntityId: '1', phase: 'spawned', gameMode: 'survival', threatPolicy: 'balanced_mining', health: capture.health, position: copy(capture.rawServerPosition), positionUpdatedAt: epoch, inventory: { known: true, items: [] }, heldItem: null, rawSelectedSlot: 0, equipmentServerConfirmed: true, rotation: { yaw: 11.25, pitch: 0 }, entities: capture.enemies.map(actor => ({ ...copy(actor), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })) }
  const pursuer = state.entities.find(actor => actor.runtimeId === '8')
  pursuer.position = copy(capture.initialPursuer)
  const records = [], predictions = [], packets = []
  const working = () => ({ ...copy(state), position: copy(prediction.position), positionUpdatedAt: epoch + elapsed + 1, positionSource: 'client_prediction', positionServerConfirmed: false, rawServerPosition: copy(state.position), rawServerPositionUpdatedAt: state.positionUpdatedAt, predicted: copy(prediction) })
  const common = { version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => elapsed,
    client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); tick = packet.tick; packets.push(copy(packet)); return { tick } } },
    onQueuedFrame: frame => records.push(copy(frame)), getQueuedCursor: () => records.length ? { tick: records.at(-1).tick, queuedAt: records.at(-1).queuedAt } : null }
  const movement = createMovement({ ...common, getState: () => origin ?? working(), world, physics, onPrediction: value => {
    prediction = copy(value); predictions.push(copy(value))
    const dx = capture.position.x - pursuer.position.x, dz = capture.position.z - pursuer.position.z, length = Math.hypot(dx, dz)
    if (length > 0.1) { pursuer.position.x += dx / length * 0.1; pursuer.position.z += dz / length * 0.1 }
    const passed = prediction.position.z > capture.target.z && prediction.physicsState.onGround && Object.values(prediction.controls ?? {}).every(value => !value)
    if (passed && mode === 'airborne') prediction.physicsState.onGround = false
    if (passed && mode === 'unsafe_actor') pursuer.position = { ...prediction.position, z: prediction.position.z + 0.2 }
    if (passed && mode === 'unknown_body') blocks.set('-10,66,48', { known: false })
    if (passed && mode === 'outside_arrival') { prediction.position.z = capture.target.z - 0.41; prediction.physicsState.position.z = prediction.position.z }
  } })
  const input = createInput({ ...common, getState: working, frameProvider: () => {
    const model = physics.step(physics.fromServer(working()), {}), position = physics.toServerPosition(model)
    return { position, delta: model.velocity, controls: {}, predictedState: model, commitPrediction: () => { prediction = { position, physicsState: model } } }
  } })
  const advance = ms => { elapsed += ms; t.mock.timers.tick(ms) }
  input.start(); advance(50); input.stop(false)
  const prove = (observed, partial = false) => { try { return navigator.verifyOrigin(physics.fromServer(observed), { stablePartialOrigin: partial }) } catch { return false } }
  const guard = createGuardedRoute({ getState: working, getMovement: () => {
    const value = movement.snapshot()
    if (mode === 'wrong_target') value.target = { ...capture.target, z: capture.target.z + 1 }
    if (mode === 'nonneutral') value.controls = { forward: true }
    return value
  }, movement: { preview: movement.preview, start: (target, options) => { origin = working(); return movement.start(target, options) }, stop: movement.stop }, inventory: { equip: () => assert.fail('No equipment'), cancel () {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => assert.fail('No combat'), cancel () {}, drain () {} }, verifyStanding: observed => prove(observed), verifyOrigin: (observed, target, options) => prove(observed, options.stablePartialOrigin), clock: Date.now, delay: async ms => advance(ms), pollMs: 50, operationTimeoutMs: 1500 })
  t.after(() => { input.stop(false); movement.stop('test_cleanup') })
  return { guard, movement, records, predictions, packets, working, prove, state }
}

test('real queued neutral coast 3.3cm past the actual downhill target keeps its swept proof without a reverse remainder', async t => {
  const f = fixture(t), raw = copy(f.state.position)
  const result = await f.guard.escape([capture.target], { allowUnarmedBootstrap: true, maxLegDistance: 2, maxMovementStarts: 1, timeoutMs: 2000 })
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.interruptions, 0, JSON.stringify(result))
  assert.equal(result.routeInterruption, null)
  assert.equal(result.remainingRouteRejection, null)
  const observed = f.predictions.find(value => distance(value.position, capture.position) < 1e-6)
  assert.ok(observed, JSON.stringify(f.predictions.map(value => ({ position: value.position, phase: value.phase, controls: value.controls }))))
  assert.equal(observed.phase, 'moving')
  assert.deepEqual(observed.controls, {})
  assert.ok(f.records.some(frame => frame.receiptConfirmed && String(frame.tick) === observed.tick))
  assert.ok(f.prove(f.working()))
  assert.equal(result.movementStarts, 1)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.state.position, raw)
})

test('unarrived, airborne, unsafe, unknown, wrong-target or active-input observations cannot earn a clean neutral arrival', async t => {
  for (const mode of ['outside_arrival', 'airborne', 'unsafe_actor', 'unknown_body', 'wrong_target', 'nonneutral']) await t.test(mode, async t => {
    const f = fixture(t, mode)
    const result = await f.guard.escape([capture.target], { allowUnarmedBootstrap: true, maxLegDistance: 2, maxMovementStarts: 1, timeoutMs: 2000 })
    assert.ok(!result.arrived || result.routeInterruption != null, mode + ': ' + JSON.stringify(result))
    assert.equal(result.serverConfirmed, false, mode)
    assert.equal(result.movementStarts, 1, mode)
  })
})
