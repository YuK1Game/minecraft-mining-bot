'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryCapacityBatch, fullDropBudget, chooseCapacityPrefix } = require('../src/quarry-capacity-batch')
const { supplyScope } = require('../src/quarry-supplies')

const cp = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const box = { x: 4, y: 1, z: 4 }, stand = { x: 2, y: 1, z: 4 }, target = { x: 1, y: 1, z: 4 }
function fixture ({ mode = 'normal' } = {}) {
  // Before placement: 34 used slots. The empty box is removed by a received
  // normal placement, leaving exactly three slots for leaves' three drops.
  const before = Array.from({ length: 34 }, (_, slot) => ({ slot, name: slot === 0 ? 'minecraft:undyed_shulker_box' : 'minecraft:diamond_sword', count: 1, stackId: 100 + slot }))
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, maxHealth: 20, profile: 'test', realm: { id: 'realm' }, connectionId: 'connection', startedAt: 'start', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, inventory: { known: true, items: cp(before.slice(1)) } }
  const blocks = new Map([[key(box), { known: true, name: 'minecraft:undyed_shulker_box', runtimeId: 90 }], [key(target), { known: true, name: 'minecraft:oak_leaves', runtimeId: 7 }]])
  let currentWindow, epoch = 1, saved = null, mineCalls = 0, collectCalls = 0, refreshCalls = 0, reconcileCalls = 0, clock = 1000
  const makeWindow = () => ({ busy: false, contentsKnown: true, slotCount: 27, observationSource: 'server_inventory_content', window: { id: 3, epoch, replayed: false, position: cp(box), scope: supplyScope(state) }, slots: Array.from({ length: 27 }, (_, slot) => ({ slot, known: true, count: 0, name: null })) })
  currentWindow = makeWindow()
  const decision = { action: 'mine', stance: cp(stand), tool: { name: 'hand', kind: 'hand' }, targets: [{ position: cp(target), name: 'minecraft:oak_leaves', runtimeId: 7 }] }
  const request = { jobId: 'job', operationId: 'cargo1', selection: { kind: 'shulker', key: 'undyed_shulker_box:stack:100' }, inventoryPolicy: { keepFood: 0, keepLogs: 0, keepCoal: 0, keepPlanks: 0, keepSticks: 0, keepSealBlocks: 0 }, capacityBatch: { decision, beforePlacementItems: before } }
  const input = { request, position: cp(box), stand: cp(stand), ownership: { position: cp(box), name: 'minecraft:undyed_shulker_box', runtimeId: 90, confirmedBy: 'server_block_and_inventory' } }
  const mineReceipt = actionId => ({ actionId, status: 'completed', serverConfirmed: true, confirmedTargets: [cp(target)] })
  let durableMine = null
  const ports = {
    getState: () => cp(state), getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:stone', runtimeId: 2 },
    refreshInventory: async () => { refreshCalls++; return mode !== 'refresh_false' },
    closeContainer: async () => { currentWindow = null; epoch++ },
    openContainer: async () => { epoch++; currentWindow = makeWindow(); if (mode === 'replayed') currentWindow.window.replayed = true; if (mode === 'slot_only') currentWindow.observationSource = 'server_inventory_slot'; return { serverConfirmed: mode !== 'open_sent', confirmedBy: 'server_container_open_and_full_content' } },
    getContainer: () => cp(currentWindow),
    reconcileMine: async ({ actionId }) => { reconcileCalls++; return mode === 'unknown_intent' ? { actionId, status: 'unknown', serverConfirmed: false } : durableMine ?? { actionId, status: 'not_started', serverConfirmed: true } },
    mineBatch: async ({ actionId }) => {
      mineCalls++
      if (mode !== 'no_air') blocks.set(key(target), { known: true, name: 'minecraft:air', runtimeId: 0 })
      durableMine = mineReceipt(actionId)
      if (mode === 'mine_late_throw') throw new Error('interrupted after received air')
      if (mode === 'mine_wrong_id') return { ...durableMine, actionId: 'other' }
      return durableMine
    },
    collectBatch: async ({ actionId }, { onCheckpoint }) => {
      collectCalls++
      const drops = [{ runtimeId: '20', name: 'minecraft:stick', count: 2 }, { runtimeId: '21', name: 'minecraft:apple', count: 2 }, { runtimeId: '22', name: 'minecraft:oak_sapling', count: 2 }]
      await onCheckpoint({ receivedDrops: cp(drops) })
      if (mode !== 'no_gain') {
        for (let i = 0; i < drops.length; i++) if (!state.inventory.items.some(item => item.stackId === 500 + i)) state.inventory.items.push({ slot: [0, 34, 35][i], name: drops[i].name, count: drops[i].count, stackId: 500 + i })
      }
      if (mode === 'collection_life') state.lifecycle.deathId++
      if (mode === 'collect_abort') throw new Error('collection interrupted')
      return { actionId, serverConfirmed: true, receivedDrops: drops, pendingDropIds: mode === 'pending_drop' ? ['22'] : [] }
    },
    now: () => ++clock
  }
  const create = () => createQuarryCapacityBatch(ports)
  const run = (controller = create(), checkpoint = null, options = {}) => controller.workWithContainer({ ...input, checkpoint }, { onCheckpoint: async value => { saved = cp(value) }, ...options })
  return { state, blocks, input, ports, create, run, saved: () => cp(saved), window: () => currentWindow, setWindow: value => { currentWindow = value }, mineCalls: () => mineCalls, collectCalls: () => collectCalls, refreshCalls: () => refreshCalls, reconcileCalls: () => reconcileCalls }
}

