'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')
const { createMissionMemory } = require('../src/mission-memory')
const { planShelter } = require('../src/shelter-planner')
const { createShelter } = require('../src/shelter')
const { planHut } = require('../src/hut-planner')
const { createHut } = require('../src/hut')

const scope = { realmId: '21225335', profile: 'bot', dimension: 'overworld' }
function memoFixture () {
  const state = { phase: 'spawned', health: 20, dimension: 'overworld', runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 'observed-now', connectionId: 'private-connection-marker' }
  const block = name => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : 10, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  const getBlock = (x, y, z) => block(y < 65 ? 'stone' : x >= 1 && x <= 4 && Math.abs(z) <= 2 && y <= 67 ? y === 67 ? 'grass_block' : 'dirt' : 'air')
  const site = planShelter(state, { getBlock }, { radius: 0 })
  assert.equal(site.ready, true)
  return {
    version: 1, scope: { realmId: scope.realmId, dimension: scope.dimension }, site,
    cleared: site.initialExcavation.map(item => ({ position: item.position, originalName: item.name, confirmedBy: 'received_air' })),
    placements: site.doorCells.map((item, index) => ({ position: item.position, item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease', requestId: -2 - index * 2 })),
    established: true, totalActions: 9, stage: 'closed_refuge', pendingPlacement: null
  }
}
async function fixture (t, options = {}) {
  const root = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'minecraftbot-mission-memory-')))
  const local = path.resolve(root, '.local')
  const filename = path.join(local, 'mission-memory.json')
  const store = createMissionMemory({ workspaceRoot: root, ...options })
  t.after(async () => {
    await store.flush().catch(() => {})
    // Flat unlink/rmdir only. Every resolved cleanup target is checked against
    // this explicitly created temp workspace; no recursive shell deletion.
    assert.equal(path.dirname(local), root)
    try {
      for (const name of await fs.readdir(local)) {
        const target = path.resolve(local, name)
        assert.equal(path.dirname(target), local)
        const stat = await fs.lstat(target)
        assert.equal(stat.isDirectory(), false)
        await fs.unlink(target)
      }
      await fs.rmdir(local)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.equal(path.resolve(root), root)
    await fs.rmdir(root)
  })
  return { root, local, filename, store }
}

test('constructor is passive and an explicit missing load does not create a directory', async t => {
  const f = await fixture(t)
  assert.equal(f.store.snapshot().pendingWrites, 0)
  await assert.rejects(fs.lstat(f.local), { code: 'ENOENT' })
  const result = await f.store.load(scope)
  assert.equal(result.status, 'missing')
  assert.equal(result.shelterMemo, null)
  await assert.rejects(fs.lstat(f.local), { code: 'ENOENT' })
})

test('atomic save/load keeps only scoped shelter data and drops auth, stacks, inventory and private fields', async t => {
  const f = await fixture(t)
  const memo = memoFixture()
  const marker = 'NEVER_PERSIST_CREDENTIAL_OR_RAW_STACK'
  memo.auth = { accessToken: marker }
  memo.token = marker
  memo.password = marker
  memo.inventory = { items: [{ name: marker, stackId: 123 }] }
  memo.site.origin.token = marker
  memo.site.raw = { login: marker }
  memo.site.initialSteps[0].clearance[0].rawStack = { network_id: 900, stack_id: marker }
  memo.placements[0].raw = { extra: marker }
  memo.placements[0]._private = marker
  const original = structuredClone(memo)
  const saved = await f.store.save({ ...scope, shelterMemo: memo, authorization: marker })
  assert.equal(saved.atomic, true)
  const text = await fs.readFile(f.filename, 'utf8')
  assert.equal(text.includes(marker), false)
  assert.equal(text.includes('private-connection-marker'), false)
  const document = JSON.parse(text)
  assert.deepEqual(Object.keys(document).sort(), ['profile', 'realmId', 'schemaVersion', 'shelterMemo'])
  const loaded = await f.store.load(scope)
  assert.equal(loaded.status, 'loaded')
  assert.equal(loaded.requiresWorldValidation, true)
  assert.equal(loaded.shelterMemo.requiresWorldValidation, true)
  assert.equal(loaded.shelterMemo.site.requiresWorldValidation, true)
  assert.equal(loaded.shelterMemo.established, true, 'this is historical construction, not current geometry validation')
  assert.equal(loaded.shelterMemo.placements[0].requestId, -2)
  assert.equal(Object.hasOwn(loaded, 'usable'), false)
  assert.equal(Object.hasOwn(loaded, 'serverConfirmed'), false)
  assert.equal(Object.hasOwn(loaded.shelterMemo, 'inventory'), false)
  assert.deepEqual(memo, original)
})

test('Realm, profile and dimension mismatches cannot import or relabel another mission', async t => {
  const f = await fixture(t)
  await f.store.save({ ...scope, shelterMemo: memoFixture() })
  const original = await fs.readFile(f.filename, 'utf8')
  for (const mismatch of [{ realmId: '21225336' }, { profile: 'main' }, { dimension: 'nether' }]) {
    const result = await f.store.load({ ...scope, ...mismatch })
    assert.equal(result.status, 'rejected')
    assert.equal(result.code, 'SCOPE_MISMATCH')
    assert.equal(result.shelterMemo, null)
  }
  await assert.rejects(f.store.save({ ...scope, realmId: '21225336', shelterMemo: memoFixture() }), error => error.code === 'SCOPE_MISMATCH')
  assert.equal(await fs.readFile(f.filename, 'utf8'), original)
  const invalid = await f.store.load({ ...scope, profile: '../account' })
  assert.equal(invalid.code, 'INVALID_SCOPE')
})

test('pending placement remains unconfirmed across restart and never becomes a verified receipt or established shelter', async t => {
  const f = await fixture(t)
  const memo = memoFixture()
  memo.pendingPlacement = { position: memo.site.doorCells[1].position, item: 'minecraft:dirt', beforeDirt: 3, requestId: -8, serverConfirmed: true, token: 'secret' }
  await f.store.save({ ...scope, shelterMemo: memo })
  const restarted = createMissionMemory({ workspaceRoot: f.root })
  const restored = (await restarted.load(scope)).shelterMemo
  assert.equal(restored.established, false)
  assert.equal(restored.previouslyEstablished, true)
  assert.equal(restored.pendingPlacement.serverConfirmed, false)
  assert.equal(restored.pendingPlacement.requiresReconciliation, true)
  assert.equal(restored.pendingPlacement.beforeDirt, 3)
  assert.equal(restored.pendingPlacement.requestId, -8)
  assert.equal(restored.placements.length, 2, 'the pending record was not appended to the historical verified receipts')
  const partial = memoFixture()
  partial.established = false
  partial.pendingPlacement = null
  await f.store.save({ ...scope, shelterMemo: partial })
  assert.equal((await f.store.load(scope)).shelterMemo.established, false, 'two old receipts alone cannot promote a partially checked memo')
})

test('restored history becomes usable only through the real shelter validator reading the current world geometry', async t => {
  const f = await fixture(t)
  await f.store.save({ ...scope, shelterMemo: memoFixture() })
  const restored = (await f.store.load(scope)).shelterMemo
  const overrides = new Map()
  const block = name => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : 10, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y < 65 ? 'stone' : x >= 1 && x <= 4 && Math.abs(z) <= 2 && y <= 67 ? y === 67 ? 'grass_block' : 'dirt' : 'air') }
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', realm: { id: scope.realmId }, dimension: scope.dimension, position: { x: 2.5, y: 66.62, z: 0.5 }, positionSource: 'move_player', positionUpdatedAt: 'new-connection-observation', inventory: { known: true, items: [] } }
  let actions = 0
  const never = () => { actions++; throw new Error('Read-only restore cannot perform a game action') }
  const controller = { preview: never, start: never, stop: never }
  const shelter = createShelter({ getState: () => structuredClone(state), world, planner: planShelter, mining: controller, movement: controller, getMining: () => ({ phase: 'idle' }), getMovement: () => ({ phase: 'idle' }), inventory: { equip: never }, interactions: { previewPlace: never, placeBlock: never }, memo: restored })
  assert.equal(shelter.snapshot().usable, false, 'past receipts do not turn the currently solid interior into a room')
  for (const item of restored.site.initialExcavation) overrides.set(`${item.position.x},${item.position.y},${item.position.z}`, block('air'))
  for (const item of restored.site.doorCells) overrides.set(`${item.position.x},${item.position.y},${item.position.z}`, block('dirt'))
  assert.equal(shelter.snapshot().usable, true, 'current known floor, roof, room and own doorway are required')
  overrides.set('2,67,0', { known: false })
  assert.equal(shelter.snapshot().usable, false)
  assert.equal(actions, 0)
})

