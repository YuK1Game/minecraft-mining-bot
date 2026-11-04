'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/diamond-planner')
const { createInteractions } = require('../src/interactions')
const { placementTopVisible } = require('../src/action-access')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function fixture (captured = false) {
  const capture = captured ? require('./fixtures/table-placement-leaf-litter.json') : null
  const state = capture ? copy(capture.state) : { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, threatPolicy: 'online_learning' }
  state.runtimeEntityId = '273'; state.equipmentServerConfirmed = true
  const blocks = new Map((capture?.blocks ?? []).map(b => [key(b.position), copy(b)]))
  const set = (p, name, extra = {}) => blocks.set(key(p), { known: true, position: copy(p), name: 'minecraft:' + name, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [], ...extra })
  if (!capture) for (let x = -5; x <= 10; x++) for (let y = 64; y <= 69; y++) for (let z = -5; z <= 5; z++) set({ x, y, z }, y === 64 ? 'grass_block' : 'air')
  const getBlock = p => blocks.get(key(p)) ?? { known: false, position: p }
  const packets = [], transactions = []
  let inventory = [], raw = []
  const items = entries => {
    inventory = entries.map(([name, count], slot) => ({ slot, name: 'minecraft:' + name, count, ...(name.endsWith('_pickaxe') ? { durabilityKnown: true, durabilityRemaining: 100 } : {}) }))
    state.inventory = { known: true, items: inventory }
    state.selectedSlot = state.rawSelectedSlot = 0; state.heldItem = copy(inventory[0])
    raw = Array.from({ length: 36 }, empty)
    for (const item of inventory) raw[item.slot] = { ...empty(), network_id: 777 + item.slot, count: item.count, has_stack_id: true, stack_id: 100 + item.slot, block_runtime_id: 1 }
  }
  items([['stone_pickaxe', 1], ['furnace', 1]])
  const world = { getBlock: (x, y, z) => getBlock({ x, y, z }) }
  const input = { stats: () => ({ running: true }), lookAt () {}, start () {}, stop () {}, sendTransaction: (packet, options) => { transactions.push(packet); options?.onSent?.() } }
  const interactions = createInteractions({ client: { queue: (...args) => packets.push(args) }, getState: () => state, world, crafting: { rawItem: slot => copy(raw[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: inventory.map(item => ({ ...item, stackId: raw[item.slot].stack_id })) }), applyPacket () {} }, getInput: () => input })
  const observations = { blocks: [...blocks.values()], capabilities: { move: true, movement: true, craft: true, place_block: true, place_furnace: true, open_furnace: true, furnace: true, use_table: true, scan_blocks: true }, crafting: { previews: {} }, drops: [], ores: { coal: [], iron: [], diamond: [] } }
  const refresh = () => { observations.blocks = [...blocks.values()] }
  const preview = name => { observations.crafting.previews[name] = { ready: true, output: { name: 'minecraft:' + name, count: 1 }, times: 1 } }
  return { state, capture, blocks, set, getBlock, world, items, observations, refresh, preview, interactions, transactions, packets, next: () => nextDiamondAction(state, observations) }
}