test('full drop projection includes every leaf option and chooses only a prefix that fits', () => {
  const f = fixture(); const decision = f.input.request.capacityBatch.decision
  assert.equal(fullDropBudget(decision.targets, decision.tool).length, 3)
  assert.deepEqual(fullDropBudget(decision.targets, decision.tool).map(d => d.name), ['stick', 'apple', 'oak_sapling'])
  assert.throws(() => chooseCapacityPrefix(decision, f.input.request.capacityBatch.beforePlacementItems), /MINING_CAPACITY_REQUIRED/)
  assert.equal(chooseCapacityPrefix(decision, f.state.inventory.items).targets.length, 1)
  const more = cp(decision); more.targets.push({ position: { x: 1, y: 1, z: 5 }, name: 'minecraft:birch_leaves', runtimeId: 8 })
  assert.equal(chooseCapacityPrefix(more, f.state.inventory.items).targets.length, 1)
})

test('one received slot release allows all three leaf drops, then returns ordinary deposits for the held box', async () => {
  const f = fixture(); const r = await f.run()
  assert.equal(r.status, 'completed', r.reason); assert.equal(r.serverConfirmed, true)
  assert.equal(f.mineCalls(), 1); assert.equal(f.collectCalls(), 1)
  assert.equal(r.mineReceipt.actionId, 'cargo1:mine:1')
  assert.equal(r.deposits.length, 3)
  assert.equal(r.deposits.reduce((n, d) => n + d.count, 0), 6)
  assert.equal(r.checkpoint.inventoryEvidence.confirmedBy, 'fresh_main_inventory_and_guaranteed_drops')
  assert.equal(r.checkpoint.inventoryEvidence.observedDrops.length, 3)
  assert.ok(r.checkpoint.containerEvidence.epoch > r.checkpoint.initialEpoch)
  assert.ok(f.refreshCalls() >= 3)
  // The child has neither broken nor recovered its box, nor credited a ledger.
  assert.equal(f.blocks.get(key(box)).name, 'minecraft:undyed_shulker_box')
  assert.equal(f.state.inventory.items.some(item => item.stackId === 100), false)
})

test('unreceived slot release, full cargo, unknown terrain and protected or owned supports never mine', async () => {
  for (const change of [
    f => { f.state.inventory.items = cp(f.input.request.capacityBatch.beforePlacementItems) },
    f => { f.window().slots.forEach(s => { s.count = 64; s.name = 'minecraft:stone' }) },
    f => { f.blocks.set(key(target), { known: false }) },
    f => { f.blocks.set(key(target), { known: true, name: 'minecraft:diamond_ore', runtimeId: 7 }) },
    f => { f.input.request.capacityBatch.decision.targets[0].position = { ...stand, y: stand.y - 1 } },
    f => { f.input.ownership.confirmedBy = 'sent' }
  ]) {
    const f = fixture(); change(f); const r = await f.run()
    assert.equal(r.status, 'blocked'); assert.equal(r.serverConfirmed, false); assert.equal(f.mineCalls(), 0)
  }
})

test('a sent mining result, wrong action ID or absent received air cannot authorize collection', async () => {
  for (const mode of ['no_air', 'mine_wrong_id']) {
    const f = fixture({ mode }); const r = await f.run()
    assert.equal(r.reason, 'CAPACITY_MINE_UNCONFIRMED'); assert.equal(f.collectCalls(), 0)
  }
})

