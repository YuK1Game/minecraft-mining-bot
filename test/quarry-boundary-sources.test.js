'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { createQuarryJob } = require('../src/quarry-job')
const { buildRegions, permits } = require('../src/quarry-region')
const { keepPlan } = require('../src/quarry-inventory')

const boundarySeal = { enabled: true, horizontalMargin: 1, material: 'dirt', sourceOnly: true, closeOpenings: true }
const k = p => `${p.x},${p.y},${p.z}`
function fixture ({ closeOpenings = false, dirt = 194 } = {}) {
  const blocks = new Map()
  const put = (p, name, depth) => blocks.set(k(p), { known: true, name: `minecraft:${name}`, position: { ...p }, runtimeId: name.length + (depth ?? 20), boundingBox: /air|water|lava/.test(name) ? 'empty' : 'block', diggable: !/water|lava/.test(name), properties: depth == null ? {} : { liquid_depth: depth }, extra: [] })
  const read = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: y <= 0 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, runtimeId: y <= 0 ? 2 : 0, boundingBox: y <= 0 ? 'block' : 'empty', diggable: y <= 0, properties: {}, extra: [] }
  const config = { jobId: 'boundary-sources', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 1, yBottom: 1, worldMinY: -4, worldMaxY: 25, boundarySeal: { ...boundarySeal, closeOpenings }, inventory: { carryOnly: true, minFreeSlots: 0 }, exit: { mode: 'adjacent_pillar', reservedDirt: 192 } }
  const regions = buildRegions(config)
  const inventory = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100, maxDurability: 1561 }]
  let left = dirt
  for (let slot = 1; left > 0; slot++) { const count = Math.min(64, left); inventory.push({ slot, name: 'minecraft:dirt', count }); left -= count }
  const planner = () => createQuarryPlanner({ regions, getBlock: read, exit: config.exit })
  const next = (p = planner()) => p.next({ feet: { x: 2, y: 1, z: 4 }, yTop: 1, tools: inventory, inventoryItems: inventory })
  return { blocks, put, read, config, regions, inventory, planner, next }
}

test('new source-only policy chooses actual highest known water/lava sources, including multiple sources', () => {
  for (const family of ['water', 'lava']) {
    const f = fixture(); f.regions.yTop = 2; f.regions.seal.yMax = 3
    const high = { x: 0, y: 2, z: 4 }; const low = { x: 0, y: 1, z: 4 }
    f.put(low, `flowing_${family}`, 1); f.put(high, family, 0); f.put({ x: 0, y: 1, z: 5 }, family, 0)
    const p = f.planner(); const first = p.sealPlan({ position: low })
    assert.deepEqual(first.position, high); assert.equal(first.materialRequired, 'dirt'); assert.equal(first.sourceSeal.sources.length, 2)
    f.put(high, 'dirt')
    assert.deepEqual(p.sealPlan({ position: low }).position, { x: 0, y: 1, z: 5 })
  }
})

test('source-only mode waits for received source-less flow instead of filling a flowing cell', async () => {
  const f = fixture(); f.put({ x: 0, y: 1, z: 4 }, 'flowing_water', 1)
  const decision = await f.next()
  assert.equal(decision.action, 'wait_fluid'); assert.equal(decision.cells.length, 1)
})

test('unknown boundaries, mixed liquids, foreign/protected sources, missing depth and component overflow fail closed', () => {
  for (const [change, reason] of [
    [f => f.blocks.set('-1,1,4', { known: false }), 'SOURCE_BOUNDARY_UNKNOWN'],
    [f => f.put({ x: 0, y: 1, z: 5 }, 'lava', 0), 'SOURCE_COMPONENT_MIXED_FLUID'],
    [f => f.put({ x: -2, y: 1, z: 4 }, 'water', 0), 'SOURCE_OUTSIDE_OR_PROTECTED'],
    [f => { f.blocks.get('0,1,4').protected = true }, 'SOURCE_OUTSIDE_OR_PROTECTED'],
    [f => { f.blocks.get('0,1,4').properties = {} }, 'SOURCE_DEPTH_UNKNOWN'],
    [f => { for (let x = 0; x < 66; x++) for (let z = 0; z < 66; z++) f.put({ x, y: 1, z }, 'flowing_water', 1) }, 'SOURCE_COMPONENT_LIMIT']
  ]) {
    const f = fixture(); f.put({ x: 0, y: 1, z: 4 }, 'water', 0); f.put({ x: -1, y: 1, z: 4 }, 'flowing_water', 1); change(f)
    const plan = f.planner().sealPlan({ position: { x: 0, y: 1, z: 4 } })
    assert.equal(plan.ok, false); assert.equal(plan.reason, reason)
  }
})

