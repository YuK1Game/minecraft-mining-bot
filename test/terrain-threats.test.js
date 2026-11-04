'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildTerrainThreatEvidence, annotateTerrainThreats, terrainOcclusionApplies } = require('../src/terrain-threats')
const { evaluateThreats } = require('../src/threats')

function fixture ({ layers = [60, 61, 62], x = 0.5, z = 0.5 } = {}) {
  const state = { runtimeEntityId: '1', dimension: 'overworld', position: { x, y: 70, z } }
  const entity = { runtimeId: '2', kind: 'mob', entityType: 'minecraft:skeleton', dimension: 'overworld', positionKnown: true, alive: true, position: { x, y: 51.38, z } }
  const overrides = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  let reads = 0
  const world = { getBlock: (x, y, z) => { reads++; return overrides.get(key(x, y, z)) ?? block(layers.includes(y) ? 'stone' : 'air') } }
  const now = () => 10000
  const set = (x, y, z, value) => overrides.set(key(x, y, z), typeof value === 'string' ? block(value) : value)
  return { state, entity, world, now, set, reads: () => reads }
}

test('a distant skeleton separated vertically by thick known terrain is screened using all thirteen body rays', () => {
  const f = fixture()
  const original = structuredClone({ state: f.state, entity: f.entity })
  const [annotated] = annotateTerrainThreats(f.state, [f.entity], f)
  const evidence = annotated.terrainOcclusion
  assert.equal(evidence.suppressed, true)
  assert.ok(Math.abs(evidence.verticalSeparation - 17) < 1e-6)
  assert.equal(evidence.rays.length, 13)
  assert.ok(evidence.rays.every(ray => ray.known && ray.barrierLength >= 3 - 1e-6 && ray.barrierCells >= 3))
  assert.equal(terrainOcclusionApplies(f.state, annotated, { now: f.now }), true)
  const result = evaluateThreats(f.state, [annotated], { now: f.now })
  assert.equal(result.threats.length, 0)
  assert.equal(result.suppressedByTerrain.length, 1)
  assert.equal(result.suppressedByTerrain[0].occludedNow, true)
  assert.match(result.suppressedByTerrain[0].reason, /保証しません/)
  assert.deepEqual({ state: f.state, entity: f.entity }, original)
  annotated.terrainOcclusion.observerPosition.x = 999
  assert.deepEqual({ state: f.state, entity: f.entity }, original)
  assert.ok(f.reads() < 600, 'per-entity rays reuse a bounded synchronous known-block cache')
})

test('a hillside eight or more blocks above a distant cave still requires thirteen thick known barriers', () => {
  const f = fixture({ layers: [64, 65, 66, 67] })
  f.state.position = { x: 0.5, y: 72.62, z: 0.5 }
  f.entity.position = { x: 18.5, y: 61, z: 0.5 }
  const [entry] = annotateTerrainThreats(f.state, [f.entity], f)
  assert.equal(entry.terrainOcclusion.suppressed, true)
  assert.equal(terrainOcclusionApplies(f.state, entry, { now: f.now }), true)
  const exposed = fixture({ layers: [65] })
  exposed.state.position = f.state.position
  exposed.entity.position = f.entity.position
  assert.equal(annotateTerrainThreats(exposed.state, [exposed.entity], exposed)[0].terrainOcclusion.suppressed, false)
})

test('thin or disconnected cover, unknown terrain, lava and unsupported geometry cannot screen a hostile', () => {
  for (const layers of [[], [60], [60, 61], [58, 60, 62]]) {
    const f = fixture({ layers })
    const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
    assert.equal(evidence.suppressed, false, String(layers))
  }
  for (const value of [{ known: false }, { known: true, name: 'minecraft:stone', boundingBox: 'empty', extra: [] }, { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ name: 'minecraft:water' }] }, { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [{ known: false, name: 'minecraft:water' }] }, { known: true, name: 'minecraft:glass', boundingBox: 'block', extra: [] }, 'lava']) {
    const f = fixture()
    f.set(0, 66, 0, value)
    const annotated = annotateTerrainThreats(f.state, [f.entity], f)
    assert.equal(annotated[0].terrainOcclusion.suppressed, false)
    assert.equal(evaluateThreats(f.state, annotated, { now: f.now }).threats.length, 1)
  }
})