test('entity disappearance without received inventory gain and remaining live drops stay blocked', async () => {
  for (const [mode, reason] of [['no_gain', 'CAPACITY_DROP_INVENTORY_UNCONFIRMED'], ['pending_drop', 'CAPACITY_COLLECTION_UNCONFIRMED']]) {
    const f = fixture({ mode }); const r = await f.run()
    assert.equal(r.reason, reason); assert.equal(r.serverConfirmed, false)
    assert.equal(f.blocks.get(key(box)).name, 'minecraft:undyed_shulker_box')
    assert.ok(f.saved().collectionCheckpoint.receivedDrops.length === 3)
  }
})

test('the pending fixed mine action reconciles received air after reload without mining twice', async () => {
  const f = fixture({ mode: 'mine_late_throw' }); const r = await f.run()
  assert.equal(r.status, 'blocked'); assert.equal(r.checkpoint.phase, 'mining'); assert.equal(f.mineCalls(), 1)
  const resumed = await f.run(f.create(), f.saved())
  assert.equal(resumed.status, 'completed', resumed.reason); assert.equal(f.mineCalls(), 1); assert.equal(f.reconcileCalls(), 1)
  assert.equal(resumed.mineReceipt.actionId, 'cargo1:mine:1')
})

test('an unknown pending mine is never automatically resent or inferred from elapsed time', async () => {
  const f = fixture({ mode: 'mine_late_throw' }); await f.run(); const checkpoint = f.saved()
  f.ports.reconcileMine = async ({ actionId }) => ({ actionId, status: 'unknown', serverConfirmed: false })
  const r = await f.run(f.create(), checkpoint)
  assert.equal(r.reason, 'CAPACITY_MINE_UNCONFIRMED'); assert.equal(f.mineCalls(), 1); assert.equal(f.collectCalls(), 0)
})

test('a new life or connection cannot resume a held box, and collection death cannot succeed', async () => {
  for (const change of [f => { f.state.lifecycle.deathId++ }, f => { f.state.connectionId = 'new' }]) {
    const f = fixture({ mode: 'mine_late_throw' }); await f.run(); change(f)
    const r = await f.run(f.create(), f.saved())
    assert.equal(r.reason, 'CAPACITY_SCOPE_CHANGED'); assert.equal(f.mineCalls(), 1)
  }
  const died = fixture({ mode: 'collection_life' }); const r = await died.run()
  assert.equal(r.reason, 'CAPACITY_SCOPE_CHANGED'); assert.equal(r.serverConfirmed, false)
})

test('fresh main and a genuinely new full open are required; sent, replayed or slot-only opens are insufficient', async () => {
  for (const [mode, reason] of [['refresh_false', 'CAPACITY_INVENTORY_UNCONFIRMED'], ['open_sent', 'CAPACITY_CONTAINER_REOPEN_UNCONFIRMED'], ['replayed', 'CAPACITY_CONTAINER_UNCONFIRMED'], ['slot_only', 'CAPACITY_CONTAINER_REOPEN_UNCONFIRMED']]) {
    const f = fixture({ mode }); const r = await f.run()
    assert.equal(r.reason, reason); assert.equal(r.serverConfirmed, false)
  }
})

test('abort and failed persistence retain the owned box and never dispatch another action', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(Object.assign(new Error('combat'), { code: 'COMBAT' }))
  assert.equal((await f.run(f.create(), null, { signal: controller.signal })).reason, 'COMBAT')
  assert.equal(f.mineCalls(), 0)
  const p = fixture(); const r = await p.run(p.create(), null, { onCheckpoint: async () => { throw new Error('disk') } })
  assert.equal(r.reason, 'CAPACITY_PERSISTENCE_FAILED'); assert.equal(p.mineCalls(), 0)
})

test('a collection interruption preserves received-drop checkpoint and resumes without remine', async () => {
  const f = fixture({ mode: 'collect_abort' }); const r = await f.run()
  assert.equal(r.checkpoint.phase, 'collecting'); assert.equal(f.mineCalls(), 1)
  f.ports.collectBatch = async ({ actionId, checkpoint }) => ({ actionId, serverConfirmed: true, receivedDrops: checkpoint.receivedDrops, pendingDropIds: [] })
  const resumed = await f.run(f.create(), f.saved())
  assert.equal(resumed.status, 'completed', resumed.reason); assert.equal(f.mineCalls(), 1)
})

