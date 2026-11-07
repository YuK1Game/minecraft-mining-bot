'use strict'

// Storage policy regressions: normal drops are secondary to excavating the
// region. Passive pickup never weakens ownership proof for portable boxes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function jobFactory () {
  if (!process.env.QUARRY_POLICY_TEST_SOURCE) return require('../src/quarry-job').createQuarryJob
  const filename = require.resolve('../src/quarry-job'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(process.env.QUARRY_POLICY_TEST_SOURCE, 'utf8'), filename)
  return loaded.exports.createQuarryJob
}
const createQuarryJob = jobFactory()
const copy = value => structuredClone(value)
const policy = { pickupMode: 'passive', depositWhen: 'full' }
const key = p => `${p.x},${p.y},${p.z}`

async function until (predicate, describe, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${describe()}`); await turn() }
}

function fixture ({ free = 1, configured = true, small = false, maxBatch = 8, holdAfter = Infinity, strategy = {} } = {}) {
  const loaded = { xMin: -8, xMax: 20, yMin: 58, yMax: 70, zMin: -8, zMax: 20 }
  const sim = createSim({ loaded, chestSlots: 54 })
  flatTerrain(sim, { x1: -8, x2: 20, z1: -8, z2: 20, bedrock: 58, stoneTop: 62, top: 62 })
  sim.world.fill(-8, 62, -8, 20, 62, 20, 'stone')
  sim.world.set(-4, 63, -4, 'chest'); sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 64); sim.give('cobblestone', 5)
  while (sim.state.inventory.items.length < 36 - free) sim.give('andesite', 64)
  let clock = 1000, currentSignal, hold = holdAfter, held = false, release = null, job, collecting = false
  const writes = [], logs = [], mineCalls = [], collectionMoves = [], deposits = [], removed = []
  const originalMine = sim.adapter.mine, originalMove = sim.adapter.moveTo, originalDeposit = sim.adapter.deposit
  sim.adapter.mine = async (targets, options) => {
    assert.ok(36 - sim.state.inventory.items.length > 0, 'normal miner receives no action with zero free slots')
    currentSignal = options.signal; mineCalls.push({ before: sim.stats.mined, targets: copy(targets) })
    return originalMine(targets, options)
  }
  sim.hooks.afterMine = async target => {
    removed.push(key(target))
    if (sim.stats.mined < hold) return
    held = true
    await new Promise((resolve, reject) => {
      release = resolve
      if (currentSignal.aborted) reject(Error('fixture interrupted'))
      else currentSignal.addEventListener('abort', () => reject(Error('fixture interrupted')), { once: true })
    })
  }
  sim.adapter.moveTo = async target => { if (collecting) collectionMoves.push(copy(target)); return originalMove(target) }
  sim.adapter.deposit = async (...args) => { deposits.push({ mined: sim.stats.mined, before: copy(sim.state.inventory.items) }); return originalDeposit(...args) }
  const options = {
    adapter: sim.adapter, pollMs: 5, now: () => clock,
    sleep: async ms => { clock += ms; await turn() },
    storage: { save: async (_id, document) => writes.push(copy(document)) },
    log: line => {
      logs.push(line)
      const found = /^\[quarry\] state (.*)$/.exec(line)
      if (found) {
        const { to } = JSON.parse(found[1])
        if (to === 'COLLECT') collecting = true
        else if (to !== 'MOVE') collecting = false
      }
    }
  }
  const create = () => { job = createQuarryJob(options); return job }
  const config = { jobId: 'passive-full-policy', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 62, worldMinY: 58, worldMaxY: 70,
    strategy: { maxBlocksPerBatch: maxBatch, ...strategy }, inventory: { ...(configured ? policy : {}), minFreeSlots: 2, keepSealBlocks: 0, keepFood: 0, keepCoal: 0, keepSticks: 0, keepLogs: 0, keepPlanks: 0, storage: [{ position: { x: -4, y: 63, z: -4 }, stand: { x: -3, y: 63, z: -4 } }] } }
  const j = create(), plan = j.plan(config); assert.equal(plan.ready, true, JSON.stringify(plan))
  if (small) {
    // Keep the already planned legacy entrance, then expose a received almost
    // completed layer. Its reserved cells are AIR, so no stair exception hides
    // a collection or final-storage failure.
    sim.world.fill(0, 62, 0, 15, 62, 15, 'air')
    for (const z of [2, 3, 4]) sim.world.set(2, 62, z, 'stone')
  }
  return { sim, j, config, create, writes, logs, mineCalls, collectionMoves, deposits, removed,
    held: () => held, holdAt: n => { hold = n; held = false },
    release: () => { const next = release; release = null; held = false; next?.() },
    advance: ms => { clock += ms },
    describe: () => JSON.stringify({ status: job.status().state, reason: job.status().pauseReason, mined: sim.stats.mined, deposits: deposits.length }) }
}

test('passive/full keeps one free slot and a small stone stack instead of flushing at the legacy minimum', async () => {
  const f = fixture({ holdAfter: 8 }); f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 8, f.describe())
    assert.equal(f.deposits.length, 0, 'free1 plus stone5 is not a full inventory')
    assert.equal(f.collectionMoves.length, 0)
  } finally { await f.j.pause(); await f.j.drain() }
})

test('an actually full inventory is stored before the ordinary miner is called', async () => {
  const f = fixture({ free: 0, holdAfter: 1 }); f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.ok(f.deposits.length > 0, f.describe())
    assert.equal(f.deposits[0].mined, 0)
    assert.equal(f.sim.stats.mined, 1)
    assert.equal(f.collectionMoves.length, 0)
  } finally { await f.j.pause(); await f.j.drain() }
})

test('one free slot permits normal gravel mining even when all possible normal drops would need two slots', async () => {
  const f = fixture({ small: true, holdAfter: 1, maxBatch: 1 })
  f.sim.world.set(2, 62, 2, 'gravel')
  f.sim.world.set(2, 62, 3, 'air'); f.sim.world.set(2, 62, 4, 'air')
  f.sim.setFeet({ x: 1, y: 62, z: 2 })
  f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 1, f.describe())
    assert.equal(f.mineCalls[0].targets[0].expectedName, 'minecraft:gravel')
    assert.equal(f.deposits.length, 0, 'possible gravel/flint variants do not force a preliminary flush')
    assert.equal(f.j.document().portableStorage ?? null, null, 'normal mining does not start a held-box capacity batch')
  } finally { await f.j.pause(); await f.j.drain() }
})

test('natural pickup filling the last slot while approaching a mine is stored before mining dispatch', async () => {
  const f = fixture({ holdAfter: 1 }), move = f.sim.adapter.moveTo
  f.sim.setFeet({ x: -6, y: 63, z: 5 })
  let pickedUp = false
  f.sim.adapter.moveTo = async target => {
    const result = await move(target)
    if (!pickedUp) {
      pickedUp = true
      // A received item at the current feet is naturally picked up by the sim.
      f.sim.entities.push({ id: 9010, name: 'minecraft:gold_ingot', count: 1, position: { x: f.sim.state.position.x, y: f.sim.state.position.y - 1.62, z: f.sim.state.position.z } })
      f.sim.adapter.getState()
      assert.equal(f.sim.state.inventory.items.length, 36)
    }
    return result
  }
  f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(pickedUp, true)
    assert.ok(f.deposits.length > 0, f.describe())
    assert.equal(f.deposits[0].mined, 0, 'the full inventory is handled before a normal mining packet')
    assert.equal(f.sim.stats.mined, 1)
  } finally { await f.j.pause(); await f.j.drain() }
})

test('pending/deadline drops are observed without pickup movement or repeated no-op collection', async () => {
  const f = fixture({ free: 24, holdAfter: 8, strategy: { collectAfterSeconds: 1, collectWithinSeconds: 2, collectPendingDrops: 1 } })
  f.sim.entities.push({ id: 9000, name: 'minecraft:gold_ingot', count: 1, position: { x: 14.5, y: 63, z: 14.5 }, stuck: true })
  f.advance(10000); f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 8, f.describe())
    assert.deepEqual(f.collectionMoves, [])
    assert.ok(f.sim.entities.some(item => item.id === 9000))
    assert.equal(f.j.status().ledgerDetail.picked.gold_ingot ?? 0, 0)
    assert.equal(f.deposits.length, 0)
  } finally { await f.j.pause(); await f.j.drain() }
  assert.deepEqual(f.collectionMoves, [], 'manual pause also keeps passive pickup passive')
})

test('combat keeps received partial mining and resumes the same job without pickup trips or repeated cells', async () => {
  const f = fixture({ free: 24, holdAfter: 2 }); f.j.start()
  let next
  try {
    await until(f.held, f.describe)
    f.sim.setCombat(true)
    await until(() => f.j.status().state === 'COMBAT', f.describe)
    assert.equal(f.j.status().ledger.minedBlocks, 2)
    assert.equal(f.j.document().userRunIntent, 'running')
    f.holdAt(5); f.sim.setCombat(false); f.advance(4000)
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 5, f.describe())
    assert.equal(f.j.status().jobId, f.config.jobId)
    assert.equal(f.j.status().ledger.minedBlocks, 2, 'the currently held partial batch is credited only after its response is interrupted')
    assert.deepEqual(f.collectionMoves, [])
    await f.j.pause(); await f.j.drain()
    const saved = f.j.document()
    assert.equal(saved.config.inventory.pickupMode, 'passive'); assert.equal(saved.config.inventory.depositWhen, 'full')
    assert.equal(f.j.status().ledger.minedBlocks, 5)
    f.holdAt(8); next = f.create(); next.load(saved); next.resume()
    await until(() => f.held() || next.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 8, f.describe())
    assert.equal(new Set(f.removed).size, f.removed.length, 'received-air targets are not sent for mining again')
    assert.deepEqual(f.collectionMoves, [])
  } finally { f.sim.setCombat(false); await (next ?? f.j).pause(); await (next ?? f.j).drain() }
})

test('moving down to the next excavation layer does not make a trip to recover the earlier layer drops', async () => {
  const f = fixture({ free: 24, holdAfter: 260 })
  assert.equal(f.j.plan({ ...f.config, yBottom: 61 }).ready, true)
  f.j.start()
  try {
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.sim.stats.mined, 260, f.describe())
    assert.ok(f.mineCalls.some(call => call.targets.some(target => target.y === 61)), 'the test actually crosses a layer boundary')
    assert.deepEqual(f.collectionMoves, [])
    assert.equal(f.deposits.length, 0)
  } finally { await f.j.pause(); await f.j.drain() }
})

test('the final partial load remains carried and normal unpicked drops do not prevent excavation completion', async () => {
  const f = fixture({ free: 24, small: true })
  f.sim.entities.push({ id: 9001, name: 'minecraft:gold_ingot', count: 1, position: { x: 14.5, y: 62, z: 14.5 }, stuck: true })
  f.j.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(f.j.status().state), f.describe)
    if (f.j.status().state === 'PAUSED' && f.j.status().pauseReason === 'UNRESOLVED_EXCEPTIONS') {
      const exceptions = f.j.document().pauseDetails.exceptions
      assert.ok(exceptions.length > 0)
      assert.ok(exceptions.every(entry => entry.kind === 'stair' || entry.kind === 'temporary' && entry.purpose === 'stair'), 'only the fixture legacy staircase may need explicit exception acceptance')
      f.j.acceptExceptions()
      await until(() => ['PAUSED', 'FINISHED'].includes(f.j.status().state), f.describe)
    }
    const status = f.j.status(), document = f.j.document()
    assert.equal(status.state, 'FINISHED', f.describe())
    assert.equal(status.ledger.minedBlocks, 3)
    assert.equal(f.deposits.length, 0, 'full-only does not add a final partial deposit')
    assert.equal(f.collectionMoves.length, 0)
    assert.ok(f.sim.state.inventory.items.some(item => item.name === 'minecraft:cobblestone' && item.count >= 5))
    assert.notEqual(document.finalDeposited, true, 'retained materials are not described as deposited')
    assert.equal(document.finalStorageSkipped?.reason, 'POLICY_FULL_ONLY')
    assert.equal(status.ledgerDetail.picked.gold_ingot ?? 0, 0)
    assert.ok(f.sim.entities.some(item => item.id === 9001))
    assert.equal(document.passivePickup.pickupCompleted, false)
    assert.ok(document.passivePickup.remainingGroundDrops.some(item => item.runtimeId === '9001' && item.name === 'minecraft:gold_ingot' && item.count === 1))
  } finally { await f.j.pause(); await f.j.drain() }
})

test('changing a running job queues the storage policy until its next safe work boundary', async () => {
  const f = fixture({ configured: false, free: 24, maxBatch: 1, holdAfter: 1 }); f.j.start()
  try {
    await until(f.held, f.describe)
    assert.equal(typeof f.j.configureStorage, 'function')
    const status = await f.j.configureStorage(policy)
    assert.deepEqual(status.storagePolicy.pending, policy)
    assert.notEqual(f.j.document().config.inventory.pickupMode, 'passive')
    assert.deepEqual({ pickupMode: f.j.document().pendingStorageConfiguration.pickupMode, depositWhen: f.j.document().pendingStorageConfiguration.depositWhen }, policy)
    f.holdAt(2); f.release()
    await until(() => f.held() || f.j.status().state === 'PAUSED', f.describe)
    assert.equal(f.j.document().config.inventory.pickupMode, 'passive')
    assert.equal(f.j.document().config.inventory.depositWhen, 'full')
    assert.equal(f.j.status().storagePolicy.pending, null)
  } finally { await f.j.pause(); await f.j.drain() }
})

test('a passive/full job still reconciles its owned box before mining, and unknown recovery is never credited', async () => {
  const filename = require.resolve('./quarry-storage-combat-handoff.test'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = fixture\n', filename)
  const h = await loaded.exports('combat', 'awaiting_recovery')
  const document = h.job.document(); Object.assign(document.config.inventory, policy)
  const carried = h.f.items().find(item => /shulker_box$/.test(item.name))
  assert.ok(carried)
  h.f.bag[carried.slot].extra = { has_nbt: false, can_place_on: [], can_destroy: [] }
  h.job.load(document); h.job.resume()
  try {
    await until(() => h.job.status().state === 'PAUSED', () => JSON.stringify(h.job.status().pauseReason))
    const actual = h.job.document()
    assert.equal(actual.pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(actual.portableStorage.operationId, h.op)
    assert.equal(actual.portableStorage.checkpoint.stage, 'awaiting_recovery')
    assert.equal(h.job.status().ledger.minedBlocks ?? 0, 0)
    assert.equal(h.job.status().ledger.deposited ?? 0, 0)
    assert.deepEqual(actual.carriedStorageReceipts ?? [], [])
    assert.deepEqual(h.f.events.filter(event => event.type !== 'move'), [], 'owned-box pickup movement is allowed, but no second placement, transfer or break is sent')
  } finally { await h.job.pause(); await h.job.drain() }
})

test('a policy queued behind an owned full box is applied before RETURN can start another box for three remaining items', async () => {
  const filename = require.resolve('./quarry-portable-storage.test'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item }\n', filename)
  const { fixture: portableFixture, item } = loaded.exports, f = portableFixture('shulker')
  f.bag[0].count = 4; f.request.deposits[0].count = 4
  const open = f.dependencies.chest.open
  let initialized = false
  f.dependencies.chest.open = async (...args) => {
    const result = await open(...args)
    if (!initialized) {
      initialized = true
      const slots = f.containers.get(key(args[0]))
      for (let slot = 0; slot < 27; slot++) slots[slot] = item(3, slot === 26 ? 63 : 64, 200 + slot)
    }
    return result
  }
  const interrupted = new AbortController()
  let checkpoint
  await f.run({ signal: interrupted.signal, onCheckpoint: async cp => { if (!checkpoint && cp.stage === 'awaiting_recovery') { checkpoint = copy(cp); interrupted.abort() } } })
  assert.ok(checkpoint)
  assert.equal(checkpoint.deposited.reduce((n, entry) => n + entry.count, 0), 1)
  assert.equal(f.items().find(entry => entry.name === 'minecraft:dirt').count, 3)
  f.blocks.set('0,65,0', { known: true, name: 'minecraft:stone', runtimeId: 4, boundingBox: 'block', extra: [] })
  const sim = createSim(), events = [], calls = []
  let clock = 1000
  const adapter = { ...sim.adapter, getState: () => ({ ...f.getState(), food: 20, maxHealth: 20 }), getBlock: f.getBlock,
    storeCarried: async (request, options) => { calls.push(request.operationId); assert.equal(request.operationId, f.request.operationId, 'no new storage operation before applying the queued policy'); return f.controller.storeCarried(request, options) } }
  const j = createQuarryJob({ adapter, pollMs: 5, now: () => clock, sleep: async ms => { clock += ms; await turn() }, storage: { save: async () => {} }, log: line => events.push(line) })
  assert.equal(j.plan({ jobId: f.request.jobId, target: { chunks: [{ x: 0, z: 0 }] }, exit: { mode: 'legacy_stair' }, yTop: 65, yBottom: 65, worldMinY: 63, worldMaxY: 69, inventory: { carryOnly: true, keepSealBlocks: 0 } }).ready, true)
  const document = j.document()
  Object.assign(document, { state: 'PAUSED', pauseReason: 'MANUAL_PAUSE', userRunIntent: 'paused', scope: JSON.stringify([f.state.profile, String(f.state.realm.id), f.state.dimension, f.state.connectionId, f.state.startedAt]), life: f.state.lifecycle.deathId,
    portableStorage: { operationId: f.request.operationId, why: 'capacity', selection: copy(f.request.selection), checkpoint, depositLimit: copy(f.request.deposits) } })
  j.load(document)
  assert.equal(typeof j.configureStorage, 'function')
  const configured = await j.configureStorage(policy)
  assert.deepEqual(configured.storagePolicy.pending, policy, 'the existing box retains its in-flight configuration')
  f.events.length = 0; j.resume()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(j.status().state), () => JSON.stringify({ state: j.status().state, reason: j.status().pauseReason, calls }))
    assert.equal(j.document().config.inventory.pickupMode, 'passive')
    assert.equal(j.document().config.inventory.depositWhen, 'full')
    assert.equal(j.status().storagePolicy.pending, null)
    assert.equal(j.document().portableStorage, null)
    assert.deepEqual(calls, [f.request.operationId])
    assert.equal(j.status().ledger.deposited, 1)
    assert.equal(f.items().find(entry => entry.name === 'minecraft:dirt').count, 3)
    assert.deepEqual(j.document().carriedStorageReceipts, [f.request.operationId])
    assert.deepEqual(f.events.filter(event => ['place', 'mine', 'deposit'].includes(event.type)), [])
  } finally { await j.pause(); await j.drain() }
})

test('unsupported policy pairs and invalid saved policy values are rejected without queuing them', async t => {
  const f = fixture({ free: 24 })
  assert.equal(typeof f.j.configureStorage, 'function')
  for (const invalid of [{ pickupMode: 'active', depositWhen: 'full' }, { pickupMode: 'passive', depositWhen: 'capacity' }, { pickupMode: 'invented', depositWhen: 'full' }, { depositEveryBlocks: 64 }]) {
    await assert.rejects(f.j.configureStorage(invalid))
    assert.equal(f.j.status().storagePolicy.pending, null)
    assert.equal(f.j.document().config.inventory.pickupMode, 'passive')
  }
  for (const [label, alter] of [
    ['unknown persisted pickup mode', doc => { doc.config.inventory.pickupMode = 'invented' }],
    ['unsupported saved pair', doc => { doc.config.inventory.pickupMode = 'active' }],
    ['unsupported queued pair', doc => { doc.pendingStorageConfiguration = { pickupMode: 'active', depositWhen: 'full', requestedAt: new Date(0).toISOString() } }],
    ['unknown queued property', doc => { doc.pendingStorageConfiguration = { ...policy, surprise: true } }],
    ['invalid queued time', doc => { doc.pendingStorageConfiguration = { ...policy, requestedAt: 'not-a-time' } }]
  ]) await t.test(label, () => { const doc = f.j.document(); alter(doc); const next = f.create(); assert.throws(() => next.load(doc)) })
})
