'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')

const BOX = { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 }
const upper = { x: 7, y: 62, z: 7 }
const current = { x: 7, y: 61, z: 9 }
const positionKey = p => `${p.x},${p.y},${p.z}`

function fixture () {
  const sim = createSim({ loaded: BOX })
  flatTerrain(sim, { x1: BOX.xMin, x2: BOX.xMax, z1: BOX.zMin, z2: BOX.zMax, bedrock: 50, stoneTop: 60, top: 62 })
  sim.world.set(-4, 63, -4, 'chest'); sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const config = { jobId: 'resume_layer', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 61, worldMinY: 50, worldMaxY: 70, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 }, stand: { x: -3, y: 63, z: -4 } }] } }
  const options = { adapter: sim.adapter, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 }
  const planned = createQuarryJob(options)
  assert.equal(planned.plan(config).ready, true)
  const saved = planned.document()
  sim.world.fill(0, 61, 0, 15, 62, 15, 'air')
  sim.world.set(0, 62, 0, 'grass_block'); sim.world.set(1, 61, 0, 'dirt') // kept stair
  sim.world.set(upper.x, upper.y, upper.z, 'grass_block')
  sim.world.set(current.x, current.y, current.z, 'dirt')
  Object.assign(saved, {
    state: 'PAUSED', pauseReason: 'PROCESS_RESTARTED', userRunIntent: 'running', deepestY: 61, cursorY: 61, lastMineY: 61,
    scope: JSON.stringify([sim.state.profile, sim.state.realm.id, sim.state.dimension, sim.state.connectionId, sim.state.startedAt]),
    life: sim.state.lifecycle.deathId
  })
  saved.records.deferred = {
    [positionKey(upper)]: { name: 'minecraft:grass_block', reason: 'UNREACHABLE' },
    [positionKey(current)]: { name: 'minecraft:dirt', reason: 'UNREACHABLE' }
  }
  const levels = []
  const mine = sim.adapter.mine
  sim.adapter.mine = async (targets, opts) => { levels.push(...targets.map(t => t.y)); return mine(targets, opts) }
  return { sim, saved, levels, planned, options, load: extra => { const job = createQuarryJob({ ...options, ...extra }); job.load(saved); return job } }
}

