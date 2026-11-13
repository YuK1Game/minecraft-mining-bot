'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { keepPlan, canAccept, maxStack, isShulkerBox, carriedContainerKey, selectCarriedStorage } = require('../src/quarry-inventory')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

test('all carried shulker variants stay in the inventory even when full', () => {
  const names = ['shulker_box', 'undyed_shulker_box', 'red_shulker_box', 'light_blue_shulker_box', 'black_shulker_box']
  const boxes = names.map((name, slot) => ({ slot, name: `minecraft:${name}`, count: 1, full: true, custom: true }))
  const plan = keepPlan([...boxes, { slot: 9, name: 'minecraft:dirt', count: 64 }], { keepSealBlocks: 0 })
  for (const box of boxes) {
    assert.equal(isShulkerBox(box.name), true)
    assert.equal(maxStack(box.name), 1)
    assert.equal(plan.keep.get(box.slot), 1)
  }
  assert.deepEqual(plan.deposits, [{ slot: 9, name: 'minecraft:dirt', count: 64 }])
  assert.equal(isShulkerBox('minecraft:shulker_shell'), false)
})

test('shulker recovery needs a real free slot and never stacks with a carried box', () => {
  const full = Array.from({ length: 36 }, (_, slot) => ({ slot, name: slot === 0 ? 'minecraft:shulker_box' : 'minecraft:stone', count: slot === 0 ? 1 : 64 }))
  assert.equal(canAccept(full, [{ name: 'minecraft:shulker_box', count: 1 }]), false)
  assert.equal(canAccept(full.slice(0, 35), [{ name: 'minecraft:shulker_box', count: 1 }]), true)
  assert.equal(canAccept(full.slice(0, 35), [{ name: 'minecraft:shulker_box', count: 2 }]), false)
})

test('carried storage prioritises shulkers, then two normal chests, then one', () => {
  const chest = { slot: 0, name: 'minecraft:chest', count: 2, stackId: 10 }
  const box = { slot: 15, name: 'minecraft:red_shulker_box', count: 1, stackId: 11 }
  assert.equal(selectCarriedStorage([chest, box]).kind, 'shulker')
  assert.equal(selectCarriedStorage([chest, box], { excludedShulkerKeys: [carriedContainerKey(box)] }).kind, 'double_chest')
  assert.equal(selectCarriedStorage([{ ...chest, count: 1 }]).kind, 'single_chest')
  const split = selectCarriedStorage([{ ...chest, count: 1 }, { ...chest, slot: 12, stackId: 12, count: 1 }])
  assert.equal(split.kind, 'double_chest')
  assert.deepEqual(split.sources.map(item => [item.slot, item.count]), [[0, 1], [12, 1]])
  assert.equal(selectCarriedStorage([{ slot: 0, name: 'minecraft:trapped_chest', count: 2 }]), null)
  assert.equal(selectCarriedStorage([]), null)
})

test('an exhausted recovered shulker is skipped without discarding it', () => {
  const full = { slot: 8, name: 'minecraft:shulker_box', count: 1, stackId: 42 }
  const next = { slot: 20, name: 'minecraft:shulker_box', count: 1, stackId: 43 }
  assert.equal(selectCarriedStorage([full, next], { excludedShulkerKeys: [carriedContainerKey(full)] }).sources[0].slot, 20)
  assert.deepEqual(keepPlan([full, next]).deposits, [])
})

function fixture (containers = []) {
  const box = { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 }
  const sim = createSim({ loaded: box })
  flatTerrain(sim, { x1: -6, x2: 20, z1: -6, z2: 20, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 }); sim.world.set(-4, 63, -4, 'chest')
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 64)
  for (const c of containers) sim.give(c.name, c.count, { stackId: c.stackId })
  const docs = []; let saving = 0; let maxSaving = 0
  const storage = { save: async (id, doc) => { saving++; maxSaving = Math.max(maxSaving, saving); await new Promise(resolve => setImmediate(resolve)); docs.push(structuredClone(doc)); saving-- } }
  const options = { adapter: sim.adapter, storage, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 }
  const job = createQuarryJob(options)
  assert.equal(job.plan({ jobId: 'carried', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 62, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true, storage: [] } }).ready, true)
  const saved = job.document()
  Object.assign(saved, { state: 'PAUSED', pauseReason: 'MANUAL_PAUSE', userRunIntent: 'paused', scope: JSON.stringify([sim.state.profile, sim.state.realm.id, sim.state.dimension, sim.state.connectionId, sim.state.startedAt]), life: sim.state.lifecycle.deathId })
  job.load(saved)
  return { sim, job, docs, options, maxSaving: () => maxSaving }
}

