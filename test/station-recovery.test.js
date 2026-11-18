'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMining } = require('../src/actions/mining')
const { createStationRecovery } = require('../src/actions/station-recovery')
const { createInventoryStore } = require('../src/inventory/inventory-store')

function fixture (t, { item = 'crafting_table' } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-18T01:30:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, selectedSlot: 0, heldItem: null }
  const target = { x: 1, y: 65, z: 0, accessPreparation: 'owned_station', expectedName: `minecraft:${item}`, ownershipKey: 'placed:current:1,65,0', expectedRuntimeId: 921 }
  const ids = new Map([[58, 'minecraft:crafting_table'], [61, 'minecraft:furnace'], [257, 'minecraft:iron_pickaxe'], [3, 'minecraft:dirt']])
  const inventory = createInventoryStore()
  inventory.apply('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, () => ({ network_id: 0, count: 0 })) })
  const getState = () => ({ ...state, inventory: { known: inventory.known('main'), items: inventory.view('main').slots.filter(slot => slot.raw?.count > 0).map(slot => ({ slot: slot.slot, name: ids.get(slot.raw.network_id), count: slot.raw.count })), ...state.inventoryOverride } })
  const receiveItem = (name, count = 1, slot = 0) => inventory.apply('inventory_slot', { window_id: 'inventory', slot, item: { network_id: [...ids].find(([, value]) => value === name)?.[0] ?? 0, count, has_stack_id: true, stack_id: slot + 90 } })
  if (item === 'furnace') { receiveItem('minecraft:iron_pickaxe'); state.heldItem = { name: 'minecraft:iron_pickaxe', durabilityKnown: true, durabilityRemaining: 20 } }
  const key = p => `${p.x},${p.y},${p.z}`, blocks = new Map(), actions = [], collected = [], saves = []
  const set = (p, name, runtimeId = 1) => blocks.set(key(p), { position: { x: p.x, y: p.y, z: p.z }, known: true, name: `minecraft:${name}`, runtimeId, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
  set({ x: 0, y: 64, z: 0 }, 'stone'); set(target, item, 921)
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0, extra: [] } }
  let running = false, owned = true, pending = null, clock = 0, onSleep = null, onCollect = null, onSave = null
  const input = { lookAt () {}, start () { running = true }, stop () { running = false }, sendAction: (...action) => actions.push(action), stats: () => ({ running }) }
  const verifyOwnedStation = (_state, point, block) => owned && point.ownershipKey === target.ownershipKey && (block.name !== 'minecraft:air' || pending?.miningStarted === true)
  const mining = createMining({ getState, world, getInput: () => input, verifyOwnedStation, now: () => clock })
  t.after(() => mining.stop('cleanup'))
  const receiveAir = () => { set(target, 'air', 0); mining.applyPacket('update_block', { position: target, block_runtime_id: 0 }) }
  const options = { getState, getBlock: world.getBlock, mining, verifyOwnedStation, getPending: () => pending, setPending: async (_target, value) => { pending = value; saves.push(structuredClone(value)); await onSave?.(value) }, collect: async (point, options) => { collected.push(point); return onCollect?.(point, options) }, now: () => clock, sleep: async ms => { clock += ms; await onSleep?.(clock) }, timeoutMs: 200, pollMs: 20 }
  const recovery = createStationRecovery(options)
  return { state, getState, target, blocks, world, set, key, actions, mining, receiveAir, receiveItem, inventory, input, recovery, options, collected, saves, pending: () => pending, revoke: () => { owned = false }, onSleep: fn => { onSleep = fn }, onCollect: fn => { onCollect = fn }, onSave: fn => { onSave = fn } }
}

test('actual station mining plus received inventory-slot pickup returns an owned table and clears its pending receipt', async t => {
  const f = fixture(t)
  f.receiveItem('minecraft:crafting_table', 2)
  f.onSleep(() => { assert.equal(f.pending().miningStarted, true); f.receiveAir() })
  f.onCollect(() => { assert.equal(f.mining.snapshot().blockCleared, true); assert.equal(f.pending().blockCleared, true); f.receiveItem('minecraft:crafting_table', 3) })
  const result = await f.recovery.recover(f.target)
  assert.equal(result.ok, true); assert.equal(result.collected, true); assert.equal(result.serverConfirmed, true)
  assert.equal(result.confirmedBy, 'owned_station_air_and_server_inventory')
  assert.equal(f.actions.filter(action => action[0] === 'start_break').length, 1)
  assert.equal(f.collected.length, 1); assert.equal(f.pending(), null)
  assert.equal(f.saves[0].miningStarted, false)
  assert.equal(f.saves[0].inventoryBefore, 2)
  assert.equal(f.inventory.slotInfo('main', 0).source, 'server_inventory_slot')
})

