'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { supplySitePreview } = require('./helpers/supply-site-preview')
const { supplyScope } = require('../src/quarry-supplies')
const { carriedContainerKey } = require('../src/quarry-inventory')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture () {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 80, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.setFeet({ x: -3, y: 63, z: 5 })
  const roles = ['pickaxe', 'shovel', 'food', 'dirt'], foods = ['diamond_pickaxe', 'diamond_shovel', 'bread', 'dirt']
  for (const [i, color] of ['blue', 'red', 'green', 'brown'].entries()) sim.give(`${color}_shulker_box`, 1, { stackId: 100 + i })
  sim.give('undyed_shulker_box', 20)
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('iron_sword'); sim.give('bow'); sim.give('bread', 64); sim.give('arrow', 64); sim.give('dirt', 192)
  let bindings = roles.map((role, i) => ({ role, itemName: `minecraft:${foods[i]}`, key: carriedContainerKey(sim.state.inventory.items[i]), boxName: sim.state.inventory.items[i].name, stackId: 100 + i }))
  const docs = [], requests = []
  let behavior = 'success'
  sim.adapter.previewSupplySite = supplySitePreview(sim.adapter)
  sim.adapter.discoverSupplies = () => ({ ok: true, bindings: structuredClone(bindings) })
  sim.adapter.restockSupplies = async (request, { onCheckpoint }) => {
    requests.push(request)
    await onCheckpoint({ version: 1, jobId: request.jobId, operationId: request.operationId, phase: 'controlled', scope: supplyScope(sim.state), marker: request.checkpoint?.marker ?? 'same-operation' })
    if (behavior === 'blocked') return { status: 'blocked', serverConfirmed: false, reason: 'SUPPLY_FRESH_INVENTORY_REQUIRED' }
    if (behavior === 'site') { behavior = 'success'; return { status: 'blocked', serverConfirmed: false, reason: 'STORAGE_SITE_CHANGED', checkpoint: { withdrawn: [], returned: [], child: { placed: [], siteIssue: { cause: 'ENTITY_OCCUPIES_OR_UNOBSERVED', part: 'box' } } } } }
    if (behavior === 'placed-site') { return { status: 'blocked', serverConfirmed: false, reason: 'STORAGE_SITE_CHANGED', checkpoint: { withdrawn: [], returned: [], child: { placed: [{ position: { x: 0, y: 0, z: 0 } }] } } } }
    if (behavior === 'room') { behavior = 'success'; return { status: 'blocked', serverConfirmed: false, reason: 'SUPPLY_CAPACITY_REQUIRED' } }
    const dirt = sim.state.inventory.items.filter(i => i.name === 'minecraft:dirt').reduce((sum, item) => sum + item.count, 0), need = 224 - dirt
    if (need > 0) sim.give('dirt', need)
    const box = sim.state.inventory.items.find(item => carriedContainerKey(item) === bindings.find(b => b.role === 'dirt').key)
    box.stackId = 900
    bindings = bindings.map(binding => binding.role === 'dirt' ? { ...binding, stackId: 900, key: carriedContainerKey(box) } : binding)
    return { status: 'completed', serverConfirmed: true, bindings: structuredClone(bindings), withdrawn: need > 0 ? [{ role: 'dirt', name: 'minecraft:dirt', count: need, confirmedBy: 'controlled_received_transfer' }] : [], returned: [] }
  }
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => { docs.push(structuredClone(doc)) } }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  const config = { jobId: 'supply-job', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 61, worldMinY: 50, worldMaxY: 80, boundarySeal: { material: 'dirt', sourceOnly: true }, inventory: { carryOnly: true, minFreeSlots: 1, keepFood: 64, keepLogs: 0, keepPlanks: 0, keepCoal: 0, keepSticks: 0 } }
  return { sim, job, config, docs, requests, bindings: () => structuredClone(bindings), setBehavior: value => { behavior = value } }
}