test('captured leaf-litter furnace placement uses ordinary Native movement then a current real preview with unchanged raw', t => {
  const f = fixture(true), before = copy(f.state.rawServerPosition)
  const blocked = { x: -39, y: 70, z: 37 }
  f.observations.furnacePlacement = { ready: true, position: blocked }
  assert.equal(f.interactions.previewPlace({ position: blocked, slot: 1 }).ready, false)
  const move = f.next()
  assert.equal(move.type, 'move_to'); assert.equal(move.placementPurpose, 'furnace')
  assert.equal(move.requiresReobservation, true); assert.equal(move.interactionTarget, undefined)
  assert.deepEqual(move.target, { x: -40.5, y: 70, z: 39.5 })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { createPhysics } = require('../src/physics'), { createMovement } = require('../src/movement')
  const physics = createPhysics({ world: f.world, version: '1.26.60' })
  const origin = { ...copy(f.state), positionUpdatedAt: f.capture.observedAt, rawServerPositionUpdatedAt: f.capture.observedAt, rotation: { yaw: 0, pitch: 0 } }
  let time = 20000
  const receipts = []
  const movement = createMovement({ world: f.world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: time, clock: () => time, getState: () => copy(origin), client: { queue: (name, packet) => ({ tick: packet.tick }) }, onQueuedFrame: frame => receipts.push(frame), onPrediction: prediction => { f.state.position = copy(prediction.position); f.state.positionSource = prediction.source; f.state.predicted = prediction } })
  t.after(() => movement.stop())
  movement.start(move.target, { sprint: false })
  for (let n = 0; n < 80 && movement.snapshot().running; n++) { time += 50; t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().phase, 'awaiting_server_confirmation', movement.snapshot().reason)
  assert.equal(movement.snapshot().serverConfirmed, false)
  assert.ok(receipts.length > 1 && receipts.every(receipt => receipt.receiptConfirmed))
  assert.deepEqual(f.state.rawServerPosition, before)
  const place = f.next()
  assert.equal(place.type, 'place_furnace'); assert.equal(place.slot, 1)
  assert.equal(f.interactions.previewPlace({ position: place.target, slot: place.slot }).ready, true)
  assert.equal(placementTopVisible({ state: f.state, target: place.target, getBlock: f.getBlock }).face, 1)
  assert.equal(place.serverConfirmed, undefined)
  assert.equal(f.transactions.length, 0)
})

test('Diamond-owned table placement also skips the captured blocked center and keeps the new AIR metadata separate', () => {
  const f = fixture(true)
  f.items([['wooden_pickaxe', 1], ['cobblestone', 3], ['crafting_table', 1], ['stick', 2]])
  f.observations.tablePlacement = { ready: true, position: { x: -39, y: 70, z: 37 } }
  const move = f.next()
  assert.equal(move.type, 'move_to'); assert.equal(move.placementPurpose, 'crafting_table')
  assert.equal(move.interactionTarget, undefined); assert.equal(move.requiresReobservation, true)
  f.state.position = { ...move.target, y: move.target.y + 1.62 }
  const place = f.next()
  assert.equal(place.type, 'place_crafting_table')
  assert.equal(f.interactions.previewPlace({ position: place.target, slot: 2 }).ready, true)
})

test('unreceived remote furnace or table is history and cannot replace current bootstrap materials', () => {
  for (const kind of ['furnace', 'craftingTable']) {
    const f = fixture(), memo = { known: true, usable: true, serverConfirmed: true, position: { x: 18, y: 65, z: 0 } }
    f.observations.stations = { [kind]: memo }
    if (kind === 'furnace') {
      f.items([['stone_pickaxe', 1], ['cobblestone', 8]])
      f.set({ x: -1, y: 65, z: 1 }, 'crafting_table'); f.refresh(); f.preview('furnace')
      assert.equal(f.next().output, 'minecraft:furnace')
    } else {
      f.items([['stone_pickaxe', 1], ['iron_ingot', 3], ['oak_planks', 4], ['stick', 2]])
      f.preview('crafting_table')
      assert.equal(f.next().output, 'minecraft:crafting_table')
    }
    assert.equal(f.next().type, 'craft', 'current received materials progress instead of repeating a remote move/scan')
    assert.deepEqual(f.observations.stations[kind], memo)
  }
})

test('known furnace and lit-furnace retain actual open contents and never fabricate cooking completion', () => {
  for (const name of ['furnace', 'lit_furnace']) {
    const f = fixture(), p = { x: 2, y: 65, z: -1 }
    f.items([['stone_pickaxe', 1], ['coal', 1], ['stick', 2]])
    f.set(p, name); f.refresh()
    f.observations.furnace = { window: { id: 3, type: 'furnace', coordinates: p }, contentsKnown: true, needsOpen: false, inventoryUncertain: false, slots: [{ slot: 0, role: 'furnace_ingredient', known: true, name: 'minecraft:raw_iron', count: 3 }, { slot: 1, role: 'furnace_fuel', known: true, name: 'minecraft:coal', count: 1 }, { slot: 2, role: 'furnace_output', known: true, name: null, count: 0 }], progress: {} }
    const action = f.next()
    assert.equal(action.type, 'wait'); assert.equal(action.code, 'furnace_cooking')
    assert.notEqual(action.type, 'craft'); assert.equal(action.confirmedBy, undefined)
    f.observations.furnace.slots[2] = { ...f.observations.furnace.slots[2], name: 'minecraft:iron_ingot', count: 1 }
    assert.equal(f.next().type, 'take_furnace_output')
    assert.equal(f.next().count, 1, 'only actual known result slots provide output credit')
  }
})

