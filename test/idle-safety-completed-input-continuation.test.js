'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createIdleSafety } = require('../src/idle-safety')
const capture = require('./fixtures/completed-dry-input-anchor.json')
const copy = value => structuredClone(value)

function fixture (t, { mode = 'safe', repeat = false } = {}) {
  let time = Date.parse(capture.observedAt), attempts = 0, checks = 0
  const proofs = new WeakMap(), calls = [], emergencies = []
  const actor = { ...copy(capture.primary), position: copy(capture.initialPrimaryPosition), dimension: 'overworld', kind: 'mob', alive: true, hostile: true, positionKnown: true }
  const state = { phase: 'spawned', profile: 'completed-input', realm: { id: '42' }, connectionId: 'socket', startedAt: 'life', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', threatPolicy: 'balanced_mining', health: capture.health, inventory: { known: true, items: [] }, equipmentServerConfirmed: true, rawSelectedSlot: 0, heldItem: null, position: { ...capture.origin, y: capture.origin.y + 1.62 }, rawServerPosition: copy(capture.rawServerPosition), rawServerPositionUpdatedAt: capture.rawServerPositionUpdatedAt, predicted: copy(capture.predicted), entities: [actor], fullStanding: true }
  const safety = createIdleSafety({
    getState: () => copy(state), isIdle: () => true, equipSword: () => assert.fail('No equipment'), closeGui () {}, previewEngage: () => ({ ready: false }), engage: () => assert.fail('No combat'),
    verifyBody: observed => observed.fullStanding,
    verifyCompletedDryProgress: (result, observed, context) => {
      checks++
      const proof = proofs.get(result)
      if (mode === 'late_actor' && checks === 2) state.entities.push({ ...copy(actor), runtimeId: '77', uniqueId: 'late', position: { x: 10, y: 68, z: 25 } })
      if (mode === 'late_identity' && checks === 2) actor.uniqueId = 'late-replacement'
      if (mode === 'late_body' && checks === 2) state.fullStanding = false
      return !!proof && proof.operationId === context.operationId && state.fullStanding && observed.fullStanding && !['no_input', 'shadow', 'gap', 'stale_anchor', 'correction'].includes(mode)
    },
    escape: context => {
      attempts++; calls.push({ result: copy(safety.snapshot().lastResult), continuation: copy(safety.snapshot().lastContinuation) })
      if (attempts > 1 && !repeat) {
        state.entities = []; state.position.x += 10
        return { supported: true, arrived: true, escaped: true, serverConfirmed: false }
      }
      if (attempts === 1) { state.position = copy(capture.position); actor.position = copy(capture.primary.position) } else { state.position.x += 0.25; actor.position.x += 0.25 }
      if (mode === 'damage') state.health--
      if (mode === 'scope') state.connectionId = 'replacement'
      if (mode === 'lifecycle') state.startedAt = 'new-life'
      if (mode === 'unknown') actor.positionKnown = false
      if (mode === 'body') state.fullStanding = false
      if (mode === 'unsafe_actor') actor.position = { ...state.position, x: state.position.x - 3.5 }
      if (mode === 'primed') actor.primed = true
      if (mode === 'new_active') state.entities.push({ ...copy(actor), runtimeId: '88', uniqueId: 'new-active', position: { ...state.position, x: state.position.x + 3 } })
      const result = { supported: true, arrived: mode !== 'unarrived', escaped: false, partialEscape: mode !== 'failed', serverConfirmed: false }
      if (mode === 'failed') result.code = 'NO_SAFE_RETREAT'
      if (mode === 'interrupted') result.routeInterruption = { reason: 'changed route' }
      if (mode === 'rejected') result.routeRejection = { reason: 'actor_radius' }
      if (mode !== 'no_input') proofs.set(result, { operationId: context.operationId })
      return result
    },
    cancelOwned () {}, onEmergencyStop: detail => emergencies.push(detail), intervalMs: 1000, graceMs: 0, actionTimeoutMs: 1000, now: () => time
  })
  t.after(() => safety.stop('test_cleanup'))
  const run = async () => { safety.start({ enableEpoch: 1 }); await safety.tick(); time++; await safety.tick(); await safety.drain() }
  return { safety, state, calls, emergencies, run, attempts: () => attempts, checks: () => checks }
}

test('captured completed dry landing can continue on its private queued-input proof with the 1.5s unchanged raw anchor', async t => {
  const f = fixture(t)
  const raw = copy(f.state.rawServerPosition), rawStamp = f.state.rawServerPositionUpdatedAt
  assert.ok(Date.parse(capture.observedAt) - rawStamp > 1500)
  assert.ok(Math.abs(Math.hypot(capture.position.x - raw.x, capture.position.y - raw.y, capture.position.z - raw.z) - 0.8189606528157075) < 1e-9)
  await f.run()
  assert.equal(f.attempts(), 2, JSON.stringify(f.safety.snapshot()))
  assert.equal(f.calls[1].continuation.continued, true)
  assert.equal(f.calls[1].continuation.bodyVerified, true)
  assert.equal(f.calls[1].continuation.rawProgress, 0)
  assert.ok(f.calls[1].continuation.currentDistance >= 6)
  assert.ok(f.calls[1].continuation.currentDistance < f.calls[1].continuation.originalDistance - 0.5)
  assert.equal(f.calls[1].result.escaped, false)
  assert.equal(f.calls[1].result.serverConfirmed, false)
  assert.equal(f.emergencies.length, 0)
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(f.state.rawServerPositionUpdatedAt, rawStamp)
  assert.equal(f.state.health, 12)
  assert.deepEqual(f.state.inventory.items, [])
})

test('completed input proof does not bypass failed routes, missing evidence, current safety checks or late roster/body races', async t => {
  for (const mode of ['no_input', 'shadow', 'gap', 'stale_anchor', 'correction', 'damage', 'scope', 'lifecycle', 'unknown', 'body', 'unsafe_actor', 'primed', 'new_active', 'unarrived', 'failed', 'interrupted', 'rejected', 'late_actor', 'late_identity', 'late_body']) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), 1, mode + ': ' + JSON.stringify(f.safety.snapshot()))
    assert.notEqual(f.safety.snapshot().lastContinuation?.continued, true, mode)
    assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false, mode)
  }
})

test('completed queued-input continuation retains eight escape actions and gives no resource or server credit', async t => {
  const f = fixture(t, { repeat: true })
  await f.run()
  assert.equal(f.attempts(), 8)
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.safety.snapshot().lastContinuation.failedPredicate, 'escape_action_limit')
  assert.equal(f.safety.snapshot().lastResult.escaped, false)
  assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false)
  assert.deepEqual(f.state.inventory.items, [])
})
