'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createIdleSafety } = require('../src/idle-safety')
const copy = value => structuredClone(value)

function fixture (t, { mode = 'safe', repeat = false } = {}) {
  let time = 1000, attempts = 0, safety
  const calls = [], emergency = []
  const creeper = { runtimeId: '17', uniqueId: 'creeper-seventeen', entityType: 'minecraft:creeper', dimension: 'overworld', kind: 'mob', hostile: true, alive: true, positionKnown: true, primed: false, charged: false, position: { x: -6.3, y: 65, z: 0.5 } }
  const outside = { ...copy(creeper), runtimeId: '30', uniqueId: 'known-outside', entityType: 'minecraft:skeleton', position: { x: 30, y: 65, z: 0.5 } }
  if (mode.startsWith('removed_')) { outside.entityType = 'minecraft:spider'; outside.position.x = 42 }
  const state = { phase: 'spawned', profile: 'successful-dry-progress', realm: { id: '42' }, startedAt: 'session', connectionId: 'socket', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', threatPolicy: 'balanced_mining', health: 13, rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: null, inventory: { known: true, items: [] }, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, predicted: { physicsState: { onGround: true, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.0784, z: 0 } } }, entities: [creeper, outside], bodyKnown: true, supportKnown: true }
  if (mode === 'bounded_diff') for (let n = 31; n <= 42; n++) state.entities.push({ ...copy(outside), runtimeId: String(n), uniqueId: `outside-${n}` })
  if (mode === 'removed_preexisting') state.removedEntities = [{ runtimeId: outside.runtimeId, uniqueId: outside.uniqueId, entityType: outside.entityType, removedAt: time }]
  safety = createIdleSafety({
    getState: () => copy(state), isIdle: () => true, equipSword: () => ({ serverConfirmed: false }), closeGui () {}, previewEngage: () => ({ ready: false }), engage: () => assert.fail('No synthetic combat'),
    verifyBody: observed => {
      if (mode === 'body_race' && attempts === 1) state.entities.push({ ...copy(outside), runtimeId: '31', uniqueId: 'new-after-body' })
      if (mode === 'removed_body_race' && attempts === 1) state.removedEntities = []
      if (attempts === 1 && mode === 'added_late_race') state.entities.push({ ...copy(outside), runtimeId: '32', uniqueId: 'late-outside' })
      if (attempts === 1 && mode === 'added_uid_race') state.entities.find(actor => actor.runtimeId === '31').uniqueId = 'late-replacement'
      if (attempts === 1 && mode === 'added_clearance_race') state.entities.find(actor => actor.runtimeId === '31').position = { ...state.position, x: state.position.x + 18.2 }
      return observed.bodyKnown && observed.supportKnown && observed.predicted.physicsState.onGround === true
    },
    verifyStrikeBody: observed => observed.bodyKnown,
    escape: context => {
      attempts++; calls.push({ before: copy(context.state), previous: copy(safety.snapshot().lastResult), diagnostic: copy(safety.snapshot().lastContinuation) })
      if (attempts > 1 && !repeat) {
        state.position.x += 10; state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt++
        return { supported: true, arrived: true, escaped: true, partialEscape: false, serverConfirmed: false }
      }
      state.position.x += 0.5
      creeper.position.x += attempts === 1 ? 2 : 0.5
      state.rawServerPosition = copy(state.position)
      if (mode !== 'stale') state.rawServerPositionUpdatedAt++
      if (mode === 'stationary_raw') state.rawServerPosition.x -= 0.5
      if (mode === 'unknown') creeper.positionKnown = false
      if (mode === 'new_actor') state.entities.push({ ...copy(outside), runtimeId: '31', uniqueId: 'new-outside', position: { ...state.position, x: state.position.x + 18.2 } })
      if (mode.startsWith('added_') && attempts === 1) {
        const actor = { ...copy(outside), runtimeId: '31', uniqueId: 'new-outside' }
        if (mode === 'added_boundary') actor.position = { ...state.position, x: state.position.x + 18.49 }
        if (mode === 'added_exact_margin') actor.position = { ...state.position, x: state.position.x + 18.5 }
        if (mode === 'added_active') actor.position = { ...state.position, x: state.position.x + 4 }
        if (mode === 'added_unknown') actor.positionKnown = false
        if (mode === 'added_uid_unknown') actor.uniqueId = null
        if (mode === 'added_dimension_unknown') delete actor.dimension
        if (mode === 'added_uid_duplicate') actor.uniqueId = outside.uniqueId
        if (mode === 'added_creeper' || mode === 'added_primed' || mode === 'added_charge_unknown' || mode === 'added_prime_unknown') actor.entityType = 'minecraft:creeper'
        if (mode === 'added_primed') actor.primed = true
        if (mode === 'added_charge_unknown') delete actor.charged
        if (mode === 'added_prime_unknown') delete actor.primed
        if (mode === 'added_raw_boundary') { actor.position = { ...state.position, x: state.position.x + 18.7 }; state.rawServerPosition.x += 0.4 }
        if (mode === 'added_feet_boundary') actor.position = { ...state.position, y: state.position.y - 1.62 - 18.4 }
        if (mode === 'added_deep') actor.position = { ...state.position, y: state.position.y - 40 }
        state.entities.push(actor)
      }
      if (mode === 'added_adopted_uid' && attempts === 2) state.entities.find(actor => actor.runtimeId === '31').uniqueId = 'replacement-next-leg'
      if (mode === 'missing_actor') state.entities.pop()
      if (mode.startsWith('removed_') && attempts === 1) {
        state.entities.pop()
        const receipt = { runtimeId: outside.runtimeId, uniqueId: outside.uniqueId, entityType: outside.entityType, position: copy(outside.position), removedAt: time }
        if (mode === 'removed_stale') receipt.removedAt = time - 10000
        if (mode === 'removed_future') receipt.removedAt = time + 10000
        if (mode === 'removed_wrong_uid') receipt.uniqueId = 'wrong-outside'
        if (mode === 'removed_wrong_id') receipt.runtimeId = '31'
        if (mode === 'removed_wrong_type') receipt.entityType = 'minecraft:zombie'
        if (mode === 'removed_bad_stamp') receipt.removedAt = 'invalid'
        if (mode === 'removed_iso') receipt.removedAt = new Date(time).toISOString()
        if (mode !== 'removed_preexisting') state.removedEntities = [receipt]
        if (mode === 'removed_replacement') state.entities.push({ ...copy(outside), uniqueId: 'replacement', entityType: 'minecraft:unknown_mob' })
        if (mode === 'removed_unknown') state.entities.push({ ...copy(outside), positionKnown: false })
        if (mode === 'removed_added') state.entities.push({ ...copy(outside), runtimeId: '31', uniqueId: 'new-outside' })
        if (mode === 'removed_primed') creeper.primed = true
        if (mode === 'removed_damage') state.health--
        if (mode === 'removed_stale_raw') state.rawServerPositionUpdatedAt--
        if (mode === 'removed_body_unknown') state.supportKnown = false
      }
      if (mode === 'outside_identity') outside.uniqueId = 'outside-replacement'
      if (mode === 'outside_policy') state.threatPolicy = 'conservative'
      if (mode === 'bounded_diff') {
        state.entities.splice(1, 6)
        for (const entity of state.entities.slice(1)) entity.uniqueId += '-replacement'
        for (let n = 50; n <= 55; n++) state.entities.push({ ...copy(outside), runtimeId: String(n), uniqueId: `new-${n}` })
      }
      if (mode === 'identity') creeper.uniqueId = 'replacement'
      if (mode === 'primed') creeper.primed = true
      if (mode === 'below_floor') creeper.position.x = state.position.x - 3.5
      if (mode === 'damage') state.health--
      if (mode === 'body_unknown') state.supportKnown = false
      if (mode === 'drift') state.position.z += 1
      const result = { supported: mode !== 'unsupported_result', arrived: mode !== 'unarrived', escaped: false, partialEscape: true, serverConfirmed: false }
      if (mode === 'result_code') result.code = 'NO_SAFE_RETREAT'
      if (mode === 'rejection') result.routeRejection = { reason: 'actor_radius' }
      if (mode === 'interruption') result.routeInterruption = { reason: 'interrupted' }
      return result
    },
    cancelOwned () {}, onEmergencyStop: detail => emergency.push(copy(detail)), intervalMs: 1000, graceMs: 0, actionTimeoutMs: 1000, now: () => time
  })
  t.after(() => safety.stop('test_cleanup'))
  const run = async () => { safety.start({ enableEpoch: 1 }); await safety.tick(); time++; await safety.tick(); await safety.drain() }
  return { safety, state, creeper, calls, emergency, run, attempts: () => attempts }
}

test('an arrived successful dry partial can continue after original-distance loss using fresh received progress', async t => {
  const f = fixture(t)
  await f.run()
  assert.equal(f.attempts(), 2, JSON.stringify({ state: f.safety.snapshot(), emergency: f.emergency }))
  const leg = f.calls[1]
  assert.equal(leg.previous.partialEscape, true)
  assert.equal(leg.previous.escaped, false)
  assert.equal(leg.previous.serverConfirmed, false)
  assert.equal(leg.diagnostic.continued, true)
  assert.equal(leg.diagnostic.failedPredicate, null)
  assert.ok(leg.diagnostic.currentDistance < leg.diagnostic.originalDistance - 0.5)
  assert.equal(leg.diagnostic.rawProgress, 0.5)
  assert.equal(leg.diagnostic.bodyVerified, true)
  assert.equal(f.emergency.length, 0)
  assert.equal(f.safety.snapshot().phase, 'observing')
  assert.equal(f.state.health, 13)
  assert.deepEqual(f.state.inventory.items, [])
})

test('stale, unknown, changed, primed, too-close, damaged, unsupported or unarrived partial evidence cannot use the extension', async t => {
  const expected = { stale: 'raw_position_stale', stationary_raw: 'raw_progress_missing', unknown: 'actor_observation_unknown', new_actor: 'new_actor_outside_clearance', missing_actor: 'actor_set_changed', outside_identity: 'actor_identity_or_policy_changed', outside_policy: 'actor_identity_or_policy_changed', identity: 'current_actor_floor_or_kind', primed: 'current_actor_floor_or_kind', below_floor: 'current_actor_floor_or_kind', damage: 'damage', body_unknown: 'body_unverified', drift: 'prediction_drift', unarrived: 'partial_unarrived', unsupported_result: 'result_unsupported', result_code: 'result_code', rejection: 'route_interrupted', interruption: 'route_interrupted', body_race: 'actor_set_changed' }
  for (const [mode, predicate] of Object.entries(expected)) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), 1, mode)
    const diagnostic = f.safety.snapshot().lastContinuation
    assert.ok(diagnostic, mode + ': ' + JSON.stringify(f.safety.snapshot()))
    assert.equal(diagnostic.continued, false, mode)
    assert.equal(diagnostic.failedPredicate, predicate, mode)
    assert.equal(diagnostic.primaryId, '17', mode)
    assert.ok(Number.isFinite(diagnostic.originalDistance), mode)
    assert.ok(Number.isFinite(diagnostic.currentDistance) || mode === 'unknown', mode)
    assert.ok(JSON.stringify(diagnostic).length < 2000, mode)
  }
})

