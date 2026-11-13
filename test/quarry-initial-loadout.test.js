'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryV22ChestWork } = require('../src/quarry-v22-chest-work')
const { carriedContainerKey } = require('../src/quarry-inventory')
const { permits, buildRegions } = require('../src/quarry-region')
const { supplySitePreview } = require('./helpers/supply-site-preview')
const { supplyNeeds } = require('../src/quarry-supplies')
const file = require.resolve('./quarry-v22-chest-work.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, raw, empty }\n', file)
const { fixture: chestFixture, raw, empty } = loaded.exports
const copy = value => structuredClone(value)
const home = { position: { x: 2, y: 63, z: -1 }, other: { x: 3, y: 63, z: -1 }, stand: { x: 1, y: 63, z: -1 }, stage: { x: 0, y: 63, z: -1 }, chunk: { x: 0, z: -1 } }
function fixture ({ missing = false, blockedSupply = true, rejectTransfer = false, mutateSave = null, seal = false, corruptStock = false, delayedHand = false, neverHand = false, invalidCp = false, cargoDirt = 0, loseDirtBox = false, renumber = false, boxStillPlaced = false, jobOptions = {} } = {}) {
  const f = chestFixture({ missing }), blocks = new Map(), saved = [], requests = [], events = []
  // The shared routing fixture has decoded contents separately. Its raw
  // identity still needs an actual typed compound for received-prefix checks.
  for (const item of f.base) if (item.network_id && item.extra?.nbt?.name) {
    item.extra.nbt = { version: 1, nbt: { type: 'compound', name: '', value: { FixtureName: { type: 'string', value: item.extra.nbt.name } } } }
  }
  Object.assign(f.pos, home.position)
  f.state.position = { x: 1.5, y: 64.62, z: -0.5 }
  f.state.maxHealth = 20; f.state.food = 20
  const getBlock = (x, y, z) => blocks.get([x, y, z].join(',')) ?? { known: true, name: y < 63 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 63 ? 'block' : 'empty', runtimeId: 1, properties: {}, extra: [] }
  for (const p of [home.position, home.other]) blocks.set([p.x, p.y, p.z].join(','), { known: true, name: 'minecraft:chest', boundingBox: 'block', extra: [] })
  const describe = () => f.view().slots.filter(row => !row.empty).map(row => ({ ...copy(row), stackId: f.bag[row.slot].stack_id, raw: copy(f.bag[row.slot]),
    ...(/_(pickaxe|shovel)$/.test(row.name) ? { durabilityKnown: true, maxDurability: 1561, durabilityRemaining: 1500, durabilityUsed: 61 } : {}) }))
  Object.defineProperty(f.state.inventory, 'items', { configurable: true, get: describe })
  const getState = () => ({ ...f.state, inventory: { known: f.state.inventory.known, uncertain: f.state.inventory.uncertain, items: describe() } })
  let handReceived = true
  const actualView = () => { const view = f.view(); return { ...view, slots: view.slots.map(row => ({ ...row, ...(!row.empty ? { stackId: f.bag[row.slot].stack_id } : {}) })),
    ...(!handReceived ? { offhand: { known: false, slots: [{ slot: 0, known: false, empty: false, name: null, count: null }] } } : {}) } }
  if (seal) blocks.set('2,62,1', { known: true, name: 'minecraft:water', boundingBox: 'empty', runtimeId: 100, properties: { liquid_depth: 0 }, extra: [] })
  let mining = 0, moves = 0, maxMain = 0, seals = 0, controller, holdSeen = null, holdAfter = null
  const bindings = () => ['pickaxe', 'shovel', 'dirt', 'totem'].map((role, i) => {
    const name = ['blue', 'light_blue', 'brown', 'yellow'][i] + '_shulker_box'
    const item = describe().find(row => row.name === 'minecraft:' + name)
    return { role, itemName: 'minecraft:' + ['diamond_pickaxe', 'stone_shovel', 'dirt', 'totem_of_undying'][i], key: carriedContainerKey(item), boxName: item.name, stackId: item.stackId }
  })
  const add = (name, count) => {
    const merge = describe().find(row => row.name === name && row.count + count <= 64 && name === 'minecraft:dirt')
    if (merge) { f.bag[merge.slot].count += count; return }
    const slot = f.bag.findIndex(row => row.count === 0); assert.ok(slot >= 0, 'only actual empty main slots may receive supplies'); f.bag[slot] = raw(name, count, 900 + slot)
  }
  const adapter = {
    getState, getBlock, entities: () => [], equipmentView: actualView, registeredHomeChest: () => copy(home),
    async mine () { mining++; events.push('mine'); assert.equal(f.transfers.filter(row => row.kind === 'withdraw').length, 34); f.state.health = 0; throw new Error('bounded scene ends after actual kit and supplies') },
    async moveTo (p) { moves++; events.push('move'); f.state.position = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 } },
    async equip (slot) { f.state.selectedSlot = slot; f.state.heldItem = { name: f.view().slots[slot].name, slot }; return { phase: 'completed' } },
    async place ({ position, slot, expectedBlock }) {
      assert.equal(f.bag[slot].count, 64, 'work sealing consumes real work dirt without reserving unseen carried dirt')
      f.bag[slot].count--; blocks.set([position.x, position.y, position.z].join(','), { known: true, name: expectedBlock, boundingBox: 'block', runtimeId: 3, properties: {}, extra: [] })
      seals++; events.push('seal'); return { phase: 'completed', confirmedBy: 'server_block_and_inventory' }
    },
    async stopAll () {}, combatActive: () => false,
    async storeCarried () { assert.fail('a nonfull bag must not trigger storage') },
    async finalChestDeposit () { assert.fail('passive/full does not gain four-layer final chest deposit') },
    async logout () { assert.fail('passive/full does not gain four-layer logout') },
    async egress () { assert.fail('the focused start fixture cannot ascend') },
    discoverSupplies (layout) {
      if (f.transfers.filter(row => row.kind === 'withdraw').length !== 34) return { ok: false, reason: 'SUPPLY_BOXES_UNCONFIRMED' }
      assert.equal(layout, 'v22'); return { ok: true, bindings: bindings() }
    },
    async loadoutWithdraw (request, options) {
      events.push('loadout'); assert.equal(mining, 0)
      controller ??= createQuarryV22ChestWork({ ...f.ports, getState })
      const result = await controller.withdrawAll(request, { ...options, onCheckpoint: async cp => {
        if (invalidCp && cp.phase === 'completed') cp.identities.pop()
        await options.onCheckpoint(cp)
      } })
      if (result.status === 'completed') events.push('loadout_received')
      return result
    },
    async restockSupplies (request, { onCheckpoint }) {
      events.push('supplies'); requests.push(request)
      assert.equal(f.transfers.filter(row => row.kind === 'withdraw').length, 34)
      assert.equal(mining, 0); assert.equal(request.policy.pickupMode, 'passive'); assert.equal(request.policy.depositWhen, 'full')
      assert.equal(request.policy.deferExitSupplies, true)
      if (blockedSupply) return { status: 'blocked', serverConfirmed: false, reason: 'TEST_INITIAL_SUPPLY_BLOCKED' }
      if (cargoDirt && requests.length === 1) {
        // The mining put dirt (and other blocks) into a carried cargo box.
        const cargo = f.bag[describe().find(row => row.name === 'minecraft:purple_shulker_box').slot]
        cargo.contents = [...Array.from({ length: Math.ceil(cargoDirt / 64) }, (_, i) => ({ name: 'minecraft:dirt', count: Math.min(64, cargoDirt - i * 64) })), { name: 'minecraft:cobblestone', count: 64 }]
      }
      // Live 2026-11-14 00:03: the placed dirt supply box was never picked up
      // (combat, then a new connection); the block is air and it is not carried.
      if (loseDirtBox && requests.length === 1) {
        const boxCount = describe().filter(row => /shulker_box$/.test(row.name)).length
        const brown = describe().find(row => row.name === 'minecraft:brown_shulker_box')
        f.bag[brown.slot] = empty()
        // A reconnect gives every carried box a new stack ID (live 2026-11-14 02:19).
        if (renumber) for (const row of f.bag) if (row.count && /shulker_box/.test(row.network_id ? describe().find(d => d.stackId === row.stack_id)?.name ?? '' : '')) row.stack_id += 5000
        const scope = { lost: true }
        await onCheckpoint({ version: 1, jobId: request.jobId, operationId: request.operationId, scope, bindings: copy(request.bindings), policy: copy(request.policy), boxCount, index: 2, withdrawn: [], returned: [],
          child: { version: 1, kind: 'shulker', stage: 'breaking', scope, selectionKey: request.bindings[2].key, placed: [{ name: 'minecraft:brown_shulker_box', position: { x: 5, y: 63, z: 5 } }], supplyCheckpoint: { withdrawn: [] } } })
        holdSeen = job.shulkerHold()
        if (boxStillPlaced) { blocks.set('5,63,5', { known: true, name: 'minecraft:brown_shulker_box', boundingBox: 'block', runtimeId: 9, properties: {}, extra: [] }); return { status: 'blocked', serverConfirmed: false, reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', checkpoint: null } }
        return { status: 'blocked', serverConfirmed: false, reason: 'SUPPLY_SCOPE_CHANGED', checkpoint: null }
      }
      const need = supplyNeeds(describe(), request.policy)
      for (const [role, name] of [['pickaxe', 'diamond_pickaxe'], ['shovel', 'stone_shovel'], ['totem', 'totem_of_undying']]) if (need.missing[role]) add('minecraft:' + name, need.missing[role])
      if (need.missing.dirt) add('minecraft:dirt', need.missing.dirt)
      maxMain = Math.max(maxMain, describe().length)
      assert.equal(maxMain, loseDirtBox ? 33 : 34)
      const dirtKey = request.bindings.find(b => b.role === 'dirt').key
      const dirt = f.bag[describe().find(row => carriedContainerKey(row) === dirtKey).slot]
      let remaining = need.missing.dirt
      for (let i = 0; i < 27 && remaining; i++) { const row = dirt.contents[i]; if (!row || row.name !== 'minecraft:dirt') continue; const take = Math.min(row.count, remaining); row.count -= take; remaining -= take; if (!row.count) dirt.contents[i] = null }
      if (corruptStock) dirt.contents = Array.from({ length: 27 }, () => null)
      await onCheckpoint({ version: 1, jobId: request.jobId, operationId: request.operationId, phase: 'completed' })
      holdAfter = job.shulkerHold()
      return { status: 'completed', serverConfirmed: true, bindings: copy(request.bindings), withdrawn: [{ role: 'dirt', count: 64 }], returned: [] }
    },
    async equipmentTransfer (request) {
      events.push('totem'); assert.equal(request.from, 'main'); assert.equal(request.to, 'offhand')
      f.hand[0] = f.bag[request.fromSlot]; f.bag[request.fromSlot] = empty()
      if (delayedHand || neverHand) handReceived = false
      return { serverConfirmed: true }
    },
    async resyncInventory () { events.push('resync'); if (!neverHand) handReceived = true; return true }
  }
  adapter.previewSupplySite = supplySitePreview(adapter)
  if (rejectTransfer) f.ports.withdraw = async () => ({ serverConfirmed: false })
  let clock = Date.now()
  const job = createQuarryJob({ adapter, storageMode: 'shulker', pollMs: 5, ...jobOptions, sleep: () => turn(), ...(neverHand ? { now: () => (clock += 100) } : {}), storage: { save: async (_id, doc) => { saved.push(copy(doc)); mutateSave?.(doc, f) } } })
  const config = { jobId: 'initial-loadout-full', initialLoadout: 'v22', homeChest: copy(home), target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 61,
    worldMinY: 50, worldMaxY: 80, inventory: { pickupMode: 'passive', depositWhen: 'full' } }
  const run = async ({ resume = false } = {}) => {
    if (resume) job.resume(); else job.start()
    const until = Date.now() + 6000
    while (job.status().state !== 'PAUSED' && job.status().state !== 'FINISHED') { if (Date.now() > until) { await job.pause(); throw Error('bounded initial loadout test timed out') } await turn() }
    const status = job.status(); await job.pause(); return status
  }
  return { f, job, adapter, config, blocks, saved, requests, events, run, receiveHand: () => { handReceived = true }, get mining () { return mining }, get holdSeen () { return holdSeen }, get holdAfter () { return holdAfter }, get moves () { return moves }, get maxMain () { return maxMain }, get seals () { return seals } }
}

test('a passive/full plan defers actual inventory until start without changing its separate target or storage policy', () => {
  const f = fixture(), summary = f.job.plan(f.config), doc = f.job.document()
  assert.equal(summary.ready, true, JSON.stringify(summary.issues))
  assert.deepEqual(summary.chunks, [{ x: 0, z: 0 }]); assert.deepEqual(doc.config.homeChest.chunk, { x: 0, z: -1 })
  assert.equal(doc.config.inventory.pickupMode, 'passive'); assert.equal(doc.config.inventory.depositWhen, 'full'); assert.equal(doc.config.inventory.supplyLayout, 'v22')
  assert.equal(doc.config.inventory.minFreeSlots, 3); assert.equal(doc.config.inventory.keepExitDirt, 192)
  assert.deepEqual(summary.initialLoadout, { mode: 'v22', pending: true, serverConfirmed: false, position: home.position })
  assert.ok(summary.warnings.some(row => row.code === 'INITIAL_LOADOUT_ON_START'))
  for (const code of ['NO_PICKAXE', 'NO_FOOD', 'NO_SEAL_MATERIAL']) assert.ok(!summary.warnings.some(row => row.code === code))
  assert.equal(f.f.transfers.length, 0); assert.equal(f.mining, 0); assert.equal(f.moves, 0); assert.equal(f.saved.length, 0)
  const regions = buildRegions({ target: f.config.target, yTop: summary.yTop, yBottom: 61, travelRegion: summary.travelRegion, protectedRegion: doc.config.permissions.protectedRegion })
  assert.equal(permits(regions, 'travel', home.stand).allowed, true)
  assert.equal(permits(regions, 'break', home.position).allowed, false)
})

test('all 34 native receipt-backed stacks must complete before initial supplies, exit planning or mining', async () => {
  const f = fixture(); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run(), doc = f.job.document()
  assert.equal(result.pauseReason, 'SUPPLY_RESTOCK_BLOCKED')
  assert.equal(f.f.transfers.filter(row => row.kind === 'withdraw').length, 34)
  assert.equal(doc.loadoutReady, true); assert.equal(doc.loadout.checkpoint.phase, 'completed'); assert.equal(doc.loadout.checkpoint.index, 34)
  assert.equal(doc.loadout.checkpoint.receipts.length, 34); assert.equal(doc.loadout.checkpoint.identities.length, 34)
  assert.equal(f.requests.length, 1); assert.equal(f.mining, 0); assert.equal(doc.exitPreflight, undefined)
  assert.ok(f.events.indexOf('loadout_received') < f.events.indexOf('supplies'))
  assert.ok(f.requests[0].canPlace({ x: 0, y: 63, z: 1 }))
  assert.equal(f.requests[0].canPlace(home.stage), false, 'initial supply placement stays inside the selected target')
})

test('actual initial supplies fit, the received totem leaves main, and only then may passive/full mining begin', async () => {
  const f = fixture({ blockedSupply: false }); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run()
  assert.equal(f.maxMain, 34); assert.equal(f.f.bag.filter(row => row.count > 0).length, 33, JSON.stringify({ result, events: f.events }))
  assert.equal(f.f.view().offhand.slots[0].name, 'minecraft:totem_of_undying')
  assert.ok(f.events.indexOf('loadout_received') < f.events.indexOf('supplies'))
  assert.ok(f.events.indexOf('supplies') < f.events.indexOf('totem'))
  assert.ok(f.events.indexOf('totem') < f.events.indexOf('mine'), JSON.stringify({ reason: result.pauseReason, details: result.pauseDetails, events: f.events, decision: result.lastDecision }))
  assert.equal(f.mining, 1)
  assert.equal(f.job.document().config.inventory.depositWhen, 'full')
  assert.equal(f.job.document().exitPreflight, undefined, 'deferred stock is not falsely recorded as a carried-dirt exit plan')
})

test('64 actual work dirt can seal a source while the verified bound box retains the future exit reserve', async () => {
  const f = fixture({ blockedSupply: false, seal: true }); assert.equal(f.job.plan(f.config).ready, true)
  await f.run()
  assert.equal(f.seals, 1)
  assert.equal(f.blocks.get('2,62,1').name, 'minecraft:dirt')
  assert.ok(f.events.indexOf('totem') < f.events.indexOf('seal'))
  assert.equal(f.job.document().ledger.placedTemporary.dirt, 1)
})

test('unknown or insufficient deferred stock cannot be counted as carried exit dirt or authorize mining', async () => {
  const f = fixture({ blockedSupply: false, corruptStock: true }); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run()
  assert.equal(result.pauseReason, 'EXIT_SUPPLY_MISSING')
  assert.equal(f.mining, 0); assert.equal(result.egress.dirtAvailable, 64)
})

test('a late actual offhand receipt is refreshed before mining and an accepted move is never repeated', async () => {
  const f = fixture({ blockedSupply: false, delayedHand: true }); assert.equal(f.job.plan(f.config).ready, true)
  await f.run()
  assert.equal(f.events.filter(row => row === 'totem').length, 1)
  assert.ok(f.events.indexOf('totem') < f.events.indexOf('resync'))
  assert.ok(f.events.indexOf('resync') < f.events.indexOf('mine'))
  assert.equal(f.job.document().pendingTotemEquip, undefined)
  assert.ok(f.saved.some(doc => doc.pendingTotemEquip?.stage === 'accepted'))
})

test('an ACK alone keeps the accepted totem intent and explicit resume observes it without another equip', async () => {
  const f = fixture({ blockedSupply: false, neverHand: true }); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run()
  assert.equal(result.pauseReason, 'TOTEM_EQUIP_UNCONFIRMED'); assert.equal(f.mining, 0)
  assert.equal(f.job.document().pendingTotemEquip.stage, 'accepted')
  f.receiveHand()
  await f.run({ resume: true })
  assert.equal(f.events.filter(row => row === 'totem').length, 1)
  assert.equal(f.mining, 1); assert.equal(f.job.document().pendingTotemEquip, undefined)
})

test('an invalid completed native checkpoint cannot authorize initial supplies or mining', async () => {
  const f = fixture({ invalidCp: true }); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run()
  assert.equal(result.pauseReason, 'LOADOUT_RECEIPTS_UNCONFIRMED')
  assert.equal(f.requests.length, 0); assert.equal(f.mining, 0)
  assert.notEqual(f.job.document().loadoutReady, true)
})

// 2026-11-13 user request: by default everything returns to the registered chest.
test('a returned passive/full job stores everything at the registered chest before FINISHED', async () => {
  const f = fixture({ blockedSupply: false }); f.job.plan(f.config); await f.run()
  f.f.state.health = 20
  const doc = f.job.document()
  doc.state = 'PAUSED'; doc.userRunIntent = 'paused'; doc.pauseReason = 'MANUAL_PAUSE'; doc.records = {}
  doc.surfaceReturnedAt = '2026-11-12T00:00:00Z'; doc.miningCompletedAt = '2026-11-12T00:00:00Z'
  f.job.load(doc)
  const requests = []
  f.adapter.finalChestDeposit = async (request, { onCheckpoint }) => { requests.push(request); const cp = { operationId: request.operationId, phase: 'completed', receipts: [] }; await onCheckpoint(cp); return { status: 'completed', serverConfirmed: true, checkpoint: cp } }
  const emptySlots = n => ({ known: true, slots: Array.from({ length: n }, (_, slot) => ({ slot, known: true, empty: true })) })
  f.adapter.inventoryDetails = () => ({ known: true, slots: emptySlots(36).slots, armor: emptySlots(4), offhand: emptySlots(1) })
  let logouts = 0; f.adapter.logout = async () => { logouts++ }
  const result = await f.run({ resume: true })
  assert.equal(result.state, 'FINISHED')
  assert.equal(requests.length, 1); assert.equal(requests[0].keep, undefined, 'nothing is kept back')
  assert.ok(f.job.document().finalChestStoredAt)
  assert.equal(logouts, 1, 'the unarmed bot logs out normally after the full return')
})

// 2026-11-13 18:35: after the storage the user saw an offhand item. The job
// fetches the inventory again and FINISHED needs a received empty offhand.
test('a final storage that leaves the offhand occupied is not FINISHED', async () => {
  const f = fixture({ blockedSupply: false }); f.job.plan(f.config); await f.run()
  f.f.state.health = 20
  const doc = f.job.document()
  doc.state = 'PAUSED'; doc.userRunIntent = 'paused'; doc.pauseReason = 'MANUAL_PAUSE'; doc.records = {}
  doc.surfaceReturnedAt = '2026-11-12T00:00:00Z'; doc.miningCompletedAt = '2026-11-12T00:00:00Z'
  f.job.load(doc)
  f.adapter.finalChestDeposit = async (request, { onCheckpoint }) => { const cp = { operationId: request.operationId, phase: 'completed', receipts: [] }; await onCheckpoint(cp); return { status: 'completed', serverConfirmed: true, checkpoint: cp } }
  const emptySlots = n => ({ known: true, slots: Array.from({ length: n }, (_, slot) => ({ slot, known: true, empty: true })) })
  f.adapter.inventoryDetails = () => ({ known: true, slots: emptySlots(36).slots, armor: emptySlots(4), offhand: { known: true, slots: [{ slot: 0, known: true, empty: false, name: 'minecraft:totem_of_undying', count: 1 }] } })
  const result = await f.run({ resume: true })
  assert.equal(result.state, 'PAUSED'); assert.equal(result.pauseReason, 'FINAL_INVENTORY_UNCONFIRMED')
  assert.equal(f.job.document().finalChestStoredAt, undefined)
})

test('with final chest storage off, a returned passive/full job keeps its nonfull inventory without final chest deposit or logout', async () => {
  const f = fixture({ blockedSupply: false }); f.job.plan({ ...f.config, strategy: { ...(f.config.strategy ?? {}), finalChestStore: false } }); await f.run()
  f.f.state.health = 20
  const before = copy(f.f.bag), doc = f.job.document()
  doc.state = 'PAUSED'; doc.userRunIntent = 'paused'; doc.pauseReason = 'MANUAL_PAUSE'; doc.records = {}
  doc.surfaceReturnedAt = '2026-11-12T00:00:00Z'; doc.miningCompletedAt = '2026-11-12T00:00:00Z'
  f.job.load(doc)
  const result = await f.run({ resume: true })
  assert.equal(result.state, 'FINISHED')
  assert.deepEqual(f.f.bag, before)
  assert.equal(f.job.document().finalChest, undefined)
})

for (const mode of ['unknownGear', 'occupied', 'noSource', 'noPort', 'invalidMarker']) test(`${mode} never waives ordinary empty-start validation`, () => {
  const f = fixture()
  if (mode === 'unknownGear') f.adapter.equipmentView = () => ({ ...f.f.view(), armor: { known: false, slots: [] } })
  if (mode === 'occupied') f.f.bag[35] = raw('minecraft:diamond', 1, 1000)
  if (mode === 'noSource') f.adapter.registeredHomeChest = () => null
  if (mode === 'noPort') delete f.adapter.loadoutWithdraw
  if (mode === 'invalidMarker') f.config.initialLoadout = 'other'
  const summary = f.job.plan(f.config)
  assert.equal(summary.ready, false)
  assert.ok(summary.issues.includes('NO_CARGO_SHULKER'))
  assert.equal(f.f.transfers.length, 0); assert.equal(f.mining, 0)
})

for (const mode of ['missing', 'rejected', 'changed', 'pickupAfterIntent']) test(`${mode} kit evidence stops before unconfirmed receipt or mining`, async () => {
  const f = fixture({ missing: mode === 'missing', rejectTransfer: mode === 'rejected', mutateSave: mode === 'pickupAfterIntent' ? (doc, native) => {
    if (doc.loadout && doc.loadout.checkpoint == null) native.bag[35] = raw('minecraft:diamond', 1, 1100)
  } : null })
  assert.equal(f.job.plan(f.config).ready, true)
  if (mode === 'changed') f.blocks.set('2,63,-1', { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
  const result = await f.run()
  assert.equal(result.state, 'PAUSED')
  assert.equal(f.job.document().loadoutReady, undefined)
  assert.equal(f.mining, 0); assert.equal(f.requests.length, 0)
  assert.equal(f.f.transfers.length, 0)
})

test('the new marker caps work at Y75 and preserves an explicitly chosen slot reserve', () => {
  const f = fixture(); f.config.yTop = 90; f.config.worldMaxY = 100; f.config.inventory.minFreeSlots = 5
  const summary = f.job.plan(f.config)
  assert.equal(summary.yTop, 75); assert.equal(f.job.document().config.inventory.minFreeSlots, 5)
})

test('a recovered partial startup returns to the existing loadout checkpoint before checking future supply stock', async () => {
  let interrupted = false
  const f = fixture(), withdraw = f.adapter.loadoutWithdraw
  f.adapter.loadoutWithdraw = (request, options) => withdraw(request, { ...options, onCheckpoint: async cp => {
    await options.onCheckpoint(cp)
    if (!interrupted && cp.index === 4) { interrupted = true; throw Object.assign(new Error('combat handoff after durable receipt'), { code: 'COMBAT' }) }
  } })
  assert.equal(f.job.plan(f.config).ready, true)
  await f.run()
  const partial = f.job.document()
  assert.equal(partial.loadout.checkpoint.index, 4)
  assert.notEqual(partial.loadoutReady, true)
  f.f.state.health = 20
  partial.state = 'PAUSED'; partial.userRunIntent = 'paused'; partial.pauseReason = 'COMBAT'
  const state = f.f.state
  partial.scope = JSON.stringify([state.profile, state.realm?.id ?? state.realmId ?? null, state.dimension, state.connectionId ?? null, state.startedAt ?? null])
  partial.life = state.lifecycle.deathId
  f.job.load(partial)
  const result = await f.run({ resume: true })
  assert.equal(result.pauseReason, 'SUPPLY_RESTOCK_BLOCKED', JSON.stringify(result))
  assert.equal(f.f.transfers.filter(row => row.kind === 'withdraw').length, 34)
  assert.equal(f.job.document().loadoutReady, true)
  assert.equal(f.requests.length, 1); assert.equal(f.mining, 0)
})

test('live case 2026-11-14: the received dirt in a carried cargo box covers the exit when the dirt supply box is empty', async () => {
  const f = fixture({ blockedSupply: false, corruptStock: true, cargoDirt: 256 }); assert.equal(f.job.plan(f.config).ready, true)
  const result = await f.run()
  assert.notEqual(result.pauseReason, 'EXIT_SUPPLY_MISSING', JSON.stringify(result.pauseDetails))
  assert.equal(f.mining, 1)
  const doc = f.job.document(), dirt = doc.config.inventory.supplyBoxes.find(b => b.role === 'dirt')
  assert.equal(dirt.boxName, 'minecraft:purple_shulker_box')
  assert.equal(doc.dirtSourceChanges.length, 1); assert.equal(doc.dirtSourceChanges[0].dirt, 256)
})

async function untilMining (f, ms = 6000) {
  const until = Date.now() + ms
  while (f.mining === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  const status = f.job.status(); await f.job.pause(); return status
}

test('live case 2026-11-14: a lost dirt supply box is searched for, accepted as lost, and the cargo box dirt becomes the source', async () => {
  const f = fixture({ blockedSupply: false, loseDirtBox: true, cargoDirt: 256, jobOptions: { cargoLossSearchMs: 40, cargoLossStepMs: 5 } }); assert.equal(f.job.plan(f.config).ready, true)
  f.job.start()
  const status = await untilMining(f)
  assert.equal(f.mining, 1, JSON.stringify({ state: status.state, reason: status.pauseReason, details: status.pauseDetails }))
  const doc = f.job.document()
  assert.equal(doc.lostCargoBoxes.length, 1)
  assert.equal(doc.lostCargoBoxes[0].box, 'minecraft:brown_shulker_box'); assert.equal(doc.lostCargoBoxes[0].kind, 'supply'); assert.equal(doc.lostCargoBoxes[0].acceptedBy, 'auto')
  assert.equal(doc.config.inventory.supplyBoxes.find(b => b.role === 'dirt').boxName, 'minecraft:purple_shulker_box')
  assert.equal(f.requests[1].bindings.find(b => b.role === 'dirt').boxName, 'minecraft:purple_shulker_box', 'the next withdrawal is the ordinary supply operation on the cargo box')
  assert.equal(status.lostCargoBoxes.length, 1, 'the loss is listed for the dashboard')
  // 2026-11-14 user: box recovery has priority over combat. While the box was
  // out (breaking) the job reported a hold; with the box back, none.
  assert.deepEqual({ kind: f.holdSeen?.kind, stage: f.holdSeen?.stage, box: f.holdSeen?.box }, { kind: 'supply', stage: 'breaking', box: 'minecraft:brown_shulker_box' })
  assert.equal(f.holdAfter, null)
  assert.equal(f.job.shulkerHold(), null, 'a paused job holds nothing')
})

test('a lost dirt supply box is not accepted when no carried cargo box holds enough received dirt', async () => {
  const f = fixture({ blockedSupply: false, loseDirtBox: true, jobOptions: { cargoLossSearchMs: 40, cargoLossStepMs: 5 } }); assert.equal(f.job.plan(f.config).ready, true)
  f.job.start()
  const until = Date.now() + 3000
  while (!f.job.document().dirtSupplyLossStopped && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  const doc = f.job.document()
  assert.equal(doc.pauseReason, 'SUPPLY_RESTOCK_BLOCKED'); assert.equal(doc.dirtSupplyLossStopped, 'CARGO_DIRT_SHORT')
  assert.equal(doc.lostCargoBoxes, undefined); assert.equal(f.mining, 0)
  await f.job.pause()
})

test('live case 2026-11-14 02:19: after a reconnect renumbers the carried boxes, the supply bindings are re-found before the next restock', async () => {
  const f = fixture({ blockedSupply: false, loseDirtBox: true, cargoDirt: 256, renumber: true, jobOptions: { cargoLossSearchMs: 40, cargoLossStepMs: 5 } }); assert.equal(f.job.plan(f.config).ready, true)
  f.job.start()
  const until = Date.now() + 6000
  while (f.mining === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  await f.job.pause()
  assert.equal(f.mining, 1, JSON.stringify({ reason: f.job.status().pauseReason, details: f.job.status().pauseDetails }))
  const carried = new Set(f.f.view().slots.filter(r => !r.empty).map(r => carriedContainerKey({ ...r, stackId: f.f.bag[r.slot].stack_id })))
  for (const b of f.requests[1].bindings) assert.ok(carried.has(b.key), b.role + ' ' + b.key + ' is carried')
  assert.ok(f.job.status().events.some(e => e.type === 'supply_bindings_refreshed'))
})

test('live case 2026-11-14 02:38: a placed dirt box waiting for pickup room is not searched for as lost; the capacity retry is armed', async () => {
  const f = fixture({ blockedSupply: false, loseDirtBox: true, boxStillPlaced: true, cargoDirt: 256, jobOptions: { cargoLossSearchMs: 40, cargoLossStepMs: 5 } }); assert.equal(f.job.plan(f.config).ready, true)
  f.job.start()
  const until = Date.now() + 3000
  while (f.job.status().state !== 'PAUSED' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  const status = f.job.status()
  assert.equal(status.pauseReason, 'SUPPLY_RESTOCK_BLOCKED'); assert.equal(status.pauseDetails.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
  assert.equal(status.events.some(e => e.type === 'supply_loss_search'), false)
  assert.equal(status.autoRetry?.kind, 'capacity', JSON.stringify(status.autoRetry))
  await f.job.pause()
})