test('registering four received supply boxes on an idle job preserves mining progress and manual restock remains paused', async () => {
  const f = fixture()
  assert.equal(f.job.plan(f.config).ready, true)
  const before = f.job.document()
  await f.job.configureSupplies()
  assert.equal(f.job.document().deepestY, before.deepestY)
  assert.deepEqual(f.job.document().ledger, before.ledger)
  const result = await f.job.restockSuppliesNow()
  assert.equal(result.state, 'PAUSED')
  assert.equal(result.supplyResult.status, 'completed')
  assert.equal(result.supplies.needs.available.dirt, 224)
  assert.equal(result.supplies.needs.freeSlots, 2)
  assert.equal(result.supplies.bindings.find(b => b.role === 'dirt').stackId, 900)
  assert.equal(f.sim.stats.mined, 0)
  assert.equal(result.ledger.picked, 0, 'internal supply movement is not claimed as mined-drop pickup')
  assert.equal(f.job.document().supplyReceipts.length, 1)
  assert.ok(f.docs.some(d => d.supplyRestock?.checkpoint?.marker === 'same-operation'))
})

test('autoSupplies discovers once during planning; unknown discovery prevents start without sending supply work', () => {
  const f = fixture()
  assert.equal(f.job.plan({ ...f.config, inventory: { ...f.config.inventory, autoSupplies: true } }).ready, true)
  assert.equal(f.job.document().config.inventory.supplyBoxes.length, 4)
  const unknown = fixture(); unknown.sim.adapter.discoverSupplies = () => ({ ok: false, reason: 'SUPPLY_BOXES_UNCONFIRMED' })
  const planned = unknown.job.plan({ ...unknown.config, inventory: { ...unknown.config.inventory, autoSupplies: true } })
  assert.equal(planned.ready, false)
  assert.ok(planned.issues.includes('SUPPLY_BOXES_UNCONFIRMED'))
  assert.equal(unknown.requests.length, 0)
  assert.throws(() => unknown.job.start(), /not ready/)
})

test('an interrupted supply operation preserves its checkpoint and cannot have its box bindings replaced', async () => {
  const f = fixture(); f.job.plan(f.config); await f.job.configureSupplies()
  f.setBehavior('blocked')
  const first = await f.job.restockSuppliesNow()
  assert.equal(first.pauseReason, 'SUPPLY_RESTOCK_BLOCKED')
  const operation = f.job.document().supplyRestock.operationId
  await assert.rejects(f.job.configureSupplies({ bindings: f.bindings() }), /unfinished/)
  f.setBehavior('success')
  const second = await f.job.restockSuppliesNow()
  assert.equal(second.state, 'PAUSED')
  assert.equal(second.pauseReason, 'MANUAL_PAUSE')
  assert.equal(second.supplyResult.status, 'completed')
  assert.equal(f.requests[1].operationId, operation)
  assert.equal(f.requests[1].checkpoint.marker, 'same-operation')
  assert.equal(f.job.document().supplyReceipts.length, 1)
})

test('ordinary cargo storage excludes all four supplies even when they occupy the first inventory slots', async () => {
  const f = fixture(); f.job.plan(f.config); await f.job.configureSupplies()
  const paused = f.job.document()
  Object.assign(paused, { state: 'PAUSED', pauseReason: 'MANUAL_PAUSE', userRunIntent: 'paused', scope: JSON.stringify([f.sim.state.profile, f.sim.state.realm.id, f.sim.state.dimension, f.sim.state.connectionId, f.sim.state.startedAt]), life: f.sim.state.lifecycle.deathId })
  f.job.load(paused)
  f.sim.give('stone', 1)
  let selected = null
  f.sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    selected = request.selection
    const cp = { jobId: request.jobId, operationId: request.operationId, kind: 'shulker', stage: 'completed' }
    await onCheckpoint(cp)
    for (const deposit of request.deposits) {
      const item = f.sim.state.inventory.items.find(i => i.slot === deposit.slot)
      item.count -= deposit.count
      if (!item.count) f.sim.state.inventory.items.splice(f.sim.state.inventory.items.indexOf(item), 1)
    }
    return { status: 'completed', serverConfirmed: true, recovered: true, deposited: request.deposits.map(({ name, count }) => ({ name, count })), checkpoint: cp }
  }
  const result = await f.job.storeCarriedNow()
  assert.equal(result.storageResult.status, 'completed')
  assert.equal(selected.sources[0].name, 'minecraft:undyed_shulker_box')
  assert.ok(!f.bindings().some(binding => binding.key === selected.key))
  assert.equal(f.sim.state.inventory.items.filter(i => ['minecraft:blue_shulker_box', 'minecraft:red_shulker_box', 'minecraft:green_shulker_box', 'minecraft:brown_shulker_box'].includes(i.name)).length, 4)
})

