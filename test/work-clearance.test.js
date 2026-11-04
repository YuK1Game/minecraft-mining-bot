'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { evaluateThreats } = require('../src/threats')
const { captureWorkActors, resolveWorkActors, workEscapeEvaluation } = require('../src/work-clearance')
const { createIdleSafety } = require('../src/idle-safety')
const { buildTerrainThreatEvidence } = require('../src/terrain-threats')

// Reuse only the native fixtures. None of the large historical escape suite's
// tests or fake IO run when this small regression suite is loaded.
function fixtureFrom (filename, names) {
  const file = path.join(__dirname, filename)
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const target = { exports: {} }
  new vm.Script(Module.wrap(`${source}\nmodule.exports={${names}}`), { filename: file }).runInThisContext()(target.exports, Module.createRequire(file), target, file, __dirname)
  return target.exports
}
const runtimeFixture = fixtureFrom('runtime-idle-escape.test.js', 'prepare,context')
const guardFixture = fixtureFrom('guarded-route.test.js', 'fixture').fixture

function outsideFixture () {
  const f = guardFixture()
  f.actors.push(f.enemy('creeper', 9))
  const state = f.getState(); const evaluation = evaluateThreats(state, state.entities)
  const records = captureWorkActors(state, evaluation, evaluation.outsideDanger, 1000)
  return { ...f, records }
}

test('the pause margin retains the known outside creeper without changing actual policy or classification', () => {
  const f = outsideFixture(); const state = f.getState(); const current = evaluateThreats(state, state.entities)
  assert.equal(current.threats.length, 0)
  assert.equal(current.outsideDanger[0].dangerRadius, 8)
  const retained = resolveWorkActors(state, current, f.records)
  assert.equal(retained.actors.length, 1)
  assert.equal(workEscapeEvaluation(current, retained.actors).threats.length, 1)
  assert.equal(current.threats.length, 0)
  f.state.position.x = -7.5
  assert.equal(resolveWorkActors(f.getState(), evaluateThreats(f.getState(), f.actors), f.records).actors.length, 0)
})

test('retained actors reject reused IDs, changed policy, unknown positions and changed scope', () => {
  for (const change of [f => { f.actors[0].uniqueId = 'new' }, f => { f.actors[0].charged = true }, f => { f.actors[0].positionKnown = false }, f => { f.state.connectionId = 'other' }]) {
    const f = outsideFixture(); change(f)
    const state = f.getState()
    assert.equal(resolveWorkActors(state, evaluateThreats(state, state.entities), f.records).invalid.length, 1)
  }
})

