'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { createQuarryJob } = require('../src/quarry-job')
const { buildRegions } = require('../src/quarry-region')

function fixture ({ floor = 'stone', below = 'stone' } = {}) {
  const blocks = new Map(), key = p => `${p.x},${p.y},${p.z}`
  const put = (p, name, depth) => blocks.set(key(p), { known: true, name: `minecraft:${name}`, runtimeId: /lava/.test(name) ? 1000 + (depth ?? 0) : name === 'stone' ? 2 : 3, boundingBox: /lava|air/.test(name) ? 'empty' : 'block', properties: depth == null ? {} : { liquid_depth: depth }, extra: [], diggable: !/lava|air/.test(name) })
  const feet = { x: 0, y: 61, z: 0 }, floorPosition = { x: 0, y: 60, z: 0 }, source = { x: 1, y: 60, z: 0 }
  put(floorPosition, floor)
  put({ x: 0, y: 59, z: 0 }, below, below === 'lava' ? 1 : undefined)
  put(source, 'lava', 0)
  put({ x: 2, y: 60, z: 0 }, 'stone')
  const getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', properties: {}, extra: [] })
  // The synthetic world is air outside the few placed blocks, which the plan-time cave check would refuse.
  const config = { jobId: 'seal-stance', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 60, yBottom: 55, worldMinY: 50, worldMaxY: 80, allowCaves: true, boundarySeal: { sourceOnly: true, material: 'dirt' }, inventory: { carryOnly: true, minFreeSlots: 0 }, permissions: { travelRegion: [{ xMin: 0, xMax: 15, yMin: 50, yMax: 65, zMin: 0, zMax: 15 }] } }
  const regions = buildRegions({ ...config, travelRegion: config.permissions.travelRegion })
  const inventory = [64, 64, 64, 32].map((count, slot) => ({ slot, name: 'minecraft:dirt', count, stackId: 10 + slot }))
  const planner = createQuarryPlanner({ regions, getBlock, exit: { mode: 'adjacent_pillar', reservedDirt: 192 } })
  const next = () => planner.next({ feet, yTop: 60, tools: inventory, inventoryItems: inventory })
  return { blocks, put, getBlock, config, inventory, feet, floorPosition, source, planner, next }
}

test('fluid sealing rejects gravity stance floors even when the ordinary walking graph permits them', async () => {
  for (const floor of ['gravel', 'sand', 'red_sand', 'white_concrete_powder']) {
    const f = fixture({ floor, below: 'lava' })
    assert.equal(f.planner.standable(f.feet), true, `${floor}: walking semantics stay unchanged`)
    assert.equal(f.planner.reachableFrom(f.feet).has('0,61,0'), true)
    const action = await f.next()
    assert.equal(action.action, 'pause', JSON.stringify(action))
    assert.equal(action.reason, 'NO_SAFE_SEAL_STANCE')
    assert.equal(f.getBlock(f.source.x, f.source.y, f.source.z).name, 'minecraft:lava')
  }
})

test('supported gravel remains walkable but a seal uses the same conservative no-gravity rule', async () => {
  const f = fixture({ floor: 'gravel', below: 'stone' })
  f.put({ x: 0, y: 60, z: 1 }, 'stone')
  assert.equal(f.planner.standable(f.feet), true)
  assert.equal(f.planner.reachableFrom(f.feet).has('0,61,1'), true)
  assert.equal(f.planner.safeSealStance(f.feet), false)
  const action = await f.next()
  assert.equal(action.action, 'seal', JSON.stringify(action))
  assert.notDeepEqual(action.stance, f.feet)
  assert.equal(f.planner.safeSealStance(action.stance), true)
})

test('an ordinary stable floor still permits the existing source plug, while missing floor knowledge never does', async () => {
  const f = fixture()
  assert.equal(f.planner.safeSealStance(f.feet), true)
  const action = await f.next()
  assert.equal(action.action, 'seal')
  assert.deepEqual(action.stance, f.feet)
  assert.deepEqual(action.position, f.source)
  f.blocks.set('0,60,0', { known: false })
  assert.equal(f.planner.safeSealStance(f.feet), false)
})

