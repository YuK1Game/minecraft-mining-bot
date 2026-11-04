'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createIdleSafety } = require('../src/idle-safety')
const copy = value => structuredClone(value)

function fixture (t, { mode = 'land', code = 'SUPPORT_UNKNOWN', repeat = false } = {}) {
  let time = 1000; let safety; let attempts = 0
  const emergency = []; const calls = []; const reports = []; const timers = []
  const actor = { runtimeId: '9', uniqueId: 'zombie-nine', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, position: { x: -8.7, y: 65, z: 0.5 } }
  const outside = { ...copy(actor), runtimeId: '10', uniqueId: 'skeleton-ten', entityType: 'minecraft:skeleton', position: { x: 30, y: 65, z: 0.5 } }
  const state = { phase: 'spawned', profile: 'dry-progress', realm: { id: '42' }, startedAt: 'session', connectionId: 'connection', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', threatPolicy: 'balanced_mining', health: 20, rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: null, inventory: { known: true, items: [] }, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, predicted: { physicsState: { onGround: true, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.0784, z: 0 } } }, entities: [actor, outside], bodyKnown: true, supportKnown: true }
  const schedule = fn => { const timer = setTimeout(fn, 35); timers.push(timer) }
  const failed = () => ({ supported: true, arrived: false, escaped: false, partialEscape: false, code, routeInterruption: { code: 'NEARBY_THREAT', reason: 'The remaining escape route no longer leads away from current danger' }, remainingRouteRejection: { reason: 'actor_radius', actorName: 'minecraft:zombie', minDistance: 9.212356999, required: 9.219705108 } })
  safety = createIdleSafety({
    getState: () => copy(state), isIdle: () => true, equipSword: () => ({ serverConfirmed: false }), closeGui: () => {}, previewEngage: () => ({ ready: false }), engage: () => { throw new Error('No synthetic combat') },
    verifyBody: observed => {
      calls.push({ type: 'body', position: copy(observed.position) })
      if (mode === 'proof_race' && attempts === 1 && observed.predicted.physicsState.onGround) state.entities.push({ ...copy(actor), runtimeId: '11', uniqueId: 'new-after-proof', position: { x: 50, y: 65, z: 0.5 } })
      return observed.bodyKnown && observed.supportKnown && observed.predicted.physicsState.onGround === true
    },
    verifyStrikeBody: observed => observed.bodyKnown,
    escape: context => {
      attempts++; calls.push({ type: 'escape', context: { state: copy(context.state), previous: safety.snapshot().lastResult } })
      if (attempts > 1 && !repeat) {
        state.position.x += 4; state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt++
        return { supported: true, arrived: true, escaped: true, serverConfirmed: false }
      }
      state.position.x += 0.25
      state.rawServerPosition = copy(state.position)
      if (mode === 'stationary') state.rawServerPosition.x -= 0.25
      if (mode !== 'stale') state.rawServerPositionUpdatedAt++
      if (!repeat && mode !== 'ground') {
        state.predicted.physicsState.onGround = false
        state.predicted.physicsState.velocity.y = -0.2
        state.position.y -= 0.4
        if (mode === 'reconcile' || mode === 'drift_stays') state.position.z += 1.2
        schedule(() => {
          state.position.y = 65.62; state.predicted.physicsState.onGround = true; state.predicted.physicsState.velocity.y = -0.0784
          if (mode !== 'drift_stays') state.position.z = state.rawServerPosition.z
          state.rawServerPosition.y = 65.62; state.rawServerPositionUpdatedAt++
          if (mode === 'unknown_landing') state.supportKnown = false
          if (mode === 'invalid_body') state.bodyKnown = false
          if (mode === 'water') state.predicted.physicsState.isInWater = true
          if (mode === 'lava') state.predicted.physicsState.isInLava = true
          if (mode === 'floor') outside.position.x = 18
        })
      }
      if (mode === 'damage') state.health--
      if (mode === 'identity') actor.uniqueId = 'replacement'
      if (mode === 'new_actor') state.entities.push({ ...copy(outside), runtimeId: '11', uniqueId: 'new-outside', dimension: 'overworld', position: { ...state.position, x: state.position.x + 18.2 } })
      if (mode === 'missing_actor') state.entities.pop()
      if (mode === 'scope') state.connectionId = 'replacement-session'
      if (mode === 'unsupported_result') return { ...failed(), supported: false }
      return failed()
    },
    cancelOwned: () => { calls.push({ type: 'cleanup' }) }, onEmergencyStop: detail => emergency.push(detail), onProgress: value => reports.push(copy(value)), intervalMs: 20, graceMs: 0, actionTimeoutMs: 1000, now: () => time
  })
  t.after(async () => { for (const timer of timers) clearTimeout(timer); await safety.stop('test_cleanup') })
  const run = async () => { safety.start({ enableEpoch: 1 }); await safety.tick(); time += 1; await safety.tick(); await safety.drain() }
  return { safety, state, actor, outside, emergency, calls, reports, run, attempts: () => attempts }
}

test('received dry progress survives the masked old-path failure, lands, and replans without claiming the failed arrival', async t => {
  for (const code of ['SUPPORT_UNKNOWN', 'NO_SAFE_RETREAT']) {
    const f = fixture(t, { code })
    await f.run()
    const actions = f.calls.filter(call => call.type === 'escape')
    assert.equal(actions.length, 2, JSON.stringify(f.safety.snapshot()))
    assert.equal(actions[1].context.state.predicted.physicsState.onGround, true)
    assert.equal(actions[1].context.state.position.y, 65.62)
    assert.equal(actions[1].context.state.rawServerPositionUpdatedAt, 3)
    assert.equal(actions[1].context.previous.code, code)
    assert.equal(actions[1].context.previous.escaped, false)
    assert.equal(actions[1].context.previous.partialEscape, false)
    assert.equal(actions[1].context.previous.serverConfirmed, false)
    assert.equal(f.emergency.length, 0)
    assert.equal(f.safety.snapshot().phase, 'observing')
    assert.equal(f.state.health, 20)
    assert.deepEqual(f.state.inventory.items, [])
  }
})

test('existing passive landing may reconcile larger prediction drift but new motion still requires the original coherence bound', async t => {
  for (const mode of ['reconcile', 'drift_stays']) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), mode === 'reconcile' ? 2 : 1, mode)
    assert.equal(f.emergency.length, mode === 'reconcile' ? 0 : 1, mode)
  }
})

test('stationary, stale, damaged, changed or unknown evidence cannot authorize another dry escape', async t => {
  for (const mode of ['stationary', 'stale', 'damage', 'identity', 'new_actor', 'missing_actor', 'scope', 'unknown_landing', 'invalid_body', 'water', 'lava', 'floor', 'proof_race', 'unsupported_result']) {
    const f = fixture(t, { mode })
    await f.run()
    assert.equal(f.attempts(), 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.notEqual(f.safety.snapshot().lastResult?.escaped, true, mode)
    assert.notEqual(f.safety.snapshot().lastResult?.partialEscape, true, mode)
  }
})

test('received dry progress keeps the existing eight-action cap without resetting failed-result claims', async t => {
  const f = fixture(t, { repeat: true })
  await f.run()
  assert.equal(f.attempts(), 8)
  assert.equal(f.safety.snapshot().escapes, 8)
  assert.equal(f.emergency.length, 1)
  assert.equal(f.safety.snapshot().lastResult.escaped, false)
  assert.equal(f.safety.snapshot().lastResult.partialEscape, false)
  assert.equal(f.safety.snapshot().lastResult.serverConfirmed, false)
})
