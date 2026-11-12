'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateThreats } = require('../src/threats')
const { chunkTravelThreatsClear } = require('../src/chunk-travel-threats')
const point = x => ({ x, y: 64, z: 0 })
const actor = (type = 'drowned', x = 10.877, extra = {}) => ({ runtimeId: '22', uniqueId: '-22', kind: 'mob', entityType: `minecraft:${type}`, dimension: 'overworld', alive: true, hostile: true, positionKnown: true, position: point(x), ...extra })
function fixture (entity = actor()) {
  const state = { runtimeEntityId: '1', dimension: 'overworld', health: 20, threatPolicy: 'balanced_mining', position: point(0), entities: [entity] }
  const risk = evaluateThreats(state, state.entities, { observationRadius: 32 })
  const input = { state, previous: point(0), next: point(0.5), risk, attackExposure: () => ({ intercept: false, unknown: false, reason: 'PROJECTILE_SIGHT_BLOCKED' }) }
  return { state, risk, input, entity, clear: extra => chunkTravelThreatsClear({ ...input, ...extra }) }
}
function regroup (f, group) {
  const rows = ['threats', 'outsideDanger', 'suppressedByTerrain', 'unreachable'].flatMap(key => f.risk[key])
  for (const key of ['threats', 'outsideDanger', 'suppressedByTerrain', 'unreachable']) f.risk[key] = []
  f.risk[group] = rows
}

test('the actual blocked-drowned condition permits movement despite being inside its old avoidance radius', () => {
  const f = fixture(), before = structuredClone(f.state), calls = []
  assert.equal(f.risk.threats.length, 1); assert.equal(f.risk.threats[0].dangerRadius, 14)
  assert.equal(f.clear({ attackExposure: (target, projected) => { calls.push(projected.position); assert.equal(target, f.entity); return { intercept: false, unknown: false, sight: false, reason: 'PROJECTILE_SIGHT_BLOCKED' } } }), true)
  assert.ok(calls.length > 2); assert.deepEqual(f.state, before)
})

for (const group of ['threats', 'outsideDanger', 'suppressedByTerrain', 'unreachable']) test(`known blocked attack access is rechecked for ${group}`, () => {
  const f = fixture(); regroup(f, group)
  assert.equal(f.clear(), true)
})

for (const verdict of [{ intercept: true, unknown: false }, { intercept: false, unknown: true }, {}, null, { intercept: false }, { intercept: false, unknown: 0 }]) test(`visible, unknown or malformed access ${JSON.stringify(verdict)} cannot permit a near hostile`, () => {
  assert.equal(fixture().clear({ attackExposure: () => verdict }), false)
})

test('throwing and asynchronous exposure callbacks cannot authorize the synchronous input guard', () => {
  const f = fixture()
  assert.equal(f.clear({ attackExposure: () => { throw Error('unknown terrain') } }), false)
  assert.equal(f.clear({ attackExposure: async () => ({ intercept: false, unknown: false }) }), false)
})

test('current position and the swept segment use existing exposure at intervals no greater than a quarter block', () => {
  const f = fixture(), seen = []
  assert.equal(f.clear({ next: point(7.5), attackExposure: (_actor, projected) => { seen.push(projected.position); return { intercept: false, unknown: false } } }), true)
  assert.equal(seen.length, 32)
  assert.deepEqual(seen[0], f.state.position); assert.deepEqual(seen.at(-1), point(7.5))
  for (let i = 2; i < seen.length; i++) assert.ok(Math.hypot(seen[i].x - seen[i - 1].x, seen[i].y - seen[i - 1].y, seen[i].z - seen[i - 1].z) <= 0.25)
  assert.equal(f.clear({ next: point(8), attackExposure: () => assert.fail('oversized sweeps are not sampled') }), false)
})

test('attack access opening only between blocked endpoints still stops the next input', () => {
  const f = fixture(), seen = []
  assert.equal(f.clear({ next: point(1), attackExposure: (_actor, projected) => { seen.push(projected.position.x); return { intercept: projected.position.x === 0.5, unknown: false } } }), false)
  assert.ok(seen.includes(0.5))
})

for (const changed of ['uid', 'type', 'dimension', 'position']) test(`${changed} changing during the canonical probe invalidates actor proof`, () => {
  const f = fixture()
  assert.equal(f.clear({ attackExposure: () => {
    if (changed === 'uid') f.entity.uniqueId = '-99'
    if (changed === 'type') f.entity.entityType = 'minecraft:zombie'
    if (changed === 'dimension') f.entity.dimension = 'nether'
    if (changed === 'position') f.entity.position.x++
    return { intercept: false, unknown: false }
  } }), false)
})