test('a hole that affects an outer body ray invalidates otherwise thick central cover', () => {
  const f = fixture({ layers: [64, 65, 66], x: 0.05, z: 0.05 })
  assert.equal(buildTerrainThreatEvidence(f.state, f.entity, f).suppressed, true)
  f.set(-1, 65, -1, 'air')
  const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
  assert.equal(evidence.suppressed, false)
  assert.ok(evidence.rays.some(ray => ray.blocked))
  assert.ok(evidence.rays.some(ray => !ray.blocked))
})

test('nearby or same-height enemies, players and special wall-crossing or boss mobs remain conservative', () => {
  const f = fixture()
  const sameHeight = { ...f.entity, position: { x: 17.5, y: 68.38, z: 0.5 } }
  assert.equal(buildTerrainThreatEvidence(f.state, sameHeight, f).suppressed, false)
  assert.equal(evaluateThreats(f.state, annotateTerrainThreats(f.state, [sameHeight], f), { now: f.now }).threats.length, 1)
  const close = { ...f.entity, position: { x: 0.5, y: 63.38, z: 0.5 } }
  assert.equal(buildTerrainThreatEvidence(f.state, close, f).suppressed, false)
  const valid = buildTerrainThreatEvidence(f.state, f.entity, f)
  for (const type of ['vex', 'warden', 'wither', 'ender_dragon', 'blaze', 'ghast', 'creeper', 'custom:skeleton']) {
    const entityType = type.includes(':') ? type : `minecraft:${type}`
    const entity = { ...f.entity, entityType, terrainOcclusion: { ...valid, entityType } }
    assert.equal(terrainOcclusionApplies(f.state, entity, { now: f.now }), false, type)
  }
  const player = { ...f.entity, kind: 'player' }
  assert.equal(buildTerrainThreatEvidence(f.state, player, f).suppressed, false)
  assert.equal(buildTerrainThreatEvidence(f.state, { ...f.entity, position: null }, f).suppressed, false)
})

test('movement, dimension changes, old evidence and incomplete ray evidence immediately restore normal threat evaluation', () => {
  const f = fixture()
  const [entity] = annotateTerrainThreats(f.state, [f.entity], f)
  assert.equal(terrainOcclusionApplies(f.state, entity, { now: f.now }), true)
  for (const state of [{ ...f.state, position: { ...f.state.position, x: 0.01 } }, { ...f.state, dimension: 'nether' }]) assert.equal(terrainOcclusionApplies(state, entity, { now: f.now }), false)
  assert.equal(terrainOcclusionApplies(f.state, { ...entity, position: { ...entity.position, y: 51.4 } }, { now: f.now }), false)
  assert.equal(evaluateThreats(f.state, [entity], { now: () => 12000 }).threats.length, 1)
  assert.equal(terrainOcclusionApplies(f.state, entity, { now: () => 9000 }), false)
  const invalid = structuredClone(entity)
  invalid.terrainOcclusion.rays[0].barrierLength = 2.99
  assert.equal(terrainOcclusionApplies(f.state, invalid, { now: f.now }), false)
  invalid.terrainOcclusion.rays.pop()
  assert.equal(terrainOcclusionApplies(f.state, invalid, { now: f.now }), false)
  f.set(0, 61, 0, 'air')
  assert.equal(annotateTerrainThreats(f.state, [f.entity], f)[0].terrainOcclusion.suppressed, false, 'the next host snapshot must rebuild from current blocks')
})

test('annotation is bounded and never leaves an old suppression on entities outside the observation budget', () => {
  const f = fixture()
  const first = annotateTerrainThreats(f.state, [f.entity], f)[0]
  const result = annotateTerrainThreats(f.state, [f.entity, { ...first, runtimeId: '3' }], { ...f, maxEntities: 1 })
  assert.equal(result[0].terrainOcclusion.suppressed, true)
  assert.equal(result[1].terrainOcclusion, null)
  assert.throws(() => annotateTerrainThreats(f.state, [f.entity], { ...f, maxEntities: 0 }))
  assert.throws(() => buildTerrainThreatEvidence(f.state, f.entity, { ...f, now: () => NaN }))
})