test('partial continuation diagnostics identify observed actor additions, losses and identity or radius changes', async t => {
  for (const mode of ['new_actor', 'missing_actor', 'outside_identity', 'outside_policy', 'unknown']) {
    const f = fixture(t, { mode })
    await f.run()
    const diff = f.safety.snapshot().lastContinuation.actorSet
    assert.equal(diff.baselineCount, 2, mode)
    assert.equal(diff.addedCount, mode === 'new_actor' ? 1 : 0, mode)
    assert.equal(diff.removedCount, ['missing_actor', 'unknown'].includes(mode) ? 1 : 0, mode)
    assert.equal(diff.changedCount, ['outside_identity', 'outside_policy'].includes(mode) ? 1 : 0, mode)
    if (mode === 'new_actor') assert.equal(diff.added[0].runtimeId, '31')
    if (mode === 'missing_actor') {
      assert.equal(diff.removed[0].runtimeId, '30')
      assert.equal(diff.removed[0].name, 'minecraft:skeleton')
      assert.equal(diff.removed[0].entityPresent, false)
      assert.ok(Number.isFinite(diff.removed[0].distance))
    }
    if (mode === 'unknown') {
      assert.equal(diff.removed[0].runtimeId, '17')
      assert.equal(diff.removed[0].entityPresent, true)
      assert.equal(diff.removed[0].entityPositionKnown, false)
    }
    if (mode.startsWith('outside_')) {
      assert.equal(diff.changed[0].runtimeId, '30')
      assert.equal(diff.changed[0].identityChanged, mode === 'outside_identity')
      assert.ok(Number.isFinite(diff.changed[0].beforeDistance))
      assert.ok(Number.isFinite(diff.changed[0].distance))
    }
    assert.equal(f.attempts(), 1, mode)
  }
})