test('blocked known furnace moves to a full stance whose exact dominant-center opener succeeds', async t => {
  const f = fixture(), target = { x: 3, y: 65, z: 0 }
  f.items([['stone_pickaxe', 1], ['coal', 1], ['raw_iron', 3], ['stick', 2]])
  f.set(target, 'furnace'); f.set({ x: 1, y: 65, z: 0 }, 'oak_log'); f.set({ x: 1, y: 66, z: 0 }, 'oak_log'); f.refresh()
  f.observations.stations = { furnace: { known: true, position: target } }
  // Already held coal/iron reaches the station operation rather than ore work.
  const move = f.next()
  assert.equal(move.type, 'move_to'); assert.equal(move.resource, 'furnace')
  assert.deepEqual(move.stationTarget, target); assert.equal(move.requiresReobservation, true)
  const oldRaw = copy(f.state.rawServerPosition)
  f.state.position = { ...move.target, y: move.target.y + 1.62 }
  assert.equal(f.next().type, 'open_furnace')
  const opened = f.interactions.openFurnace(target, 0)
  opened.catch(() => {})
  t.after(() => f.interactions.cancel('Fixture cleanup'))
  assert.equal(f.transactions.length, 1, 'the real opener accepts this working pose and exact center face')
  assert.deepEqual(f.state.rawServerPosition, oldRaw)
  f.interactions.cancel('No server response is synthesized')
  await assert.rejects(opened)
})

test('a received furnace containing real iron, or a lit furnace, cannot become a duplicate when access is unknown', () => {
  for (const name of ['furnace', 'lit_furnace']) {
    const f = fixture(), target = { x: 2, y: 65, z: -1 }
    f.items([['stone_pickaxe', 1], ['coal', 1], ['stick', 2]])
    f.blocks.clear(); f.set(target, name); f.refresh()
    f.observations.furnace = { window: { id: 3, type: 'furnace', coordinates: target }, needsOpen: true, contentsKnown: true, inventoryUncertain: false, slots: [{ slot: 0, role: 'furnace_ingredient', known: true, name: 'minecraft:raw_iron', count: 3 }, { slot: 1, role: 'furnace_fuel', known: true, name: 'minecraft:coal', count: 1 }, { slot: 2, role: 'furnace_output', known: true, name: null, count: 0 }] }
    const action = f.next()
    assert.equal(action.type, 'wait'); assert.equal(action.code, 'station_access_unproven')
    assert.notEqual(action.type, 'craft'); assert.notEqual(action.type, 'place_furnace')
    assert.equal(action.confirmedBy, undefined)
  }
})

test('protected, unknown, replaced and unsafe supplied stations/placement never authorize a mutation', () => {
  for (const kind of ['protected', 'unknown', 'replaced']) {
    const f = fixture(), p = { x: 2, y: 65, z: -1 }
    f.observations.stations = { furnace: { known: true, serverConfirmed: true, position: p } }
    f.set(p, kind === 'replaced' ? 'stone' : 'furnace', kind === 'protected' ? { protected: true } : kind === 'unknown' ? { known: false } : {})
    f.refresh()
    const action = f.next()
    assert.equal(action.type, 'place_furnace', kind)
    assert.notDeepEqual(action.target, p)
    assert.equal(f.interactions.previewPlace({ position: action.target, slot: 1 }).ready, true)
  }
  const f = fixture(), p = { x: 2, y: 65, z: -1 }
  f.observations.furnacePlacement = { ready: true, position: p }
  f.set(p, 'air', { protected: true }); f.refresh()
  assert.notDeepEqual(f.next().target, p)
  assert.equal(f.transactions.length, 0)
})
