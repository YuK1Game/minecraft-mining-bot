'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createInventoryInspection } = require('../src/inventory-inspection')
const { receivedEquipmentView } = require('../src/loadout-runtime-adapter')

const copy = value => structuredClone(value)
const tag = (type, value) => ({ type, value })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0,
  extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const helmet = () => ({ network_id: 47, count: 1, metadata: 3, has_stack_id: true, stack_id: 138, block_runtime_id: 0,
  extra: { has_nbt: true, nbt: { version: 1, nbt: tag('compound', {
    Damage: tag('int', 7), display: tag('compound', { Name: tag('string', 'received helmet') })
  }) }, can_place_on: [], can_destroy: [] } })
const totem = () => ({ ...air(), network_id: 50, count: 1, has_stack_id: true, stack_id: 139 })
const names = new Map([[47, 'minecraft:diamond_helmet'], [50, 'minecraft:totem_of_undying']])
const registry = { itemsByName: { diamond_helmet: { stackSize: 1, maxDurability: 363 }, totem_of_undying: { stackSize: 1 } }, enchantments: {} }

function fixture ({ legacyKnown = true } = {}) {
  const main = Array.from({ length: 36 }, air)
  const armorStore = { known: legacyKnown, worn: new Map(Array.from({ length: 4 }, (_, slot) => [slot, air()])) }
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, dimension: 'overworld',
    connectionId: 'connection', startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '41', lifecycle: { deathId: 0 },
    health: 20, spawnPending: false, inventory: { known: true }, selectedSlot: 0 }
  const crafting = { rawItem: slot => copy(main[slot]), itemNameOf: id => names.get(id) ?? null,
    status: () => ({ authority: true, inventoryKnown: true, openContainer: null, pendingRequestId: null }),
    snapshot: () => ({ authority: true, inventoryKnown: true, openContainer: null, pendingRequestId: null }) }
  const store = {}
  const inspection = createInventoryInspection({ crafting, armorStore, getState: () => state, store, registry })
  inspection.applyPacket('inventory_content', { window_id: 'inventory', input: copy(main) })
  const view = () => receivedEquipmentView(inspection, crafting, state)
  const actualEmpty = () => {
    inspection.applyPacket('inventory_content', { window_id: 120, input: Array.from({ length: 4 }, air) })
    inspection.applyPacket('inventory_content', { window_id: 119, input: [air()] })
  }
  return { main, state, crafting, armorStore, store, inspection, view, actualEmpty }
}

test('v22 reset equipment view cannot promote ACK-synthesized emptiness or a main-only refresh', () => {
  const f = fixture(), worn = helmet(), held = totem()
  f.armorStore.worn.set(0, copy(worn))
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: [worn, air(), air(), air()] })
  f.inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [held] })
  assert.equal(f.view().armor.slots[0].empty, false)
  f.inspection.applyPacket('item_stack_response', { responses: [{ request_id: -3, status: 0, containers: [
    { slot_type: { container_id: 6 }, slots: [{ slot: 0, count: 0 }] },
    { slot_type: { container_id: 34 }, slots: [{ slot: 1, count: 0 }] }
  ] }] })
  f.armorStore.worn.set(0, air())
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: air(), source: 'server_item_stack_response' })
  f.inspection.applyPacket('inventory_slot', { window_id: 'offhand', slot: 0, item: air(), source: 'server_item_stack_response' })
  assert.equal(f.inspection.snapshot().armor.slots[0].empty, true, 'legacy presentation may adopt the ACK')
  assert.equal(f.inspection.snapshot().offhand.slots[0].empty, true)
  f.inspection.applyPacket('inventory_content', { window_id: 'inventory', input: copy(f.main) })
  const view = f.view()
  assert.equal(view.armor.known, false)
  assert.deepEqual(view.armor.slots[0], { slot: 0, known: false, empty: false, name: null, count: null })
  assert.equal(view.offhand.known, false)
  assert.equal(view.offhand.slots[0].empty, false)
  assert.equal(view.armor.slots[1].known, true, 'unaffected actual slots remain evidence')
})

