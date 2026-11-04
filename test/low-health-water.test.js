'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { lowHealthSurfaceEligible, proveLowHealthSurfaceRoute } = require('../src/low-health-water')

function fixture () {
  const physical = { position: { x: 0, y: 62.1, z: 0 }, velocity: { x: 0, y: 0.012, z: 0 }, isInWater: true, isInLava: false, onGround: false }
  const entities = [{ runtimeId: '2', uniqueId: 'two', entityType: 'minecraft:skeleton', dimension: 'overworld', positionKnown: true, alive: true, position: { x: 0, y: 55, z: -10 } }, { runtimeId: '3', uniqueId: 'three', entityType: 'minecraft:zombie', dimension: 'overworld', positionKnown: true, alive: true, position: { x: -8, y: 62, z: 0 } }]
  const state = { phase: 'spawned', gameMode: 'survival', health: 6, position: { x: 0, y: 63.72, z: 0 }, dimension: 'overworld', inventory: { known: true }, breath: { current: 300, maximum: 300 }, entities, predicted: { physicsState: physical } }
  const actors = entities.map(e => ({ runtimeId: e.runtimeId, name: e.entityType, category: e.runtimeId === '2' ? 'ranged' : 'melee' }))
  const physics = { waterSurface: () => ({ surfaceY: 63 }), blockAt: ({ y }) => ({ name: y < 63 ? 'water' : 'air', metadata: 0, shapes: [] }), step: previous => ({ ...previous, position: { ...previous.position, z: previous.position.z + 0.002 } }) }
  const preview = { directSurface: true, waypoints: [{ medium: 'water' }] }
  const navigator = { physics, createStepper: () => { let tick = 0; return { next: () => ({ phase: ++tick === 3 ? 'awaiting_server_confirmation' : 'moving', predictedState: { ...physical, position: { ...physical.position, z: tick * 0.1 } } }) } } }
  const proof = () => proveLowHealthSurfaceRoute({ navigator, initial: physical, preview, circles: [{ id: '2', position: entities[0].position, minDistance: 13 }], surfaceY: 63, shallow: () => true })
  return { state, actors, physics, navigator, preview, proof }
}

test('low-health received rising water state permits a known Skeleton and Zombie group without a sword or full dry support', () => {
  const f = fixture()
  assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), true)
  f.state.predicted.physicsState.velocity.y = -0.001
  assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), true, 'the actual native first step determines rising, not the old velocity sign')
  assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics, { starting: false, surfaceY: 63 }), true, 'an already-proved bob is checked by its received body and strict actor floors')
})

test('death, unknown breath, wet head, unknown body, projectiles, primed Creeper, boss and unknown actor identity reject the permission', () => {
  for (const mutate of [f => { f.state.health = 0 }, f => { f.state.breath = null }, f => { f.physics.blockAt = () => ({ name: 'water', metadata: 0, shapes: [] }) }, f => { f.physics.blockAt = () => { throw new Error('unknown') } }, f => { f.state.entities.push({ entityType: 'minecraft:arrow', alive: true }) }, f => { f.actors[0].name = 'minecraft:creeper'; f.state.entities[0].primed = true }, f => { f.actors[0].category = 'boss' }, f => { delete f.state.entities[0].uniqueId }]) {
    const f = fixture(); mutate(f)
    assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), false)
  }
})

test('explicit native surface proof bounds execution plus eight float-coast frames without granting server credit', () => {
  const f = fixture(), result = f.proof()
  assert.equal(result.ready, true, result.reason)
  assert.equal(result.ticks, 3)
  assert.equal(result.coastTrace.length, 9)
  assert.equal(result.trace.length, 12)
  assert.equal(result.serverConfirmed, false)
  f.navigator.createStepper = () => ({ next: () => ({ phase: 'moving', predictedState: { position: { x: 2, y: 62.1, z: 0 } } }) })
  assert.equal(f.proof().ready, false)
})

test('fixed actor floors, unknown coast and non-surface preview reject without relaxing a distance', () => {
  const f = fixture()
  f.physics.step = previous => ({ ...previous, position: { ...previous.position, z: -1 } })
  assert.equal(f.proof().ready, false)
  const g = fixture(); g.preview.directSurface = false
  assert.equal(g.proof().ready, false)
  const h = fixture()
  h.navigator.createStepper = () => ({ next: () => ({ phase: 'moving', predictedState: { position: { x: 0, y: 62.09, z: 0.1 } } }) })
  assert.equal(h.proof().reason, 'first_actual_step_not_rising')
})

const observationTime = Date.parse('2026-11-01T01:44:26.868Z')
function arrow (extra = {}) {
  return { runtimeId: '99', uniqueId: 'arrow-99', entityType: 'minecraft:arrow', dimension: 'overworld', alive: true, positionKnown: true, position: { x: 2, y: 61, z: 0 }, positionUpdatedAt: '2026-11-01T01:44:23.723Z', ...extra }
}
function eligible (f, diagnostic = {}) { return lowHealthSurfaceEligible(f.state, f.actors, f.physics, { diagnostic, now: observationTime }) }

