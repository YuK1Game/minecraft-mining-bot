'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { serialize } = require('node:v8')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { buildRegions, permits } = require('../src/quarry-region')
const { supplyPlacementAllowed } = require('../src/quarry-supply-site')
const { supplyScope } = require('../src/quarry-supplies')
const { carriedContainerKey } = require('../src/quarry-inventory')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createSim } = require('./helpers/quarry-sim')
const { supplySitePreview } = require('./helpers/supply-site-preview')
const copy = value => structuredClone(value)
const home = { position: { x: -94, y: 97, z: -47 }, other: { x: -93, y: 97, z: -47 }, stand: { x: -95, y: 97, z: -47 }, stage: { x: -96, y: 97, z: -47 }, chunk: { x: -6, z: -3 } }
const geometry = { target: { chunks: [home.chunk] }, yTop: 75, yBottom: -59, travelRegion: [{ xMin: -98, xMax: -79, yMin: -59, yMax: 101, zMin: -50, zMax: -31 }] }

function completedLoadout (jobId, state) {
  const plan = Array.from({ length: 34 }, (_, index) => ({ from: index, to: index, name: 'minecraft:received_fixture_item', count: 1 }))
  const world = JSON.stringify([state.profile, String(state.realm.id), state.dimension]), operationId = jobId + ':loadout:1'
  return { operationId, checkpoint: { version: 1, direction: 'withdraw', phase: 'completed', jobId, operationId, position: copy(home.position), world,
    life: JSON.stringify([world, state.lifecycle.deathId]), index: 34, plan, receipts: copy(plan), intent: null,
    identities: plan.map((_, i) => serialize({ network_id: i + 1, count: 1, metadata: 0, has_stack_id: true, stack_id: i + 10, block_runtime_id: 0 }).toString('base64')) } }
}

function fixture (options = {}) {
  const sim = createSim({ loaded: { xMin: -100, xMax: -78, yMin: -64, yMax: 105, zMin: -52, zMax: -28 } })
  sim.world.fill(-100, 96, -52, -78, 96, -28, 'grass_block')
  sim.world.set(home.position.x, 97, home.position.z, 'chest'); sim.world.set(home.other.x, 97, home.other.z, 'chest')
  sim.setFeet(home.stand)
  const registered = copy(home), requests = [], previews = [], saves = []
  const adapter = sim.adapter
  adapter.registeredHomeChest = () => registered
  adapter.loadoutWithdraw = async () => assert.fail('already completed kit must not be withdrawn again')
  adapter.finalChestDeposit = async () => assert.fail('initial supplies must not finalize the job')
  adapter.equipmentTransfer = async () => assert.fail('site selection sends no equipment move')
  const preview = supplySitePreview(adapter)
  adapter.previewSupplySite = (stand, settings) => { previews.push(copy(stand)); return preview(stand, settings) }
  adapter.restockSupplies = async request => { requests.push(request); return { status: 'blocked', serverConfirmed: false, reason: 'TEST_SUPPLY_REACHED' } }
  const job = createQuarryJob({ adapter, storageMode: 'shulker', pollMs: 5, sleep: () => turn(), storage: { save: async (_id, doc) => { saves.push(copy(doc)); options.onSave?.(doc, sim) } } })
  const config = { jobId: 'initial-home-supply', target: copy(geometry.target), yTop: 75, yBottom: -59, allowCaves: true, homeChest: copy(home), inventory: { pickupMode: 'active', depositWhen: 'four_layers' } }
  assert.equal(job.plan(config).ready, true)
  const roles = ['pickaxe', 'shovel', 'dirt', 'totem'], items = ['diamond_pickaxe', 'diamond_shovel', 'dirt', 'totem_of_undying']
  const boxes = ['blue', 'light_blue', 'brown', 'yellow'].map((color, i) => { sim.give(color + '_shulker_box', 1, { stackId: 100 + i }); return sim.state.inventory.items.at(-1) })
  sim.give('bread', 64)
  const doc = job.document()
  Object.assign(doc, { state: 'PAUSED', pauseReason: 'SUPPLY_RESTOCK_BLOCKED', loadoutReady: true, loadout: completedLoadout(config.jobId, sim.state),
    supplyRestock: { operationId: config.jobId + ':supplies:1', checkpoint: null, resumeTo: 'SURVEY' } })
  doc.config.inventory.supplyBoxes = roles.map((role, i) => ({ role, itemName: 'minecraft:' + items[i], key: carriedContainerKey(boxes[i]), boxName: boxes[i].name, stackId: boxes[i].stackId }))
  options.mutate?.(doc, registered, sim)
  job.load(doc)
  const run = async () => {
    job.resume()
    const until = Date.now() + 7000
    while (job.status().state !== 'PAUSED') { if (Date.now() > until) throw Error('bounded home supply test timed out'); await turn() }
    await job.pause()
  }
  return { sim, job, doc, registered, requests, previews, saves, run }
}

