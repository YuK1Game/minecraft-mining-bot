'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/work-survival-life17.json')
const { evaluateThreats } = require('../src/threats')
const { WORK_MARGIN, workMargin, workScope, captureWorkActors, resolveWorkActors, workEscapeEvaluation } = require('../src/work-clearance')
const { createIdleSafety } = require('../src/idle-safety')
const { buildTerrainThreatEvidence } = require('../src/terrain-threats')

const sample = () => structuredClone(fixture.state)
// Controlled outside variant retains the original historical actor fixture.
const outsideSample = () => {const s=sample();s.entities[0].position={...s.position,x:s.position.x+21};return s}
// SEPARATE CONTROLLED balanced HP20 variant for the unchanged26m retention contract.
const balancedOutsideSample = () => {const s=outsideSample();s.threatPolicy='balanced_mining';s.health=20;s.healthSource='controlled_test_scenario';return s}
const evaluate = state => evaluateThreats(state, state.entities)

test('actual life17 skeleton14.917m remains canonical18; learning21m work is clear and separate balanced26m retention is unchanged', () => {
  const historical=sample(),observed=evaluate(historical);assert.equal(observed.threats.length,1);assert.equal(observed.threats[0].dangerRadius,18);assert.ok(Math.abs(observed.threats[0].distance-14.917092193744397)<1e-9)
  const s=outsideSample(),evaluation=evaluate(s),actor=evaluation.outsideDanger[0]
  assert.equal(s.lifecycle.deathId,17);assert.deepEqual(s.inventory.items,[]);assert.equal(evaluation.threats.length,0);assert.equal(actor.dangerRadius,18);assert.equal(actor.distance,21)
  for(const flag of [undefined,false,1,'true',true]){s.survivalWorkClearance=flag;assert.equal(workMargin(s,actor),0);assert.deepEqual(captureWorkActors(s,evaluation,evaluation.outsideDanger),[])}
  assert.deepEqual(evaluate(s),evaluation)
  const controlled=balancedOutsideSample();controlled.survivalWorkClearance=true;const ordinary=evaluate(controlled),records=captureWorkActors(controlled,ordinary,ordinary.outsideDanger,1000)
  assert.equal(records.length,1);assert.equal(workMargin(controlled,ordinary.outsideDanger[0]),WORK_MARGIN);assert.equal(records[0].runtimeId,'14495');assert.equal(records[0].uniqueId,'-639950112792');assert.equal(records[0].scope,workScope(controlled));assert.equal(records[0].dangerRadius+workMargin(controlled,ordinary.outsideDanger[0]),26)
  assert.deepEqual(evaluate(controlled),ordinary);const retained=resolveWorkActors(controlled,ordinary,records);assert.equal(retained.actors.length,1);assert.equal(workEscapeEvaluation(ordinary,retained.actors).threats.length,1);assert.equal(ordinary.threats.length,0);assert.equal('safe' in records[0],false);assert.equal('serverConfirmed' in records[0],false)
})

test('CONTROLLED balanced skeleton retains26m and refuses stale scope, UID, missing actor or unknown pose', () => {
  const initial = balancedOutsideSample(); initial.survivalWorkClearance = true
  const records = captureWorkActors(initial, evaluate(initial), evaluate(initial).outsideDanger, 1000)
  const atDistance = distance => {
    const s = structuredClone(initial)
    s.entities[0].position = { ...s.position, x: s.position.x + distance }
    return s
  }
  const near = atDistance(25.9999)
  assert.equal(resolveWorkActors(near, evaluate(near), records).actors.length, 1)
  const clear = atDistance(26)
  assert.deepEqual(resolveWorkActors(clear, evaluate(clear), records).released, [{ runtimeId: '14495', reason: 'clearance' }])
  for (const change of [
    s => { s.connectionId = 'other' },
    s => { s.startedAt = '2026-11-01T16:00:00.000Z' },
    s => { s.entities[0].uniqueId = 'replacement' },
    s => { s.entities[0].entityType = 'minecraft:stray' },
    s => { s.entities[0].positionKnown = false },
    s => { s.entities = [] },
  ]) {
    const s = atDistance(20); change(s)
    const resolved = resolveWorkActors(s, evaluate(s), records)
    assert.deepEqual(resolved.invalid, ['14495'])
    assert.deepEqual(resolved.released, [])
  }
  const unbound = balancedOutsideSample(); unbound.survivalWorkClearance = true; unbound.entities[0].uniqueId = null
  assert.deepEqual(captureWorkActors(unbound, evaluate(unbound), evaluate(unbound).outsideDanger), [])
})

test('CONTROLLED balanced real IdleSafety capture stays passive and releases only at unchanged26m clearance', async t => {
  const state = balancedOutsideSample(); state.survivalWorkClearance = true
  let escapes = 0; let emergency = 0; let actions = 0
  const safety = createIdleSafety({
    getState: () => structuredClone(state), isIdle: () => false,
    equipSword: () => { actions++ }, closeGui: () => { actions++ },
    previewEngage: () => ({ ready: false }), engage: () => { actions++ },
    verifyBody: () => true, supportsWorkClearance: true,
    escape: () => { escapes++; throw Error('A busy caller may not be preempted') },
    onEmergencyStop: () => { emergency++ }, intervalMs: 1000, graceMs: 0,
  })
  t.after(() => safety.stop())
  safety.start(); await safety.drain()
  const requested = safety.requestWorkClearance()
  assert.equal(requested.pending, true)
  assert.equal(requested.actors[0].uniqueId, state.entities[0].uniqueId)
  assert.equal(safety.snapshot().workClearance.actors[0].targetDistance, 26)
  await safety.tick()
  assert.equal(safety.snapshot().workClearancePending, true)
  assert.equal(safety.snapshot().phase, 'work_clearance_pending')
  assert.equal(actions + escapes + emergency, 0)
  state.entities[0].position = { ...state.position, x: state.position.x + 26 }
  assert.equal(safety.requestWorkClearance().pending, false)
  assert.equal(actions + escapes + emergency, 0)
})

test('existing fresh proven terrain cover stays excluded; a margin flag cannot fabricate occlusion or clear unknown actors', () => {
  const state = sample(); state.survivalWorkClearance = true
  state.position = { x: 0.5, y: 66.62, z: 0.5 }
  state.entities[0].position = { x: 0.5, y: 50, z: 0.5 }
  const layers = [55, 56, 57, 59, 49]
  const world = { getBlock: (x, y, z) => ({ known: true, name: layers.includes(y) ? 'minecraft:stone' : 'minecraft:air', boundingBox: layers.includes(y) ? 'block' : 'empty', extra: [] }) }
  const before = evaluate(state)
  const records = captureWorkActors(state, before, before.threats)
  assert.equal(records.length, 1)
  state.entities[0].terrainOcclusion = buildTerrainThreatEvidence(state, state.entities[0], { world })
  assert.equal(state.entities[0].terrainOcclusion.suppressed, true)
  const covered = evaluate(state)
  assert.deepEqual(captureWorkActors(state, covered, covered.outsideDanger), [])
  assert.deepEqual(resolveWorkActors(state, covered, records).released, [{ runtimeId: '14495', reason: 'terrain' }])
  state.entities[0].positionKnown = false
  const unknown = evaluate(state)
  assert.equal(unknown.requiresObservation, true)
  assert.deepEqual(captureWorkActors(state, unknown, unknown.outsideDanger), [])
  assert.equal(workMargin({ threatPolicy: 'balanced_mining' }), 8)
  assert.equal(workMargin({ threatPolicy: 'balanced_mining', survivalWorkClearance: true }), 8)
})
