'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')

// A large water body just outside the chunk's east edge (x=16..19) touches the
// edge column x=15 at y=59..61. It cannot be sealed from inside, so those edge
// cells are left as the wall and the rest of the layer keeps being mined.
function fixture ({ waterInside = false, intrusion = false, unknownGap = false } = {}) {
  const blocks = new Map(); const k = (x, y, z) => `${x},${y},${z}`
  for (let x = waterInside ? 10 : 16; x <= (waterInside ? 13 : 19); x++) for (let y = 59; y <= 61; y++) for (let z = 0; z <= 5; z++) blocks.set(k(x, y, z), { known: true, position: { x, y, z }, name: 'minecraft:water', boundingBox: 'empty', runtimeId: 9, properties: {}, extra: [] })
  // The outside body leaks into the edge column x=15 at y=61 (z=0..5). With
  // unknownGap the only link (x=16) is unobserved instead of water.
  if (intrusion) for (let z = 0; z <= 5; z++) blocks.set(k(15, 61, z), { known: true, position: { x: 15, y: 61, z }, name: 'minecraft:water', boundingBox: 'empty', runtimeId: 9, properties: {}, extra: [] })
  if (unknownGap) for (let y = 59; y <= 61; y++) for (let z = 0; z <= 5; z++) blocks.set(k(16, y, z), { known: false })
  const read = (x, y, z) => blocks.get(k(x, y, z)) ?? { known: true, position: { x, y, z }, name: y <= 61 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 61 ? 'block' : 'empty', runtimeId: 2, properties: {}, extra: [], diggable: true }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 61, yBottom: 55, worldMinY: 50, worldMaxY: 80, travelRegion: [{ xMin: -3, xMax: 15, yMin: 50, yMax: 80, zMin: -3, zMax: 20 }] })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }, { slot: 1, name: 'minecraft:cobblestone', count: 64 }]
  const records = { deferred: {} }
  const planner = createQuarryPlanner({ regions, getBlock: read, records, exit: { mode: 'adjacent_pillar' } })
  return { planner, tools, records }
}

test('cells walling a large water body outside the chunk are left in place and mining continues', async () => {
  const f = fixture()
  const decision = await f.planner.next({ feet: { x: 14, y: 62, z: 2 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  assert.equal(decision.action, 'mine', JSON.stringify(decision).slice(0, 400))
  for (const t of decision.targets) assert.ok(!(t.position.x === 15 && t.position.z <= 5), 'a wall cell is never mined: ' + JSON.stringify(t.position))
  const walls = Object.entries(f.planner.exportRecords().deferred).filter(([, v]) => v.reason === 'LARGE_FLUID_WALL')
  assert.ok(walls.length >= 1, 'the wall cell is recorded')
  assert.ok(walls.every(([key]) => key.startsWith('15,')))
})

test('a large water body inside the target still pauses the job', async () => {
  const f = fixture({ waterInside: true })
  const decision = await f.planner.next({ feet: { x: 2, y: 62, z: 8 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  assert.equal(decision.action, 'pause', JSON.stringify(decision).slice(0, 300))
  assert.equal(decision.reason, 'LARGE_FLUID_AREA')
})

test('in-chunk water connected to the outside body is held with its inner neighbours, and no stand touches it', async () => {
  const f = fixture({ intrusion: true })
  const decision = await f.planner.next({ feet: { x: 12, y: 62, z: 2 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  assert.equal(decision.action, 'mine', JSON.stringify(decision).slice(0, 400))
  const deferred = f.planner.exportRecords().deferred
  const held = Object.entries(deferred).filter(([, v]) => v.reason === 'LARGE_FLUID_WALL').map(([key]) => key)
  for (let z = 0; z <= 5; z++) assert.ok(held.includes('15,61,' + z), 'intruding water cell held: 15,61,' + z)
  const water = new Set(Array.from({ length: 6 }, (_, z) => '15,61,' + z))
  for (const t of decision.targets) {
    assert.ok(!held.includes(`${t.position.x},${t.position.y},${t.position.z}`), 'a held cell is never mined')
    const touches = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => water.has(`${t.position.x + dx},${t.position.y + dy},${t.position.z + dz}`))
    assert.ok(!touches, 'a cell touching held water is never broken: ' + JSON.stringify(t.position))
  }
  const st = decision.stance
  for (const c of [st, { ...st, y: st.y + 1 }]) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) assert.ok(!water.has(`${c.x + dx},${c.y + dy},${c.z + dz}`), 'stand touches held water')
})

test('in-chunk water linked outward only through unobserved blocks is not held; the existing fluid handling applies', async () => {
  const f = fixture({ intrusion: true, unknownGap: true })
  const decision = await f.planner.next({ feet: { x: 12, y: 62, z: 2 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  // Unproven link: the 6 cells are a small known pool, so the existing plug rule applies (never a hold).
  assert.ok(['seal', 'pause'].includes(decision.action), JSON.stringify(decision).slice(0, 300))
  assert.equal(Object.values(f.planner.exportRecords().deferred).some(v => v.reason === 'LARGE_FLUID_WALL'), false)
})
