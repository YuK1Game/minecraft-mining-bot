'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { createFood } = require('../src/food')
const { createInventory } = require('../src/inventory')
const { createCrafting } = require('../src/crafting')

const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const item = (networkId, count, stackId) => ({ ...air(), network_id: networkId, count, has_stack_id: true, stack_id: stackId })

function fixture (t, { foodSlot = 9, afterEquip = result => result } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-04T15:00:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 2, dead: false }, gameMode: 'survival', health: 10, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, selectedSlot: 0 }
  const packets = [], transactions = [], equipment = [], uncertainties = []
  const client = { queue: (name, packet) => packets.push({ name, packet: structuredClone(packet) }) }
  const crafting = createCrafting({ client, getState: () => state })
  crafting.applyPacket('start_game', { server_authoritative_inventory: true })
  crafting.applyPacket('item_registry', { itemstates: [{ runtime_id: 201, name: 'minecraft:stone_sword' }, { runtime_id: 300, name: 'minecraft:baked_potato' }] })
  const slots = Array.from({ length: 36 }, air)
  slots[3] = item(201, 1, 90)
  slots[foodSlot] = item(300, 3, 91)
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  crafting.applyPacket('container_open', { window_id: 2, window_type: 'inventory' })
  const getState = () => ({ ...structuredClone(state), inventory: { known: true, items: crafting.inventorySnapshot().inventory } })
  const onInventory = packet => crafting.applyPacket('inventory_content', packet)
  let inventoryId = -41, foodId = -202, sent = 0, running = false, time = 1000
  const selectionStore = {}
  const inventory = createInventory({ client, getState, crafting, allocateRequestId: () => { const id = inventoryId; inventoryId -= 2; return id }, selectionStore, commitSelection: slot => { state.rawSelectedSlot = slot; state.selectedSlot = slot }, onInventory })
  const input = { start: () => { running = true; sent++ }, stop: () => { running = false }, stats: () => ({ running, sent, target: null }), sendTransaction: (transaction, options) => { transactions.push(structuredClone(transaction)); options.onSent(); sent++ } }
  const food = createFood({ client, getState, crafting, getInput: () => input, equip: async slot => { const result = await inventory.equipForFood(slot); equipment.push(result); return afterEquip(result, { state, crafting }) }, allocateLegacyId: () => { const id = foodId; foodId -= 2; return id }, now: () => time, onInventory, onUncertain: details => uncertainties.push(details) })
  t.after(() => { food.cancel('test cleanup'); inventory.cancel('test cleanup') })
  const observe = (name, packet) => { crafting.applyPacket(name, packet); inventory.applyPacket(name, packet); food.applyPacket(name, packet) }
  observe('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 16 }] })
  const consumeSlot = count => observe('inventory_slot', { window_id: 'inventory', container: null, slot: 3, item: item(300, count, 101 + count) })
  const acknowledge = () => observe('completed_using_item', { used_item_id: 300, use_method: 'eat' })
  const advance = () => { time += 1700; sent += 33; t.mock.timers.tick(1700) }
  return { state, crafting, inventory, food, packets, transactions, equipment, uncertainties, selectionStore, observe, consumeSlot, acknowledge, advance }
}

test('real inventory combat selection followed by two meals accepts preparation but credits only server consumption', async t => {
  const f = fixture(t)
  const combat = await f.inventory.equipForCombat(3)
  assert.equal(combat.selectionSent, true)
  assert.equal(combat.serverConfirmed, false)
  const first = f.food.eat(), firstOutcome = first.then(value => ({ value }), error => ({ error }))
  await nextTurn()
  const transfer = f.packets.find(packet => packet.name === 'item_stack_request').packet.requests[0]
  f.observe('item_stack_response', { responses: [{ request_id: transfer.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 9, count: 1, item_stack_id: 100 }, { slot: 3, count: 3, item_stack_id: 101 }] }] }] })
  await nextTurn()
  assert.equal(f.food.snapshot().phase, 'holding')
  assert.equal(f.equipment[0].serverConfirmed, true, 'the first meal receives a real swap response')
  assert.equal(f.crafting.rawItem(3).count, 3)
  f.consumeSlot(2)
  assert.equal(f.food.snapshot().busy, true, 'a stack decrement alone does not complete consumption')
  f.acknowledge()
  const firstResult = await firstOutcome
  assert.equal(firstResult.error, undefined)
  assert.equal(firstResult.value.serverConfirmed, true)
  assert.equal(firstResult.value.consumed, true)
  assert.ok(f.selectionStore.pending, 'the swap and food receipt do not invent a selected-slot acknowledgement')

  const selectionsBefore = f.packets.filter(packet => packet.name === 'mob_equipment').length
  const second = f.food.eat(), secondOutcome = second.then(value => ({ value }), error => ({ error }))
  await nextTurn()
  assert.equal(f.food.snapshot().phase, 'holding')
  assert.equal(f.equipment[1].selectionSent, true)
  assert.equal(f.equipment[1].serverConfirmed, false)
  assert.equal(f.packets.filter(packet => packet.name === 'mob_equipment').length, selectionsBefore + 1)
  assert.equal(f.crafting.rawItem(3).count, 2)
  f.advance()
  assert.equal(f.food.snapshot().busy, true, 'selection, input and elapsed time are not consumption receipts')
  assert.notEqual(f.food.snapshot().lastResult?.serverConfirmed, true)
  assert.equal(f.crafting.rawItem(3).count, 2)
  f.consumeSlot(1)
  f.acknowledge()
  const secondResult = await secondOutcome
  assert.equal(secondResult.error, undefined)
  assert.equal(secondResult.value.serverConfirmed, true)
  assert.equal(secondResult.value.consumed, true)
  assert.equal(f.crafting.rawItem(3).count, 1)
  assert.deepEqual(f.uncertainties, [])
})

for (const mode of ['connection', 'life', 'dimension', 'self', 'selected', 'stack_id', 'metadata', 'source_slot', 'result_slot', 'not_sent', 'not_completed']) {
  test(`food selection preparation rejects changed ${mode} before use`, async t => {
    const f = fixture(t, { foodSlot: 3, afterEquip: (result, { state, crafting }) => {
      if (mode === 'connection') state.connectionId = 'replacement'
      if (mode === 'life') state.lifecycle.deathId++
      if (mode === 'dimension') state.dimension = 'nether'
      if (mode === 'self') state.runtimeEntityId = '99'
      if (mode === 'selected') state.rawSelectedSlot = 0
      if (mode === 'stack_id' || mode === 'metadata') {
        const raw = crafting.rawItem(3)
        raw[mode]++
        crafting.applyPacket('inventory_slot', { window_id: 'inventory', slot: 3, item: raw })
      }
      if (mode === 'source_slot') return { ...result, sourceSlot: 9 }
      if (mode === 'result_slot') return { ...result, slot: 0 }
      if (mode === 'not_sent') return { ...result, selectionSent: false }
      if (mode === 'not_completed') return { ...result, phase: 'requested' }
      return result
    } })
    await f.inventory.equipForCombat(3)
    await assert.rejects(f.food.eat(), error => ['SESSION_CHANGED', 'EQUIPMENT_NOT_CONFIRMED'].includes(error.code))
    assert.deepEqual(f.transactions, [])
    assert.notEqual(f.food.snapshot().lastResult?.serverConfirmed, true)
    assert.deepEqual(f.uncertainties, [], 'no use input means no uncertain consumption')
  })
}
