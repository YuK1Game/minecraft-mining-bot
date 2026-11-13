'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob, defaults } = require('../src/quarry-job')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { planQuarryExit, permitsExitAction } = require('../src/quarry-exit-plan')
const { keepPlan, canAccept } = require('../src/quarry-inventory')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture () {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.fill(0, 60, 0, 15, 62, 15, 'air')
  sim.world.set(-4, 63, -4, 'chest')
  sim.setFeet({ x: 15, y: 60, z: 8 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('dirt', 64)
  const config = { jobId: 'pillar-exit', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } }
  const regions = buildRegions({ ...config, travelRegion: [{ xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 }] })
  const planner = createQuarryPlanner({ regions, getBlock: sim.adapter.getBlock, exit: { mode: 'adjacent_pillar' } })
  const args = () => ({ regions, yTop: 62, feet: sim.feet(), getBlock: sim.adapter.getBlock, inventory: sim.adapter.getState().inventory.items, reachable: planner.reachableFrom(sim.feet()), exit: { side: 'east' } })
  const docs = []
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => { docs.push(doc) } }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  return { sim, config, regions, planner, args, docs, job }
}

async function until (predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() > end) throw new Error('exit test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('the new default has no future stair reservation or stair upkeep', async () => {
  assert.equal(defaults().exit.mode, 'adjacent_pillar')
  const { sim, planner } = fixture()
  assert.equal(planner.planStair({ yTop: 62 }), null)
  assert.equal(planner.stairStepAt(60), null)
  sim.world.set(0, 60, 0, 'stone')
  const next = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items, inventoryItems: sim.state.inventory.items })
  assert.notEqual(next.reason, 'STAIR_UNSUPPORTED')
})

test('a paused legacy job migrates without losing depth, ledger, storage, or its frozen upper stair', async () => {
  const { sim, config, job } = fixture()
  sim.world.fill(0, 60, 0, 15, 62, 15, 'stone')
  job.plan({ ...config, exit: { mode: 'legacy_stair' } })
  const saved = job.document()
  delete saved.config.exit
  Object.assign(saved, { state: 'PAUSED', deepestY: 61, cursorY: 61, ledger: { minedBlocks: { stone: 123 } }, pauseReason: 'STAIR_UNSUPPORTED' })
  job.load(saved)
  assert.equal(job.status().egress.mode, 'legacy_stair')
  const before = job.document()
  await job.configureExit({ mode: 'adjacent_pillar' })
  const after = job.document()
  assert.equal(after.deepestY, 61)
  assert.deepEqual(after.ledger, before.ledger)
  assert.deepEqual(after.config.inventory.storage, before.config.inventory.storage)
  assert.equal(after.config.exit.migrationFloorY, 61)
  const planner = createQuarryPlanner({ regions: fixture().regions, getBlock: sim.adapter.getBlock, records: after.records, exit: after.config.exit })
  assert.ok(planner.stairStepAt(62))
  assert.equal(planner.stairStepAt(61), null)
  assert.equal(planner.stairStepAt(60), null)
  assert.equal(after.config.inventory.keepExitDirt, 192)
  await job.configureExit({ migrationFloorY: 60 })
  assert.equal(job.document().config.exit.migrationFloorY, 61, 'the preserved upper-stair boundary cannot drift')
})

test('tool exhaustion pauses at the current layer rather than checking a lower empty stair', async () => {
  const { sim, regions } = fixture()
  sim.world.fill(0, 60, 0, 15, 62, 15, 'stone')
  const pick = sim.state.inventory.items.find(i => i.name === 'minecraft:diamond_pickaxe')
  pick.durabilityRemaining = 1; pick.durabilityUsed = 1560
  const planner = createQuarryPlanner({ regions, getBlock: sim.adapter.getBlock })
  planner.planStair({ yTop: 62 })
  sim.world.set(1, 60, 0, 'air')
  const next = await planner.next({ feet: sim.feet(), yTop: 62, tools: sim.state.inventory.items, inventoryItems: sim.state.inventory.items })
  assert.equal(next.reason, 'WAITING_FOR_TOOL')
  assert.equal(next.details.y, 62)
  assert.ok(next.details.cells > 0)
})

test('exit dirt is retained across stacks separately from ordinary seal material', () => {
  const inv = [{ slot: 0, name: 'minecraft:stone', count: 64 }, ...[1, 2, 3, 4].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))]
  const p = keepPlan(inv, { keepSealBlocks: 32, keepExitDirt: 192 })
  assert.equal(p.keep.get(0), 32)
  assert.equal([1, 2, 3].reduce((n, slot) => n + p.keep.get(slot), 0), 192)
  assert.ok(p.deposits.some(i => i.slot === 4 && i.count === 64))
})