test('minimum refuge memory accepts deferred unknown or unsafe future observations without recording them as world facts', async t => {
  const f = await fixture(t)
  const memo = memoFixture()
  const future = memo.site.finalInterior.bodyCells.find(item => item.position.x === 3 && item.position.z === 1)
  Object.assign(future, { known: false, name: null, rawStack: { secret: 'private-future-marker' } })
  const next = memo.site.expansion.find(item => item.position.x === 3 && item.position.z === 1)
  Object.assign(next, { known: true, name: 'minecraft:lava', expectedBlock: 'minecraft:lava' })
  await f.store.save({ ...scope, shelterMemo: memo })
  const restored = (await f.store.load(scope)).shelterMemo
  assert.equal(restored.site.minimumInterior.footCells.length, 1)
  assert.equal(restored.site.minimumInterior.bodyCells.length, 2)
  assert.deepEqual(Object.fromEntries(Object.entries(restored.site.preserved).map(([name, values]) => [name, values.length])), { floor: 2, roof: 2, walls: 10 })
  assert.ok(restored.site.finalInterior.bodyCells.every(item => Object.keys(item).length === 1 && item.position))
  assert.equal((await fs.readFile(f.filename, 'utf8')).includes('private-future-marker'), false)
})

test('legacy full-room memo geometry is loaded as a minimum refuge proposal requiring fresh world validation', async t => {
  const f = await fixture(t)
  const memo = memoFixture()
  const site = memo.site
  delete site.minimumInterior
  const body = [...site.finalInterior.footCells]
  const floor = [...new Map([site.entry, site.inner, ...body].map(p => { const point = { ...p, y: p.y - 1 }; return [`${point.x},${point.y},${point.z}`, point] })).values()]
  const roof = floor.map(p => ({ ...p, y: site.inner.y + 2 }))
  const walls = [0, 1].flatMap(height => [{ x: 1, y: 65 + height, z: -1 }, { x: 1, y: 65 + height, z: 1 }, ...[2, 3].flatMap(x => [-2, 2].map(z => ({ x, y: 65 + height, z }))), ...[-1, 0, 1].map(z => ({ x: 4, y: 65 + height, z }))])
  const describe = position => ({ position, name: position.y < 65 ? 'minecraft:stone' : position.y === 67 ? 'minecraft:grass_block' : 'minecraft:dirt', known: true, runtimeId: 10, preserve: true, needsMining: false })
  site.preserved = { floor: floor.map(describe), roof: roof.map(describe), walls: walls.map(describe) }
  await fs.mkdir(f.local)
  await fs.writeFile(f.filename, JSON.stringify({ schemaVersion: 1, realmId: scope.realmId, profile: scope.profile, shelterMemo: memo }))
  const result = await f.store.load(scope)
  assert.equal(result.status, 'loaded')
  assert.equal(result.requiresWorldValidation, true)
  assert.equal(result.shelterMemo.site.minimumInterior.footCells.length, 1)
  assert.equal(result.shelterMemo.site.preserved.walls.length, 10)
  assert.equal(result.shelterMemo.site.preserved.roof.length, 2)
  assert.equal(Object.hasOwn(result, 'usable'), false)
})

