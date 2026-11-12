'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createManualChestDeposit } = require('../src/manual-chest-deposit')
const clone = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const air = slot => ({ slot, known: true, empty: true, name: null, count: 0 })
const item = (slot, name = 'minecraft:stone', id = slot + 1) => ({ slot, known: true, empty: false, name, count: 1, metadata: 0,
  raw: { network_id: id, count: 1, metadata: 0, has_stack_id: true, stack_id: 100 + id, block_runtime_id: 0,
    extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: 'observed ' + id } } } } } }, can_place_on: [], can_destroy: [] } } })
const sameItem = (a, b) => a?.name === b?.name && a?.count === b?.count && JSON.stringify(a?.raw) === JSON.stringify(b?.raw)

function fixture ({ full = false, proofKnown = true, refreshProof = false } = {}) {
  const bag = Array.from({ length: 36 }, (_, slot) => full || slot === 0 ? item(slot) : air(slot))
  const armor = Array.from({ length: 4 }, (_, slot) => full ? item(slot, 'minecraft:diamond_' + ['helmet', 'chestplate', 'leggings', 'boots'][slot], 50 + slot) : air(slot))
  const offhand = [full ? item(0, 'minecraft:totem_of_undying', 60) : air(0)]
  if (full) {
    bag[0].name = 'minecraft:purple_shulker_box'
    bag[0].raw.extra.nbt.nbt.value.Items = { type: 'list', value: { type: 'compound', value: [{ Slot: { type: 'byte', value: 0 }, Name: { type: 'string', value: 'minecraft:diamond' }, Count: { type: 'byte', value: 64 } }] } }
  }
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42', name: 'Test Realm' }, connectionId: 'socket', startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20, gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true } }
  const target = { x: 1, y: 65, z: 0 }, boxes = new Map(), events = [], records = new Map(), saves = [], transfers = []
  let clock = 1000, generation = 1, job = 'quarry:paused', uuid = 0, lease = null, window = null, mode = 'normal', onSave = null, onAcquire = null, onOpen = null, opened = 0, workerCalls = 0
  const addChest = (position, { size = 54, known = true, nonempty = false } = {}) => boxes.set(key(position), { position: clone(position), size, known, slots: Array.from({ length: size }, (_, slot) => nonempty && slot === 0 ? item(slot) : air(slot)) })
  addChest(target)
  const rows = () => [...bag, ...armor, ...offhand]
  const getView = () => ({ known: true, slots: clone(bag), armor: { known: proofKnown, slots: proofKnown ? clone(armor) : armor.map(row => ({ slot: row.slot, known: false, empty: false, name: null, count: null })) }, offhand: { known: proofKnown, slots: proofKnown ? clone(offhand) : [{ slot: 0, known: false, empty: false, name: null, count: null }] } })
  const source = intent => intent.kind === 'main' ? bag : intent.kind === 'armor' ? armor : offhand
  const adapter = {
    getState: () => clone(state), getView,
    getBlock: (x, y, z) => boxes.has(key({ x, y, z })) ? { known: true, name: 'minecraft:chest', runtimeId: 10, extra: [] } : { known: true, name: 'minecraft:air', runtimeId: 0, extra: [] },
    inventoryIdentity: () => { events.push('identity'); if (!proofKnown) throw new Error('unknown actual gear'); return createHash('sha256').update(JSON.stringify(rows())).digest('hex') },
    generation: () => generation, jobIdentity: () => job, assertIdle: () => events.push('idle'),
    acquire: async (id, settings) => { events.push(settings.preview ? 'preview-lease' : 'run-lease'); assert.equal(settings.identity, settings.preview ? null : createHash('sha256').update(JSON.stringify(rows())).digest('hex')); lease = id; if (onAcquire) await onAcquire(settings); if (settings.preview && refreshProof) proofKnown = true },
    release: async id => { if (lease === id) { events.push('release'); lease = null } },
    open: async (position, settings) => { assert.ok(lease); assert.equal(settings.expectedSlots, 54); settings.signal.throwIfAborted(); events.push('open'); opened++; if (onOpen) await onOpen(position); window = boxes.get(key(position)); return { serverConfirmed: true, slotCount: window?.size, position: clone(position) } },
    close: async () => { if (window) { events.push('close'); window = null } },
    container: () => window && ({ known: window.known, slotCount: window.size, position: clone(window.position), slots: clone(window.slots) }),
    save: async doc => { if (onSave) await onSave(doc); saves.push(clone(doc)); records.set(doc.operationId, clone(doc)) },
    load: async id => clone(records.get(id) ?? null),
    cancelTransfers: async (id, reason) => events.push(['cancel', id, reason]),
    runDeposit: async (request, { onCheckpoint, signal }) => {
      workerCalls++
      const box = boxes.get(key(request.position)), cp = clone(request.checkpoint ?? { version: 1, direction: 'deposit', jobId: request.jobId, operationId: request.operationId,
        world: JSON.stringify([state.profile, String(state.realm.id), state.dimension]), life: JSON.stringify([JSON.stringify([state.profile, String(state.realm.id), state.dimension]), state.lifecycle.deathId]), position: request.position, phase: 'deposit', index: 0, receipts: [], intent: null })
      const blocked = () => ({ status: 'blocked', serverConfirmed: false, reason: 'FIXTURE_INTERRUPTED', checkpoint: clone(cp) })
      if (cp.intent) {
        const current = source(cp.intent)[cp.intent.slot], received = box.slots[cp.intent.destination]
        if (!current.empty || !sameItem(received, cp.intent.before)) return blocked()
        cp.index++; cp.receipts.push({ kind: 'reconciled_deposit' }); cp.intent = null; await onCheckpoint(cp)
      }
      if (mode === 'fakeComplete') { cp.phase = 'completed'; return { status: 'completed', serverConfirmed: true, checkpoint: cp } }
      for (const kind of ['main', 'armor', 'offhand']) {
        const array = kind === 'main' ? bag : kind === 'armor' ? armor : offhand
        for (let slot = 0; slot < array.length; slot++) {
          if (array[slot].empty) continue
          const destination = box.slots.findIndex(row => row.empty)
          cp.intent = { kind, slot, destination, before: clone(array[slot]) }
          await onCheckpoint(cp)
          if (signal.aborted) return blocked()
          box.slots[destination] = clone(array[slot]); transfers.push(clone(array[slot])); array[slot] = air(slot)
          if (mode === 'partial' || mode === 'cancel') { if (mode === 'cancel') controller.cancel(); return blocked() }
          cp.index++; cp.receipts.push({ kind: 'deposit' }); cp.intent = null; await onCheckpoint(cp)
        }
      }
      cp.phase = 'completed'; await onCheckpoint(cp)
      return { status: 'completed', serverConfirmed: mode !== 'unconfirmed', checkpoint: cp }
    }
  }
  const controller = createManualChestDeposit({ adapter, now: () => clock, uuid: () => `operation-${++uuid}` })
  const start = preview => controller.start({ token: preview.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' })
  return { controller, adapter, state, bag, armor, offhand, target, boxes, events, records, saves, transfers, addChest, start, rows,
    setMode: value => { mode = value }, setSave: value => { onSave = value }, setAcquire: value => { onAcquire = value }, setOpen: value => { onOpen = value },
    setTime: value => { clock = value }, nextGeneration: () => { generation++ }, setJob: value => { job = value }, opens: () => opened, calls: () => workerCalls, hasLease: () => lease !== null }
}

test('normal manual deposit preserves all41 stacks and packed shulker NBT without command, mining or movement ports', async () => {
  const f = fixture({ full: true }), before = clone(f.rows()), position = clone(f.state.position), preview = await f.controller.prepare()
  assert.deepEqual(preview.stacks, { main: 36, armor: 4, offhand: 1, total: 41 }); assert.equal(preview.slotCount, 54)
  assert.deepEqual(f.rows(), before); assert.equal(f.calls(), 0); assert.equal(f.hasLease(), false)
  const started = f.start(preview)
  assert.equal(started.busy, true); assert.equal(started.serverConfirmed, false); assert.equal(f.calls(), 0, 'start returns before the async worker')
  await f.controller.drain()
  const status = f.controller.status(), stored = f.boxes.get(key(f.target)).slots.filter(row => !row.empty)
  assert.equal(status.phase, 'completed', JSON.stringify(status.error)); assert.equal(status.serverConfirmed, true)
  assert.equal(status.transferredStacks, 41); assert.equal(status.remainingStacks, 0)
  assert.deepEqual(stored, before); assert.deepEqual(f.state.position, position); assert.equal(f.hasLease(), false)
  assert.ok(f.rows().every(row => row.known && row.empty)); assert.equal(f.records.get(preview.operationId).checkpoint.phase, 'completed')
  assert.equal(Object.hasOwn(status, 'checkpoint'), false); assert.equal(Object.hasOwn(status, 'scope'), false)
  assert.ok(!JSON.stringify(status).includes('Items'), 'raw/NBT never enters the public status')
})

test('preview acquires its read-only lease before requiring actual equipment proof', async () => {
  const f = fixture({ proofKnown: false, refreshProof: true })
  const preview = await f.controller.prepare()
  assert.ok(preview.token); assert.ok(f.events.indexOf('preview-lease') < f.events.indexOf('identity')); assert.equal(f.hasLease(), false)
  const unknown = fixture({ proofKnown: false })
  await assert.rejects(unknown.controller.prepare(), { code: 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN' }); assert.equal(unknown.opens(), 0); assert.equal(unknown.hasLease(), false)
})

for (const mode of ['nonempty', 'single', 'unreceived', 'tooFar']) test(`new operation refuses ${mode} target without transferring anything`, async () => {
  const f = fixture()
  if (mode === 'nonempty') f.addChest(f.target, { nonempty: true })
  if (mode === 'single') f.addChest(f.target, { size: 27 })
  if (mode === 'unreceived') f.addChest(f.target, { known: false })
  if (mode === 'tooFar') { f.boxes.clear(); f.addChest({ x: 4, y: 65, z: 4 }) }
  await assert.rejects(f.controller.prepare(), { code: 'MANUAL_DEPOSIT_NO_EMPTY_DOUBLE_CHEST' })
  assert.equal(f.calls(), 0); assert.equal(f.transfers.length, 0); assert.equal(f.hasLease(), false)
})

test('scan uses nearest candidates and attempts at most8 normal opens', async () => {
  const f = fixture(); f.boxes.clear()
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) f.addChest({ x, y: 65, z }, { size: 27 })
  await assert.rejects(f.controller.prepare(), { code: 'MANUAL_DEPOSIT_NO_EMPTY_DOUBLE_CHEST' }); assert.equal(f.opens(), 8); assert.equal(f.calls(), 0)
})

for (const mode of ['inventory', 'job', 'generation', 'death', 'position', 'target', 'expiry']) test(`preview ${mode} change prevents storage and consumes the stale token`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  if (mode === 'inventory') f.bag[1] = item(1)
  if (mode === 'job') f.setJob('other:paused')
  if (mode === 'generation') f.nextGeneration()
  if (mode === 'death') f.state.lifecycle.deathId++
  if (mode === 'position') f.state.position.x++
  if (mode === 'target') f.boxes.clear()
  if (mode === 'expiry') f.setTime(preview.expiresAt)
  assert.throws(() => f.start(preview)); assert.equal(f.calls(), 0)
  assert.throws(() => f.start(preview), { code: 'MANUAL_DEPOSIT_CONFIRMATION_REQUIRED' })
})

test('a filled target after preview and before the fresh start open is never used', async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.addChest(f.target, { nonempty: true }); f.start(preview); await f.controller.drain()
  assert.equal(f.controller.status().serverConfirmed, false); assert.equal(f.calls(), 0); assert.equal(f.transfers.length, 0)
})

for (const mode of ['inventory', 'job', 'target']) test(`a ${mode} change during the durable first-transfer intent blocks all transfers`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.setSave(async doc => {
    if (doc.phase !== 'running' || doc.checkpoint) return
    if (mode === 'inventory') f.bag[1] = item(1)
    if (mode === 'job') f.setJob('other:paused')
    if (mode === 'target') f.boxes.get(key(f.target)).slots[0] = item(0)
  })
  f.start(preview); await f.controller.drain()
  assert.equal(f.calls(), 0); assert.equal(f.transfers.length, 0); assert.equal(f.controller.status().serverConfirmed, false)
})

