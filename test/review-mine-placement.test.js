'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/actions/interactions')

function fixture (item = 'minecraft:ladder') {
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const raw = new Map(Array.from({ length: 36 }, (_, slot) => [slot, empty()]))
  raw.set(0, { network_id: 900, count: 8, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra })
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, position: { x: 1.5, y: 66.62, z: 0.5 }, selectedSlot: 0, inventory: { known: true } }
  const block = (name, properties = {}) => ({ known: true, name, runtimeId: 20, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', properties, extra: [] })
  const blocks = new Map([['0,65,1', block('minecraft:stone')]])
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? block('minecraft:air') }
  const crafting = { applyPacket () {}, rawItem: slot => structuredClone(raw.get(slot)), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [{ slot: 0, name: item, count: raw.get(0).count, stackId: 92 }] }) }
  let running = false, transaction
  const input = { stats: () => ({ running, target: null }), lookAt: () => ({ yaw: 0, pitch: 0 }), start: () => { running = true }, stop: () => { running = false }, sendTransaction: (value, callbacks) => { transaction = { value, callbacks } } }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world, crafting, getInput: () => input })
  const options = { position: { x: 0, y: 65, z: 0 }, clicked: { x: 0, y: 65, z: 1 }, slot: 0, face: 2, clickY: item.endsWith('slab') ? 0.25 : 0.5 }
  const sent = () => transaction.callbacks.onSent()
  const receipt = (properties, consume = true, support = null) => {
    blocks.set('0,65,0', block(item, properties))
    if (consume) raw.get(0).count = 7
    if (support) blocks.set('0,65,1', support)
    interactions.applyPacket('update_block', { position: options.position })
    interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: raw.get(0) })
  }
  const receiveAll = () => interactions.applyPacket('inventory_content', {
    window_id: 'inventory', input: Array.from({ length: 36 }, (_, slot) => structuredClone(raw.get(slot)))
  })
  return { interactions, options, raw, state, blocks, receipt, sent, block, receiveAll }
}

test('ladder placement requires received facing, stable supporting wall and real consumption together', async () => {
  const f = fixture()
  assert.equal(f.interactions.previewHouseBlock(f.options).ready, true)
  let completed = false
  const pending = f.interactions.placeHouseBlock(f.options).then(value => { completed = true; return value })
  f.sent()
  f.receipt({ facing_direction: 3 })
  await Promise.resolve()
  assert.equal(completed, false, 'a wrong-facing ladder cannot confirm the planned connection')
  f.raw.get(0).count = 8
  f.receipt({ facing_direction: 2 }, false)
  await Promise.resolve()
  assert.equal(completed, false, 'the block alone is not the consumption receipt')
  f.raw.get(0).stack_id = 99
  f.receipt({ facing_direction: 2 })
  await Promise.resolve()
  assert.equal(completed, false, 'a substituted stack does not prove source consumption')
  f.raw.get(0).stack_id = 92
  f.receipt({ facing_direction: 2 })
  const result = await pending
  assert.equal(result.phase, 'completed')
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
})

test('ladder cannot be placed on a top face, a slab, an unknown wall or from uncertain inventory', () => {
  const f = fixture()
  assert.equal(f.interactions.previewHouseBlock({ ...f.options, clicked: { x: 0, y: 64, z: 0 }, face: 1 }).ready, false)
  for (const wall of [f.block('minecraft:cobblestone_slab', { 'minecraft:vertical_half': 'bottom' }), { known: false }]) {
    f.blocks.set('0,65,1', wall)
    assert.equal(f.interactions.previewHouseBlock(f.options).ready, false)
  }
  f.blocks.set('0,65,1', f.block('minecraft:stone')); f.state.inventory.uncertain = true
  assert.equal(f.interactions.previewHouseBlock(f.options).ready, false)
})

test('a removed support wall prevents confirmation after the block and inventory arrive', async () => {
  const f = fixture()
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent(); f.receipt({ facing_direction: 2 }, true, f.block('minecraft:air'))
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.interactions.cancel('wall changed')
  await assert.rejects(pending, /wall changed/)
})

test('cobblestone slab accepts only a lower-half plan and received lower-half state', async () => {
  const f = fixture('minecraft:cobblestone_slab')
  assert.equal(f.interactions.previewHouseBlock({ ...f.options, clickY: 0.75 }).ready, false)
  assert.equal(f.interactions.previewHouseBlock(f.options).ready, true)
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent(); f.receipt({ 'minecraft:vertical_half': 'top' })
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.receipt({ 'minecraft:vertical_half': 'bottom' })
  const result = await pending
  assert.equal(result.phase, 'completed')
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
})

test('confidence loss after a sent mine placement cannot produce success', async () => {
  const f = fixture()
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent(); f.state.inventory.uncertain = true; f.receipt({ facing_direction: 2 })
  await assert.rejects(pending, /持ち物が不明/)
})


test('a full server receipt can confirm a renumbered ladder stack before the block receipt', async () => {
  const f = fixture()
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent()
  f.raw.get(0).count = 7
  f.raw.get(0).stack_id = 101
  f.receiveAll()
  assert.equal(f.interactions.snapshot().pendingOperation, 'place', 'wait for the actual correctly facing block')
  f.receipt({ facing_direction: 2 }, false)
  const result = await pending
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
  assert.ok(result.placementObservation.sourceObservedAt <= result.placementObservation.blockObservedAt)
})

test('a renumbered source stack does not confirm when the missing item moved to another slot', async () => {
  const f = fixture()
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent()
  f.raw.get(0).count = 7
  f.raw.get(0).stack_id = 101
  f.raw.set(5, { ...f.raw.get(0), count: 1, stack_id: 102 })
  f.receiveAll()
  f.receipt({ facing_direction: 2 }, false)
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.interactions.cancel('no net consumption')
  await assert.rejects(pending, /no net consumption/)
})


test('cobbled deepslate uses the ordinary visible support face and placement receipts', async () => {
  const f = fixture('minecraft:cobbled_deepslate')
  assert.equal(f.interactions.previewHouseBlock(f.options).ready, true)
  const pending = f.interactions.placeHouseBlock(f.options)
  f.sent()
  f.receipt({})
  const result = await pending
  assert.equal(result.blockName, 'minecraft:cobbled_deepslate')
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
})
