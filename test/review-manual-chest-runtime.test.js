'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn, setTimeout: delay } = require('node:timers/promises')
const loadout = require('../src/loadout-runtime-adapter')

// Reuse the bounded Host scene, but compile the actual Runtime with only its
// storage bridge and unrelated movement/behavior dependencies substituted.
const filename = require.resolve('./runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
const sceneSource = fs.readFileSync(filename, 'utf8').split('\ntest(')[0]
const reloadableSceneSource = sceneSource.replace('return { runtime, host, raw, shared,', 'return { recreateRuntime: () => loaded.exports.createRuntime(host), runtime, host, raw, shared,')
assert.notEqual(reloadableSceneSource, sceneSource, 'the shared Host fixture must expose its Runtime factory')
loaded._compile(reloadableSceneSource + '\nmodule.exports = { scene }\n', filename)
const { scene } = loaded.exports
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function deferred () {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function observed (predicate) {
  const until = Date.now() + 350
  while (!predicate() && Date.now() < until) await delay(5)
  assert.equal(predicate(), true, 'the bounded receipt observer must settle')
}
function fixture (t) {
  let ports, busy = false, mutationPending = false, equipmentPending = false, creations = 0, quarryCreations = 0, armorCalls = 0, autoArmorReady = false, inputRunning = false
  const events = [], drained = deferred()
  const bridge = {
    status: () => ({ available: true, busy, phase: busy ? 'running' : 'idle', operationId: busy ? 'fixture-storage' : null }),
    isBusy: () => busy, pendingMutation: () => mutationPending, equipmentBusy: () => equipmentPending,
    async prepare (options) {
      ports.assertIdle(); events.push(['prepare', options]); await ports.onAcquire({ preview: true })
      return { token: 'fixture-token', operationId: 'fixture-storage' }
    },
    start (options) {
      ports.assertIdle(); events.push(['start', options]); ports.onAcquire({ preview: false }); busy = true
      return bridge.status()
    },
    cancel (reason) { events.push(['cancel', reason]); if (!mutationPending && !equipmentPending) busy = false; return bridge.status() },
    drain () { events.push(['drain']); return mutationPending || equipmentPending ? drained.promise : Promise.resolve() },
    applyPacket (name, packet) {
      events.push(['packet', name, structuredClone(packet)])
      if (name === 'inventory_slot' && packet.window_id === 'inventory' && packet.slot === 35 && (mutationPending || equipmentPending)) finish()
    }
  }
  function finish () { busy = false; mutationPending = false; equipmentPending = false; drained.resolve() }
  const f = scene(t, { runtimeOverrides: {
    './manual-chest-runtime-adapter': { createManualChestRuntime: options => { creations++; ports = options; return bridge } },
    './quarry-job': { createQuarryJob: () => { quarryCreations++; throw new Error('Manual storage must not construct a quarry') } },
    './loadout-runtime-adapter': { ...loadout, createRuntimeV22ChestReset: options => ({
      prepare: () => { options.assertIdle(); events.push(['resetPrepare']); return {} },
      start: () => { options.assertIdle(); events.push(['resetStart']); return {} },
      status: () => ({ busy: false }), cancel () {}, drain: async () => {}
    }) },
    './armor': { createArmor: () => ({ preview: () => autoArmorReady,
      equipBest: async () => { armorCalls++; return [] }, preemptForCombat: () => events.push(['armorPreempt']), applyPacket () {}, snapshot: () => ({ busy: false }) }) },
    './input': { createInput: () => ({ stats: () => ({ running: inputRunning, tick: '1000', sent: 0, target: null }),
      start: () => { inputRunning = true; events.push(['inputStart']) }, stop: () => { inputRunning = false; events.push(['inputStop']) },
      release () {}, lookAt () {}, sendAction: () => events.push(['combatInput']), sendTransaction () {} }) }
  } })
  const prepare = options => f.runtime.operations.storage.prepare(options)
  const start = async () => { await prepare({}); return f.runtime.operations.storage.start({ token: 'fixture-token', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }) }
  return { ...f, events, bridge, prepare, start, finish, ports: () => ports, creations: () => creations, quarryCreations: () => quarryCreations,
    pending: kind => { mutationPending = kind === 'mutation'; equipmentPending = kind === 'equipment' },
    armorCalls: () => armorCalls,
    tickArmor: async () => { autoArmorReady = true; f.shared.autoWanted = true; f.shared.armorCheckedAt = 0; f.runtime.resumeRequested(); f.advance(50); await turn() } }
}

test('manual chest Runtime status is passive and prepare uses current ports without constructing or cancelling a quarry', async t => {
  const f = fixture(t), job = { instanceId: 'saved-instance', state: 'PAUSED', userRunIntent: 'pause', ledger: { minedBlocks: 123 } }
  f.shared.quarryDocument = structuredClone(job)
  assert.equal(f.runtime.operations.storage.status().available, true)
  await f.runtime.operations.storage.drain()
  f.runtime.operations.storage.cancel('idle-cancel')
  assert.equal(f.creations(), 0); assert.equal(f.quarryCreations(), 0)
  f.shared.inventoryUncertain = { reason: 'pending saved receipt' }
  const preview = await f.prepare({ operationId: 'saved-operation' })
  assert.equal(preview.token, 'fixture-token'); assert.equal(f.creations(), 1); assert.equal(f.quarryCreations(), 0)
  assert.deepEqual(f.shared.quarryDocument, job)
  assert.equal(f.ports().jobIdentity(), 'saved-instance:PAUSED:pause')
  assert.deepEqual(f.events.filter(([name]) => ['prepare', 'cancel'].includes(name)), [['prepare', { operationId: 'saved-operation' }]])
  for (const name of ['getState', 'getView', 'getRawMain', 'getRawEquipment', 'assertIdle', 'refreshInventory', 'commitMain', 'commitEquipment']) assert.equal(typeof f.ports()[name], 'function', name)
  assert.equal(f.ports().getState().loadingScreenEnded, true)
  delete f.shared.inventoryUncertain
})

test('a reloaded Runtime forwards the actual owned close before lazy storage is requested', async t => {
  const f = fixture(t), job = { instanceId: 'saved-instance', state: 'PAUSED', userRunIntent: 'pause', ledger: { minedBlocks: 0 } }
  await f.runtime.dispose('fixture_reload')
  f.shared.manualChestCloseBarrier = { pending: true, window: { id: 11, type: 'container' } }
  f.shared.quarryDocument = structuredClone(job)
  const runtime = f.recreateRuntime()
  t.after(async () => { await runtime.dispose('test_reloaded_cleanup') })
  assert.equal(f.creations(), 0, 'reloading must leave storage lazy until an actual window response arrives')
  const packet = { window_id: 11, window_type: 'none', server: false }, beforeWire = f.wire.length
  runtime.applyPacket('container_close', packet)
  assert.equal(f.creations(), 1)
  assert.deepEqual(f.events.filter(([name]) => name === 'packet'), [['packet', 'container_close', packet]])
  assert.equal(f.quarryCreations(), 0); assert.equal(f.counters.autonomyStarts, 0)
  assert.deepEqual(f.shared.quarryDocument, job)
  assert.equal(f.shared.autoWanted, false); assert.equal(f.mockMovement.snapshot().running, false)
  assert.equal(f.wire.length, beforeWire, 'handling the close cannot start a transfer, movement, or mining')
})

test('replayed window packets and actual windows without a persisted barrier keep storage lazy', async t => {
  const f = fixture(t)
  await f.runtime.dispose('fixture_reload')
  f.shared.manualChestCloseBarrier = { pending: true, window: { id: 11, type: 'container' } }
  const replay = f.host.cache.replay
  f.host.cache.replay = receive => {
    replay(receive)
    receive('container_open', { window_id: 11, window_type: 'container' })
    receive('container_close', { window_id: 11, window_type: 'none', server: false })
  }
  const runtime = f.recreateRuntime()
  t.after(async () => { await runtime.dispose('test_reloaded_cleanup') })
  assert.equal(f.creations(), 0, 'cached window packets cannot construct a receipt observer or acknowledge a close')
  assert.equal(f.events.filter(([name]) => name === 'packet').length, 0)
  delete f.shared.manualChestCloseBarrier
  runtime.applyPacket('container_open', { window_id: 12, window_type: 'inventory' })
  runtime.applyPacket('container_close', { window_id: 12, window_type: 'none', server: false })
  assert.equal(f.creations(), 0, 'ordinary window responses without an owned close do not initialize storage')
  assert.equal(f.quarryCreations(), 0); assert.equal(f.counters.autonomyStarts, 0)
  assert.equal(f.wire.filter(packet => packet.name === 'item_stack_request').length, 0)
})

test('manual chest Runtime busy lease blocks ordinary movement, gear, chest and debug reset operations', async t => {
  const f = fixture(t); await f.start()
  assert.equal(f.runtime.canReload(), false)
  for (const operation of [
    () => f.runtime.operations.movement.preview({ x: 1, y: 65, z: 1 }),
    () => f.runtime.operations.movement.start({ x: 1, y: 65, z: 1 }),
    () => f.runtime.operations.walking.start({ x: 1, y: 65, z: 1 }),
    () => f.runtime.operations.interactions.equip(1),
    () => f.runtime.operations.crafting.openInventory(),
    () => f.runtime.operations.chest.open({ x: 1, y: 65, z: 1 }),
    () => f.runtime.operations.loadout.preview(),
    () => f.runtime.operations.loadout.start({ token: 'irrelevant', confirm: 'RESET' })
  ]) assert.throws(operation, { code: 'STORAGE_BUSY' })
  await assert.rejects(f.runtime.operations.inventory.equip(1), { code: 'STORAGE_BUSY' })
  assert.throws(() => f.runtime.operations.armor.equipBest(), { code: 'STORAGE_BUSY' })
  assert.equal(f.armorCalls(), 0); assert.equal(f.quarryCreations(), 0)
  assert.equal(f.mockMovement.snapshot().running, false)
  assert.equal(f.wire.filter(packet => packet.name === 'item_stack_request').length, 0)
  f.finish(); assert.equal(f.runtime.canReload(), true)
})

test('manual chest Runtime defers automatic armor and ordinary behaviors while preserving combat admission', async t => {
  const f = fixture(t)
  f.runtime.resumeRequested(); await turn()
  await f.start()
  f.shared.combatDefenseWanted = true; f.shared.userBehaviorsEnabled = true; f.shared.autoWanted = true
  assert.equal(f.facadeOptions.canAct({ kind: 'combat' }), true)
  assert.equal(f.facadeOptions.canAct({ kind: 'bed' }), false)
  await f.tickArmor()
  assert.equal(f.armorCalls(), 0); assert.equal(f.runtime.canReload(), false)
  f.finish(); await f.tickArmor()
  assert.equal(f.armorCalls(), 1)
})

test('manual chest Runtime equipment ports preserve actual receipts and invalidate synthesized armor proof', async t => {
  const f = fixture(t); await f.prepare({})
  const worn = { network_id: 401, count: 1, has_stack_id: true, stack_id: 77, metadata: 3, extra: { has_nbt: true, nbt: { name: '', type: 'compound', value: { RepairCost: { type: 'int', value: 4 } } } } }
  const offhand = { network_id: 402, count: 1, has_stack_id: true, stack_id: 78, metadata: 0 }
  assert.equal(f.ports().getRawEquipment('armor', 0), null)
  f.runtime.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: worn })
  f.runtime.applyPacket('inventory_slot', { window_id: 'offhand', slot: 0, item: offhand })
  assert.deepEqual(f.ports().getRawEquipment('armor', 0), worn)
  assert.deepEqual(f.ports().getRawEquipment('offhand', 0), offhand)
  const returned = f.ports().getRawEquipment('armor', 0); returned.extra.nbt.value.RepairCost.value = 99
  assert.deepEqual(f.ports().getRawEquipment('armor', 0), worn)
  f.runtime.applyPacket('item_stack_response', { responses: [{ status: 'ok', containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 1, item_stack_id: 80 }] }] }] })
  assert.equal(f.ports().getRawEquipment('armor', 0), null, 'an ACK cannot replace the actual server equipment receipt')
  assert.deepEqual(f.ports().getRawEquipment('offhand', 0), offhand)
})

