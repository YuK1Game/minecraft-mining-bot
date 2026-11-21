'use strict'

// Received recipe and stack-response peer for the real crafting and furnace modules.
// These are explicit vanilla-shaped test packets, not a recording from a Realm.
const assert = require('node:assert/strict')
const { createCrafting } = require('../../src/actions/crafting')
const { createFurnace } = require('../../src/actions/furnace')
const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const full = name => 'minecraft:' + name
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
const USES = { wooden_pickaxe: 59, stone_pickaxe: 131, iron_pickaxe: 250 }
const NAMES = ['oak_log', 'oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'cobblestone', 'furnace', 'charcoal', 'coal', 'torch', 'ladder', 'cobblestone_slab', 'chest', 'raw_iron', 'iron_ingot', 'dirt']
const named = name => ({ type: 'valid', descriptor_type: 'name', name: full(name), metadata: 0, count: 1 })

function attachBootstrapRecipes (w) {
  const { operations } = w.ctx, names = NAMES, id = name => names.indexOf(name) + 1
  let serial = 1000, requestId = -1001, activeFurnace = null, crafting, furnace, rejectIronTakes = 0
  const made = [], cooked = [], transfers = [], rejected = [], furnaces = new Map(), recipes = new Map()
  const raw = (name, count) => count ? { network_id: id(name), count, metadata: 0, has_stack_id: true, stack_id: ++serial, block_runtime_id: 0, extra } : empty()
  function publish () {
    const before = new Map(w.items.map(row => [row.slot, row]))
    const rows = crafting.inventorySnapshot().inventory.map(row => {
      const previous = before.get(row.slot), uses = USES[row.name?.replace('minecraft:', '')]
      return { ...row, ...(uses ? { durabilityKnown: true, durabilityRemaining: previous?.name === row.name ? previous.durabilityRemaining : uses, durabilityUsed: previous?.name === row.name ? previous.durabilityUsed ?? 0 : 0 } : {}) }
    })
    w.items.splice(0, w.items.length, ...rows)
  }
  function sync () {
    const slots = Array.from({ length: 36 }, empty)
    for (const row of w.items.filter(i => i.count > 0)) {
      assert.ok(id(row.name.replace('minecraft:', '')) > 0, row.name)
      slots[row.slot] = raw(row.name.replace('minecraft:', ''), row.count)
    }
    crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  }
  const send = (name, packet) => { crafting.applyPacket(name, packet); furnace?.applyPacket(name, packet) }
  const client = { queue (name, params) {
    if (name === 'interact') queueMicrotask(() => send('container_open', { window_id: 'inventory', window_type: 'inventory' }))
    if (name === 'container_close') queueMicrotask(() => send('container_close', { window_id: params.window_id, server: true }))
    if (name !== 'item_stack_request') return
    const request = params.requests[0], auto = request.actions.find(a => a.type_id === 'craft_recipe_auto')
    queueMicrotask(() => {
      if (auto) {
        const recipe = recipes.get(auto.recipe_network_id), changed = new Map()
        assert.ok(recipe, 'the peer received the recipe ID it advertised')
        for (const action of request.actions.filter(a => a.type_id === 'consume')) {
          const slot = action.source.slot, before = changed.get(slot)?.count ?? crafting.rawItem(slot).count
          assert.ok(before >= action.count, 'a craft consumes received ingredients')
          changed.set(slot, { slot, count: before - action.count, item_stack_id: ++serial })
        }
        const take = request.actions.find(a => a.type_id === 'take')
        assert.equal(take.count, recipe.output[0].count * auto.times_crafted)
        changed.set(take.destination.slot, { slot: take.destination.slot, count: take.count, item_stack_id: ++serial })
        send('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [...changed.values()] }] }] })
        publish(); made.push({ name: names[recipe.output[0].network_id - 1], count: take.count, feet: w.feet() })
      } else {
        assert.ok(activeFurnace, 'a furnace transfer has an open received furnace')
        const action = request.actions[0], put = action.type_id === 'place'
        const player = put ? action.source : action.destination, oven = put ? action.destination : action.source
        const bag = crafting.rawItem(player.slot), held = furnace.rawItem(oven.slot)
        const source = put ? bag : held, destination = put ? held : bag
        assert.ok(source?.count >= action.count)
        if (!put && source.network_id === id('iron_ingot') && rejectIronTakes > 0) {
          rejectIronTakes--
          const before = w.items.filter(i => i.name === full('iron_ingot')).reduce((sum, i) => sum + i.count, 0)
          send('item_stack_response', { responses: [{ request_id: request.request_id, status: 'error' }] })
          rejected.push({ output: 'iron_ingot', before, after: w.items.filter(i => i.name === full('iron_ingot')).reduce((sum, i) => sum + i.count, 0), madeTools: made.filter(i => i.name === 'iron_pickaxe').length })
          return
        }
        const count = (destination?.count ?? 0) + action.count
        const role = oven.slot_type.container_id
        send('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers: [
          { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: player.slot, count: put ? bag.count - action.count : count, item_stack_id: ++serial }] },
          { slot_type: { container_id: role }, slots: [{ slot: oven.slot, count: put ? count : held.count - action.count, item_stack_id: ++serial }] }
        ] }] })
        publish(); transfers.push({ type: put ? 'put' : 'take', role, name: names[source.network_id - 1], count: action.count })
        activeFurnace.slots = [0, 1, 2].map(slot => furnace.rawItem(slot))
        cook()
      }
    })
  } }
  crafting = createCrafting({ client, getState: () => ({ ...w.raw, gameMode: 'survival' }), timeoutMs: 100 })
  furnace = createFurnace({ client, getState: () => ({ ...w.raw, gameMode: 'survival' }), crafting, timeoutMs: 100,
    allocateRequestId: () => { requestId -= 2; return requestId }, onInventory: packet => { crafting.applyPacket('inventory_content', packet); publish() } })
  send('start_game', { server_authoritative_inventory: true })
  send('item_registry', { itemstates: names.map(name => ({ name: full(name), runtime_id: id(name) })) })
  const add = (name, amount, rows) => {
    const width = rows[0].length, input = rows.flat().map(part => part ? named(part) : { type: 'invalid', count: 0 })
    const recipe = { recipe_id: name + recipes.size, network_id: recipes.size + 1, block: 'crafting_table', width, height: rows.length, input, output: [raw(name, amount)] }
    recipes.set(recipe.network_id, recipe)
  }
  add('oak_planks', 4, [['oak_log']]); add('stick', 4, [['oak_planks'], ['oak_planks']])
  add('crafting_table', 1, [['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']])
  for (const [name, material] of [['wooden_pickaxe', 'oak_planks'], ['stone_pickaxe', 'cobblestone'], ['iron_pickaxe', 'iron_ingot']]) add(name, 1, [[material, material, material], [null, 'stick', null], [null, 'stick', null]])
  add('furnace', 1, [['cobblestone', 'cobblestone', 'cobblestone'], ['cobblestone', null, 'cobblestone'], ['cobblestone', 'cobblestone', 'cobblestone']])
  for (const fuel of ['coal', 'charcoal']) add('torch', 4, [[fuel], ['stick']])
  add('ladder', 3, [['stick', null, 'stick'], ['stick', 'stick', 'stick'], ['stick', null, 'stick']])
  add('cobblestone_slab', 6, [['cobblestone', 'cobblestone', 'cobblestone']])
  add('chest', 1, [['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', null, 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']])
  send('crafting_data', { clear_recipes: true, shaped_recipes: [...recipes.values()] })
  function cook () {
    const box = activeFurnace, input = box.slots[0], fuel = box.slots[1], output = box.slots[2]
    const name = names[input?.network_id - 1], product = name === 'oak_log' ? 'charcoal' : name === 'raw_iron' ? 'iron_ingot' : null
    if (!product || !input?.count) return
    let madeCount = 0
    while (input.count && (output?.count ?? 0) + madeCount < 64) {
      if (box.burn < 200 && fuel?.count) { fuel.count--; box.burn += /^(?:coal|charcoal)$/.test(names[fuel.network_id - 1]) ? 1600 : 300 }
      if (box.burn < 200) break
      box.burn -= 200; input.count--; madeCount++
    }
    if (input.count && box.burn < 200 && !fuel?.count) box.burn = 0
    send('container_set_data', { window_id: 7, property: 1, value: box.burn })
    if (!madeCount) return
    assert.ok(!output?.count || output.network_id === id(product), 'smelting cannot overwrite a different output')
    box.slots = [input.count ? input : empty(), fuel?.count ? fuel : empty(), raw(product, (output?.count ?? 0) + madeCount)]
    for (let slot = 0; slot < 3; slot++) send('inventory_slot', { window_id: 7, slot, item: box.slots[slot] })
    send('container_set_data', { window_id: 7, property: 1, value: box.burn })
    cooked.push({ input: name, output: product, count: madeCount, feet: w.feet() })
  }
  const close = operations.crafting.closeContainer
  operations.crafting = { ...crafting, closeContainer: () => { close(); return crafting.closeContainer() },
    openInventory: (...args) => { sync(); return crafting.openInventory(...args) },
    craft: (...args) => { sync(); return crafting.craft(...args) }, preview: (...args) => { sync(); return crafting.preview(...args) } }
  // The peer cooks synchronously when it receives fuel. A missing/partial
  // result is therefore a bounded receive timeout, not a wall-clock cook.
  operations.furnace = { ...furnace, waitOutput: (name, count, options) => furnace.waitOutput(name, count, { ...options, timeoutMs: 20 }) }
  operations.interactions.openCraftingTable = async at => {
    assert.equal(w.getBlock(at.x, at.y, at.z).name, full('crafting_table'))
    assert.ok(Math.hypot(at.x + .5 - w.feet().x, at.y - w.feet().y, at.z + .5 - w.feet().z) < 5)
    sync(); send('container_open', { window_id: 6, window_type: 'workbench', coordinates: at })
  }
  operations.interactions.openFurnace = async at => {
    assert.equal(w.getBlock(at.x, at.y, at.z).name, full('furnace'))
    assert.ok(Math.hypot(at.x + .5 - w.feet().x, at.y - w.feet().y, at.z + .5 - w.feet().z) < 5)
    sync(); const key = `${at.x},${at.y},${at.z}`
    if (!furnaces.has(key)) furnaces.set(key, { slots: [empty(), empty(), empty()], burn: 0 })
    activeFurnace = furnaces.get(key)
    send('container_open', { window_id: 7, window_type: 'furnace', coordinates: at })
    send('inventory_content', { window_id: 7, input: activeFurnace.slots })
    send('container_set_data', { window_id: 7, property: 1, value: activeFurnace.burn }); cook()
  }
  const sleep = w.ctx.sleep
  w.ctx.sleep = async ms => {
    // Unused heat is spent while wood gathering, building and return travel
    // advance this fixture's clock; it is not stored forever across windows.
    for (const box of furnaces.values()) box.burn = Math.max(0, box.burn - ms / 50)
    if (activeFurnace && crafting.snapshot().openContainer?.id === 7) send('container_set_data', { window_id: 7, property: 1, value: Math.floor(activeFurnace.burn) })
    await sleep(ms)
  }
  sync()
  return { made, cooked, transfers, rejected, crafting, furnace, sync, rejectIronTake: () => { rejectIronTakes++ } }
}

module.exports = { attachBootstrapRecipes }
