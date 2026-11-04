'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/diamond-planner')

function fixture () {
  const state = { phase: 'spawned', version: '1.26.60', runtimeEntityId: '41', dimension: 'overworld', gameMode: 'survival', health: 20, dead: false, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, heldItem: null, selectedSlot: 0, equipmentServerConfirmed: true, world: { initialized: true, loadedSections: 27, version: '1.26.60' }, capabilities: { mining: true, movement: true } }
  const map = new Map()
  const set = (x, y, z, name, metadata = {}) => map.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, position: { x, y, z }, runtimeId: 100, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [], ...metadata })
  for (let x = -4; x <= 10; x++) for (let y = 62; y <= 72; y++) for (let z = -4; z <= 4; z++) set(x, y, z, y < 64 ? 'stone' : y === 64 ? 'grass_block' : 'air')
  for (let y = 65; y <= 68; y++) set(3, y, 0, 'oak_log')
  set(3, 69, 0, 'oak_leaves')
  set(1, 65, 1, 'stone')
  const observations = { blocks: [...map.values()], drops: [], ores: { coal: [], iron: [], diamond: [] }, crafting: { previews: {} }, capabilities: { scan_blocks: true, craft: true, place_block: true, use_table: true, equip: true, collect_drops: true, prospect: true, tunnel: true, mine_ore: true, place_furnace: true, open_furnace: true, furnace: true } }
  const items = values => { state.inventory.items = values.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const hold = name => { const item = state.inventory.items.find(value => value.name === `minecraft:${name}`); assert.ok(item); state.heldItem = { ...item }; state.selectedSlot = item.slot; state.rawSelectedSlot = item.slot }
  const refresh = () => { observations.blocks = [...map.values()] }
  const table = () => { set(-1, 65, 1, 'crafting_table'); observations.craftingTable = { known: true, usable: true, position: { x: -1, y: 65, z: 1 } }; refresh() }
  const preview = (name, times = 1, metadata = {}) => { observations.crafting.previews[name] = { ready: true, output: { name: `minecraft:${name}`, count: times * (name.endsWith('_planks') || name === 'stick' ? 4 : 1) }, times, recipeNetworkId: 1901, ...metadata } }
  const ore = (resource, name, position, metadata = {}) => {
    set(position.x, position.y, position.z, name, metadata)
    observations.ores[resource].push({ ...map.get(`${position.x},${position.y},${position.z}`), ...metadata })
    refresh()
  }
  const furnace = () => {
    set(2, 65, -1, 'furnace')
    observations.furnace = { window: { id: 1, type: 'furnace', coordinates: { x: 2, y: 65, z: -1 } }, contentsKnown: true, needsOpen: false, busy: false, inventoryUncertain: false, slots: [{ slot: 0, role: 'furnace_ingredient', known: true, name: null, count: 0, stackId: null }, { slot: 1, role: 'furnace_fuel', known: true, name: null, count: 0, stackId: null }, { slot: 2, role: 'furnace_output', known: true, name: null, count: 0, stackId: null }], progress: { cookTicks: null, burnTicksRemaining: null, burnDuration: null } }
    observations.stations = { furnace: { known: true, serverConfirmed: true, position: { x: 2, y: 65, z: -1 } } }
    refresh()
  }
  return { state, observations, map, set, refresh, items, hold, table, preview, ore, furnace, next: () => nextDiamondAction(state, observations) }
}

test('online learning HP1 diamond plan still needs real tools and received resources', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.next().code, 'low_health')
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.next().type, 'gather_logs')
  f.items([['wooden_pickaxe', 1], ['cobblestone', 2]]); f.hold('wooden_pickaxe')
  assert.equal(f.next().type, 'mine_stone')
  f.state.inventory.known = false; assert.equal(f.next().code, 'inventory_unknown')
  f.state.inventory.known = true; f.state.health = 0
  assert.equal(f.next().type, 'capability_required')
})

test('the first bootstrap step still gathers real wood and never narrows the final goal to cobblestone', () => {
  const f = fixture()
  const action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.count, 3)
  assert.deepEqual(action.goal, { diamond: 1 })
  f.items([['wooden_pickaxe', 1], ['cobblestone', 2]])
  f.hold('wooden_pickaxe')
  const stone = f.next()
  assert.equal(stone.type, 'mine_stone')
  assert.equal(stone.count, 1)
  assert.equal(stone.subgoal.stone, 3)
  assert.notEqual(stone.type, 'complete')
})

