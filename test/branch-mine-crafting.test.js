'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCrafting } = require('../src/actions/crafting')
const { createHousePorts } = require('../src/modes/house/house-ports')
const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
const item = (network_id, count, stack_id) => ({ network_id, count, stack_id, metadata: 0, has_stack_id: true, block_runtime_id: 0, extra })
const named = name => ({ type: 'valid', descriptor_type: 'name', name: 'minecraft:' + name, metadata: 0, count: 1 })
const plank = () => ({ type: 'valid', descriptor_type: 'item_tag', tag: 'minecraft:planks', metadata: 0, count: 1 })

function fixture (stock) {
  const names = ['oak_planks', 'birch_planks', 'stick', 'coal', 'charcoal', 'torch'], id = name => names.indexOf(name) + 1
  const sent = []
  let crafting
  const client = { queue: (name, params) => {
    if (name === 'interact') queueMicrotask(() => crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' }))
    if (name !== 'item_stack_request') return
    const request = params.requests[0]
    sent.push(request)
    queueMicrotask(() => {
      const changed = new Map()
      for (const action of request.actions.filter(action => action.type_id === 'consume')) {
        const slot = action.source.slot, before = changed.get(slot)?.count ?? crafting.rawItem(slot).count
        changed.set(slot, { slot, count: before - action.count, item_stack_id: 100 + slot })
      }
      const take = request.actions.find(action => action.type_id === 'take')
      changed.set(take.destination.slot, { slot: take.destination.slot, count: take.count, item_stack_id: 200 })
      crafting.applyPacket('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [...changed.values()] }] }] })
    })
  } }
  crafting = createCrafting({ client, getState: () => ({ phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', health: 20 }) })
  crafting.applyPacket('start_game', { server_authoritative_inventory: true })
  crafting.applyPacket('item_registry', { itemstates: names.map(name => ({ name: 'minecraft:' + name, runtime_id: id(name) })) })
  const recipe = (name, network_id, input) => ({ recipe_id: name + network_id, network_id, block: 'crafting_table', width: 1, height: 2, input, output: [{ network_id: id(name), count: 4, metadata: 0, block_runtime_id: 0, extra }] })
  crafting.applyPacket('crafting_data', { clear_recipes: true, shaped_recipes: [recipe('stick', 1, [plank(), plank()]), recipe('torch', 2, [named('coal'), named('stick')]), recipe('torch', 3, [named('charcoal'), named('stick')])] })
  const slots = Array.from({ length: 36 }, empty)
  stock.forEach(([name, count], slot) => { slots[slot] = item(id(name), count, 100 + slot) })
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  const inventory = () => ({ known: crafting.inventorySnapshot().inventoryKnown, items: crafting.inventorySnapshot().inventory })
  const house = createHousePorts({ operations: { crafting }, getInventory: inventory, getBlock: () => ({ known: false }) })
  return { house, crafting, sent, inventory }
}

test('mine batch crafting uses the actual received recipe when plank species cannot fill a large batch', async () => {
  const f = fixture([['oak_planks', 1], ['birch_planks', 15]])
  assert.equal(f.crafting.preview('stick', { times: 8 }).ready, false)
  assert.equal(await f.house.craft('minecraft:stick', 8, null, { fitMaterials: true }), true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].actions[0].times_crafted, 1)
  assert.equal(f.inventory().items.find(i => i.name === 'minecraft:stick').count, 4)
})

test('mine batch torches choose one executable coal variant and credit the server result', async () => {
  const f = fixture([['coal', 3], ['charcoal', 5], ['stick', 8]])
  assert.equal(f.crafting.preview('torch', { times: 8 }).ready, false)
  assert.equal(await f.house.craft('minecraft:torch', 8, null, { fitMaterials: true }), true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].actions[0].times_crafted, 5)
  assert.equal(f.sent[0].actions[0].recipe_network_id, 3)
  assert.equal(f.inventory().items.find(i => i.name === 'minecraft:torch').count, 20)
})
