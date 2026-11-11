'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planQuarryExit, permitsExitAction } = require('../src/quarry-exit-plan')
const { buildRegions } = require('../src/quarry-region')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim } = require('./helpers/quarry-sim')

// Synthetic received terrain, not a recording of the user's Realm.
function fixture ({ bottom = -64, bedrockTop = -60, dug = false, patch = () => null } = {}) {
  const regions = buildRegions({ target: { chunks: [{ x: -2, z: 1 }] }, yBottom: bottom, yTop: 85 })
  const calls = []
  function getBlock (x, y, z) {
    calls.push({ x, y, z })
    if (y < -64 || y > 319) return { known: false }
    const override = patch(x, y, z)
    if (override && typeof override === 'object') return override
    const inTarget = regions.columns.has(`${x},${z}`)
    const name = override ?? (y <= bedrockTop ? 'bedrock' : dug && inTarget || y > 85 ? 'air' : y === 85 ? 'grass_block' : 'deepslate')
    return { known: true, name: `minecraft:${name}`, boundingBox: /^(air|water|lava)$/.test(name) ? 'empty' : 'block', runtimeId: name.length, extra: [] }
  }
  const inventory = [0, 1, 2].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))
  inventory.push({ slot: 3, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1561 })
  const args = { regions, getBlock, inventory, feet: { x: -17, y: bedrockTop + 1, z: 17 }, preflight: !dug, exit: { side: 'east' } }
  return { regions, getBlock, calls, args }
}

for (const bedrockTop of [-64, -63, -60, -59]) test(`review: world-min quarry reserves exit above received bedrock Y${bedrockTop}`, () => {
  const f = fixture({ bedrockTop }), before = JSON.stringify(f.regions)
  const result = planQuarryExit(f.args)
  assert.equal(result.ok, true, JSON.stringify(result))
  const p = result.plan
  assert.equal(p.entry.y, bedrockTop + 1)
  assert.equal(p.startFeet.y, bedrockTop + 1)
  assert.equal(p.requiredDirt, p.targetFeetY - p.startFeet.y)
  assert.equal(p.totalDirt, p.requiredDirt + 8)
  assert.equal(f.regions.yBottom, -64, 'the requested excavation depth is not silently reduced')
  assert.equal(JSON.stringify(f.regions), before, 'preflight does not mutate terrain or permissions')
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.calls.every(p => p.y >= -64 && p.y <= 319), 'do not request impossible Y=-65')
  assert.ok(p.shaftCells.every(c => c.position.y > bedrockTop && c.name !== 'minecraft:bedrock'))
  assert.equal(permitsExitAction(p, 'break', { ...p.column, y: bedrockTop }), false)
})

