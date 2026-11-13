'use strict'

// Cave floors (user spec 2026-11-13): a void under the next standing cell is
// filled with an ordinary block instead of writing the work off or stopping.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')

test('a deep cave gap is bridged with a placed floor instead of deferring the far work as UNREACHABLE', async () => {
  // Floor strip at y=50 for x 0..3 and x 8..15 (z 0..2); between them a cave
  // down to y=40. Rock pillar targets at x=13 above the far strip.
  const solid = []
  for (let x = 0; x <= 15; x++) for (let z = 0; z <= 2; z++) if (x < 4 || x > 7) for (let y = 41; y <= 50; y++) solid.push([x, y, z])
  for (let y = 51; y <= 53; y++) solid.push([13, y, 1])
  // The gap is a narrow cave: its side walls at the walking level are chests
  // (clickable but never a floor), so only the middle row needs a new floor.
  for (let x = 4; x <= 7; x++) for (const z of [0, 2]) solid.push([x, 50, z, 'minecraft:chest'])
  const k = (x, y, z) => `${x},${y},${z}`
  const set = new Map(solid.map(([x, y, z, name]) => [k(x, y, z), name ?? 'minecraft:stone']))
  const read = (x, y, z) => {
    const rock = set.has(k(x, y, z)) || y <= 40 || false
    return { known: true, position: { x, y, z }, name: rock ? (set.get(k(x, y, z)) ?? 'minecraft:stone') : 'minecraft:air', boundingBox: rock ? 'block' : 'empty', runtimeId: rock ? 2 : 0, properties: {}, extra: [], diggable: true }
  }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 53, yBottom: 50, worldMinY: 30, worldMaxY: 80, travelRegion: [{ xMin: 0, xMax: 15, yMin: 30, yMax: 80, zMin: 0, zMax: 2 }] })
  const planner = createQuarryPlanner({ regions, getBlock: read, records: { deferred: {} }, exit: { mode: 'adjacent_pillar', reservedDirt: 0 } })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }]
  const items = [...tools, { slot: 1, name: 'minecraft:cobblestone', count: 64 }]
  let decision = null
  // Fill one floor cell at a time (simulating the server placing it) until the
  // far pillar becomes minable.
  for (let i = 0; i < 8; i++) {
    decision = await planner.next({ feet: { x: 1, y: 51, z: 1 }, yTop: 53, tools, inventoryItems: items })
    if (decision.action !== 'seal') break
    assert.equal(decision.purpose, 'floor'); assert.equal(decision.reason, 'CAVE_FLOOR_FILL')
    assert.equal(decision.position.y, 50, 'the floor is placed at the walking level of the strip')
    assert.ok(decision.position.x >= 4 && decision.position.x <= 7 && decision.position.z === 1, JSON.stringify(decision.position))
    set.set(k(decision.position.x, decision.position.y, decision.position.z), 'minecraft:cobblestone')
    planner.recordPlacement(decision.position, 'floor', 'cobblestone')
  }
  assert.equal(decision.action, 'mine', JSON.stringify(decision).slice(0, 300))
  assert.equal(Object.values(planner.exportRecords().deferred).filter(v => v.reason === 'UNREACHABLE').length, 0)
  assert.ok(planner.temporaryList().some(t => t.purpose === 'floor'))
})

test('without placeable material the old deferral stays', async () => {
  const solid = []
  for (let x = 0; x <= 15; x++) for (let z = 0; z <= 2; z++) if (x < 4 || x > 7) for (let y = 41; y <= 50; y++) solid.push([x, y, z])
  for (let y = 51; y <= 53; y++) solid.push([13, y, 1])
  const k = (x, y, z) => `${x},${y},${z}`
  const set = new Set(solid.map(([x, y, z]) => k(x, y, z)))
  const read = (x, y, z) => { const rock = set.has(k(x, y, z)) || y <= 40 || false; return { known: true, position: { x, y, z }, name: rock ? 'minecraft:stone' : 'minecraft:air', boundingBox: rock ? 'block' : 'empty', runtimeId: rock ? 2 : 0, properties: {}, extra: [], diggable: true } }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 53, yBottom: 50, worldMinY: 30, worldMaxY: 80, travelRegion: [{ xMin: 0, xMax: 15, yMin: 30, yMax: 80, zMin: 0, zMax: 2 }] })
  const planner = createQuarryPlanner({ regions, getBlock: read, records: { deferred: {} }, exit: { mode: 'adjacent_pillar', reservedDirt: 0 } })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }]
  const decision = await planner.next({ feet: { x: 1, y: 51, z: 1 }, yTop: 53, tools, inventoryItems: tools })
  assert.notEqual(decision.action, 'seal')
})

test('no floor is filled into the layer being dug, and a filled cell mined since is never refilled', async () => {
  // The strip stands on layer 50 rock; work at layer 51 beyond a gap. A floor
  // at y=50 would be in the layer below 51 (allowed), but once layer 50 is the
  // work layer a fill there would be mined again at once (live loop 01:57).
  const solid = []
  for (let x = 0; x <= 15; x++) for (let z = 0; z <= 2; z++) if (x < 4 || x > 7) for (let y = 41; y <= 50; y++) solid.push([x, y, z])
  for (let x = 4; x <= 7; x++) for (const z of [0, 2]) solid.push([x, 50, z, 'minecraft:chest'])
  const k = (x, y, z) => `${x},${y},${z}`
  const set = new Map(solid.map(([x, y, z, name]) => [k(x, y, z), name ?? 'minecraft:stone']))
  const read = (x, y, z) => { const rock = set.has(k(x, y, z)) || y <= 40; return { known: true, position: { x, y, z }, name: rock ? (set.get(k(x, y, z)) ?? 'minecraft:stone') : 'minecraft:air', boundingBox: rock ? 'block' : 'empty', runtimeId: rock ? 2 : 0, properties: {}, extra: [], diggable: true } }
  // Layer 50 itself is the top work layer: the far strip cells at x>7 are its pending work.
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 50, yBottom: 45, worldMinY: 30, worldMaxY: 80, travelRegion: [{ xMin: 0, xMax: 15, yMin: 30, yMax: 80, zMin: 0, zMax: 2 }] })
  const planner = createQuarryPlanner({ regions, getBlock: read, records: { deferred: {}, temporary: { '4,49,1': { purpose: 'floor', material: 'cobblestone' } } }, exit: { mode: 'adjacent_pillar', reservedDirt: 0 } })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }]
  const items = [...tools, { slot: 1, name: 'minecraft:cobblestone', count: 64 }]
  for (let i = 0; i < 4; i++) {
    const decision = await planner.next({ feet: { x: 1, y: 51, z: 1 }, yTop: 50, tools, inventoryItems: items })
    if (decision.action !== 'seal') break
    assert.ok(decision.position.y < 50, 'never into the work layer: ' + JSON.stringify(decision.position))
    assert.notDeepEqual(decision.position, { x: 4, y: 49, z: 1 }, 'a previously filled cell is not refilled')
    set.set(k(decision.position.x, decision.position.y, decision.position.z), 'minecraft:cobblestone')
    planner.recordPlacement(decision.position, 'floor', 'cobblestone')
  }
})
