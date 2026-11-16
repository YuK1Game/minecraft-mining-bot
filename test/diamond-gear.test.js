'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { nextGear } = require('../src/survival/diamond-gear')

const item = (name, count = 1) => ({ name: `minecraft:${name}`, count })
const worn = (...names) => ({ known: true, worn: ['head', 'chest', 'legs', 'feet'].map((piece, index) => ({ piece, name: names[index] ? `minecraft:${names[index]}` : null })) })

test('diamond gear is made in order, each piece once, when enough diamonds are held', () => {
  assert.equal(nextGear({ items: [item('diamond', 2)], worn: worn(), diamonds: 2 }), null, 'a pickaxe needs 3')
  assert.equal(nextGear({ items: [item('diamond', 18)], worn: worn(), diamonds: 18 }).output, 'diamond_pickaxe')
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond', 15)], worn: worn(), diamonds: 15 }).output, 'diamond_sword')
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond_sword')], worn: worn(), diamonds: 13 }).output, 'diamond_chestplate')
  // A worn chestplate is owned; the leggings come next and wait for 7.
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond_sword')], worn: worn(null, 'diamond_chestplate'), diamonds: 5 }), null)
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond_sword')], worn: worn(null, 'diamond_chestplate'), diamonds: 7 }).output, 'diamond_leggings')
  assert.equal(nextGear({ items: [item('netherite_pickaxe'), item('diamond_sword')], worn: worn('diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'), diamonds: 40 }), null)
})

test('armor is not made while the worn armor is not received', () => {
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond_sword')], worn: null, diamonds: 20 }), null)
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), item('diamond_sword')], worn: { known: false, worn: [] }, diamonds: 20 }), null)
  assert.equal(nextGear({ items: [], worn: null, diamonds: 3 }).output, 'diamond_pickaxe', 'tools do not need the worn armor')
})

test('a second diamond pickaxe is made once the held one is worn below 300 uses', () => {
  const pick = used => ({ ...item('diamond_pickaxe'), maxDurability: 1561, durabilityUsed: used })
  const all = [item('diamond_sword')]
  const armor = worn('diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots')
  assert.equal(nextGear({ items: [pick(1261), ...all], worn: armor, diamonds: 75 }), null, '300 uses left still counts')
  assert.equal(nextGear({ items: [pick(1402), ...all], worn: armor, diamonds: 75 }).output, 'diamond_pickaxe', '159 uses left')
  assert.equal(nextGear({ items: [pick(1402), pick(0), ...all], worn: armor, diamonds: 72 }), null, 'a fresh spare is held')
  assert.equal(nextGear({ items: [item('diamond_pickaxe'), ...all], worn: armor, diamonds: 75 }), null, 'unknown wear is not worn')
  assert.equal(nextGear({ items: [{ ...item('diamond_pickaxe'), durabilityUsed: 1400 }, ...all], worn: armor, diamonds: 75 }).output, 'diamond_pickaxe', 'the registry maximum is used when the item has none')
})