for (const mode of ['partial', 'cancel']) test(`${mode} keeps applied intent and resumes only the same scoped journal without duplicate deposits`, async () => {
  const f = fixture({ full: true }), preview = await f.controller.prepare()
  f.setMode(mode); f.start(preview); await f.controller.drain()
  const paused = f.controller.status(), journal = f.records.get(preview.operationId)
  assert.equal(paused.phase, 'paused'); assert.equal(paused.serverConfirmed, false); assert.ok(journal.checkpoint.intent); assert.equal(f.transfers.length, 1)
  f.setMode('normal')
  const resumed = await f.controller.prepare({ operationId: preview.operationId })
  assert.equal(resumed.resume, true); assert.equal(resumed.stacks.total, 40)
  f.start(resumed); await f.controller.drain()
  assert.equal(f.controller.status().serverConfirmed, true); assert.equal(f.transfers.length, 41)
  assert.equal(f.boxes.get(key(f.target)).slots.filter(row => !row.empty).length, 41)
})

for (const mode of ['scope', 'foreignCheckpoint']) test(`resume refuses ${mode} journal and never adopts a nonempty unrelated target`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.setMode('partial'); f.start(preview); await f.controller.drain()
  if (mode === 'scope') f.state.connectionId = 'different-connection'
  else f.records.get(preview.operationId).checkpoint.operationId = 'another-operation'
  const before = f.calls()
  await assert.rejects(f.controller.prepare({ operationId: preview.operationId })); assert.equal(f.calls(), before); assert.equal(f.hasLease(), false)
})