for (const pendingKind of ['mutation', 'equipment']) test(`manual chest Runtime combat cancels before input and waits only for ${pendingKind} receipts`, { timeout: 2500 }, async t => {
  const f = fixture(t); await f.start(); f.pending(pendingKind)
  const context = { kind: 'combat', claimId: `combat:manual-${pendingKind}`, scope: f.scope() }
  try {
    const acquiring = f.facadeOptions.acquireControl(context)
    assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === 'COMBAT_PRIORITY'), 'manual owner is revoked synchronously')
    const token = await acquiring
    assert.notEqual(token.acquired, false)
    assert.equal(f.events.filter(event => event[0] === 'drain').length, 0, 'combat does not await storage drain')
    const cancelled = f.events.findIndex(event => event[0] === 'cancel' && event[1] === 'COMBAT_PRIORITY')
    const stopped = f.events.findIndex((event, index) => index > cancelled && event[0] === 'inputStop')
    assert.ok(cancelled >= 0 && stopped > cancelled)
    const control = { claimId: `manual-${pendingKind}`, token }
    assert.equal(f.facadeOptions.coordinatorOptions.controlReady(control), false)
    assert.equal(f.facadeOptions.isBusy({ ...context, token }), true)
    await delay(35)
    assert.equal(f.facadeOptions.coordinatorOptions.controlReady(control), false, 'elapsed time cannot confirm a pending request')
    f.runtime.applyPacket('inventory_slot', { window_id: 'inventory', slot: 35, item: air() })
    await observed(() => f.facadeOptions.coordinatorOptions.controlReady(control))
    f.facadeOptions.getInput().sendAction('swing')
    assert.ok(f.events.findIndex(event => event[0] === 'combatInput') > cancelled)
    await f.facadeOptions.resumeControl({ ...context, token })
  } finally { f.finish() }
})