test('received death and exact fresh removal discard a retained actor; mere absence does not', () => {
  for (const mode of ['death', 'removed', 'missing']) {
    const f = outsideFixture()
    if (mode === 'death') f.actors[0].alive = false
    else {
      f.actors.splice(0)
      if (mode === 'removed') f.state.removedEntities = [{ runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', removedAt: 1001 }]
    }
    const state = f.getState(); const result = resolveWorkActors(state, evaluateThreats(state, state.entities), f.records)
    assert.equal(result.actors.length, 0)
    assert.equal(result.invalid.length, mode === 'missing' ? 1 : 0)
  }
})

test('passives and fresh terrain-suppressed hostiles do not request work retreat, and fresh cover releases a tracked actor', () => {
  const f = guardFixture()
  const skeleton = f.enemy('skeleton', 0.5)
  skeleton.position.y = 50
  f.actors.push(skeleton, { ...f.enemy('cow', 3, '12'), entityType: 'minecraft:cow' }, { ...f.enemy('zombie', 3, '13'), kind: 'npc', isNpc: true })
  let state = f.getState(); let current = evaluateThreats(state, state.entities)
  const records = captureWorkActors(state, current)
  assert.equal(records.length, 1)
  const layers = [55, 56, 57, 59, 49]
  const world = { getBlock: (x, y, z) => ({ known: true, name: layers.includes(y) ? 'minecraft:stone' : 'minecraft:air', boundingBox: layers.includes(y) ? 'block' : 'empty', extra: [] }) }
  skeleton.terrainOcclusion = buildTerrainThreatEvidence(state, skeleton, { world })
  assert.equal(skeleton.terrainOcclusion.suppressed, true)
  state = f.getState(); current = evaluateThreats(state, state.entities)
  assert.equal(current.threats.length, 0)
  assert.equal(current.suppressedByTerrain.length, 1)
  assert.deepEqual(captureWorkActors(state, current, current.outsideDanger), [])
  assert.equal(resolveWorkActors(state, current, records).released[0].reason, 'terrain')
})

test('native Guard accepts an explicit scoped outside pursuer but keeps its actual threat status empty', async () => {
  const f = outsideFixture()
  const result = await f.route.escape([{ x: -5.5, y: 60, z: 0.5 }], { retainedActors: f.records, maxLegDistance: 8, allowUnarmedBootstrap: true })
  assert.equal(result.ok, true)
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.riskRemains, false)
  assert.deepEqual(result.currentThreats, [])
  assert.ok(result.movementStarts <= 5)
})

test('native Guard refuses an outside escape without scoped retained actors or after identity changes', async () => {
  for (const mode of ['absent', 'changed']) {
    const f = outsideFixture()
    if (mode === 'changed') f.actors[0].uniqueId = 'replacement'
    const result = await f.route.escape([{ x: -5.5, y: 60, z: 0.5 }], { ...(mode === 'changed' ? { retainedActors: f.records } : {}), maxLegDistance: 8, allowUnarmedBootstrap: true })
    assert.equal(result.arrived, false)
    assert.equal(f.calls.some(call => call.type === 'start'), false)
  }
})

test('a newly active actor interrupts a retained outside-pursuer route', async () => {
  const f = guardFixture({ onStart: ({ actors, arrive, target }) => { arrive(target); actors.push({ runtimeId: '11', uniqueId: '11', entityType: 'minecraft:zombie', alive: true, positionKnown: true, position: { x: target.x, y: 60, z: target.z } }); return { phase: 'awaiting_server_confirmation' } } })
  f.actors.push(f.enemy('creeper', 9))
  const state = f.getState(); const current = evaluateThreats(state, state.entities)
  const result = await f.route.escape([{ x: -5.5, y: 60, z: 0.5 }], { retainedActors: captureWorkActors(state, current, current.outsideDanger), maxLegDistance: 8, maxMovementStarts: 5, allowUnarmedBootstrap: true })
  assert.equal(result.escaped, false)
  assert.equal(result.arrived, false)
  assert.ok(result.movementStarts <= 5)
})

test('native Runtime and Guard continue from outside 8.65 to the separate 16-block pause clearance', async t => {
  const f = runtimeFixture.prepare(t, { realGuard: true })
  f.actors[0].position = { x: 9.15, y: f.raw.position.y, z: 0.5 }
  const initial = f.safeties[0].options.getState(); const current = evaluateThreats(initial, initial.entities)
  const records = captureWorkActors(initial, current, current.outsideDanger)
  assert.equal(current.threats.length, 0)
  assert.equal(current.outsideDanger[0].distance, 8.65)
  let result; let actions = 0
  do {
    result = await f.safeties[0].options.escape({ ...runtimeFixture.context(f), retainedActors: records })
    actions++
    assert.equal(result.arrived, true)
    assert.equal(result.serverConfirmed, false)
    assert.ok(result.movementStarts > 0 && result.movementStarts <= 5)
    assert.equal(evaluateThreats(f.raw, f.actors).threats.length, 0)
  } while (result.workClearancePending && actions < 8)
  assert.ok(actions <= 8)
  assert.equal(result.escaped, true)
  assert.ok(evaluateThreats(f.raw, f.actors).outsideDanger[0].distance >= 16)
  assert.deepEqual(f.packets, [])
})

test('work-clearance requests yield the next action while the current bounded owner finishes', async t => {
  let idle = false; let escapes = 0
  const state = { phase: 'spawned', profile: 'work', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '1', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, inventory: { known: true, items: [] }, predicted: { physicsState: { onGround: true } }, entities: [{ runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 9.15, y: 66.62, z: 0.5 } }] }
  const safety = createIdleSafety({ getState: () => structuredClone(state), isIdle: () => idle, equipSword: () => {}, closeGui: () => {}, previewEngage: () => {}, engage: () => {}, verifyBody: () => true, escape: context => { escapes++; assert.equal(context.threats.length, 0); assert.equal(context.retainedActors[0].uniqueId, '9'); state.position.x = -8; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++; return { supported: true, escaped: true, arrived: true, serverConfirmed: false } }, onEmergencyStop: () => assert.fail('clearance should succeed'), supportsWorkClearance: true, graceMs: 0, intervalMs: 1000 })
  t.after(() => safety.stop())
  safety.start(); await safety.drain()
  assert.equal(safety.requestWorkClearance().pending, true)
  const work = safety.snapshot().workClearance
  assert.equal(work.margin, 8)
  assert.equal(work.actors[0].dangerRadius, 8)
  assert.equal(work.actors[0].targetDistance, 16)
  assert.ok(Math.abs(work.actors[0].remainingDistance - 7.35) < 1e-9)
  await safety.tick()
  assert.equal(safety.snapshot().phase, 'work_clearance_pending')
  assert.equal(escapes, 0)
  idle = true; await safety.tick()
  assert.equal(escapes, 1)
  assert.equal(safety.snapshot().workClearancePending, false)
  assert.equal(safety.snapshot().phase, 'observing')
})

