'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { defaults, createQuarryJob } = require('../src/quarry-job')
const { buildRegions } = require('../src/quarry-region')
const { normalizeExit, planQuarryExit, permitsExitAction } = require('../src/quarry-exit-plan')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function flatFixture () {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.fill(0, 60, 0, 15, 62, 15, 'air'); sim.setFeet({ x: 8, y: 60, z: 8 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('dirt', 64)
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90 })
  const args = side => ({ regions, feet: sim.feet(), getBlock: sim.adapter.getBlock, inventory: sim.adapter.getState().inventory.items, exit: { side } })
  const block = side => { for (let i = 0; i < 16; i++) { const p = side === 'east' ? { x: 16, z: i } : side === 'west' ? { x: -1, z: i } : side === 'north' ? { x: i, z: -1 } : { x: i, z: 16 }; sim.world.set(p.x, 61, p.z, 'water') } }
  return { sim, regions, args, block }
}

test('new exit settings default to auto while an existing east side and migration floor survive', () => {
  assert.equal(defaults().exit.side, 'auto')
  assert.equal(normalizeExit({ side: 'east', migrationFloorY: -1 }).side, 'east')
  assert.equal(normalizeExit({ side: 'east', migrationFloorY: -1 }).migrationFloorY, -1)
  for (const side of ['auto', 'east', 'west', 'north', 'south']) assert.equal(normalizeExit({ side }).side, side)
  assert.throws(() => normalizeExit({ side: 'northeast' }), /Unsupported quarry exit side/)
})

test('auto prefers east even when a later side would consume less dirt', () => {
  const f = flatFixture()
  f.sim.world.fill(17, 63, 0, 17, 64, 15, 'stone')
  const selected = planQuarryExit(f.args('auto'))
  const west = planQuarryExit(f.args('west'))
  assert.equal(selected.ok, true)
  assert.equal(selected.plan.side, 'east')
  assert.ok(selected.plan.totalDirt > west.plan.totalDirt)
})

test('auto rotates the one-column entry and landing east then west then north then south', () => {
  const f = flatFixture()
  const expected = [
    { side: 'east', column: { x: 16, z: 0 }, entry: { x: 15, y: 60, z: 0 }, landing: { x: 17, y: 63, z: 0 } },
    { side: 'west', column: { x: -1, z: 0 }, entry: { x: 0, y: 60, z: 0 }, landing: { x: -2, y: 63, z: 0 } },
    { side: 'north', column: { x: 0, z: -1 }, entry: { x: 0, y: 60, z: 0 }, landing: { x: 0, y: 63, z: -2 } },
    { side: 'south', column: { x: 0, z: 16 }, entry: { x: 0, y: 60, z: 15 }, landing: { x: 0, y: 63, z: 17 } }
  ]
  for (const e of expected) {
    const r = planQuarryExit(f.args('auto'))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.plan.side, e.side)
    assert.deepEqual(r.plan.column, e.column)
    assert.deepEqual(r.plan.entry, e.entry)
    assert.deepEqual(r.plan.landing, e.landing)
    assert.equal(permitsExitAction(r.plan, 'break', { ...e.column, y: 61 }), true)
    assert.equal(permitsExitAction(r.plan, 'break', { ...e.landing, y: 61 }), false)
    assert.equal(permitsExitAction(r.plan, 'break', e.entry), false)
    assert.equal(permitsExitAction(r.plan, 'travel', e.landing), true)
    f.block(e.side)
  }
  const none = planQuarryExit(f.args('auto'))
  assert.equal(none.reason, 'EXIT_COLUMN_UNAVAILABLE')
  assert.equal(none.details.attempts.length, 64)
})

test('an explicit east job never quietly changes sides when east is hazardous', () => {
  const f = flatFixture(); f.block('east')
  const r = planQuarryExit(f.args('east'))
  assert.equal(r.reason, 'EXIT_COLUMN_UNAVAILABLE')
  assert.equal(r.details.attempts.length, 16)
  assert.ok(r.details.attempts.every(a => a.side === 'east'))
  assert.equal(planQuarryExit(f.args('auto')).plan.side, 'west')
})

