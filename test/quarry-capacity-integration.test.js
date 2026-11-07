'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createQuarryCapacityBatch } = require('../src/quarry-capacity-batch')
const { supplyScope } = require('../src/quarry-supplies')
const { createQuarryJob } = require('../src/quarry-job')
const file = path.resolve(__dirname, 'quarry-portable-storage.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, airItem, names, carriedBox }\n', file)
const { fixture, item, airItem, names, carriedBox } = loaded.exports
const clone = value => structuredClone(value), key = p => `${p.x},${p.y},${p.z}`
names.set(5, 'minecraft:stick'); names.set(6, 'minecraft:apple'); names.set(7, 'minecraft:oak_sapling'); names.set(8, 'minecraft:oak_leaves')

function setup ({ interrupt = false, missingNBT = false, zeroDrop = false, partialCargo = false, fullCargo = false, markerDirt = false, dirtCount = 224 } = {}) {
  const f = fixture('shulker', { missingNBT, full: fullCargo })
  f.bag.fill(null)
  for (let slot = 0; slot < 36; slot++) f.bag[slot] = slot < 34 ? item(1, 1, 1000 + slot) : airItem()
  f.bag[14] = item(2, 1, 20)
  if (markerDirt) {
    for (let slot = 1, left = dirtCount; slot <= 4; slot++) { const count = Math.min(left, 64); f.bag[slot] = count ? item(3, count, 600 + slot) : item(1, 1, 1000 + slot); left -= count }
  }
  if (partialCargo) { const slots = Array.from({ length: 27 }, airItem); slots[26] = item(4, 32, 800); f.bag[14] = carriedBox(slots, 20) }
  const before = f.items(), source = before.find(i => i.stackId === 20)
  const target = { x: 1, y: 65, z: 1 }
  f.blocks.set(key(target), { known: true, name: 'minecraft:oak_leaves', runtimeId: 8, boundingBox: 'block', extra: [] })
  let epoch = 0, mines = 0, durable = null, interrupted = false
  const oldOpen = f.dependencies.chest.open, oldSnapshot = f.dependencies.chest.snapshot, oldClose = f.dependencies.crafting.closeContainer
  f.dependencies.chest.open = async (...args) => {
    epoch++; const r = await oldOpen(...args)
    if (partialCargo) f.containers.get(key(args[0]))[26] = item(4, 32, 800)
    return { ...r, scope: supplyScope(f.getState()) }
  }
  f.dependencies.crafting.closeContainer = () => { epoch++; oldClose() }
  f.dependencies.chest.snapshot = () => {
    const s = oldSnapshot()
    return { ...s, busy: false, observationSource: 'server_inventory_content', window: { ...s.window, scope: supplyScope(f.getState()), epoch, replayed: false }, slots: Array.from({ length: 27 }, (_, slot) => { const raw = f.dependencies.chest.rawItem(slot); return { slot, known: !!raw, name: raw?.count ? names.get(raw.network_id) : null, count: raw?.count ?? null, stackId: raw?.count ? raw.stack_id : null } }) }
  }
  const runner = createQuarryPortableStorage({ ...f.dependencies, refreshInventory: async () => true })
  f.controller.ownsShulker = runner.ownsShulker
  const request = { jobId: 'job', operationId: 'capacity1', selection: { kind: 'shulker', key: 'undyed_shulker_box:stack:20', sources: [source] }, purpose: 'capacity_batch', deposits: [], inventoryPolicy: { keepFood: 0, keepSticks: 0, keepSealBlocks: 0, keepLogs: 0, keepCoal: 0, keepPlanks: 0 }, capacityBatch: { beforePlacementItems: before, decision: { action: 'mine', stance: { x: 0, y: 65, z: 0 }, tool: { kind: 'hand' }, targets: [{ position: target, name: 'minecraft:oak_leaves', runtimeId: 8 }] } } }
  if (markerDirt) { request.capacityBatch.markerDirt = true; Object.assign(request.inventoryPolicy, { keepExitDirt: 192, keepSealBlocks: 32, keepSealMaterial: 'dirt' }) }
  const capacityWork = async (context, options) => {
    const child = createQuarryCapacityBatch({ getState: f.getState, getBlock: f.getBlock, ...context.ports,
      reconcileMine: async ({ actionId }) => durable ?? { actionId, status: 'unknown', serverConfirmed: false },
      mineBatch: async ({ actionId }) => {
        assert.equal(f.events.filter(e => e.type === 'place').length, 1)
        assert.equal(f.events.filter(e => e.type === 'mine').length, 0, 'box is still placed during normal mining')
        mines++; f.blocks.set(key(target), { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] })
        durable = { actionId, serverConfirmed: true, status: 'completed', confirmedTargets: [target] }
        if (interrupt && !interrupted) { interrupted = true; throw new Error('interrupted after received normal air') }
        return durable
      },
      collectBatch: async ({ actionId }, { onCheckpoint }) => {
        const drops = zeroDrop ? [] : [5, 6, 7].map((id, i) => ({ runtimeId: String(80 + i), name: names.get(id), count: 2 }))
        for (const [i, drop] of drops.entries()) { const slot = f.bag.findIndex(raw => !raw.count); f.bag[slot] = item(5 + i, drop.count, 900 + i) }
        await onCheckpoint({ receivedDrops: drops })
        return { actionId, serverConfirmed: true, receivedDrops: drops, pendingDropIds: [] }
      }, now: f.dependencies.now })
    return child.workWithContainer(context, options)
  }
  const run = checkpoint => runner.storeCarried({ ...request, checkpoint }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(clone(cp)) }, capacityWork })
  return { ...f, runner, request, run, mines: () => mines }
}