test('native IdleSafety follows a real danger episode through outside-danger clearance using fresh received progress', async t => {
  const f = runtimeFixture.prepare(t, { realGuard: true, realSafety: true })
  f.raw.rawServerPosition = { ...f.raw.position }
  f.raw.rawServerPositionUpdatedAt = 1
  const movement = f.guards[0].options.movement
  const start = movement.start
  movement.start = async (...args) => {
    const result = await start(...args)
    f.raw.rawServerPosition = { ...f.raw.position }
    f.raw.rawServerPositionUpdatedAt = (f.raw.rawServerPositionUpdatedAt ?? 0) + 1
    return result
  }
  f.runtime.operations.safety.start()
  await f.safeties[0].native.drain()
  const snapshot = f.safeties[0].native.snapshot()
  assert.equal(snapshot.emergencySent, false, JSON.stringify(snapshot))
  assert.equal(snapshot.workClearancePending, false)
  assert.equal(snapshot.lastResult.escaped, true)
  assert.ok(snapshot.escapes >= 2 && snapshot.escapes <= 8)
  const current = evaluateThreats(f.raw, f.actors)
  assert.equal(current.threats.length, 0)
  assert.ok(current.outsideDanger[0].distance >= 16)
  assert.deepEqual(f.packets, [])
})

test('native Runtime uses a pursuing outside actor current pose on the next bounded route', async t => {
  const f = runtimeFixture.prepare(t, { realGuard: true })
  f.actors[0].position = { x: 9.15, y: f.raw.position.y, z: 0.5 }
  const initial = f.safeties[0].options.getState(); const current = evaluateThreats(initial, initial.entities)
  const records = captureWorkActors(initial, current, current.outsideDanger)
  const first = await f.safeties[0].options.escape({ ...runtimeFixture.context(f), retainedActors: records })
  assert.equal(first.partialEscape, true)
  f.actors[0].position.x -= 1
  const pursuit = evaluateThreats(f.raw, f.actors)
  assert.equal(pursuit.threats.length, 0)
  const before = pursuit.outsideDanger[0].distance
  const second = await f.safeties[0].options.escape({ ...runtimeFixture.context(f), retainedActors: records })
  assert.equal(second.escaped, true)
  assert.ok(evaluateThreats(f.raw, f.actors).outsideDanger[0].distance > before)
  assert.equal(second.serverConfirmed, false)
  assert.ok(first.movementStarts <= 5 && second.movementStarts <= 5)
})

test('Runtime keeps the same four-second escape deadline and five-start allowance for retained work actors', async t => {
  const f = runtimeFixture.prepare(t)
  f.actors[0].position = { x: 9.15, y: f.raw.position.y, z: 0.5 }
  const state = f.safeties[0].options.getState(); const current = evaluateThreats(state, state.entities)
  await f.safeties[0].options.escape({ ...runtimeFixture.context(f), retainedActors: captureWorkActors(state, current, current.outsideDanger) })
  assert.ok(f.guards[0].calls.length > 0)
  for (const call of f.guards[0].calls) {
    assert.equal(call.bounds.maxMovementStarts, 5)
    assert.ok(call.bounds.timeoutMs > 0 && call.bounds.timeoutMs <= 4000)
  }
})

test('work-clearance continuation retains the eight-action cap and never renews a prediction lease', async t => {
  let escapes = 0; let emergency = 0
  const state = { phase: 'spawned', profile: 'work', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '1', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, inventory: { known: true, items: [] }, predicted: { physicsState: { onGround: true } }, entities: [{ runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 9.15, y: 66.62, z: 0.5 } }] }
  const safety = createIdleSafety({ getState: () => structuredClone(state), isIdle: () => true, equipSword: () => {}, closeGui: () => {}, previewEngage: () => {}, engage: () => {}, verifyBody: () => true, supportsWorkClearance: true, escape: () => { escapes++; state.position.x -= 0.25; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++; return { supported: true, escaped: false, partialEscape: true, arrived: true, serverConfirmed: false } }, onEmergencyStop: () => { emergency++ }, graceMs: 0, intervalMs: 1000 })
  t.after(() => safety.stop())
  safety.start(); await safety.drain(); safety.requestWorkClearance(); await safety.tick(); await Promise.resolve()
  assert.equal(escapes, 8)
  assert.equal(emergency, 0)
  assert.equal(safety.snapshot().workClearancePending, true)
  assert.equal(safety.snapshot().workClearance.held, true)
  assert.equal(safety.snapshot().emergencySent, false)
  for (let n = 0; n < 3; n++) { assert.equal(safety.requestWorkClearance().pending, true); await safety.tick() }
  assert.equal(escapes, 8)
  assert.equal(emergency, 0)
  assert.equal(safety.snapshot().phase, 'work_clearance_pending')
})