for (const boundary of ['initial', 'checkpoint', 'final']) test(`persistence failure at ${boundary} cannot become success or lose the in-memory checkpoint`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.setSave(async doc => { if (boundary === 'initial' && doc.phase === 'running' && !doc.checkpoint || boundary === 'checkpoint' && doc.checkpoint?.intent || boundary === 'final' && doc.phase === 'completed') throw new Error('disk unavailable') })
  f.start(preview); await f.controller.drain()
  const status = f.controller.status()
  assert.equal(status.phase, 'failed'); assert.equal(status.serverConfirmed, false); assert.equal(status.error.code, 'MANUAL_DEPOSIT_PERSISTENCE_FAILED')
  if (boundary !== 'final') assert.equal(f.transfers.length, 0)
  if (boundary === 'checkpoint') assert.ok(f.records.get(preview.operationId) || f.saves.length)
})

for (const mode of ['fakeComplete', 'unconfirmed']) test(`${mode} response cannot replace actual41empty plus a confirmed durable completion`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.setMode(mode); f.start(preview); await f.controller.drain()
  assert.equal(f.controller.status().serverConfirmed, false)
  assert.notEqual(f.controller.status().phase, 'completed')
})

test('cancel while preview acquisition waits aborts immediately and drain waits for owned cleanup', async () => {
  const f = fixture()
  let release, entered
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  let signal
  f.setAcquire(async settings => { signal = settings.signal; entered(); await gate })
  const pending = f.controller.prepare(); await started
  f.controller.cancel(); assert.equal(signal.aborted, true)
  let drained = false; const drain = f.controller.drain().then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  release(); await assert.rejects(pending); await drain
  assert.equal(f.opens(), 0); assert.equal(f.hasLease(), false)
})