test('real portable + capacity child holds its box through one leaf batch, deposits every type and recovers exact NBT', async () => {
  const f = setup(); const r = await f.run()
  assert.equal(r.status, 'completed', r.reason); assert.equal(r.recovered, true)
  assert.equal(f.mines(), 1); assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  assert.equal(r.deposited.length, 3); assert.equal(r.deposited.reduce((n, d) => n + d.count, 0), 6)
  assert.equal(r.checkpoint.capacityCheckpoint.phase, 'ready')
  const raw = f.bag.find(raw => raw.network_id === 2 && raw.count)
  const entries = raw.extra.nbt.nbt.value.Items.value.value
  assert.deepEqual(entries.map(e => e.Name.value).sort(), ['minecraft:apple', 'minecraft:oak_sapling', 'minecraft:stick'])
  assert.ok(entries.every(e => e.Count.value === 2))
})

test('portable + capacity reload reconciles the saved normal action and never places or mines the batch twice', async () => {
  const f = setup({ interrupt: true }); const first = await f.run()
  assert.equal(first.status, 'blocked'); assert.equal(first.checkpoint.capacityCheckpoint.phase, 'mining')
  assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
  const second = await f.run(first.checkpoint)
  assert.equal(second.status, 'completed', second.reason); assert.equal(f.mines(), 1)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('a received partial cargo box is reused without changing its previous contents', async () => {
  const f = setup({ partialCargo: true }); const r = await f.run()
  assert.equal(r.status, 'completed', r.reason); assert.equal(f.mines(), 1)
  const raw = f.bag.find(raw => raw.network_id === 2 && raw.count)
  const entries = raw.extra.nbt.nbt.value.Items.value.value
  assert.equal(entries.length, 4)
  const original = entries.find(entry => entry.Slot.value === 26)
  assert.equal(original.Name.value, 'minecraft:stone'); assert.equal(original.Count.value, 32)
  assert.equal(r.deposited.reduce((n, d) => n + d.count, 0), 6)
})

test('a box without sufficient confirmed cargo room is recovered unchanged before choosing another box', async () => {
  const f = setup({ fullCargo: true }); const r = await f.run()
  assert.equal(r.status, 'full', r.reason); assert.equal(r.recovered, true)
  assert.equal(f.mines(), 0); assert.equal(r.deposited.length, 0)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1, 'only the owned box is mined')
  assert.equal(r.exhaustedShulkerKeys.length, 1)
  const entries = f.bag.find(raw => raw.network_id === 2 && raw.count).extra.nbt.nbt.value.Items.value.value
  assert.equal(entries.length, 27); assert.ok(entries.every(entry => entry.Count.value === 64))
})

test('an actual full main inventory prevents box breaking even if a child claimed its projection had room', async () => {
  const f = setup()
  const r = await f.runner.storeCarried(f.request, { canPlace: () => true, onCheckpoint: async () => {}, capacityWork: async () => {
    for (let slot = 0; slot < 36; slot++) if (!f.bag[slot].count) f.bag[slot] = item(1, 1, 4000 + slot)
    return { status: 'completed', serverConfirmed: true, deposits: [] }
  } })
  assert.equal(r.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
})

test('one surplus dirt marker precedes mining and makes a zero-drop cargo box recoverable with exact positive NBT', async () => {
  const f = setup({ markerDirt: true, zeroDrop: true }); const r = await f.run()
  assert.equal(r.status, 'completed', r.reason); assert.equal(r.recovered, true)
  assert.equal(f.mines(), 1); assert.equal(r.deposited.length, 1)
  assert.deepEqual(r.deposited[0], { name: 'minecraft:dirt', count: 1 })
  assert.equal(r.checkpoint.markerReceipt.count, 1)
  assert.equal(r.checkpoint.markerReceipt.confirmedBy, 'matching_response_and_actual_inventory_slots')
  assert.equal(f.bag.filter(raw => raw.network_id === 3).reduce((n, raw) => n + raw.count, 0), 223)
  const entries = f.bag.find(raw => raw.network_id === 2 && raw.count).extra.nbt.nbt.value.Items.value.value
  assert.equal(entries.length, 1); assert.equal(entries[0].Name.value, 'minecraft:dirt'); assert.equal(entries[0].Count.value, 1)
})

test('marker intent is saved before ordinary deposit and a reload after confirmation never deposits its dirt twice', async () => {
  const f = setup({ markerDirt: true, interrupt: true, zeroDrop: true }); const first = await f.run()
  assert.equal(first.status, 'blocked'); assert.equal(first.checkpoint.markerReceipt.count, 1)
  const intent = f.checkpoints.find(p => p.intent?.type === 'deposit' && p.plan?.[p.intent.index]?.capacityMarker)
  assert.ok(intent); assert.equal(intent.intent.count, 1)
  const before = f.events.filter(e => e.type === 'deposit').length
  const r = await f.run(first.checkpoint)
  assert.equal(r.status, 'completed', r.reason)
  assert.equal(f.events.filter(e => e.type === 'deposit').length, before)
  assert.equal(r.deposited.find(d => d.name === 'minecraft:dirt').count, 1)
})

test('an exact192 exit dirt reserve cannot fund a marker or start a batch', async () => {
  const f = setup({ markerDirt: true, dirtCount: 192 }); const r = await f.run()
  assert.equal(r.reason, 'CAPACITY_MARKER_MATERIAL_MISSING')
  assert.equal(f.mines(), 0); assert.equal(f.events.filter(e => e.type === 'deposit').length, 0)
  assert.equal(f.bag.filter(raw => raw.network_id === 3).reduce((n, raw) => n + raw.count, 0), 192)
})

test('a partial cargo box already has positive contents and does not take another marker', async () => {
  const f = setup({ markerDirt: true, partialCargo: true, zeroDrop: true }); const r = await f.run()
  assert.equal(r.status, 'completed', r.reason)
  assert.equal(r.checkpoint.markerReceipt.required, false)
  assert.equal(f.events.filter(e => e.type === 'deposit').length, 0)
  assert.equal(f.bag.filter(raw => raw.network_id === 3).reduce((n, raw) => n + raw.count, 0), 224)
})

test('marker pending exact-before and exact-applied reconcile through ordinary fresh main and container receipts', async () => {
  for (const applied of [false, true]) {
    const f = setup({ markerDirt: true, zeroDrop: true })
    const deposit = f.dependencies.chest.depositItem; let interrupted = false
    f.dependencies.chest.depositItem = async options => {
      if (!interrupted) {
        interrupted = true
        if (applied) {
          const oldId = f.bag[options.sourceSlot].stack_id
          await deposit(options)
          if (f.bag[options.sourceSlot].count) f.bag[options.sourceSlot].stack_id = oldId
        }
        throw new Error('marker confirmation interrupted')
      }
      return deposit(options)
    }
    const first = await f.run()
    assert.equal(first.status, 'blocked'); assert.equal(first.checkpoint.intent.type, 'deposit')
    assert.equal(first.checkpoint.plan[first.checkpoint.intent.index].capacityMarker, true)
    assert.equal(f.mines(), 0)
    const r = await f.run(first.checkpoint)
    assert.equal(r.status, 'completed', r.reason)
    assert.equal(r.checkpoint.reconciliation.outcome, applied ? 'applied' : 'unchanged')
    assert.equal(r.deposited.find(d => d.name === 'minecraft:dirt').count, 1)
    assert.equal(f.events.filter(e => e.type === 'deposit').length, 1)
    assert.equal(f.bag.filter(raw => raw.network_id === 3).reduce((n, raw) => n + raw.count, 0), 223)
  }
})

test('a pending marker cannot cross a life boundary or use a failed fresh main receipt', async () => {
  for (const changedLife of [false, true]) {
    const f = setup({ markerDirt: true, zeroDrop: true })
    f.dependencies.chest.depositItem = async () => { throw new Error('marker pending') }
    const first = await f.run()
    assert.equal(first.checkpoint.intent?.type, 'deposit')
    if (changedLife) f.state.lifecycle.deathId++
    else f.state.inventory.uncertain = true
    const r = await f.run(first.checkpoint)
    assert.equal(r.status, 'blocked'); assert.equal(r.serverConfirmed, false)
    assert.equal(f.mines(), 0); assert.equal(f.events.filter(e => e.type === 'deposit').length, 0)
    assert.equal(f.bag.filter(raw => raw.network_id === 3).reduce((n, raw) => n + raw.count, 0), 224)
  }
})

test('capacity cannot be adopted as ordinary storage; a missing NBT empty recovery remains unconfirmed', async () => {
  const f = setup({ interrupt: true }); const first = await f.run()
  const ordinary = await f.runner.storeCarried({ ...f.request, purpose: undefined, checkpoint: first.checkpoint }, { onCheckpoint: async () => {} })
  assert.equal(ordinary.reason, 'STORAGE_CHECKPOINT_INVALID')
  const unknown = setup({ missingNBT: true, zeroDrop: true }); const r = await unknown.run()
  assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
  assert.equal(r.serverConfirmed, false)
})

function jobFixture ({ pauseOnDropCheckpoint = false, closeOpenings = false } = {}) {
  const f = setup({ markerDirt: true }); let normalMines = 0, drops = [], seen = false, saved = null, paused = false, clock = 1000, job
  const pickup = () => {
    if (!seen || !drops.length) return
    for (let i = 0; i < drops.length; i++) { const slot = f.bag.findIndex(raw => !raw.count); if (slot < 0) throw new Error('All actual leaf drops must fit'); f.bag[slot] = item(5 + i, 2, 3000 + i) }
    drops = []
  }
  const adapter = {
    getState: () => { pickup(); return f.getState() }, getBlock: f.getBlock,
    entities: () => { const result = clone(drops); if (drops.length) seen = true; return result },
    combatActive: () => false, stopAll: async () => {}, equip: f.dependencies.equip,
    moveTo: async p => f.dependencies.moveTo(p),
    mine: async targets => { normalMines++; for (const t of targets) f.blocks.set(key(t), { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] }); drops = [5, 6, 7].map((id, i) => ({ kind: 'item', runtimeId: String(500 + i), name: names.get(id), count: 2, position: { x: 1.5, y: 65, z: 1.5 } })); return { phase: 'completed' } },
    storeCarried: (request, options) => f.runner.storeCarried(request, options)
  }
  const storage = { save: async (id, document) => {
    saved = clone(document)
    if (pauseOnDropCheckpoint && !paused && document.portableStorage?.checkpoint?.capacityCheckpoint?.phase === 'collecting') { paused = true; queueMicrotask(() => { void job.pause() }) }
  } }
  const create = () => createQuarryJob({ adapter, storage, now: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) }, pollMs: 5 })
  job = create()
  assert.equal(job.plan({ jobId: 'live-capacity', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 65, yBottom: 65, worldMinY: 60, worldMaxY: 80, ...(closeOpenings ? { boundarySeal: { enabled: true, horizontalMargin: 1, closeOpenings: true, material: 'dirt', sourceOnly: true } } : {}), inventory: { carryOnly: true, minFreeSlots: 1, keepSealBlocks: 32, keepSealMaterial: 'dirt', keepFood: 0, keepSticks: 0, keepLogs: 0, keepCoal: 0, keepPlanks: 0 } }).ready, true)
  return { ...f, job, adapter, create, setJob: next => { job = next }, normalMines: () => normalMines, saved: () => saved }
}
async function until (fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('job capacity integration timed out'); await new Promise(resolve => setTimeout(resolve, 2)) } }