function drownedHill ({ ridge = [24, 25, 26] } = {}) {
  const state = { runtimeEntityId: '494', dimension: 'overworld', position: { x: -11.5, y: 68.62, z: 22.5 } }
  const entity = { runtimeId: '901', kind: 'mob', entityType: 'minecraft:drowned', dimension: 'overworld', positionKnown: true, alive: true, position: { x: -7.7, y: 61, z: 29.3 } }
  const overrides = new Map()
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: ['air', 'water', 'flowing_water', 'seagrass'].includes(name) ? 'empty' : 'block', properties: ['water', 'flowing_water'].includes(name) ? { liquid_depth: 0 } : {}, extra: [] })
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y <= 60 ? 'stone' : ridge.includes(z) && y <= 67 ? y === 67 ? 'grass_block' : 'dirt' : z <= 23 && y <= 66 ? 'dirt' : z >= 27 && y <= 63 ? 'water' : 'air') }
  const set = (x, y, z, value) => overrides.set(`${x},${y},${z}`, typeof value === 'string' ? block(value) : value)
  return { state, entity, world, now: () => 10000, set }
}

test('the observed shore-height drowned is screened by thirteen thick soil prefixes without claiming suffix water was traced', () => {
  const f = drownedHill()
  const waterPosition = { x: -8, y: 61, z: 29 }
  const waterBefore = structuredClone(f.world.getBlock(waterPosition.x, waterPosition.y, waterPosition.z))
  const original = structuredClone({ state: f.state, entity: f.entity })
  const [observed] = annotateTerrainThreats(f.state, [f.entity], f)
  assert.ok(observed.terrainOcclusion.distance > 8 && observed.terrainOcclusion.distance < 14)
  assert.ok(Math.abs(observed.terrainOcclusion.verticalSeparation - 6) < 1e-6)
  assert.equal(observed.terrainOcclusion.suppressed, true)
  assert.equal(observed.terrainOcclusion.rays.length, 13)
  assert.ok(observed.terrainOcclusion.rays.every(ray => ray.proofPrefix && ray.barrierCells >= 3 && ray.barrierLength >= 3 - 1e-6))
  assert.ok(observed.terrainOcclusion.rays.some(ray => ray.waterCells === 0 && ray.checkedFraction < 1), 'water behind an already proven wall is not counted as a traversed prefix cell')
  assert.equal(terrainOcclusionApplies(f.state, observed, { now: f.now }), true)
  const result = evaluateThreats(f.state, [observed], { now: f.now })
  assert.equal(result.threats.length, 0)
  assert.equal(result.suppressedByTerrain.length, 1)
  assert.deepEqual(f.world.getBlock(waterPosition.x, waterPosition.y, waterPosition.z), waterBefore)
  assert.equal(waterBefore.name, 'minecraft:water')
  assert.deepEqual({ state: f.state, entity: f.entity }, original)
  const plant = drownedHill()
  plant.set(-8, 61, 29, { known: true, name: 'minecraft:seagrass', boundingBox: 'empty', extra: [{ name: 'minecraft:water' }] })
  assert.equal(buildTerrainThreatEvidence(plant.state, plant.entity, plant).suppressed, true)
})

test('known water before or after a proven barrier is transparent evidence and never contributes to its thickness', () => {
  const f = fixture()
  f.set(0, 66, 0, { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [{ name: 'minecraft:water' }] })
  const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
  assert.equal(evidence.suppressed, true)
  assert.ok(evidence.rays.some(ray => ray.waterCells > 0))
  const noBarrier = drownedHill({ ridge: [] })
  assert.equal(buildTerrainThreatEvidence(noBarrier.state, noBarrier.entity, noBarrier).suppressed, false)
  const thin = drownedHill({ ridge: [24, 25] })
  assert.equal(buildTerrainThreatEvidence(thin.state, thin.entity, thin).suppressed, false)
  const split = fixture({ layers: [60, 62, 64] })
  split.set(0, 61, 0, 'water'); split.set(0, 63, 0, 'flowing_water')
  assert.equal(buildTerrainThreatEvidence(split.state, split.entity, split).suppressed, false, 'water cannot bridge separate solid runs')
})