test('a restock blocked for a free slot puts a small stack of mined blocks back into dug cells and retries', async () => {
  const f = fixture()
  f.sim.give('cobblestone', 2)
  f.config.yTop = 63 // the stand's layer is inside the excavated range
  assert.equal(f.job.plan(f.config).ready, true)
  await f.job.configureSupplies()
  f.setBehavior('room')
  const first = await f.job.restockSuppliesNow()
  assert.notEqual(first.pauseReason, 'SUPPLY_RESTOCK_BLOCKED', 'room was made instead of pausing as blocked')
  // The running job re-enters RESTOCK by itself; the manual entry is called again here.
  const result = await f.job.restockSuppliesNow()
  assert.equal(result.supplyResult.status, 'completed', JSON.stringify(result.supplyResult))
  assert.equal(f.requests.length, 2, 'the same restock was retried once')
  assert.equal(f.sim.state.inventory.items.filter(i => i.name === 'minecraft:cobblestone').length, 0, 'the stack was placed')
  const placed = f.job.document().actions.filter(a => a.purpose === 'supply_room' && a.status === 'confirmed')
  assert.equal(placed.length, 2)
  assert.equal(result.ledger.placedTemporary, 2)
})

test('live case 2026-11-11: a supply site refused before anything was placed starts over with a new site; after a placement it still pauses', async () => {
  const f = fixture()
  assert.equal(f.job.plan(f.config).ready, true)
  await f.job.configureSupplies()
  f.setBehavior('site')
  const first = await f.job.restockSuppliesNow()
  assert.notEqual(first.pauseReason, 'SUPPLY_RESTOCK_BLOCKED', 'the untouched site refusal was not a pause')
  assert.equal(f.job.document().supplyRestock.checkpoint, null, 'started over from the beginning')
  const result = await f.job.restockSuppliesNow()
  assert.equal(result.supplyResult.status, 'completed', JSON.stringify(result.supplyResult))
  assert.equal(f.requests.length, 2)

  const g = fixture()
  assert.equal(g.job.plan(g.config).ready, true)
  await g.job.configureSupplies()
  g.setBehavior('placed-site')
  const blocked = await g.job.restockSuppliesNow()
  assert.equal(blocked.pauseReason, 'SUPPLY_RESTOCK_BLOCKED')
  assert.equal(g.requests.length, 1)
})

test('live case 2026-11-11: a stack larger than eight (ten diorite) is put back to free a slot; reserves stay intact', async () => {
  const f = fixture()
  f.sim.give('diorite', 10)
  f.config.yTop = 63 // the stand's layer is inside the excavated range
  assert.equal(f.job.plan(f.config).ready, true)
  await f.job.configureSupplies()
  const dirtBefore = f.sim.state.inventory.items.filter(i => i.name === 'minecraft:dirt').reduce((n, i) => n + i.count, 0)
  f.setBehavior('room')
  const first = await f.job.restockSuppliesNow()
  assert.notEqual(first.pauseReason, 'SUPPLY_RESTOCK_BLOCKED')
  assert.equal(f.sim.state.inventory.items.filter(i => i.name === 'minecraft:diorite').length, 0, 'the whole stack was placed')
  const placed = f.job.document().actions.filter(a => a.purpose === 'supply_room' && a.status === 'confirmed')
  assert.equal(placed.length, 10)
  assert.ok(placed.every(a => a.confirmedBy === 'server_block_and_inventory'))
  assert.equal(f.sim.state.inventory.items.filter(i => i.name === 'minecraft:dirt').reduce((n, i) => n + i.count, 0), dirtBefore, 'no dirt from the exit and seal reserve was used')
})