test('v2.2 received kit stages initial supplies at registered Y97 while the ordinary mining cap remains Y75', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.requests.length, 1, JSON.stringify(f.job.status().pauseDetails))
  assert.equal(f.requests[0].operationId, f.doc.supplyRestock.operationId)
  const preview = f.sim.adapter.previewSupplySite(home.stand, { canPlace: f.requests[0].canPlace })
  assert.equal(preview.ready, true, JSON.stringify(preview)); assert.deepEqual(preview.positions, [home.stage])
  assert.equal(f.sim.stats.placements, 0, 'planning did not send a placement')
  assert.equal(f.sim.stats.mineCalls, 0, 'the station cannot authorize above-cap terrain clearance')
  for (const p of [home.stage, home.stand, { ...home.stage, y: 96 }, { ...home.stage, y: 98 }, { ...home.stage, x: -97 }]) {
    const ordinary = buildRegions(geometry)
    assert.equal(permits(ordinary, 'break', p).allowed, false)
    assert.equal(permits(ordinary, 'place', p).allowed, false)
    assert.equal(f.requests[0].canPlace(p), p.y === 97 && [home.stand.x, home.stage.x].includes(p.x))
  }
  assert.equal(f.job.document().yTop, 75); assert.equal(f.job.document().config.yBottom, -59)
})

for (const mode of ['notReady', 'incomplete', 'intent', 'identityMissing', 'receiptMissing', 'job', 'operation', 'world', 'life', 'position', 'registered', 'stageMissing', 'mined', 'remined']) {
  test(`v2.2 initial station exception rejects ${mode} evidence`, async () => {
    const f = fixture({ mutate: (doc, registered) => {
      const cp = doc.loadout.checkpoint
      if (mode === 'notReady') doc.loadoutReady = false
      if (mode === 'incomplete') cp.phase = 'armor'
      if (mode === 'intent') cp.intent = { index: 33 }
      if (mode === 'identityMissing') cp.identities.pop()
      if (mode === 'receiptMissing') cp.receipts.pop()
      if (mode === 'job') cp.jobId = 'other-job'
      if (mode === 'operation') cp.operationId = 'other-operation'
      if (mode === 'world') cp.world = '["bot","other-realm","overworld"]'
      if (mode === 'life') cp.life = JSON.stringify([cp.world, 1])
      if (mode === 'position') cp.position.x--
      if (mode === 'registered') registered.stage.x--
      if (mode === 'stageMissing') delete doc.config.homeChest.stage
      if (mode === 'mined') doc.ledger.minedBlocks = { 'minecraft:stone': 1 }
      if (mode === 'remined') doc.ledger.reminedTemporary = { 'minecraft:dirt': 1 }
      // Keep preflight past kit work while testing the permit's ready gate.
      if (mode === 'notReady') { doc.scope = JSON.stringify([doc.world.profile, doc.world.realmId, doc.world.dimension, 'c1', 't0']); doc.life = 0 }
    } })
    await f.run()
    assert.equal(f.requests.length, 0)
    assert.equal(f.sim.stats.placements, 0); assert.equal(f.sim.stats.mineCalls, 0)
  })
}

for (const obstacle of ['unknown', 'occupied', 'water', 'protected', 'moved', 'scope']) test(`registered home supply rejects ${obstacle} stage without clearing terrain`, async () => {
  let changed = false
  const f = fixture({ mutate: (doc, _registered, sim) => {
    if (obstacle === 'unknown') sim.unknown.add('-96,97,-47')
    if (obstacle === 'occupied') sim.world.set(-96, 97, -47, 'stone')
    if (obstacle === 'water') sim.world.set(-96, 97, -47, 'water')
    if (obstacle === 'protected') doc.config.permissions.protectedRegion.push({ xMin: -96, xMax: -96, yMin: 97, yMax: 98, zMin: -47, zMax: -47 })
  }, onSave: (doc, sim) => {
    if (obstacle === 'moved' && !changed && doc.supplyRestock?.approach?.phase === 'planned') { changed = true; sim.world.set(-96, 97, -47, 'stone') }
    if (obstacle === 'scope' && !changed && doc.supplyRestock?.approach?.phase === 'planned') { changed = true; sim.state.realm.id = 'other-realm' }
  } })
  await f.run()
  assert.equal(f.requests.length, 0)
  assert.equal(f.sim.stats.placements, 0); assert.equal(f.sim.stats.mineCalls, 0)
})

