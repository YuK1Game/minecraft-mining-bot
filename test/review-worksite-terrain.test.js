'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { supplySitePreview } = require('./helpers/supply-site-preview')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')
const { carriedContainerKey } = require('../src/quarry-inventory')
const { clearableSitePlant } = require('../src/storage-site-terrain')
const copy = value => structuredClone(value)
function terrain (ground = 'grass_block') {
  const sim = createSim({ loaded: { xMin: -40, xMax: 6, yMin: 50, yMax: 90, zMin: 8, zMax: 40 } })
  flatTerrain(sim, { x1: -40, x2: 6, z1: 8, z2: 40, bedrock: 50, stoneTop: 63, top: 64 })
  sim.world.fill(-40, 64, 8, 6, 64, 40, ground)
  sim.setFeet({ x: -20, y: 65, z: 20 })
  const actors = []
  const preview = supplySitePreview({ ...sim.adapter, getEntities: () => actors })
  return { sim, actors, preview, stand: { x: -20, y: 65, z: 20 } }
}
for (const ground of ['clay', 'podzol', 'mycelium', 'sandstone', 'red_sandstone', 'basalt', 'bedrock', 'sand', 'red_sand', 'gravel']) test(`review: supply footprint accepts received stable ${ground} rather than a narrow ground whitelist`, () => {
  const f = terrain(ground), before = copy(f.sim.state.position)
  const result = f.preview(f.stand, { canPlace: () => true })
  assert.equal(result.ready, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.sim.state.position, before)
  assert.equal(f.sim.stats.moves, 0)
})
test('review: an unsupported sand stack is not a safe supply floor', () => {
  const f = terrain('sand'); f.sim.world.fill(-40, 63, 8, 6, 63, 40, 'air')
  const r = f.preview(f.stand, { canPlace: () => true })
  assert.equal(r.ready, false); assert.equal(r.details.cause, 'SUPPORT_NOT_SOLID')
})
for (const ground of ['farmland', 'mud', 'magma', 'soul_sand', 'powder_snow', 'oak_leaves', 'bamboo']) test(`review: partial or harmful ${ground} remains disallowed`, () => {
  const f = terrain(ground)
  assert.equal(f.preview(f.stand, { canPlace: () => true }).ready, false)
})
test('review: a dry collisionless plant at the stand does not invent a collision', () => {
  const f = terrain(); f.sim.world.set(f.stand.x, f.stand.y, f.stand.z, 'short_grass')
  const r = f.preview(f.stand, { canPlace: () => true })
  assert.equal(r.ready, true, JSON.stringify(r)); assert.equal(r.preparation, undefined)
  assert.equal(f.sim.world.name(f.stand.x, f.stand.y, f.stand.z), 'short_grass')
})
test('review: dense grass is only a clearance proposal; ordinary placement still requires received air', () => {
  const f = terrain(); f.sim.world.fill(-40, 65, 8, 6, 65, 40, 'short_grass')
  const settings = { canPlace: () => true }
  assert.equal(f.preview(f.stand, settings).ready, false)
  const r = f.preview(f.stand, { ...settings, canClear: () => true })
  assert.equal(r.ready, true, JSON.stringify(r)); assert.equal(r.requiresPreparation, true)
  assert.equal(r.preparation.length, 2)
  assert.equal(Math.abs(r.preparation[0].x - f.stand.x) + Math.abs(r.preparation[0].z - f.stand.z), 1, 'clear the intervening grass before the farther box cell')
  assert.equal(f.sim.stats.mined, 0)
  assert.equal(f.preview(f.stand, settings).ready, false, 'proposal must not fabricate air')
})
test('review: supply can use an adjacent permitted box cell when a two-cell gap is unavailable', () => {
  const f = terrain(), target = { ...f.stand, x: f.stand.x + 1 }
  const allowed = p => p.y === f.stand.y && p.z === f.stand.z && (p.x === f.stand.x || p.x === target.x)
  const r = f.preview(f.stand, { canPlace: allowed })
  assert.equal(r.ready, true, JSON.stringify(r)); assert.deepEqual(r.positions, [target])
})
test('review: unknown terrain has a concrete coordinate and is never a preparation proposal', () => {
  const f = terrain(); const preview = supplySitePreview({ ...f.sim.adapter, getBlock: () => ({ known: false }) })
  const r = preview(f.stand, { canPlace: () => true, canClear: () => true })
  assert.equal(r.ready, false); assert.equal(r.details.cause, 'STAND_TERRAIN_UNKNOWN'); assert.deepEqual(r.details.position, f.stand)
})
for (const name of ['water', 'seagrass', 'kelp', 'sweet_berry_bush', 'wheat', 'oak_leaves', 'snow_layer']) test(`review: ${name} is never cleared as harmless supply grass`, () => {
  assert.equal(clearableSitePlant({ known: true, name: `minecraft:${name}`, boundingBox: 'empty', extra: [] }), false)
})
test('review: protected and waterlogged grass cannot be cleared', () => {
  const b = { known: true, name: 'minecraft:short_grass', boundingBox: 'empty', extra: [] }
  assert.equal(clearableSitePlant({ ...b, protected: true }), false)
  assert.equal(clearableSitePlant({ ...b, extra: [{ name: 'minecraft:water' }] }), false)
})

