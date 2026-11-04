'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { createGuardedRoute } = require('../src/guarded-route')
const copy = value => structuredClone(value)
const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
const prepared = createPhysics({ world })
const originRange = 12.520670751661077

function fixture (t, mode = 'valid') {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, origin = null, lastFull = null, changed = false
  const epoch = 1800000000000
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const blocks = new Map(), nativeWorld = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? world.getBlock(x, y, z) }
  const physics = prepared.withWorld(nativeWorld), navigator = createNavigator({ world: nativeWorld, physics })
  const initial = physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } })
  const target = { x: 0.73, y: 65, z: 1.25 }
  const skeleton = { runtimeId: '9', uniqueId: '-9', kind: 'mob', entityType: 'minecraft:skeleton', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: 0.5 - Math.sqrt(originRange ** 2 - 1.62 ** 2), y: 65, z: 0.5 } }
  const state = { phase: 'spawned', profile: 'native-progress', realm: { id: '42' }, connectionId: 'offline', startedAt: 'native-life', runtimeEntityId: '1', lifecycle: { deathId: 0 }, dimension: 'overworld', gameMode: 'survival', threatPolicy: 'balanced_mining', health: 20, inventory: { known: true, items: [] }, heldItem: null, rawSelectedSlot: 0, equipmentServerConfirmed: true, position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: epoch, entities: [skeleton], vitals: { hunger: { value: 20, source: 'server_attribute' } } }
  let prediction = { position: copy(state.position), physicsState: initial }
  const packets = [], frames = []
  const working = () => ({ ...copy(state), position: copy(prediction.position), positionSource: 'client_prediction', positionUpdatedAt: epoch + elapsed + 1, rawServerPosition: copy(state.position), rawServerPositionUpdatedAt: state.positionUpdatedAt, predicted: copy(prediction) })
  const movement = createMovement({ world: nativeWorld, physics, getState: () => origin ?? working(), version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, client: { queue: (name, packet) => { packets.push({ name, packet: copy(packet) }); return mode === 'no_receipt' ? undefined : { tick: packet.tick } } }, onQueuedFrame: frame => frames.push(copy(frame)), onPrediction: value => {
    prediction = copy(value)
    if (value.phase === 'awaiting_server_confirmation') {
      lastFull = copy(value)
      if (changed) return
      changed = true
      if (mode === 'unknown') blocks.set('0,64,1', { known: false })
      if (mode === 'wet') prediction.physicsState.isInWater = true
      if (mode === 'airborne') prediction.physicsState.onGround = false
      if (mode === 'damage') state.health--
      if (mode === 'identity') skeleton.uniqueId = '-999'
      if (mode === 'life') state.lifecycle.deathId++
      if (mode === 'unsafe_actor') skeleton.position = { x: value.position.x + 0.1, y: 65, z: value.position.z }
    }
  } })
  const advance = ms => { elapsed += ms; t.mock.timers.tick(ms) }
  const proof = value => { try { return navigator.verifyOrigin(physics.fromServer(value)) } catch { return false } }
  const guard = createGuardedRoute({ getState: working, getMovement: () => {
    const motion = movement.snapshot()
    if (motion.phase === 'awaiting_server_confirmation') {
      if (mode === 'wrong_tick') motion.queuedTick = '1'
      if (mode === 'active_controls') motion.controls = { forward: true }
      if (mode === 'wrong_target') motion.target.x++
      if (mode === 'old_receipt') motion.queuedAt = epoch - 500
    }
    return motion
  }, movement: { preview: movement.preview, start: (destination, options) => { origin = working(); return movement.start(destination, options) }, stop: movement.stop }, inventory: { equip: () => assert.fail('No invented equipment'), cancel () {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => assert.fail('No combat'), cancel () {}, drain () {} }, verifyStanding: proof, verifyOrigin: proof, clock: Date.now, delay: async ms => advance(ms), pollMs: 50, operationTimeoutMs: 1500 })
  t.after(() => movement.stop('test_cleanup'))
  return { guard, movement, navigator, physics, state, working, target, skeleton, packets, frames, lastFull: () => lastFull, range: point => Math.hypot(point.x - skeleton.position.x, point.y - skeleton.position.y, point.z - skeleton.position.z) }
}

test('real queued Native braking ends 3.7cm below the required gain and requests only a full-supported partial-progress replan', async t => {
  const f = fixture(t), raw = copy(f.state.position), result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 2, maxMovementStarts: 1, timeoutMs: 2000 })
  const native = f.lastFull()
  assert.ok(native, JSON.stringify(result))
  assert.ok(f.range({ ...f.target, y: f.target.y + 1.62 }) >= originRange + 0.25)
  const range = f.range(native.position), shortfall = originRange + 0.25 - range
  assert.ok(shortfall > 0.037 && shortfall < 0.038, String(shortfall))
  assert.equal(native.settled, true); assert.equal(native.physicsState.onGround, true)
  assert.ok(f.frames.some(frame => frame.receiptConfirmed && String(frame.tick) === native.tick))
  let coast = native.physicsState
  for (let tick = 0; tick < 8; tick++) coast = f.physics.step(coast, {})
  assert.ok(f.range(f.physics.toServerPosition(coast)) < originRange + 0.25, 'eight further neutral coast ticks cannot supply the missing gain')
  assert.equal(result.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify(result))
  assert.equal(result.progressReplan.kind, 'native_partial_landing')
  assert.ok(result.progressReplan.primaryGain >= 0.1 && result.progressReplan.primaryGain < 0.25)
  assert.equal(result.ok, false); assert.equal(result.arrived, false); assert.equal(result.escaped, false); assert.equal(result.serverConfirmed, false)
  assert.deepEqual(result.visitedPrefix, [{ x: raw.x, y: raw.y - 1.62, z: raw.z }])
  assert.equal(result.movementStarts, 1)
  assert.deepEqual(f.state.position, raw)
})

test('Native partial-progress handoff rejects missing or stale queue proof, changed life/actors, damage and invalid full landing', async t => {
  for (const mode of ['no_receipt', 'wrong_tick', 'old_receipt', 'wrong_target', 'active_controls', 'life', 'identity', 'unsafe_actor', 'damage', 'unknown', 'wet', 'airborne']) await t.test(mode, async t => {
    const f = fixture(t, mode), result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 2, maxMovementStarts: 1, timeoutMs: 2000 })
    assert.notEqual(result.code, 'ESCAPE_PROGRESS_REPLAN', mode)
    assert.equal(result.progressReplan, null, mode)
    assert.equal(result.arrived, false, mode); assert.equal(result.escaped, false, mode); assert.equal(result.serverConfirmed, false, mode)
    assert.equal(result.movementStarts, 1)
  })
})
