'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createCombatCoordinator } = require('../src/combat-coordinator')

// These are actual received anchors in the preserved life293 event4/event5
// captures. The intervening claim origins were not captured; tests below use
// explicitly controlled origins and never attribute the actual CHASE_LIMIT.
const OLD_RAW = { x: -30.699995040893555, y: 77.37320709228516, z: 4.220558166503906 }
const NEW_RAW = { x: -68.20672607421875, y: 80.62001037597656, z: 15.54305648803711 }
const CONTROLLED_ORIGIN = { x: -68.63529731175686, y: 80.62, z: 15.330161072485787 }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function loadModule (filename, source) {
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source, filename)
  return loaded.exports
}

function fixtureFrom (basename) {
  const filename = path.join(__dirname, basename)
  const source = fs.readFileSync(filename, 'utf8').split(/\r?\ntest\(/)[0]
  return loadModule(filename, source + '\nmodule.exports = { fixture }\n').fixture
}

const coordinatorFixture = fixtureFrom('combat-coordinator.test.js')
const meleeFixture = fixtureFrom('melee-combat.test.js')
const coordinatorFilename = require.resolve('../src/combat-coordinator')
const currentSource = fs.readFileSync(coordinatorFilename, 'utf8')
const currentGuard = 'if (distance(s.position, lease.origin) > maxChaseDistance)'
const originalGuard = 'if (distance(s.position, lease.origin) > maxChaseDistance || finite(s.rawServerPosition) && distance(s.rawServerPosition, lease.rawOrigin) > maxChaseDistance)'
const { createCombatCoordinator: createOriginalCoordinator } = loadModule(coordinatorFilename,
  currentSource.includes(currentGuard) ? currentSource.replace(currentGuard, originalGuard) : currentSource)

test('a historical raw refresh alone differs from the original chase guard while current geometry remains fixed', async () => {
  const results = []
  for (const original of [true, false]) {
    let time = 0, enabled = true, pendingResolve, active = false, admitted = false
    const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'controlled-293', startedAt: 'controlled-start', runtimeEntityId: '273', dimension: 'overworld', lifecycle: { deathId: 293 }, health: 20, position: { ...CONTROLLED_ORIGIN }, rawServerPosition: { ...OLD_RAW }, inventory: { known: true, items: [] } }
    const actor = { runtimeId: '10314', uniqueId: '-639950116896', kind: 'mob', entityType: 'minecraft:creeper', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: state.position.x + 1.7, y: state.position.y - 1.62, z: state.position.z } }
    const actorOrigin = structuredClone(actor.position)
    const calls = { engage: 0, cancel: 0, release: 0 }
    const controller = { preview: () => ({ ready: true }), engage: () => { calls.engage++; active = true; return new Promise(resolve => { pendingResolve = resolve }) }, cancel: (reason, code) => { calls.cancel++; active = false; pendingResolve?.({ code, targetRuntimeId: actor.runtimeId, targetUniqueId: actor.uniqueId, targetDead: false, serverConfirmed: false }) }, drain: async () => {}, snapshot: () => ({ cleanupUnconfirmed: false }) }
    const make = original ? createOriginalCoordinator : createCombatCoordinator
    let coordinator
    coordinator = make({ maxChaseDistance: 24, getState: () => state, entities: { snapshot: () => [structuredClone(actor)] }, melee: controller, ranged: controller, canAct: () => enabled, now: () => time,
      acquire: async () => { admitted = true; return { acquired: true, token: 'controlled-lease' } }, resume: async () => { calls.release++; return { resumed: true } },
      sleep: async ms => {
        time += ms
        if (active && admitted && state.rawServerPosition.x === OLD_RAW.x) state.rawServerPosition = { ...NEW_RAW }
        else if (active && !original) { enabled = false; coordinator.cancel('Controlled observation completed', 'CONTROL_DONE') }
        await turn()
      } })
    const result = await coordinator.tick()
    assert.equal(result.code, original ? 'CHASE_LIMIT' : 'CONTROL_DONE')
    assert.deepEqual(state.position, CONTROLLED_ORIGIN)
    assert.deepEqual(actor.position, actorOrigin)
    assert.ok(distance(actor.position, CONTROLLED_ORIGIN) < 2.35)
    assert.ok(Math.abs(distance(OLD_RAW, NEW_RAW) - 39.312791462961655) < 1e-10)
    assert.deepEqual(calls, { engage: 1, cancel: 1, release: 1 })
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.botCausedDamage, null)
    results.push(result)
  }
  assert.equal(results[0].reason, 'Attacker moved beyond the claim-origin chase bound')
})