test('water inside a missing barrier, an outer-ray hole, unknown or lava still restores danger', () => {
  const hole = drownedHill({ ridge: [24, 26] })
  const original = hole.world.getBlock
  hole.world.getBlock = (x, y, z) => z === 25 && y >= 61 && y <= 67 ? { known: true, name: 'minecraft:water', boundingBox: 'empty', properties: { liquid_depth: 0 }, extra: [] } : original(x, y, z)
  assert.equal(buildTerrainThreatEvidence(hole.state, hole.entity, hole).suppressed, false)
  for (const value of [{ known: false }, 'lava']) {
    const f = drownedHill()
    f.set(-8, 61, 29, value)
    const entries = annotateTerrainThreats(f.state, [f.entity], f)
    assert.equal(entries[0].terrainOcclusion.suppressed, false)
    assert.equal(evaluateThreats(f.state, entries, { now: f.now }).threats.length, 1)
  }
})

test('a drowned surfacing or approaching invalidates the old proof immediately, as do time and player-pose changes', () => {
  const f = drownedHill()
  const [observed] = annotateTerrainThreats(f.state, [f.entity], f)
  assert.equal(terrainOcclusionApplies(f.state, observed, { now: f.now }), true)
  const surfaced = { ...observed, position: { ...observed.position, y: 66 } }
  assert.equal(terrainOcclusionApplies(f.state, surfaced, { now: f.now }), false)
  const freshSurfaced = annotateTerrainThreats(f.state, [surfaced], f)
  assert.equal(freshSurfaced[0].terrainOcclusion.suppressed, false)
  assert.equal(evaluateThreats(f.state, freshSurfaced, { now: f.now }).threats.length, 1)
  assert.equal(terrainOcclusionApplies(f.state, observed, { now: () => 12000 }), false)
  assert.equal(terrainOcclusionApplies({ ...f.state, position: { ...f.state.position, z: 22.51 } }, observed, { now: f.now }), false)
  const close = { ...f.entity, position: { x: -11.5, y: 61, z: 22.5 } }
  assert.equal(buildTerrainThreatEvidence(f.state, close, f).suppressed, false)
  for (const type of ['vex', 'warden']) assert.equal(buildTerrainThreatEvidence(f.state, { ...f.entity, entityType: `minecraft:${type}` }, f).suppressed, false)
})

test('a proven thick barrier terminates a known prefix before farther lava or unknown terrain without claiming the suffix', () => {
  for (const replacement of ['lava', { known: false, reason: 'unreceived beyond the wall' }]) {
    const f = fixture()
    f.set(0, 58, 0, replacement)
    const raw = structuredClone(f.world.getBlock(0, 58, 0))
    const read = f.world.getBlock
    const queried = []
    f.world.getBlock = (x, y, z) => { queried.push({ x, y, z }); return read(x, y, z) }
    const [entity] = annotateTerrainThreats(f.state, [f.entity], f)
    const evidence = entity.terrainOcclusion
    assert.equal(evidence.policy, 'deep_known_solid_separation_v3_corner_prefix')
    assert.equal(evidence.suppressed, true)
    assert.equal(evidence.rays.length, 13)
    assert.equal(queried.some(point => point.y === 58), false, 'no ray reads behind its already proven wall')
    for (const ray of evidence.rays) {
      assert.equal(ray.endpointsKnownClear, true)
      assert.equal(ray.proofPrefix, true)
      assert.equal(ray.known, true)
      assert.equal(ray.hazard, false)
      assert.ok(ray.checkedFraction > 0 && ray.checkedFraction < 1)
      assert.ok(ray.terminatedAt.y >= 60 - 1e-6)
      assert.ok(ray.barrierLength >= 3 - 1e-6 && ray.barrierCells >= 3)
      assert.equal(ray.reason, 'known_thick_solid_barrier_prefix')
    }
    assert.equal(terrainOcclusionApplies(f.state, entity, { now: f.now }), true)
    assert.equal(evaluateThreats(f.state, [entity], { now: f.now }).suppressedByTerrain.length, 1)
    assert.deepEqual(read(0, 58, 0), raw, 'visibility evidence never promotes unknown terrain or changes lava')
  }
})

