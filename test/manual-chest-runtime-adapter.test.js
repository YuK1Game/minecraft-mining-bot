'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const io = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { observedScope } = require('../src/server-position-verifier')
const copy = value => structuredClone(value)
const ID = '01234567-89ab-4cde-8fab-0123456789ab'
const OTHER = '11234567-89ab-4cde-8fab-0123456789ab'
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const item = (id = 1, stack = 10) => ({ ...air(), network_id: id, count: 1, has_stack_id: true, stack_id: stack })
const names = new Map([[1, 'minecraft:totem_of_undying'], [2, 'minecraft:diamond_helmet']])
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture ({ journalDirectory, unknownGear = false, composed = false } = {}) {
  const captured = {}, filename = require.resolve('../src/manual-chest-runtime-adapter')
  const loaded = new Module(filename, module), ordinary = Module.createRequire(filename)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = name => !composed && name === './manual-chest-deposit' ? { createManualChestDeposit: ({ adapter }) => {
    captured.adapter = adapter
    return { prepare () {}, start () {}, status: () => ({ busy: false }), cancel: () => ({ phase: 'paused' }), drain: async () => {} }
  } } : !composed && name === './quarry-v22-chest-work' ? { createQuarryV22ChestWork: ports => {
    captured.ports = ports
    return { depositAll: (request, options) => captured.run(request, options, ports) }
  } } : name === './durable-json' ? { ...ordinary(name), writeDurableJson: async (...args) => {
    if (captured.pointerFailure && path.basename(args[0]) === 'latest.json') throw new Error('controlled pointer persistence failure')
    const result = await ordinary(name).writeDurableJson(...args)
    await captured.onSave?.(args[1])
    return result
  } } : ordinary(name)
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename)
  const main = Array.from({ length: 36 }, air), armor = Array.from({ length: 4 }, air), offhand = [air()]
  const actual = { armor: unknownGear ? Array(4).fill(null) : armor.map(copy), offhand: unknownGear ? [null] : offhand.map(copy) }
  main[0] = item()
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'connection',
    startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '41', lifecycle: { deathId: 0 }, health: 20, gameMode: 'survival',
    position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true } }
  const target = { x: 2, y: 65, z: 0 }, contents = Array.from({ length: 54 }, air), packets = [], commits = [], callbacks = [], closes = []
  let ui = null, chestWindow = null, pendingId = null, bridge, refreshes = 0, job = 'job:PAUSED:paused', gen = 1
  const description = (raw, slot) => ({ slot, known: true, empty: raw.count === 0, name: raw.count ? names.get(raw.network_id) : null, count: raw.count })
  const getView = () => ({ known: captured.viewKnown !== false, uncertain: captured.viewUncertain === true,
    slots: main.map((raw, slot) => ({ ...description(raw, slot), known: captured.unknownSlot !== slot })), armor: { known: true, slots: armor.map(description) },
    offhand: { known: true, slots: offhand.map(description) }, openContainer: chestWindow ? { known: true, slotCount: 54, position: target, slots: contents.map(description) } : null })
  const crafting = { itemNameOf: id => names.get(id), status: () => ({ openContainer: copy(ui), pendingRequestId: null }),
    openInventory: async () => {
      if (captured.openInventory) return captured.openInventory()
      ui = { id: 99, type: 'inventory' }
      bridge.applyPacket('container_open', { window_id: 99, window_type: 'inventory' })
      return copy(ui)
    }, cancel: () => callbacks.push({ type: 'cancel_inventory_open' }),
    closeContainer: () => { closes.push(ui?.id); ui = null; chestWindow = null } }
  const chest = { snapshot: () => ({ busy: pendingId != null, pendingRequestId: pendingId, contentsKnown: !!chestWindow, slotCount: captured.slotCount ?? 54,
    window: chestWindow ? { ...chestWindow, position: target, replayed: false } : null }), rawItem: slot => copy(contents[slot]),
    open: async () => {
      if (captured.openChest) return captured.openChest()
      ui = { id: 5, type: 'container' }; chestWindow = copy(ui)
      bridge.applyPacket('container_open', { window_id: 5, window_type: 'container' })
      return { serverConfirmed: true, slotCount: captured.slotCount ?? 54, windowId: 5 }
    }, depositItem: options => {
      packets.push({ name: 'deposit', options }); contents[options.chestSlot] = copy(main[options.sourceSlot]); main[options.sourceSlot] = air()
      return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, item: options.expectedName, count: options.count,
        playerSlot: options.sourceSlot, chestSlot: options.chestSlot, requestId: -17 }
    },
    cancel: () => { pendingId = null } }
  const host = { client: { queue: (name, packet) => { assert.equal(name, 'item_stack_request'); packets.push({ name, packet }) } },
    world: { getBlock: (x, y, z) => ({ known: true, name: x === target.x && y === target.y && z === target.z ? 'minecraft:chest' : 'minecraft:air', extra: [] }) } }
  bridge = loaded.exports.createManualChestRuntime({ host, getState: () => copy(state), getView, getRawMain: slot => copy(main[slot]),
    getRawEquipment: (kind, slot) => copy(actual[kind][slot]), crafting, chest, generation: () => gen, jobIdentity: () => job,
    assertIdle () {}, onAcquire: lease => { callbacks.push({ type: 'acquire', preview: lease.preview, id: lease.id }); if (captured.acquireError) throw captured.acquireError }, onRelease: id => callbacks.push({ type: 'release', id }),
    refreshInventory: async () => {
      refreshes++
      if (captured.refreshAckOnly) return true
      state.inventory.known = true; state.inventory.uncertain = false
      captured.viewKnown = true; captured.viewUncertain = false; captured.unknownSlot = null
      actual.armor = armor.map(copy); actual.offhand = offhand.map(copy)
      return true
    },
    allocateRequestId: () => -3, commitMain: (slot, raw) => { commits.push('main'); main[slot] = copy(raw) },
    commitEquipment: (kind, slot, raw) => { commits.push(kind); (kind === 'armor' ? armor : offhand)[slot] = copy(raw) }, onUncertain: () => {}, journalDirectory })
  captured.run = async () => ({ status: 'completed', serverConfirmed: true })
  const acquire = (preview = false) => captured.adapter.acquire(ID, { scope: observedScope(state), preview, identity: preview ? null : captured.adapter.inventoryIdentity() })
  return { bridge, captured, state, main, armor, offhand, actual, target, contents, packets, commits, callbacks, closes, crafting, chest, acquire,
    refreshes: () => refreshes, setJob: value => { job = value }, nextGeneration: () => { gen++ },
    setWindow: value => { ui = copy(value) }, setPending: id => { pendingId = id } }
}

