'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createMining } = require('../src/mining')
const file = path.resolve(__dirname, 'quarry-fluid-source.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
const nativeRequire = loaded.require.bind(loaded)
loaded.require = id => id === 'node:test' ? Object.assign(() => {}, { test: () => {} }) : nativeRequire(id)
loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { fixture }\n', file)

function fixture () {
  const f = loaded.exports.fixture(), neighbour = { x: 1, y: 61, z: 5 }
  const preview = () => {
    const state = { phase: 'spawned', gameMode: 'survival', profile: 'test', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-06T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20,
      position: { x: f.feet.x + .5, y: f.feet.y + 1.62, z: f.feet.z + .5 }, heldItem: { name: 'minecraft:diamond_pickaxe', durabilityKnown: true, durabilityRemaining: 1000 }, inventory: { known: true, items: f.tools } }
    const mining = createMining({ getState: () => state, world: { getBlock: f.read }, getInput: () => ({}) })
    return mining.preview([{ ...f.roof, expectedName: 'minecraft:deepslate', expectedRuntimeId: 2, accessPreparation: 'quarry_fluid_roof', fluidSource: { position: f.source, expectedName: 'minecraft:lava', expectedRuntimeId: 1000 }, requiredTool: { kind: 'pickaxe', tier: 4, reserve: 1 } }])
  }
  const setNeighbour = name => {
    f.put(neighbour, name)
    // Preserve the neighbouring cell just like the original fixture's floor;
    // only the one roof is an eligible mining target in this comparison.
    f.records.deferred[f.k(neighbour)] = { name: `minecraft:${name}`, reason: 'PRESERVED_TEST_FLOOR' }
  }
  return { ...f, neighbour, setNeighbour, preview }
}

test('the same received stone surroundings permit both the roof plan and its normal mining preview', async () => {
  const f = fixture(), decision = await f.next(f.make())
  assert.equal(decision.reason, 'FLUID_SOURCE_ACCESS')
  assert.equal(f.preview().ready, true)
})

for (const name of ['magma', 'cobweb']) test(`a received ${name} neighbour cannot pass roof planning when the identical mining operation rejects it`, async () => {
  const f = fixture(); f.setNeighbour(name)
  const preview = f.preview()
  assert.equal(preview.ready, false)
  assert.match(preview.errors.join(' '), /Fluid-roof other neighbours must remain received and dry/)
  const decision = await f.next(f.make())
  assert.notEqual(decision.reason, 'FLUID_SOURCE_ACCESS', 'planning must reject the same static hazard before proposing roof mining')
})

test('unknown, liquid, gravity and extra-layer neighbours remain denied by both roof gates', async t => {
  for (const kind of ['unknown', 'water', 'bubble_column', 'gravel', 'extra_water']) await t.test(kind, async () => {
    const f = fixture()
    if (kind === 'unknown') f.blocks.set(f.k(f.neighbour), { known: false })
    else if (kind === 'extra_water') {
      const block = structuredClone(f.read(f.neighbour.x, f.neighbour.y, f.neighbour.z))
      block.extra = ['minecraft:water']; f.blocks.set(f.k(f.neighbour), block)
    } else f.setNeighbour(kind)
    assert.equal(f.preview().ready, false, kind)
    const decision = await f.next(f.make())
    assert.notEqual(decision.reason, 'FLUID_SOURCE_ACCESS', kind)
  })
})
