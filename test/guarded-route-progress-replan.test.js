'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGuardedRoute } = require('../src/guarded-route')
const { createNavigator } = require('../src/navigation')

const copy = value => structuredClone(value)
const eye = feet => ({ ...feet, y: feet.y + 1.62 })
function fixture (mode = 'valid') {
  const observed = require('./fixtures/land-overshot-partial-origin.json')
  const blocks = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  const navigator = createNavigator({ world: { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } } })
  const initial = copy(observed.initialPhysicsState)
  const initialEye = eye(initial.position)
  const entities = () => observed.enemies.map(actor => ({ ...copy(actor), hostile: true, alive: true, positionKnown: true, dimension: 'overworld' }))
  const state = { phase: 'spawned', profile: 'bot', realm: { id: observed.realmId }, dimension: 'overworld', connectionId: 'offline', runtimeEntityId: '1', gameMode: 'survival', threatPolicy: 'balanced_mining', health: 20, position: initialEye, rawServerPosition: copy(initialEye), positionUpdatedAt: 1000, rawServerPositionUpdatedAt: 1000, positionSource: 'client_prediction', predicted: { position: copy(initialEye), physicsState: initial }, rawSelectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [] }, heldItem: null, entities: entities().map(actor => ({ ...actor, position: copy(observed.route.avoidance.find(circle => circle.id === actor.runtimeId)?.position ?? actor.position) })) }
  let now = 1000; let motion = { phase: 'idle' }
  const calls = []
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', target: copy(target) }); return navigator.plan(navigator.physics.fromServer(state), target, options) },
    start: target => {
      calls.push({ type: 'start', target: copy(target) })
      state.position = copy(observed.position); state.rawServerPosition = copy(observed.rawServerPosition); state.predicted = copy(observed.predicted)
      state.entities = entities()
      state.positionUpdatedAt = 1001; state.rawServerPositionUpdatedAt = mode === 'stale' ? 1000 : 1001
      if (mode === 'stationary') { state.position = copy(initialEye); state.rawServerPosition = copy(initialEye); state.predicted = { position: copy(initialEye), physicsState: copy(initial) } }
      if (mode === 'prediction_only') state.rawServerPosition = copy(initialEye)
      if (mode === 'damage') state.health = 19
      if (mode === 'falling') state.predicted.physicsState.onGround = false
      if (mode === 'unknown' || mode === 'async_unknown') blocks.set('-17,67,25', { known: false })
      if (mode === 'head') blocks.set('-17,69,25', { known: true, position: { x: -17, y: 69, z: 25 }, name: 'minecraft:stone', properties: {}, extra: [] })
      if (mode === 'actor') state.entities.push({ runtimeId: '999', uniqueId: '999', entityType: 'minecraft:drowned', position: { x: -15, y: 69, z: 25 }, positionKnown: true })
      if (mode === 'outside_actor') state.entities.push({ runtimeId: '999', uniqueId: '999', entityType: 'minecraft:skeleton', position: { x: 20, y: 70, z: 20 }, positionKnown: true })
      if (mode === 'identity') state.entities.find(actor => actor.entityType === 'minecraft:drowned').uniqueId = '999'
      if (mode === 'async_radius') state.entities.find(actor => actor.entityType === 'minecraft:drowned').position = { x: -16.4, y: 69.62, z: 24.5 }
      motion = { phase: mode.startsWith('async') ? 'moving' : 'replan_required' }
      return motion
    },
    stop: reason => { calls.push({ type: 'stop', reason }); motion = { phase: 'stopped' } }
  }
  const prove = (observedState, partial) => { try { return navigator.verifyOrigin(navigator.physics.fromServer(observedState), { stablePartialOrigin: partial }) } catch { return false } }
  const route = createGuardedRoute({ getState: () => copy(state), movement, getMovement: () => { const previous = copy(motion); if (mode.startsWith('async') && motion.phase === 'moving') motion.phase = 'replan_required'; return previous }, inventory: { equip: () => { throw new Error('No synthetic equipment') }, cancel: () => {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => { throw new Error('No combat') }, cancel: () => {}, drain: () => {} }, verifyStanding: observedState => prove(observedState, false), verifyOrigin: (observedState, target, options) => prove(observedState, options.stablePartialOrigin === true), clock: () => now, delay: async ms => { now += ms }, pollMs: 10, operationTimeoutMs: 1000 })
  return { route, state, observed, calls, prove, options: { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 1000 } }
}

test('the actual 36.5 percent overshoot hands a fresh stable partial origin back without arrival, reverse input or a visited target', async () => {
  for (const mode of ['valid', 'async']) {
  const f = fixture(mode)
  const result = await f.route.escape([f.observed.target], f.options)
  assert.equal(result.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify(result))
  assert.equal(result.ok, false)
  assert.equal(result.arrived, false)
  assert.equal(result.escaped, false)
  assert.equal(result.returned, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.movementStarts, 1)
  assert.equal(result.busy, false)
  assert.equal(f.prove(f.state, true), true)
  assert.equal(f.prove(f.state, false), false)
  assert.deepEqual(result.visitedPrefix, [f.observed.initialPhysicsState.position])
  assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target), [f.observed.target])
  assert.equal(f.calls.filter(call => call.type === 'preview').length, 1, 'the passed target is never previewed again')
  assert.ok(f.calls.some(call => call.type === 'stop'))
  assert.deepEqual(result.progressReplan.position, f.observed.position)
  assert.deepEqual(result.progressReplan.authoritativePosition, f.observed.rawServerPosition)
  const length = Math.hypot(f.observed.target.x - result.progressReplan.from.x, f.observed.target.z - result.progressReplan.from.z)
  assert.ok(result.progressReplan.targetOvershoot / length > 0.35 && result.progressReplan.targetOvershoot / length < 0.37)
  }
})

test('stationary, stale, prediction-only, damaged, changed-actor and invalid-origin observations cannot earn a progress handoff', async () => {
  for (const mode of ['stationary', 'stale', 'prediction_only', 'damage', 'actor', 'outside_actor', 'identity', 'falling', 'unknown', 'head', 'async_unknown', 'async_radius']) {
    const f = fixture(mode)
    const result = await f.route.escape([f.observed.target], f.options)
    assert.notEqual(result.code, 'ESCAPE_PROGRESS_REPLAN', mode)
    assert.equal(result.progressReplan, null, mode)
    assert.equal(result.arrived, false, mode)
    assert.equal(result.escaped, false, mode)
    assert.equal(result.movementStarts, 1, mode)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1, mode)
  }
})

test('a completed handoff cannot extend the consumed start budget or retain a handoff in the next route', async () => {
  const f = fixture()
  const first = await f.route.escape([f.observed.target], f.options)
  assert.equal(first.code, 'ESCAPE_PROGRESS_REPLAN')
  const next = await f.route.escape([{ x: -16.29633331298828, y: 68, z: 25.053003129083663 }], f.options)
  assert.equal(next.progressReplan, null)
  assert.equal(next.arrived, false)
  assert.equal(next.escaped, false)
})