test('ordinary sealing does not spend the dirt reserved for the final exit', async () => {
  const { sim, regions } = fixture()
  sim.give('dirt', 128)
  sim.world.set(10, 60, 10, 'water')
  let planner = createQuarryPlanner({ regions, getBlock: sim.adapter.getBlock, exit: { mode: 'adjacent_pillar', reservedDirt: 192 } })
  let next = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items, inventoryItems: sim.state.inventory.items })
  assert.equal(next.reason, 'SEAL_MATERIAL_MISSING')
  sim.give('cobblestone', 16)
  planner = createQuarryPlanner({ regions, getBlock: sim.adapter.getBlock, exit: { mode: 'adjacent_pillar', reservedDirt: 192 } })
  next = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items, inventoryItems: sim.state.inventory.items })
  assert.equal(next.action, 'seal')
  assert.equal(next.material, 'minecraft:cobblestone')
})

test('a bounded east shaft includes jump headroom, a separate landing, capacity and tool budget', () => {
  const { args } = fixture()
  const r = planQuarryExit(args())
  assert.equal(r.ok, true, JSON.stringify(r))
  const p = r.plan
  assert.deepEqual(p.column, { x: 16, z: 0 })
  assert.deepEqual(p.entry, { x: 15, y: 60, z: 0 })
  assert.deepEqual(p.startFeet, { x: 16, y: 60, z: 0 })
  assert.deepEqual(p.landing, { x: 17, y: 63, z: 0 })
  assert.equal(p.requiredDirt, 3)
  assert.equal(p.totalDirt, 11)
  assert.equal(p.clearTopY, 65)
  assert.ok(p.shaftCells.length > 0)
  assert.ok(p.toolUses.some(use => use.count > 0))
  assert.equal(permitsExitAction(p, 'break', { x: 16, y: 65, z: 0 }), true)
  assert.equal(permitsExitAction(p, 'break', { x: 17, y: 62, z: 0 }), false)
  assert.equal(permitsExitAction(p, 'place', { x: 16, y: 63, z: 0 }), false)
  assert.equal(permitsExitAction(p, 'travel', p.landing), true)
})

test('unknown terrain, fluids, falling blocks and protected cells reject every unsafe shaft', () => {
  for (const name of ['unknown', 'water', 'gravel', 'chest']) {
    const { sim, args } = fixture()
    for (let z = 0; z < 16; z++) { if (name === 'unknown') sim.unknown.add(`16,61,${z}`); else sim.world.set(16, 61, z, name) }
    const r = planQuarryExit(args())
    assert.equal(r.reason, 'EXIT_COLUMN_UNAVAILABLE', name)
    assert.equal(r.details.attempts.length, 16)
  }
})

test('candidate selection skips a gravel column and requires a genuine adjacent landing', () => {
  const { sim, args } = fixture()
  sim.world.set(16, 61, 0, 'gravel')
  const r = planQuarryExit(args())
  assert.equal(r.ok, true)
  assert.ok(r.plan.column.z >= 2, 'the falling neighbour also excludes the adjoining shaft')
  // Remove the lower ground as well, so there is no landing above the
  // bottom of the shaft. An open lower surface is a valid landing.
  for (let z = 0; z < 16; z++) sim.world.fill(17, 60, z, 17, 90, z, 'air')
  assert.equal(planQuarryExit(args()).reason, 'EXIT_COLUMN_UNAVAILABLE')
})

test('received bedrock can support the exit without permission to mine it', () => {
  const { sim, args } = fixture()
  sim.world.fill(0, 59, 0, 17, 59, 15, 'bedrock')
  const r = planQuarryExit(args())
  assert.equal(r.ok, true)
  assert.equal(r.plan.shaftCells.some(c => c.position.y === 59), false)
})

test('shaft resources are checked against real dirt, tool reserve and worst-case drop slots', () => {
  const { args } = fixture()
  let a = args()
  a.inventory = a.inventory.filter(i => i.name !== 'minecraft:dirt')
  const material = planQuarryExit(a)
  assert.equal(material.reason, 'EXIT_MATERIAL_MISSING')
  assert.equal(material.plan.totalDirt, 11, 'reports the actual plan, not the 192 estimate')
  a = args()
  a.inventory.find(i => i.name === 'minecraft:diamond_pickaxe').durabilityRemaining = 2
  assert.equal(planQuarryExit(a).reason, 'EXIT_TOOL_MISSING')
  a = args()
  a.inventory = [a.inventory[0], { slot: 1, name: 'minecraft:dirt', count: 64 }, ...Array.from({ length: 28 }, (_, i) => ({ slot: i + 2, name: 'minecraft:bow', count: 1 }))]
  assert.equal(canAccept(a.inventory, [{ name: 'minecraft:cobblestone', count: 1 }]), true)
  assert.equal(planQuarryExit(a).reason, 'EXIT_INVENTORY_CAPACITY')
  // Storage exhausted under the passive dig-through policy: the shaft drops are left behind.
  const leave = planQuarryExit({ ...a, allowFullBag: true })
  assert.equal(leave.ok, true, JSON.stringify(leave.reason))
})

function completeExit (sim, request) {
  sim.setFeet(request.plan.landing)
  return { status: 'completed', serverConfirmed: true, checkpoint: { jobId: request.jobId, operationId: request.operationId, stage: 'completed' } }
}