test('partial continuation actor diffs retain exact counts and cap each diagnostic roster at four records', async t => {
  const f = fixture(t, { mode: 'bounded_diff' })
  await f.run()
  const diff = f.safety.snapshot().lastContinuation.actorSet
  assert.equal(diff.baselineCount, 14)
  assert.equal(diff.currentCount, 14)
  assert.equal(diff.addedCount, 6)
  assert.equal(diff.removedCount, 6)
  assert.equal(diff.changedCount, 7)
  for (const key of ['added', 'removed', 'changed']) assert.equal(diff[key].length, 4, key)
  assert.ok(JSON.stringify(diff).length < 4000)
  assert.equal(f.attempts(), 1)
})

test('successful partial receipt continuation retains the existing eight-escape cap', async t => {
  const f = fixture(t, { repeat: true })
  await f.run()
  assert.equal(f.attempts(), 8)
  assert.equal(f.safety.snapshot().escapes, 8)
  assert.equal(f.emergency.length, 1)
  assert.equal(f.safety.snapshot().lastResult.partialEscape, true)
  assert.equal(f.safety.snapshot().lastResult.escaped, false)
  assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false)
  assert.equal(f.safety.snapshot().lastContinuation.failedPredicate, 'escape_action_limit')
  assert.equal(f.safety.snapshot().lastContinuation.continued, false)
})