test('real job capacity refusal enters the held-box cycle and credits normal mining and deposited materials exactly once', async () => {
  const f = jobFixture(); f.job.start()
  try {
    await until(() => f.job.document().carriedStorageReceipts?.length || f.job.status().state === 'PAUSED')
    assert.equal(f.job.document().carriedStorageReceipts?.length, 1, JSON.stringify(f.job.status()))
    assert.equal(f.normalMines(), 1)
    assert.equal(f.job.status().ledger.minedBlocks, 1)
    assert.equal(f.job.status().ledger.deposited, 7)
    assert.equal(f.events.filter(e => e.type === 'place').length, 1)
    assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
    assert.equal(f.job.document().portableStorage, null)
  } finally { await f.job.pause() }
})

test('a paused and reloaded real job resumes its received-air checkpoint without repeating the normal break or ledger', async () => {
  const f = jobFixture({ pauseOnDropCheckpoint: true }); f.job.start()
  await until(() => f.job.status().state === 'PAUSED')
  await f.job.pause()
  const document = f.job.document()
  assert.equal(document.portableStorage.checkpoint.capacityCheckpoint.phase, 'collecting')
  assert.equal(f.normalMines(), 1)
  const next = f.create(); f.setJob(next); next.load(document); next.resume()
  try {
    await until(() => next.document().carriedStorageReceipts?.length || next.status().state === 'PAUSED')
    assert.equal(next.document().carriedStorageReceipts?.length, 1, JSON.stringify(next.status()))
    assert.equal(f.normalMines(), 1); assert.equal(next.status().ledger.minedBlocks, 1)
    assert.equal(next.status().ledger.deposited, 7)
    assert.equal(f.events.filter(e => e.type === 'place').length, 1)
    assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  } finally { await next.pause() }
})

test('a close-openings job excludes its dirt-only boundary ring from cargo and capacity box sites', async () => {
  const f = jobFixture({ closeOpenings: true }); let permission
  f.adapter.storeCarried = async (request, options) => { permission = options.canPlace; return { status: 'blocked', serverConfirmed: false, reason: 'FIXTURE_END' } }
  f.job.start()
  try {
    await until(() => permission || f.job.status().state === 'PAUSED')
    assert.equal(typeof permission, 'function')
    assert.equal(permission({ x: -1, y: 65, z: 5 }), false)
    assert.equal(permission({ x: -1, y: 66, z: 5 }), false)
    assert.equal(permission({ x: 2, y: 65, z: 5 }), true)
    assert.equal(permission({ x: -2, y: 65, z: 5 }), true)
  } finally { await f.job.pause() }
})
