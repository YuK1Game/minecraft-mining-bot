'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGuardedRoute } = require('../src/guarded-route')
const { createNavigator } = require('../src/navigation')
const observed = require('./fixtures/nutrition-hut-corridor-overshoot.json')
const copy = value => structuredClone(value)
const eye = feet => ({ ...feet, y: feet.y + 1.62 })

function fixture (mode = 'valid', asynchronous = true) {
  const blocks = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  const navigator = createNavigator({ world: { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } } })
  const initial = copy(observed.initialPhysicsState)
  const initialEye = eye(initial.position)
  const state = { phase: 'spawned', profile: 'bot', realm: { id: observed.realmId }, dimension: 'overworld', connectionId: 'offline', startedAt: 'offline', runtimeEntityId: '1', gameMode: 'survival', threatPolicy: 'balanced_mining', health: observed.health, inventory: copy(observed.inventory), heldItem: copy(observed.heldItem), rawSelectedSlot: 0, equipmentServerConfirmed: true, position: initialEye, positionSource: 'client_prediction', positionUpdatedAt: 1000, rawServerPosition: copy(initialEye), rawServerPositionUpdatedAt: 1000, predicted: { position: copy(initialEye), physicsState: initial }, entities: copy(observed.initialEntities) }
  if (mode === 'removed_outside') state.entities.push({ runtimeId: '9998', uniqueId: 'outside-only', entityType: 'minecraft:zombie', position: { x: 100, y: 67, z: 17 }, positionKnown: true, alive: true })
  const calls = []; let motion = { phase: 'idle' }; let time = 1000
  const prove = (value, partial = false) => { try { return navigator.verifyOrigin(navigator.physics.fromServer(value), { stablePartialOrigin: partial }) } catch { return false } }
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', target: copy(target) }); return navigator.plan(navigator.physics.fromServer(state), target, options) },
    start: target => {
      calls.push({ type: 'start', target: copy(target) })
      state.position = copy(observed.position); state.rawServerPosition = copy(observed.rawServerPosition); state.positionUpdatedAt = 1001; state.rawServerPositionUpdatedAt = mode === 'stale' ? 1000 : 1001
      state.predicted = { position: copy(state.position), physicsState: copy(observed.correctionPhysicsState) }; state.entities = copy(observed.currentEntities)
      if (mode === 'beyond_corridor') { state.position.z = observed.target.z + 0.451; state.rawServerPosition.z = state.position.z; state.predicted.position.z = state.position.z; state.predicted.physicsState.position.z = state.position.z }
      if (mode === 'stationary') { state.position = copy(initialEye); state.rawServerPosition = copy(initialEye); state.predicted = { position: copy(initialEye), physicsState: copy(initial) } }
      if (mode === 'damage') state.health--
      if (mode === 'unknown') blocks.set('-11,66,18', { known: false })
      if (mode === 'head') blocks.set('-11,68,18', { known: true, position: { x: -11, y: 68, z: 18 }, name: 'minecraft:stone', properties: {}, extra: [] })
      if (mode === 'falling') state.predicted.physicsState.onGround = false
      if (mode === 'new_actor') state.entities.push({ runtimeId: '999', uniqueId: '999', entityType: 'minecraft:creeper', position: { x: -9, y: 67, z: 18 }, positionKnown: true, alive: true })
      if (mode === 'identity') state.entities.find(actor => String(actor.runtimeId) === '13').uniqueId = 'replacement'
      if (mode === 'actor_floor') state.entities.find(actor => String(actor.runtimeId) === '13').position = { x: -9.84, y: 68.62, z: 16.9 }
      motion = { phase: asynchronous ? 'moving' : 'replan_required' }
      return motion
    },
    stop: reason => { calls.push({ type: 'stop', reason }); motion = { phase: 'stopped' } }
  }
  const route = createGuardedRoute({ getState: () => copy(state), movement, getMovement: () => { const value = copy(motion); if (motion.phase === 'moving') motion.phase = 'replan_required'; return value }, inventory: { equip: () => { throw new Error('No fabricated sword') }, cancel: () => {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => { throw new Error('No combat') }, cancel: () => {}, drain: () => {} }, verifyStanding: value => prove(value), verifyOrigin: (value, target, options) => prove(value, options.stablePartialOrigin === true), clock: () => time, delay: async ms => { time += ms }, pollMs: 10, operationTimeoutMs: 1000 })
  return { route, state, calls, prove, options: { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 1000 } }
}

test('the received 0.4067-block overshoot stays a non-arrival handoff inside the existing 0.45-block trajectory corridor', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture('valid', asynchronous)
    assert.equal(f.state.health, 13)
    assert.equal(f.state.heldItem.name, 'minecraft:rotten_flesh')
    assert.equal(f.state.heldItem.count, 2)
    assert.ok(f.state.entities.some(actor => String(actor.runtimeId) === '17'), 'the already-observed drowned is in the initial actor set')
    const result = await f.route.escape([observed.target], f.options)
    assert.equal(result.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify(result))
    assert.equal(result.ok, false)
    assert.equal(result.arrived, false)
    assert.equal(result.escaped, false)
    assert.equal(result.returned, false)
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.movementStarts, 1)
    assert.equal(result.busy, false)
    assert.equal(f.prove(f.state), true)
    const beyond = Math.hypot(f.state.position.x - observed.target.x, f.state.position.z - observed.target.z)
    assert.ok(beyond > 0.406 && beyond < 0.407)
    assert.ok(beyond > 0.4, 'arrival tolerance remains insufficient')
    assert.deepEqual(result.visitedPrefix, [observed.initialPhysicsState.position])
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
    assert.equal(f.calls.filter(call => call.type === 'preview').length, 1)
    assert.ok(f.calls.some(call => call.type === 'stop'))
  }
})

test('the corridor handoff rejects excess displacement and preserves stale, stationary, body and actor guards', async () => {
  for (const mode of ['beyond_corridor', 'stale', 'stationary', 'damage', 'unknown', 'head', 'falling', 'new_actor', 'identity', 'actor_floor']) {
    const f = fixture(mode)
    const result = await f.route.escape([observed.target], f.options)
    assert.notEqual(result.code, 'ESCAPE_PROGRESS_REPLAN', mode)
    assert.equal(result.progressReplan, null, mode)
    assert.equal(result.arrived, false, mode)
    assert.equal(result.escaped, false, mode)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1, mode)
  }
  const removed = fixture('removed_outside')
  assert.equal((await removed.route.escape([observed.target], removed.options)).code, 'ESCAPE_PROGRESS_REPLAN', 'the existing outside-actor disappearance rule is unchanged')
})