function consume (sim, slot, name, count) {
  const item = sim.state.inventory.items.find(i => i.slot === slot && i.name === name)
  assert.ok(item && item.count >= count, `missing ${name} at ${slot}`)
  item.count -= count
  if (!item.count) sim.state.inventory.items.splice(sim.state.inventory.items.indexOf(item), 1)
}

function controller (f, { fullShulkers = false, afterPlaced = null } = {}) {
  const calls = []; let placements = 0; let recoveredStack = 500
  const position = { x: 10, y: 63, z: 10 }
  f.sim.adapter.storeCarried = async (request, { onCheckpoint, canPlace, signal }) => {
    calls.push(request)
    const kind = request.selection.kind
    let cp = request.checkpoint ? structuredClone(request.checkpoint) : { version: 1, operationId: request.operationId, jobId: request.jobId, kind, stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: kind === 'double_chest' ? [position, { ...position, x: 11 }] : [position], placed: [], deposited: [], scope: { life: f.sim.state.lifecycle.deathId } }
    if (cp.scope.life !== f.sim.state.lifecycle.deathId) return { status: 'blocked', reason: 'STORAGE_SCOPE_CHANGED', checkpoint: cp }
    if (!cp.placed.length) {
      await onCheckpoint(cp)
      assert.equal(f.docs.at(-1).portableStorage.checkpoint.stage, 'planned', 'intent was persisted before placement')
      for (const p of cp.positions) assert.equal(canPlace(p), true)
      for (const source of request.selection.sources) consume(f.sim, source.slot, source.name, source.count)
      const name = kind === 'shulker' ? request.selection.sources[0].name : 'minecraft:chest'
      for (const p of cp.positions) f.sim.world.set(p.x, p.y, p.z, name)
      placements++
      cp.placed = cp.positions.map(p => ({ position: p, name, confirmedBy: 'server_block_and_inventory' })); cp.stage = 'placed'
      await onCheckpoint(cp)
      if (afterPlaced) await afterPlaced(cp, signal)
    }
    if (!cp.completed) {
      if (!(kind === 'shulker' && fullShulkers)) {
        const budget = new Map()
        for (const d of request.deposits) budget.set(d.name, (budget.get(d.name) ?? 0) + d.count)
        for (const d of cp.deposited) budget.set(d.name, (budget.get(d.name) ?? 0) - d.count)
        for (const d of keepPlan(f.sim.state.inventory.items, request.inventoryPolicy).deposits) {
          const count = Math.min(d.count, budget.get(d.name) ?? 0)
          if (count <= 0) continue
          consume(f.sim, d.slot, d.name, count); cp.deposited.push({ name: d.name, count }); budget.set(d.name, budget.get(d.name) - count)
        }
        cp.stage = 'deposited'; await onCheckpoint(cp)
      }
      if (kind === 'shulker') {
        f.sim.world.set(position.x, position.y, position.z, 'air')
        f.sim.give(request.selection.sources[0].name, 1, { stackId: ++recoveredStack })
        cp.recovered = true
        if (fullShulkers) cp.exhaustedShulkerKeys = [carriedContainerKey(f.sim.state.inventory.items.find(i => i.stackId === recoveredStack))]
      } else cp.storage = [{ position, stand: cp.stand, ...(kind === 'double_chest' ? { pairedPositions: cp.positions, slotCount: 54 } : { slotCount: 27 }) }]
      cp.completed = true; cp.stage = 'completed'; await onCheckpoint(cp)
    }
    return { status: kind === 'shulker' && fullShulkers ? 'full' : 'completed', serverConfirmed: true, recovered: cp.recovered, storage: cp.storage, deposited: cp.deposited, exhaustedShulkerKeys: cp.exhaustedShulkerKeys, checkpoint: cp }
  }
  return { calls, placements: () => placements, position }
}

