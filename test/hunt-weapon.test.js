'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { huntWeapon, huntArmed } = require('../src/survival/hunt-weapon')

const raw = { 3: { network_id: 900, count: 2, has_stack_id: true, stack_id: 31 }, 7: { network_id: 901, count: 1, has_stack_id: true, stack_id: 77 } }
const items = [{ slot: 3, name: 'minecraft:rotten_flesh', count: 2, stackId: 31 }, { slot: 7, name: 'minecraft:diamond_sword', count: 1, stackId: 77 }]
const rawItem = slot => raw[slot] ?? { network_id: 0, count: 0, has_stack_id: false }

test('with food in hand, the hunt takes the sword first (live 2026-11-17 03:00 JST: 8 fist hits on a sheep)', async () => {
  assert.equal(huntWeapon({ items, rawItem, selected: 3 }).slot, 7)
  assert.equal(huntWeapon({ items, rawItem, selected: 7 }), null)
  const calls = []
  const out = await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`); return { phase: 'observed' } }, equip: async slot => { calls.push(`equip ${slot}`); return { serverConfirmed: true } }, crafting: { snapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ rawServerSelectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['equip 7', 'hunt 42'])
  assert.equal(out.phase, 'observed')
})

test('a refused switch still hits with what is held', async () => {
  const calls = []
  await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`) }, equip: async () => { throw new Error('busy') }, crafting: { snapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ rawServerSelectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['hunt 42'])
})

test('the received state (host getServerState: `selectedSlot` only) still switches to the sword (live 2026-11-26 12:45 JST)', async () => {
  const calls = []
  await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`); return { phase: 'observed' } }, equip: async slot => { calls.push(`equip ${slot}`); return { phase: 'completed' } }, crafting: { inventorySnapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ selectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['equip 7', 'hunt 42'])
})