for (const when of ['after selection', 'during checkpoint persistence']) test(`the job rejects gravel introduced ${when} and sends no source placement`, async () => {
  const f = fixture(); let job, changed = false, calls = 0
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'test', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', dimension: 'overworld', runtimeEntityId: '1', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20, food: 20, position: { x: .5, y: 62.62, z: .5 }, selectedSlot: 0, heldItem: f.inventory[0], inventory: { known: true, items: f.inventory } }
  const adapter = { getState: () => {
    if (when === 'after selection' && !changed && job?.document()?.lastDecision?.action === 'seal') { f.put(f.floorPosition, 'gravel'); changed = true }
    return structuredClone(state)
  }, getBlock: f.getBlock, entities: () => [], combatActive: () => false, stopAll: async () => {}, equip: async () => {}, moveTo: async p => { state.position = { x: p.x + .5, y: p.y + 1.62, z: p.z + .5 } }, mine: async () => { throw Error('unexpected mining') }, place: async () => { calls++; return { phase: 'completed' } } }
  job = createQuarryJob({ adapter, pollMs: 5, sleep: () => new Promise(resolve => setImmediate(resolve)), storage: { save: async (id, doc) => {
    if (when === 'during checkpoint persistence' && !changed && doc.actions.at(-1)?.type === 'place') { f.put(f.floorPosition, 'gravel'); changed = true }
  } } })
  assert.equal(job.plan(f.config).ready, true)
  job.start()
  try {
    const end = Date.now() + 4000
    while (job.status().state !== 'PAUSED') { if (Date.now() > end) throw Error('seal stance job timeout'); await new Promise(resolve => setTimeout(resolve, 3)) }
    assert.equal(changed, true)
    assert.equal(calls, 0)
    assert.equal(job.status().pauseReason, 'SEAL_UNSAFE_STANCE')
    assert.equal(job.status().ledger.placedSeal, 0)
    assert.equal(f.inventory.reduce((n, i) => n + i.count, 0), 224)
  } finally { await job.pause() }
})

for (const mode of ['source_depth', 'source_runtime', 'dirt_reserve', 'boundary_roof']) test(`checkpoint changes to ${mode} are revalidated immediately before placement`, async () => {
  const f = fixture(); let changed = false, calls = 0
  if (mode === 'boundary_roof') {
    f.config.yTop = 61; f.config.yBottom = 61; f.config.boundarySeal.closeOpenings = true
    f.put({ x: -1, y: 60, z: 0 }, 'stone'); f.put({ x: -1, y: 63, z: 0 }, 'stone')
  }
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'test', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', dimension: 'overworld', runtimeEntityId: '1', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20, food: 20, position: { x: .5, y: 62.62, z: .5 }, selectedSlot: 0, heldItem: f.inventory[0], inventory: { known: true, items: f.inventory } }
  const adapter = { getState: () => structuredClone(state), getBlock: f.getBlock, entities: () => [], combatActive: () => false, stopAll: async () => {}, equip: async () => {}, moveTo: async p => { state.position = { x: p.x + .5, y: p.y + 1.62, z: p.z + .5 } }, mine: async () => { throw Error('unexpected mining') }, place: async () => { calls++; return { phase: 'completed' } } }
  const job = createQuarryJob({ adapter, pollMs: 5, sleep: () => new Promise(resolve => setImmediate(resolve)), storage: { save: async (id, doc) => {
    if (!changed && doc.actions.at(-1)?.type === 'place') {
      if (mode === 'source_depth') f.put(f.source, 'lava', 1)
      if (mode === 'source_runtime') f.blocks.get('1,60,0').runtimeId++
      if (mode === 'dirt_reserve') f.inventory[3].count = 0
      if (mode === 'boundary_roof') f.put({ x: -1, y: 63, z: 0 }, 'air')
      changed = true
    }
  } } })
  assert.equal(job.plan(f.config).ready, true)
  job.start()
  try {
    const end = Date.now() + 4000
    while (job.status().state !== 'PAUSED') { if (Date.now() > end) throw Error('seal checkpoint race timeout'); await new Promise(resolve => setTimeout(resolve, 3)) }
    assert.equal(changed, true)
    assert.equal(calls, 0)
    assert.equal(job.status().pauseReason, mode === 'dirt_reserve' ? 'SEAL_MATERIAL_MISSING' : mode === 'boundary_roof' ? 'BOUNDARY_CONTEXT_CHANGED' : 'FLUID_SOURCE_CHANGED')
    assert.equal(job.status().ledger.placedSeal, 0)
    assert.equal(job.status().ledger.placedTemporary, 0)
    assert.equal(f.inventory.reduce((n, item) => n + item.count, 0), mode === 'dirt_reserve' ? 192 : 224)
  } finally { await job.pause() }
})