for (const missing of ['uid', 'runtime', 'type', 'dimension', 'positionKnown', 'duplicate']) test(`${missing} actor information fails closed before exposure is trusted`, () => {
  const f = fixture()
  if (missing === 'uid') delete f.entity.uniqueId
  if (missing === 'runtime') delete f.entity.runtimeId
  if (missing === 'type') delete f.entity.entityType
  if (missing === 'dimension') delete f.entity.dimension
  if (missing === 'positionKnown') f.entity.positionKnown = false
  if (missing === 'duplicate') f.state.entities.push(structuredClone(f.entity))
  assert.equal(f.clear({ attackExposure: () => assert.fail('missing identity is not a known blocked attack') }), false)
})

for (const missing of ['risk', 'array', 'observation', 'unknownPosition', 'truncated']) test(`${missing} risk information cannot become permission`, () => {
  const f = fixture()
  if (missing === 'risk') f.input.risk = null
  if (missing === 'array') delete f.risk.unreachable
  if (missing === 'observation') f.risk.requiresObservation = true
  if (missing === 'unknownPosition') f.risk.unknownPositions.push({ runtimeId: '99' })
  if (missing === 'truncated') f.risk.truncated = true
  assert.equal(f.clear(), false)
})

for (const [type, extra] of [['cow', { hostile: false }], ['pig', { hostile: false }], ['player', { kind: 'player' }], ['item', { kind: 'item' }], ['npc', { kind: 'npc' }]]) test(`confirmed passive ${type} remains allowed without inventing combat access`, () => {
  const f = fixture(actor(type, 2, extra))
  assert.equal(f.clear({ attackExposure: () => assert.fail('passive actors need no new combat policy') }), true)
})
for (const hostile of [undefined, true]) test(`unclassified generic mob with hostility ${String(hostile)} is not assumed safe`, () => {
  const f = fixture(actor('custom_unknown_mob', 2, { hostile }))
  assert.equal(f.clear(), false)
})

test('a creeper inside its blast margin is never waived by blocked sight or a missing walk route', () => {
  const f = fixture(actor('creeper', 4))
  assert.equal(f.clear({ attackExposure: () => assert.fail('creeper blast does not need an attack route') }), false)
})
test('an outside creeper keeps the existing full segment corridor and tolerance', () => {
  const f = fixture(actor('creeper', 10)), noProbe = () => assert.fail('outside creepers use the existing blast corridor')
  assert.equal(f.clear({ next: point(1), attackExposure: noProbe }), true)
  assert.equal(f.clear({ next: point(3), attackExposure: noProbe }), false)
  const edge = fixture(actor('creeper', 8 - 0.00005)); regroup(edge, 'outsideDanger'); edge.risk.outsideDanger[0].dangerous = false
  assert.equal(edge.clear({ previous: point(0), next: point(0), attackExposure: noProbe }), true)
  edge.entity.position.x = 8 - 0.0002; edge.risk.outsideDanger[0].position.x = edge.entity.position.x
  assert.equal(edge.clear({ previous: point(0), next: point(0), attackExposure: noProbe }), false)
})

test('an unsearched far outside zombie retains the old outside-circle movement permission', () => {
  const f = fixture(actor('zombie', 50))
  assert.equal(f.risk.outsideDanger.length, 1)
  assert.equal(f.clear({ attackExposure: (_actor, projected) => ({ intercept: false, unknown: true, distance: 50 - projected.position.x, recognitionRadius: 12, reason: 'ATTACK_ACCESS_UNKNOWN' }) }), true)
})
test('unknown access cannot approach the legacy circle even while outside canonical recognition range', () => {
  const f = fixture(actor('drowned', 15))
  assert.equal(f.risk.outsideDanger[0].dangerRadius, 14)
  assert.equal(f.clear({ next: point(2), attackExposure: (_actor, projected) => ({ intercept: false, unknown: true, distance: 15 - projected.position.x, recognitionRadius: 12 }) }), false)
  assert.equal(f.clear({ next: point(2) }), true, 'known blocked access still uses the canonical decision')
})
for (const group of ['threats', 'suppressedByTerrain', 'unreachable']) test(`far unknown fallback is not granted to ${group}`, () => {
  const f = fixture(actor('zombie', 50)); regroup(f, group)
  assert.equal(f.clear({ attackExposure: () => ({ intercept: false, unknown: true, distance: 50, recognitionRadius: 12 }) }), false)
})
for (const verdict of [{ intercept: false, unknown: true }, { intercept: false, unknown: true, distance: 50, recognitionRadius: '12' }, { intercept: false, unknown: true, distance: 12, recognitionRadius: 12 }, { intercept: true, unknown: false, distance: 50, recognitionRadius: 12 }]) test(`a far malformed or recognized attack ${JSON.stringify(verdict)} still stops`, () => {
  assert.equal(fixture(actor('zombie', 50)).clear({ attackExposure: () => verdict }), false)
})