test('only an actual inner-air to outer-air underground opening gets a dirt boundary seal', async () => {
  const f = fixture({ closeOpenings: true }); const outer = { x: -1, y: 1, z: 4 }
  f.put({ ...outer, y: 3 }, 'stone')
  const decision = await f.next()
  assert.equal(decision.action, 'seal'); assert.deepEqual(decision.position, outer); assert.equal(decision.material, 'minecraft:dirt'); assert.equal(decision.purpose, 'seal')
  assert.equal(permits(f.regions, 'break', outer).allowed, false)
  f.put(outer, 'dirt')
  assert.equal((await f.next()).action, 'finished')
  const sky = fixture({ closeOpenings: true })
  assert.equal((await sky.next()).action, 'finished')
  const solid = fixture({ closeOpenings: true }); solid.put(outer, 'diamond_ore'); solid.put({ ...outer, y: 3 }, 'stone')
  assert.equal((await solid.next()).action, 'finished')
})

test('unknown cave roofs and protected apertures stop while disconnected outside air is ignored', async () => {
  const f = fixture({ closeOpenings: true }); f.blocks.set('-1,2,4', { known: false })
  assert.equal((await f.next()).reason, 'BOUNDARY_UNOBSERVED')
  f.put({ x: -1, y: 2, z: 4 }, 'stone'); f.put({ x: -1, y: 1, z: 4 }, 'air'); f.blocks.get('-1,1,4').protected = true
  assert.equal((await f.next()).reason, 'BOUNDARY_PROTECTED')
  f.put({ x: 0, y: 1, z: 4 }, 'diamond_ore')
  assert.notEqual((await f.next()).reason, 'BOUNDARY_PROTECTED')
})

test('dirt seal budgets preserve 192 exit blocks; dirt in main inventory requests normal equipment', async () => {
  const f = fixture({ dirt: 192 }); f.put({ x: 0, y: 1, z: 4 }, 'water', 0)
  f.inventory.push({ slot: 8, name: 'minecraft:cobblestone', count: 64 })
  assert.equal((await f.next()).reason, 'SEAL_MATERIAL_MISSING')
  f.inventory.push({ slot: 20, name: 'minecraft:dirt', count: 1 })
  for (const i of f.inventory) if (i.name === 'minecraft:dirt' && i.slot < 9) i.slot += 9
  assert.equal((await f.next()).action, 'equip_seal')
  const items = [{ slot: 0, name: 'minecraft:cobblestone', count: 64 }, ...[1, 2, 3, 4].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))]
  const kept = keepPlan(items, { keepExitDirt: 192, keepSealBlocks: 32, keepSealMaterial: 'dirt' })
  assert.equal([...kept.keep.values()].reduce((n, v) => n + v, 0), 224)
  assert.ok(kept.deposits.some(i => i.name === 'minecraft:cobblestone' && i.count === 64))
})