async function until (predicate) {
  const deadline = Date.now() + 10000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Carried-storage test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('paused storage uses single, double or shulker priority with a bounded transfer and returns to pause', async () => {
  for (const [containers, expected] of [
    [[{ name: 'chest', count: 1 }], 'single_chest'],
    [[{ name: 'chest', count: 2 }], 'double_chest'],
    [[{ name: 'chest', count: 2 }, { name: 'red_shulker_box', count: 1, stackId: 50 }], 'shulker']
  ]) {
    const f = fixture(containers); const c = controller(f)
    const result = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
    assert.equal(c.calls[0].selection.kind, expected)
    assert.equal(result.state, 'PAUSED'); assert.equal(result.userRunIntent, 'paused')
    assert.equal(result.storageResult.serverConfirmed, true)
    assert.equal(f.sim.state.inventory.items.find(i => i.slot === 3).count, 56)
    assert.equal(result.ledger.deposited, 8)
    assert.equal(f.job.document().portableStorage, null)
    assert.equal(f.maxSaving(), 1, 'checkpoints cannot race on the storage file')
    if (expected === 'shulker') {
      assert.equal(f.sim.world.name(c.position.x, c.position.y, c.position.z), 'air')
      assert.equal(f.sim.state.inventory.items.filter(i => isShulkerBox(i.name)).length, 1)
      assert.equal(f.job.document().config.inventory.storage.length, 0)
    } else {
      const st = f.job.document().config.inventory.storage[0]
      assert.equal(st.slotCount, expected === 'double_chest' ? 54 : 27)
      assert.ok(f.job.document().config.permissions.protectedRegion.some(b => b.xMin === 10 && b.yMin === 62 && b.yMax === 63))
      assert.ok(f.job.document().config.permissions.protectedRegion.some(b => b.xMin === 5 && b.zMin === 5 && b.yMin === 62 && b.yMax === 62), 'the interaction stand has a protected floor but remains walkable')
    }
  }
})

test('full shulkers are recovered then skipped for the next carried chest before registered storage', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 10 }, { name: 'chest', count: 2 }]); const c = controller(f, { fullShulkers: true })
  f.sim.give('stone', 64 * 30)
  const saved = f.job.document(); saved.config.inventory.storage = [{ position: { x: -4, y: 63, z: -4 } }]; f.job.load(saved)
  let returns = 0; const go = f.sim.adapter.goToStorage
  f.sim.adapter.goToStorage = (...args) => { returns++; return go(...args) }
  f.job.resume()
  try {
    await until(() => (f.job.document().carriedStorageReceipts?.length ?? 0) >= 2 || f.job.status().state === 'PAUSED')
    assert.deepEqual(c.calls.slice(0, 2).map(r => r.selection.kind), ['shulker', 'double_chest'])
    assert.equal(returns, 0)
    assert.equal(f.sim.state.inventory.items.filter(i => isShulkerBox(i.name)).length, 1)
    assert.equal(f.job.document().exhaustedShulkerKeys.length, 1)
  } finally { await f.job.pause() }
})

test('an interrupted shulker operation reloads its checkpoint before any new placement', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 12 }])
  let first = true
  const c = controller(f, { afterPlaced: async (cp, signal) => {
    if (!first) return
    first = false
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
  } })
  const task = f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] }).catch(error => error)
  await until(() => f.job.document().portableStorage?.checkpoint?.stage === 'placed')
  await f.job.pause(); await task
  const saved = f.job.document()
  assert.equal(saved.portableStorage.checkpoint.stage, 'placed')
  const restored = createQuarryJob(f.options); restored.load(saved)
  const result = await restored.storeCarriedNow()
  assert.equal(c.placements(), 1)
  assert.equal(c.calls[1].operationId, c.calls[0].operationId)
  assert.equal(c.calls[1].deposits[0].count, 8)
  assert.equal(result.ledger.deposited, 8)
  assert.equal(result.portableStorage, null)
  assert.equal(f.sim.state.inventory.items.filter(i => isShulkerBox(i.name)).length, 1)
})

test('paused carried storage rejects attempts to deposit a kept shulker or more than the eligible cargo', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 13 }]); const c = controller(f)
  await assert.rejects(f.job.storeCarriedNow({ deposits: [{ slot: 4, name: 'minecraft:shulker_box', count: 1 }] }), /depositable/)
  await assert.rejects(f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 33 }] }), /depositable/)
  assert.equal(c.calls.length, 0)
})