test('a new preview after completion never inherits old success or old progress', async () => {
  const f = fixture(), preview = await f.controller.prepare(); f.start(preview); await f.controller.drain()
  assert.equal(f.controller.status().serverConfirmed, true)
  f.boxes.clear(); f.addChest(f.target); f.bag[1] = item(1)
  await f.controller.prepare()
  const ready = f.controller.status()
  assert.equal(ready.phase, 'ready'); assert.equal(ready.serverConfirmed, false); assert.equal(ready.transferredStacks, 0); assert.equal(ready.remainingStacks, 1)
})

for (const mode of ['scope', 'job', 'generation']) test(`a ${mode} change while saving a child intent preserves it but sends no transfer`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  let changed = false
  f.setSave(async doc => {
    if (changed || !doc.checkpoint?.intent) return
    changed = true
    if (mode === 'scope') f.state.connectionId = 'replacement-socket'
    if (mode === 'job') f.setJob('other:paused')
    if (mode === 'generation') f.nextGeneration()
  })
  f.start(preview); await f.controller.drain()
  assert.equal(f.transfers.length, 0); assert.equal(f.controller.status().serverConfirmed, false)
  assert.ok(f.records.get(preview.operationId).checkpoint.intent)
})

test('cancel during a late normal open closes only that owned preview and never publishes a token', async () => {
  const f = fixture()
  let release, entered
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  f.setOpen(async () => { entered(); await gate })
  const pending = f.controller.prepare(); await started
  f.controller.cancel(); release()
  await assert.rejects(pending); await f.controller.drain()
  assert.equal(f.events.filter(event => event === 'close').length, 1)
  assert.equal(f.hasLease(), false); assert.equal(f.calls(), 0)
})