test('an empty furnace uses a confirmed durable pickaxe and also waits for received pickup', async t => {
  const f = fixture(t, { item: 'furnace' })
  f.onSleep(() => f.receiveAir())
  f.onCollect(() => f.receiveItem('minecraft:furnace', 1, 1))
  assert.equal((await f.recovery.recover(f.target)).collected, true)
  assert.equal(f.pending(), null)
})

test('AIR and a successful collect callback without an inventory gain retain the pending station for a later attempt', async t => {
  const f = fixture(t)
  f.onSleep(() => f.receiveAir())
  f.onCollect(() => ({ ok: true, collected: true }))
  await assert.rejects(f.recovery.recover(f.target), { code: 'STATION_RECOVERY_TIMEOUT' })
  assert.equal(f.pending().miningStarted, true); assert.equal(f.pending().blockCleared, true)
  assert.equal(f.mining.snapshot().collected, false)
  f.onCollect(() => f.receiveItem('minecraft:crafting_table'))
  assert.equal((await createStationRecovery(f.options).recover(f.target)).collected, true)
  assert.equal(f.actions.filter(action => action[0] === 'start_break').length, 1, 'reloaded recovery collects the pending drop without digging AIR again')
})

test('predicted or uncertain inventory and a changed life cannot settle a pending pickup', async t => {
  for (const mode of ['prediction', 'uncertain', 'life', 'connection']) {
    const f = fixture(t)
    f.onSleep(() => f.receiveAir())
    f.onCollect(() => {
      f.receiveItem('minecraft:crafting_table')
      if (mode === 'prediction') f.state.inventoryOverride = { source: 'client_prediction' }
      if (mode === 'uncertain') f.state.inventoryOverride = { uncertain: true }
      if (mode === 'life') f.state.lifecycle.deathId++
      if (mode === 'connection') f.state.connectionId = 'new'
    })
    await assert.rejects(f.recovery.recover(f.target), /received inventory|changed connection/, mode)
    assert.equal(f.pending().miningStarted, true, mode)
    assert.notEqual(f.saves.at(-1), null, mode)
  }
})

test('aborting recovery leaves its receipt and never stops a replacement mining operation', async t => {
  const f = fixture(t), controller = new AbortController()
  f.onSleep(() => {
    f.mining.stop('another operator')
    f.mining.start([f.target])
    controller.abort()
  })
  await assert.rejects(f.recovery.recover(f.target, { signal: controller.signal }), { code: 'ABORTED' })
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.equal(f.mining.snapshot().stationRunId, 2)
  assert.equal(f.input.stats().running, true)
  assert.equal(f.pending().miningStarted, true)
})

test('a delayed pending write rechecks current ownership before sending any mining input', async t => {
  const f = fixture(t)
  f.onSave(value => { if (value?.miningStarted === false) f.revoke() })
  await assert.rejects(f.recovery.recover(f.target), { code: 'STATION_OWNERSHIP_UNCONFIRMED' })
  assert.deepEqual(f.actions, [])
})

test('inventory received during pending persistence becomes the baseline, never the mining drop', async t => {
  const f = fixture(t)
  f.onSave(value => { if (value?.miningStarted === false && value.inventoryBefore === 0) f.receiveItem('minecraft:crafting_table') })
  f.onSleep(() => f.receiveAir())
  f.onCollect(() => ({ collected: true }))
  await assert.rejects(f.recovery.recover(f.target), { code: 'STATION_RECOVERY_TIMEOUT' })
  assert.equal(f.pending().inventoryBefore, 1)
  assert.equal(f.pending().blockCleared, true)
})

test('a stuck pickup callback is bounded and receives only its own abort signal', async t => {
  const f = fixture(t)
  let pickupSignal = null
  f.onSleep(() => f.receiveAir())
  f.onCollect((_target, { signal }) => { pickupSignal = signal; return new Promise(() => {}) })
  await assert.rejects(f.recovery.recover(f.target), { code: 'STATION_RECOVERY_TIMEOUT' })
  assert.equal(pickupSignal.aborted, true)
  assert.equal(f.pending().miningStarted, true)
  assert.equal(f.pending().blockCleared, true)
})