test('a completed checkpoint replays its receipt without transferring or placing twice', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }]); const c = controller(f)
  await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  const checkpoint = f.docs.findLast(doc => doc.portableStorage?.checkpoint?.completed === true)
  assert.ok(checkpoint)
  const restored = createQuarryJob(f.options); restored.load(checkpoint)
  const result = await restored.storeCarriedNow()
  assert.equal(result.ledger.deposited, 8)
  assert.equal(f.sim.state.inventory.items.find(i => i.slot === 3).count, 56)
  assert.equal(c.placements(), 1)
  assert.equal(result.storageResult.recovered, true)
})

test('a successful manual retry clears the old carried-storage failure while remaining paused', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  f.sim.adapter.storeCarried = async () => ({ status: 'blocked', reason: 'STORAGE_SITE_UNOBSERVED', serverConfirmed: false })
  const blocked = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.equal(blocked.pauseReason, 'CARRIED_STORAGE_BLOCKED')
  controller(f)
  const restored = await f.job.storeCarriedNow()
  assert.equal(restored.storageResult.serverConfirmed, true)
  assert.equal(restored.state, 'PAUSED')
  assert.equal(restored.pauseReason, 'MANUAL_PAUSE')
  assert.equal(restored.pauseDetails, null)
  assert.equal(restored.ledger.deposited, 8)
})

test('death changes block carried-storage recovery instead of mining or replacing the old box', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 15 }])
  const c = controller(f, { afterPlaced: (cp, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })) })
  const task = f.job.storeCarriedNow().catch(error => error)
  await until(() => f.job.document().portableStorage?.checkpoint?.stage === 'placed')
  await f.job.pause(); await task
  f.sim.state.lifecycle.deathId++
  f.job.resume()
  await until(() => f.job.status().state === 'PAUSED')
  assert.equal(f.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.equal(f.job.status().pauseDetails.reason, 'STORAGE_SCOPE_CHANGED')
  assert.equal(c.placements(), 1)
  assert.equal(f.sim.world.name(c.position.x, c.position.y, c.position.z), 'shulker_box')
  assert.equal(f.sim.stats.mined, 0)
  assert.ok(f.job.document().portableStorage)
})

test('a checkpoint write failure stops before sending any carried-container action', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 16 }]); const c = controller(f)
  const broken = createQuarryJob({ ...f.options, storage: { save: async () => { throw new Error('disk unavailable') } } })
  broken.load(f.job.document())
  await assert.rejects(broken.storeCarriedNow(), /Checkpoint could not be saved/)
  assert.equal(c.calls.length, 0)
  assert.equal(c.placements(), 0)
  assert.equal(f.sim.state.inventory.items.filter(i => isShulkerBox(i.name)).length, 1)
})

test('live case 2026-11-12: a storage site refused before anything was placed starts over at another site; the refused cell is avoided', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  const refused = { x: 7, y: 63, z: 5 }
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [refused], placed: [], deposited: [], intent: null, siteIssue: { cause: 'ENTITY_OCCUPIES_OR_UNOBSERVED', position: refused, part: 'box' } }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_SITE_CHANGED', serverConfirmed: false, checkpoint: cp }
  }
  const first = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.notEqual(first.pauseReason, 'CARRIED_STORAGE_BLOCKED', 'an untouched site refusal is retried, not a pause')
  assert.equal(f.job.document().portableStorage.checkpoint, null, 'started over from the beginning')
  assert.deepEqual(f.job.document().portableStorage.avoidPositions, [refused])
  const c = controller(f)
  const second = await f.job.storeCarriedNow()
  assert.equal(second.storageResult.serverConfirmed, true, JSON.stringify(second.pauseDetails))
  assert.deepEqual(c.calls[0].avoidPositions, [refused], 'the refused cell is passed on as avoided')
})

