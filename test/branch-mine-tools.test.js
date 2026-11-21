'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineTools } = require('../src/modes/mining/mine-tools')
const { hasWorkingPick } = require('../src/modes/dragon-supply-kit')

test('mine admission agrees with the actual hand at the two-use and unknown-durability boundaries', async () => {
  for (const remaining of [2, null]) {
    const items = [{ name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: remaining != null, durabilityRemaining: remaining }], calls = []
    assert.equal(hasWorkingPick(items, 'iron'), true)
    const ctx = { cancelled: () => false, runtime: { raw: () => null }, supplies: { acquire: async (...args) => calls.push(args) } }
    const tools = createMineTools(ctx, { inventory: () => ({ known: true, items }) })
    const result = await tools({ request: { resource: 'diamond' } })
    assert.equal(result.code, 'MINE_TOOL_SUPPLY')
    assert.deepEqual(calls, [['iron_pickaxe', 2]])
  }
})

test('received usable higher-tier tools satisfy a lower-tier mine without making a duplicate', async () => {
  const items = [{ name: 'minecraft:diamond_pickaxe', slot: 0, count: 1, durabilityKnown: true, durabilityRemaining: 3 }]
  const ctx = { cancelled: () => false, supplies: { acquire: async () => assert.fail('already has a usable tool') } }
  const tools = createMineTools(ctx, { inventory: () => ({ known: true, items }), done: (code, evidence) => ({ code, evidence, status: 'completed', serverConfirmed: true }) })
  assert.equal((await tools({ request: { resource: 'raw_iron' } })).serverConfirmed, true)
})