test('bad JSON, unknown versions and oversize files are rejected without exposing or modifying contents', async t => {
  const f = await fixture(t)
  await f.store.save({ ...scope, shelterMemo: memoFixture() })
  const valid = JSON.parse(await fs.readFile(f.filename, 'utf8'))
  for (const [content, code] of [
    ['{broken JSON with token', 'BAD_JSON'],
    [JSON.stringify({ ...valid, schemaVersion: 99 }), 'UNKNOWN_SCHEMA_VERSION'],
    [JSON.stringify({ ...valid, shelterMemo: { ...valid.shelterMemo, version: 99 } }), 'UNKNOWN_MEMO_VERSION'],
    [' '.repeat(128 * 1024 + 1), 'OVERSIZE']
  ]) {
    await fs.writeFile(f.filename, content)
    const result = await f.store.load(scope)
    assert.equal(result.status, 'rejected')
    assert.equal(result.code, code)
    assert.equal(result.shelterMemo, null)
    assert.equal(await fs.readFile(f.filename, 'utf8'), content)
    assert.equal(JSON.stringify(result).includes('token'), false)
  }
})

test('a rename failure preserves the previous complete file and cleans up its exact temporary file', async t => {
  const f = await fixture(t)
  await f.store.save({ ...scope, shelterMemo: memoFixture() })
  const original = await fs.readFile(f.filename, 'utf8')
  t.mock.method(fs, 'rename', async () => { const error = new Error('sharing violation'); error.code = 'EPERM'; throw error })
  const changed = memoFixture(); changed.totalActions = 10
  await assert.rejects(f.store.save({ ...scope, shelterMemo: changed }), { code: 'EPERM' })
  assert.equal(await fs.readFile(f.filename, 'utf8'), original)
  assert.deepEqual(await fs.readdir(f.local), ['mission-memory.json'])
  assert.equal(f.store.snapshot().lastError, 'EPERM')
  assert.equal((await f.store.load(scope)).status, 'loaded')
})

