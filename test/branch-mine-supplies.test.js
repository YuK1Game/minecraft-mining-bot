'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createMineSupplies } = require('../src/modes/mining/mine-supplies')

function fixture (plankCounts, extra = {}, storage = {}) {
  const plan = createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const stock = { torch: 32, cobblestone_slab: 64, cobblestone: 64, ladder: 0, stick: 0, ...extra }
  const inv = { known: true, items: Object.entries(stock).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot })) }
  for (const count of plankCounts) inv.items.push({ name: 'minecraft:oak_planks', count, slot: inv.items.length })
  const calls = [], ctx = { getFeet: () => ({ x: 0.5, y: 64, z: 0.5 }), cancelled: () => false, memory: { early: { mine: { branch: { plan } } } }, supplies: { acquire: async (name, count) => { calls.push(['acquire', name, count]) } } }
  const actions = { inventory: () => inv, done: code => ({ status: 'completed', serverConfirmed: true, code }),
    block: p => {
      if (p.y === 64 && p.x === 3 && p.z === 0) return { known: true, name: 'minecraft:crafting_table', boundingBox: 'block' }
      if (p.y < 64) return { known: true, name: 'minecraft:chest', boundingBox: 'block' }
      if (p.x === 1 && p.z === 0 && p.y <= 65) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
      return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    },
    walk: async () => { calls.push(['walk to workbench']); return { status: 'blocked' } },
    house: { craft: async (name, times) => { calls.push(['craft', name, times]); inv.items.push({ name, count: times * 4, slot: inv.items.length }) }, why: () => null }
  }
  return { plan, calls, inv, ctx, branch: ctx.memory.early.mine.branch, supplies: createMineSupplies(ctx, actions, storage) }
}

test('multi-batch ladder sticks reserve two planks per craft before crafting', async () => {
  const f = fixture([2])
  await f.supplies.ensure(f.plan, { layer: 'upper' })
  assert.deepEqual(f.calls, [['acquire', 'planks', 16]])
})