async function until (predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Quarry regression test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

async function stopped (job) {
  await until(() => ['PAUSED', 'FINISHED'].includes(job.status().state))
  await job.drain()
  return job.status()
}

function assertUpperKept (f, job, status) {
  assert.equal(f.sim.world.name(current.x, current.y, current.z), 'air', 'current-layer unreachable work was retried')
  assert.equal(f.sim.world.name(upper.x, upper.y, upper.z), 'grass_block', 'an earlier-layer leftover remains untouched')
  assert.ok(f.levels.length > 0)
  assert.ok(f.levels.every(y => y <= 61), `mining moved above the saved work floor: ${f.levels}`)
  assert.equal(job.document().cursorY, 61)
  assert.equal(job.document().deepestY, 61)
  assert.ok(job.document().records.deferred[positionKey(upper)], 'the leftover is still recorded')
  assert.equal(status.pauseReason, 'UNRESOLVED_EXCEPTIONS', 'leftovers are not silently completed')
}

test('loaded resume keeps old upper UNREACHABLE while retrying the current layer', async () => {
  const f = fixture(); const job = f.load()
  job.resume()
  try { assertUpperKept(f, job, await stopped(job)) } finally { await job.pause() }
})

test('final-check retries current-layer UNREACHABLE without resetting the mining cursor to yTop', async () => {
  const f = fixture(); const logs = []; const job = f.load({ log: line => logs.push(line) })
  // start on a loaded paused document keeps the pending deferrals until the
  // final retry; unlike resume(), it does not first reconcile them away.
  job.start()
  try {
    assertUpperKept(f, job, await stopped(job))
    assert.ok(logs.some(line => line.includes('unreachable_retry')))
  } finally { await job.pause() }
})

test('an older saved lastMineY cannot reopen an earlier layer at the next layer-end retry', async () => {
  const f = fixture(); f.saved.lastMineY = 62; const job = f.load()
  job.resume()
  try { assertUpperKept(f, job, await stopped(job)) } finally { await job.pause() }
})

test('legacy restoration respects the configured bottom and stops depth inference at unknown terrain', async () => {
  const f = fixture(); delete f.saved.deepestY
  f.sim.world.fill(0, 50, 0, 15, 60, 15, 'air')
  f.sim.unknown.add('9,61,9')
  const job = f.load()
  job.resume()
  try {
    const status = await stopped(job)
    assert.equal(job.document().deepestY, 61)
    assert.equal(job.document().cursorY, 61)
    assert.equal(status.pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(f.levels.length, 0)
  } finally { await job.pause() }
})

test('same-life partial server-confirmed mining advances the work floor before a manual pause', async () => {
  const f = fixture()
  f.sim.world.set(upper.x, upper.y, upper.z, 'air')
  let started = false
  f.sim.adapter.mine = (targets, { signal }) => new Promise((resolve, reject) => {
    const t = targets[0]
    f.sim.world.set(t.x, t.y, t.z, 'air')
    signal.addEventListener('abort', () => reject(new Error('manual pause')), { once: true })
    started = true
  })
  f.planned.start()
  try {
    await until(() => started)
    await f.planned.pause()
    assert.equal(f.planned.status().ledger.minedBlocks, 1)
    assert.equal(f.planned.document().deepestY, 61)
    assert.equal(f.planned.document().cursorY, 61)
  } finally { await f.planned.pause() }
})

test('combat recovery and an outside travel rebind keep the saved mining floor', async () => {
  const f = fixture(); const logs = []; let clock = 1000; let interrupted = false
  delete f.saved.records.deferred[positionKey(current)]
  f.sim.hooks.beforeMine = () => { if (!interrupted) { interrupted = true; f.sim.setCombat(true) } }
  const job = f.load({ now: () => clock, log: line => logs.push(line) })
  job.start()
  try {
    await until(() => job.status().state === 'COMBAT')
    f.sim.setFeet({ x: 19, y: 63, z: 5 }) // outside the original x<=17 travel box
    f.sim.setCombat(false)
    await until(() => job.status().state === 'COMBAT_SETTLE' && job.status().combat.settle?.remainingMs != null)
    clock += 4000
    assertUpperKept(f, job, await stopped(job))
    assert.ok(logs.some(line => line.includes('combat_resume')))
    assert.ok(logs.some(line => line.includes('travel_rebound')))
  } finally { await job.pause() }
})

test('upper protection, ores and unbreakable reasons survive while fluids remain explicit leftovers', async () => {
  const f = fixture()
  const cells = [
    { x: 7, y: 62, z: 7, name: 'bedrock', reason: 'UNBREAKABLE', saved: true },
    { x: 9, y: 62, z: 9, name: 'bedrock', reason: 'UNBREAKABLE' },
    { x: 11, y: 62, z: 11, name: 'chest', reason: 'CONTAINER_OR_FACILITY', saved: true },
    { x: 13, y: 62, z: 13, name: 'chest', reason: 'CONTAINER_OR_FACILITY' },
    { x: 12, y: 62, z: 5, name: 'water', reason: 'EARLIER_LAYER_LEFTOVER' },
    { x: 9, y: 62, z: 3, name: 'diamond_ore', reason: 'PROTECTED_ORE' }
  ]
  for (const c of cells) {
    f.sim.world.set(c.x, c.y, c.z, c.name)
    if (c.saved) f.saved.records.deferred[positionKey(c)] = { name: `minecraft:${c.name}`, reason: c.reason }
  }
  const job = f.load(); job.start()
  try {
    const status = await stopped(job)
    const records = job.document().records.deferred
    for (const c of cells) {
      assert.equal(f.sim.world.name(c.x, c.y, c.z), c.name)
      assert.equal(records[positionKey(c)]?.reason, c.reason, positionKey(c))
    }
    assert.equal(status.pauseReason, 'UNRESOLVED_EXCEPTIONS')
    assert.equal(status.pauseDetails.byReason.UNBREAKABLE ?? 0, 0, 'planned exclusions did not become new exceptions')
    assert.equal(status.pauseDetails.byReason.CONTAINER_OR_FACILITY, 2)
    assert.equal(status.ledger.minedBlocks, 1)
    assert.ok(f.levels.every(y => y <= 61))
  } finally { await job.pause() }
})

test('unknown cells in an earlier layer still prevent completion of resumed work', async () => {
  const f = fixture(); f.sim.unknown.add('10,62,10')
  const job = f.load(); job.resume()
  try {
    const status = await stopped(job)
    assert.equal(status.pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(status.pauseDetails.unknown, 1)
    assert.equal(job.document().cursorY, 61)
    assert.ok(f.levels.every(y => y <= 61))
    assert.equal(job.document().records.deferred['10,62,10'], undefined)
  } finally { await job.pause() }
})