async function heldFixture (t) {
  let escapes = 0; let emergency = 0
  const body = { onVerify: null }
  const state = { phase: 'spawned', profile: 'work', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '1', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, inventory: { known: true, items: [] }, predicted: { physicsState: { onGround: true } }, entities: [{ runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 9.15, y: 66.62, z: 0.5 } }] }
  const safety = createIdleSafety({ getState: () => structuredClone(state), isIdle: () => true, equipSword: () => {}, closeGui: () => {}, previewEngage: () => {}, engage: () => {}, verifyBody: () => { body.onVerify?.(); return true }, supportsWorkClearance: true, escape: () => { escapes++; return { supported: false, reason: 'no_known_away_route', arrived: false, escaped: false } }, onEmergencyStop: () => { emergency++ }, graceMs: 0, intervalMs: 1000 })
  t.after(() => safety.stop())
  safety.start(); await safety.drain(); safety.requestWorkClearance(); await safety.tick()
  assert.equal(safety.snapshot().workClearance.held, true)
  assert.equal(escapes, 1)
  assert.equal(emergency, 0)
  return { safety, state, body, escapes: () => escapes, emergencies: () => emergency }
}

test('a healthy work-only no-route hold stays online without restarting movement or its budget', async t => {
  const f = await heldFixture(t)
  for (let n = 0; n < 4; n++) { f.safety.requestWorkClearance(); await f.safety.tick() }
  assert.equal(f.escapes(), 1)
  assert.equal(f.emergencies(), 0)
  assert.equal(f.safety.snapshot().running, true)
  assert.equal(f.safety.snapshot().busy, false)
  assert.equal(f.safety.snapshot().phase, 'work_clearance_pending')
  assert.equal(f.safety.snapshot().workClearancePending, true)
})

test('naturally satisfied clearance releases a held productive action without another escape', async t => {
  const f = await heldFixture(t)
  f.state.entities[0].position.x = 18
  await f.safety.tick()
  assert.equal(f.safety.snapshot().workClearance.held, false)
  assert.equal(f.safety.snapshot().workClearancePending, false)
  assert.equal(f.safety.snapshot().phase, 'observing')
  assert.equal(f.safety.requestWorkClearance().pending, false)
  assert.equal(f.escapes(), 1)
  assert.equal(f.emergencies(), 0)
})

test('fresh actual danger releases work hold and resumes the existing protection/emergency policy', async t => {
  const f = await heldFixture(t)
  f.state.entities[0].position.x = 6
  await f.safety.tick(); await Promise.resolve()
  assert.equal(f.safety.snapshot().workClearance.held, false)
  assert.equal(f.escapes(), 2)
  assert.equal(f.emergencies(), 1)
  assert.equal(f.safety.snapshot().emergencySent, true)
})

test('covered refuge, death and changed scope clear the work hold', async t => {
  for (const mode of ['covered', 'dead', 'scope']) {
    const f = await heldFixture(t)
    if (mode === 'covered') f.state.hut = { inside: true, closed: true, usable: true, serverConfirmed: true }
    if (mode === 'dead') { f.state.dead = true; f.state.health = 0; f.state.phase = 'dead' }
    if (mode === 'scope') f.state.connectionId = 'other'
    await f.safety.tick()
    assert.equal(f.safety.snapshot().workClearance.held, false, mode)
    assert.equal(f.escapes(), 1, mode)
    assert.equal(f.emergencies(), 0, mode)
    assert.equal(f.safety.snapshot().phase, mode === 'scope' ? 'stopped' : mode, mode)
  }
})

test('unknown actors and unsafe body cannot keep the work-only hold exemption', async t => {
  for (const mode of ['unknown', 'body']) {
    const f = await heldFixture(t)
    if (mode === 'unknown') f.state.entities[0].positionKnown = false
    else f.state.predicted.physicsState.onGround = false
    await f.safety.tick(); await Promise.resolve()
    assert.equal(f.safety.snapshot().workClearance.held, false, mode)
    assert.equal(f.emergencies(), 1, mode)
    assert.equal(f.safety.snapshot().emergencySent, true, mode)
  }
})

test('a held body check reobserves margin satisfaction or new actual danger before deciding to keep the hold', async t => {
  for (const mode of ['cleared', 'danger']) {
    const f = await heldFixture(t)
    f.body.onVerify = () => { f.body.onVerify = null; f.state.entities[0].position.x = mode === 'cleared' ? 18 : 6 }
    await f.safety.tick(); await Promise.resolve()
    assert.equal(f.safety.snapshot().workClearance.held, false, mode)
    assert.equal(f.emergencies(), mode === 'cleared' ? 0 : 1, mode)
    assert.equal(f.escapes(), mode === 'cleared' ? 1 : 2, mode)
    assert.equal(f.safety.snapshot().phase, mode === 'cleared' ? 'observing' : 'emergency_stopped', mode)
  }
})

