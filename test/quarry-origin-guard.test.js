'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

const top = { x: 7, y: 63, z: 7 }
const k = p => `${p.x},${p.y},${p.z}`
function fixture ({ auto = false, isolated = false, headOutside = false, driftInPlan = false } = {}) {
  const bounds = { xMin: -12, xMax: 28, yMin: 50, yMax: 80, zMin: -12, zMax: 28 }
  const sim = createSim({ loaded: bounds })
  flatTerrain(sim, { x1: bounds.xMin, x2: bounds.xMax, z1: bounds.zMin, z2: bounds.zMax, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.set(top.x, top.y, top.z, 'short_grass')
  sim.setFeet({ x: -3, y: 63, z: isolated ? -5 : 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 10); sim.give('dirt', 224)
  if (isolated) {
    sim.world.fill(-12, 63, -1, 28, 66, -1, 'stone')
    sim.world.set(3, 63, 3, 'future_ore')
  }
  const travel = { xMin: -6, xMax: 20, yMin: 50, yMax: headOutside ? 63 : 70, zMin: isolated ? -8 : 0, zMax: 20 }
  const config = { jobId: 'origin-guard', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 63, yBottom: 61, worldMinY: 50, worldMaxY: 80, permissions: { travelRegion: auto ? null : [travel] }, inventory: { carryOnly: true, minFreeSlots: 1 } }
  const logs = []; let shifted = false
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, sleep: async () => new Promise(resolve => setImmediate(resolve)), log: line => {
    logs.push(line)
    if (driftInPlan && !shifted && line.includes('"to":"PLAN"')) { shifted = true; sim.setFeet({ x: -3, y: 63, z: -7 }) }
  } })
  assert.equal(job.plan(config).ready, true)
  return { sim, job, config, logs }
}
async function until (fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('origin guard test timed out'); await new Promise(resolve => setTimeout(resolve, 3)) } }
function untouched (f) {
  assert.equal(f.sim.stats.mined, 0); assert.equal(f.sim.stats.placements, 0); assert.equal(f.sim.stats.moves, 0)
  assert.equal(Object.keys(f.job.document().records.deferred).length, 0)
  assert.equal(f.job.document().deepestY, 63)
  assert.equal(f.sim.world.name(top.x, top.y, top.z), 'short_grass')
}

test('a pre-start safety escape outside an explicit travel box pauses before any planner deferral or lower-layer work', async () => {
  const f = fixture(); f.sim.setFeet({ x: -3, y: 63, z: -7 }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'OUTSIDE_TRAVEL_REGION')
    assert.deepEqual(f.job.status().pauseDetails.feet, { x: -3, y: 63, z: -7 })
    assert.equal(f.job.status().pauseDetails.explicitTravelRegion, true)
    assert.ok(f.logs.some(l => l.includes('travel_rebound_failed')))
    untouched(f)
  } finally { await f.job.pause() }
})

test('the actual planning position is re-read after PLAN callbacks instead of reusing the earlier work snapshot', async () => {
  const f = fixture({ driftInPlan: true }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'OUTSIDE_TRAVEL_REGION'); untouched(f)
  } finally { await f.job.pause() }
})

test('a permitted feet cell with an unpermitted head cell also pauses without classifying a layer', async () => {
  const f = fixture({ headOutside: true }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'OUTSIDE_TRAVEL_REGION')
    assert.deepEqual(f.job.status().pauseDetails.head, { x: -3, y: 64, z: 5 }); untouched(f)
  } finally { await f.job.pause() }
})

test('an unstarted isolated valid origin records only its first unreachable layer and preserves protected exclusions', async () => {
  const f = fixture({ isolated: true }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'INITIAL_LAYER_UNREACHABLE')
    assert.equal(f.job.status().pauseDetails.y, 63)
    const records = f.job.document().records.deferred
    assert.equal(records[k(top)].reason, 'UNREACHABLE')
    assert.equal(records['3,63,3'].reason, 'PROTECTED_ORE')
    assert.ok(Object.keys(records).every(p => Number(p.split(',')[1]) === 63))
    assert.equal(f.sim.stats.mined, 0); assert.equal(f.sim.stats.moves, 0)
    assert.equal(f.sim.world.name(3, 63, 3), 'future_ore')
  } finally { await f.job.pause() }
})

test('start with saved initial UNREACHABLE cannot silently skip it and mine the layer below', async () => {
  const f = fixture(); const document = f.job.document()
  document.state = 'PAUSED'; document.userRunIntent = 'paused'
  document.records.deferred[k(top)] = { reason: 'UNREACHABLE', name: 'minecraft:short_grass' }
  f.job.load(document); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'INITIAL_LAYER_UNREACHABLE')
    assert.equal(Object.keys(f.job.document().records.deferred).length, 1)
    assert.equal(f.sim.stats.mined, 0); assert.equal(f.sim.stats.moves, 0)
    assert.equal(f.sim.world.name(7, 62, 7), 'grass_block')
  } finally { await f.job.pause() }
})

test('an automatic travel region may safely rebind after escape and mine the actual top before any lower target', async () => {
  const f = fixture({ auto: true }); f.sim.setFeet({ x: -3, y: 63, z: -7 })
  const levels = []; f.sim.hooks.beforeMine = target => { levels.push(target.y) }
  f.job.start()
  try {
    await until(() => levels.length || f.job.status().state === 'PAUSED')
    assert.ok(levels.length > 0, JSON.stringify(f.job.status()))
    assert.equal(levels[0], 63)
    assert.ok(f.logs.some(l => l.includes('travel_rebound')))
    assert.equal(f.job.document().records.deferred[k(top)], undefined)
  } finally { await f.job.pause() }
})

test('live case 2026-11-11: unreachable canopy leaves at the top of a new job do not stop it; solid cells still do', async () => {
  for (const name of ['oak_leaves', 'short_grass']) {
    const f = fixture()
    f.sim.world.set(top.x, top.y, top.z, name)
    const document = f.job.document()
    document.state = 'PAUSED'; document.userRunIntent = 'paused'
    document.records.deferred[k(top)] = { reason: 'UNREACHABLE', name: `minecraft:${name}` }
    f.job.load(document); f.job.start()
    try {
      if (name === 'short_grass') {
        await until(() => f.job.status().state === 'PAUSED')
        assert.equal(f.job.status().pauseReason, 'INITIAL_LAYER_UNREACHABLE')
      } else {
        await until(() => f.sim.stats.mined > 0 || f.job.status().state === 'PAUSED')
        assert.notEqual(f.job.status().pauseReason, 'INITIAL_LAYER_UNREACHABLE', 'the leaves did not block the origin')
        assert.ok(f.sim.stats.mined > 0, 'work began below the canopy')
      }
    } finally { await f.job.pause() }
  }
})
