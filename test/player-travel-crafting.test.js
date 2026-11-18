'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createPlayerTravelCrafting } = require('../src/travel/player-travel-crafting')
const { createRuntimeOperations } = require('../src/runtime/runtime-operations')
const { createPlayerWorkstationRuntime } = require('../src/modes/player-workstation-runtime')
const { createInteractions } = require('../src/actions/interactions')
const { createMining } = require('../src/actions/mining')
const { createInventoryStore } = require('../src/inventory/inventory-store')
const { ownsStation } = require('../src/modes/player-workstations')

// The wire peer supplies placement/open responses and recipe inventory. Table
// placement, Runtime registration, mining, ledger and received pickup are real.
function fixture (t, { carried = true, nearby = false, planks = 5, logs = 0 } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'c1', startedAt: '2026-11-18T00:00:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, heldItem: null }
  const shared = { botMode: 'player', playerWanted: true }, store = createInventoryStore(), names = new Map([[777, 'minecraft:crafting_table'], [778, 'minecraft:oak_boat'], [779, 'minecraft:oak_planks'], [780, 'minecraft:oak_log'], [781, 'minecraft:bed'], [782, 'minecraft:white_wool']])
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const raw = (id, count = 1) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: id + 100, block_runtime_id: 300, extra })
  store.apply('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty) })
  const receive = (id, count, slot) => store.apply('inventory_slot', { window_id: 'inventory', slot, item: count > 0 ? raw(id, count) : empty() })
  if (carried) receive(777, 1, 0)
  if (planks) receive(779, planks, 1)
  if (logs) receive(780, logs, 3)
  const inventory = () => ({ known: store.known('main'), items: store.view('main').slots.filter(s => s.raw?.count > 0).map(s => ({ slot: s.slot, name: names.get(s.raw.network_id), count: s.raw.count, stackId: s.raw.stack_id })) })
  const getState = () => ({ ...state, inventory: inventory() })
  const blocks = new Map(), key = p => `${p.x},${p.y},${p.z}`
  const set = (p, name, runtimeId = 300) => blocks.set(key(p), { position: { x: p.x, y: p.y, z: p.z }, known: true, name, runtimeId, properties: {}, extra: [], boundingBox: name === 'minecraft:air' ? 'empty' : 'block' })
  const getBlock = (x, y, z) => blocks.get(key({ x, y, z })) ?? { position: { x, y, z }, known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', runtimeId: y < 65 ? 1 : 0, properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }
  if (nearby) set({ x: 1, y: 65, z: 0 }, 'minecraft:crafting_table')
  const events = [], crafts = []
  let clock = Date.now() + 100, running = false, blocked = false, rejectCraft = false, collect = true, openContainer = null, motion = { phase: 'idle' }
  const crafting = { rawItem: slot => store.raw('main', slot), snapshot: () => ({ authority: true, inventoryKnown: store.known('main'), inventory: inventory().items, openContainer }),
    preview: output => output === 'minecraft:crafting_table' && store.raw('main', 1).count >= 4 ? { ready: true, materials: [{ slot: 1, name: 'minecraft:oak_planks', count: 4 }] } : { ready: false },
    applyPacket: (name, packet) => store.apply(name, packet), closeContainer: () => { openContainer = null }, openInventory: async () => { openContainer = { id: 2, type: 'inventory' } },
    craft: async (output, { times }) => {
      crafts.push({ output, times })
      if (rejectCraft && output.endsWith('_boat')) throw Error('recipe refused')
      const count = slot => store.raw('main', slot).count
      if (output === 'minecraft:oak_planks') { assert.ok(count(3) >= times); receive(780, count(3) - times, 3); receive(779, count(1) + times * 4, 1) }
      else if (output === 'minecraft:crafting_table') { assert.ok(count(1) >= 4); receive(779, count(1) - 4, 1); receive(777, 1, 0) }
      else if (output === 'minecraft:oak_boat') { assert.ok(count(1) >= 5); receive(779, count(1) - 5, 1); receive(778, 1, 2) }
      else if (output === 'minecraft:bed') { assert.ok(count(1) >= 3 && count(4) >= 3); receive(779, count(1) - 3, 1); receive(782, count(4) - 3, 4); receive(781, 1, 2) }
      else throw Error(`unexpected recipe ${output}`)
      return { phase: 'completed', serverConfirmed: true }
    }
  }
  let interactions
  const input = { stats: () => ({ running }), lookAt () {}, start () { running = true }, stop () { running = false }, sendAction: (...args) => events.push(args),
    sendTransaction (packet, options) {
      events.push(['transaction', packet]); options.onSent()
      queueMicrotask(() => {
        clock = Math.max(clock, Date.now() + 100)
        if (packet.actions.length) {
          const p = packet.data.block_position, offset = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }][packet.data.face]
          set({ x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z }, 'minecraft:crafting_table')
          const slot = packet.data.hotbar_slot
          receive(777, store.raw('main', slot).count - 1, slot)
          interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot, item: store.raw('main', slot) })
        } else {
          openContainer = { id: 4, type: 'workbench' }
          interactions.applyPacket('container_open', { window_id: 4, window_type: 'workbench', coordinates: packet.data.block_position })
        }
      })
    }
  }
  interactions = createInteractions({ client: { queue () {} }, getState, world: { getBlock }, crafting, getInput: () => input, timeoutMs: 500, onInventory: packet => store.apply('inventory_content', packet) })
  const mining = createMining({ getState, world: { getBlock }, getInput: () => input, verifyOwnedStation: (s, target, block) => ownsStation({ shared, state: s, target, block, now: clock }), now: () => clock })
  t.after(() => { mining.stop('cleanup'); interactions.cancel('cleanup') })
  const sleep = async ms => { clock += ms; const target = mining.snapshot().activeTarget; if (target) { set(target, 'minecraft:air', 0); mining.applyPacket('update_block', { position: target, block_runtime_id: 0 }); await Promise.resolve() } }
  const nativeRequire = createRequire(path.resolve(__dirname, '..', 'src', 'runtime.js'))
  const rt = { host: { shared, world: { getBlock }, log: text => events.push(['log', text]), setEquipmentPrediction () {} }, working: getState, raw: getState, actualLifeId: () => state.lifecycle.deathId,
    interactions, crafting, mining, furnace: { snapshot: () => ({}) }, inventory: { equip: async () => ({ phase: 'completed', serverConfirmed: true }) }, longTravelLogAllowance: () => true,
    userBehaviorOwns: () => blocked, requireIdle () { if (blocked) throw Error('controls held') }, portableKeys: () => new Set(), planningWorld: { getBlock }, readCurrentTunnelFloors: () => [], portableMovementOptions: (_target, options) => options,
    movement: { preview: () => ({ ready: true }), snapshot: () => motion, stop: () => { motion.phase = 'stopped' } },
    startMotion: (_kind, to) => { state.position = { ...to, y: to.y + 1.62 }; motion = { phase: 'completed', timingDiagnostics: { start: { at: ++clock } } }; if (collect && shared.playerWorkstations.records.some(record => record.pending?.blockCleared)) receive(777, 1, 0); return motion },
    require: name => name === './modes/mode-runtime' ? { attachModeOperations () {} } : name === './modes/player-workstation-runtime' ? { createPlayerWorkstationRuntime: options => createPlayerWorkstationRuntime({ ...options, file: null, now: () => clock, sleep }) } : nativeRequire(name)
  }
  rt.operations = createRuntimeOperations(rt).operations
  const travel = createPlayerTravelCrafting(rt, { now: () => clock })
  return { travel, rt, state, shared, store, inventory, crafts, events, getBlock, receive, advance: ms => { clock += ms }, block: value => { blocked = value }, reject: value => { rejectCraft = value }, collect: value => { collect = value } }
}