test('the owned station exception never allows arbitrary furniture, lit furnaces or an unowned nearby table', t => {
  const f = fixture(t)
  assert.equal(f.mining.preview([f.target]).ready, true)
  assert.equal(f.mining.preview([{ x: 1, y: 65, z: 0 }]).ready, false)
  for (const expectedName of ['minecraft:chest', 'minecraft:lit_furnace', 'minecraft:bed', 'crafting_table']) assert.throws(() => f.mining.preview([{ ...f.target, expectedName }]), /Owned-station/)
  for (const marker of [{ ownershipKey: '' }, { ownershipKey: 'x'.repeat(201) }, { expectedRuntimeId: null }, { expectedRuntimeId: -1 }, { expectedRuntimeId: 4294967296 }]) assert.throws(() => f.mining.preview([{ ...f.target, ...marker }]), /Owned-station/)
  const missingVerifier = createMining({ getState: f.getState, world: f.world, getInput: () => f.input })
  assert.equal(missingVerifier.preview([f.target]).ready, false)
  f.revoke()
  assert.equal(f.mining.preview([f.target]).ready, false)
  assert.deepEqual(f.actions, [])
})

test('owned station mining preserves terrain, protection, received inventory and durability checks', t => {
  for (const mode of ['unknown', 'wrong_runtime', 'wrong_block', 'protected', 'water', 'neighbour', 'support', 'full', 'prediction', 'tool', 'durability', 'selected']) {
    const f = fixture(t, { item: 'furnace' })
    if (mode === 'unknown') f.blocks.set(f.key(f.target), { known: false })
    if (mode === 'wrong_runtime') f.set(f.target, 'furnace', 922)
    if (mode === 'wrong_block') f.set(f.target, 'lit_furnace', 921)
    if (mode === 'protected') f.blocks.get(f.key(f.target)).protected = true
    if (mode === 'water') f.blocks.get(f.key(f.target)).extra = [{ name: 'minecraft:water' }]
    if (mode === 'neighbour') f.blocks.set('2,65,0', { known: false })
    if (mode === 'support') f.blocks.set('0,64,0', { known: false })
    if (mode === 'full') for (let slot = 0; slot < 36; slot++) f.receiveItem('minecraft:dirt', 64, slot)
    if (mode === 'prediction') f.state.inventoryOverride = { source: 'client_prediction' }
    if (mode === 'tool') f.state.heldItem = null
    if (mode === 'durability') f.state.heldItem.durabilityRemaining = 1
    if (mode === 'selected') f.state.selectedSlot = 1
    assert.equal(f.mining.preview([f.target]).ready, false, mode)
    assert.deepEqual(f.actions, [], mode)
  }
})

test('a full received bag may recover only into an existing non-full stack of the exact station', t => {
  const f = fixture(t)
  for (let slot = 0; slot < 36; slot++) f.receiveItem('minecraft:dirt', 64, slot)
  assert.equal(f.mining.preview([f.target]).ready, false)
  f.receiveItem('minecraft:crafting_table', 63, 2)
  assert.equal(f.mining.preview([f.target]).ready, true)
  f.receiveItem('minecraft:crafting_table', 64, 2)
  assert.equal(f.mining.preview([f.target]).ready, false)
})

test('block packets are only wake-ups, and scope or ownership changes reject even simultaneous received AIR', async t => {
  for (const mode of ['packet_only', 'life', 'connection', 'revoked', 'protected']) {
    const f = fixture(t)
    // The actual recovery controller persists this before starting its dig.
    await f.options.setPending(f.target, { miningStarted: true })
    f.mining.start([f.target])
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'connection') f.state.connectionId = 'new'
    if (mode === 'revoked') f.revoke()
    if (mode === 'packet_only') f.mining.applyPacket('update_block', { position: f.target, block_runtime_id: 0 })
    else f.receiveAir()
    if (mode === 'protected') f.blocks.get(f.key(f.target)).protected = true
    await Promise.resolve()
    assert.equal(f.mining.snapshot().phase, mode === 'packet_only' ? 'mining' : 'failed', mode)
    assert.equal(f.mining.snapshot().serverConfirmed, false, mode)
    assert.equal(f.mining.snapshot().collected, false, mode)
  }
})
