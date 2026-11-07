'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { buildRegions } = require('../src/quarry-region')

function fixture ({ config = {}, travel = true } = {}) {
  const source = { x: 0, y: 60, z: 5 }, roof = { x: 0, y: 61, z: 5 }, feet = { x: -1, y: 62, z: 5 }
  const blocks = new Map(); const k = p => `${p.x},${p.y},${p.z}`
  const put = (position, name, depth) => blocks.set(k(position), { known: true, position: { ...position }, name: `minecraft:${name}`, boundingBox: /air|lava|water/.test(name) ? 'empty' : 'block', runtimeId: /lava/.test(name) ? 1000 + depth : 2, properties: depth == null ? {} : { liquid_depth: depth }, extra: [], diggable: !/lava|water/.test(name) })
  put(source, 'lava', 0)
  for (let i = 0; i < 178; i++) put({ x: i % 14, y: 59, z: 5 + Math.floor(i / 14) }, i % 2 ? 'flowing_lava' : 'lava', i === 0 ? 8 : 1)
  put(roof, 'deepslate')
  const read = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y <= 61 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 61 ? 'block' : 'empty', runtimeId: 2, properties: {}, extra: [], diggable: true }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 61, yBottom: 50, worldMinY: 50, worldMaxY: 80, travelRegion: travel ? [{ xMin: -3, xMax: 20, yMin: 50, yMax: 80, zMin: -3, zMax: 20 }] : [] })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }, { slot: 1, name: 'minecraft:cobblestone', count: 64 }]
  const deferred = {}
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (x !== roof.x || z !== roof.z) deferred[`${x},61,${z}`] = { name: 'minecraft:stone', reason: 'PRESERVED_TEST_FLOOR' }
  const make = () => createQuarryPlanner({ regions, getBlock: read, config, records: { deferred }, exit: { mode: 'adjacent_pillar' } })
  const next = (planner, workY = 61, origin = feet) => planner.next({ feet: origin, yTop: workY, tools, inventoryItems: tools })
  return { source, roof, feet, blocks, k, put, read, regions, tools, make, next, records: { deferred } }
}

test('a fully observed 179-cell lava flow with one highest source selects only that permitted source', () => {
  const f = fixture(), p = f.make().sealPlan({ position: { x: 3, y: 59, z: 5 }, lava: true })
  assert.equal(p.ok, true)
  assert.deepEqual(p.position, f.source)
  assert.equal(p.sourceSeal.size, 179)
  assert.equal(p.sourceSeal.cells.length, 179)
  assert.equal(p.sourceSeal.source.expectedName, 'minecraft:lava')
  assert.equal(p.sourceSeal.source.expectedRuntimeId, 1000)
})

test('a covered highest source proposes just its current-layer roof from a dry different column', async () => {
  const f = fixture(), decision = await f.next(f.make())
  assert.equal(decision.action, 'mine', JSON.stringify(decision))
  assert.equal(decision.reason, 'FLUID_SOURCE_ACCESS')
  assert.equal(decision.targets.length, 1)
  assert.deepEqual(decision.targets[0].position, f.roof)
  assert.equal(decision.targets[0].accessPreparation, 'quarry_fluid_roof')
  assert.deepEqual(decision.targets[0].fluidSource.position, f.source)
  assert.deepEqual(decision.stance, f.feet)
  assert.equal(decision.travel, 0)
})

test('after received roof air, a normal front-facing placement plugs the source once', async () => {
  const f = fixture(); f.put(f.roof, 'air')
  const decision = await f.next(f.make())
  assert.equal(decision.action, 'seal', JSON.stringify(decision))
  assert.deepEqual(decision.position, f.source)
  assert.equal(decision.sourceSeal.size, 179)
  const eye = { x: decision.stance.x + 0.5, y: decision.stance.y + 1.62, z: decision.stance.z + 0.5 }
  const normals = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
  const n = normals[decision.face]
  assert.ok((eye.x - decision.point.x) * n.x + (eye.y - decision.point.y) * n.y + (eye.z - decision.point.z) * n.z > 0)
})

test('a clicked roof underside is never accepted from an eye above that face', async () => {
  const f = fixture({ config: { largeFluidCells: 512 } })
  const decision = await f.next(f.make())
  assert.equal(decision.action, 'pause')
  assert.equal(decision.reason, 'NO_SAFE_SEAL_STANCE')
})