test('stone pickaxe is crafted from the existing table, three cobble and remaining sticks', () => {
  const f = fixture()
  f.table()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 3], ['stick', 2], ['oak_planks', 3]])
  f.hold('wooden_pickaxe')
  assert.equal(f.next().type, 'preview_craft')
  assert.equal(f.next().output, 'minecraft:stone_pickaxe')
  f.preview('stone_pickaxe')
  assert.equal(f.next().type, 'craft')
  f.items([['wooden_pickaxe', 1], ['stone_pickaxe', 1], ['oak_planks', 3]])
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().item, 'minecraft:stone_pickaxe')
})

test('furnace needs eight actual stone, a live recipe preview and a confirmed placement callback', () => {
  const f = fixture()
  f.table()
  f.items([['stone_pickaxe', 1], ['cobblestone', 7]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'mine_stone')
  assert.equal(f.next().subgoal.stone, 8)
  f.items([['stone_pickaxe', 1], ['cobblestone', 8]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().output, 'minecraft:furnace')
  f.preview('furnace')
  assert.equal(f.next().type, 'craft')
  f.items([['stone_pickaxe', 1], ['furnace', 1]])
  f.hold('stone_pickaxe')
  f.observations.furnacePlacement = { ready: true, position: { x: 2, y: 65, z: -1 } }
  assert.equal(f.next().type, 'place_furnace')
  f.observations.capabilities.place_furnace = false
  const unsupported = f.next()
  assert.equal(unsupported.type, 'capability_required')
  assert.equal(unsupported.capability, 'place_furnace')
})

test('ore acquisition uses an equipped stone tier for coal and iron and never invents an unknown target', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'prospect')
  assert.equal(f.next().resource, 'coal')
  f.ore('coal', 'coal_ore', { x: 1, y: 65, z: 0 })
  const coal = f.next()
  assert.equal(coal.type, 'mine_ore')
  assert.equal(coal.resource, 'coal')
  assert.equal(coal.requiredToolTier, 2)
  assert.equal(coal.block, 'minecraft:coal_ore')
  f.set(1, 65, 0, 'air'); f.refresh()
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().resource, 'iron')
  f.ore('iron', 'iron_ore', { x: 2, y: 65, z: 0 })
  const iron = f.next()
  assert.equal(iron.type, 'mine_ore')
  assert.equal(iron.resource, 'iron')
  assert.equal(iron.count, 3)
  f.state.equipmentServerConfirmed = false
  assert.equal(f.next().type, 'equip', 'requested selection is not enough to mine iron')
})

test('furnace slots drive input, fuel, output collection and unknown-progress waiting without imaginary ingots', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['coal', 1], ['raw_iron', 3]])
  f.hold('stone_pickaxe')
  const input = f.next()
  assert.equal(input.type, 'put_furnace_input')
  assert.equal(input.slot, 2)
  assert.equal(input.count, 3)
  f.observations.furnace.slots[0] = { ...f.observations.furnace.slots[0], name: 'minecraft:raw_iron', count: 3, stackId: 501 }
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'put_furnace_fuel')
  f.items([['stone_pickaxe', 1]])
  f.hold('stone_pickaxe')
  f.observations.furnace.lastTransfer = { phase: 'completed', operation: 'fuel', serverConfirmed: true }
  assert.equal(f.next().type, 'wait')
  assert.equal(f.next().code, 'furnace_cooking')
  f.observations.furnace.slots[0].count = 2
  f.observations.furnace.slots[2] = { ...f.observations.furnace.slots[2], name: 'minecraft:iron_ingot', count: 1, stackId: 601 }
  assert.equal(f.next().type, 'take_furnace_output')
  assert.equal(f.next().expectedName, 'minecraft:iron_ingot')
  f.observations.furnace.slots[2].count = 0
  f.items([['stone_pickaxe', 1], ['iron_ingot', 1]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().code, 'furnace_cooking', 'unknown fuel progress is not proof that another coal must be mined')
})

