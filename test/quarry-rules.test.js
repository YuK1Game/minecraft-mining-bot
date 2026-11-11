'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { blockRule, selectTool, reserveUses } = require('../src/quarry-rules')
const { canAccept, keepPlan } = require('../src/quarry-inventory')

const tool = (slot, name, remaining, enchantments = []) => ({ slot, name: `minecraft:${name}`, count: 1, durabilityKnown: true, durabilityRemaining: remaining, enchantments })

test('harvest rules: required tool and tier are separate from breakability', () => {
  assert.equal(blockRule('minecraft:iron_ore').ore, true)
  assert.equal(blockRule('minecraft:diamond_ore').ore, true)
  assert.equal(blockRule('minecraft:obsidian').tier, 4)
  assert.equal(blockRule('minecraft:dirt').needs, null)
  assert.equal(blockRule('minecraft:gravel').gravity, true)
  assert.equal(blockRule('minecraft:chest').kind, 'protected')
  assert.equal(blockRule('minecraft:suspicious_sand').reason, 'SUSPICIOUS_BLOCK')
  assert.equal(blockRule('minecraft:glass').kind, 'protected')
  assert.equal(blockRule('minecraft:modded_thing').kind, 'unknown')
  assert.equal(blockRule('minecraft:water').kind, 'fluid')
})

test('T03 registered ores require a sufficient pickaxe tier; ordinary hard stone too', () => {
  assert.equal(selectTool(blockRule('minecraft:iron_ore'), [tool(0, 'wooden_pickaxe', 50)]).reason, 'WAITING_FOR_TOOL')
  assert.equal(selectTool(blockRule('minecraft:obsidian'), [tool(0, 'wooden_pickaxe', 50)]).reason, 'WAITING_FOR_TOOL')
  assert.equal(selectTool(blockRule('minecraft:dirt'), [tool(0, 'wooden_pickaxe', 50)]).kind, 'hand')
})

test('T04 fortune and silk ore policies select the expected pickaxe; stone keeps its normal policy', () => {
  const tools = [tool(0, 'iron_pickaxe', 200), tool(1, 'diamond_pickaxe', 1000, [{ name: 'silk_touch', level: 1 }]), tool(2, 'diamond_pickaxe', 1000, [{ name: 'fortune', level: 3 }])]
  assert.equal(selectTool(blockRule('minecraft:diamond_ore'), tools).slot, 2)
  assert.equal(selectTool(blockRule('minecraft:diamond_ore'), tools.slice(0, 2), { orePolicy: 'preserve_ore' }).slot, 1)
  assert.equal(selectTool(blockRule('minecraft:stone'), tools).slot, 0)
  assert.equal(selectTool(blockRule('minecraft:stone'), tools, { buildingBlockPolicy: 'preserve_blocks' }).slot, 1)
})

test('T05 reserve: default one remaining use, with explicit larger reservations preserved', () => {
  assert.equal(reserveUses(59), 1); assert.equal(reserveUses(131), 1); assert.equal(reserveUses(1561), 1); assert.equal(reserveUses(59, { returnUses: 10 }), 10)
  assert.equal(reserveUses(1561, { reserveMinUses: 8, reserveFraction: 0.1 }), 157)
  assert.equal(selectTool(blockRule('minecraft:stone'), [tool(0, 'stone_pickaxe', 1)]).reason, 'TOOL_DURABILITY_RESERVE')
  assert.equal(selectTool(blockRule('minecraft:stone'), [tool(0, 'stone_pickaxe', 2)]).ok, true)
  assert.equal(selectTool(blockRule('minecraft:stone'), [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: false }]).reason, 'TOOL_DURABILITY_UNKNOWN')
})

test('T06 capacity counts stack room, not just free slots; enchanted items never stack', () => {
  const full = Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'minecraft:cobblestone', count: slot === 5 ? 63 : 64 }))
  assert.equal(canAccept(full, [{ name: 'cobblestone', count: 1 }]), true)
  assert.equal(canAccept(full, [{ name: 'cobblestone', count: 2 }]), false)
  assert.equal(canAccept(full, [{ name: 'dirt', count: 1 }]), false)
  const keep = keepPlan([tool(0, 'iron_pickaxe', 100), { slot: 1, name: 'minecraft:bread', count: 5 }, { slot: 2, name: 'minecraft:cobblestone', count: 64 }, { slot: 3, name: 'minecraft:raw_iron', count: 3 }])
  assert.deepEqual(keep.deposits, [{ slot: 2, name: 'minecraft:cobblestone', count: 32 }, { slot: 3, name: 'minecraft:raw_iron', count: 3 }])
})