test('multiple, absent, incomplete and mixed source observations retain LARGE_FLUID_AREA', () => {
  const cases = [
    f => { f.put({ x: 1, y: 59, z: 5 }, 'lava', 0) },
    f => { f.put(f.source, 'lava', 1) },
    f => { f.blocks.set('-1,60,5', { known: false, position: { x: -1, y: 60, z: 5 } }) },
    f => { const b = f.read(1, 59, 5); f.blocks.set('1,59,5', { ...b, properties: {} }) },
    f => { f.put({ x: -1, y: 60, z: 5 }, 'water', 0) },
    f => { f.put(f.roof, 'lava', 1) }
  ]
  for (const mutate of cases) {
    const f = fixture(); mutate(f)
    const plan = f.make().sealPlan({ position: f.source, lava: true })
    assert.equal(plan.ok, false)
    assert.equal(plan.reason, 'LARGE_FLUID_AREA')
    assert.ok(plan.sourceFailure)
  }
})

test('the source exception never traverses more than 512 connected fluid cells or permits a foreign source', () => {
  const f = fixture()
  for (let x = 0; x < 32; x++) for (let z = 5; z < 22; z++) f.put({ x, y: 59, z }, 'lava', 1)
  assert.equal(f.make().sealPlan({ position: f.source, lava: true }).sourceFailure, 'SOURCE_COMPONENT_LIMIT')
  const outside = fixture()
  outside.regions.protected.push({ xMin: 0, xMax: 0, yMin: 60, yMax: 60, zMin: 5, zMax: 5 })
  assert.equal(outside.make().sealPlan({ position: outside.source, lava: true }).ok, false)
})

test('an earlier-layer, protected or falling roof and an unavailable dry stance cannot authorize access mining', async () => {
  const earlier = fixture()
  assert.equal((await earlier.next(earlier.make(), 62)).action, 'pause')
  for (const material of ['chest', 'gravel']) {
    const f = fixture(); f.put(f.roof, material)
    assert.notEqual((await f.next(f.make())).reason, 'FLUID_SOURCE_ACCESS')
  }
  const trapped = fixture({ travel: false })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (x !== 0 || z !== 5) trapped.regions.protected.push({ xMin: x, xMax: x, yMin: 62, yMax: 63, zMin: z, zMax: z })
  const d = await trapped.next(trapped.make(), 61, { x: 0, y: 62, z: 5 })
  assert.equal(d.action, 'pause')
  assert.equal(d.reason, 'NO_SAFE_SEAL_STANCE')
})

test('large water bodies keep the ordinary stop instead of acquiring a lava-only exception', () => {
  const f = fixture()
  for (const b of [...f.blocks.values()]) if (/lava/.test(b.name)) f.put(b.position, 'water', 0)
  assert.equal(f.make().sealPlan({ position: f.source }).reason, 'LARGE_FLUID_AREA')
})

test('runtime adapter preserves fluid-access metadata in batch preview and single-target fallback', async () => {
  const f = fixture(); const seen = []; let phase = 'idle'
  const roofTarget = { ...f.roof, expectedName: 'minecraft:deepslate', expectedRuntimeId: 2, accessPreparation: 'quarry_fluid_roof', fluidSource: { position: f.source, expectedName: 'minecraft:lava', expectedRuntimeId: 1000 }, requiredTool: { kind: 'pickaxe', tier: 4, reserve: 1 } }
  const normal = { x: 2, y: 61, z: 5, expectedName: 'minecraft:stone' }
  const adapter = createQuarryRuntimeAdapter({ getState: () => ({}), getBlock: f.read, entities: () => [], mining: { preview: targets => { seen.push(structuredClone(targets)); return { ready: targets.length === 1 } }, start: async targets => { for (const p of targets) f.put(p, 'air'); phase = 'completed' } }, getMining: () => ({ phase }), movement: {}, getMovement: () => ({}), equip: async () => {}, placeQuarry: async () => {}, eat: async () => {}, chest: {}, stopAll: async () => {}, combatActive: () => false })
  await adapter.mine([roofTarget, normal])
  assert.ok(seen.some(targets => targets.length === 2))
  const roofReceipts = seen.flat().filter(p => p.x === f.roof.x && p.y === f.roof.y && p.z === f.roof.z)
  assert.ok(roofReceipts.length >= 2)
  for (const target of roofReceipts) {
    assert.equal(target.accessPreparation, 'quarry_fluid_roof')
    assert.deepEqual(target.fluidSource, roofTarget.fluidSource)
    assert.deepEqual(target.requiredTool, roofTarget.requiredTool)
  }
})

