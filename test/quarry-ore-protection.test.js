'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { blockRule, selectTool } = require('../src/quarry-rules')
const { oreDefinition, oreDropRange } = require('../src/quarry-ore')
const { deriveDropGuarantee, checkDropGuarantees } = require('../src/quarry-drop-guarantee')

test('registered overworld and nether ores are diggable, future ore stays protected', () => {
  const examples = ['coal_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_gold_ore', 'lit_redstone_ore', 'lit_deepslate_redstone_ore',
    'lapis_ore', 'deepslate_diamond_ore', 'emerald_ore', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris']
  for (const name of examples) {
    assert.equal(blockRule(name).kind, 'dig', name)
    assert.equal(blockRule(name).ore, true, name)
    assert.equal(blockRule(name).needs, 'pickaxe', name)
    assert.ok(oreDefinition(name), name)
  }
  assert.deepEqual(blockRule('new_future_ore'), { kind: 'protected', reason: 'PROTECTED_ORE' })
  assert.equal(blockRule('chest').kind, 'protected')
})

test('ore mining uses harvest tier and prioritizes Fortune for yield', () => {
  const weak = [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 80 }]
  assert.equal(selectTool(blockRule('diamond_ore'), weak).ok, false)
  const fortune = { slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100, enchantments: [{ name: 'fortune', level: 3 }] }
  const silk = { slot: 1, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100, enchantments: [{ name: 'silk_touch', level: 1 }] }
  const t = [silk, fortune]
  assert.equal(selectTool(blockRule('diamond_ore'), t, { orePolicy: 'maximize_yield' }).slot, 0)
  assert.equal(selectTool(blockRule('diamond_ore'), t, { orePolicy: 'preserve_ore' }).slot, 1)
  assert.equal(selectTool(blockRule('iron_ore'), []).ok, false)
})

test('Fortune ore ranges retain a conservative capacity bound while checking actual drops', () => {
  assert.deepEqual(oreDropRange('deepslate_diamond_ore', { fortune: 3 }), { name: 'diamond', min: 1, max: 4 })
  assert.deepEqual(oreDropRange('lapis_ore', { fortune: 3 }), { name: 'lapis_lazuli', min: 4, max: 36 })
  assert.deepEqual(oreDropRange('lit_redstone_ore', { fortune: 3 }), { name: 'redstone', min: 4, max: 8 })
  assert.deepEqual(oreDropRange('ancient_debris', { fortune: 3 }), { name: 'ancient_debris', min: 1, max: 1 })
  assert.deepEqual(oreDropRange('diamond_ore', { silk: true, fortune: 0 }), { name: 'diamond_ore', min: 1, max: 1 })
  const target = { name: 'minecraft:diamond_ore', position: { x: 0, y: 60, z: 0 } }
  const tool = { kind: 'pickaxe', tier: 4, silk: false, fortune: 3 }
  const rule = deriveDropGuarantee(target, tool)
  assert.equal(rule.ok, true)
  assert.equal(rule.capacityAlternatives[0][0].count, 4)
  assert.equal(checkDropGuarantees([target], tool, {
    beforeItems: [{ slot: 0, name: 'minecraft:diamond', count: 5 }],
    afterItems: [{ slot: 0, name: 'minecraft:diamond', count: 7 }]
  }).ok, true)
  assert.equal(checkDropGuarantees([target], tool, {
    beforeItems: [{ slot: 0, name: 'minecraft:diamond', count: 5 }],
    afterItems: [{ slot: 0, name: 'minecraft:diamond', count: 5 }]
  }).ok, false)
})

test('unharvestable ore with a wrong tool fails drop proof before dispatch', () => {
  const target = { name: 'minecraft:deepslate_diamond_ore', position: { x: 0, y: 60, z: 0 } }
  assert.equal(deriveDropGuarantee(target, { kind: 'hand', tier: 0 }).reason, 'DROP_TOOL_NOT_CONFIRMED')
  assert.equal(deriveDropGuarantee(target, { kind: 'pickaxe', tier: 2 }).reason, 'DROP_TOOL_NOT_CONFIRMED')
  assert.equal(deriveDropGuarantee({ ...target, name: 'future_ore' }, { kind: 'pickaxe', tier: 4 }).reason, 'DROP_TARGET_NOT_DIGGABLE')
})