function jobFixture (mode = 'normal', hooks = {}) {
  const f = terrain(), { sim } = f
  sim.setFeet({ x: -4, y: 65, z: 16 })
  // Reported origin and target band, but synthetic flat terrain with plants.
  sim.world.fill(-32, 65, 16, -17, 65, 31, 'short_grass')
  const roles = ['pickaxe', 'shovel', 'food', 'dirt'], names = ['diamond_pickaxe', 'diamond_shovel', 'bread', 'dirt']
  for (const [i, color] of ['blue', 'light_blue', 'yellow', 'brown'].entries()) sim.give(`${color}_shulker_box`, 1, { stackId: 100 + i })
  const bindings = roles.map((role, i) => ({ role, itemName: `minecraft:${names[i]}`, key: carriedContainerKey(sim.state.inventory.items[i]), boxName: sim.state.inventory.items[i].name, stackId: 100 + i }))
  sim.give('purple_shulker_box', 20); sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 64); sim.give('dirt', 192)
  const events = [], logs = [], docs = []
  sim.adapter.discoverSupplies = () => ({ ok: true, bindings: copy(bindings) })
  sim.adapter.previewSupplySite = f.preview
  const move = sim.adapter.moveTo, mine = sim.adapter.mine
  sim.adapter.moveTo = async (...args) => { events.push('move'); const r = await move(...args); await hooks.afterMove?.(sim); return r }
  sim.adapter.mine = async (targets, settings) => {
    assert.ok(events.includes('move'), 'walk before preparing the supply patch')
    assert.ok(targets.every(p => p.x >= -32 && p.x <= -17 && p.z >= 16 && p.z <= 31))
    events.push('clear')
    if (mode === 'no-receipt') return { phase: 'completed', serverConfirmed: true }
    const result = await mine(targets, settings)
    await hooks.afterMine?.(sim, targets)
    return result
  }
  sim.adapter.restockSupplies = async request => {
    events.push('restock')
    const p = sim.state.position, here = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62 + 0.001), z: Math.floor(p.z) }
    assert.equal(f.preview(here, { canPlace: request.canPlace }).ready, true, 'actual footprint must need no hypothetical clearance')
    sim.give('dirt', 32)
    return { status: 'completed', serverConfirmed: true, bindings: copy(bindings), withdrawn: [{ name: 'minecraft:dirt', count: 32 }], returned: [] }
  }
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (_id, d) => { await hooks.save?.(d); docs.push(copy(d)) } }, sleep: turn, pollMs: 5, log: l => logs.push(l) })
  const config = { jobId: 'worksite-terrain', target: { chunks: [{ x: -2, z: 1 }] }, yTop: 85, yBottom: 63, worldMinY: 50, worldMaxY: 90, inventory: { carryOnly: true, autoSupplies: true, minFreeSlots: 1, pickupMode: 'passive', depositWhen: 'full' } }
  assert.equal(job.plan(config).ready, true)
  return { ...f, job, events, logs, docs }
}
for (const entry of ['start', 'resume']) test(`review: ${entry} walks, prepares received grass, rechecks air, then opens supply box`, async () => {
  const f = jobFixture()
  if (entry === 'resume') { const d = f.job.document(); Object.assign(d, { state: 'PAUSED', userRunIntent: 'running', pauseReason: 'SUPPLY_RESTOCK_BLOCKED', supplyRestock: { operationId: 'worksite-terrain:supplies:9', checkpoint: null, resumeTo: 'SURVEY' } }); f.job.load(d) }
  f.job[entry]()
  try {
    const deadline = Date.now() + 6000
    while (!f.job.document().supplyReceipts?.length && f.job.status().state !== 'PAUSED') { if (Date.now() > deadline) throw Error('bounded worksite test timeout'); await turn() }
    await f.job.pause()
    assert.equal(f.events.at(-1), 'restock', JSON.stringify(f.job.status()))
    assert.deepEqual(f.events, ['move', 'clear', 'clear', 'restock'])
    assert.ok(f.docs.some(d => d.actions.some(a => a.type === 'supply_site_clear' && a.status === 'confirmed')))
    if (entry === 'resume') assert.equal(f.job.document().supplyReceipts[0].operationId, 'worksite-terrain:supplies:9')
  } finally { await f.job.pause() }
})
test('review: sent mining without received air never proceeds to supply placement', async () => {
  const f = jobFixture('no-receipt'); f.job.start()
  try {
    const deadline = Date.now() + 6000
    while (f.job.status().state !== 'PAUSED') { if (Date.now() > deadline) throw Error('bounded failed-preparation timeout'); await turn() }
    assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_SITE_PREPARATION_UNCONFIRMED')
    assert.ok(!f.events.includes('restock'))
  } finally { await f.job.pause() }
})