function jobFixture (mode) {
  const f = fixture(); let clock = 1000; let placements = 0; let firstMine = null; let job
  const inventory = structuredClone(f.tools)
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'flow-test', realm: { id: '1' }, dimension: 'overworld', connectionId: 'c1', startedAt: 't1', runtimeEntityId: '41', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20, food: 20, position: { x: f.feet.x + 0.5, y: f.feet.y + 1.62, z: f.feet.z + 0.5 }, selectedSlot: 0, heldItem: inventory[0], inventory: { known: true, items: inventory } }
  const adapter = {
    getState: () => structuredClone(state), getBlock: f.read, entities: () => [], combatActive: () => false, stopAll: async () => {},
    equip: async slot => { state.selectedSlot = slot; state.heldItem = inventory.find(i => i.slot === slot) },
    moveTo: async p => { state.position = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 } },
    mine: async targets => { firstMine ??= structuredClone(targets); for (const p of targets) f.put(p, 'air'); return { phase: 'completed' } },
    place: async ({ position, slot, expectedBlock }) => { placements++; f.put(position, expectedBlock.replace('minecraft:', '')); if (mode !== 'no_spend') inventory.find(i => i.slot === slot).count--; return { phase: 'completed' } }
  }
  job = createQuarryJob({ adapter, now: () => clock, sleep: async ms => {
    clock += ms
    const drain = job.document()?.fluidDrain
    if (drain && mode === 'drain' && clock - drain.startedAt >= 2000) for (const b of [...f.blocks.values()]) if (/lava/.test(b.name)) f.put(b.position, 'air')
    if (drain && mode === 'unknown') f.blocks.set('1,59,5', { known: false, position: { x: 1, y: 59, z: 5 } })
    await new Promise(resolve => setImmediate(resolve))
  }, pollMs: 5 })
  assert.equal(job.plan({ jobId: 'flow-job', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 61, yBottom: 59, worldMinY: 50, worldMaxY: 80, inventory: { carryOnly: true }, exit: { mode: 'adjacent_pillar' } }).ready, true)
  const doc = job.document(); doc.records = f.records; job.load(doc)
  return { ...f, job, placements: () => placements, firstMine: () => firstMine }
}

async function until (predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('fluid source test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) } }

test('the job carries the roof capability, plugs exactly once, and records received downstream disappearance', async () => {
  const f = jobFixture('drain'); f.job.start()
  try {
    await until(() => !!f.job.document().lastFluidDrain || f.job.status().state === 'PAUSED')
    assert.ok(f.job.document().lastFluidDrain, JSON.stringify(f.job.status().pauseDetails))
    assert.equal(f.firstMine().length, 1)
    assert.equal(f.firstMine()[0].accessPreparation, 'quarry_fluid_roof')
    assert.deepEqual(f.firstMine()[0].fluidSource.position, f.source)
    assert.equal(f.firstMine()[0].requiredTool.reserve, 1)
    assert.equal(f.placements(), 1)
    assert.equal(f.job.status().ledger.placedTemporary, 1)
    assert.equal(f.job.document().lastFluidDrain.cells, 179)
    assert.equal(f.job.status().fluidDrain, null)
  } finally { await f.job.pause() }
})

test('undrained or unobserved downstream stays stopped without filling the whole lake', async () => {
  for (const [mode, reason] of [['timeout', 'FLUID_DRAIN_TIMEOUT'], ['unknown', 'FLUID_DRAIN_UNOBSERVED']]) {
    const f = jobFixture(mode); f.job.start()
    try {
      await until(() => f.job.status().state === 'PAUSED')
      assert.equal(f.job.status().pauseReason, reason)
      assert.equal(f.placements(), 1)
      assert.equal(f.job.document().lastFluidDrain, undefined)
      assert.ok(f.job.status().fluidDrain.remaining > 0)
    } finally { await f.job.pause() }
  }
})

test('received source block without real material spend does not start a drain receipt', async () => {
  const f = jobFixture('no_spend'); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'SOURCE_PLACEMENT_UNCONFIRMED')
    assert.equal(f.placements(), 1)
    assert.equal(f.job.status().ledger.placedTemporary, 0)
    assert.equal(f.job.document().fluidDrain, undefined)
  } finally { await f.job.pause() }
})