test('concurrent saves across instances serialize atomic renames and load waits for the newest queued document', async t => {
  const f = await fixture(t)
  const other = createMissionMemory({ workspaceRoot: f.root })
  const realRename = fs.rename
  let concurrent = 0; let maximum = 0
  t.mock.method(fs, 'rename', async (...args) => {
    concurrent++; maximum = Math.max(maximum, concurrent)
    try { await delay(2); return await realRename(...args) } finally { concurrent-- }
  })
  const writes = [9, 10, 11].map((totalActions, index) => {
    const memo = memoFixture(); memo.totalActions = totalActions
    return (index === 1 ? other : f.store).save({ ...scope, shelterMemo: memo })
  })
  const loaded = await other.load(scope)
  await Promise.all(writes)
  assert.equal(loaded.shelterMemo.totalActions, 11)
  assert.equal(maximum, 1)
  assert.equal(f.store.snapshot().pendingWrites, 0)
  assert.equal(other.snapshot().pendingWrites, 0)
  assert.deepEqual(await fs.readdir(f.local), ['mission-memory.json'])
})

test('invalid geometry, another block receipt, false success and low output limits fail safely', async t => {
  const f = await fixture(t)
  for (const change of [
    memo => { memo.site.inner.x++ },
    memo => { memo.site.preserved.roof = [] },
    memo => { memo.placements[0].item = 'minecraft:diamond' },
    memo => { memo.placements[0].position = { x: 100, y: 65, z: 0 } },
    memo => { memo.pendingPlacement = { position: memo.site.doorCells[0].position, item: 'minecraft:dirt', beforeDirt: 999999 } }
  ]) {
    const memo = memoFixture(); change(memo)
    await assert.rejects(f.store.save({ ...scope, shelterMemo: memo }))
  }
  const memo = memoFixture(); memo.placements[0].serverConfirmed = false
  await f.store.save({ ...scope, shelterMemo: memo })
  const loaded = (await f.store.load(scope)).shelterMemo
  assert.equal(loaded.placements[0].serverConfirmed, false)
  assert.equal(loaded.established, false)
  const tiny = createMissionMemory({ workspaceRoot: f.root, maxBytes: 1024 })
  await assert.rejects(tiny.save({ ...scope, shelterMemo: memoFixture() }), error => error.code === 'OVERSIZE')
})