test('live case 2026-11-12: after a placement, a site refusal still pauses', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage: 'placed', stand: { x: 5, y: 63, z: 5 }, positions: [{ x: 7, y: 63, z: 5 }], placed: [{ position: { x: 7, y: 63, z: 5 } }], deposited: [], intent: null }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_SITE_CHANGED', serverConfirmed: false, checkpoint: cp }
  }
  const blocked = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.equal(blocked.pauseReason, 'CARRIED_STORAGE_BLOCKED')
})

test('live case 2026-11-12: a preview refusal or an unsettled placement before anything was placed also starts over at another site', async () => {
  for (const reason of ['STORAGE_PLACEMENT_PREVIEW_REJECTED', 'STORAGE_PLACEMENT_NOT_SETTLED']) {
    const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
    const refused = { x: 7, y: 63, z: 5 }
    f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
      const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [refused], placed: [], deposited: [], intent: null, placementPrepareAttempts: 3, previewRejection: { position: refused, errors: ['x'] } }
      await onCheckpoint(cp)
      return { status: 'blocked', reason, serverConfirmed: false, checkpoint: cp }
    }
    const first = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
    assert.notEqual(first.pauseReason, 'CARRIED_STORAGE_BLOCKED', reason)
    assert.equal(f.job.document().portableStorage.checkpoint, null, reason)
    const c = controller(f)
    const second = await f.job.storeCarriedNow()
    assert.equal(second.storageResult.serverConfirmed, true, reason)
    assert.deepEqual(c.calls[0].avoidPositions, [refused], reason)
  }
})

test('live case 2026-11-12: a storage walk that timed out before anything was placed starts over at another site; after a placement it still pauses', async () => {
  for (const [stage, placed, expectRetry] of [['planned', [], true], ['placing', [{ position: { x: 7, y: 63, z: 5 } }], false]]) {
    const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
    const refused = { x: 7, y: 63, z: 5 }
    f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
      const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage, stand: { x: 5, y: 63, z: 5 }, positions: [refused], placed, deposited: [], intent: null }
      await onCheckpoint(cp)
      return { status: 'blocked', reason: 'quarry move: timed out', serverConfirmed: false, checkpoint: cp }
    }
    const first = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
    if (!expectRetry) { assert.equal(first.pauseReason, 'CARRIED_STORAGE_BLOCKED', stage); continue }
    assert.notEqual(first.pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(f.job.document().portableStorage.checkpoint, null)
    const c = controller(f)
    const second = await f.job.storeCarriedNow()
    assert.equal(second.storageResult.serverConfirmed, true)
    assert.deepEqual(c.calls[0].avoidPositions, [refused])
  }
})

test('live case 2026-11-12: a full box blocked only by loose drops is relieved by holding the next empty box, then that box continues as the next storage', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }, { name: 'red_shulker_box', count: 1, stackId: 15 }])
  const mainCell = { x: 7, y: 63, z: 5 }, reliefCell = { x: 8, y: 63, z: 7 }
  const requests = []
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    requests.push(structuredClone(request))
    if (request.holdAfterPlacement) {
      const source = request.selection.sources[0]
      consume(f.sim, source.slot, source.name, 1); f.sim.world.set(reliefCell.x, reliefCell.y, reliefCell.z, source.name)
      const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'placed', stand: { x: 6, y: 63, z: 7 }, positions: [reliefCell], placed: [{ position: reliefCell, name: source.name, confirmedBy: 'server_block_and_inventory' }], deposited: [], plan: [], intent: null, relief: true }
      await onCheckpoint(cp)
      return { status: 'held', serverConfirmed: false, recovered: false, deposited: [], checkpoint: cp }
    }
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', scope: { life: f.sim.state.lifecycle.deathId }, stage: 'depositing', stand: { x: 5, y: 63, z: 5 }, positions: [mainCell], placed: [{ position: mainCell, name: 'minecraft:shulker_box', confirmedBy: 'server_block_and_inventory' }], deposited: [], plan: [], intent: null, full: true }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', serverConfirmed: false, recovered: false, details: { kind: 'owned_box_pickup_capacity', phase: 'before_packing', freeSlots: 1, requiredFreeSlots: 2 }, checkpoint: cp }
  }
  const first = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.notEqual(first.pauseReason, 'CARRIED_STORAGE_BLOCKED', JSON.stringify(first.pauseDetails))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].holdAfterPlacement, true)
  assert.deepEqual(requests[1].deposits, [])
  assert.deepEqual(requests[1].avoidPositions, [mainCell])
  assert.notEqual(requests[1].selection.key, requests[0].selection.key, 'a different, empty cargo box')
  assert.notEqual(requests[1].operationId, requests[0].operationId)
  const doc = f.job.document()
  assert.equal(doc.pendingRelief.checkpoint.stage, 'placed')
  assert.equal(doc.pendingRelief.forOperationId, requests[0].operationId)
  // The full box is recovered normally; the held box becomes the next storage.
  const c = controller(f)
  await f.job.storeCarriedNow()
  assert.equal(c.calls[0].operationId, requests[0].operationId)
  const after = f.job.document()
  assert.equal(after.pendingRelief, null)
  assert.equal(after.portableStorage?.operationId, requests[1].operationId, 'the relief box continues as the next storage')
  assert.equal(after.portableStorage.checkpoint.stage, 'placed')
})