test('a resumed collector cannot erase previously received drops to hide missing inventory evidence', async () => {
  const f = fixture({ mode: 'collect_abort' }); await f.run()
  f.state.inventory.items = f.state.inventory.items.filter(item => item.stackId < 500)
  f.ports.collectBatch = async ({ actionId }) => ({ actionId, serverConfirmed: true, receivedDrops: [], pendingDropIds: [] })
  const r = await f.run(f.create(), f.saved())
  assert.equal(r.reason, 'CAPACITY_DROP_INVENTORY_UNCONFIRMED')
  assert.equal(r.checkpoint.collectionReceipt.receivedDrops.length, 3)
  assert.equal(f.mineCalls(), 1)
})

test('received unexpected keep-items cannot consume the slot required to recover the owned box', async () => {
  const f = fixture()
  f.ports.collectBatch = async ({ actionId }) => {
    const names = ['minecraft:bow', 'minecraft:arrow', 'minecraft:shield']
    names.forEach((name, i) => f.state.inventory.items.push({ slot: [0, 34, 35][i], name, count: 1, stackId: 500 + i }))
    return { actionId, serverConfirmed: true, receivedDrops: names.map((name, i) => ({ runtimeId: String(20 + i), name, count: 1 })), pendingDropIds: [] }
  }
  const r = await f.run()
  assert.equal(r.reason, 'CAPACITY_RECOVERY_SLOT_REQUIRED'); assert.equal(r.serverConfirmed, false)
  assert.equal(f.blocks.get(key(box)).name, 'minecraft:undyed_shulker_box')
})

test('low health, invalid main stack IDs and a changed owned block stop before mining', async () => {
  for (const change of [f => { f.state.health = 13 }, f => { f.state.inventory.items[0].stackId = 0 }, f => { f.blocks.get(key(box)).runtimeId++ }]) {
    const f = fixture(); change(f); const r = await f.run()
    assert.equal(r.status, 'blocked'); assert.equal(f.mineCalls(), 0)
  }
})

test('silk-preserved stone participates in capacity projection and mandatory stone drops require real inventory gain', async () => {
  const target = { position: { x: 1, y: 1, z: 4 }, name: 'minecraft:stone', runtimeId: 7 }
  assert.deepEqual(fullDropBudget([target], { kind: 'pickaxe', tier: 1, silk: true }), [{ name: 'stone', count: 1 }])
  assert.deepEqual(fullDropBudget([target], { kind: 'pickaxe', tier: 1, silk: false }), [{ name: 'cobblestone', count: 1 }])
  assert.deepEqual(fullDropBudget([target], { kind: 'pickaxe', tier: 1 }), [{ name: 'cobblestone', count: 1 }, { name: 'stone', count: 1 }])
  const f = fixture()
  f.input.request.capacityBatch.decision.targets = [target]
  f.input.request.capacityBatch.decision.tool = { kind: 'pickaxe', tier: 1, silk: true }
  f.blocks.set(key(target.position), { known: true, name: 'minecraft:stone', runtimeId: 7 })
  f.ports.collectBatch = async ({ actionId }) => ({ actionId, serverConfirmed: true, receivedDrops: [], pendingDropIds: [] })
  const r = await f.run()
  assert.equal(r.reason, 'DROP_GAIN_MISSING')
  assert.equal(r.serverConfirmed, false)
})

test('the connected controller refuses dirt/log zero gain and one snowball for a full snow block', async () => {
  for (const [name, tool, gain] of [
    ['dirt', { kind: 'hand' }, null], ['oak_log', { kind: 'hand' }, null],
    ['snow', { kind: 'shovel', tier: 1, silk: false }, { name: 'minecraft:snowball', count: 1 }]
  ]) {
    const f = fixture()
    f.input.request.capacityBatch.decision.targets[0].name = `minecraft:${name}`
    f.input.request.capacityBatch.decision.tool = tool
    f.blocks.set(key(target), { known: true, name: `minecraft:${name}`, runtimeId: 7 })
    f.ports.collectBatch = async ({ actionId }) => {
      if (gain) f.state.inventory.items.push({ slot: 0, stackId: 800, ...gain })
      return { actionId, serverConfirmed: true, receivedDrops: [], pendingDropIds: [] }
    }
    const r = await f.run()
    assert.equal(r.reason, 'DROP_GAIN_MISSING', name)
    assert.equal(r.serverConfirmed, false)
  }
})