test('v22 reset equipment view accepts actual full windows as known empty without changing inputs', () => {
  const f = fixture(), packets = [
    { window_id: 'armor', input: Array.from({ length: 5 }, air) },
    { window_id: 'offhand', input: [air()] }
  ], before = copy(packets)
  for (const packet of packets) f.inspection.applyPacket('inventory_content', packet)
  const stateBefore = copy(f.state), mainBefore = copy(f.main), legacyBefore = copy(f.armorStore)
  const first = f.view(), second = f.view()
  for (const kind of ['armor', 'offhand']) {
    assert.equal(first[kind].known, true)
    assert.equal(first[kind].slots.every(slot => slot.known && slot.empty && slot.count === 0), true)
    assert.equal(first[kind].slots.every(slot => /^[a-f0-9]{64}$/.test(slot.receiptIdentity)), true)
    assert.deepEqual(first[kind], second[kind])
  }
  assert.deepEqual(packets, before)
  assert.deepEqual(f.state, stateBefore)
  assert.deepEqual(f.main, mainBefore)
  assert.deepEqual(f.armorStore, legacyBefore)
})

test('actual slot-only armor emptiness is usable even while the legacy armor controller is unknown', () => {
  const f = fixture({ legacyKnown: false })
  for (let slot = 0; slot < 4; slot++) {
    f.inspection.applyPacket('inventory_slot', { window_id: 120, slot, item: air() })
    assert.equal(f.view().armor.known, slot === 3)
  }
  f.inspection.applyPacket('inventory_slot', { window_id: 119, slot: 0, item: air() })
  f.armorStore.known = false
  assert.equal(f.inspection.snapshot().armor.known, false)
  const view = f.view()
  assert.equal(view.armor.known, true)
  assert.equal(view.armor.slots.every(slot => slot.known && slot.empty), true)
  assert.equal(view.offhand.known, true)
  assert.equal(view.offhand.slots[0].empty, true)
})

test('equipment receipt identity covers metadata and NBT and callers cannot mutate its evidence', () => {
  const f = fixture(), original = helmet()
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: original })
  const first = f.view().armor.slots[0]
  assert.equal(first.name, 'minecraft:diamond_helmet')
  assert.equal(first.metadata, 3)
  assert.equal(f.view().armor.slots[0].receiptIdentity, first.receiptIdentity)
  original.extra.nbt.nbt.value.Damage.value = 99
  assert.equal(f.inspection.rawEquipment('armor', 0).extra.nbt.nbt.value.Damage.value, 7)
  first.metadata = 99; first.receiptIdentity = 'forged'
  const stable = f.view().armor.slots[0]
  assert.equal(stable.metadata, 3)
  assert.notEqual(stable.receiptIdentity, 'forged')
  for (const change of ['metadata', 'nbt', 'stack_id']) {
    const changed = helmet()
    if (change === 'metadata') changed.metadata = 4
    if (change === 'nbt') changed.extra.nbt.nbt.value.Damage.value = 8
    if (change === 'stack_id') changed.stack_id = 140
    f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: changed })
    assert.notEqual(f.view().armor.slots[0].receiptIdentity, stable.receiptIdentity, change)
  }
})

test('replay, synthetic windows and old connection receipts never prove equipment is empty', () => {
  const f = fixture()
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, air) }, { replaying: true })
  f.inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [air()], source: 'server_item_stack_response' })
  assert.equal(f.view().armor.known, false)
  assert.equal(f.view().offhand.known, false)
  f.actualEmpty()
  assert.equal(f.view().armor.known, true)
  f.state.connectionId = 'replacement'
  assert.equal(f.view().armor.known, false)
  assert.equal(f.view().offhand.known, false)
})

function captureAdapter ({ getJob, journalDirectory }) {
  const filename = path.resolve(__dirname, '../src/loadout-runtime-adapter.js')
  const nativeRequire = Module.createRequire(filename)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = name => name === './quarry-v22-reset'
    ? { createQuarryV22Reset: ({ adapter }) => adapter }
    : nativeRequire(name)
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename)
  const f = fixture()
  const forbidden = () => assert.fail('adapter receipt test must not send packets or world actions')
  const host = { shared: { quarryAutoResume: true, quarryRestoreDisabled: false }, client: { queue: forbidden }, world: { getBlock: forbidden } }
  const adapter = loaded.exports.createRuntimeV22ChestReset({ host, getState: () => f.state,
    inspection: f.inspection, crafting: f.crafting, armor: {}, inventory: {}, chest: {},
    assertIdle: forbidden, acquire: forbidden, release: forbidden, getJob, generation: () => 1, cancelTransfers: forbidden, journalDirectory })
  return { adapter, host, state: f.state }
}

