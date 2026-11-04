'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createCombatCoordinator } = require('../src/combat-coordinator')

function deferred () { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture ({ bow = false, targetX = 2.2, acquireHook = null, resumeHook = null, approachHook = null, meleeHook = null, rangedHook = null, sleepHook = null, drainHook = null, ...options } = {}) {
  let time = 1000; let enabled = true; let resourceMoving = true; let cleanup = false; let staleCleanupResult = false; let meleeReady = true; let rangedReady = true; let activeMelee = null; let activeRanged = null; let coordinator
  const events = []; const acquisitions = []; const resumes = []; const approaches = []; const meleeCalls = []; const rangedCalls = []; const cancels = []; const drains = []
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'scope-A', startedAt: 'start-A', runtimeEntityId: '1', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, lifecycle: { deathId: 0, phase: 'alive' }, inventory: { known: true, items: bow ? [{ name: 'minecraft:bow', count: 1, slot: 0 }, { name: 'minecraft:arrow', count: 8, slot: 10, metadata: 0 }] : [] }, safetyWanted: true, autoWanted: true }
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: targetX, y: 65, z: 0.5 } }
  const actors = [target]; const removed = []
  const terminal = (actor = target) => ({ phase: 'completed', code: 'TARGET_DEAD', targetRuntimeId: actor.runtimeId, targetUniqueId: actor.uniqueId, targetDead: true, serverConfirmed: true, confirmedBy: 'fixture_server_death' })
  const stopped = code => ({ code, targetRuntimeId: target.runtimeId, targetUniqueId: target.uniqueId, targetDead: false, serverConfirmed: false })
  const context = () => ({ coordinator, state, target, actors, removed, events, terminal, stopped, setCleanup: value => { cleanup = value }, setEnabled: value => { enabled = value }, advance: ms => { time += ms }, setMeleeReady: value => { meleeReady = value }, setRangedReady: value => { rangedReady = value } })
  function controller (name) {
    return {
      preview: runtimeId => { events.push(`preview_${name}`); return { ready: !resourceMoving && (name === 'melee' ? meleeReady : rangedReady), code: resourceMoving ? 'BUSY' : 'LOS_BLOCKED' } },
      engage: (runtimeId, args) => {
        events.push(`engage_${name}`); (name === 'melee' ? meleeCalls : rangedCalls).push({ runtimeId, args })
        const hook = name === 'melee' ? meleeHook : rangedHook
        const value = hook ? hook({ ...context(), args, runtimeId, calls: name === 'melee' ? meleeCalls : rangedCalls }) : terminal(actors.find(a => a.runtimeId === runtimeId))
        if (value === 'pending') { const d = deferred(); if (name === 'melee') activeMelee = d; else activeRanged = d; return d.promise }
        return Promise.resolve(value)
      },
      cancel: (reason, code) => { events.push(`cancel_${name}`); cancels.push({ name, reason, code }); if (name === 'ranged' && ['MELEE_PRIORITY', 'NEAR_HOSTILE_PRIORITY'].includes(code)) cleanup = true; const d = name === 'melee' ? activeMelee : activeRanged; d?.resolve(stopped(code ?? 'CANCELLED')) },
      drain: async () => { drains.push(name); events.push(`drain_${name}`); await drainHook?.({ name, drains, ...context() }) },
      snapshot: () => ({ cleanupUnconfirmed: name === 'ranged' && cleanup, lastResult: { cleanupUnconfirmed: staleCleanupResult } })
    }
  }
  const melee = controller('melee'), ranged = controller('ranged')
  coordinator = createCombatCoordinator({ getState: () => state, entities: { snapshot: () => structuredClone(actors), snapshotRemoved: () => structuredClone(removed) }, melee, ranged,
    acquire: async args => { acquisitions.push(args); events.push('acquire'); resourceMoving = false; return acquireHook ? acquireHook({ ...context(), args }) : { acquired: true, token: 'root-token' } },
    resume: async args => { resumes.push(args); events.push('resume'); return resumeHook?.({ ...context(), args, resumes }) },
    approach: approachHook ? async (actor, args) => { approaches.push({ actor, args }); events.push('approach'); return approachHook({ ...context(), actor, args }) } : null,
    canAct: () => enabled, now: () => time, sleep: async ms => { time += ms; sleepHook?.(context()); await turn() }, ...options })
  return { ...context(), coordinator, state, target, actors, removed, events, acquisitions, resumes, approaches, meleeCalls, rangedCalls, cancels, drains, setCleanup: value => { cleanup = value }, setStaleCleanupResult: value => { staleCleanupResult = value }, setEnabled: value => { enabled = value }, setMeleeReady: value => { meleeReady = value }, advance: ms => { time += ms }, resourceMoving: () => resourceMoving }
}

const setRange = (f, range) => { f.target.position = { x: f.state.position.x + Math.sqrt(range * range - 0.72 * 0.72), y: 65, z: 0.5 } }
const safeApproach = ({ state, target, args }) => { assert.equal(args.maxStepDistance, 6); assert.deepEqual(args.desiredDistance, { min: 1.8, max: 2.2 }); state.position.x = target.position.x - 1.8; return { accepted: true, phase: 'predicted', serverConfirmed: false, partialApproach: true, targetReached: false } }

