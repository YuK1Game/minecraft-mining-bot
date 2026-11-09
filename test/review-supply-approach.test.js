'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { buildRegions, permits } = require('../src/quarry-region')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { supplyScope } = require('../src/quarry-supplies')
const { carriedContainerKey } = require('../src/quarry-inventory')
const { supplyPlacementAllowed, planSupplyApproach } = require('../src/quarry-supply-site')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { supplySitePreview } = require('./helpers/supply-site-preview')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const copy = value => structuredClone(value)
const feet = s => ({ x: Math.floor(s.position.x), y: Math.floor(s.position.y - 1.62 + 1e-3), z: Math.floor(s.position.z) })
const inside = p => p.x >= -32 && p.x <= -17 && p.z >= 16 && p.z <= 31
function fixture (options = {}) {
  const sim = createSim({ loaded: { xMin: -40, xMax: 4, yMin: 50, yMax: 85, zMin: 8, zMax: 40 } })
  flatTerrain(sim, { x1: -40, x2: 4, z1: 8, z2: 40, bedrock: 50, stoneTop: 61, top: 62 })
  sim.setFeet(options.origin ?? { x: -6, y: 63, z: 20 })
  const roles = ['pickaxe', 'shovel', 'food', 'dirt'], foods = ['diamond_pickaxe', 'diamond_shovel', 'bread', 'dirt']
  for (const [i, color] of ['blue', 'light_blue', 'yellow', 'brown'].entries()) sim.give(`${color}_shulker_box`, 1, { stackId: 100 + i })
  sim.give('purple_shulker_box', 20); sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 64); sim.give('dirt', options.dirt ?? 192)
  const bindings = roles.map((role, i) => ({ role, itemName: `minecraft:${foods[i]}`, key: carriedContainerKey(sim.state.inventory.items[i]), boxName: sim.state.inventory.items[i].name, stackId: 100 + i }))
  const docs = [], requests = [], events = [], logs = []
  const actorList = []
  sim.adapter.previewSupplySite = supplySitePreview({ ...sim.adapter, getEntities: () => actorList })
  sim.adapter.discoverSupplies = () => ({ ok: true, bindings: copy(bindings) })
  const move = sim.adapter.moveTo
  sim.adapter.moveTo = async (stand, settings) => {
    events.push({ kind: 'move', stand: copy(stand), path: copy(settings.path) })
    assert.ok(settings.path.length > 1)
    assert.ok(settings.path.every(p => settings.travel(p)))
    if (options.move) return options.move({ sim, stand, settings, move })
    return move(stand, settings)
  }
  sim.adapter.restockSupplies = async (request, { onCheckpoint }) => {
    events.push({ kind: 'restock', at: feet(sim.state) }); requests.push(request)
    if (options.existingChild) return { status: 'blocked', serverConfirmed: false, reason: 'CONTROLLED_PENDING_TRANSFER' }
    assert.ok(inside(feet(sim.state)), 'never open the supply box outside the target')
    const preview = sim.adapter.previewSupplySite(feet(sim.state), { canPlace: request.canPlace })
    assert.equal(preview.ready, true, JSON.stringify(preview))
    await onCheckpoint({ version: 1, jobId: request.jobId, operationId: request.operationId, scope: supplyScope(sim.state), index: 3, child: null, bindings: copy(bindings), withdrawn: [], returned: [] })
    sim.give('dirt', 32)
    return { status: 'completed', serverConfirmed: true, bindings: copy(bindings), withdrawn: [{ role: 'dirt', name: 'minecraft:dirt', count: 32 }], returned: [] }
  }
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (_id, doc) => {
    docs.push(copy(doc)); if (options.save) await options.save(doc)
  } }, sleep: () => turn(), pollMs: 5, log: line => logs.push(line) })
  const config = { jobId: 'supply-approach', target: { chunks: [{ x: -2, z: 1 }] }, yTop: options.top ?? 62, yBottom: 61, worldMinY: 50, worldMaxY: 85,
    permissions: options.permissions ?? {}, inventory: { carryOnly: true, autoSupplies: true, pickupMode: 'passive', depositWhen: 'full', minFreeSlots: 1, keepFood: 64, keepExitDirt: 192, keepSealBlocks: 32 } }
  assert.equal(job.plan(config).ready, true)
  return { sim, job, config, docs, requests, events, logs, actorList, bindings }
}
async function until (predicate) {
  const deadline = Date.now() + 7000
  while (!predicate()) { if (Date.now() > deadline) throw Error('bounded supply approach test timed out'); await turn() }
}
async function run (f, start = () => f.job.start()) {
  start()
  await until(() => f.job.status().state === 'PAUSED' || f.job.document().supplyReceipts?.length)
  await f.job.pause()
}