test('station exception never overrides protected, exit-reserved or missing body travel permissions', () => {
  const station = { stand: home.stand, stage: home.stage }
  for (const kind of ['protected', 'exit', 'exitHead', 'travel']) {
    const regions = buildRegions({ ...geometry, ...(kind === 'protected' ? { protectedRegion: [{ xMin: -96, xMax: -96, yMin: 97, yMax: 98, zMin: -47, zMax: -47 }] } : {}), ...(kind === 'travel' ? { travelRegion: [] } : {}) })
    if (kind === 'exit') regions.exitReservation = { column: { x: -96, z: -47 }, startFeet: { y: 96 }, clearTopY: 99, landing: { x: -97, y: 97, z: -47 } }
    if (kind === 'exitHead') regions.exitReservation = { column: { x: -96, z: -47 }, startFeet: { y: 99 }, clearTopY: 100, landing: { x: -97, y: 100, z: -47 } }
    assert.equal(supplyPlacementAllowed(regions, home.stage, station), false, kind)
  }
})

test('an existing supply child keeps its checkpoint and never searches for a new registered site', async () => {
  const f = fixture({ mutate: (doc, _registered, sim) => {
    doc.supplyRestock.checkpoint = { scope: supplyScope(sim.state), child: { stage: 'placed', marker: 'existing-owned-box' } }
  } })
  await f.run()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].checkpoint.child.marker, 'existing-owned-box')
  assert.equal(f.previews.length, 0)
  assert.equal(f.sim.stats.moves, 0)
})

test('registered high supply staging still places, normally mines and recovers only its receipt-owned shulker', async () => {
  const file = require.resolve('./quarry-portable-storage.test.js'), helper = new Module(file, module)
  helper.filename = file; helper.paths = Module._nodeModulePaths(path.dirname(file))
  helper._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item }\n', file)
  const f = helper.exports.fixture('shulker', { full: true })
  f.state.position = { x: -94.5, y: 98.62, z: -46.5 }
  const getBlock = (x, y, z) => copy(f.blocks.get(`${x},${y},${z}`) ?? { known: true, name: y < 97 ? 'minecraft:stone' : 'minecraft:air', runtimeId: y < 97 ? 1 : 0, boundingBox: y < 97 ? 'block' : 'empty', extra: [] })
  const runner = createQuarryPortableStorage({ ...f.dependencies, getBlock, workWithContainer: async context => {
    assert.deepEqual(context.position, home.stage)
    return { status: 'completed', serverConfirmed: true, withdrawn: [], returned: [] }
  } })
  f.controller.ownsShulker = runner.ownsShulker
  const regions = buildRegions(geometry), canPlace = p => supplyPlacementAllowed(regions, p, home)
  const result = await runner.storeCarried({ ...f.request, operationId: 'job:supplies:1:dirt', deposits: [], purpose: 'supply', supply: { binding: { role: 'dirt', itemName: 'minecraft:dirt' } } }, { canPlace, onCheckpoint: async () => {} })
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.recovered, true)
  const placed = f.events.filter(event => event.type === 'place'), mined = f.events.filter(event => event.type === 'mine')
  assert.equal(placed.length, 1); assert.deepEqual(placed[0].position, home.stage)
  assert.equal(mined.length, 1); assert.equal(mined[0].target.accessPreparation, 'owned_shulker')
  assert.equal(permits(regions, 'break', home.stage).allowed, false)
  assert.equal(permits(regions, 'place', home.stage).allowed, false)
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
})

