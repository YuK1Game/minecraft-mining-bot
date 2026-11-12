'use strict'

// Live 2026-11-12 23:28: 34 of 36 slots were fixed items (22 cargo boxes,
// 4 supply boxes, 4 tools, arrows, bread, 64 dirt, 3 sticks). In the v2.2
// carried mode the work dirt and sticks are no longer held in hand.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { keepPlan } = require('../src/quarry-inventory')
const { supplyNeeds } = require('../src/quarry-supplies')

const bag = [
  { slot: 0, name: 'minecraft:dirt', count: 64 },
  { slot: 11, name: 'minecraft:cobblestone', count: 15 },
  { slot: 34, name: 'minecraft:stick', count: 3 }
]

test('without seal dirt and with no kept sticks, the dirt and sticks are deposited and cobblestone stays as seal material', () => {
  const plan = keepPlan(bag, { keepSealBlocks: 64, keepExitDirt: 0, sealDirt: false, keepSticks: 0 })
  assert.deepEqual(plan.deposits.map(d => [d.name, d.count]), [['minecraft:dirt', 64], ['minecraft:stick', 3]])
  assert.equal(plan.keep.get(11), 15)
})

test('the default and the exit reserve still keep dirt', () => {
  assert.equal(keepPlan(bag, { keepSealBlocks: 64 }).keep.get(0), 64, 'default: dirt is seal material up to the limit')
  assert.equal(keepPlan(bag, { keepSealBlocks: 64, keepExitDirt: 192, sealDirt: false }).keep.get(0), 64, 'the exit reserve is kept')
})

test('v2.2 work dirt target: none is restocked by default; a seal demand asks for it from the supply box', () => {
  const base = { supplyLayout: 'v22', deferExitSupplies: true, keepExitDirt: 0, keepSealBlocks: 64 }
  const empty = [{ slot: 1, name: 'minecraft:diamond_pickaxe', count: 1 }]
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 0 }).required.dirt, false)
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 32 }).required.dirt, true)
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 32 }).desired.dirt, 32)
  assert.equal(supplyNeeds(empty, base).desired.dirt, 64, 'unchanged default')
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 0, exitPreparing: true, exitDirtTarget: 192 }).desired.dirt, 192, 'the exit still takes its dirt')
})
