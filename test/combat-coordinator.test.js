'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createCombatCoordinator } = require(process.env.COMBAT_COORDINATOR_TEST_SOURCE ?? '../src/combat-coordinator')

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
      survey: runtimeId => ({ ready: !cleanup && (name === 'melee' ? meleeReady : rangedReady), code: cleanup ? 'CLEANUP_PENDING' : 'LOS_BLOCKED' }),
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

test('selects a near hostile before preview, preempts resource movement through acquire, then re-previews', async () => {
  const f = fixture(); const result = await f.coordinator.tick()
  assert.equal(result.targetDead, true); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1); assert.ok(f.events.indexOf('preview_melee') > f.events.indexOf('acquire')); assert.equal(f.meleeCalls.length, 1); assert.equal(f.rangedCalls.length, 0); assert.equal(f.coordinator.snapshot().busy, false)
  assert.equal(f.resumes[0].token, 'root-token'); assert.equal(f.state.safetyWanted, true); assert.equal(f.state.autoWanted, true)
})
test('near melee has priority over a far bow target, even when bow and arrows are owned', async () => {
  const f = fixture({ bow: true }); f.actors.unshift({ ...f.target, runtimeId: '71', uniqueId: '-701', position: { x: 8, y: 65, z: 0.5 } })
  await f.coordinator.tick(); assert.equal(f.meleeCalls[0].runtimeId, '70'); assert.equal(f.rangedCalls.length, 0)
})
test('far targets without real owned bow/arrows do not acquire or disturb resource work', async () => {
  for (const modify of [s => {}, s => { s.inventory.items = [{ name: 'minecraft:bow', count: 1 }] }, s => { s.inventory.items = [{ name: 'minecraft:arrow', count: 8, metadata: 0 }] }, s => { s.inventory.items = [{ name: 'minecraft:bow', count: 1 }, { name: 'minecraft:spectral_arrow', count: 8 }] }, s => { s.inventory.known = false }]) {
    const f = fixture({ targetX: 8 }); modify(f.state); const r = await f.coordinator.tick(); assert.equal(r.code, 'NO_CANDIDATE'); assert.equal(f.acquisitions.length, 0); assert.equal(f.resourceMoving(), true); assert.equal(f.events.some(e => e.startsWith('preview_')), false)
  }
  const valid = fixture({ targetX: 8, bow: true }); await valid.coordinator.tick(); assert.equal(valid.rangedCalls.length, 1); assert.equal(valid.meleeCalls.length, 0)
})
test('Bedrock tipped-only arrow inventory admits far ranged combat without Java spectral assumptions', async () => {
  const f = fixture({ targetX: 8, bow: true }); f.state.inventory.items.find(i => i.name === 'minecraft:arrow').metadata = 23
  await f.coordinator.tick(); assert.equal(f.rangedCalls.length, 1); assert.equal(f.acquisitions.length, 1)
})
test('automatic mode must be explicitly enabled and players/passives/unknown UIDs are not candidates', async () => {
  const disabled = fixture(); disabled.setEnabled(false); assert.equal((await disabled.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(disabled.acquisitions.length, 0)
  for (const change of [{ kind: 'player', entityType: 'minecraft:player' }, { hostile: false, entityType: 'minecraft:cow' }, { uniqueId: null }, { alive: false }, { positionKnown: false }, { dimension: 'nether' }]) { const f = fixture(); Object.assign(f.target, change); await f.coordinator.tick(); assert.equal(f.acquisitions.length, 0) }
})
test('tick coalesces while acquisition is pending, and manual cancellation drains before one release', async () => {
  const admission = deferred(); const f = fixture({ acquireHook: () => admission.promise })
  const first = f.coordinator.tick(); const second = f.coordinator.tick(); assert.equal(first, second); assert.equal(f.coordinator.snapshot().busy, true)
  await turn(); f.setEnabled(false); f.coordinator.cancel('manual stop'); admission.resolve({ acquired: true, token: 'cancelled-admission-token' }); await f.coordinator.drain()
  assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1); assert.equal(f.resumes[0].canActNow, false); assert.equal(f.meleeCalls.length, 0); assert.equal(f.coordinator.snapshot().busy, false)
  assert.equal(f.resumes[0].token, 'cancelled-admission-token')
})
test('bound target stays within one lease across melee out-of-reach and bow switching', async () => {
  const f = fixture({ bow: true, meleeHook: ({ target, stopped }) => { target.position.x = 8; return stopped('OUT_OF_REACH') } })
  const r = await f.coordinator.tick(); assert.equal(r.targetDead, true); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1); assert.equal(f.meleeCalls.length, 1); assert.equal(f.rangedCalls.length, 1); assert.equal(f.resumes[0].target.uniqueId, '-700')
})
test('a ranged target entering melee reach cancels safely and holds the same lease through cleanup', async () => {
  let moved = false
  const f = fixture({ bow: true, targetX: 8, rangedHook: () => 'pending', sleepHook: ({ events, target }) => { if (!moved && events.includes('engage_ranged')) { moved = true; target.position.x = 2.2 } } })
  const blocked = await f.coordinator.tick(); assert.equal(blocked.code, 'RANGED_CLEANUP_PENDING'); assert.equal(f.coordinator.snapshot().busy, true); assert.equal(f.coordinator.snapshot().blocked, true); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 0); assert.equal(f.meleeCalls.length, 0)
  await f.coordinator.tick(); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 0)
  f.setCleanup(false); f.setStaleCleanupResult(true); const result = await f.coordinator.tick(); assert.equal(result.targetDead, true); assert.equal(f.meleeCalls.length, 1); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1); assert.equal(f.coordinator.snapshot().busy, false)
})
test('target death still cannot hand resources back while actual bow cleanup remains unconfirmed', async () => {
  const f = fixture({ bow: true, targetX: 8, rangedHook: ({ setCleanup, terminal }) => { setCleanup(true); return terminal() } })
  const blocked = await f.coordinator.tick(); assert.equal(blocked.targetDead, true); assert.equal(blocked.blocked, true); assert.equal(f.resumes.length, 0); await f.coordinator.drain(); assert.equal(f.coordinator.snapshot().claim.targetUniqueId, '-700')
  f.setCleanup(false); const done = await f.coordinator.tick(); assert.equal(done.targetDead, true); assert.equal(f.resumes.length, 1)
})
test('another near hostile preempts a far bow fight without rebinding the old target lease', async () => {
  let entered = false
  const f = fixture({ bow: true, targetX: 8, rangedHook: () => 'pending', sleepHook: ({ events, actors, target }) => { if (!entered && events.includes('engage_ranged')) { entered = true; actors.push({ ...target, runtimeId: '71', uniqueId: '-701', position: { x: 2.2, y: 65, z: 0.5 } }) } } })
  const pending = await f.coordinator.tick(); assert.equal(pending.blocked, true); assert.equal(f.coordinator.snapshot().claim.targetUniqueId, '-700'); assert.equal(f.meleeCalls.length, 0)
  f.setCleanup(false); const ended = await f.coordinator.tick(); assert.equal(ended.code, 'NEAR_HOSTILE_PRIORITY'); assert.equal(ended.targetDead, false)
  await f.coordinator.tick(); assert.equal(f.meleeCalls[0].runtimeId, '71'); assert.equal(f.acquisitions.length, 2); assert.equal(f.acquisitions[0].target.uniqueId, '-700'); assert.equal(f.acquisitions[1].target.uniqueId, '-701')
})
test('confirmed life reset may release an old cleanup-held lease; unknown scope changes do not pretend equipment proof', async () => {
  const f = fixture({ bow: true, targetX: 8, rangedHook: ({ setCleanup, terminal }) => { setCleanup(true); return terminal() } })
  await f.coordinator.tick(); f.state.lifecycle = { deathId: 1, phase: 'alive', lastResult: { deathId: 1, serverConfirmed: true } }; f.state.health = 20
  await f.coordinator.tick(); assert.equal(f.resumes.length, 1); assert.equal(f.coordinator.snapshot().busy, false)
})
test('pre-existing unconfirmed bow cleanup blocks another fight before any acquisition', async () => {
  const f = fixture(); f.setCleanup(true); const r = await f.coordinator.tick(); assert.equal(r.blocked, true); assert.equal(f.acquisitions.length, 0); assert.equal(f.meleeCalls.length, 0)
})
test('server death and removal are separate outcomes; mismatched UID terminal claims are rejected', async () => {
  const removed = fixture({ meleeHook: ({ target }) => ({ code: 'TARGET_REMOVED', targetRemoved: true, targetDead: false, serverConfirmed: false, targetRuntimeId: target.runtimeId, targetUniqueId: target.uniqueId }) }); const a = await removed.coordinator.tick(); assert.equal(a.targetRemoved, true); assert.equal(a.targetDead, false); assert.equal(a.serverConfirmed, false)
  const wrong = fixture({ meleeHook: ({ terminal }) => ({ ...terminal(), targetUniqueId: '-999' }) }); const b = await wrong.coordinator.tick(); assert.equal(b.code, 'UNCONFIRMED_CONTROLLER_TERMINAL'); assert.equal(b.targetDead, false)
  const death = fixture(); const c = await death.coordinator.tick(); assert.equal(c.serverConfirmed, true); assert.equal(c.targetDead, true); assert.equal(c.botCausedDeath, null)
})
test('actual actor death/removal cache interrupts an active controller without inventing attribution', async () => {
  for (const mode of ['death', 'removed']) {
    let changed = false
    const f = fixture({ meleeHook: () => 'pending', sleepHook: ({ events, target, actors, removed }) => { if (!changed && events.includes('engage_melee')) { changed = true; if (mode === 'death') { target.alive = false; target.lastEvent = { event: 'death_animation' } } else { removed.push(structuredClone(target)); actors.splice(0) } } } })
    const r = await f.coordinator.tick(); assert.equal(r.code, mode === 'death' ? 'TARGET_DEAD' : 'TARGET_REMOVED'); assert.equal(r.targetDead, mode === 'death'); assert.equal(f.cancels.length, 1); assert.ok(f.drains.includes('melee')); assert.equal(f.resumes.length, 1)
  }
})
test('unique ID, lifecycle and connection changes cancel and drain the bound action', async () => {
  for (const mode of ['uid', 'life', 'connection']) {
    let changed = false
    const f = fixture({ meleeHook: () => 'pending', sleepHook: ({ events, state, target }) => { if (!changed && events.includes('engage_melee')) { changed = true; if (mode === 'uid') target.uniqueId = '-999'; else if (mode === 'life') state.lifecycle.deathId++; else state.connectionId = 'scope-B' } } })
    const r = await f.coordinator.tick(); assert.equal(r.targetDead, false); assert.equal(r.code, mode === 'uid' ? 'TARGET_CHANGED' : 'SESSION_CHANGED'); assert.equal(f.cancels.length, 1); assert.equal(f.resumes.length, 1)
  }
})
test('self damage alone keeps the claim and does not cancel a living fight', async () => {
  const f = fixture({ meleeHook: ({ state, terminal }) => { state.health = 1; return terminal() } }); const r = await f.coordinator.tick(); assert.equal(r.targetDead, true); assert.equal(f.cancels.length, 0); assert.equal(f.state.health, 1)
})
test('optional approach keeps UID/scope and requests a known bounded stance before re-preview', async () => {
  let calls = 0
  const f = fixture({ meleeHook: ({ target, stopped, terminal }) => { if (++calls === 1) { target.position.x = 3.6; return stopped('OUT_OF_REACH') }; return terminal() }, approachHook: ({ state, args }) => { assert.equal(args.maxStepDistance, 6); assert.deepEqual(args.desiredDistance, { min: 1.8, max: 2.2 }); assert.equal(args.primaryHostileUniqueId, '-700'); state.position.x = 1.6; return { ready: true, phase: 'completed' } } })
  const result = await f.coordinator.tick(); assert.equal(result.targetDead, true); assert.equal(f.approaches.length, 1); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1)
})
test('no safe preview or approach releases with bounded backoff instead of a busy-cancel loop', async () => {
  const f = fixture({ approachHook: () => ({ ready: false, reason: 'unknown body/world' }) }); f.setMeleeReady(false)
  const first = await f.coordinator.tick(); assert.equal(first.code, 'APPROACH_NOT_READY'); assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1)
  await f.coordinator.tick(); assert.equal(f.acquisitions.length, 1); f.advance(1600); await f.coordinator.tick(); assert.equal(f.acquisitions.length, 1, 'no-route backoff is 2s'); f.advance(500); await f.coordinator.tick(); assert.equal(f.acquisitions.length, 2); assert.equal(f.resumes.length, 2)
})
test('a nominally ready approach without movement or ready attack stops as no progress', async () => {
  const f = fixture({ approachHook: () => ({ ready: true }) }); f.setMeleeReady(false); const r = await f.coordinator.tick(); assert.equal(r.code, 'NO_PROGRESS'); assert.equal(f.approaches.length, 1); assert.equal(f.resumes.length, 1)
})
test('claim-origin chase and 120-second ceiling cancel active operations honestly', async () => {
  for (const mode of ['chase', 'duration']) {
    let moved = false
    const f = fixture({ durationMs: 1000, meleeHook: () => 'pending', sleepHook: ({ events, state, target }) => { if (mode === 'chase' && !moved && events.includes('engage_melee')) { moved = true; state.position.x = 45; target.position.x = 46 } } })
    const r = await f.coordinator.tick(); assert.equal(r.code, mode === 'chase' ? 'CHASE_LIMIT' : 'DURATION_LIMIT'); assert.equal(r.serverConfirmed, false); assert.equal(f.cancels.length, 1); assert.equal(f.resumes.length, 1)
  }
})
test('failed Root release retains the protective lease and retries only after backoff', async () => {
  const f = fixture({ resumeHook: ({ resumes }) => { if (resumes.length === 1) throw new Error('fixture release failure') } })
  const first = await f.coordinator.tick(); assert.equal(first.code, 'LEASE_RELEASE_FAILED'); assert.equal(f.coordinator.snapshot().busy, true)
  await f.coordinator.tick(); assert.equal(f.resumes.length, 1); f.advance(1600); const done = await f.coordinator.tick(); assert.equal(done.targetDead, true); assert.equal(f.resumes.length, 2); assert.equal(f.coordinator.snapshot().busy, false)
})
test('explicit acquisition denial never resumes or drains another owner', async () => {
  const f = fixture({ acquireHook: () => false }); const r = await f.coordinator.tick(); assert.equal(r.code, 'ACQUIRE_DENIED'); assert.equal(f.resumes.length, 0); assert.equal(f.drains.length, 0); assert.equal(f.meleeCalls.length, 0)
})
test('controller drain rejection retains ownership and is retried with backoff before resume', async () => {
  let rejectDrain = true
  const f = fixture({ drainHook: () => { if (rejectDrain) throw new Error('fixture controller still owns input') } })
  const r = await f.coordinator.tick(); assert.equal(r.code, 'CONTROLLER_DRAIN_FAILED'); assert.equal(f.resumes.length, 0); assert.equal(f.coordinator.snapshot().busy, true)
  const count = f.drains.length; await f.coordinator.tick(); assert.equal(f.drains.length, count); rejectDrain = false; f.advance(1600); await f.coordinator.tick(); assert.equal(f.resumes.length, 1); assert.equal(f.coordinator.snapshot().busy, false)
})
test('two no-progress controller returns release safely rather than spin under a permanent claim', async () => {
  const f = fixture({ meleeHook: ({ stopped }) => ({ ...stopped('HIT_LIMIT'), hitsRequested: 0 }) })
  const r = await f.coordinator.tick(); assert.equal(r.code, 'NO_PROGRESS'); assert.equal(f.meleeCalls.length, 2); assert.equal(f.resumes.length, 1); assert.equal(f.coordinator.snapshot().busy, false)
})
test('combat mode needs a near melee target or current route evidence within the 32-block engage radius', async () => {
  const blocked = fixture({ bow: true, targetX: 8, canEngage: () => false }); const r = await blocked.coordinator.tick()
  assert.equal(r.code, 'NO_CANDIDATE'); assert.equal(blocked.acquisitions.length, 0); assert.equal(blocked.resourceMoving(), true)
  const near = fixture({ canEngage: () => false }); assert.equal((await near.coordinator.tick()).targetDead, true)
  const routed = fixture({ bow: true, targetX: 8, canEngage: () => true }); await routed.coordinator.tick(); assert.equal(routed.acquisitions.length, 1)
  const far = fixture({ bow: true, targetX: 8, canEngage: () => true, engageRadius: 4 }); assert.equal((await far.coordinator.tick()).code, 'NO_CANDIDATE')
})
test('per-enemy profiles gate selection: warden is never claimed, low HP keeps only an in-reach counterattack until health recovers', async () => {
  const warden = fixture(); warden.target.entityType = 'minecraft:warden'; assert.equal((await warden.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(warden.acquisitions.length, 0)
  const far = fixture({ bow: true, targetX: 8 }); far.state.health = 6; assert.equal((await far.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(far.acquisitions.length, 0)
  far.state.health = 10; assert.equal((await far.coordinator.tick()).code, 'NO_CANDIDATE', 'hysteresis: 50% is not yet the 60% resume threshold')
  const near = fixture(); near.state.health = 6; assert.equal((await near.coordinator.tick()).targetDead, true, 'an in-reach counterattack continues at low health')
})
test('a creeper between melee reach and the 8-block shot distance is not claimed even with a bow', async () => {
  const f = fixture({ bow: true, targetX: 6 }); f.target.entityType = 'minecraft:creeper'
  assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.acquisitions.length, 0)
})
test('a bow draw cancelled by own movement is retried from the new spot instead of forcing an approach', async () => {
  const f = fixture({ bow: true, targetX: 8, approachHook: () => ({ ready: false, reason: 'must not approach' }), rangedHook: ({ calls, stopped, terminal }) => calls.length === 1 ? { ...stopped('SHOOTER_MOVED'), shotsRequested: 0 } : terminal() })
  const r = await f.coordinator.tick()
  assert.equal(r.targetDead, true, JSON.stringify(r)); assert.equal(f.rangedCalls.length, 2); assert.equal(f.approaches.length, 0)
})
test('melee_kite (risky trade only): one hit per slice, then a short retreat step before the next hit; no retreat hook keeps the old behaviour', async () => {
  const retreats = []
  const healthy = fixture({ retreat: async () => { retreats.push('healthy'); return { ready: true } } }); await healthy.coordinator.tick(); assert.equal(retreats.length, 0, 'full health and one hostile: press on, no kite'); assert.equal(healthy.meleeCalls[0].args.maxHits, undefined)
  const f = fixture({ retreat: async (actor, args) => { retreats.push({ actor, args }); return { ready: true } }, meleeHook: ({ calls, terminal, target }) => calls.length === 1 ? { code: 'HIT_LIMIT', hitsRequested: 1, targetRuntimeId: target.runtimeId, targetUniqueId: target.uniqueId, targetDead: false, serverConfirmed: false } : terminal() })
  f.actors.push({ ...structuredClone(f.target), runtimeId: '72', uniqueId: '-702', position: { x: 4, y: 65, z: 3 } }) // surrounded at healthy HP: the kite applies
  const r = await f.coordinator.tick()
  assert.equal(r.targetDead, true, JSON.stringify(r)); assert.equal(retreats.length, 1); assert.equal(retreats[0].actor.runtimeId, '70')
  assert.equal(f.meleeCalls[0].args.maxHits, 1)
  const plain = fixture(); await plain.coordinator.tick(); assert.equal(plain.meleeCalls[0].args.maxHits, undefined)
})
test('a creeper closing fast during ranged fire ends the claim with one bounded retreat step before it reaches the shot distance', async () => {
  const retreats = []
  const f = fixture({ bow: true, targetX: 14, rangedHook: () => 'pending', retreat: async (actor, args) => { retreats.push(args); return { ready: true } }, sleepHook: ({ target }) => { target.position.x -= 0.3 } })
  f.target.entityType = 'minecraft:creeper'
  const r = await f.coordinator.tick()
  assert.equal(r.code, 'CREEPER_CLOSING', JSON.stringify(r)); assert.ok(r.closingSpeed > 0)
  assert.equal(r.creeperRetreat, 'stepped'); assert.equal(retreats.length, 1); assert.deepEqual(retreats[0].radii, [9, 10, 8.5]); assert.equal(retreats[0].maxStep, 6)
  assert.ok(f.target.position.x > 8, 'stopped before the creeper reached the 8-block shot distance')
})
test('a creeper inside the shot distance gets an evade claim: repeated retreat steps, no attack, ending once it is 9m away', async () => {
  const retreats = []
  const f = fixture({ bow: true, targetX: 6, retreat: async (actor, args) => { retreats.push(args); f.target.position.x += 2; return { ready: true } } })
  f.target.entityType = 'minecraft:creeper'
  const r = await f.coordinator.tick()
  assert.equal(r.code, 'CREEPER_EVADED', JSON.stringify(r)); assert.ok(retreats.length >= 1 && retreats.length <= 4)
  assert.equal(f.meleeCalls.length, 0); assert.equal(f.rangedCalls.length, 0); assert.ok(retreats.every(a => a.maxStep === 6))
})
test('low HP under fire answers a hostile (bow band with a bow, 12m without); without recent damage only the 4m defence remains', async () => {
  const calm = fixture({ bow: true, targetX: 8 }); calm.state.health = 6
  assert.equal((await calm.coordinator.tick()).code, 'NO_CANDIDATE', 'no recent damage: retreat keeps only the 4m defence')
  const hit = fixture({ bow: true, targetX: 8, getRecentDamageAt: () => Date.now() }); hit.state.health = 6
  await hit.coordinator.tick(); assert.equal(hit.acquisitions.length, 1, 'being hit at 35% HP: the 8m shooter is answered')
})
test('a creeper whose shot is not ready is never approached', async () => {
  const f = fixture({ bow: true, targetX: 14, rangedHook: () => ({ code: 'LOS_BLOCKED', shotsRequested: 0 }) }); f.target.entityType = 'minecraft:creeper'
  await f.coordinator.tick()
  assert.equal(f.approaches.length, 0)
})
test('low HP: one close hostile is pressed with continuous hits (no kite); two close hostiles not yet in reach disengage, one in reach is fought', async () => {
  const retreats = []
  const single = fixture({ retreat: async () => { retreats.push(1); return { ready: true } } }); single.state.health = 6
  await single.coordinator.tick(); assert.equal(retreats.length, 0); assert.equal(single.meleeCalls[0].args.maxHits, undefined)
  const crowd = fixture({ targetX: 4.5 }); crowd.state.health = 6
  crowd.actors.push({ ...structuredClone(crowd.target), runtimeId: '72', uniqueId: '-702', position: { x: 4, y: 65, z: 3 } })
  assert.equal((await crowd.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(crowd.acquisitions.length, 0)
  const pinned = fixture(); pinned.state.health = 6
  pinned.actors.push({ ...structuredClone(pinned.target), runtimeId: '72', uniqueId: '-702', position: { x: 3, y: 65, z: 2 } })
  await pinned.coordinator.tick(); assert.equal(pinned.acquisitions.length, 1, 'an adjacent hostile is fought, not fled')
})
test('a blocked bow line first asks for a short sight stance before walking at the enemy', async () => {
  const f = fixture({ bow: true, targetX: 12, approachHook: ({ args }) => args.purpose === 'sight' ? { ready: false, reason: 'none nearby' } : { ready: false, reason: 'no stance' } })
  f.setRangedReady?.(false)
  await f.coordinator.tick()
  const purposes = f.approaches.map(a => a.args.purpose ?? 'melee')
  assert.ok(purposes.length >= 1, JSON.stringify(purposes)); assert.equal(purposes[0], 'sight')
})
test('a creeper behind terrain (>= 8m) gets only a sight-stance request, never a closing approach', async () => {
  const f = fixture({ bow: true, targetX: 14, approachHook: ({ args }) => ({ ready: false, reason: args.purpose ?? 'melee' }) })
  f.target.entityType = 'minecraft:creeper'; f.setRangedReady(false)
  const r = await f.coordinator.tick()
  const purposes = f.approaches.map(a => a.args.purpose ?? 'melee')
  assert.ok(purposes.length >= 1, JSON.stringify(r)); assert.ok(purposes.every(p => p === 'sight'), JSON.stringify(purposes))
  assert.equal(r.code, 'CREEPER_NO_SIGHT')
})
