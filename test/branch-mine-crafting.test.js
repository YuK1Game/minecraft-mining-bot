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
      const destBefore = take.destination.stack_id ? crafting.rawItem(take.destination.slot).count : 0
      changed.set(take.destination.slot, { slot: take.destination.slot, count: destBefore + take.count, item_stack_id: 200 })
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

test('mine station placement mines an adjacent rock wall when boxed into a 1x1 pit instead of stalling on MINE_STATION_SPACE_UNAVAILABLE', async () => {
  const { createMineSupplies } = require('../src/modes/mining/mine-supplies')
  const dug = []
  const placed = []
  const opened = new Set()
  const blockAt = ({ x, y, z }) => {
    const key = `${x},${y},${z}`
    if (opened.has(key)) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    if (x === 10 && z === 10 && (y === 61 || y === 62)) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  }
  const plan = {
    shaft: { topY: 70, columns: [{ x: 0, z: 0 }], approach: { x: 0.5, y: 70, z: 0.5 }, ladder: { column: { x: 0, z: 0 }, support: { x: -1, z: 0 } } },
    layers: [{ id: 'upper', y: 16 }],
    storage: [{ layer: 'upper', pairs: [] }],
    steps: []
  }
  const branch = { plan, shaft: { depth: 16, landings: { upper: true } }, progress: { upper: { cursor: 0, confirmedSteps: 0 } }, storage: { pairs: {} }, lobbyReady: {} }
  const ctx = {
    cancelled: () => false,
    getFeet: () => ({ x: 10.5, y: 61, z: 10.5 }),
    memory: { early: { mine: { branch } } },
    shared: {},
    supplies: { acquire: async () => ({ done: false, reason: 'acquiring' }) },
    log: () => {}
  }
  const inv = {
    known: true,
    items: [
      { slot: 0, name: 'minecraft:torch', count: 32 },
      { slot: 1, name: 'minecraft:cobblestone', count: 88 },
      { slot: 2, name: 'minecraft:crafting_table', count: 1 },
      { slot: 3, name: 'minecraft:ladder', count: 64 },
      { slot: 4, name: 'minecraft:chest', count: 16 }
    ]
  }
  const actions = {
    inventory: () => inv,
    block: blockAt,
    walk: async () => ({ status: 'failed', code: 'MINE_WALK_REFUSED' }),
    mine: async pos => {
      dug.push(pos)
      opened.add(`${pos.x},${pos.y},${pos.z}`)
      return { status: 'completed', code: 'MINE_AIR_RECEIVED', serverConfirmed: true }
    },
    place: async req => {
      placed.push(req)
      return { status: 'completed', code: 'MINE_STRUCTURE_RECEIVED', serverConfirmed: true }
    },
    house: {
      craft: async () => false,
      why: () => null
    },
    save: async () => true,
    done: (code, evidence) => ({ status: 'completed', code, evidence, serverConfirmed: true })
  }
  const supplies = createMineSupplies(ctx, actions, {})
  await supplies.ensure(plan, { layer: 'upper', shaftOnly: false })
  assert.equal(dug.length, 1)
  assert.equal(placed.length, 1)
  assert.equal(placed[0].name, 'crafting_table')
  assert.deepEqual(placed[0].position, dug[0])
})