test('player travel uses its carried table through actual placement registration, mining and received pickup without crafting another', async t => {
  const f = fixture(t)
  assert.equal((await f.travel.makeBoat()).ok, true)
  assert.deepEqual(f.crafts, [{ output: 'minecraft:oak_boat', times: 1 }])
  assert.equal(f.events.filter(event => event[0] === 'start_break').length, 1)
  assert.equal(f.inventory().items.find(item => item.name === 'minecraft:crafting_table').count, 1)
  assert.equal(f.rt.operations.playerWorkstations.snapshot().pending.length, 0)
  assert.equal(f.store.slotInfo('main', 0).source, 'server_inventory_slot')
})

test('a nearby borrowed table is reused without placement, table manufacture or mining', async t => {
  const f = fixture(t, { carried: false, nearby: true })
  assert.equal((await f.travel.makeBoat()).ok, true)
  assert.deepEqual(f.crafts, [{ output: 'minecraft:oak_boat', times: 1 }])
  assert.equal(f.getBlock(1, 65, 0).name, 'minecraft:crafting_table')
  assert.equal(f.events.filter(event => event[0] === 'start_break').length, 0)
  assert.equal(f.shared.playerWorkstations.records.length, 0)
})

test('only missing boat planks are converted and a refused craft still recovers its owned table', async t => {
  const f = fixture(t, { planks: 1, logs: 3 })
  f.reject(true)
  await assert.rejects(f.travel.makeBoat(), /recipe refused/)
  assert.deepEqual(f.crafts, [{ output: 'minecraft:oak_planks', times: 1 }, { output: 'minecraft:oak_boat', times: 1 }])
  assert.equal(f.inventory().items.find(item => item.name === 'minecraft:oak_log').count, 2)
  assert.equal(f.rt.operations.playerWorkstations.snapshot().pending.length, 0)
  assert.equal(f.events.filter(event => event[0] === 'start_break').length, 1)
})