test('a fresh exact received removal of a distant episode actor permits dry partial continuation', async t => {
  for (const mode of ['removed_safe', 'removed_iso', 'removed_added']) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), 2, mode + ': ' + JSON.stringify(f.safety.snapshot()))
    const leg = f.calls[1]
    assert.equal(leg.previous.partialEscape, true)
    assert.equal(leg.previous.escaped, false)
    assert.equal(leg.previous.serverConfirmed, false)
    assert.equal(leg.diagnostic.continued, true)
    assert.equal(leg.diagnostic.bodyVerified, true)
    assert.equal(leg.diagnostic.actorSet.removedCount, 1)
    const lost = leg.diagnostic.actorSet.removed[0]
    assert.equal(lost.runtimeId, '30')
    assert.equal(lost.name, 'minecraft:spider')
    assert.equal(lost.entityPresent, false)
    assert.ok(lost.distance > lost.dangerRadius)
    assert.equal(lost.removalReceipt.runtimeId, '30')
    assert.equal(lost.removalReceipt.uniqueId, 'known-outside')
    assert.equal(lost.removalReceipt.entityType, 'minecraft:spider')
    assert.ok(Number.isFinite(lost.removalReceipt.removedAt))
    assert.equal(f.emergency.length, 0)
    assert.equal(f.state.health, 13)
  }
})

test('missing, stale, wrong, preexisting or contradicted removal receipts cannot authorize continuation', async t => {
  for (const suffix of ['stale', 'future', 'wrong_uid', 'wrong_id', 'wrong_type', 'bad_stamp', 'preexisting', 'replacement', 'unknown', 'primed', 'damage', 'stale_raw', 'body_unknown', 'body_race']) {
    const f = fixture(t, { mode: `removed_${suffix}` })
    await f.run()
    assert.equal(f.attempts(), 1, suffix + ': ' + JSON.stringify(f.safety.snapshot()))
    assert.equal(f.safety.snapshot().lastResult.partialEscape, true, suffix)
    assert.equal(f.safety.snapshot().lastResult.escaped, false, suffix)
    assert.equal(f.safety.snapshot().lastContinuation.continued, false, suffix)
  }
})