test('manual chest Runtime stop revokes storage and disposal drains the pending observer without deadlock', { timeout: 2500 }, async t => {
  const f = fixture(t); await f.start(); f.pending('mutation')
  try {
    await f.runtime.stopActions('manual-stop')
    assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === 'manual-stop'))
    assert.equal(f.runtime.canReload(), false)
    let disposed = false
    const disposing = f.runtime.dispose('test-explicit-dispose').then(() => { disposed = true })
    await turn()
    assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === 'RUNTIME_RELOADED'))
    assert.ok(f.events.some(event => event[0] === 'drain'))
    assert.equal(disposed, false)
    f.runtime.applyPacket('inventory_slot', { window_id: 'inventory', slot: 35, item: air() })
    await disposing
    assert.equal(disposed, true)
  } finally { f.finish() }
})

test('manual chest Runtime rejects legacy autonomy start and tick while the storage owner is busy', async t => {
  const f = fixture(t); await f.start()
  assert.throws(() => f.runtime.operations.agent.start({ objective: 'diamond' }), { code: 'STORAGE_BUSY' })
  assert.throws(() => f.runtime.operations.agent.tick(), { code: 'STORAGE_BUSY' })
  assert.equal(f.counters.autonomyStarts, 0)
  assert.equal(f.shared.autoWanted, false)
  f.finish()
})

test('manual chest Runtime busy lease prevents automatic resume and quarry restoration without changing the recorded job', async t => {
  const f = fixture(t); await f.start()
  const job = { instanceId: 'saved-instance', state: 'PAUSED', userRunIntent: 'pause', pauseReason: 'PROCESS_RESTARTED' }
  f.shared.quarryDocument = structuredClone(job)
  f.shared.autoWanted = true; f.shared.quarryAutoResume = true; f.shared.quarryRestoreDisabled = false
  f.shared.quarryRestoreTried = false; f.shared.quarryRestoreNextAt = 0
  await f.runtime.resumeRequested()
  f.advance(15000); await turn()
  assert.equal(f.counters.autonomyStarts, 0)
  assert.equal(f.quarryCreations(), 0)
  assert.deepEqual(f.shared.quarryDocument, job)
  assert.equal(f.shared.quarryAutoResume, true, 'manual storage cannot consume a saved job resume intent')
  f.finish()
  f.shared.autoWanted = false; f.shared.quarryAutoResume = false; f.shared.quarryRestoreDisabled = true
})