test('review: initial restock walks from outside the quarry to a placeable site before opening supplies', async () => {
  const f = fixture(); await run(f)
  assert.equal(f.requests.length, 1, JSON.stringify(f.job.status().pauseDetails))
  assert.deepEqual(f.events.map(e => e.kind), ['move', 'restock'])
  assert.ok(inside(f.events[0].stand)); assert.equal(f.events[0].stand.y, 63)
  assert.deepEqual(f.events[0].path[0], { x: -6, y: 63, z: 20 })
  assert.ok(f.docs.some(d => d.checkpointReason === 'supply_approach_intent' || d.supplyRestock?.approach?.phase === 'planned'))
  assert.ok(f.logs.some(l => l.includes('supply_approach')))
  assert.ok(f.logs.some(l => l.includes('supply_arrived')))
  assert.equal(f.job.document().supplyReceipts.length, 1)
  assert.equal(f.job.document().config.yTop, 62)
  assert.equal(f.job.document().config.yBottom, 61)
})

test('review: old STORAGE_SITE_UNOBSERVED operation with no child is relocated and keeps its operation/checkpoint', async () => {
  const f = fixture(), old = f.job.document(), operationId = 'supply-approach:supplies:7'
  Object.assign(old, { state: 'PAUSED', pauseReason: 'SUPPLY_RESTOCK_BLOCKED', userRunIntent: 'running',
    supplyRestock: { operationId, resumeTo: 'SURVEY', checkpoint: { version: 1, jobId: old.config.jobId, operationId, scope: supplyScope(f.sim.state), index: 3, child: null, bindings: copy(f.bindings), marker: 'retained', withdrawn: [], returned: [] } } })
  f.job.load(old)
  await run(f, () => f.job.resume())
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].operationId, operationId)
  assert.equal(f.requests[0].checkpoint.marker, 'retained')
  assert.equal(f.events[0].kind, 'move')
})

test('review: an uncut surface at yTop+1 permits only supply staging, not extra excavation', () => {
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 50, travelRegion: [{ xMin: -4, xMax: 20, zMin: -4, zMax: 20, yMin: 50, yMax: 70 }] })
  assert.equal(supplyPlacementAllowed(regions, { x: 3, y: 63, z: 3 }), true)
  assert.equal(permits(regions, 'break', { x: 3, y: 63, z: 3 }).allowed, false)
  assert.equal(permits(regions, 'place', { x: 3, y: 63, z: 3 }).allowed, false)
  assert.equal(supplyPlacementAllowed(regions, { x: -1, y: 63, z: 3 }), false)
  assert.equal(supplyPlacementAllowed(regions, { x: 3, y: 64, z: 3 }), false)
  assert.equal(supplyPlacementAllowed(regions, { x: 3, y: 49, z: 3 }), false)
  regions.protected.push({ xMin: 3, xMax: 3, yMin: 63, yMax: 64, zMin: 3, zMax: 3 })
  assert.equal(supplyPlacementAllowed(regions, { x: 3, y: 63, z: 3 }), false)
})

test('review: already at a safe worksite uses that layer without an approach move', async () => {
  const f = fixture({ origin: { x: -20, y: 63, z: 20 }, top: 80 }); await run(f)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.events.map(e => e.kind), ['restock'])
})

test('review: sufficient direct inventory never walks or opens a box just to restock', async () => {
  const f = fixture({ dirt: 224 })
  const r = await f.job.restockSuppliesNow()
  assert.equal(r.state, 'PAUSED'); assert.equal(f.requests.length, 0); assert.equal(f.events.length, 0)
})