const observedCandidates = [
  { side: 'west', column: { x: -65, z: 41 }, entry: { x: -64, y: -59, z: 41 }, landing: { x: -66, y: 69, z: 41 }, totalDirt: 136 },
  { side: 'north', column: { x: -52, z: 31 }, entry: { x: -52, y: -59, z: 32 }, landing: { x: -52, y: 70, z: 30 }, totalDirt: 137 },
  { side: 'north', column: { x: -51, z: 31 }, entry: { x: -51, y: -59, z: 32 }, landing: { x: -51, y: 70, z: 30 }, totalDirt: 137 },
  { side: 'south', column: { x: -58, z: 48 }, entry: { x: -58, y: -59, z: 47 }, landing: { x: -58, y: 67, z: 49 }, totalDirt: 134 },
  { side: 'south', column: { x: -57, z: 48 }, entry: { x: -57, y: -59, z: 47 }, landing: { x: -57, y: 66, z: 49 }, totalDirt: 133 },
  { side: 'south', column: { x: -56, z: 48 }, entry: { x: -56, y: -59, z: 47 }, landing: { x: -56, y: 67, z: 49 }, totalDirt: 134 }
]

// This fixture explicitly represents the later, excavated pit. The current
// live entry is still solid; a separate test below preserves that refusal.
function observedFixture (selected, { buriedEntry = false } = {}) {
  const regions = buildRegions({ target: { chunks: [{ x: -4, z: 2 }] }, yTop: 63, yBottom: -59, worldMinY: -64, worldMaxY: 319 })
  const getBlock = (x, y, z) => {
    let name = 'stone'
    const inside = x >= -64 && x <= -49 && z >= 32 && z <= 47
    const landingBand = x === -47 && z >= 32 && z <= 47 || x === -66 && z >= 32 && z <= 47 || z === 30 && x >= -64 && x <= -49 || z === 49 && x >= -64 && x <= -49
    if (y <= -60) name = 'bedrock'
    else if (inside && y <= 63) name = 'air'
    else if (landingBand) { const cap = x === selected.landing.x && z === selected.landing.z ? selected.landing.y - 1 : 90; name = y <= cap ? 'stone' : 'air' }
    else name = y <= 68 ? 'stone' : 'air'
    if (buriedEntry && x === selected.entry.x && z === selected.entry.z && [selected.entry.y, selected.entry.y + 1].includes(y)) name = 'deepslate'
    return { known: true, position: { x, y, z }, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 2, extra: [], diggable: name !== 'bedrock' }
  }
  const inventory = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, maxDurability: 1561, durabilityRemaining: 1561 }, ...[1, 2, 3].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))]
  return { regions, yTop: 63, feet: selected.entry, reachable: new Map([[`${selected.entry.x},${selected.entry.y},${selected.entry.z}`, 0]]), getBlock, inventory, exit: { side: 'auto' } }
}

for (const expected of observedCandidates) {
  test(`the received ${expected.side} candidate ${expected.column.x},${expected.column.z} has the correct one-column orientation and dirt count`, () => {
    const r = planQuarryExit(observedFixture(expected))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.plan.side, expected.side)
    assert.deepEqual(r.plan.column, expected.column)
    assert.deepEqual(r.plan.entry, expected.entry)
    assert.deepEqual(r.plan.landing, expected.landing)
    assert.equal(r.plan.totalDirt, expected.totalDirt)
    assert.ok(r.plan.shaftCells.every(cell => cell.position.x === expected.column.x && cell.position.z === expected.column.z))
  })
}

test('an otherwise safe outside shaft cannot bypass a currently buried pit entrance', () => {
  const r = planQuarryExit(observedFixture(observedCandidates[0], { buriedEntry: true }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'EXIT_COLUMN_UNAVAILABLE')
  assert.ok(r.details.attempts.some(a => a.side === 'west' && a.column.z === 41 && a.reason === 'ENTRY_UNAVAILABLE'))
})

test('explicitly changing an existing east job to auto keeps its frozen migration floor', async () => {
  const f = flatFixture()
  f.sim.world.set(-4, 63, -4, 'chest')
  const job = createQuarryJob({ adapter: f.sim.adapter })
  job.plan({ jobId: 'side-migration', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90, exit: { mode: 'adjacent_pillar', side: 'east', migrationFloorY: 61 }, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } })
  const before = job.document()
  await job.configureExit({ side: 'auto', migrationFloorY: 60 })
  const after = job.document()
  assert.equal(after.config.exit.side, 'auto')
  assert.equal(after.config.exit.migrationFloorY, 61)
  assert.equal(after.deepestY, before.deepestY)
  assert.deepEqual(after.ledger, before.ledger)
  assert.deepEqual(after.config.inventory.storage, before.config.inventory.storage)
})