test('unknown or conflicting furnace contents are not overwritten and a closed station is reopened', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['coal', 1], ['raw_iron', 3]])
  f.hold('stone_pickaxe')
  f.observations.furnace.contentsKnown = false
  assert.equal(f.next().code, 'furnace_contents_unknown')
  f.observations.furnace.contentsKnown = true
  f.observations.furnace.slots[0] = { ...f.observations.furnace.slots[0], name: 'minecraft:raw_beef', count: 1 }
  const blocked = f.next()
  assert.equal(blocked.type, 'capability_required')
  assert.equal(blocked.capability, 'manage_furnace_contents')
  f.observations.furnace.window = null
  f.observations.furnace.needsOpen = true
  assert.equal(f.next().type, 'open_furnace')
})

test('three ingots use the remaining starter planks for sticks, then craft and equip an iron pickaxe', () => {
  const f = fixture()
  f.table()
  f.items([['stone_pickaxe', 1], ['iron_ingot', 3], ['oak_planks', 3]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'preview_craft')
  assert.equal(f.next().output, 'minecraft:stick')
  f.preview('stick')
  assert.equal(f.next().type, 'craft')
  f.items([['stone_pickaxe', 1], ['iron_ingot', 3], ['oak_planks', 1], ['stick', 4]])
  f.hold('stone_pickaxe')
  f.preview('iron_pickaxe')
  assert.equal(f.next().type, 'craft')
  assert.equal(f.next().output, 'minecraft:iron_pickaxe')
  f.items([['stone_pickaxe', 1], ['iron_pickaxe', 1], ['oak_planks', 1], ['stick', 2]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().item, 'minecraft:iron_pickaxe')
})

test('a missing stone pickaxe can rebuild its sticks from additional real wood', () => {
  const f = fixture()
  f.table()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 3]])
  f.hold('wooden_pickaxe')
  const replacement = f.next()
  assert.equal(replacement.type, 'gather_logs')
  assert.equal(replacement.subgoal.name, 'additional_wood')
  f.items([['wooden_pickaxe', 1], ['cobblestone', 3], ['oak_log', 1]])
  f.hold('wooden_pickaxe')
  assert.equal(f.next().output, 'minecraft:oak_planks')
  assert.equal(f.next().times, 1)
})

test('known buried diamond requests a bounded tunnel capability and exposed ore uses actual ore identity', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1], ['cobblestone', 16]])
  f.hold('iron_pickaxe')
  f.ore('diamond', 'deepslate_diamond_ore', { x: 2, y: 60, z: 0 }, { requiresTunnel: true })
  const tunnel = f.next()
  assert.equal(tunnel.type, 'tunnel')
  assert.deepEqual(tunnel.targetOre, { name: 'minecraft:deepslate_diamond_ore', position: { x: 2, y: 60, z: 0 } })
  assert.equal(tunnel.requiredToolTier, 3)
  f.observations.capabilities.tunnel = false
  assert.equal(f.next().capability, 'tunnel')
  f.observations.ores.diamond = []
  f.set(2, 60, 0, 'air')
  f.ore('diamond', 'diamond_ore', { x: 1, y: 65, z: 0 })
  assert.equal(f.next().type, 'mine_ore')
  assert.equal(f.next().block, 'minecraft:diamond_ore')
  assert.deepEqual(f.next().goal, { diamond: 1 })
  assert.notEqual(f.next().type, 'complete', 'sixteen cobblestone cannot satisfy a diamond goal')
})

test('unknown, protected and excluded ores cannot become invented tunnel or mining targets', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1]])
  f.hold('iron_pickaxe')
  f.observations.ores.diamond = [{ known: false, name: 'minecraft:diamond_ore', position: { x: 8, y: 65, z: 0 } }]
  assert.equal(f.next().type, 'prospect')
  f.ore('diamond', 'diamond_ore', { x: 1, y: 65, z: 0 }, { protected: true })
  assert.equal(f.next().type, 'prospect')
  f.set(1, 65, 0, 'air')
  f.observations.ores.diamond = []
  f.ore('diamond', 'diamond_ore', { x: 2, y: 65, z: 0 })
  f.observations.progress = { excludedResources: [{ resource: 'diamond', position: { x: 2, y: 65, z: 0 } }] }
  assert.equal(f.next().type, 'prospect')
  f.observations.capabilities.prospect = false
  assert.equal(f.next().capability, 'prospect')
})