for (const condition of ['no-motion', 'failed-motion', 'changed-site']) test(`review: ${condition} cannot open or spend supplies`, async () => {
  const f = fixture({ move: async ({ sim, stand, settings, move }) => {
    if (condition === 'no-motion') return { phase: 'completed' }
    if (condition === 'failed-motion') throw Error('controlled route failure')
    const result = await move(stand, settings)
    sim.world.set(stand.x, stand.y - 1, stand.z, 'water')
    return result
  } })
  await run(f)
  assert.equal(f.requests.length, 0)
  assert.equal(f.job.status().pauseReason, 'SUPPLY_RESTOCK_BLOCKED')
  assert.match(f.job.status().pauseDetails.reason, /SUPPLY_APPROACH_MOVE_FAILED|SUPPLY_SITE_CHANGED/)
  assert.equal(f.job.document().supplyRestock.checkpoint, null)
})

for (const reason of ['death', 'combat', 'stop', 'world']) test(`review: ${reason} during approach never enters supply placement`, async () => {
  let stopping
  const f = fixture({ move: async ({ sim, stand, settings, move }) => {
    await move(stand, settings)
    if (reason === 'death') { sim.state.health = 0; sim.state.dead = true }
    else if (reason === 'combat') sim.setCombat(true)
    else if (reason === 'world') sim.state.realm.id = 'other'
    else stopping = f.job.pause()
    return { phase: 'completed' }
  } })
  f.job.start()
  try {
    await until(() => ['PAUSED', 'COMBAT', 'STOPPING'].includes(f.job.status().state))
    if (stopping) await stopping
    assert.equal(f.requests.length, 0)
    assert.ok(f.job.document().supplyRestock)
  } finally { await f.job.pause() }
})

test('review: a saved child with uncertain transfer remains with its existing recovery owner, no relocation', async () => {
  const f = fixture({ existingChild: true }), old = f.job.document(), child = { stage: 'depositing', intent: { type: 'withdraw', requestId: -11 }, positions: [{ x: -20, y: 63, z: 20 }] }
  old.state = 'PAUSED'; old.userRunIntent = 'running'; old.pauseReason = 'SUPPLY_RESTOCK_BLOCKED'
  old.supplyRestock = { operationId: 'same-child-owner', resumeTo: 'SURVEY', checkpoint: { child, marker: 'keep' } }
  f.job.load(old); await run(f, () => f.job.resume())
  assert.equal(f.events.filter(e => e.kind === 'move').length, 0)
  assert.deepEqual(f.requests[0].checkpoint.child, child)
  assert.equal(f.requests[0].operationId, 'same-child-owner')
  assert.equal(f.job.status().pauseDetails.reason, 'CONTROLLED_PENDING_TRANSFER')
})

test('review: a stale supply lifecycle with no child is rejected before walking', async () => {
  const f = fixture(), old = f.job.document()
  old.state = 'PAUSED'; old.userRunIntent = 'running'
  old.supplyRestock = { operationId: 'old-life', checkpoint: { scope: { ...supplyScope(f.sim.state), life: 99 }, child: null } }
  f.job.load(old); await run(f, () => f.job.resume())
  assert.equal(f.events.length, 0)
  assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_SCOPE_CHANGED')
})

test('review: travel permissions are not widened to reach an otherwise valid supply site', async () => {
  const f = fixture({ permissions: { travelRegion: [{ xMin: -8, xMax: -4, yMin: 60, yMax: 70, zMin: 18, zMax: 22 }] } })
  await run(f)
  assert.equal(f.events.length, 0)
  assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_APPROACH_UNREACHABLE')
})

test('review: failed approach-intent persistence cannot dispatch walking or supply work', async () => {
  const f = fixture({ save: async doc => { if (doc.supplyRestock?.approach) throw Error('controlled disk full') } })
  f.job.start()
  await until(() => f.job.status().state === 'PAUSED')
  await f.job.drain()
  assert.equal(f.events.length, 0)
  assert.equal(f.job.status().pauseReason, 'PERSISTENCE_FAILED')
  await assert.rejects(f.job.pause(), { code: 'PERSISTENCE_FAILED' })
})

test('review: exact site previews use real terrain and never send actions or pretend to move the player', () => {
  const f = fixture(), before = copy(f.sim.state.position)
  const p = { x: -20, y: 63, z: 20 }
  const preview = f.sim.adapter.previewSupplySite(p, { canPlace: inside })
  assert.equal(preview.ready, true, JSON.stringify(preview))
  assert.equal(preview.serverConfirmed, false)
  assert.deepEqual(f.sim.state.position, before)
  assert.equal(f.events.length, 0)
  f.actorList.push({ kind: 'mob', alive: true, runtimeId: 'different', positionKnown: false })
  assert.equal(f.sim.adapter.previewSupplySite(p, { canPlace: inside }).ready, false)
})