test('cancelJob returns a verified null identity receipt without cancelling a nonexistent document', async () => {
  for (const job of [null, { document: () => null, cancel: () => assert.fail('no document may be cancelled') }]) {
    const { adapter, host } = captureAdapter({ getJob: () => job })
    assert.deepEqual(await adapter.cancelJob({ expectedJobIdentity: null }), {
      serverConfirmed: true, previousJobIdentity: null, jobIdentity: null
    })
    assert.equal(host.shared.quarryAutoResume, false)
    assert.equal(host.shared.quarryRestoreDisabled, true)
  }
})

test('cancelJob refuses a stale expected identity before invoking cancellation', async () => {
  const job = { document: () => ({ instanceId: 'new', state: 'PAUSED', userRunIntent: 'paused' }), cancel: () => assert.fail('stale identity cannot cancel') }
  const { adapter, host } = captureAdapter({ getJob: () => job })
  await assert.rejects(adapter.cancelJob({ expectedJobIdentity: 'old:PAUSED:paused' }), { code: 'RESET_JOB_CHANGED' })
  assert.equal(host.shared.quarryAutoResume, true)
  assert.equal(host.shared.quarryRestoreDisabled, false)
})

test('cancelJob cannot credit a replacement job or instance while the original cancellation is pending', async () => {
  for (const change of ['object', 'instance']) {
    const doc = { instanceId: 'original', state: 'PAUSED', userRunIntent: 'paused' }
    let resolveCancel, current
    const original = { document: () => copy(doc), cancel: () => new Promise(resolve => { resolveCancel = resolve }) }
    current = original
    const { adapter, host } = captureAdapter({ getJob: () => current })
    const result = adapter.cancelJob({ expectedJobIdentity: 'original:PAUSED:paused' })
    if (change === 'object') current = { document: () => ({ instanceId: 'replacement', state: 'IDLE', userRunIntent: 'idle' }) }
    else doc.instanceId = 'replacement'
    resolveCancel({ state: 'FINISHED', persistence: { status: 'saved' } })
    await assert.rejects(result, { code: 'RESET_JOB_CHANGED' }, change)
    assert.equal(host.shared.quarryAutoResume, true)
    assert.equal(host.shared.quarryRestoreDisabled, false)
  }
})

test('cancelJob credits only the same finished job after its verified cancellation', async () => {
  const doc = { instanceId: 'same', state: 'PAUSED', userRunIntent: 'paused' }
  const job = { document: () => copy(doc), cancel: async () => {
    doc.state = 'FINISHED'; doc.userRunIntent = 'cancelled'
    return { state: 'FINISHED', persistence: { status: 'saved' } }
  } }
  const { adapter } = captureAdapter({ getJob: () => job })
  assert.deepEqual(await adapter.cancelJob({ expectedJobIdentity: 'same:PAUSED:paused' }), {
    serverConfirmed: true, previousJobIdentity: 'same:PAUSED:paused', jobIdentity: 'same:FINISHED:cancelled'
  })
})


test('V22 failure journal stays in its original world after the live world changes', async t => {
  const io = require('node:fs/promises'), os = require('node:os'), { createHash } = require('node:crypto')
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-v22-journal-'))
  t.after(async () => {
    const target = path.resolve(directory), parent = path.resolve(os.tmpdir()) + path.sep
    assert.ok(target.startsWith(parent) && path.basename(target).startsWith('mc-v22-journal-'))
    await io.rm(target, { recursive: true, force: true })
  })
  const f = captureAdapter({ getJob: () => null, journalDirectory: directory })
  const originalWorld = JSON.stringify([f.state.profile, String(f.state.realm.id), f.state.dimension])
  f.state.realm.id = 'other-world'
  const currentWorld = JSON.stringify([f.state.profile, String(f.state.realm.id), f.state.dimension])
  const name = world => createHash('sha256').update(world).digest('hex') + '.json'
  await f.adapter.save({ world: originalWorld, operationId: 'original', phase: 'failed' })
  assert.equal(JSON.parse(await io.readFile(path.join(directory, name(originalWorld)), 'utf8')).operationId, 'original')
  await assert.rejects(io.readFile(path.join(directory, name(currentWorld))), { code: 'ENOENT' })
})
