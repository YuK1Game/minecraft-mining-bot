'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGuardedRoute } = require('../src/guarded-route')

function fixture ({ partial = false, correction = false, partialArrival = false, originHook = true } = {}) {
  let now = 1000; let stamp = 1000; let motion = { phase: 'idle' }
  const state = { phase: 'spawned', profile: 'origin', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: stamp, positionSource: 'server_post_move', rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: stamp, rawSelectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }] }, heldItem: { slot: 0, name: 'minecraft:stone_sword', count: 1 }, predicted: { physicsState: { onGround: true } }, partial, entities: [{ runtimeId: '2', uniqueId: '2', entityType: 'minecraft:drowned', position: { x: -8.5, y: 65, z: 0.5 }, positionKnown: true, hostile: true, alive: true }] }
  const calls = []
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', target: structuredClone(target), options: structuredClone({ stablePartialOrigin: options.stablePartialOrigin }) }); return { ready: !state.partial || options.stablePartialOrigin === true, waypoints: [{ position: target, medium: 'land', action: 'walk' }] } },
    start: (target, options) => {
      calls.push({ type: 'start', target: structuredClone(target), stablePartialOrigin: options.stablePartialOrigin })
      state.position = { ...target, y: target.y + 1.62 }
      if (correction && calls.filter(call => call.type === 'start').length === 1) state.position.x = 1
      state.positionUpdatedAt = ++stamp
      state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = stamp
      state.positionSource = 'correct_player_move_prediction'
      state.partial = partialArrival || correction && calls.filter(call => call.type === 'start').length === 1
      motion = { phase: state.partial && correction && calls.filter(call => call.type === 'start').length === 1 ? 'replan_required' : 'awaiting_server_confirmation' }
      return motion
    },
    settle: () => { calls.push({ type: 'settle' }); throw new Error('Stable partial support must not neutral settle') },
    stop: () => { motion = { phase: 'stopped' } }
  }
  const standing = (observed, target) => { calls.push({ type: 'standing', partial: observed.partial, target }); return observed.predicted.physicsState.onGround === true && !observed.partial }
  const origin = (observed, target, options) => { calls.push({ type: 'origin', partial: observed.partial, target, stablePartialOrigin: options.stablePartialOrigin }); return observed.predicted.physicsState.onGround === true && (!observed.partial || options.stablePartialOrigin === true) }
  const route = createGuardedRoute({ getState: () => structuredClone(state), getMovement: () => structuredClone(motion), movement, inventory: { equip: () => { throw new Error('Already equipped') }, cancel: () => {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => { throw new Error('No combat') }, cancel: () => {}, drain: () => {} }, verifyStanding: standing, ...(originHook ? { verifyOrigin: origin } : {}), clock: () => now, delay: async ms => { now += ms }, pollMs: 10, operationTimeoutMs: 1000 })
  return { route, state, calls, target: { x: 2.5, y: 65, z: 0.5 } }
}

test('an explicit escape can start from a proven partial origin while ordinary routes and the strict default refuse it', async () => {
  const f = fixture({ partial: true })
  const result = await f.route.escape([f.target])
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.arrived, true)
  assert.equal(f.calls.some(call => call.type === 'settle'), false)
  assert.equal(f.calls.find(call => call.type === 'start').stablePartialOrigin, true)
  assert.ok(f.calls.filter(call => call.type === 'origin').every(call => call.stablePartialOrigin === true))
  for (const mode of ['ordinary', 'default']) {
    const strict = fixture({ partial: true, originHook: mode !== 'default' })
    const rejected = await (mode === 'ordinary' ? strict.route.execute([strict.target]) : strict.route.escape([strict.target]))
    assert.equal(rejected.arrived, false)
    assert.equal(strict.calls.some(call => call.type === 'start'), false)
    assert.equal(strict.calls.some(call => call.type === 'origin'), false)
  }
})

test('a fresh corrected partial origin retries the same escape leg without a neutral-settle deadlock or extra budget', async () => {
  const f = fixture({ correction: true })
  const result = await f.route.escape([f.target], { maxMovementStarts: 2, timeoutMs: 1000 })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.arrived, true)
  assert.equal(result.movementStarts, 2)
  assert.equal(f.calls.some(call => call.type === 'settle'), false)
  assert.ok(f.calls.some(call => call.type === 'origin' && call.partial))
  assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target), [f.target, f.target])
})

test('a proven partial origin cannot certify either a near-target shortcut or a final partial arrival', async () => {
  const f = fixture({ partialArrival: true })
  const result = await f.route.escape([f.target])
  assert.equal(result.ok, false)
  assert.equal(result.arrived, false)
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.calls.some(call => call.type === 'standing' && call.partial))
  const near = fixture({ partial: true, partialArrival: true })
  near.target = { x: 0.7, y: 65, z: 0.5 }
  const rejected = await near.route.escape([near.target])
  assert.equal(rejected.arrived, false)
  assert.equal(rejected.ok, false)
})
