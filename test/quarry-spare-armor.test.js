'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { keepPlan, spareArmorStackIds } = require('../src/quarry-inventory')

// Live 2026-11-13: a copper helmet picked up from a mob was kept as gear while
// a diamond helmet was worn, leaving one free bag slot and tiny deposits.
const piece = (slot, name, extra = {}) => ({ slot, known: true, empty: false, name: `minecraft:${name}`, count: 1, stackId: 500 + slot, enchantmentsKnown: true, enchantments: [], displayName: null, lore: [], repairCost: null, ...extra })
const details = (bag, worn = [piece(0, 'diamond_helmet'), piece(1, 'diamond_chestplate')]) => ({ known: true, slots: bag, armor: { known: true, slots: worn } })

test('plain armour worse than the worn piece is cargo; equal, better or unworn pieces stay kept', () => {
  const bag = [piece(9, 'copper_helmet'), piece(10, 'diamond_helmet'), piece(11, 'iron_boots'), piece(12, 'netherite_chestplate'), piece(13, 'leather_chestplate')]
  assert.deepEqual(spareArmorStackIds(details(bag)), [509, 513])
})

test('enchanted, named, unknown or unreceived armour is never classified as spare', () => {
  const bag = [piece(9, 'copper_helmet', { enchantments: [{ name: 'protection', level: 1 }] }), piece(10, 'iron_helmet', { displayName: 'Mine' }), piece(11, 'golden_helmet', { enchantmentsKnown: false }), piece(12, 'chainmail_helmet', { known: false })]
  assert.deepEqual(spareArmorStackIds(details(bag)), [])
  assert.deepEqual(spareArmorStackIds({ known: true, slots: [piece(9, 'copper_helmet')], armor: { known: false, slots: [] } }), [])
  assert.deepEqual(spareArmorStackIds(undefined), [])
})

test('keepPlan deposits only the listed spare armour stack and keeps other gear', () => {
  const items = [{ slot: 9, name: 'minecraft:copper_helmet', count: 1, stackId: 509 }, { slot: 10, name: 'minecraft:iron_boots', count: 1, stackId: 510 }, { slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, stackId: 7 }]
  assert.deepEqual(keepPlan(items).deposits, [])
  assert.deepEqual(keepPlan(items, { cargoStackIds: [509, 7] }).deposits, [{ slot: 9, name: 'minecraft:copper_helmet', count: 1 }])
})