async function coupledMelee ({ original = false, mutate = null, allowed = true } = {}) {
  let time = 1000, lease = false, coordinator, controllerResult = null
  const calls = { engage: 0, cancel: 0, release: 0 }
  let f
  f = meleeFixture({ simulatedWall: true, isBusy: () => !lease, onSleep: () => f.modelPose() })
  // Translate the actual anchor delta onto the existing real Native flat-world
  // fixture. The working pose is freshly modeled at its known dry floor; these
  // inventory/queue receipts are controlled in memory, not Realm observations.
  const workingOrigin = structuredClone(f.state.position)
  const historicalRaw = Object.fromEntries(['x', 'y', 'z'].map(k => [k, workingOrigin[k] + OLD_RAW[k] - NEW_RAW[k]]))
  f.state.rawServerPosition = structuredClone(historicalRaw)
  f.rawState.rawServerPosition = structuredClone(historicalRaw)
  f.modelPose()
  const real = f.melee
  const controller = { ...real,
    engage: async (runtimeId, options) => {
      calls.engage++
      controllerResult = await real.engage(runtimeId, { ...options, critical: false, maxHits: 1 })
      coordinator.cancel('One real aimed request completed', 'CONTROL_DONE')
      return controllerResult
    }, cancel: (...args) => { calls.cancel++; return real.cancel(...args) } }
  const inactiveRanged = { preview: () => ({ ready: false }), engage: async () => { throw new Error('No ranged action expected') }, cancel: () => {}, drain: async () => {}, snapshot: () => ({ cleanupUnconfirmed: false }) }
  const make = original ? createOriginalCoordinator : createCombatCoordinator
  coordinator = make({ maxChaseDistance: 24, getState: () => f.state, entities: { snapshot: () => structuredClone(f.actors) }, melee: controller, ranged: inactiveRanged,
    acquire: async () => {
      lease = true
      f.state.rawServerPosition = structuredClone(workingOrigin)
      f.rawState.rawServerPosition = structuredClone(workingOrigin)
      mutate?.(f)
      return { acquired: true, token: 'controlled-root-lease' }
    }, resume: async () => { lease = false; calls.release++; return { resumed: true } }, canAct: () => allowed,
    now: () => time, sleep: async ms => { time += ms; await turn() } })
  const result = await coordinator.tick()
  return { f, result, controllerResult, calls, workingOrigin, historicalRaw }
}

test('real Melee requests only after a new actual aimed input receipt when the historical raw anchor refreshes', async () => {
  const old = await coupledMelee({ original: true })
  assert.equal(old.result.code, 'CHASE_LIMIT')
  assert.equal(old.calls.engage, 0)
  assert.equal(old.f.attacks.length, 0)
  const current = await coupledMelee()
  assert.equal(current.result.code, 'CONTROL_DONE', JSON.stringify(current.result))
  assert.equal(current.calls.engage, 1)
  assert.equal(current.calls.release, 1)
  assert.equal(current.f.attacks.length, 1)
  assert.deepEqual(current.f.state.position, current.workingOrigin)
  assert.ok(Math.abs(distance(current.historicalRaw, current.workingOrigin) - distance(OLD_RAW, NEW_RAW)) < 1e-10)
  const inputIndex = current.f.packets.findIndex(p => p.name === 'player_auth_input')
  const attackIndex = current.f.packets.findIndex(p => p.name === 'inventory_transaction')
  assert.ok(inputIndex >= 0 && attackIndex > inputIndex)
  const attempt = current.controllerResult.attempts[0]
  assert.ok(current.f.packets.some(p => p.name === 'player_auth_input' && String(p.params.tick) === attempt.queuedTick))
  assert.equal(attempt.criticalAttempt, false)
  assert.equal(attempt.hitConfirmed, false)
  assert.equal(current.controllerResult.hitsRequested, 1)
  assert.equal(current.controllerResult.serverConfirmed, false)
  assert.equal(current.controllerResult.botCausedDamage, null)
  assert.equal(current.controllerResult.botCausedDeath, null)
})

test('working, target and authoritative current teleports still obey the unchanged24m claim bound', async () => {
  for (const mode of ['working', 'target', 'authoritative_current']) {
    let moved = false
    const f = coordinatorFixture({ maxChaseDistance: 24, meleeHook: () => 'pending', sleepHook: ({ events, state, target }) => {
      if (!moved && events.includes('engage_melee')) {
        moved = true
        if (mode === 'target') target.position.x = 25
        else {
          state.position.x += 24.01
          if (mode === 'authoritative_current') { state.positionSource = 'server_post_move'; state.rawServerPosition = structuredClone(state.position) }
        }
      }
    } })
    const result = await f.coordinator.tick()
    assert.equal(result.code, 'CHASE_LIMIT', mode)
    assert.equal(result.reason, mode === 'target' ? 'Bound target moved beyond the claim-origin chase bound' : 'Attacker moved beyond the claim-origin chase bound')
    assert.equal(f.cancels.length, 1)
    assert.equal(f.resumes.length, 1)
    assert.equal(result.serverConfirmed, false)
  }
})

test('UID, life, Root permission and duration guards are retained', async () => {
  for (const mode of ['uid', 'life', 'root', 'duration']) {
    let changed = false
    const f = coordinatorFixture({ maxChaseDistance: 24, durationMs: 1000, meleeHook: () => 'pending', sleepHook: ({ events, state, target, setEnabled }) => {
      if (!changed && events.includes('engage_melee')) {
        changed = true
        if (mode === 'uid') target.uniqueId = '-701'
        if (mode === 'life') state.lifecycle.deathId++
        if (mode === 'root') setEnabled(false)
      }
    } })
    const result = await f.coordinator.tick()
    assert.equal(result.code, { uid: 'TARGET_CHANGED', life: 'SESSION_CHANGED', root: 'AUTOMATIC_MODE_DISABLED', duration: 'DURATION_LIMIT' }[mode], mode)
    assert.equal(f.cancels.length, 1)
    assert.equal(f.resumes.length, 1)
    assert.equal(result.serverConfirmed, false)
  }
})

test('invalid current model or unknown inventory cannot gain a real Melee request after raw refresh', async () => {
  for (const mutate of [f => { f.state.predicted.physicsState.position.x += 0.01 }, f => { f.state.positionUpdatedAt = f.state.predicted.updatedAt = new Date(Date.now() - 1000).toISOString() }, f => { f.state.inventory.known = false }]) {
    const current = await coupledMelee({ mutate })
    assert.equal(current.f.attacks.length, 0)
    assert.equal(current.f.packets.filter(p => p.name === 'player_auth_input').length, 0)
    assert.equal(current.controllerResult, null)
    assert.equal(current.result.code, 'NO_READY_ACTION')
    assert.equal(current.result.serverConfirmed, false)
  }
})