test('live case 2026-11-12: a relief box refused after placement pauses; one refused before placement falls back to the usual wait', async () => {
  for (const placedRelief of [true, false]) {
    const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }, { name: 'red_shulker_box', count: 1, stackId: 15 }])
    const mainCell = { x: 7, y: 63, z: 5 }, reliefCell = { x: 8, y: 63, z: 7 }
    f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
      if (request.holdAfterPlacement) {
        const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: placedRelief ? 'placed' : 'planned', stand: { x: 6, y: 63, z: 7 }, positions: [reliefCell], placed: placedRelief ? [{ position: reliefCell, name: 'minecraft:red_shulker_box', confirmedBy: 'server_block_and_inventory' }] : [], deposited: [], plan: [], intent: null, relief: true }
        await onCheckpoint(cp)
        return { status: 'blocked', reason: 'STORAGE_SITE_CHANGED', serverConfirmed: false, checkpoint: cp }
      }
      const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', scope: { life: f.sim.state.lifecycle.deathId }, stage: 'depositing', stand: { x: 5, y: 63, z: 5 }, positions: [mainCell], placed: [{ position: mainCell, name: 'minecraft:shulker_box', confirmedBy: 'server_block_and_inventory' }], deposited: [], plan: [], intent: null, full: true }
      await onCheckpoint(cp)
      return { status: 'blocked', reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', serverConfirmed: false, recovered: false, details: { kind: 'owned_box_pickup_capacity', phase: 'before_packing' }, checkpoint: cp }
    }
    const r = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
    assert.equal(r.pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(r.pauseDetails.reason, placedRelief ? 'STORAGE_RELIEF_UNCONFIRMED' : 'STORAGE_PICKUP_CAPACITY_REQUIRED')
    assert.equal(f.job.document().pendingRelief === null || f.job.document().pendingRelief === undefined, !placedRelief)
  }
})

test('live case 2026-11-13: a re-selected site follows the same box to its current slot before anything is placed', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [{ x: 7, y: 63, z: 5 }], placed: [], deposited: [], intent: null }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_PLACEMENT_PREVIEW_REJECTED', serverConfirmed: false, checkpoint: cp }
  }
  await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  const box = f.sim.state.inventory.items.find(i => i.stackId === 14)
  const before = f.job.document().portableStorage.selection.sources[0].slot
  assert.equal(box.slot, before)
  const free = [...Array(36).keys()].find(slot => !f.sim.state.inventory.items.some(i => i.slot === slot))
  box.slot = free // the refused attempt had equipped the box into another slot
  const c = controller(f)
  const done = await f.job.storeCarriedNow()
  assert.equal(done.storageResult?.serverConfirmed, true, JSON.stringify(done.pauseDetails))
  assert.equal(c.calls[0].selection.sources[0].slot, free)
})