function liveFixture ({ mode = 'drain', family = 'water', closeOpenings = false, sourceLess = false } = {}) {
  const f = fixture({ closeOpenings }); const placed = []; let clock = 1000; let job
  if (closeOpenings) f.put({ x: -1, y: 3, z: 4 }, 'stone')
  else { f.put({ x: 0, y: 1, z: 4 }, sourceLess ? `flowing_${family}` : family, sourceLess ? 1 : 0); if (!sourceLess) f.put({ x: 0, y: 1, z: 5 }, family, 0) }
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'test', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', dimension: 'overworld', runtimeEntityId: '1', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20, food: 20, position: { x: 2.5, y: 2.62, z: 4.5 }, selectedSlot: 0, heldItem: f.inventory[0], inventory: { known: true, items: f.inventory } }
  const adapter = { getState: () => structuredClone(state), getBlock: f.read, entities: () => [], combatActive: () => false, stopAll: async () => {}, equip: async slot => { state.selectedSlot = slot; state.heldItem = f.inventory.find(i => i.slot === slot) }, moveTo: async p => { state.position = { x: p.x + .5, y: p.y + 1.62, z: p.z + .5 }; if (mode === 'changed') f.put({ x: 0, y: 1, z: 4 }, family, 1) }, mine: async () => { throw new Error('test stops before ordinary excavation') }, place: async ({ position, slot }) => { placed.push(position); f.put(position, 'dirt'); if (mode !== 'no_spend') f.inventory.find(i => i.slot === slot).count--; return { phase: 'completed' } } }
  job = createQuarryJob({ adapter, now: () => clock, sleep: async ms => {
    clock += ms
    if (job.document()?.fluidDrain) {
      if (mode === 'flow_drains') f.put({ x: 0, y: 1, z: 4 }, 'air')
      if (mode === 'unknown') f.blocks.set('0,1,4', { known: false })
      if (mode === 'life') state.lifecycle.deathId++
    }
    await new Promise(resolve => setImmediate(resolve))
  }, pollMs: 5 })
  assert.equal(job.plan(f.config).ready, true)
  return { ...f, state, job, placed }
}
async function until (fn) { const end = Date.now() + 4000; while (!fn()) { if (Date.now() > end) throw new Error('boundary job timed out'); await new Promise(resolve => setTimeout(resolve, 2)) } }

test('normal job seals two water/lava sources once each, observes drainage and retains exactly exit dirt', async () => {
  for (const family of ['water', 'lava']) {
    const f = liveFixture({ family }); f.job.start()
    try {
      await until(() => f.job.document().lastFluidDrain || f.job.status().state === 'PAUSED')
      assert.ok(f.job.document().lastFluidDrain, JSON.stringify(f.job.status()))
      assert.equal(f.placed.length, 2); assert.equal(new Set(f.placed.map(k)).size, 2)
      assert.equal(f.job.document().lastFluidSourceStep.remainingSources, 1)
      assert.equal(f.inventory.filter(i => i.name === 'minecraft:dirt').reduce((n, i) => n + i.count, 0), 192)
      assert.equal(f.job.status().ledger.placedTemporary, 2)
    } finally { await f.job.pause() }
  }
})

test('source and dry boundary block updates without inventory spend never count as success', async () => {
  for (const closeOpenings of [false, true]) {
    const f = liveFixture({ mode: 'no_spend', closeOpenings }); f.job.start()
    try {
      await until(() => f.job.status().state === 'PAUSED')
      assert.equal(f.job.status().pauseReason, closeOpenings ? 'SEAL_PLACEMENT_UNCONFIRMED' : 'SOURCE_PLACEMENT_UNCONFIRMED')
      assert.equal(f.placed.length, 1); assert.equal(f.job.document().lastFluidDrain, undefined)
      assert.equal(f.job.status().ledger.placedTemporary + f.job.status().ledger.placedSeal, 0)
    } finally { await f.job.pause() }
  }
})

test('source-less drainage requires received disappearance; timeout, unknown and life changes never count', async () => {
  for (const [mode, reason] of [['flow_drains', null], ['timeout', 'FLUID_DRAIN_TIMEOUT'], ['unknown', 'FLUID_DRAIN_UNOBSERVED'], ['life', 'DEATH']]) {
    const f = liveFixture({ sourceLess: true, mode }); f.job.start()
    try {
      await until(() => f.job.document().lastFluidDrain || f.job.status().state === 'PAUSED')
      assert.equal(f.placed.length, 0)
      if (reason) { assert.equal(f.job.status().pauseReason, reason); assert.equal(f.job.document().lastFluidDrain, undefined) }
      else { assert.equal(f.job.document().lastFluidDrain.source, null); assert.equal(f.job.document().lastFluidDrain.cells, 1) }
    } finally { await f.job.pause() }
  }
})

test('opening policy is explicit, one-cell and dirt-only; old jobs retain legacy behavior', () => {
  assert.throws(() => buildRegions({ ...fixture().config, boundarySeal: { ...boundarySeal, horizontalMargin: 2 } }), /one-cell/)
  assert.throws(() => buildRegions({ ...fixture().config, boundarySeal: { ...boundarySeal, material: 'cobblestone' } }), /dirt/)
  const old = buildRegions({ ...fixture().config, boundarySeal: { enabled: true, horizontalMargin: 1 } })
  assert.equal(old.seal.closeOpenings, false); assert.equal(old.seal.sourceOnly, false)
})