for (const bow of [false, true]) test('close gap uses one owned native approach then in-reach melee with bow=' + bow, async () => {
  const f = fixture({ bow, approachHook: safeApproach, canAcquireMeleeApproach: () => false }); setRange(f, 3.2)
  const result = await f.coordinator.tick()
  assert.equal(f.acquisitions.length, 1); assert.equal(f.approaches.length, 1); assert.equal(f.meleeCalls.length, 1); assert.equal(f.rangedCalls.length, 0)
  assert.equal(f.approaches[0].args.primaryHostileUniqueId, f.target.uniqueId); assert.equal(f.resumes.length, 1)
  assert.equal(result.targetDead, true); assert.equal(result.confirmedBy, 'fixture_server_death')
  assert.equal(f.state.autoWanted, true); assert.equal(f.state.safetyWanted, true)
})

test('close gap excludes exact melee boundary and upper boundary without a bow', async () => {
  const near = fixture({ approachHook: safeApproach, canAcquireMeleeApproach: () => false }); setRange(near, 2.8)
  await near.coordinator.tick(); assert.equal(near.approaches.length, 0); assert.equal(near.meleeCalls.length, 1)
  for (const range of [6.05, 6.5, 8]) { // bow band starts at 6m (RANGED_SELECT_MIN)
    const far = fixture({ approachHook: safeApproach, canAcquireMeleeApproach: () => false }); setRange(far, range)
    assert.equal((await far.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(far.acquisitions.length, 0)
  }
})

test('6m and farther with owned bow retain ranged priority instead of the close approach branch', async () => {
  for (const range of [6.05, 6.5, 8]) { // bow band starts at 6m (RANGED_SELECT_MIN)
    const f = fixture({ bow: true, approachHook: safeApproach, canAcquireMeleeApproach: () => false }); setRange(f, range)
    await f.coordinator.tick(); assert.equal(f.rangedCalls.length, 1); assert.equal(f.approaches.length, 0); assert.equal(f.meleeCalls.length, 0)
  }
})

test('a close hostile cannot acquire without a native approach callback', async () => {
  const f = fixture({ bow: true, canAcquireMeleeApproach: () => true }); setRange(f, 3.2)
  assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.acquisitions.length, 0)
})

for (const invalid of ['unknown', 'uncertain', 'confidence', 'items', 'life', 'uid', 'world', 'disabled']) test('close admission denies ' + invalid + ' before acquiring', async () => {
  const f = fixture({ bow: true, approachHook: safeApproach, canAcquireMeleeApproach: () => true }); setRange(f, 3.2)
  if (invalid === 'unknown') f.state.inventory.known = false
  if (invalid === 'uncertain') f.state.inventory.uncertain = true
  if (invalid === 'confidence') f.state.inventoryConfidence = { known: false }
  if (invalid === 'items') f.state.inventory.items = null
  if (invalid === 'life') f.state.lifecycle.deathId = null
  if (invalid === 'uid') f.target.uniqueId = null
  if (invalid === 'world') f.target.dimension = 'nether'
  if (invalid === 'disabled') f.setEnabled(false)
  assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.acquisitions.length, 0)
})

test('unknown/unsafe native stance releases the claim without a bow release or out-of-reach melee', async () => {
  const f = fixture({ bow: true, approachHook: () => ({ ready: false, reason: 'Unknown body or no safe Native stance' }), canAcquireMeleeApproach: () => false }); setRange(f, 3.2)
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'APPROACH_NOT_READY'); assert.equal(f.approaches.length, 1); assert.equal(f.meleeCalls.length, 0); assert.equal(f.rangedCalls.length, 0)
  assert.equal(f.resumes.length, 1); assert.equal(f.coordinator.snapshot().busy, false)
  assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE', 'bounded backoff prevents reacquisition spin')
})

test('life change during close acquisition cancels before the native callback or attack', async () => {
  const f = fixture({ bow: true, approachHook: safeApproach, canAcquireMeleeApproach: () => false, acquireHook: ({ state }) => { state.lifecycle.deathId++; return { acquired: true, token: 'root-token' } } }); setRange(f, 3.2)
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'SESSION_CHANGED'); assert.equal(f.approaches.length, 0); assert.equal(f.meleeCalls.length, 0); assert.equal(f.rangedCalls.length, 0)
})

test('post-acquisition melee validation rejects unsupported/unknown targets before any native approach', async () => {
  const melee = { preview: () => ({ ready: false, code: 'INVALID_TARGET' }), engage: () => assert.fail('unsupported target attack'), cancel () {}, drain: async () => {}, snapshot: () => ({ busy: false }) }
  const f = fixture({ bow: true, melee, approachHook: () => assert.fail('unsupported target movement'), canAcquireMeleeApproach: () => false }); setRange(f, 3.2)
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'NO_READY_ACTION'); assert.equal(f.acquisitions.length, 1); assert.equal(f.approaches.length, 0); assert.equal(f.resumes.length, 1)
})