test('receipt-backed removals retain the same eight-action bound', async t => {
  const f = fixture(t, { mode: 'removed_safe', repeat: true })
  await f.run()
  assert.equal(f.attempts(), 8)
  assert.equal(f.safety.snapshot().escapes, 8)
  assert.equal(f.emergency.length, 1)
  assert.equal(f.safety.snapshot().lastResult.escaped, false)
  assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false)
  assert.equal(f.safety.snapshot().lastContinuation.failedPredicate, 'escape_action_limit')
  assert.equal(f.calls[1].diagnostic.actorSet.removed[0].removalReceipt.runtimeId, '30')
  assert.equal(f.safety.snapshot().lastContinuation.actorSet.removedCount, 0)
})

test('new distant outside actors authorize a fresh route only after received progress and body proof', async t => {
  for (const mode of ['added_safe', 'added_exact_margin', 'added_creeper', 'added_deep']) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), 2, mode + ': ' + JSON.stringify(f.safety.snapshot()))
    const leg = f.calls[1]
    assert.equal(leg.diagnostic.continued, true, mode)
    assert.equal(leg.diagnostic.bodyVerified, true, mode)
    assert.equal(leg.diagnostic.actorSet.addedCount, 1, mode)
    assert.equal(leg.previous.partialEscape, true, mode)
    assert.equal(leg.previous.escaped, false, mode)
    assert.equal(leg.previous.serverConfirmed, false, mode)
    assert.equal(leg.before.entities.filter(actor => actor.runtimeId === '31').length, 1, mode)
    assert.equal(f.state.health, 13, mode)
    assert.deepEqual(f.state.inventory.items, [], mode)
  }
})

test('new actor handoff rejects insufficient eye or feet clearance, active or unknown actors and proof races', async t => {
  for (const suffix of ['boundary', 'active', 'unknown', 'uid_unknown', 'dimension_unknown', 'uid_duplicate', 'primed', 'charge_unknown', 'prime_unknown', 'raw_boundary', 'feet_boundary', 'late_race', 'uid_race', 'clearance_race']) {
    const f = fixture(t, { mode: `added_${suffix}` })
    await f.run()
    assert.equal(f.attempts(), 1, suffix + ': ' + JSON.stringify(f.safety.snapshot()))
    assert.equal(f.safety.snapshot().lastContinuation.continued, false, suffix)
    assert.equal(f.safety.snapshot().lastResult.escaped, false, suffix)
    assert.equal(f.state.inventory.items.length, 0, suffix)
  }
})

test('a successful new-actor handoff adopts identities for subsequent legs and keeps the same eight-action cap', async t => {
  for (const mode of ['added_safe', 'added_adopted_uid']) {
    const f = fixture(t, { mode, repeat: true })
    await f.run()
    assert.equal(f.attempts(), mode === 'added_safe' ? 8 : 2, mode + ': ' + JSON.stringify(f.safety.snapshot()))
    assert.equal(f.calls[1].diagnostic.actorSet.baselineCount, 2, mode)
    assert.equal(f.calls[1].diagnostic.actorSet.addedCount, 1, mode)
    assert.equal(f.safety.snapshot().lastContinuation.actorSet.baselineCount, 3, mode)
    assert.equal(f.safety.snapshot().lastContinuation.actorSet.addedCount, 0, mode)
    assert.equal(f.safety.snapshot().lastContinuation.failedPredicate, mode === 'added_safe' ? 'escape_action_limit' : 'actor_identity_or_policy_changed', mode)
    assert.equal(f.emergency.length, 1, mode)
    assert.equal(f.safety.snapshot().lastResult.escaped, false, mode)
    assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false, mode)
  }
})
