'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { scoreMeleeWeapon, selectMeleeWeapon } = require('../src/melee-weapons')
const proof = require('./fixtures/melee-tool-ground-damage.json')
const copy = value => structuredClone(value)
const rows = new Map(proof.rows.map(row => [row.item, row]))
function selection (names, selectedSlot = 0, alter = () => {}) {
  const raw = new Map(), items = names.map((name, slot) => {
    const row = rows.get('minecraft:' + name)
    assert.ok(row, name + ' must have its own observed ground damage row')
    raw.set(slot, copy(row.rawItem))
    return { slot, name: row.item, count: row.rawItem.count, stackId: row.rawItem.stack_id }
  })
  alter(items, raw)
  return selectMeleeWeapon({ items, selectedSlot, rawItem: slot => raw.get(slot) ?? copy(proof.emptyRawItem) })
}

test('every independently measured Bedrock tool defeats the actual empty-hand regression using its original server raw stack', () => {
  const tools = proof.rows.filter(row => /_(?:pickaxe|shovel|hoe)$/.test(row.item))
  assert.equal(tools.length, 21)
  for (const row of tools) {
    const choice = selection([row.item.replace('minecraft:', '')])
    assert.equal(choice.name, row.item)
    assert.equal(choice.damage, row.damage)
    assert.equal(choice.damageKnown, true)
    assert.equal(choice.fists, false)
    assert.deepEqual(choice.raw, row.rawItem)
  }
})

test('actual netherite pickaxe and hoe outscore the actual stone-sword control by normal Bedrock damage', () => {
  for (const tool of ['netherite_pickaxe', 'netherite_hoe']) {
    const chosen = selection(['stone_sword', tool])
    assert.equal(chosen.name, 'minecraft:' + tool)
    assert.equal(chosen.damage, 7)
    assert.equal(chosen.slot, 1)
  }
  assert.equal(selection(['diamond_shovel', 'stone_sword']).name, 'minecraft:stone_sword')
})

test('Bedrock pickaxe, shovel and hoe family differences use observed per-hit totals, including copper and gold', () => {
  for (const [names, expected] of [
    [['wooden_hoe', 'stone_pickaxe'], 'stone_pickaxe'],
    [['stone_shovel', 'stone_hoe'], 'stone_hoe'],
    [['copper_shovel', 'copper_hoe'], 'copper_hoe'],
    [['golden_shovel', 'golden_pickaxe'], 'golden_pickaxe'],
    [['wooden_pickaxe', 'diamond_shovel'], 'diamond_shovel']
  ]) assert.equal(selection(names).name, 'minecraft:' + expected)
  assert.equal(selection(['stone_pickaxe', 'stone_hoe'], 1).name, 'minecraft:stone_hoe', 'Equal observed damage retains the actual selected-slot tie break')
})

test('tool wear and raw metadata never replace the observed normal attack damage or forge raw stack identity', () => {
  for (const row of proof.rows.filter(row => /_(?:pickaxe|shovel|hoe)$/.test(row.item))) {
    assert.equal(row.afterItem?.network_id, row.rawItem.network_id)
    assert.ok(row.afterItem?.has_stack_id && row.afterItem.stack_id > 0, 'A received durability update may legitimately allocate a new stack ID')
    assert.equal(scoreMeleeWeapon({ name: row.item, count: row.afterItem.count, stackId: row.afterItem.stack_id }, row.afterItem).damage, row.damage)
  }
  const mismatch = selection(['netherite_pickaxe'], 0, items => { items[0].stackId++ })
  assert.equal(mismatch.name, 'minecraft:air')
  assert.equal(mismatch.damage, 1)
  assert.equal(mismatch.unknownCandidates[0].source, 'unconfirmed_stack')
})