test('a new empty operation refuses storage without opening or creating a journal', async () => {
  const f = fixture(); f.bag[0] = air(0)
  await assert.rejects(f.controller.prepare(), { code: 'MANUAL_DEPOSIT_NOTHING_TO_STORE' })
  assert.equal(f.opens(), 0); assert.equal(f.records.size, 0); assert.equal(f.hasLease(), false)
})

for (const kind of ['pending', 'completed']) test(`a recreated controller discovers its ${kind} checkpoint and reconciles zero remaining sources read-only`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  if (kind === 'pending') f.setMode('partial')
  else f.setSave(async doc => { if (doc.phase === 'completed') throw new Error('final durable save failed') })
  f.start(preview); await f.controller.drain()
  assert.equal(f.controller.status().serverConfirmed, false); assert.equal(f.rows().filter(row => !row.empty).length, 0)
  const saved = f.records.get(preview.operationId), cp = clone(saved.checkpoint)
  assert.ok(kind === 'pending' ? cp.intent : cp.phase === 'completed')
  f.adapter.loadPending = async () => clone(f.records.get(preview.operationId))
  f.setMode('normal'); f.setSave(null)
  const recreated = createManualChestDeposit({ adapter: f.adapter, uuid: () => 'new-unused-operation' })
  const resumed = await recreated.prepare()
  assert.equal(resumed.resume, true); assert.equal(resumed.operationId, preview.operationId); assert.equal(resumed.stacks.total, 0)
  assert.equal(f.transfers.length, 1, 'discovery and reconfirmation cannot dispatch a replacement transfer')
  recreated.start({ token: resumed.token, confirm: 'STORE_ALL_IN_EMPTY_CHEST' }); await recreated.drain()
  assert.equal(recreated.status().serverConfirmed, true); assert.equal(f.transfers.length, 1)
  assert.equal(f.records.size, 1); assert.equal(f.records.get(preview.operationId).checkpoint.phase, 'completed')
})

for (const change of ['connection', 'life']) test(`a discovered pending journal from another ${change} stays visible and blocks unrelated new transfers`, async () => {
  const f = fixture(), preview = await f.controller.prepare()
  f.setMode('partial'); f.start(preview); await f.controller.drain()
  const saved = clone(f.records.get(preview.operationId)), previousCalls = f.calls()
  f.adapter.loadPending = async () => clone(saved)
  if (change === 'connection') f.state.connectionId = 'replacement-connection'
  else f.state.lifecycle.deathId++
  const recreated = createManualChestDeposit({ adapter: f.adapter })
  await assert.rejects(recreated.prepare(), { code: 'MANUAL_DEPOSIT_RESUME_SCOPE_CHANGED' })
  const blocked = recreated.status()
  assert.equal(blocked.phase, 'paused'); assert.equal(blocked.operationId, preview.operationId); assert.deepEqual(blocked.target, saved.position)
  assert.equal(blocked.serverConfirmed, false); assert.equal(blocked.error.code, 'MANUAL_DEPOSIT_RESUME_SCOPE_CHANGED')
  assert.deepEqual(f.records.get(preview.operationId), saved, 'old scope, receipt and pending intent are never rewritten')
  assert.equal(f.calls(), previousCalls); assert.equal(f.records.size, 1)
})

test('a completed latest pointer does not resume history or hide a new confirmation', async () => {
  const f = fixture(), preview = await f.controller.prepare(); f.start(preview); await f.controller.drain()
  const completed = clone(f.records.get(preview.operationId))
  f.adapter.loadPending = async () => clone(completed)
  f.addChest({ x: -1, y: 65, z: 0 }); f.bag[1] = item(1)
  const recreated = createManualChestDeposit({ adapter: f.adapter, uuid: (() => { let n = 0; return () => `next-operation-${++n}` })() })
  const next = await recreated.prepare()
  assert.equal(next.resume, false); assert.notEqual(next.operationId, preview.operationId); assert.equal(next.stacks.total, 1)
  assert.equal(recreated.status().serverConfirmed, false); assert.equal(f.transfers.length, 1)
})
