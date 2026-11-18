'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createRuntimeOperations } = require('../src/runtime/runtime-operations')
const { createPlayerWorkstationRuntime } = require('../src/modes/player-workstation-runtime')
const { createInteractions } = require('../src/actions/interactions')
const { createMining } = require('../src/actions/mining')
const { createInventoryStore } = require('../src/inventory/inventory-store')
const { createStoragePorts } = require('../src/modes/player-storage-ports')
const { withWorkstationCleanup, ownsStation } = require('../src/modes/player-workstations')
const { stationWorldScope } = require('../src/survival/supply-return')

// Actual interaction placement receipts, actual Runtime operations, actual
// mining and InventoryStore. Only the wire peer and walking physics are fake.
function fixture (t) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'c1', startedAt: '2026-11-18T00:00:00.000Z', runtimeEntityId: '41',
    dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', health: 20, playerPlay: true,
    position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, heldItem: null }
  const shared = { botMode: 'player', playerWanted: true }, store = createInventoryStore(), names = new Map([[777, 'minecraft:crafting_table'], [778, 'minecraft:chest']])
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const item = (id, count = 1) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: id + 100, block_runtime_id: 300, extra })
  store.apply('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty) })
  const inventory = () => ({ known: store.known('main'), items: store.view('main').slots.filter(s => s.raw?.count > 0).map(s => ({ slot: s.slot, name: names.get(s.raw.network_id), count: s.raw.count, stackId: s.raw.stack_id })) })
  const getState = () => ({ ...state, inventory: inventory() })
  const receive = (raw, slot = 0) => store.apply('inventory_slot', { window_id: 'inventory', slot, item: raw })
  receive(item(777))
  const blocks = new Map(), key = p => `${p.x},${p.y},${p.z}`, target = { x: 2, y: 65, z: 0 }
  const set = (p, name, runtimeId = 30) => blocks.set(key(p), { position: { ...p }, known: true, name, runtimeId, properties: {}, extra: [], boundingBox: name === 'minecraft:air' ? 'empty' : 'block' })
  const getBlock = (x, y, z) => blocks.get(key({ x, y, z })) ?? { position: { x, y, z }, known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', runtimeId: y < 65 ? 1 : 0, properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }
  const events = [], moves = [], saved = []
  let clock = Date.now(), running = false, blocked = false, collect = true, breakBlock = true, sleepHook = null, motion = { phase: 'idle' }
  const input = { stats: () => ({ running }), lookAt () {}, start () { running = true }, stop () { running = false },
    sendTransaction: (packet, options) => { events.push(['place', packet]); options?.onSent?.() }, sendAction: (...args) => events.push(args) }
  const crafting = { rawItem: slot => store.raw('main', slot), snapshot: () => ({ authority: true, inventoryKnown: store.known('main'), inventory: inventory().items }),
    applyPacket: (name, packet) => store.apply(name, packet), closeContainer () {}, openInventory: async () => {}, craft: async output => { if (output === 'minecraft:chest') receive(item(778, 2), 1) } }
  const interactions = createInteractions({ client: { queue () {} }, getState, world: { getBlock }, crafting, getInput: () => input, timeoutMs: 500,
    onInventory: packet => store.apply('inventory_content', packet) })
  const mining = createMining({ getState, world: { getBlock }, getInput: () => input, verifyOwnedStation: (s, p, b) => ownsStation({ shared, state: s, target: p, block: b, now: clock }), now: () => clock })
  t.after(() => { mining.stop('test cleanup'); interactions.cancel('test cleanup') })
  const sleep = async ms => {
    clock += ms
    await sleepHook?.()
    const active = mining.snapshot().activeTarget
    if (breakBlock && active && mining.snapshot().phase === 'mining') {
      set(active, 'minecraft:air', 0); mining.applyPacket('update_block', { position: active, block_runtime_id: 0 })
      await Promise.resolve()
    }
  }
  const nativeRequire = createRequire(path.resolve(__dirname, '..', 'src', 'runtime.js'))
  const rt = { host: { shared, world: { getBlock }, log: text => events.push(['log', text]), setEquipmentPrediction () {} }, working: getState, raw: getState, actualLifeId: () => state.lifecycle.deathId,
    interactions, crafting, mining, furnace: { snapshot: () => ({}) }, inventory: { equip: async () => ({ phase: 'completed', serverConfirmed: true }) },
    userBehaviorOwns: () => blocked, requireIdle () { if (blocked) throw Error('controls held') }, portableKeys: () => new Set(), planningWorld: { getBlock }, readCurrentTunnelFloors: () => [],
    portableMovementOptions: (_target, options) => options, movement: { preview: () => ({ ready: true }), snapshot: () => motion, stop: () => { motion = { ...motion, phase: 'stopped' } } },
    startMotion: (_kind, to) => {
      moves.push({ ...to }); state.position = { ...to, y: to.y + 1.62 }; motion = { phase: 'completed', timingDiagnostics: { start: { at: ++clock } } }
      if (collect && shared.playerWorkstations.records.some(r => r.pending?.blockCleared)) receive(item(777))
      return motion
    },
    require: name => name === './modes/mode-runtime' ? { attachModeOperations () {} } : name === './modes/player-workstation-runtime' ? {
      createPlayerWorkstationRuntime: options => createPlayerWorkstationRuntime({ ...options, file: 'memory-only', write: async (_file, value) => saved.push(structuredClone(value)), now: () => clock, sleep })
    } : nativeRequire(name)
  }
  const operations = createRuntimeOperations(rt).operations
  async function place (position = target) {
    clock = Math.max(clock, Date.now())
    const pending = operations.interactions.placeCraftingTable({ position, slot: 0 })
    set(position, 'minecraft:crafting_table', 300)
    receive(empty())
    interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: empty() })
    clock = Math.max(clock, Date.now())
    return pending
  }
  return { state, shared, store, inventory, operations, target, getBlock, set, events, moves, saved, place, sleep,
    receive: (id, count = 1, slot = 0) => receive(count ? item(id, count) : empty(), slot), now: () => clock, advance: ms => { clock += ms },
    block: value => { blocked = value }, collect: value => { collect = value }, breaking: value => { breakBlock = value }, onSleep: hook => { sleepHook = hook } }
}

