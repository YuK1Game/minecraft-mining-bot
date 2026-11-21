'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createMineSupplies } = require('../src/modes/mining/mine-supplies')

function fixture (plankCounts, extra = {}) {
  const plan = createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const stock = { torch: 32, cobblestone_slab: 64, cobblestone: 64, ladder: 0, stick: 0, ...extra }
  const inv = { known: true, items: Object.entries(stock).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot })) }
  for (const count of plankCounts) inv.items.push({ name: 'minecraft:oak_planks', count, slot: inv.items.length })
  const calls = [], ctx = { getFeet: () => ({ x: 0.5, y: 64, z: 0.5 }), cancelled: () => false, memory: { early: { mine: { branch: { plan } } } }, supplies: { acquire: async (name, count) => { calls.push(['acquire', name, count]) } } }
  const actions = { inventory: () => inv, done: code => ({ status: 'completed', serverConfirmed: true, code }),
    block: p => ({ known: true, name: p.y < 64 ? 'minecraft:chest' : 'minecraft:crafting_table', boundingBox: 'block' }),
    house: { craft: async (name, times) => { calls.push(['craft', name, times]); inv.items.push({ name, count: times * 4, slot: inv.items.length }) }, why: () => null }
  }
  return { plan, calls, supplies: createMineSupplies(ctx, actions, {}) }
}

test('multi-batch ladder sticks reserve two planks per craft before crafting', async () => {
  const f = fixture([2])
  await f.supplies.ensure(f.plan, { layer: 'upper' })
  assert.deepEqual(f.calls, [['acquire', 'planks', 16]])
})

test('split plank stacks satisfy the recipe without an endless acquire-already-held loop', async () => {
  const f = fixture([1, 15])
  await f.supplies.ensure(f.plan, { layer: 'upper' })
  assert.deepEqual(f.calls, [['craft', 'minecraft:stick', 8]])
})

test('supply reserves do not cause a surface round trip after every completed short corridor', async () => {
  const f = fixture([], { ladder: 64, torch: 12, cobblestone_slab: 30, cobblestone: 32 })
  assert.equal((await f.supplies.ensure(f.plan, { layer: 'upper' })).serverConfirmed, true)
  assert.deepEqual(f.calls, [])
})

test('a first lower-layer request budgets the still-unbuilt upper shaft as well', async () => {
  const f = fixture([], { ladder: 72 })
  const out = await f.supplies.ensure(f.plan, { layer: 'lower' })
  assert.notEqual(out.code, 'MINE_SUPPLIES_READY')
  assert.deepEqual(f.calls, [['acquire', 'planks', 16]])
})