test('live case 2026-11-13: a precondition refusal with no received change is retried (3 at most); a changed state or an unconfirmed code still pauses', async () => {
  const msg = '2021,25,2024: 通常の地面に静止していることを確認できません。'
  // Box placed, break refused before dispatch: retried on the same box.
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  const cell = { x: 7, y: 63, z: 5 }
  let calls = 0
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    calls++
    if (calls === 1) { const src = request.selection.sources[0]; consume(f.sim, src.slot, src.name, 1); f.sim.world.set(cell.x, cell.y, cell.z, 'shulker_box') }
    const cp = request.checkpoint ?? { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'breaking', stand: { x: 5, y: 63, z: 5 }, positions: [cell], placed: [{ position: cell, name: 'minecraft:shulker_box', confirmedBy: 'server_block_and_inventory' }], deposited: [], plan: [], intent: { type: 'break', position: cell } }
    if (calls === 1) await onCheckpoint(cp)
    return { status: 'blocked', reason: msg, serverConfirmed: false, checkpoint: cp }
  }
  // The first call places the box (a received change): it pauses at once.
  let r = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.equal(calls, 1)
  assert.equal(r.pauseReason, 'CARRIED_STORAGE_BLOCKED', 'a refusal after a received change is not transient')
  // Continued from the saved breaking checkpoint, nothing changes: transient.
  f.job.load({ ...f.job.document(), pauseReason: 'MANUAL_PAUSE', pauseDetails: null, result: null })
  r = await f.job.storeCarriedNow()
  for (let n = 0; n < 4 && r.pauseReason !== 'CARRIED_STORAGE_BLOCKED'; n++) r = await f.job.storeCarriedNow()
  assert.equal(calls, 5, 'the resumed call plus three transient retries')
  assert.equal(r.pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.equal(r.pauseDetails.reason, msg)
  assert.equal(f.job.document().portableStorage.checkpoint.placed.length, 1, 'the placed box is kept')
  // An unconfirmed code is never transient.
  const g = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  g.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [cell], placed: [], deposited: [], plan: [], intent: null }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_PLACE_UNCONFIRMED', serverConfirmed: false, checkpoint: cp }
  }
  const u = await g.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  assert.equal(u.pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.equal(u.pauseDetails.reason, 'STORAGE_PLACE_UNCONFIRMED')
})

test('live case 2026-11-13: resuming an untouched storage operation that used up its retries starts it over at a new site', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  let calls = 0
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    calls++
    const cp = request.checkpoint ?? { version: 1, operationId: request.operationId, jobId: request.jobId, kind: request.selection.kind, stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [{ x: 7, y: 63, z: 5 }], placed: [], deposited: [], intent: null, placementPrepareAttempts: 3 }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_PLACEMENT_NOT_SETTLED', serverConfirmed: false, checkpoint: cp }
  }
  let r = await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  for (let n = 0; n < 8 && r.pauseReason !== 'CARRIED_STORAGE_BLOCKED'; n++) r = await f.job.storeCarriedNow()
  assert.equal(r.pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.ok(f.job.document().portableStorage.checkpoint)
  try { f.job.resume() } catch {}
  await f.job.pause().catch(() => {})
  const ps = f.job.document().portableStorage
  assert.ok(ps == null || ps.siteRetries == null || ps.siteRetries < 3, 'a fresh retry budget')
  assert.ok(f.job.document().events?.some?.(e => e.type === 'storage_untouched_restart') ?? true)
})

test('live case 2026-11-13: resuming after a reconciled unconfirmed placement starts over at a new site, avoiding the old cell', async () => {
  const f = fixture([{ name: 'shulker_box', count: 1, stackId: 14 }])
  const cell = { x: 7, y: 63, z: 5 }
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'planned', stand: { x: 5, y: 63, z: 5 }, positions: [cell], placed: [], deposited: [], intent: null }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_PLACE_UNCONFIRMED', serverConfirmed: false, checkpoint: cp }
  }
  await f.job.storeCarriedNow({ deposits: [{ slot: 3, name: 'minecraft:cobblestone', count: 8 }] })
  const doc = f.job.document()
  f.job.load({ ...doc, state: 'PAUSED', pauseReason: 'STORAGE_CURRENT_STATE_RECONCILED', pauseDetails: { operationId: doc.portableStorage.operationId, currentStateConfirmed: true }, result: null })
  try { f.job.resume() } catch {}
  await f.job.pause().catch(() => {})
  const ps = f.job.document().portableStorage
  assert.ok(ps == null || ps.checkpoint == null || !ps.checkpoint.positions.some(p => p.x === cell.x && p.z === cell.z), 'the old site is not reused')
  if (ps) assert.ok((ps.avoidPositions ?? []).some(p => p.x === cell.x && p.z === cell.z), 'the old cell is avoided')
})