test('preview refreshes actual equipment once and raw identity binds all 41 received stacks without a mutation', async () => {
  const f = fixture({ unknownGear: true })
  assert.throws(f.captured.adapter.inventoryIdentity, { code: 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN' })
  await f.acquire(true)
  assert.equal(f.refreshes(), 1)
  const before = f.captured.adapter.inventoryIdentity()
  f.actual.armor[0] = { ...item(2), extra: { has_nbt: 'true', nbt: { tag: 'received' } } }
  assert.notEqual(f.captured.adapter.inventoryIdentity(), before, 'actual equipment NBT participates in the fingerprint')
  assert.throws(() => f.captured.adapter.runDeposit({ operationId: ID }), { code: 'MANUAL_DEPOSIT_OPERATION_INVALID' })
  assert.equal(f.packets.length, 0)
  await f.captured.adapter.release(ID)
  assert.equal(f.bridge.isBusy(), false)
})

function unknownMain (f, kind) {
  if (kind === 'main') f.state.inventory.known = false
  if (kind === 'uncertain') f.state.inventory.uncertain = true
  if (kind === 'view') f.captured.viewKnown = false
  if (kind === 'viewUncertain') f.captured.viewUncertain = true
  if (kind === 'slot') f.captured.unknownSlot = 0
}

test('preview refreshes unknown main receipts even when every actual equipment slot is already known', async () => {
  for (const kind of ['main', 'uncertain', 'view', 'viewUncertain', 'slot']) {
    const f = fixture(), gear = copy(f.actual)
    unknownMain(f, kind)
    assert.throws(f.captured.adapter.inventoryIdentity, { code: 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN' }, kind)
    await f.acquire(true)
    assert.equal(f.refreshes(), 1, kind)
    assert.match(f.captured.adapter.inventoryIdentity(), /^[a-f0-9]{64}$/)
    assert.deepEqual(f.actual, gear, 'main recovery does not require replacing already known equipment')
    assert.equal(f.packets.length, 0); assert.equal(f.commits.length, 0)
    await f.captured.adapter.release(ID)
  }
})

test('a readonly refresh ACK without fresh main proof still fails closed and releases its lease', async () => {
  for (const kind of ['main', 'uncertain', 'view', 'viewUncertain', 'slot']) {
    const f = fixture(); unknownMain(f, kind); f.captured.refreshAckOnly = true
    await assert.rejects(f.acquire(true), { code: 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN' }, kind)
    assert.equal(f.refreshes(), 1)
    assert.throws(f.captured.adapter.inventoryIdentity, { code: 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN' })
    assert.equal(f.bridge.isBusy(), false); assert.equal(f.packets.length, 0); assert.equal(f.commits.length, 0)
  }
})

test('the real controller and chest worker compose into receipt-backed storage without commands or movement', async t => {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-manual-chest-compose-'))
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(directory).startsWith('mc-manual-chest-compose-'))
    await io.rm(directory, { recursive: true, force: true })
  })
  const f = fixture({ journalDirectory: directory, composed: true })
  const preview = await f.bridge.prepare()
  assert.deepEqual(preview.position, f.target)
  assert.equal(preview.stacks.total, 1); assert.equal(f.packets.length, 0)
  f.bridge.start({ token: preview.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' })
  await f.bridge.drain()
  const result = f.bridge.status()
  assert.equal(result.phase, 'completed', JSON.stringify(result.error))
  assert.equal(result.serverConfirmed, true); assert.equal(result.remainingStacks, 0)
  assert.deepEqual(f.packets.map(packet => packet.name), ['deposit'])
  const saved = JSON.parse(await io.readFile(path.join(directory, preview.operationId + '.json'), 'utf8'))
  assert.equal(saved.checkpoint.phase, 'completed'); assert.equal(saved.checkpoint.receipts.length, 1)
  assert.equal(f.bridge.isBusy(), false)
})

test('a failed start acquisition can record its original failure after releasing game control', async t => {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-manual-chest-acquire-'))
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(directory).startsWith('mc-manual-chest-acquire-'))
    await io.rm(directory, { recursive: true, force: true })
  })
  const f = fixture({ journalDirectory: directory, composed: true }), preview = await f.bridge.prepare()
  f.captured.acquireError = Object.assign(new Error('another operation owns input'), { code: 'MANUAL_DEPOSIT_CONTEXT_CHANGED' })
  f.bridge.start({ token: preview.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' }); await f.bridge.drain()
  assert.equal(f.bridge.status().error.code, 'MANUAL_DEPOSIT_CONTEXT_CHANGED')
  assert.equal(f.bridge.isBusy(), false); assert.equal(f.packets.length, 0)
  const saved = JSON.parse(await io.readFile(path.join(directory, preview.operationId + '.json'), 'utf8'))
  assert.equal(saved.phase, 'failed'); assert.equal(saved.checkpoint, null)
})

test('the actual target remains empty through the durable child intent before the first deposit', async t => {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-manual-chest-target-'))
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(directory).startsWith('mc-manual-chest-target-'))
    await io.rm(directory, { recursive: true, force: true })
  })
  const f = fixture({ journalDirectory: directory, composed: true }), preview = await f.bridge.prepare()
  f.captured.onSave = doc => { if (doc.checkpoint?.intent) f.contents[1] = item(2, 90) }
  f.bridge.start({ token: preview.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' }); await f.bridge.drain()
  assert.equal(f.bridge.status().serverConfirmed, false)
  assert.equal(f.bridge.status().error.code, 'MANUAL_DEPOSIT_CHEST_NOT_EMPTY')
  assert.equal(f.packets.length, 0); assert.equal(f.main[0].count, 1)
})

test('latest-pointer persistence failure preserves the operation document but sends no first mutation', async t => {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-manual-chest-pointer-'))
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(directory).startsWith('mc-manual-chest-pointer-'))
    await io.rm(directory, { recursive: true, force: true })
  })
  const f = fixture({ journalDirectory: directory, composed: true }), preview = await f.bridge.prepare()
  f.captured.pointerFailure = true
  f.bridge.start({ token: preview.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' }); await f.bridge.drain()
  assert.equal(f.bridge.status().error.code, 'MANUAL_DEPOSIT_PERSISTENCE_FAILED')
  assert.equal(f.packets.length, 0)
  const saved = JSON.parse(await io.readFile(path.join(directory, preview.operationId + '.json'), 'utf8'))
  assert.equal(saved.operationId, preview.operationId); assert.equal(saved.serverConfirmed, false)
  await assert.rejects(io.readFile(path.join(directory, 'latest.json')), { code: 'ENOENT' })
})

test('the first chest mutation rechecks confirmed raw identity and rejects stale job, generation or cancellation', async () => {
  for (const changed of ['inventory', 'job', 'generation', 'cancel']) {
    const f = fixture(); await f.acquire()
    await f.captured.adapter.open(f.target, { expectedSlots: 54 })
    if (changed === 'inventory') f.main[0].metadata++
    if (changed === 'job') f.setJob('other:PAUSED:paused')
    if (changed === 'generation') f.nextGeneration()
    if (changed === 'cancel') f.captured.adapter.cancelTransfers(ID, 'stopped')
    f.captured.run = async (_request, _options, ports) => ports.deposit({ sourceSlot: 0, chestSlot: 0, count: 1 })
    await assert.rejects(async () => f.captured.adapter.runDeposit({ operationId: ID, position: f.target }))
    assert.equal(f.packets.length, 0, changed)
    await f.captured.adapter.release(ID)
  }
})

test('only the owned chest generation may be closed or used for a deposit', async () => {
  const f = fixture(); await f.acquire()
  await f.captured.adapter.open(f.target, { expectedSlots: 54 })
  f.setWindow({ id: 5, type: 'container' })
  f.bridge.applyPacket('container_open', { window_id: 5, window_type: 'container' })
  f.captured.adapter.close()
  assert.deepEqual(f.closes, [])
  f.captured.run = async (_request, _options, ports) => ports.deposit({ sourceSlot: 0, chestSlot: 0, count: 1 })
  await assert.rejects(f.captured.adapter.runDeposit({ operationId: ID }), { code: 'MANUAL_DEPOSIT_FOREIGN_WINDOW' })
  assert.equal(f.packets.length, 0)
  await f.captured.adapter.release(ID)
  assert.deepEqual(f.closes, [], 'release also preserves a same-ID later owner')
})

test('an unsuitable normal single chest closes only its observed UI before another candidate is inspected', async () => {
  const f = fixture(); await f.acquire(true)
  f.captured.slotCount = 27
  await assert.rejects(f.captured.adapter.open(f.target, { expectedSlots: 54 }), { code: 'MANUAL_DEPOSIT_CHEST_UNCONFIRMED' })
  assert.deepEqual(f.closes, [5])
  f.captured.slotCount = 54
  assert.equal((await f.captured.adapter.open(f.target, { expectedSlots: 54 })).slotCount, 54)
  await f.captured.adapter.release(ID)
  assert.deepEqual(f.closes, [5, 5]); assert.equal(f.packets.length, 0)
})

test('an untouched setup checkpoint cannot adopt somebody else’s newly filled target', async () => {
  const f = fixture(); await f.acquire(); await f.captured.adapter.open(f.target, { expectedSlots: 54 })
  f.contents[1] = item(2, 90)
  f.captured.run = async (_request, _options, ports) => ports.deposit({ sourceSlot: 0, chestSlot: 0, count: 1 })
  await assert.rejects(f.captured.adapter.runDeposit({ operationId: ID, checkpoint: { index: 0, intent: null } }), { code: 'MANUAL_DEPOSIT_CHEST_NOT_EMPTY' })
  assert.equal(f.packets.length, 0); await f.captured.adapter.release(ID)
})

test('cancel blocks a late equipment dispatch and leaves a late UI to its possible new owner', async () => {
  const f = fixture(), opening = deferred(); await f.acquire()
  f.captured.openInventory = () => opening.promise
  const pending = f.captured.ports.equipmentTransfer({ from: 'main', fromSlot: 0, to: 'offhand', toSlot: 0, expectedName: names.get(1) })
  void pending.catch(() => {})
  f.bridge.cancel('combat')
  await assert.rejects(pending)
  opening.resolve({ id: 99, type: 'inventory' }); await tick()
  assert.equal(f.packets.length, 0); assert.deepEqual(f.closes, [])
  assert.equal(f.callbacks.filter(call => call.type === 'cancel_inventory_open').length, 1)
  await f.captured.adapter.release(ID)
})

test('cancel retains an already sent equipment observer until its exact matching ACK settles', async () => {
  const f = fixture(); await f.acquire()
  const pending = f.captured.ports.equipmentTransfer({ from: 'main', fromSlot: 0, to: 'offhand', toSlot: 0, expectedName: names.get(1) })
  await tick()
  assert.equal(f.packets.length, 1)
  f.bridge.cancel('combat')
  assert.equal(f.bridge.pendingMutation(), true)
  await f.captured.adapter.release(ID)
  assert.equal(f.callbacks.some(call => call.type === 'release'), false)
  const ack = { responses: [{ request_id: -3, status: 0, containers: [
    { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
    { slot_type: { container_id: 'offhand' }, slots: [{ slot: 1, count: 1, item_stack_id: 50 }] }
  ] }] }
  f.bridge.applyPacket('item_stack_response', { responses: [{ ...ack.responses[0], request_id: -5 }] })
  assert.equal(f.commits.length, 0)
  f.bridge.applyPacket('item_stack_response', ack)
  assert.equal((await pending).serverConfirmed, true)
  assert.deepEqual(f.commits, ['main', 'offhand'])
  assert.equal(f.bridge.equipmentBusy(), false); assert.equal(f.bridge.pendingMutation(), false)
  assert.deepEqual(f.closes, [], 'the cancelled observer cannot close combat UI')
  assert.equal(f.callbacks.some(call => call.type === 'cancel_inventory_open'), false, 'sent mutation observers are retained')
  await f.captured.adapter.release(ID)
  assert.equal(f.bridge.isBusy(), false)
})

test('an owned chest receipt also drains after cancel without adopting a later foreign request', async () => {
  const f = fixture(), receipt = deferred(); await f.acquire()
  await f.captured.adapter.open(f.target, { expectedSlots: 54 })
  f.chest.depositItem = () => receipt.promise
  f.captured.run = async (_request, options, ports) => {
    await ports.deposit({ sourceSlot: 0, chestSlot: 0, count: 1 })
    return { status: options.signal.aborted ? 'blocked' : 'completed' }
  }
  const pending = f.captured.adapter.runDeposit({ operationId: ID })
  f.bridge.cancel('combat')
  assert.equal(f.bridge.pendingMutation(), true)
  await f.captured.adapter.release(ID)
  assert.equal(f.callbacks.some(call => call.type === 'release'), false)
  receipt.resolve({ serverConfirmed: true }); assert.equal((await pending).status, 'blocked')
  f.setPending(-99)
  assert.equal(f.bridge.pendingMutation(), false, 'an unrelated later chest request has its own owner')
  await f.captured.adapter.release(ID)
  assert.equal(f.bridge.isBusy(), false); assert.deepEqual(f.closes, [])
})

test('native deposit checkpoints persist under only the validated operation UUID, including after revocation', async t => {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'mc-manual-chest-'))
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(directory).startsWith('mc-manual-chest-'))
    await io.rm(directory, { recursive: true, force: true })
  })
  const f = fixture({ journalDirectory: directory }); await f.acquire()
  const document = { version: 1, operationId: ID, jobId: 'manual_chest_' + ID, scope: observedScope(f.state), phase: 'paused', checkpoint: { intent: { beforeMain: 'retained-raw' } } }
  f.bridge.cancel('stop')
  await f.captured.adapter.save(document)
  assert.deepEqual(await f.captured.adapter.load(ID), document)
  assert.deepEqual((await io.readdir(directory)).sort(), [ID + '.json', 'latest.json'].sort())
  await assert.rejects(f.captured.adapter.load('../other'), { code: 'MANUAL_DEPOSIT_OPERATION_INVALID' })
  await assert.rejects(f.captured.adapter.save({ ...document, operationId: OTHER }), { code: 'MANUAL_DEPOSIT_OPERATION_INVALID' })
  await f.captured.adapter.release(ID)
  f.captured.acquireError = Object.assign(new Error('other owner is busy'), { code: 'MANUAL_DEPOSIT_BUSY' })
  await assert.rejects(f.captured.adapter.acquire(OTHER, { scope: observedScope(f.state), preview: true }), { code: 'MANUAL_DEPOSIT_BUSY' })
  await assert.rejects(f.captured.adapter.save({ ...document, operationId: OTHER }), { code: 'MANUAL_DEPOSIT_OPERATION_INVALID' })
  assert.deepEqual((await io.readdir(directory)).sort(), [ID + '.json', 'latest.json'].sort(), 'an unacquired operation cannot establish journal ownership')
  const replacement = fixture({ journalDirectory: directory })
  assert.deepEqual(await replacement.captured.adapter.loadPending(), document, 'a recreated adapter finds only the durable operation pointer')
  await replacement.acquire()
  await replacement.captured.adapter.save({ ...document, phase: 'completed', serverConfirmed: true })
  assert.equal(await replacement.captured.adapter.loadPending(), null)
  await replacement.captured.adapter.release(ID)
  await io.writeFile(path.join(directory, 'latest.json'), JSON.stringify({ operationId: '../foreign' }))
  await assert.rejects(replacement.captured.adapter.loadPending(), { code: 'MANUAL_DEPOSIT_OPERATION_INVALID' })
})