test('constructor rejects paths into auth or outside the sole memory target without filesystem access', () => {
  assert.throws(() => createMissionMemory({ workspaceRoot: path.resolve('.auth') }), error => error.code === 'INVALID_PATH')
  assert.throws(() => createMissionMemory({ workspaceRoot: process.cwd(), filePath: path.resolve('.auth', 'mission-memory.json') }), error => error.code === 'INVALID_PATH')
  assert.throws(() => createMissionMemory({ workspaceRoot: process.cwd(), filePath: path.resolve('other-memory.json') }), error => error.code === 'INVALID_PATH')
})

function hutMemoFixture () {
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', realm: { id: scope.realmId }, dimension: scope.dimension, runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'move_player', positionUpdatedAt: 'observed-hut-pose', connectionId: 'private-hut-connection', inventory: { known: true, items: [] }, entities: [] }
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 10, extra: [] })
  const getBlock = (x, y, z) => block(y < 65 ? 'grass_block' : 'air')
  const site = planHut(state, { getBlock }, { radius: 0 })
  assert.equal(site.ready, true)
  const temporary = new Set(site.temporaryPillar.map(p => `${p.x},${p.y},${p.z}`))
  return {
    version: 1, kind: 'soil_hut', scope: { realmId: scope.realmId, dimension: scope.dimension }, site: structuredClone(site), stepIndex: 30, totalActions: 32,
    placements: site.ownedBuildCells.map((position, index) => ({ position: structuredClone(position), item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease', requestId: -2 - index * 2, ...(temporary.has(`${position.x},${position.y},${position.z}`) ? { removed: true } : {}) })),
    established: true, recoveredTemporaryDirt: true, reclaimBaseline: 0, pendingPlacement: null
  }
}

test('a completed hut round-trip keeps fixed geometry, nineteen historical receipts and recovery but strips private state', async t => {
  const f = await fixture(t)
  const memo = hutMemoFixture()
  const secret = 'DO_NOT_PERSIST_HUT_AUTH_OR_STACKS'
  memo.token = secret
  memo.inventory = { items: [{ raw: secret }] }
  memo.site.origin.auth = secret
  memo.site.raw = secret
  memo.site.steps[0].observed.rawStack = { stackId: secret }
  memo.site.steps[0].standpoints[0].private = secret
  memo.placements[0].rawStack = secret
  const original = structuredClone(memo)
  await f.store.save({ ...scope, shelterMemo: memo })
  const serialized = await fs.readFile(f.filename, 'utf8')
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('private-hut-connection'), false)
  const envelope = JSON.parse(serialized)
  assert.deepEqual(Object.keys(envelope).sort(), ['profile', 'realmId', 'schemaVersion', 'shelterMemo'])
  const result = await f.store.load(scope)
  assert.equal(result.status, 'loaded')
  const restored = result.shelterMemo
  assert.equal(restored.site.type, 'soil_hut')
  assert.equal(restored.kind, 'soil_hut')
  assert.equal(restored.site.steps.length, 30)
  assert.equal(restored.site.steps.filter(step => step.type === 'place').length, 19)
  assert.equal(restored.placements.length, 19)
  assert.equal(restored.placements.filter(receipt => receipt.removed).length, 2)
  assert.equal(restored.stepIndex, 30)
  assert.equal(restored.totalActions, 32)
  assert.equal(restored.reclaimBaseline, 0)
  assert.equal(restored.recoveredTemporaryDirt, true)
  assert.equal(restored.established, true, 'historical completion may be kept, current geometry is still unknown')
  assert.equal(restored.requiresWorldValidation, true)
  assert.equal(restored.site.requiresWorldValidation, true)
  assert.equal(Object.hasOwn(restored.site, 'origin'), false)
  assert.equal(Object.hasOwn(restored.site, 'constructionState'), false)
  assert.equal(Object.hasOwn(restored.site, 'serverConfirmed'), false)
  assert.equal(Object.hasOwn(restored, 'usable'), false)
  assert.deepEqual(memo, original)
})

test('real Hut.restoreMemo needs current known dirt or grass geometry after loading before it becomes usable', async t => {
  const f = await fixture(t)
  await f.store.save({ ...scope, shelterMemo: hutMemoFixture() })
  const loaded = (await f.store.load(scope)).shelterMemo
  const overrides = new Map()
  let known = false
  let actions = 0
  const never = () => { actions++; throw new Error('Read-only hut restore must not perform a game action') }
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 10, extra: [] })
  const world = { getBlock: (x, y, z) => known ? overrides.get(`${x},${y},${z}`) ?? block(y < 65 ? 'grass_block' : 'air') : { known: false } }
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', realm: { id: scope.realmId }, dimension: scope.dimension, runtimeEntityId: '41', position: { ...loaded.site.insideStandpoint, y: loaded.site.center.y + 1.62 }, positionSource: 'move_player', positionUpdatedAt: 'new-connection-observation', inventory: { known: true, items: [] }, entities: [] }
  const controller = { preview: never, start: never, stop: never }
  const hut = createHut({ getState: () => structuredClone(state), world, planner: planHut, mining: controller, movement: controller, getMining: () => ({ phase: 'idle' }), getMovement: () => ({ phase: 'idle' }), inventory: { equip: never }, interactions: { previewPlace: never, placeBlock: never } })
  assert.equal(hut.memo(), null)
  hut.restoreMemo(loaded)
  assert.equal(hut.snapshot().usable, false)
  assert.equal(hut.snapshot().geometryVerified, false)
  assert.equal(hut.preview().ready, false)
  known = true
  for (const point of loaded.site.buildCells) overrides.set(`${point.x},${point.y},${point.z}`, block('dirt'))
  for (const point of [loaded.site.wallCells[0], loaded.site.roof, loaded.site.doorCells[0]]) overrides.set(`${point.x},${point.y},${point.z}`, block('grass_block'))
  assert.equal(hut.snapshot().geometryVerified, true)
  assert.equal(hut.snapshot().usable, true)
  assert.equal(hut.preview().ready, true)
  overrides.set(`${loaded.site.roof.x},${loaded.site.roof.y},${loaded.site.roof.z}`, { known: false })
  assert.equal(hut.snapshot().usable, false)
  assert.equal(actions, 0)
})