test('review: runtime adapter forwards the read-only site proposal without changing its result', () => {
  const stand = { x: -20, y: 63, z: 20 }, canPlace = () => true
  const adapter = createQuarryRuntimeAdapter({ previewSupplySite: (p, options) => { assert.strictEqual(p, stand); assert.strictEqual(options.canPlace, canPlace); return { ready: false, reason: 'UNOBSERVED' } } })
  assert.deepEqual(adapter.previewSupplySite(stand, { canPlace }), { ready: false, reason: 'UNOBSERVED' })
})

for (const obstacle of ['unreceived', 'water', 'protected']) test(`review: ${obstacle} work surface cannot be a supply staging success`, async () => {
  const f = fixture()
  const base = f.sim.adapter.getBlock
  const getBlock = (x, y, z) => inside({ x, z }) && y === 63 ? obstacle === 'unreceived' ? { known: false } : { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] } : base(x, y, z)
  const regions = buildRegions({ ...f.config, travelRegion: [{ xMin: -40, xMax: 4, yMin: 50, yMax: 85, zMin: 8, zMax: 40 }], protectedRegion: obstacle === 'protected' ? [{ xMin: -32, xMax: -17, yMin: 50, yMax: 85, zMin: 16, zMax: 31 }] : [] })
  const read = obstacle === 'protected' ? base : getBlock
  const planner = createQuarryPlanner({ regions, getBlock: read })
  const result = await planSupplyApproach({ origin: feet(f.sim.state), regions, planner, canPlace: p => supplyPlacementAllowed(regions, p), previewSite: supplySitePreview({ getState: f.sim.adapter.getState, getBlock: read }) })
  assert.equal(result.ready, false)
  assert.equal(f.events.length, 0)
})

// The location selected above must be accepted by the real portable pipeline,
// including received placement, window contents, withdrawal and box recovery.
test('review: arrived surface site is reusable by real portable supply placement and recovery', async () => {
  const fs = require('node:fs'), Module = require('node:module'), path = require('node:path')
  const file = require.resolve('./quarry-supply-portable.test'), loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  const ordinary = loaded.require.bind(loaded)
  loaded.require = id => id === 'node:test' ? { test: () => {} } : ordinary(id)
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { setup, withdrawFive };', file)
  const { setup, withdrawFive } = loaded.exports
  const f = setup(async (f, context, { onCheckpoint }) => {
    withdrawFive(f, context.position)
    await onCheckpoint({ phase: 'completed' })
    return { status: 'completed', serverConfirmed: true, withdrawn: [{ name: 'minecraft:dirt', count: 5 }], returned: [] }
  })
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 64, yBottom: 50, travelRegion: [{ xMin: -4, xMax: 20, yMin: 50, yMax: 70, zMin: -4, zMax: 20 }] })
  const canPlace = p => supplyPlacementAllowed(regions, p)
  const preview = f.runner.previewSupplySite(feet(f.state), { canPlace })
  assert.equal(preview.ready, true)
  assert.equal(preview.stand.y, 65)
  assert.equal(f.events.length, 0, 'preview cannot equip, move, or open a container')
  const result = await f.run(null, { canPlace })
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.recovered, true)
  assert.deepEqual(result.checkpoint.stand, preview.stand)
  assert.deepEqual(result.checkpoint.positions, preview.positions)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  assert.equal(result.checkpoint.supplyResult.withdrawn[0].count, 5)
})

test('review: native walking refusal is checked before dispatch and bounded', async () => {
  const f = fixture(); let previews = 0
  f.sim.adapter.previewStorage = async () => { previews++; return { ready: false, reason: 'CONTROLLED_NATIVE_ROUTE_REFUSAL' } }
  await run(f)
  assert.equal(previews, 8)
  assert.equal(f.events.length, 0)
  assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_APPROACH_ROUTE_LIMIT')
})

test('review: a changed origin while computing a route invalidates it before dispatch', async () => {
  const f = fixture()
  f.sim.adapter.previewStorage = async () => { f.sim.setFeet({ x: -5, y: 63, z: 20 }); return { ready: true } }
  await run(f)
  assert.equal(f.events.length, 0)
  assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_APPROACH_ORIGIN_CHANGED')
})