test('hazard or unknown before proof, a thin wall and an unconfirmed endpoint still cannot establish occlusion', () => {
  for (const replacement of ['lava', { known: false, reason: 'before the wall' }]) {
    const f = fixture(); f.set(0, 65, 0, replacement)
    const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
    assert.equal(evidence.suppressed, false)
    assert.ok(evidence.rays.some(ray => !ray.known && !ray.proofPrefix))
    const endpoint = fixture(); endpoint.set(0, 53, 0, replacement)
    const rejected = buildTerrainThreatEvidence(endpoint.state, endpoint.entity, endpoint)
    assert.equal(rejected.suppressed, false)
    assert.ok(rejected.rays.some(ray => ray.reason === 'endpoint_not_known_clear' && !ray.endpointsKnownClear))
  }
  const thin = fixture({ layers: [61, 62] }); thin.set(0, 58, 0, 'lava')
  assert.equal(buildTerrainThreatEvidence(thin.state, thin.entity, thin).suppressed, false)
})

test('prefix location/version metadata, current actor pose and fresh world rays are revalidated', () => {
  const f = fixture()
  const [entity] = annotateTerrainThreats(f.state, [f.entity], f)
  for (const change of [
    value => { value.terrainOcclusion.policy = 'deep_known_solid_separation_v1' },
    value => { value.terrainOcclusion.rays[0].checkedFraction = 1.5 },
    value => { value.terrainOcclusion.rays[0].terminatedAt.x += 0.01 },
    value => { value.terrainOcclusion.rays[0].endpointsKnownClear = false },
    value => { value.terrainOcclusion.rays[0].proofPrefix = false }
  ]) {
    const value = structuredClone(entity); change(value)
    assert.equal(terrainOcclusionApplies(f.state, value, { now: f.now }), false)
  }
  const moved = { ...f.state, position: { ...f.state.position, x: 0.6 } }
  assert.equal(terrainOcclusionApplies(moved, entity, { now: f.now }), false)
  assert.equal(annotateTerrainThreats(moved, [f.entity], f)[0].terrainOcclusion.suppressed, true)
  f.set(0, 61, 0, 'air')
  assert.equal(annotateTerrainThreats(f.state, [f.entity], f)[0].terrainOcclusion.suppressed, false)
})

function capturedCornerCover () {
  const observed = require('./fixtures/third-spawn-drowned-corner-cover.json')
  const blocks = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, structuredClone(block)]))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  return { state: structuredClone(observed.state), entity: structuredClone(observed.entity), world, blocks, now: () => 10000 }
}

test('captured cliff cover retains all thirteen prefix proofs when only two corner probes end in known stone', () => {
  const f = capturedCornerCover()
  const original = structuredClone({ state: f.state, entity: f.entity, blocks: [...f.blocks] })
  const [entity] = annotateTerrainThreats(f.state, [f.entity], f)
  const evidence = entity.terrainOcclusion
  assert.equal(evidence.suppressed, true)
  assert.equal(evidence.rays.length, 13)
  assert.ok(evidence.rays.every(ray => ray.sourceKnownAir && ray.known && ray.blocked && ray.proofPrefix && ray.barrierLength >= 3 && ray.barrierCells >= 3))
  assert.ok(evidence.rays.slice(0, 9).every(ray => !ray.cornerProbe && ray.targetKnownClear && !ray.targetKnownSolid && ray.endpointsKnownClear))
  assert.deepEqual(evidence.rays.flatMap((ray, index) => ray.targetKnownSolid ? [index] : []), [11, 12])
  for (const index of [11, 12]) {
    const ray = evidence.rays[index]
    assert.equal(ray.cornerProbe, true)
    assert.equal(ray.endpointsKnownClear, false, 'a solid probe endpoint must never be called clear')
    assert.equal(ray.targetKnownClear, false)
    assert.equal(ray.targetKnownSolid, true)
    assert.ok(ray.checkedFraction < 0.7, 'received thick cover is proved well before the solid terminal cell')
    assert.ok(ray.terminatedAt.y >= 65)
  }
  assert.equal(terrainOcclusionApplies(f.state, entity, { now: f.now }), true)
  const evaluated = evaluateThreats(f.state, [entity], { now: f.now })
  assert.equal(evaluated.threats.length, 0)
  assert.equal(evaluated.suppressedByTerrain.length, 1)
  assert.deepEqual({ state: f.state, entity: f.entity, blocks: [...f.blocks] }, original)
})

