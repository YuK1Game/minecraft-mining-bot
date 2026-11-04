'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { scoreMeleeWeapon, selectMeleeWeapon } = require('../src/melee-weapons')
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, extra: { has_nbt: 'false' } })
function item (name, enchantments = [], slot = 0) {
  const raw = { network_id: 300 + slot, count: 1, metadata: 0, has_stack_id: true, stack_id: 100 + slot, extra: { has_nbt: enchantments.length ? 'true' : 'false' } }
  if (enchantments.length) raw.extra.nbt = { version: 1, nbt: { type: 'compound', name: '', value: { ench: { type: 'list', value: { type: 'compound', value: enchantments.map(([id, lvl]) => ({ id: { type: 'short', value: id }, lvl: { type: 'short', value: lvl } })) } } } } }
  return { description: { slot, name: `minecraft:${name}`, count: 1, stackId: raw.stack_id }, raw }
}
const score = (name, ench = [], options) => { const i = item(name, ench); return scoreMeleeWeapon(i.description, i.raw, options) }
function select (specifications, options = {}) { const list = specifications.map(([name, ench], i) => item(name, ench, i)); const bag = new Map(list.map(x => [x.description.slot, x.raw])); return selectMeleeWeapon({ items: list.map(x => x.description), rawItem: slot => bag.get(slot) ?? air(), selectedSlot: 0, ...options }) }

test('normal Bedrock swords beat same-material axes, including copper and no Java axe values', () => {
  for (const [material, sword, axe] of [['wooden', 5, 4], ['golden', 5, 4], ['stone', 6, 5], ['copper', 6, 5], ['iron', 7, 6], ['diamond', 8, 7], ['netherite', 9, 8]]) { assert.equal(score(`${material}_sword`).damage, sword); assert.equal(score(`${material}_axe`).damage, axe) }
  assert.equal(score('trident').damage, 9); assert.equal(score('mace').damage, 7)
  assert.equal(select([['netherite_axe'], ['netherite_sword']]).name, 'minecraft:netherite_sword')
})
test('real Sharpness NBT can make weaker material the strongest proven per-hit weapon', () => {
  const selected = select([['netherite_sword'], ['wooden_sword', [[9, 5]]]])
  assert.equal(selected.name, 'minecraft:wooden_sword'); assert.equal(selected.damage, 11.25); assert.equal(selected.enchantmentBonus, 6.25); assert.equal(selected.damageKnown, true)
})
test('Smite and Bane bonuses apply only to the known eligible target family', () => {
  assert.equal(score('iron_sword', [[10, 5]], { target: { entityType: 'minecraft:drowned' } }).damage, 19.5)
  assert.equal(score('iron_sword', [[10, 5]], { target: { entityType: 'minecraft:creeper' } }).damage, 7)
  assert.equal(score('wooden_sword', [[11, 3]], { target: { entityType: 'minecraft:cave_spider' } }).damage, 12.5)
  assert.equal(score('wooden_sword', [[11, 3]], { target: { entityType: 'minecraft:zombie' } }).damage, 5)
})
test('Impaling uses known wet contact, never a drowned/aquatic type assumption', () => {
  assert.equal(score('trident', [[29, 5]], { target: { entityType: 'minecraft:drowned' }, targetWet: false }).damage, 9)
  assert.equal(score('trident', [[29, 5]], { target: { entityType: 'minecraft:zombie' }, targetWet: true }).damage, 21.5)
  assert.equal(score('iron_sword', [[29, 5]], { targetWet: true }).damage, 7)
})
test('observed custom minecraft:damage is extra damage plus base one; dynamic/unknown components are reported', () => {
  assert.equal(score('custom_blade', [], { components: { 'minecraft:damage': { value: 8 } } }).damage, 9)
  assert.equal(score('custom_blade', [], { components: { 'minecraft:damage': 8 } }).source, 'observed_minecraft_damage_plus_player_base')
  assert.equal(score('custom_blade', [], { components: { 'minecraft:damage': { value: 'query.health' } } }).eligible, false)
  assert.equal(score('custom_blade').source, 'unknown_item_components')
  for (const value of [-1, 32768, NaN]) assert.equal(score('custom_blade', [], { components: { 'minecraft:damage': value } }).eligible, false)
})
test('NBT and raw stack identity, rather than descriptions or item metadata, supply enchantment evidence', () => {
  const i = item('iron_sword'); i.description.enchantments = [{ id: 9, level: 5 }]; i.raw.metadata = 999
  assert.equal(scoreMeleeWeapon(i.description, i.raw).damage, 7)
  i.raw.stack_id++; assert.equal(scoreMeleeWeapon(i.description, i.raw).eligible, false)
  const malformed = item('iron_sword', [[9, 99]])
  const result = scoreMeleeWeapon(malformed.description, malformed.raw); assert.equal(result.damage, 7); assert.equal(result.damageKnown, false); assert.ok(result.warnings.length)
})
test('incompatible damage enchantments are not added together into invented damage', () => {
  const result = score('iron_sword', [[9, 5], [10, 5]], { target: { entityType: 'minecraft:zombie' } })
  assert.equal(result.damage, 7); assert.equal(result.damageKnown, false); assert.ok(result.warnings.includes('incompatible_damage_enchantments'))
})
test('fists fallback is a real known empty hotbar stack and selection is read-only', () => {
  const raw = air(); const before = structuredClone(raw)
  const selected = selectMeleeWeapon({ items: [], rawItem: () => raw, selectedSlot: 3 })
  assert.equal(selected.name, 'minecraft:air'); assert.equal(selected.slot, 3); assert.equal(selected.damage, 1); assert.equal(selected.source, 'observed_empty_hand'); assert.deepEqual(raw, before)
  assert.equal(selectMeleeWeapon({ items: [], rawItem: () => null, selectedSlot: 0 }).ready, false)
})
test('unknown components do not outrank a proven weapon and remain visible to the caller', () => {
  const result = select([['custom_blade'], ['stone_sword']])
  assert.equal(result.name, 'minecraft:stone_sword'); assert.equal(result.unknownCandidates[0].source, 'unknown_item_components')
  const custom = select([['custom_blade'], ['stone_sword']], { getItemComponents: d => d.name.endsWith('custom_blade') ? { 'minecraft:damage': 12 } : null })
  assert.equal(custom.name, 'minecraft:custom_blade'); assert.equal(custom.damage, 13)
})
test('holding known ordinary logs/planks is a legitimate equal-fists fallback with the actual stack', () => {
  for (const name of ['birch_planks', 'oak_log']) { const selected = select([[name]]); assert.equal(selected.name, `minecraft:${name}`); assert.equal(selected.slot, 0); assert.equal(selected.damage, 1); assert.equal(selected.raw.network_id, 300) }
})