test('only a known live server inventory diamond completes; drops, cooking output and stone do not', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1], ['cobblestone', 64], ['iron_ingot', 3]])
  f.hold('iron_pickaxe')
  f.observations.drops = [{ known: true, entityId: '99', name: 'minecraft:diamond', count: 1, position: { x: 1, y: 65, z: 0 } }]
  assert.equal(f.next().type, 'collect_drops')
  f.items([['iron_pickaxe', 1], ['diamond', 1]])
  f.hold('iron_pickaxe')
  assert.equal(f.next().type, 'complete')
  assert.equal(f.next().confirmedBy, 'server_inventory')
  f.state.inventory.known = false
  assert.equal(f.next().code, 'inventory_unknown')
  f.state.inventory.known = true
  f.state.dead = true; f.state.health = 0
  assert.notEqual(f.next().type, 'complete')
})

test('diamond planning is deterministic and never alters host inventory, ore metadata or furnace slots', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  f.hold('stone_pickaxe')
  f.ore('iron', 'iron_ore', { x: 2, y: 65, z: 0 })
  const before = structuredClone({ state: f.state, observations: f.observations })
  assert.deepEqual(f.next(), f.next())
  assert.deepEqual({ state: f.state, observations: f.observations }, before)
})

test('current air, protection or unknown blocks override stale remembered ore targets', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1]])
  f.hold('iron_pickaxe')
  f.ore('diamond', 'diamond_ore', { x: 1, y: 65, z: 0 })
  assert.equal(f.next().type, 'mine_ore')
  for (const metadata of [
    { name: 'minecraft:air' },
    { protected: true },
    { known: false }
  ]) {
    f.set(1, 65, 0, 'diamond_ore', metadata)
    f.refresh()
    assert.equal(f.next().type, 'prospect', 'cached ore metadata cannot replace a contrary current observation')
  }
  f.set(1, 65, 0, 'diamond_ore')
  f.refresh()
  assert.equal(f.next().type, 'mine_ore')
})

test('a remembered station is invalidated by current terrain and active server tasks are awaited', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['coal', 1], ['raw_iron', 3]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'put_furnace_input')
  f.set(2, 65, -1, 'air'); f.refresh()
  assert.equal(f.next().subgoal.name, 'cobblestone_for_furnace', 'a stale open-window or station record cannot resurrect a missing furnace')
  for (const task of ['crafting', 'interactions', 'furnace']) {
    f.state[task] = { phase: 'awaiting_server_confirmation' }
    assert.equal(f.next().code, 'task_in_progress')
    delete f.state[task]
  }
})

test('a surface furnace cannot pull an underground coal or iron mission back between tunnel steps', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1]])
  f.hold('stone_pickaxe')
  f.state.position = { x: 30.5, y: 31.62, z: 0.5 }
  f.observations.furnace.window = null
  f.observations.furnace.contentsKnown = false
  f.observations.furnace.needsOpen = true
  f.observations.furnace.slots = [0, 1, 2].map(slot => ({ slot, known: false, name: null, count: null }))
  f.ore('coal', 'coal_ore', { x: 34, y: 30, z: 0 }, { requiresTunnel: true })
  f.ore('iron', 'iron_ore', { x: 35, y: 30, z: 1 }, { requiresTunnel: true })
  for (let step = 0; step < 3; step++) {
    const action = f.next()
    assert.equal(action.type, 'tunnel')
    assert.equal(action.resource, 'coal')
    f.state.position.x += 1
  }
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  f.hold('stone_pickaxe')
  for (let step = 0; step < 3; step++) {
    const action = f.next()
    assert.equal(action.type, 'tunnel')
    assert.equal(action.resource, 'iron')
    f.state.position.z += 1
  }
  f.items([['stone_pickaxe', 1], ['coal', 1], ['raw_iron', 3]])
  f.hold('stone_pickaxe')
  const returnToFurnace = f.next()
  assert.equal(returnToFurnace.type, 'move_to')
  assert.deepEqual(returnToFurnace.stationTarget, { x: 2, y: 65, z: -1 })
  assert.ok(returnToFurnace.target && Number.isFinite(returnToFurnace.target.x))
  assert.equal(returnToFurnace.requiresReobservation, true)
  assert.equal(returnToFurnace.resource, 'furnace')
  f.state.position = { x: 0.5, y: 66.62, z: 0.5 }
  assert.equal(f.next().type, 'open_furnace')
})

