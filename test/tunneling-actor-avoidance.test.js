'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { evaluateThreats } = require('../src/threats')

// Reuse the existing cheap known-stone/real-Excavation fixture without running
// its test registrations or changing any production dependency defaults.
const fixtureFile = path.resolve(__dirname, 'tunneling.test.js')
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n')
const fixtureStart = fixtureSource.indexOf('function fixture (')
const fixtureEnd = fixtureSource.indexOf('\n\ntest(', fixtureStart)
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart)
const fixtureModule = { exports: {} }
new vm.Script(Module.wrap(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + fixtureSource.slice(fixtureStart, fixtureEnd) + '\nmodule.exports = { fixture }'), { filename: fixtureFile }).runInThisContext()(fixtureModule.exports, Module.createRequire(fixtureFile), fixtureModule, fixtureFile, path.dirname(fixtureFile))
const fixture = options => {
  const value = fixtureModule.exports.fixture(options)
  value.state.threatPolicy = 'online_learning'
  return value
}
const copy = value => structuredClone(value)
const eye = p => ({ ...p, y: p.y + 1.62 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const actor = (position, extra = {}) => ({ runtimeId: '100', uniqueId: '100', entityType: 'minecraft:zombie', kind: 'mob', alive: true, positionKnown: true, dimension: 'overworld', position: { ...position }, ...extra })
function segmentDistance (p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const length = dx * dx + dy * dy + dz * dz
  const ratio = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / length)) : 0
  return distance(p, { x: a.x + dx * ratio, y: a.y + dy * ratio, z: a.z + dz * ratio })
}
function assertFutureCircles (plan, circles) {
  const eyes = [plan.origin, ...plan.steps.map(step => eye(step.target))]
  for (const circle of circles) {
    for (let index = 1; index < eyes.length; index++) {
      assert.ok(distance(circle.position, eyes[index]) > circle.dangerRadius, 'Future node uses the unchanged canonical radius in eye space')
      assert.ok(segmentDistance(circle.position, eyes[index - 1], eyes[index]) >= circle.dangerRadius - 1e-4, 'Every planned eye segment preserves the canonical circle')
    }
    assert.ok(distance(circle.position, eye(plan.approach)) > circle.dangerRadius, 'The accessible ore standpoint stays outside the same circle')
  }
}

test('outside canonical zombie and skeleton circles change a known terrain route without changing their radii', () => {
  for (const [entityType, position, radius] of [
    ['minecraft:zombie', { x: 6.5, y: 5.62, z: 0.5 }, 5],
    ['minecraft:skeleton', { x: 11.5, y: 8.62, z: 0.5 }, 10]
  ]) {
    const f = fixture(), baseline = f.tunneling.preview(f.decision)
    assert.equal(baseline.ready, true, baseline.reason)
    f.state.hostiles = [actor(position, { entityType })]
    const canonical = evaluateThreats(f.state, f.state.hostiles, { observationRadius: 32 })
    assert.equal(canonical.threats.length, 0)
    assert.equal(canonical.outsideDanger.length, 1)
    assert.equal(canonical.outsideDanger[0].dangerRadius, radius)
    const oldEyes = [baseline.origin, ...baseline.steps.map(step => eye(step.target))]
    assert.ok(oldEyes.slice(1).some((next, index) => segmentDistance(position, oldEyes[index], next) < radius), 'The terrain-only route really enters the actor circle')
    const rerouted = f.tunneling.preview(f.decision)
    assert.equal(rerouted.ready, true, rerouted.reason)
    assert.notDeepEqual(rerouted.steps.map(step => step.target), baseline.steps.map(step => step.target))
    assertFutureCircles(rerouted, canonical.outsideDanger)
    assert.equal(f.calls.length, 0, 'Actor planning emits no mining or movement action')
  }
})

test('safe endpoints do not authorize a planned segment that cuts through an actor circle', () => {
  const f = fixture(), baseline = f.tunneling.preview(f.decision)
  const from = baseline.origin, to = eye(baseline.steps[0].target)
  const position = { x: 1 + 4.99 / Math.sqrt(2), y: 7.12 + 4.99 / Math.sqrt(2), z: 0.5 }
  assert.ok(distance(position, from) > 5)
  assert.ok(distance(position, to) > 5)
  assert.ok(segmentDistance(position, from, to) < 5 - 1e-4)
  f.state.hostiles = [actor(position)]
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.notDeepEqual(plan.steps[0].target, baseline.steps[0].target, 'The first intersecting edge is rejected despite its safe endpoints')
  assertFutureCircles(plan, evaluateThreats(f.state, f.state.hostiles).outsideDanger)
})