test('real placement receipts flow through Runtime into owned recovery and received pickup; one table is reused at two sites', async t => {
  const f = fixture(t)
  const first = await f.place()
  assert.equal(first.confirmedBy, 'server_block_and_inventory')
  const record = f.shared.playerWorkstations.records[0]
  assert.ok(record, 'Runtime placement must register the actual temporary table')
  assert.equal(f.operations.playerWorkstations.observe().recoverTable.workstationId, record.id)
  assert.equal((await f.operations.playerWorkstations.recover(record.id)).collected, true)
  assert.equal(f.getBlock(2, 65, 0).name, 'minecraft:air')
  assert.equal(f.store.slotInfo('main', 0).source, 'server_inventory_slot')
  assert.ok(f.moves.every(p => p.x % 1 === 0.5 && p.z % 1 === 0.5), 'pickup walks to cell centers')
  assert.equal(f.shared.stations.craftingTable, undefined)
  f.state.position = { x: 10.5, y: 66.62, z: 0.5 }
  await f.place({ x: 12, y: 65, z: 0 })
  const second = f.shared.playerWorkstations.records[0]
  assert.notEqual(second.id, record.id)
  assert.equal((await f.operations.playerWorkstations.recover(second.id)).collected, true)
  assert.equal(f.inventory().items.filter(i => i.name === 'minecraft:crafting_table')[0].count, 1)
  assert.equal(f.events.filter(e => e[0] === 'place').length, 2)
  assert.equal(f.events.filter(e => e[0] === 'start_break').length, 2)
  assert.equal(f.operations.playerWorkstations.snapshot().pending.length, 0)
})