function sequentialPortableFixture ({ movement = null } = {}) {
  const file = require.resolve('./quarry-portable-storage.test.js'), helper = new Module(file, module)
  helper.filename = file; helper.paths = Module._nodeModulePaths(path.dirname(file))
  helper._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item }\n', file)
  const f = helper.exports.fixture('shulker', { full: true, pickupOnMove: true })
  f.bag[15] = helper.exports.item(2, 1, 21)
  f.state.position = { x: -94.5, y: 98.62, z: -46.5 }
  for (const position of [home.position, home.other]) f.blocks.set(`${position.x},${position.y},${position.z}`, { known: true, name: 'minecraft:chest', runtimeId: 301, boundingBox: 'block', extra: [] })
  const regions = buildRegions(geometry), canPlace = p => supplyPlacementAllowed(regions, p, home)
  const getBlock = (x, y, z) => copy(f.blocks.get(`${x},${y},${z}`) ?? { known: true, name: y < 97 ? 'minecraft:stone' : 'minecraft:air', runtimeId: y < 97 ? 1 : 0, boundingBox: y < 97 ? 'block' : 'empty', extra: [] })
  const roles = [], actors = [{ kind: 'mob', runtimeId: 'far-away', positionKnown: true, position: { x: 100, y: 97, z: 100 } }]
  const move = f.dependencies.moveTo
  const runner = createQuarryPortableStorage({ ...f.dependencies, getBlock, getEntities: () => actors,
    moveTo: movement ? position => movement(f, position, move) : move,
    workWithContainer: async context => {
      roles.push(context.request.supply.binding.role)
      assert.deepEqual(context.position, home.stage)
      return { status: 'completed', serverConfirmed: true, withdrawn: [], returned: [] }
    } })
  f.controller.ownsShulker = runner.ownsShulker
  const run = (role, sourceStackId) => {
    const sourceSlot = f.bag.findIndex(raw => raw.network_id === 2 && raw.stack_id === sourceStackId)
    const request = { ...f.request, operationId: `job:supplies:1:${role}`, selection: { kind: 'shulker', key: `undyed_shulker_box:stack:${sourceStackId}`,
      sources: [{ slot: sourceSlot, name: 'minecraft:undyed_shulker_box', count: 1, stackId: sourceStackId }] }, deposits: [], purpose: 'supply', supply: { binding: { role } } }
    return runner.storeCarried(request, { canPlace, onCheckpoint: async cp => { f.checkpoints.push(copy(cp)) } })
  }
  return { ...f, runner, run, roles, actors, canPlace }
}

test('two real portable supply roles recover on stage and walk back before placing the next box', async () => {
  const f = sequentialPortableFixture()
  const first = await f.run('pickaxe', 20)
  assert.equal(first.status, 'completed', first.reason); assert.equal(first.recovered, true)
  assert.deepEqual(f.state.position, { x: -95.5, y: 98.62, z: -46.5 }, 'first pickup leaves the bot in the stage cell')
  const actual = copy(f.state), actors = copy(f.actors), blocks = copy([...f.blocks]), eventCount = f.events.length
  const preview = f.runner.previewSupplySite(home.stand, { canPlace: f.canPlace })
  assert.equal(preview.ready, true, JSON.stringify(preview)); assert.deepEqual(preview.positions, [home.stage])
  assert.deepEqual(f.state, actual); assert.deepEqual(f.actors, actors); assert.deepEqual([...f.blocks], blocks)
  assert.equal(f.events.length, eventCount, 'a proposal sends no movement, placement or inventory action')
  const second = await f.run('shovel', 21)
  assert.equal(second.status, 'completed', second.reason); assert.equal(second.recovered, true)
  assert.deepEqual(f.roles, ['pickaxe', 'shovel'])
  const placed = f.events.filter(event => event.type === 'place'), mined = f.events.filter(event => event.type === 'mine')
  assert.equal(placed.length, 2); assert.ok(placed.every(event => JSON.stringify(event.position) === JSON.stringify(home.stage)))
  assert.equal(mined.length, 2); assert.ok(mined.every(event => event.target.accessPreparation === 'owned_shulker'))
  const secondEvents = f.events.slice(eventCount)
  assert.deepEqual(secondEvents.find(event => event.type === 'move').position, home.stand)
  assert.ok(secondEvents.findIndex(event => event.type === 'move') < secondEvents.findIndex(event => event.type === 'place'))
  assert.notEqual(first.checkpoint.recovered.stackId, second.checkpoint.recovered.stackId)
})

for (const mode of ['blocked', 'unconfirmed', 'actualOverlap']) test(`a proposed stand never bypasses ${mode} actual movement or self-collision checks`, async () => {
  const f = sequentialPortableFixture({ movement: async (f, position) => {
    if (mode === 'blocked') throw new Error('fixture movement blocked')
    if (mode === 'unconfirmed') return { phase: 'completed', serverConfirmed: false }
    // This is within the ordinary arrival tolerance, but the live body still
    // overlaps the box. The execution-time check must retain that distinction.
    f.state.position = { x: position.x + 0.05, y: position.y + 1.62, z: position.z + 0.5 }
    return { phase: 'completed', serverConfirmed: false }
  } })
  f.state.position = { x: -95.5, y: 98.62, z: -46.5 }
  const result = await f.run('shovel', 21)
  assert.equal(result.status, 'blocked')
  assert.equal(f.events.filter(event => event.type === 'place').length, 0)
  assert.equal(f.roles.length, 0)
  if (mode === 'unconfirmed') assert.equal(result.reason, 'STORAGE_STAND_UNCONFIRMED')
  if (mode === 'actualOverlap') assert.equal(result.checkpoint.siteIssue.cause, 'SELF_OCCUPIES_BOX')
})
