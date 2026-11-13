'use strict'

// Live 2026-11-13: in the full-only v2.2 bag 34 of 36 slots were fixed (21
// cargo boxes, 4 supply boxes, tools, bread, arrows, coal, 64 seal cobblestone)
// while the exit needs 192 dirt (3 slots). The final dirt withdrawal must not
// stop at EXIT_DIRT_WITHDRAW_BLOCKED for want of room.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { egressDirtRoom, freeSlots } = require('../src/quarry-inventory')

const fixed = () => {
  const bag = []
  for (let slot = 0; slot < 21; slot++) bag.push({ slot, name: 'minecraft:purple_shulker_box', count: 1 })
  ;['blue', 'light_blue', 'brown', 'yellow'].forEach((c, i) => bag.push({ slot: 21 + i, name: `minecraft:${c}_shulker_box`, count: 1 }))
  ;['diamond_pickaxe', 'diamond_shovel', 'diamond_sword', 'bow'].forEach((n, i) => bag.push({ slot: 25 + i, name: `minecraft:${n}`, count: 1 }))
  bag.push({ slot: 29, name: 'minecraft:arrow', count: 64 }, { slot: 30, name: 'minecraft:bread', count: 54 }, { slot: 31, name: 'minecraft:coal', count: 4 }, { slot: 32, name: 'minecraft:cobblestone', count: 64 })
  return bag
}
// The exit-preparation keep policy of a v2.2 job (seal, coal and sticks released).
const egressPolicy = { keepExitDirt: 192, keepSealBlocks: 0, keepCoal: 0, keepSticks: 0, keepLogs: 0, keepPlanks: 0 }

test('with too few free slots the bag first stores what the exit does not need', () => {
  const bag = fixed()
  bag.push({ slot: 33, name: 'minecraft:cobbled_deepslate', count: 40 })
  assert.equal(freeSlots(bag), 2)
  const room = egressDirtRoom(bag, { target: 192, keepPolicy: egressPolicy, storageAvailable: true, depositAttempts: 0 })
  assert.equal(room.action, 'deposit')
  assert.deepEqual(room.deposits.map(d => d.name).sort(), ['minecraft:coal', 'minecraft:cobbled_deepslate', 'minecraft:cobblestone'])
})

test('after storing, the full exit reserve fits and is withdrawn unchanged', () => {
  const bag = fixed().filter(i => !['minecraft:coal', 'minecraft:cobblestone'].includes(i.name))
  assert.deepEqual(egressDirtRoom(bag, { target: 192, keepPolicy: egressPolicy, storageAvailable: true, depositAttempts: 1 }), { action: 'restock', target: 192 })
})

test('when storing cannot make room, only the selected column need plus 8 is withdrawn', () => {
  const bag = fixed()
  bag.push({ slot: 33, name: 'minecraft:dirt', count: 10 }, { slot: 34, name: 'minecraft:totem_of_undying', count: 1 })
  // Room: 10 held + 54 on that stack + one free slot = 128.
  const room = egressDirtRoom(bag, { target: 192, keepPolicy: egressPolicy, storageAvailable: true, depositAttempts: 2, planDirt: 110 })
  assert.deepEqual(room, { action: 'restock', target: 118, limited: true })
  const tight = egressDirtRoom(bag, { target: 192, keepPolicy: egressPolicy, storageAvailable: false, planDirt: 170 })
  assert.equal(tight.short, true); assert.equal(tight.target, 10 + 54 + 64)
})

test('a bag that already holds the target needs no room', () => {
  assert.deepEqual(egressDirtRoom([{ slot: 0, name: 'minecraft:dirt', count: 64 }], { target: 64 }), { action: 'restock', target: 64 })
})