test('mining and final storage complete before egress, and surface return is recorded separately', async () => {
  const { sim, job, config } = fixture()
  let called = false
  sim.adapter.egress = async request => { called = true; assert.ok(job.document().miningCompletedAt); assert.equal(job.document().finalDeposited, true); return completeExit(sim, request) }
  assert.equal(job.plan(config).ready, true)
  job.start()
  try {
    await until(() => ['FINISHED', 'PAUSED'].includes(job.status().state))
    assert.equal(job.status().state, 'FINISHED', JSON.stringify(job.status().pauseDetails))
    assert.equal(called, true)
    assert.equal(job.status().egress.surfaceReturned, true)
  } finally { await job.pause() }
})

test('with automatic acceptance off, exceptions are presented after surface return without accepting them', async () => {
  const { sim, job, config } = fixture()
  sim.world.set(5, 60, 5, 'chest')
  sim.adapter.egress = async request => completeExit(sim, request)
  assert.equal(job.plan({ ...config, strategy: { ...(config.strategy ?? {}), autoAcceptFinalExceptions: false } }).ready, true)
  job.start()
  try {
    await until(() => job.status().state === 'PAUSED')
    assert.equal(job.status().pauseReason, 'UNRESOLVED_EXCEPTIONS')
    assert.equal(job.status().egress.surfaceReturned, true)
    assert.equal(job.document().acceptedExceptions, undefined)
  } finally { await job.pause() }
})

// 2026-11-13 17:46 user instruction: unattended to the surface. After the
// return, the remaining exceptions are accepted and recorded, then FINISHED.
test('by default the remaining exceptions are accepted after surface return and recorded', async () => {
  const { sim, job, config } = fixture()
  sim.world.set(5, 60, 5, 'chest')
  sim.adapter.egress = async request => completeExit(sim, request)
  assert.equal(job.plan(config).ready, true)
  job.start()
  try {
    await until(() => ['FINISHED', 'PAUSED'].includes(job.status().state))
    const s = job.status()
    assert.equal(s.state, 'FINISHED', JSON.stringify(s.pauseReason))
    assert.equal(s.result.type, 'COMPLETED_WITH_EXCEPTIONS')
    const rec = job.document().acceptedExceptionRecord
    assert.equal(rec.by, 'auto'); assert.ok(rec.count >= 1); assert.ok(rec.items.some(i => /5,60,5/.test(i.position)))
    assert.equal(s.acceptedExceptions.count, rec.count)
  } finally { await job.pause() }
})

test('manual stop during egress resumes the saved operation instead of returning underground', async () => {
  const { sim, job, config } = fixture()
  const requests = []
  sim.adapter.egress = async (request, { signal, onCheckpoint }) => {
    requests.push(request)
    if (requests.length > 1) return completeExit(sim, request)
    await onCheckpoint({ jobId: request.jobId, operationId: request.operationId, stage: 'at_safe_step', placed: [] })
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  job.plan(config); job.start()
  try {
    await until(() => job.document().egress?.checkpoint?.stage === 'at_safe_step')
    await job.pause()
    await assert.rejects(job.configureExit({ mode: 'legacy_stair' }), /cannot be replaced/)
    job.resume()
    await until(() => ['FINISHED', 'PAUSED'].includes(job.status().state))
    assert.equal(job.status().state, 'FINISHED')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].operationId, requests[1].operationId)
    assert.equal(requests[1].checkpoint.stage, 'at_safe_step')
  } finally { await job.pause() }
})

test('unconfirmed exit results stay paused without ACTION_FAILED automatic retries', async () => {
  const { sim, job, config } = fixture()
  sim.adapter.egress = async request => ({ status: 'blocked', reason: 'EXIT_POSITION_UNCONFIRMED', serverConfirmed: false, checkpoint: { jobId: request.jobId, operationId: request.operationId, stage: 'uncertain' } })
  job.plan(config); job.start()
  try {
    await until(() => job.status().state === 'PAUSED')
    assert.equal(job.status().pauseReason, 'EXIT_POSITION_UNCONFIRMED')
    assert.equal(job.status().egress.surfaceReturned, false)
    assert.equal(job.document().autoResumes ?? 0, 0)
  } finally { await job.pause() }
})

test('a different life cannot resume the saved exit even when ordinary resume binds to that life', async () => {
  const { sim, job, config } = fixture()
  let calls = 0
  sim.adapter.egress = async request => { calls++; return { status: 'blocked', reason: 'EXIT_POSITION_UNCONFIRMED', serverConfirmed: false, checkpoint: { jobId: request.jobId, operationId: request.operationId, stage: 'uncertain' } } }
  job.plan(config); job.start()
  try {
    await until(() => job.status().state === 'PAUSED')
    sim.state.lifecycle.deathId++
    job.resume()
    await until(() => job.status().state === 'PAUSED')
    assert.equal(job.status().pauseReason, 'EXIT_SCOPE_CHANGED')
    assert.equal(calls, 1)
  } finally { await job.pause() }
})
