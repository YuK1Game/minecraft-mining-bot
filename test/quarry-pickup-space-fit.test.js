'use strict'

// Live 2026-11-12 22:30: a make-room pickup of "mergeable" cobblestone
// overflowed into a new stack and took the slot the storage box needed.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { dropsFittingStacks, freeSlots } = require('../src/quarry-inventory')

const stack = (slot, name, count) => ({ slot, name, count })
const fullBag = rows => { const bag = rows.slice(); for (let slot = 0; slot < 36; slot++) if (!bag.some(i => i.slot === slot)) bag.push(stack(slot, 'minecraft:dirt', 64)); return bag }

test('drops are taken only up to the room of existing stacks, never into a free slot', () => {
  const items = fullBag([stack(6, 'minecraft:cobblestone', 53)]).filter(i => i.slot !== 35)
  assert.equal(freeSlots(items), 1)
  const drops = [{ runtimeId: '1', name: 'minecraft:cobblestone', count: 6 }, { runtimeId: '2', name: 'minecraft:cobblestone', count: 6 }, { runtimeId: '3', name: 'minecraft:egg', count: 1 }, { runtimeId: '4', name: 'minecraft:cobblestone', count: 4 }]
  const fitting = dropsFittingStacks(items, drops)
  assert.deepEqual(fitting.map(d => d.runtimeId), ['1', '4'], '11 room: 6 then 4 fit; the second 6 and the egg would need the free slot')
})

test('no existing room means nothing is collected; malformed drops are skipped', () => {
  const items = fullBag([stack(6, 'minecraft:cobblestone', 64)]).filter(i => i.slot !== 35)
  assert.deepEqual(dropsFittingStacks(items, [{ runtimeId: '1', name: 'minecraft:cobblestone', count: 1 }, { runtimeId: '2', name: 'minecraft:cobblestone' }, null]), [])
})

test('live case 2026-11-12: with keepFree 1, drops may open new stacks but one slot always stays empty for the box', () => {
  const items = fullBag([stack(6, 'minecraft:cobblestone', 64)]).filter(i => i.slot !== 35 && i.slot !== 34 && i.slot !== 33)
  assert.equal(freeSlots(items), 3)
  const drops = [{ runtimeId: '1', name: 'minecraft:cobblestone', count: 4 }, { runtimeId: '2', name: 'minecraft:egg', count: 1 }, { runtimeId: '3', name: 'minecraft:granite', count: 1 }, { runtimeId: '4', name: 'minecraft:cobblestone', count: 2 }]
  const fitting = dropsFittingStacks(items, drops, { keepFree: 1 })
  assert.deepEqual(fitting.map(d => d.runtimeId), ['1', '2', '4'], 'cobblestone opens one stack (4+2), the egg a second; granite would take the last slot')
  assert.deepEqual(dropsFittingStacks(items.slice(0, -2).concat([]), [], { keepFree: 1 }), [])
  const one = fullBag([]).filter(i => i.slot !== 35)
  assert.deepEqual(dropsFittingStacks(one, drops, { keepFree: 1 }), [], 'only the box slot is free: nothing is collected')
})