test('a confirmed prior deposit requests inspection rather than inventing ingots or mining duplicate iron', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  f.hold('stone_pickaxe')
  f.state.position = { x: 30.5, y: 31.62, z: 0.5 }
  f.observations.furnace.window = null
  f.observations.furnace.contentsKnown = false
  f.observations.furnace.needsOpen = true
  f.observations.furnace.lastTransfer = { phase: 'completed', serverConfirmed: true, operation: 'input', item: 'minecraft:raw_iron', count: 3, requestId: -1 }
  assert.equal(f.next().type, 'move_to')
  assert.equal(f.next().resource, 'furnace')
  assert.equal(f.next().counts.ironIngots, 0)
  f.items([['stone_pickaxe', 1]])
  f.hold('stone_pickaxe')
  f.observations.furnace.lastTransfer = { phase: 'completed', serverConfirmed: true, operation: 'fuel', item: 'minecraft:coal', count: 1, requestId: -3 }
  assert.equal(f.next().type, 'move_to')
  assert.notEqual(f.next().type, 'complete')
  f.observations.furnace.lastTransfer.serverConfirmed = false
  assert.equal(f.next().type, 'prospect', 'an unconfirmed deposit cannot replace ingredient acquisition')
})

test('spare overworld planks can fuel iron smelting while preserving pickaxe sticks', () => {
  const f = fixture(); f.table(); f.furnace()
  f.items([['stone_pickaxe', 1], ['raw_iron', 3], ['oak_planks', 3], ['stick', 2]])
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'put_furnace_input')
  f.state.inventory.items.find(item => item.name === 'minecraft:raw_iron').count = 0
  Object.assign(f.observations.furnace.slots[0], { name: 'minecraft:raw_iron', count: 3, stackId: 501 })
  const fuel = f.next()
  assert.equal(fuel.type, 'put_furnace_fuel')
  assert.equal(fuel.count, 3)
  assert.equal(f.state.inventory.items[fuel.slot].name, 'minecraft:oak_planks')
  assert.equal(fuel.counts.ironIngots, 0)
  f.state.inventory.items.find(item => item.name === 'minecraft:stick').count = 0
  assert.notEqual(f.next().type, 'put_furnace_fuel', 'two planks remain reserved for sticks')
  f.state.inventory.items.find(item => item.name === 'minecraft:stick').count = 2
  f.state.inventory.items.find(item => item.name === 'minecraft:oak_planks').name = 'minecraft:crimson_planks'
  assert.notEqual(f.next().type, 'put_furnace_fuel', 'non-burning nether wood is excluded')
})

test('a confirmed plank-fuel deposit requests furnace inspection before further mining', () => {
  const f = fixture(); f.table(); f.furnace(); f.items([['stone_pickaxe', 1], ['stick', 2]]); f.hold('stone_pickaxe')
  f.state.position = { x: 30.5, y: 31.62, z: 0.5 }; f.observations.furnace.window = null; f.observations.furnace.contentsKnown = false; f.observations.furnace.needsOpen = true
  f.observations.furnace.lastTransfer = { phase: 'completed', serverConfirmed: true, operation: 'fuel', item: 'minecraft:oak_planks', count: 3, requestId: -3 }
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.equal(action.resource, 'furnace')
  assert.equal(action.counts.ironIngots, 0)
})

