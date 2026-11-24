'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineTools } = require('../src/modes/mining/mine-tools')
const { hasWorkingPick } = require('../src/modes/dragon-supply-kit')

test('mine admission uses iron-or-below tools down to Bedrock last use (0), and guards unknown durability or reserved diamond', async () => {
  for (const remaining of [1, 0]) {
    const usable = [{ name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: true, durabilityRemaining: remaining }]
    assert.equal(hasWorkingPick(usable, 'iron'), true)
    const readyTools = createMineTools(
      { cancelled: () => false, runtime: { raw: () => null }, supplies: { acquire: async () => assert.fail('disposable iron pick is usable until broken') } },
      { inventory: () => ({ known: true, items: usable }), done: (code, evidence) => ({ code, evidence, status: 'completed', serverConfirmed: true }) }
    )
    assert.equal((await readyTools({ request: { resource: 'diamond' } })).serverConfirmed, true)
  }

  {
    const items = [{ name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: false, durabilityRemaining: null }], calls = []
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


test('the early mine uses carried goal diamonds for its next pick rather than replacing iron first', async () => {
  const amount = { name: 'minecraft:diamond', slot: 1, count: 4 }
  const items = [{ name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: false, durabilityRemaining: null }, amount]
  const calls = []
  const ctx = { cancelled: () => false, memory: { stage: 'early', early: { reserveReady: true } },
    runtime: { raw: () => null }, supplies: { acquire: async (...args) => calls.push(args) } }
  const tools = createMineTools(ctx, { inventory: () => ({ known: true, items }) })
  const request = { resource: 'diamond', targetHeld: 3, requester: 'early' }
  await tools({ request })
  amount.count = 2
  await tools({ request })
  assert.deepEqual(calls, [['diamond_pickaxe', 1], ['iron_pickaxe', 2]])
})

test('a remaining deep diamond block chooses a usable pick despite an older iron request', async () => {
  const diamonds = { name: 'minecraft:diamond', slot: 2, count: 4 }
  const items = [
    { name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: false, durabilityRemaining: null },
    { name: 'minecraft:stone_pickaxe', slot: 1, count: 1, durabilityKnown: true, durabilityRemaining: 110 },
    diamonds
  ]
  const calls = []
  const ctx = {
    cancelled: () => false,
    memory: { stage: 'early', early: { reserveReady: true } },
    runtime: { raw: () => null },
    supplies: { acquire: async (...args) => calls.push(args) }
  }
  const tools = createMineTools(ctx, { inventory: () => ({ known: true, items }) })
  const request = { resource: 'raw_iron', targetHeld: 3, requester: 'early' }
  await tools({ request, blockName: 'minecraft:deepslate_diamond_ore' })
  diamonds.count = 2
  await tools({ request, blockName: 'minecraft:deepslate_diamond_ore' })
  items.pop()
  items.pop()
  await tools({ request, blockName: 'minecraft:stone' })
  assert.deepEqual(calls, [['diamond_pickaxe', 1], ['iron_pickaxe', 2], ['stone_pickaxe', 1]])
})