test('a full inventory makes the largest confirmed partial stick batch before seeking more planks', async () => {
  const f = fixture([4, 4, 1], { ladder: 1, stick: 18 })
  for (let slot = f.inv.items.length; slot < 36; slot++) f.inv.items.push({ slot, name: 'minecraft:torch', count: 1 })
  const checked = []
  f.ctx.operations = { crafting: { preview: (output, { times }) => {
    assert.equal(output, 'minecraft:stick')
    checked.push(times)
    return { ready: times === 3 }
  } } }
  await f.supplies.ensure(f.plan, { layer: 'upper' })
  assert.deepEqual(checked, [4, 3])
  assert.deepEqual(f.calls, [['craft', 'minecraft:stick', 3]])
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

test('a started cobblestone refill keeps its target until confirmed inventory reaches it', async () => {
  const f = fixture([], { ladder: 64, cobblestone: 31 })
  f.branch.shaft = { depth: f.plan.shaft.topY - 2, landings: {} }
  const stack = f.inv.items.find(item => item.name === 'minecraft:cobblestone')
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_IN_PROGRESS')
  stack.count = 32
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_IN_PROGRESS')
  stack.count = 64
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_READY')
  stack.count = 60
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_READY')
  assert.deepEqual(f.calls, [['acquire', 'cobblestone', 64], ['acquire', 'cobblestone', 64]])
})

test('a confirmed home withdrawal has to finish the remaining preparation before construction', async () => {
  const f = fixture([], { ladder: 0 }, { takeHome: async target => {
    assert.ok(target.ladder > 24)
    return { status: 'completed', code: 'KIT_TAKEN', evidence: { serverConfirmed: true }, progress: { confirmedTransferred: 24 } }
  } })
  const result = await f.supplies.ensure(f.plan, { layer: 'lower' })
  assert.equal(result.code, 'MINE_HOME_SUPPLIES_RECEIVED')
  assert.equal(result.status, 'blocked')
  assert.deepEqual(f.calls, [])
})

test('confirmed partial fuel is used for torches before another gathering trip', async () => {
  const f = fixture([], { torch: 7, charcoal: 3, stick: 9 })
  const marks = []
  f.ctx.goal = { mark: (...args) => { marks.push(args) } }
  const result = await f.supplies.ensure(f.plan, { layer: 'lower' })
  assert.deepEqual(f.calls, [['craft', 'minecraft:torch', 3]])
  assert.equal(result.code, 'MINE_SUPPLIES_CRAFTED')
  assert.equal(f.branch.refillTorches, true)
  assert.deepEqual(marks, [['mine:torch-refill', -7, 1], ['mine:torch-refill', -19, 1]])
})

test('initial preparation can proceed once the construction reserve is met', async () => {
  const f = fixture([], { ladder: 64, cobblestone: 31 })
  const stack = f.inv.items.find(item => item.name === 'minecraft:cobblestone')
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_IN_PROGRESS')
  stack.count = 32
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_SUPPLIES_READY')
  assert.deepEqual(f.calls, [['acquire', 'cobblestone', 64]])
})

test('a first lower-layer request budgets the still-unbuilt upper shaft as well', async () => {
  const f = fixture([], { ladder: 72 })
  const out = await f.supplies.ensure(f.plan, { layer: 'lower' })
  assert.notEqual(out.code, 'MINE_SUPPLIES_READY')
  assert.deepEqual(f.calls, [['acquire', 'planks', 16]])
})


test('a lower-layer trip budgets both unfinished rooms and excludes already received upper chests', () => {
  const { supplyNeeds } = require('../src/modes/mining/mine-needs')
  const f = fixture([], { chest: 4 })
  const [upper, lower] = f.plan.storage.map(room => room.pairs.flatMap(pair => pair.positions))
  const empty = () => ({ known: true, name: 'minecraft:air' })
  assert.equal(supplyNeeds(f.plan, 'lower', { inventory: f.inv, getBlock: empty }).chest, upper.length + lower.length)
  assert.equal(supplyNeeds(f.plan, 'upper', { inventory: f.inv, getBlock: empty }).chest, upper.length)
  const upperStanding = p => upper.some(cell => cell.x === p.x && cell.y === p.y && cell.z === p.z)
    ? { known: true, name: 'minecraft:chest' } : empty()
  assert.equal(supplyNeeds(f.plan, 'lower', { inventory: f.inv, getBlock: upperStanding }).chest, lower.length)
})


test('carried cobbled deepslate counts for supports while slab crafting still asks for ordinary cobblestone', async () => {
  const { supplyNeeds } = require('../src/modes/mining/mine-needs')
  const stocked = fixture([], { cobblestone: 29, cobbled_deepslate: 35 })
  const block = () => ({ known: true, name: 'minecraft:stone' })
  const needs = supplyNeeds(stocked.plan, 'lower', { inventory: stocked.inv, getBlock: block, refillCobblestone: true })
  assert.equal(needs.cobbled_deepslate, 35)
  assert.equal(needs.cobblestone, 29)

  const slabs = fixture([], { ladder: 64, cobblestone: 0, cobbled_deepslate: 64, cobblestone_slab: 0 })
  assert.equal((await slabs.supplies.ensure(slabs.plan)).code, 'MINE_SUPPLIES_IN_PROGRESS')
  assert.deepEqual(slabs.calls, [['acquire', 'cobblestone', 24]])
})


test('a received final rung removes the ladder reserve from an unfinished landing', () => {
  const { supplyNeeds } = require('../src/modes/mining/mine-needs')
  const f = fixture([], { ladder: 3 })
  const { ladder, bottomY, topY } = f.plan.shaft
  const received = missing => p => p.x === ladder.x && p.z === ladder.z && p.y >= bottomY && p.y <= topY && p.y !== missing
    ? { known: true, name: 'minecraft:ladder' } : { known: true, name: 'minecraft:stone' }
  assert.equal(supplyNeeds(f.plan, 'lower', { inventory: f.inv, getBlock: received(bottomY) }).ladder, 2)
  assert.equal(supplyNeeds(f.plan, 'lower', { inventory: f.inv, getBlock: received(null) }).ladder, 0)
})