test('a known far old arrow is outside local observations without claiming it is embedded', () => {
  const f = fixture(), diagnostic = {}
  f.state.entities.push(arrow({ position: { x: 1000, y: 61, z: 1000 }, positionUpdatedAt: '2026-10-31T23:00:00.000Z' }))
  assert.equal(eligible(f, diagnostic), true)
  assert.equal(diagnostic.remoteProjectileCount, 1)
  assert.equal(diagnostic.projectileCount, 0)
  assert.equal(diagnostic.projectileRiskAccepted, false)
})

test('balanced and default policies keep near, stale-near, unknown and boundary projectiles blocked', () => {
  const variants = [arrow(), arrow({ positionUpdatedAt: '2026-10-31T23:00:00.000Z' }), arrow({ position: null }), arrow({ positionKnown: false }), arrow({ dimension: null }), arrow({ uniqueId: null }), arrow({ positionUpdatedAt: null }), arrow({ positionUpdatedAt: '2026-11-01T01:45:00.000Z' }), arrow({ position: { x: 128, y: 63.72, z: 0 } })]
  for (const projectile of variants) for (const policy of [undefined, 'balanced_mining']) {
    const f = fixture(), diagnostic = {}; f.state.threatPolicy = policy; f.state.entities.push(projectile)
    assert.equal(eligible(f, diagnostic), false)
    assert.equal(diagnostic.reason, 'active_projectile')
    assert.equal(diagnostic.projectileRiskAccepted, false)
  }
})

test('explicit online learning can accept observed nearby arrow risk while retaining native-route proof', () => {
  const f = fixture(), diagnostic = {}; f.state.threatPolicy = 'online_learning'
  f.state.entities.push(arrow(), arrow({ runtimeId: '100', uniqueId: 'arrow-100', position: { x: 1.5, y: 61, z: 0.5 } }))
  assert.equal(eligible(f, diagnostic), true)
  assert.equal(diagnostic.reason, 'eligible_with_projectile_risk')
  assert.equal(diagnostic.projectileRiskAccepted, true)
  assert.equal(diagnostic.projectileCount, 2)
  assert.deepEqual(diagnostic.projectileNames, ['minecraft:arrow'])
  assert.equal(f.proof().ready, true)
  f.preview.directSurface = false
  assert.equal(f.proof().ready, false, 'eligibility never bypasses the native surface route contract')
})

test('online learning does not accept unobserved projectile position, identity, time or scope', () => {
  for (const extra of [{ position: null }, { positionKnown: false }, { uniqueId: null }, { dimension: null }, { dimension: 'nether' }, { positionUpdatedAt: null }, { positionUpdatedAt: 'invalid' }, { positionUpdatedAt: '2026-11-01T02:00:00.000Z' }]) {
    const f = fixture(), diagnostic = {}; f.state.threatPolicy = 'online_learning'; f.state.entities.push(arrow(extra))
    assert.equal(eligible(f, diagnostic), false)
    assert.equal(diagnostic.reason, 'active_projectile')
    assert.equal(diagnostic.projectileRiskAccepted, false)
  }
})

test('accepted projectile risk never relaxes life, water-body, breath, inventory, boss or actor identity guards', () => {
  const changes = [f => { f.state.health = 0 }, f => { f.state.health = 20.001 }, f => { f.state.dead = true }, f => { f.state.gameMode = 'creative' }, f => { f.state.predicted.physicsState.isInWater = false }, f => { f.state.predicted.physicsState.velocity = null }, f => { f.state.breath = null }, f => { f.state.inventory.known = false }, f => { f.physics.blockAt = () => ({ name: 'water', metadata: 0, shapes: [] }) }, f => { f.physics.blockAt = () => { throw Error('unknown') } }, f => { f.actors[0].category = 'boss' }, f => { delete f.state.entities[0].uniqueId }, f => { f.actors[0].name = 'minecraft:creeper'; f.state.entities[0].primed = true }]
  for (const change of changes) {
    const f = fixture(), diagnostic = {}; f.state.threatPolicy = 'online_learning'; f.state.entities.push(arrow()); change(f)
    assert.equal(eligible(f, diagnostic), false)
    assert.equal(diagnostic.projectileRiskAccepted, false)
  }
})

test('projectile diagnostics are bounded and dead projectiles do not become accepted risk', () => {
  const f = fixture(), diagnostic = {}; f.state.threatPolicy = 'online_learning'
  for (let i = 0; i < 70; i++) f.state.entities.push(arrow({ runtimeId: String(100 + i), uniqueId: 'p-' + i, kind: 'projectile', entityType: 'custom:observed-' + i }))
  assert.equal(eligible(f, diagnostic), true)
  assert.equal(diagnostic.projectileCount, 64)
  assert.equal(diagnostic.projectileCountTruncated, true)
  assert.equal(diagnostic.projectileNames.length, 8)
  const g = fixture(), empty = {}; g.state.threatPolicy = 'online_learning'; g.state.entities.push(arrow({ alive: false }))
  assert.equal(eligible(g, empty), true)
  assert.equal(empty.projectileRiskAccepted, false)
  assert.equal(empty.projectileCount, 0)
})
