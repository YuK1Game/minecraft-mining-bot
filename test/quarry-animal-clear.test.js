'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { selectAnimalTarget, excludedReason } = require('../src/quarry-animal-clear')

const columns = new Set(); for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) columns.add(`${x},${z}`)
const state = { dimension: 'overworld', position: { x: 8.5, y: 21.62, z: 8.5 } }
const meta = (patch = {}) => ({ flagsKnown: true, baby: false, tamed: false, leashed: false, sitting: false, nameTagKnown: true, nameTag: '', ownerKnown: false, owner: null, ...patch })
let serial = 0
const mob = (type, position, patch = {}) => ({ kind: 'mob', entityType: type, hostile: false, alive: true, positionKnown: true, position, dimension: 'overworld', runtimeId: String(++serial), uniqueId: String(-serial), animalMeta: meta(), ...patch })
const pick = actors => selectAnimalTarget({ actors, state, columns, yTop: 64, yBottom: 18 })

test('a chicken in the pit near the bot is chosen', () => {
  const chicken = mob('minecraft:chicken', { x: 10.5, y: 20, z: 9.5 })
  assert.equal(pick([chicken]).target, chicken)
})

test('excluded kinds are never chosen', () => {
  for (const type of ['minecraft:villager', 'minecraft:wandering_trader', 'minecraft:iron_golem', 'minecraft:snow_golem', 'minecraft:allay', 'minecraft:wolf', 'minecraft:bee', 'minecraft:goat', 'minecraft:polar_bear', 'minecraft:llama', 'minecraft:trader_llama', 'minecraft:panda', 'minecraft:cat', 'minecraft:parrot', 'minecraft:horse', 'minecraft:donkey', 'minecraft:mule', 'minecraft:camel', 'minecraft:skeleton_horse', 'minecraft:enderman']) {
    const r = pick([mob(type, { x: 10.5, y: 20, z: 9.5 })])
    assert.equal(r.target, null, type)
  }
})

test('named, leashed, tamed, owned, baby and metadata-unknown animals are not chosen', () => {
  for (const [patch, reason] of [
    [{ animalMeta: meta({ nameTag: 'Bob' }) }, 'NAMED'],
    [{ animalMeta: meta({ leashed: true }) }, 'TAMED_OR_LEASHED'],
    [{ animalMeta: meta({ tamed: true }) }, 'TAMED_OR_LEASHED'],
    [{ animalMeta: meta({ ownerKnown: true, owner: '12345' }) }, 'OWNED'],
    [{ animalMeta: meta({ baby: true }) }, 'BABY'],
    [{ animalMeta: meta({ flagsKnown: false }) }, 'METADATA_UNKNOWN'],
    [{ animalMeta: undefined }, 'METADATA_UNKNOWN']
  ]) {
    const a = mob('minecraft:cow', { x: 10.5, y: 20, z: 9.5 }, patch)
    assert.equal(excludedReason(a), reason)
    assert.equal(pick([a]).target, null, reason)
  }
})

test('animals outside the pit (beyond the 1-block margin, above the surface, below the deepest layer) or beyond 8 m are not chosen', () => {
  for (const position of [{ x: 17.5, y: 20, z: 8.5 }, { x: 8.5, y: 70, z: 8.5 }, { x: 8.5, y: 10, z: 8.5 }, { x: 15.5, y: 20, z: 15.5 }]) {
    assert.equal(pick([mob('minecraft:pig', position)]).target, null, JSON.stringify(position))
  }
  const edge = mob('minecraft:pig', { x: 16.5, y: 20, z: 8.5 })
  assert.equal(pick([edge]).target, edge, 'the 1-block margin is inside')
})

test('no animal is chosen within 6 m of a villager or wandering trader', () => {
  const sheep = mob('minecraft:sheep', { x: 10.5, y: 20, z: 9.5 })
  assert.equal(pick([sheep, mob('minecraft:wandering_trader', { x: 13.5, y: 20, z: 9.5 })]).target, null)
  assert.equal(pick([sheep, mob('minecraft:villager_v2', { x: 30.5, y: 20, z: 30.5 })]).target, sheep)
})

test('a nearby hostile always comes first', () => {
  const chicken = mob('minecraft:chicken', { x: 10.5, y: 20, z: 9.5 })
  const zombie = mob('minecraft:zombie', { x: 20.5, y: 20, z: 20.5 }, { hostile: true })
  const r = pick([chicken, zombie])
  assert.equal(r.target, null); assert.equal(r.reason, 'HOSTILE_PRESENT')
})

test('animal clearing is a per-job setting, off by default', async () => {
  const { createQuarryJob } = require('../src/quarry-job')
  const { createSim, flatTerrain } = require('./helpers/quarry-sim')
  const sim = createSim({ loaded: { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 } })
  flatTerrain(sim, { x1: -6, x2: 20, z1: -6, z2: 20, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 })
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  assert.equal(job.plan({ jobId: 'animal', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 62, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true, storage: [] } }).ready, true)
  assert.equal(job.document().config.strategy.clearAnimals, undefined)
  await assert.rejects(job.configureAnimalClearing({ enabled: 'yes' }))
  await job.configureAnimalClearing({ enabled: true })
  assert.equal(job.document().config.strategy.clearAnimals, true)
  await job.configureAnimalClearing({ enabled: false })
  assert.equal(job.document().config.strategy.clearAnimals, false)
})