test('review: entry elevation follows uneven bedrock, not a hard-coded -59 floor', () => {
  const f = fixture({ bedrockTop: -64, patch: (x, y, z) => x === -17 && y >= -63 && y <= (-60 + (z % 2)) ? 'bedrock' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.entry.y, -60 + (r.plan.entry.z % 2) + 1)
  assert.equal(r.plan.column.x, -16)
  assert.equal(r.plan.entry.x, -17)
})

test('review: execution still requires actual air and a reachable elevated entrance', () => {
  const f = fixture(), reserved = planQuarryExit(f.args)
  assert.equal(reserved.ok, true)
  assert.equal(planQuarryExit({ ...f.args, preflight: false, reservation: reserved.plan }).ok, false)
  const cut = fixture({ dug: true })
  const reach = new Set([`${reserved.plan.entry.x},${reserved.plan.entry.y},${reserved.plan.entry.z}`])
  const ready = planQuarryExit({ ...cut.args, reachable: reach, reservation: reserved.plan })
  assert.equal(ready.ok, true, JSON.stringify(ready))
  assert.deepEqual(ready.plan.entry, reserved.plan.entry)
  assert.equal(planQuarryExit({ ...cut.args, reachable: new Set(), reservation: reserved.plan }).ok, false)
})

for (const obstacle of ['unknown', 'lava', 'gravel', 'chest', 'bedrock']) test(`review: bedrock-aware exit does not bypass ${obstacle} in its shaft`, () => {
  const f = fixture({ patch: (x, y, z) => x === -16 && y === -50 ? obstacle === 'unknown' ? { known: false } : obstacle : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'EXIT_COLUMN_UNAVAILABLE')
})

test('review: unreceived lower terrain cannot be replaced with a guessed bedrock height', () => {
  const f = fixture({ patch: (x, y, z) => x === -17 && y < -58 ? { known: false } : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.reason, 'EXIT_COLUMN_UNAVAILABLE')
  assert.ok(r.details.attempts.every(a => a.reason === 'ENTRY_UNAVAILABLE' && a.cause === 'UNKNOWN'))
})

test('review: side-wall bedrock is not excavated; explicitly protected bedrock still rejects the shaft', () => {
  const f = fixture({ patch: (x, y, z) => x === -16 && z === 16 && y === -59 ? 'bedrock' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, true)
  assert.equal(r.plan.column.z, 17, 'the neighboring solid wall is harmless; the bedrock column itself is not mineable')
  const blocked = fixture({ patch: (x, y, z) => x === -15 && y === -59 ? { known: true, name: 'minecraft:bedrock', boundingBox: 'block', protected: true, extra: [] } : null })
  assert.equal(planQuarryExit(blocked.args).ok, false)
})

test('review: explicit shallow lower bound keeps the original entry and resource checks', () => {
  const f = fixture({ bottom: -50 }), r = planQuarryExit(f.args)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.entry.y, -50)
  assert.equal(planQuarryExit({ ...f.args, inventory: f.args.inventory.filter(i => i.name !== 'minecraft:dirt') }).reason, 'EXIT_MATERIAL_MISSING')
})

async function until (predicate) {
  const until = Date.now() + 10000
  while (!predicate()) { if (Date.now() > until) throw Error('bounded quarry regression timed out'); await new Promise(r => setTimeout(r, 5)) }
}
for (const how of ['start', 'resume']) test(`review: ${how} of a world-min job uses its reserved raised entry at egress`, async () => {
  const sim = createSim({ loaded: { xMin: -36, xMax: -12, yMin: -64, yMax: -48, zMin: 12, zMax: 36 } })
  sim.world.fill(-36, -64, 12, -12, -60, 36, 'bedrock')
  sim.world.fill(-36, -59, 12, -12, -58, 36, 'deepslate')
  // All excavation cells except one have already been observed cleared.
  sim.world.fill(-32, -59, 16, -17, -58, 31, 'air')
  sim.world.set(-18, -59, 18, 'deepslate')
  sim.setFeet({ x: -17, y: -59, z: 18 })
  sim.give('diamond_pickaxe'); sim.give('bread', 20); sim.give('dirt', 192)
  const documents = [], requests = []
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, sleep: () => new Promise(r => setImmediate(r)), storage: { save: async (_id, doc) => { documents.push(doc) } } })
  sim.adapter.egress = async request => {
    requests.push(request)
    assert.equal(request.plan.startFeet.y, -59)
    assert.ok(job.document().miningCompletedAt)
    assert.ok(Array.isArray(request.plan.entryPath) && request.plan.entryPath.length)
    assert.equal(sim.stats.mined, 1)
    sim.setFeet(request.plan.landing)
    return { status: 'completed', serverConfirmed: true, checkpoint: { jobId: request.jobId, operationId: request.operationId, phase: 'completed', serverConfirmed: true } }
  }
  const config = { jobId: 'bedrock-exit-lifecycle', target: { chunks: [{ x: -2, z: 1 }] }, yTop: -58, yBottom: -64, worldMinY: -64, worldMaxY: -48, inventory: { carryOnly: true, pickupMode: 'passive', depositWhen: 'full' } }
  assert.equal(job.plan(config).ready, true)
  if (how === 'resume') {
    const old = job.document()
    Object.assign(old, { state: 'PAUSED', pauseReason: 'EXIT_COLUMN_UNAVAILABLE', userRunIntent: 'running' })
    job.load(old); job.resume()
  } else job.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(job.status().state))
    await job.drain()
    assert.equal(requests.length, 1, JSON.stringify(job.status()))
    assert.equal(job.status().egress.surfaceReturned, true)
    assert.equal(job.document().config.yBottom, -64)
    assert.ok(documents.some(d => d.exitReservation?.plan?.entry.y === -59))
    assert.equal(sim.world.name(-17, -60, 16), 'bedrock')
    assert.equal(job.document().acceptedExceptions, undefined, 'no automatic exception acceptance')
    assert.equal(job.status().state, 'FINISHED')
  } finally { await job.pause() }
})

for (const side of ['east', 'west', 'north', 'south']) test(`review: world-min ${side} exit obeys the selected boundary`, () => {
  const f = fixture(), r = planQuarryExit({ ...f.args, exit: { side } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.side, side)
  assert.equal(r.plan.startFeet.y, -59)
  assert.equal(f.regions.columns.has(`${r.plan.column.x},${r.plan.column.z}`), false)
  assert.equal(f.regions.columns.has(`${r.plan.entry.x},${r.plan.entry.z}`), true)
})
test('review: void below the quarry is not treated as a bedrock floor', () => {
  const f = fixture({ bedrockTop: -65 })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.ok(r.details.attempts.every(a => a.cause === 'OUTSIDE_WORLD_HEIGHT'))
  assert.ok(f.calls.every(p => p.y >= -64))
})

test('review (2026-11-10): an ore in the exit shaft is dug with a pickaxe instead of losing the column', () => {
  const f = fixture({ patch: (x, y, z) => x === -16 && y === -50 ? 'diamond_ore' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, true, JSON.stringify(r.reason))
  const ore = r.plan.shaftCells.find(c => /diamond_ore/.test(c.name))
  if (ore) assert.equal(ore.requiredTool?.kind, 'pickaxe')
  const { exitDigRule } = require('../src/quarry-exit-plan')
  assert.equal(exitDigRule('minecraft:diamond_ore').kind, 'dig')
  assert.equal(exitDigRule('minecraft:deepslate_iron_ore').tier, 2)
  assert.equal(exitDigRule('minecraft:ancient_debris').kind, 'dig', 'registered ancient debris is harvestable')
  assert.equal(exitDigRule('minecraft:chest').kind, 'protected')
})
