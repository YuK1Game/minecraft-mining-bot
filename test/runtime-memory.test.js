'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { planHut } = require('../src/hut-planner')
const { planShelter } = require('../src/shelter-planner')
const { createSessionCache } = require('../src/session-cache')

const scope = { profile: 'bot', realmId: '21225335', dimension: 'overworld' }
const clone = value => structuredClone(value)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 10, properties: {}, extra: [] })
const initialState = () => ({ phase: 'spawned', health: 20, gameMode: 'survival', profile: scope.profile, realm: { id: scope.realmId }, dimension: scope.dimension, runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'move_player', positionUpdatedAt: 'new-observation', selectedSlot: 0, rawSelectedSlot: 0, inventory: { known: true, items: [] }, capabilities: {} })
function hutMemo () {
  const site = planHut(initialState(), { getBlock: (x, y, z) => block(y < 65 ? 'grass_block' : 'air') }, { radius: 0 })
  return { version: 1, kind: 'soil_hut', scope: { realmId: scope.realmId, dimension: scope.dimension }, site: clone(site), stepIndex: 30, totalActions: 32, established: true, recoveredTemporaryDirt: true, reclaimBaseline: 0, pendingPlacement: null, requiresWorldValidation: true,
    placements: site.ownedBuildCells.map(position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease', ...(site.temporaryPillar.some(p => JSON.stringify(p) === JSON.stringify(position)) ? { removed: true } : {}) })) }
}
function shelterMemo () {
  const getBlock = (x, y, z) => block(y < 65 ? 'stone' : x >= 1 && x <= 4 && Math.abs(z) <= 2 && y <= 67 ? y === 67 ? 'grass_block' : 'dirt' : 'air')
  const site = planShelter(initialState(), { getBlock }, { radius: 0 })
  return { version: 1, scope: { realmId: scope.realmId, dimension: scope.dimension }, site, totalActions: 9, established: true, pendingPlacement: null, cleared: site.initialExcavation.map(item => ({ position: item.position, originalName: item.name, confirmedBy: 'received_air' })), placements: site.doorCells.map(item => ({ position: item.position, item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease' })) }
}

// Only loading JavaScript source uses fs. Persistence is injected as a fake
// store; these runtime fixtures never create/read a mission or auth file.
function fixture (t, { optedIn = true, load, save, existing, knownWorld = false } = {}) {
  const raw = initialState()
  const calls = []
  const packets = []
  const lifecycle = []
  const callbacks = []
  const instances = []
  const overrides = new Map()
  let known = knownWorld
  const cache = createSessionCache()
  const startGame = { runtime_entity_id: 41n, current_tick: 1000n, player_position: raw.position, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, rotation: { x: 0, z: 0 }, dimension: scope.dimension }
  cache.observe('start_game', startGame)
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty) })
  const store = {
    load: async value => { calls.push({ type: 'load', scope: clone(value) }); return load ? load(value) : { status: 'loaded', shelterMemo: hutMemo(), requiresWorldValidation: true } },
    save: async value => { calls.push({ type: 'save', value: clone(value) }); return save ? save(value) : { saved: true, atomic: true } },
    flush: async () => { calls.push({ type: 'flush' }) }
  }
  const shared = { autoWanted: false, autoOptions: {}, loadingScreenEnded: false, ...(existing ? { [existing.site.type === 'soil_hut' ? 'hutMemo' : 'shelterMemo']: clone(existing) } : {}) }
  const host = {
    shared, cache, missionMemory: store, meta: { version: '1.26.60', profile: scope.profile, startGame, ...(optedIn ? { workspaceRoot: path.resolve('runtime-memory-fixture-no-disk') } : {}) }, apiUrl: 'http://127.0.0.1:49999',
    client: { queue: (name, params) => packets.push({ name, params: clone(params) }), close: () => lifecycle.push('close'), disconnect: () => lifecycle.push('disconnect') },
    world: { getBlock: (x, y, z) => known ? { ...clone(overrides.get(`${x},${y},${z}`) ?? block(y < 65 ? 'grass_block' : 'air')), position: { x, y, z } } : { known: false, position: { x, y, z } }, stats: () => ({ initialized: true, loadedSections: known ? 9 : 0, version: '1.26.60' }) },
    entities: { snapshot: () => [], nearby: () => [] }, getState: () => clone(raw), getServerState: () => clone(raw),
    allocate: () => -1, commitInventory () {}, setPrediction () {}, setEquipmentPrediction () {}, setCapabilities () {}, noteProgress () {}, log () {}
  }
  const filename = path.resolve(__dirname, '../src/runtime.js')
  const nativeRequire = Module.createRequire(filename)
  const target = { exports: {} }
  const realHut = nativeRequire('./hut').createHut
  const compile = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compile(target.exports, name => name === './hut' ? { createHut: options => { callbacks.push(options.onProgress); return realHut(options) } } : nativeRequire(name), target, filename, path.dirname(filename))
  const create = () => { const runtime = target.exports.createRuntime(host); instances.push(runtime); return runtime }
  const runtime = create()
  t.after(async () => { for (const instance of instances) await instance.dispose('test_cleanup') })
  const receiveGeometry = memo => {
    known = true
    for (const position of memo.site.buildCells) overrides.set(`${position.x},${position.y},${position.z}`, block('dirt'))
    overrides.set(`${memo.site.roof.x},${memo.site.roof.y},${memo.site.roof.z}`, block('grass_block'))
    raw.position = { ...memo.site.insideStandpoint, y: memo.site.center.y + 1.62 }
  }
  return { host, raw, shared, runtime, create, calls, packets, lifecycle, callbacks, store, overrides, receiveGeometry }
}

test('an opted-in real runtime constructor stays passive and restores a new host only after scope-ready spawn', async t => {
  const f = fixture(t)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.packets, [])
  assert.equal(f.runtime.snapshot().missionMemory.enabled, true)
  f.raw.realm = null
  assert.equal((await f.runtime.onSpawn()).code, 'SCOPE_NOT_READY')
  assert.deepEqual(f.calls, [])
  f.raw.realm = { id: scope.realmId }
  const result = await f.runtime.onSpawn()
  assert.equal(result.status, 'restored')
  assert.deepEqual(f.calls[0], { type: 'load', scope })
  assert.equal(f.shared.hutMemo.site.type, 'soil_hut')
  assert.equal(f.runtime.snapshot().hut.usable, false, 'unknown current chunks cannot inherit historic completion')
  assert.equal(f.runtime.snapshot().hut.geometryVerified, false)
  f.receiveGeometry(f.shared.hutMemo)
  assert.equal(f.runtime.snapshot().hut.usable, true, 'received dirt/grass, shell and exact receipts are still required')
  assert.deepEqual(f.packets, [])
  assert.deepEqual(f.lifecycle, [])
})

test('runtime fixtures without workspace opt-in never access the injected store and shared work is not replaced', async t => {
  const disabled = fixture(t, { optedIn: false })
  await disabled.runtime.onSpawn()
  disabled.runtime.resumeRequested()
  await disabled.runtime.dispose('no_disk')
  assert.deepEqual(disabled.calls, [])
  const current = hutMemo(); current.totalActions = 45
  const f = fixture(t, { existing: current })
  const result = await f.runtime.onSpawn()
  assert.equal(result.code, 'EXISTING_MEMORY')
  assert.equal(f.calls.some(call => call.type === 'load'), false)
  assert.equal(f.shared.hutMemo.totalActions, 45)
})

test('Runtime dispatch restores soil-hill history and keeps unresolved hut recovery and placement flags', async t => {
  const hill = fixture(t, { load: async () => ({ status: 'loaded', shelterMemo: shelterMemo() }) })
  assert.equal((await hill.runtime.onSpawn()).kind, 'shelter')
  assert.equal(hill.shared.shelterMemo.site.type, 'soil_hill_shelter')
  assert.equal(hill.shared.hutMemo, undefined)
  const pending = hutMemo()
  pending.established = false
  pending.recoveredTemporaryDirt = false
  pending.reclaimBaseline = null
  pending.requiresRecoveryReconciliation = true
  pending.pendingPlacement = { position: pending.site.doorCells[0], item: 'minecraft:dirt', beforeDirt: 2, requiresReconciliation: true, serverConfirmed: false }
  const hut = fixture(t, { load: async () => ({ status: 'loaded', shelterMemo: pending }) })
  await hut.runtime.onSpawn()
  assert.equal(hut.shared.hutMemo.requiresRecoveryReconciliation, true)
  assert.equal(hut.shared.hutMemo.pendingPlacement.requiresReconciliation, true)
  assert.equal(hut.runtime.snapshot().hut.usable, false)
})

test('scope changes, new spawn generations and existing live progress fence delayed restore results', async t => {
  const firstGate = deferred(); const secondGate = deferred()
  let reads = 0
  const f = fixture(t, { load: () => ++reads === 1 ? firstGate.promise : secondGate.promise })
  const first = f.runtime.onSpawn()
  await Promise.resolve(); await Promise.resolve()
  const second = f.runtime.onSpawn()
  await Promise.resolve(); await Promise.resolve()
  firstGate.resolve({ status: 'loaded', shelterMemo: hutMemo() })
  assert.equal((await first).code, 'STALE_GENERATION_OR_SCOPE')
  assert.equal(f.shared.hutMemo, undefined)
  const live = hutMemo(); live.totalActions = 49
  f.callbacks.at(-1)({ type: 'hut', phase: 'partial', memo: live })
  secondGate.resolve({ status: 'loaded', shelterMemo: hutMemo() })
  assert.equal((await second).code, 'EXISTING_MEMORY')
  assert.equal(f.shared.hutMemo.totalActions, 49)
  const gate = deferred()
  const other = fixture(t, { load: () => gate.promise })
  const loading = other.runtime.onSpawn()
  other.raw.dimension = 'nether'
  gate.resolve({ status: 'loaded', shelterMemo: hutMemo() })
  assert.equal((await loading).code, 'STALE_GENERATION_OR_SCOPE')
  assert.equal(other.shared.hutMemo, undefined)
})

test('progress saves are nonblocking, dispose drains accepted persistence and old callbacks cannot overwrite the next host', async t => {
  const gate = deferred()
  const f = fixture(t, { load: async () => ({ status: 'missing' }), save: () => gate.promise })
  await f.runtime.onSpawn()
  const current = hutMemo()
  assert.equal(f.callbacks.at(-1)({ type: 'hut', phase: 'closed_refuge', memo: current }), undefined)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.calls.filter(call => call.type === 'save').length, 1)
  let disposed = false
  const stopping = f.runtime.dispose('connection_closed').then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)
  f.callbacks.at(-1)({ type: 'hut', phase: 'partial', memo: { ...current, totalActions: 999 } })
  assert.equal(f.shared.hutMemo.totalActions, 32)
  gate.resolve({ saved: true })
  await stopping
  assert.equal(disposed, true)
  const persisted = f.calls.filter(call => call.type === 'save').at(-1).value
  assert.equal(persisted.shelterMemo.totalActions, 32)
  assert.equal(f.calls.at(-1).type, 'flush')
  const next = fixture(t, { load: async () => ({ status: 'loaded', shelterMemo: persisted.shelterMemo }) })
  assert.deepEqual(next.calls, [])
  await next.runtime.onSpawn()
  assert.equal(next.runtime.snapshot().hut.usable, false)
  next.receiveGeometry(next.shared.hutMemo)
  assert.equal(next.runtime.snapshot().hut.usable, true)
  assert.deepEqual(f.packets, [])
  assert.deepEqual(next.packets, [])
})

test('a disposed runtime never restores a late load and never auto-resumes after its pending read', async t => {
  const gate = deferred()
  const f = fixture(t, { load: () => gate.promise })
  const loading = f.runtime.onSpawn()
  await f.runtime.dispose('hot_reload')
  gate.resolve({ status: 'loaded', shelterMemo: hutMemo() })
  assert.equal((await loading).code, 'STALE_GENERATION_OR_SCOPE')
  assert.equal(f.shared.hutMemo, undefined)
  assert.equal(f.runtime.snapshot().agent.running, false)
  assert.deepEqual(f.packets, [])
})