test('a table is crafted only when absent, and an unconfirmed pickup remains in the real shared ledger', async t => {
  const f = fixture(t, { carried: false, planks: 9 })
  f.collect(false)
  assert.equal((await f.travel.makeBoat()).ok, true)
  assert.deepEqual(f.crafts, [{ output: 'minecraft:crafting_table', times: 1 }, { output: 'minecraft:oak_boat', times: 1 }])
  const pending = f.rt.operations.playerWorkstations.snapshot().pending[0]
  assert.equal(pending.pending.miningStarted, true)
  assert.equal(pending.pending.blockCleared, true)
  assert.equal(pending.lastCode, 'STATION_RECOVERY_TIMEOUT')
})

test('normal operation guards and cancellation stop player travel before crafting or placement', async t => {
  const f = fixture(t)
  f.block(true)
  await assert.rejects(f.travel.makeBoat(), /controls held/)
  assert.deepEqual(f.crafts, [])
  f.block(false)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.travel.makeBoat(controller.signal), { code: 'PLAYER_TRAVEL_CRAFT_INTERRUPTED' })
  assert.equal(f.events.filter(event => event[0] === 'transaction').length, 0)
})

test('another travel preparation retries a pending owned table before creating a replacement', async t => {
  const f = fixture(t, { carried: false, planks: 9 })
  f.collect(false)
  assert.equal((await f.travel.makeBoat()).ok, true)
  f.receive(778, 0, 2); f.receive(779, 9, 1); f.advance(300001)
  await assert.rejects(f.travel.makeBoat(), { code: 'PLAYER_TRAVEL_TABLE_PENDING' })
  assert.equal(f.crafts.filter(craft => craft.output === 'minecraft:crafting_table').length, 1)
  assert.equal(f.shared.playerWorkstations.records[0].pending.miningStarted, true)
})

test('travel bed crafting with a carried table needs only the three bed planks and returns that table', async t => {
  const f = fixture(t, { planks: 3 })
  f.receive(782, 3, 4)
  assert.equal((await f.travel.makeBed()).ok, true)
  assert.deepEqual(f.crafts, [{ output: 'minecraft:bed', times: 1 }])
  assert.equal(f.inventory().items.find(item => item.name === 'minecraft:crafting_table').count, 1)
  assert.equal(f.rt.operations.playerWorkstations.snapshot().pending.length, 0)
})