test('a hut can retain seventeen permanent receipts while the absent temporary history is not invented', async t => {
  const f = await fixture(t)
  const memo = hutMemoFixture()
  memo.placements = memo.placements.filter(receipt => !receipt.removed)
  assert.equal(memo.placements.length, 17)
  await f.store.save({ ...scope, shelterMemo: memo })
  const restored = (await f.store.load(scope)).shelterMemo
  assert.equal(restored.established, true)
  assert.equal(restored.placements.length, 17)
  assert.equal(restored.placements.some(receipt => receipt.removed), false)
  const partial = hutMemoFixture()
  partial.established = false
  partial.stepIndex = 4
  partial.placements = partial.placements.slice(0, 4)
  partial.recoveredTemporaryDirt = false
  partial.reclaimBaseline = null
  await f.store.save({ ...scope, shelterMemo: partial })
  const result = (await f.store.load(scope)).shelterMemo
  assert.equal(result.established, false)
  assert.equal(result.stepIndex, 4)
  assert.equal(result.placements.length, 4)
  assert.equal(result.recoveredTemporaryDirt, false)
})

test('an unresolved hut placement stays unconfirmed and an old partial recovery count cannot fabricate new pickups', async t => {
  const f = await fixture(t)
  const memo = hutMemoFixture()
  memo.pendingPlacement = { position: memo.site.doorCells[0], item: 'minecraft:dirt', beforeDirt: 2, requestId: -101, serverConfirmed: true }
  await f.store.save({ ...scope, shelterMemo: memo })
  const pending = (await f.store.load(scope)).shelterMemo
  assert.equal(pending.pendingPlacement.serverConfirmed, false)
  assert.equal(pending.pendingPlacement.requiresReconciliation, true)
  assert.equal(pending.pendingPlacement.requestId, -101)
  assert.equal(pending.established, false)
  assert.equal(pending.previouslyEstablished, true)
  assert.equal(pending.placements.length, 19)
  const partial = hutMemoFixture()
  partial.established = false
  partial.recoveredTemporaryDirt = false
  partial.stepIndex = 27
  partial.reclaimBaseline = 0
  await f.store.save({ ...scope, shelterMemo: partial })
  const restarted = createMissionMemory({ workspaceRoot: f.root })
  const restored = (await restarted.load(scope)).shelterMemo
  assert.equal(restored.reclaimBaseline, null)
  assert.equal(restored.recoveredTemporaryDirt, false)
  assert.equal(restored.requiresRecoveryReconciliation, true)
  await restarted.save({ ...scope, shelterMemo: restored })
  assert.equal((await f.store.load(scope)).shelterMemo.requiresRecoveryReconciliation, true)
})