test('completed predicted navigation permits the next live operation while actual streams and item requests remain busy', () => {
  const f = fixture()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 2]])
  f.hold('wooden_pickaxe')
  f.state.positionSource = 'client_prediction'
  f.state.movement = { phase: 'awaiting_server_confirmation', running: false, serverConfirmed: false }
  assert.equal(f.next().type, 'mine_stone')
  f.state.walking = { phase: 'awaiting_server_confirmation', running: false, serverConfirmed: false }
  assert.equal(f.next().type, 'mine_stone', 'legacy inactive walking markers cannot block the reused Bootstrap planner either')
  assert.equal(f.state.walking.phase, 'awaiting_server_confirmation', 'the host evidence and confidence label stay untouched')
  f.state.movement.running = true
  assert.equal(f.next().code, 'task_in_progress')
  f.state.movement.running = false
  f.state.interactions = { pendingOperation: 'place' }
  assert.equal(f.next().code, 'task_in_progress')
  delete f.state.interactions
  f.state.crafting = { pendingRequestId: -21 }
  assert.equal(f.next().code, 'task_in_progress')
  delete f.state.crafting
  assert.equal(f.next().type, 'mine_stone')
})

function knownDurability (item, remaining) {
  const maximum = { 'minecraft:wooden_pickaxe': 59, 'minecraft:golden_pickaxe': 32, 'minecraft:stone_pickaxe': 131, 'minecraft:iron_pickaxe': 250, 'minecraft:diamond_pickaxe': 1561, 'minecraft:netherite_pickaxe': 2031 }[item.name]
  Object.assign(item, { durabilityKnown: true, maxDurability: maximum, durabilityUsed: maximum - remaining, durabilityRemaining: remaining, durabilitySource: 'server_item_nbt' })
}

test('worn iron returns to the usable stone iron-and-furnace chain instead of repeating diamond tunnels', () => {
  const f = fixture()
  f.table(); f.furnace()
  f.items([['iron_pickaxe', 1], ['stone_pickaxe', 1], ['coal', 1]])
  knownDurability(f.state.inventory.items[0], 4)
  knownDurability(f.state.inventory.items[1], 70)
  f.hold('iron_pickaxe')
  f.ore('diamond', 'diamond_ore', { x: 3, y: 60, z: 0 }, { requiresTunnel: true })
  f.ore('iron', 'iron_ore', { x: 4, y: 60, z: 0 }, { requiresTunnel: true })
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().item, 'minecraft:stone_pickaxe')
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'tunnel')
  assert.equal(f.next().resource, 'iron')
  assert.equal(f.next().count, undefined)
  assert.equal(f.next().requiredToolTier, 2)
  assert.deepEqual(f.next().goal, { diamond: 1 })
  f.state.inventory.items.push({ name: 'minecraft:raw_iron', count: 3, slot: 3 })
  assert.equal(f.next().type, 'put_furnace_input')
  f.state.inventory.items.at(-1).count = 0
  Object.assign(f.observations.furnace.slots[0], { name: 'minecraft:raw_iron', count: 3, stackId: 501 })
  assert.equal(f.next().type, 'put_furnace_fuel')
  f.state.inventory.items.find(item => item.name === 'minecraft:coal').count = 0
  Object.assign(f.observations.furnace.slots[0], { name: null, count: 0, stackId: null })
  Object.assign(f.observations.furnace.slots[2], { name: 'minecraft:iron_ingot', count: 3, stackId: 601 })
  assert.equal(f.next().type, 'take_furnace_output')
  f.state.inventory.items.push({ name: 'minecraft:iron_ingot', count: 3, slot: 4 }, { name: 'minecraft:stick', count: 2, slot: 5 })
  f.preview('iron_pickaxe')
  assert.equal(f.next().type, 'craft')
  assert.equal(f.next().output, 'minecraft:iron_pickaxe')
})

test('a healthy spare of the same tool type outranks the worn selected stack even when held slot metadata is missing', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1], ['iron_pickaxe', 1]])
  knownDurability(f.state.inventory.items[0], 1)
  knownDurability(f.state.inventory.items[1], 120)
  f.hold('iron_pickaxe')
  delete f.state.heldItem.slot
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().slot, 1)
  f.state.heldItem = { ...f.state.inventory.items[1] }
  f.state.selectedSlot = 1; f.state.rawSelectedSlot = 1
  assert.equal(f.next().resource, 'diamond')
  assert.equal(f.next().type, 'prospect')
})