test('solid corner probes still require clear sources, clear central endpoints and fully known nonhazardous endpoint geometry', () => {
  const replacements = [
    { known: false },
    { known: true, name: 'minecraft:lava', boundingBox: 'block', properties: { liquid_depth: 0 }, extra: [] },
    { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ name: 'minecraft:water' }] },
    { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ known: false }] },
    { known: true, name: 'minecraft:glass', boundingBox: 'block', extra: [] }
  ]
  for (const replacement of replacements) {
    const f = capturedCornerCover()
    f.blocks.set('-8,62,27', replacement)
    const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
    assert.equal(evidence.suppressed, false)
    assert.equal(evidence.rays[11].known, false)
    assert.equal(evidence.rays[11].proofPrefix, false, 'the endpoint must be validated even behind an otherwise proven prefix')
  }
  for (const cell of ['-11,69,24', '-7,62,27']) {
    const f = capturedCornerCover()
    f.blocks.set(cell, { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] })
    const evidence = buildTerrainThreatEvidence(f.state, f.entity, f)
    assert.equal(evidence.suppressed, false, cell)
    if (cell === '-7,62,27') assert.ok([2, 5, 8].every(index => !evidence.rays[index].known && !evidence.rays[index].targetKnownSolid))
  }
  const unknownPrefix = capturedCornerCover()
  unknownPrefix.blocks.set('-10,67,24', { known: false })
  assert.equal(buildTerrainThreatEvidence(unknownPrefix.state, unknownPrefix.entity, unknownPrefix).suppressed, false)
})

test('a known solid corner terminal cube cannot complete an otherwise insufficient barrier', () => {
  const f = fixture({ layers: [54, 55], x: 0.05, z: 0.05 })
  f.entity.position.y = 51.101
  f.set(-1, 53, -1, 'stone')
  const ray = buildTerrainThreatEvidence(f.state, f.entity, f).rays[12]
  assert.equal(ray.targetKnownSolid, true)
  assert.equal(ray.endpointsKnownClear, false)
  assert.equal(ray.known, true)
  assert.equal(ray.blocked, false)
  assert.equal(ray.proofPrefix, false)
  assert.equal(ray.reason, 'solid_corner_requires_prior_barrier_prefix')
  assert.ok(ray.maxSolidLength < 3)
  assert.equal(ray.maxSolidCells, 2)
})

test('the new endpoint policy binds each proof to its exact ray and rejects contradictory or inflated metadata', () => {
  const f = capturedCornerCover()
  const [entity] = annotateTerrainThreats(f.state, [f.entity], f)
  for (const mutate of [
    value => { value.policy = 'deep_known_solid_separation_v2_prefix' },
    value => { value.rays = Array.from({ length: 13 }, () => structuredClone(value.rays[0])) },
    value => { [value.rays[11], value.rays[12]] = [value.rays[12], value.rays[11]] },
    value => { value.rays[0].cornerProbe = true },
    value => { value.rays[0].targetKnownSolid = true },
    value => { value.rays[11].endpointsKnownClear = true },
    value => { value.rays[11].targetKnownClear = true },
    value => { value.rays[11].cornerProbe = false },
    value => { value.rays[11].sourceKnownAir = false },
    value => { value.rays[11].from.x += 0.01 },
    value => { value.rays[11].barrierLength = 100 },
    value => { value.rays[11].checkedCells = 0 },
    value => { value.rays[11].barrierCells = value.rays[11].checkedCells + 1 },
    value => { value.rays[11].checkedFraction = 1; value.rays[11].terminatedAt = { ...value.rays[11].to } }
  ]) {
    const changed = structuredClone(entity)
    mutate(changed.terrainOcclusion)
    assert.equal(terrainOcclusionApplies(f.state, changed, { now: f.now }), false)
  }
})

test('identical evidence is reused only within one world revision; any applied world packet forces a fresh trace', () => {
  const f = fixture()
  let revision = 1, reads = 0
  const world = { getBlock: (...a) => { reads++; return f.world.getBlock(...a) }, revision: () => revision }
  const first = annotateTerrainThreats(f.state, [f.entity], { ...f, world })[0].terrainOcclusion
  const before = reads
  const second = annotateTerrainThreats(f.state, [f.entity], { ...f, world })[0].terrainOcclusion
  assert.equal(reads, before, 'same revision, positions and time window reuse the evidence'); assert.equal(second.suppressed, first.suppressed)
  revision++; f.set(0, 61, 0, 'air')
  assert.equal(annotateTerrainThreats(f.state, [f.entity], { ...f, world })[0].terrainOcclusion.suppressed, false, 'a new revision rebuilds from current blocks')
})