test('the actual storage crafting port reclaims its own table on a refused chest craft', async t => {
  const f = fixture(t); await f.place()
  f.operations.interactions.openCraftingTable = async () => {}
  f.operations.crafting.craft = async () => { throw Error('server refused craft') }
  const ports = createStoragePorts({ operations: f.operations, getBlock: f.getBlock, getFeet: () => ({ ...f.state.position, y: 65 }), getInventory: f.inventory, now: f.now, sleep: f.sleep })
  assert.equal(await ports.craftAtTable(f.target, 'minecraft:chest', 2), false)
  assert.equal(f.operations.playerWorkstations.snapshot().pending.length, 0)
  assert.equal(f.inventory().items[0].name, 'minecraft:crafting_table')
})

test('an interrupted pickup stays pending across controller reload and never mines the cleared table twice', async t => {
  const f = fixture(t); await f.place()
  const record = f.shared.playerWorkstations.records[0]
  const abort = new AbortController()
  f.onSleep(() => { if (record.pending?.blockCleared) abort.abort() })
  f.collect(false)
  await assert.rejects(f.operations.playerWorkstations.recover(record.id, { signal: abort.signal }))
  assert.equal(record.pending.miningStarted, true)
  f.collect(true); f.onSleep(null)
  const reloaded = createPlayerWorkstationRuntime({ shared: f.shared, getState: () => ({ ...f.state, inventory: f.inventory() }), getBlock: f.getBlock, getMotion: () => ({}), getFurnace: () => ({}), operations: f.operations, now: f.now, sleep: f.sleep, file: null })
  assert.equal((await reloaded.recover(record.id)).collected, true)
  assert.equal(f.events.filter(e => e[0] === 'start_break').length, 1)
})

test('ordinary departure packs stations, but station access, emergency safety and quarry decisions do not', () => {
  const recovery = { type: 'recover_workstation', target: { x: 2, y: 65, z: 0 }, workstationId: 'owned' }
  const observation = { enabled: true, recoverTable: recovery }
  const depart = { type: 'move_to', target: { x: 15, y: 65, z: 0 }, stage: 'iron' }
  assert.equal(withWorkstationCleanup({ mode: 'player', decision: depart, observation }), recovery)
  for (const decision of [{ ...depart, stationTarget: recovery.target }, { ...depart, interactionTarget: recovery.target }, { ...depart, placementPurpose: 'table' }, { ...depart, stage: 'safety' }, { ...depart, stage: 'portable_worksite' }, { type: 'craft', output: 'stone_pickaxe' }]) {
    assert.equal(withWorkstationCleanup({ mode: 'player', decision, observation }), decision)
  }
  assert.equal(withWorkstationCleanup({ mode: 'quarry', decision: depart, observation }), depart)
})

test('an interrupted retrieval cannot clear the authorization of its replacement owner', async t => {
  const f = fixture(t); await f.place()
  const record = f.shared.playerWorkstations.records[0], abort = new AbortController()
  let successor = null
  f.onSleep(() => {
    if (successor) return
    abort.abort()
    successor = { ...record.authorization, replacement: true }
    record.authorization = successor
  })
  await assert.rejects(f.operations.playerWorkstations.recover(record.id, { signal: abort.signal }))
  assert.ok(successor)
  assert.equal(record.authorization, successor)
})

test('a recovery cooldown prevents immediate table manufacture and never erases another world catalog', async t => {
  const f = fixture(t); await f.place()
  const record = f.shared.playerWorkstations.records[0]
  const entry = { kind: 'craftingTable', position: { ...f.target } }, worldScope = stationWorldScope(f.state)
  f.shared.stationCatalog = { version: 1, scopes: { [worldScope]: { entries: [entry] }, other: { entries: [entry] } } }
  f.breaking(false)
  assert.equal((await f.operations.playerWorkstations.recover(record.id)).phase, 'deferred')
  assert.equal(f.operations.playerWorkstations.observe().recoverTable.type, 'wait')
  f.breaking(true); f.advance(60001)
  assert.equal((await f.operations.playerWorkstations.recover(record.id)).collected, true)
  assert.equal(f.shared.stationCatalog.scopes[worldScope].entries.length, 0)
  assert.equal(f.shared.stationCatalog.scopes.other.entries.length, 1)
})