async function waitPaused (f) {
  const deadline = Date.now() + 6000
  while (f.job.status().state !== 'PAUSED') { if (Date.now() > deadline) throw Error('bounded preparation test timeout'); await turn() }
  await f.job.drain()
}
test('review: changing grass to a solid block during approach does not grant excavation permission', async () => {
  const f = jobFixture('normal', { afterMove: sim => sim.world.fill(-32, 65, 16, -17, 65, 31, 'stone') })
  f.job.start()
  try { await waitPaused(f); assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_SITE_CHANGED'); assert.deepEqual(f.events, ['move']) } finally { await f.job.pause() }
})
test('review: failed intent persistence prevents the first plant removal', async () => {
  const f = jobFixture('normal', { save: d => { if (d.actions.some(a => a.type === 'supply_site_clear' && a.status === 'intent')) throw Error('controlled disk error') } })
  f.job.start()
  try { await waitPaused(f); assert.equal(f.job.status().pauseReason, 'PERSISTENCE_FAILED'); assert.deepEqual(f.events, ['move']) } finally { await assert.rejects(f.job.pause(), { code: 'PERSISTENCE_FAILED' }) }
})
test('review: a moved pose after clearing is not treated as arrival at the saved supply stand', async () => {
  const f = jobFixture('normal', { afterMine: sim => sim.setFeet({ x: -4, y: 65, z: 16 }) })
  f.job.start()
  try { await waitPaused(f); assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_SITE_CHANGED'); assert.deepEqual(f.events, ['move', 'clear']) } finally { await f.job.pause() }
})
test('review: hand pause after one received clearance prevents further mining and box placement', async () => {
  let stopping
  const f = jobFixture('normal', { afterMine: () => { stopping = f.job.pause() } })
  f.job.start()
  try { await waitPaused(f); await stopping; assert.deepEqual(f.events, ['move', 'clear']); assert.equal(f.job.document().userRunIntent, 'paused') } finally { await f.job.pause() }
})
test('review: death after a received clearance never proceeds to opening a supply box', async () => {
  const f = jobFixture('normal', { afterMine: sim => { sim.state.dead = true; sim.state.health = 0 } })
  f.job.start()
  try { await waitPaused(f); assert.equal(f.job.status().pauseReason, 'DEATH'); assert.deepEqual(f.events, ['move', 'clear']) } finally { await f.job.pause() }
})
test('review: exhausted inventory capacity does not make room by untracked grass mining', async () => {
  const f = jobFixture('normal', { afterMove: sim => { sim.give('cobblestone', 64 * 36) } })
  f.job.start()
  try { await waitPaused(f); assert.equal(f.job.status().pauseDetails.reason, 'SUPPLY_SITE_PREPARATION_CAPACITY'); assert.deepEqual(f.events, ['move']) } finally { await f.job.pause() }
})

test('review: proposed clearance targets pass the real mining controller and still need received air', async t => {
  const { createMining } = require('../src/mining')
  const f = terrain(); f.sim.setFeet(f.stand)
  f.sim.world.fill(-40, 65, 8, 6, 65, 40, 'short_grass')
  const proposal = f.preview(f.stand, { canPlace: () => true, canClear: () => true })
  assert.equal(proposal.ready, true)
  const actions = [], input = { lookAt () {}, start () {}, stop () {}, sendAction: (...a) => actions.push(a), stats: () => ({ running: false }) }
  const mining = createMining({ getState: f.sim.adapter.getState, world: { getBlock: f.sim.adapter.getBlock }, getInput: () => input, blockTimeoutMs: 500 })
  t.after(() => mining.stop())
  for (const target of proposal.preparation) {
    const request = { ...target, accessPreparation: 'quarry', requiredTool: null }
    const preview = mining.preview([request])
    assert.equal(preview.ready, true, JSON.stringify(preview))
    mining.start([request])
    await turn()
    assert.notEqual(mining.snapshot().phase, 'completed', 'a sent break does not manufacture air')
    f.sim.world.set(target.x, target.y, target.z, 'air')
    mining.applyPacket('update_block', { position: target })
    await turn()
    assert.equal(mining.snapshot().phase, 'completed')
  }
  assert.equal(actions.filter(a => a[0] === 'start_break').length, proposal.preparation.length)
  assert.equal(f.preview(f.stand, { canPlace: () => true }).ready, true)
})
