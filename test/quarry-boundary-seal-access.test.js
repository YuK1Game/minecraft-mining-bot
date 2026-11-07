'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions, permits } = require('../src/quarry-region')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`

// Standalone roof/cave geometry: layer2 is already excavated, a dry opening
// lies at layer1 under the outer roof, and one ordinary layer1 cell can give
// access to the received cave floor. No local Realm snapshot is required.
function scene ({ oneCandidate = false } = {}) {
  const changes = new Map(), opening = { x: 14, y: 1, z: -1 }, candidate = { x: 13, y: 1, z: 0 }, feet = { x: 4, y: 2, z: 7 }
  const inside = (x, z) => x >= 0 && x <= 15 && z >= 0 && z <= 15
  const cave = (x, z) => x >= 14 && x <= 15 && z >= -1 && z <= 5 || x === 13 && z >= 1 && z <= 5
  const block = (p, name) => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : name === 'stone' ? 1 : 2, boundingBox: name === 'air' || /water|lava/.test(name) ? 'empty' : 'block', position: { ...p }, diggable: name !== 'air', properties: {}, extra: [] })
  const getBlock = (x, y, z) => {
    const p = { x, y, z }, changed = changes.get(key(p))
    if (changed) return copy(changed)
    const air = y >= 2 && inside(x, z) || [0, 1].includes(y) && cave(x, z)
    const b = block(p, air ? 'air' : 'stone')
    if (oneCandidate && y === 1 && inside(x, z) && !air && key(p) !== key(candidate)) b.protected = true
    return b
  }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 2, yBottom: 1, worldMinY: -4, worldMaxY: 6, boundarySeal: { enabled: true, horizontalMargin: 1, closeOpenings: true, material: 'dirt', sourceOnly: true }, travelRegion: [{ xMin: -2, xMax: 17, yMin: -2, yMax: 4, zMin: -2, zMax: 17 }] })
  const inventory = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100, maxDurability: 1561 }, ...[64, 64, 64, 8].map((count, i) => ({ slot: i + 1, name: 'minecraft:dirt', count }))]
  const planner = createQuarryPlanner({ regions, getBlock, exit: { mode: 'adjacent_pillar', reservedDirt: 192 } })
  const plan = { position: opening, purpose: 'seal', materialRequired: 'dirt', boundaryOpening: { inside: { x: 14, y: 1, z: 0 }, roof: { x: 14, y: 2, z: -1 } } }
  const next = (options = {}) => planner.next({ feet, yTop: 2, tools: inventory, inventoryItems: inventory, ...options })
  const put = (p, name, extra = {}) => changes.set(key(p), { ...block(p, name), ...extra })
  return { changes, opening, candidate, feet, getBlock, regions, inventory, planner, plan, next, put }
}

test('one normal inbounds cell of the boundary layer prepares access; only received AIR permits the seal', async () => {
  const f = scene(), records = copy(f.planner.exportRecords())
  assert.equal((await f.planner.previewSealPlacement(f.plan, f.feet, f.inventory)).reason, 'NO_SAFE_SEAL_STANCE')
  const decision = await f.next()
  assert.equal(decision.action, 'mine', JSON.stringify(decision))
  assert.equal(decision.reason, 'BOUNDARY_SEAL_ACCESS')
  assert.equal(decision.targets.length, 1)
  const target = decision.targets[0].position
  assert.equal(target.y, f.opening.y)
  assert.equal(permits(f.regions, 'break', target).allowed, true)
  assert.equal(f.regions.columns.has(`${target.x},${target.z}`), true)
  assert.equal(decision.tool.name, 'minecraft:diamond_pickaxe')
  assert.ok(decision.targets[0].aim)
  assert.equal(f.getBlock(target.x, target.y, target.z).name, 'minecraft:stone')
  assert.equal(f.changes.size, 0, 'the hypothetical AIR reader never changes received terrain')
  assert.deepEqual(f.planner.exportRecords(), records, 'a preview never records a seal, done cell or temporary placement')
  const repeated = await f.next()
  assert.equal(repeated.action, 'mine', 'without received AIR, no virtual seal is executed')
  f.put(target, 'air')
  const seal = await f.next()
  assert.equal(seal.action, 'seal', JSON.stringify(seal))
  assert.deepEqual(seal.position, f.opening)
  assert.equal(f.planner.safeSealStance(seal.stance), true)
  assert.equal(f.getBlock(14, 2, -1).name, 'minecraft:stone', 'the outside roof is never excavated')
})

test('unknown, protected, nonharvestable and unsafe access candidates retain the original stop', async t => {
  const cases = {
    unknown: f => f.changes.set(key(f.candidate), { known: false }),
    protected: f => f.put(f.candidate, 'stone', { protected: true }),
    ore: f => f.put(f.candidate, 'diamond_ore'),
    NBT: f => f.put(f.candidate, 'stone', { nbt: {} }),
    nonharvestable: f => f.put(f.candidate, 'stone', { diggable: false }),
    gravity: f => f.put(f.candidate, 'gravel'),
    'unknown floor': f => f.changes.set('13,0,0', { known: false }),
    'gravity floor': f => f.put({ x: 13, y: 0, z: 0 }, 'gravel'),
    'partial floor': f => f.put({ x: 13, y: 0, z: 0 }, 'stone', { shapes: [[0, 0, 0, 1, 0.5, 1]] }),
    'wet neighbour': f => f.put({ x: 12, y: 1, z: 0 }, 'water'),
    'no tool': f => { f.inventory.shift() }
  }
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = scene({ oneCandidate: true }); change(f)
    const action = await f.next()
    assert.notEqual(action.reason, 'BOUNDARY_SEAL_ACCESS', JSON.stringify(action))
    assert.notEqual(action.action, 'seal')
    assert.equal(f.getBlock(14, 1, -1).name, 'minecraft:air')
  })
})

test('an unfinished upper layer remains first and access never mines the layer below the opening', async () => {
  const f = scene()
  f.put({ x: 4, y: 2, z: 8 }, 'stone')
  const first = await f.next()
  assert.equal(first.action, 'mine')
  assert.equal(first.targets[0].position.y, 2)
  assert.notEqual(first.reason, 'BOUNDARY_SEAL_ACCESS')
  f.put({ x: 4, y: 2, z: 8 }, 'air')
  const access = await f.next()
  assert.equal(access.reason, 'BOUNDARY_SEAL_ACCESS')
  assert.ok(access.targets.every(target => target.position.y === 1))
})

test('stale access decisions do not cache virtual achievement or bypass newly protected terrain', async () => {
  const f = scene({ oneCandidate: true }), first = await f.next()
  assert.equal(first.reason, 'BOUNDARY_SEAL_ACCESS')
  f.put(first.targets[0].position, 'stone', { protected: true, runtimeId: 999 })
  const next = await f.next()
  assert.notEqual(next.action, 'seal')
  assert.notEqual(next.reason, 'BOUNDARY_SEAL_ACCESS')
  assert.deepEqual(f.planner.sealList(), [])
})