test('hut templates reject altered cells, extra or reordered actions, unsafe stances and false receipts before writing', async t => {
  const f = await fixture(t)
  const changes = [
    memo => { memo.site.center.x++ },
    memo => { memo.site.forward = { x: 1, z: 1 } },
    memo => { memo.site.contractVersion = 99 },
    memo => { memo.site.preserved.floor.pop() },
    memo => { memo.site.steps.push(structuredClone(memo.site.steps[0])) },
    memo => { [memo.site.steps[0], memo.site.steps[1]] = [memo.site.steps[1], memo.site.steps[0]] },
    memo => { memo.site.steps[22].position = memo.site.wallCells[0] },
    memo => { memo.site.steps[0].standpoints[0].x += 100 },
    memo => { memo.site.steps[18].standpoints = [memo.site.outsideStandpoint] },
    memo => { memo.site.steps[0].face = 0 },
    memo => { memo.site.steps[27].count = 1 },
    memo => { memo.placements[0].item = 'minecraft:grass_block' },
    memo => { memo.placements[0].removed = true },
    memo => { memo.placements[1] = structuredClone(memo.placements[0]) },
    memo => { memo.placements[0].confirmedBy = 'locally_predicted' },
    memo => { memo.stepIndex = 31 },
    memo => { memo.ownerProfile = 'another-profile' }
  ]
  for (const change of changes) {
    const memo = hutMemoFixture(); change(memo)
    await assert.rejects(f.store.save({ ...scope, shelterMemo: memo }))
  }
  assert.equal((await f.store.load(scope)).status, 'missing')
})

test('hut completion is never promoted from receipt counts alone and Hut scope still requires realm, profile and dimension', async t => {
  const f = await fixture(t)
  const memo = hutMemoFixture()
  memo.established = false
  await f.store.save({ ...scope, shelterMemo: memo })
  assert.equal((await f.store.load(scope)).shelterMemo.established, false)
  for (const mismatch of [{ realmId: '21225336' }, { profile: 'main' }, { dimension: 'nether' }]) assert.equal((await f.store.load({ ...scope, ...mismatch })).code, 'SCOPE_MISMATCH')
  const incomplete = hutMemoFixture()
  incomplete.placements[0].serverConfirmed = false
  await f.store.save({ ...scope, shelterMemo: incomplete })
  assert.equal((await f.store.load(scope)).shelterMemo.established, false)
})
