'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/interactions')
const { createMining } = require('../src/mining')

function fixture (t) {
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const raw = Array.from({ length: 36 }, empty)
  raw[0] = { ...empty(), network_id: 421, count: 1, metadata: 14, has_stack_id: true, stack_id: 9 }
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', profile: 'bed', realm: { id: '42' }, connectionId: 'socket', startedAt: 'life', runtimeEntityId: '41', lifecycle: { deathId: 0 }, dimension: 'overworld', selectedSlot: 0, rawSelectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:bed', count: 1, metadata: 14, networkId: 421 }] } }
  const blocks = new Map(), target = { x: 2, y: 65, z: 0 }
  const getBlock = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:grass_block' : 'minecraft:air', runtimeId: y < 65 ? 2 : 0, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }
  const put = (position, name, properties = {}, runtimeId = 18895) => blocks.set(`${position.x},${position.y},${position.z}`, { known: true, position: { ...position }, name, properties, runtimeId, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] })
  const packets = [], transactions = [], actions = []; let running = false
  const input = { stats: () => ({ running, target: null }), lookAt () {}, start: () => { running = true }, stop: () => { running = false }, sendAction: (...args) => actions.push(args), sendTransaction: (packet, options) => { transactions.push(structuredClone(packet)); options?.onSent?.() } }
  const crafting = { rawItem: slot => structuredClone(raw[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: state.inventory.items.map(item => ({ ...item, stackId: 9 })) }), applyPacket () {} }
  const world = { getBlock }
  const interactions = createInteractions({ client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: () => state, world, crafting, getInput: () => input, timeoutMs: 1000 })
  t.after(() => interactions.cancel('Test cleanup'))
  return { state, raw, empty, blocks, target, getBlock, put, world, input, packets, transactions, actions, interactions }
}

test('bed placement is explicit, validates received colour/head space, and normal completion still requires block plus real item spend', async t => {
  const f = fixture(t), options = { position: f.target, slot: 0 }
  assert.equal(f.interactions.previewPlace(options).ready, false, 'generic automatic placement does not silently gain bed capability')
  assert.equal(f.interactions.previewPlaceBed(options).ready, true)
  f.raw[0].metadata = 0
  assert.equal(f.interactions.previewPlaceBed(options).ready, false)
  f.raw[0].metadata = 14
  f.blocks.set('2,65,1', { known: false, position: { x: 2, y: 65, z: 1 } })
  assert.equal(f.interactions.previewPlaceBed(options).ready, false)
  f.blocks.delete('2,65,1')
  const placed = f.interactions.placeBed(options)
  assert.deepEqual(f.transactions[0].data.block_position, { x: 2, y: 64, z: 0 })
  assert.equal(f.transactions[0].data.held_item.metadata, 14)
  f.put(f.target, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 })
  f.interactions.applyPacket('update_block', { position: f.target })
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.raw[0] = f.empty(); f.state.inventory.items = []
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: f.raw[0] })
  assert.equal((await placed).confirmedBy, 'server_block_and_inventory')
})

test('bed item-use and normal stop-sleeping action claim only requests and use the actual half-height hit', async t => {
  const f = fixture(t)
  f.put(f.target, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 })
  f.raw[0] = f.empty(); f.state.inventory.items = []
  assert.equal(f.interactions.previewUseBed(f.target).ready, true)
  const result = await f.interactions.useBed(f.target)
  assert.equal(result.phase, 'requested')
  assert.equal(result.serverConfirmed, false)
  const packet = f.transactions[0].data
  assert.ok(packet.click_pos.y >= 0 && packet.click_pos.y <= 0.5625)
  assert.equal(packet.block_runtime_id, 18895)
  assert.deepEqual(packet.block_position, f.target)
  const wake = f.interactions.wakeBed(f.target)
  assert.equal(wake.serverConfirmed, false)
  assert.equal(f.packets.at(-1).packet.action, 'stop_sleeping')
  assert.equal(f.packets.at(-1).packet.runtime_entity_id, 41n)
  f.state.dimension = 'nether'
  assert.equal(f.interactions.previewUseBed(f.target).ready, false)
})

test('normal mining refuses all beds; only an explicit current owned target can use the real bed face, and life change blocks old completion', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.put(f.target, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 })
  f.raw[0] = f.empty(); f.state.inventory.items = []
  const target = { ...f.target, accessPreparation: 'owned_bed', expectedName: 'minecraft:bed', ownershipKey: 'confirmed-own-pair' }
  const strict = createMining({ getState: () => f.state, world: f.world, getInput: () => f.input })
  assert.equal(strict.preview([f.target]).ready, false)
  assert.equal(strict.preview([target]).ready, false)
  const owned = createMining({ getState: () => f.state, world: f.world, getInput: () => f.input, verifyOwnedBed: (state, point) => point.ownershipKey === 'confirmed-own-pair' && state.lifecycle.deathId === 0 && point.x === 2 && point.y === 65 && point.z === 0 })
  t.after(() => owned.stop())
  assert.equal(owned.preview([target]).ready, true)
  owned.start([target])
  assert.equal(f.actions[0][0], 'start_break')
  assert.ok(f.actions[0][3].hitPoint.y <= 65.5625)
  f.state.lifecycle.deathId++
  f.put(f.target, 'minecraft:air')
  t.mock.timers.tick(100)
  assert.equal(owned.snapshot().phase, 'failed')
  assert.equal(owned.snapshot().completed.length, 0)
})

test('HP1 enables only explicit bed item-use and current ownership-verified bed mining, preserving generic guards', async t => {
  const f = fixture(t); f.state.health = 1
  assert.throws(() => f.interactions.equip(0), /体力/)
  assert.throws(() => f.interactions.equip(0, true), /体力/, 'a public flag without an actual pending bed operation is insufficient')
  assert.equal(f.interactions.previewPlaceBed({ position: f.target, slot: 0 }).ready, true)
  const placed = f.interactions.placeBed({ position: f.target, slot: 0 })
  f.put(f.target, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 })
  f.raw[0] = f.empty(); f.state.inventory.items = []
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: f.raw[0] })
  await placed
  assert.equal((await f.interactions.useBed(f.target)).serverConfirmed, false)
  assert.equal(f.interactions.wakeBed(f.target).serverConfirmed, false)
  const normal = createMining({ getState: () => f.state, world: f.world, getInput: () => f.input })
  const target = { ...f.target, accessPreparation: 'owned_bed', expectedName: 'minecraft:bed', ownershipKey: 'bed-proof' }
  assert.equal(normal.preview([target]).ready, false)
  const owned = createMining({ getState: () => f.state, world: f.world, getInput: () => f.input, verifyOwnedBed: (state, point) => state.health > 0 && point.ownershipKey === 'bed-proof' })
  assert.equal(owned.preview([target]).ready, true)
  const dirt = { x: 3, y: 65, z: 0 }; f.put(dirt, 'minecraft:dirt')
  assert.equal(owned.preview([dirt]).ready, false, 'ordinary dirt mining retains its original health threshold')
})