test('an immediately accessible future cell centre cannot borrow safety from a different actual eye', () => {
  const f = fixture({ target: { x: 3, y: 6, z: 0 } })
  f.state.position.x = 0.8
  const before = f.tunneling.preview(f.decision)
  assert.equal(before.ready, true, before.reason)
  assert.equal(before.oreAccessible, true)
  const position = { x: -4.4, y: 7.62, z: 0.5 }
  assert.ok(distance(position, f.state.position) > 5)
  assert.ok(distance(position, { x: 0.5, y: 7.62, z: 0.5 }) < 5)
  f.state.hostiles = [actor(position)]
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.oreAccessible, false, 'The unsafe planned centre cannot be returned as zero-step ore access')
  assert.ok(plan.steps.length > 0)
  assertFutureCircles(plan, evaluateThreats(f.state, f.state.hostiles).outsideDanger)
  assert.equal(f.calls.length, 0)
})

test('missing or ambiguous hostile observations deny tunneling before any child action', () => {
  const far = { x: 100, y: 7.62, z: 100 }
  const cases = {
    missing_list: f => { delete f.state.hostiles },
    unknown_position: f => { f.state.hostiles = [actor(far, { positionKnown: false })] },
    invalid_id: f => { f.state.hostiles = [actor(far, { runtimeId: 'invalid' })] },
    duplicate_id: f => { f.state.hostiles = [actor(far), actor({ ...far, z: 101 })] },
    too_many: f => { f.state.hostiles = Array.from({ length: 65 }, (_, index) => actor({ ...far, z: far.z + index }, { runtimeId: String(100 + index) })) }
  }
  for (const [name, change] of Object.entries(cases)) {
    const f = fixture(); change(f)
    const plan = f.tunneling.preview(f.decision)
    assert.equal(plan.ready, false, name)
    assert.equal(plan.code, 'THREAT_OBSERVATION_UNKNOWN', name)
    assert.equal(f.calls.length, 0, name)
  }
})

test('future-route avoidance does not relax the existing current hostile rejection', () => {
  const f = fixture()
  f.state.hostiles = [actor({ x: 4.5, y: 7.62, z: 0.5 })]
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, false)
  assert.equal(plan.code, 'NEARBY_THREAT')
  assert.equal(f.calls.length, 0)
})

test('direct nondestructive movement receives fresh canonical zero-padding circles at both preview and start', async () => {
  for (const changed of [false, true]) {
    const f = fixture({ target: { x: 6, y: 6, z: 0 } })
    for (let x = 0; x < 6; x++) for (const y of [6, 7]) f.set({ x, y, z: 0 }, 'air')
    f.state.hostiles = [actor({ x: 20, y: 7.62, z: 0.5 })]
    const calls = []
    const preview = f.movement.preview, start = f.movement.start
    f.movement.preview = (target, options) => {
      calls.push({ kind: 'preview', target: copy(target), avoidance: copy(options?.avoidance) })
      if (changed) f.state.hostiles[0].position.x = 21
      return preview(target, options)
    }
    f.movement.start = (target, options) => { calls.push({ kind: 'start', target: copy(target), avoidance: copy(options?.avoidance) }); return start(target, options) }
    const plan = f.tunneling.preview(f.decision)
    assert.equal(plan.ready, true, plan.reason)
    assert.ok(plan.steps.every(step => step.kind === 'move'))
    const result = await f.tunneling.execute(f.decision, { maxSteps: 1, maxDigBlocks: 0 })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => call.kind), ['preview', 'start'])
    const expected = x => [{ id: '100', position: { x, y: 7.62, z: 0.5 }, minDistance: 5, padding: 0 }]
    assert.deepEqual(calls[0].avoidance, expected(20))
    assert.deepEqual(calls[1].avoidance, expected(changed ? 21 : 20), 'Start reobserves actor positions instead of recycling the planning or preview snapshot')
    if (!changed) assert.deepEqual(calls[1].avoidance, calls[0].avoidance)
    assert.equal(f.calls.filter(call => call.type === 'mine').length, 0)
    assert.equal(result.collected, false)
    assert.equal(result.serverConfirmed, false)
  }
})