test('worn stone is replaced from actual three cobble and two sticks, then the new stack is equipped', () => {
  const f = fixture()
  f.table()
  f.items([['stone_pickaxe', 1], ['cobblestone', 3], ['stick', 2]])
  knownDurability(f.state.inventory.items[0], 2)
  f.hold('stone_pickaxe')
  f.preview('stone_pickaxe')
  assert.equal(f.next().type, 'craft')
  assert.equal(f.next().output, 'minecraft:stone_pickaxe')
  f.items([['stone_pickaxe', 1], ['stone_pickaxe', 1]])
  knownDurability(f.state.inventory.items[0], 2)
  knownDurability(f.state.inventory.items[1], 131)
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().slot, 1)
  f.state.heldItem = { ...f.state.inventory.items[1] }
  f.state.selectedSlot = 1; f.state.rawSelectedSlot = 1
  assert.equal(f.next().type, 'mine_stone')
  assert.equal(f.next().requiresKnownDurability, true)
})

test('the Bootstrap material delegate cannot reselect a filtered worn iron or stone pickaxe', () => {
  const f = fixture()
  f.table()
  f.items([['iron_pickaxe', 1], ['stone_pickaxe', 1], ['cobblestone', 7]])
  knownDurability(f.state.inventory.items[0], 3)
  knownDurability(f.state.inventory.items[1], 60)
  f.hold('stone_pickaxe')
  const before = structuredClone(f.state)
  assert.equal(f.next().type, 'mine_stone', 'the shared planner must not equip the worn higher-tier iron tool again')
  assert.equal(f.next().count, 1)
  assert.deepEqual(f.state, before)
  f.items([['stone_pickaxe', 1], ['wooden_pickaxe', 1], ['cobblestone', 2]])
  knownDurability(f.state.inventory.items[0], 4)
  knownDurability(f.state.inventory.items[1], 40)
  f.hold('stone_pickaxe')
  assert.equal(f.next().type, 'equip')
  assert.equal(f.next().item, 'minecraft:wooden_pickaxe')
  f.hold('wooden_pickaxe')
  assert.equal(f.next().type, 'mine_stone')
  assert.equal(f.next().count, 1)
})

test('stone replacement can collect real dropped cobble or gather new wood without ever using an exhausted tool', () => {
  const f = fixture()
  f.table()
  f.items([['stone_pickaxe', 1], ['cobblestone', 2], ['stick', 2]])
  knownDurability(f.state.inventory.items[0], 0)
  f.hold('stone_pickaxe')
  f.observations.drops = [{ known: true, entityId: 'spare-stone', name: 'minecraft:cobblestone', count: 1, position: { x: 1, y: 65.1, z: 0 } }]
  assert.equal(f.next().type, 'collect_drops')
  assert.equal(f.next().resource, 'stone')
  f.observations.drops = []
  const rebuild = f.next()
  assert.equal(rebuild.type, 'gather_logs')
  assert.equal(rebuild.stage, 'logs')
  assert.notEqual(rebuild.type, 'mine_stone')
})

test('explicit unknown or contradictory durability never becomes a fresh tool or derives durability from metadata', () => {
  for (const metadata of [
    { durabilityKnown: false, metadata: 0 },
    { durabilityKnown: true, durabilityUsed: 0 },
    { durabilityKnown: true, durabilityRemaining: 10, maxDurability: 5 },
    { durabilityKnown: true, durabilityRemaining: 10, maxDurability: 250, durabilityUsed: 249 }
  ]) {
    const f = fixture()
    f.items([['iron_pickaxe', 1]])
    Object.assign(f.state.inventory.items[0], metadata)
    f.hold('iron_pickaxe')
    const before = structuredClone(f.state)
    const action = f.next()
    assert.equal(action.type, 'wait')
    assert.equal(action.code, 'tool_durability_unknown')
    assert.deepEqual(f.state, before)
  }
  const legacy = fixture()
  legacy.items([['iron_pickaxe', 1]])
  legacy.hold('iron_pickaxe')
  legacy.ore('diamond', 'diamond_ore', { x: 1, y: 65, z: 0 })
  assert.equal(legacy.next().type, 'mine_ore', 'old fixtures without any durability fields retain their planning contract')
  assert.equal(legacy.next().requiresKnownDurability, true)
  assert.equal(legacy.state.inventory.items[0].durabilityRemaining, undefined)
})
