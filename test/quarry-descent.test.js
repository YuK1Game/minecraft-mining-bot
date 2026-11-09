'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')

// Modeled on the live 2026-11-10 case: below the work layer is a deep cave
// (known air), so stands exist only on the remaining rock of the work layer.
function cave (solid) {
  const k = (x, y, z) => `${x},${y},${z}`
  const set = new Map(solid.map(([x, y, z, name]) => [k(x, y, z), name ?? 'minecraft:stone']))
  const read = (x, y, z) => {
    const rock = set.has(k(x, y, z)) || y <= 40
    return { known: true, position: { x, y, z }, name: rock ? (set.get(k(x, y, z)) ?? 'minecraft:stone') : 'minecraft:air', boundingBox: rock ? 'block' : 'empty', runtimeId: rock ? 2 : 0, properties: {}, extra: [], diggable: true }
  }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 61, yBottom: 41, worldMinY: 30, worldMaxY: 80, travelRegion: [{ xMin: -3, xMax: 18, yMin: 30, yMax: 80, zMin: -3, zMax: 18 }] })
  const planner = createQuarryPlanner({ regions, getBlock: read, records: { deferred: {} }, exit: { mode: 'adjacent_pillar' } })
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1000, maxDurability: 1561 }]
  return { planner, tools }
}

test('cut off on a pillar above a cave: the job stops with DESCENT_REQUIRED instead of deferring every lower layer', async () => {
  // Only the pillar under the bot and a far wall remain; layers 60..41 are a cave down to y=40 rock.
  const f = cave([[5, 61, 5], [15, 50, 15]])
  const decision = await f.planner.next({ feet: { x: 5, y: 62, z: 5 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  assert.equal(decision.action, 'pause', JSON.stringify(decision).slice(0, 300))
  assert.equal(decision.reason, 'DESCENT_REQUIRED')
  assert.equal(Object.values(f.planner.exportRecords().deferred).filter(v => v.reason === 'UNREACHABLE').length, 0, 'no layer is written off')
})

test('a batch never strands its stance on a pillar above the cave', async () => {
  // A 3-cell rock strip over the cave; the bot stands on its west end.
  const f = cave([[0, 61, 0], [1, 61, 0], [2, 61, 0]])
  const decision = await f.planner.next({ feet: { x: 0, y: 62, z: 0 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  assert.equal(decision.action, 'mine', JSON.stringify(decision).slice(0, 300))
  // Whatever the stance, at least one strip cell next to it must remain as a walkable floor.
  const removed = new Set(decision.targets.map(t => t.position.x))
  const st = decision.stance
  const neighbours = [st.x - 1, st.x + 1].filter(x => x >= 0 && x <= 2 && !removed.has(x))
  assert.ok(neighbours.length >= 1, 'the stance is not left alone on a pillar: ' + JSON.stringify({ stance: st, targets: decision.targets.map(c => c.position) }))
})

test('reopenWorkLayer is refused unless paused and needs a box at or above the new layer', async () => {
  const { createQuarryJob } = require('../src/quarry-job')
  const { createSim, flatTerrain } = require('./helpers/quarry-sim')
  const sim = createSim({ loaded: { xMin: -4, xMax: 20, yMin: 50, yMax: 70, zMin: -4, zMax: 20 } })
  flatTerrain(sim, { x1: -4, x2: 20, z1: -4, z2: 20, bedrock: 50, stoneTop: 61, top: 62 })
  sim.setFeet({ x: -1, y: 63, z: 0 }); sim.give('diamond_pickaxe'); sim.give('dirt', 192)
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, pollMs: 5 })
  job.plan({ jobId: 'reopen', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 55, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true } })
  await assert.rejects(() => job.reopenWorkLayer({ y: 61, box: { xMin: 0, xMax: 3, yMin: 61, yMax: 61, zMin: 0, zMax: 3 } }), /paused/)
})

test('a large whole layer out of reach from a wider island is not written off either', async () => {
  // A 3x2 island of protected ore (6 stands, never mined) above the cave; the remaining work is a far wall below.
  const island = []; for (let x = 4; x <= 6; x++) for (let z = 4; z <= 5; z++) island.push([x, 61, z, 'minecraft:iron_ore'])
  const wall = []; for (let x = 0; x <= 15; x++) for (let y = 45; y <= 50; y++) wall.push([x, y, 15])
  const f = cave([...island, ...wall])
  const decision = await f.planner.next({ feet: { x: 5, y: 62, z: 4 }, yTop: 61, tools: f.tools, inventoryItems: f.tools })
  const written = Object.values(f.planner.exportRecords().deferred).filter(v => v.reason === 'UNREACHABLE').length
  assert.ok(decision.action === 'pause' ? decision.reason === 'DESCENT_REQUIRED' : decision.action === 'mine', JSON.stringify(decision).slice(0, 300))
  assert.ok(written < 16, 'no large layer is written off: ' + written)
})

test('plan refuses a target with a large cave below the surface unless allowCaves is set', () => {
  const { createQuarryJob } = require('../src/quarry-job')
  const { createSim, flatTerrain } = require('./helpers/quarry-sim')
  const make = (cave) => {
    const sim = createSim({ loaded: { xMin: -4, xMax: 20, yMin: 50, yMax: 80, zMin: -4, zMax: 20 } })
    flatTerrain(sim, { x1: -4, x2: 20, z1: -4, z2: 20, bedrock: 50, stoneTop: 69, top: 70 })
    if (cave) for (let x = 2; x <= 13; x++) for (let z = 2; z <= 13; z++) for (let y = 52; y <= 66; y++) sim.world.set(x, y, z, 'air')
    sim.setFeet({ x: -1, y: 71, z: 0 }); sim.give('diamond_pickaxe'); sim.give('dirt', 192); sim.give('purple_shulker_box', 2)
    return createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, pollMs: 5 })
  }
  const base = { target: { chunks: [{ x: 0, z: 0 }] }, yTop: 'auto', yBottom: 51, worldMinY: 50, worldMaxY: 80, inventory: { carryOnly: true } }
  const solid = make(false).plan({ ...base, jobId: 'cave-solid' })
  assert.ok(!solid.issues.includes('CAVE_VOLUME_HIGH'), JSON.stringify(solid.caveSurvey))
  const refused = make(true).plan({ ...base, jobId: 'cave-big' })
  assert.ok(refused.issues.includes('CAVE_VOLUME_HIGH'), JSON.stringify(refused.caveSurvey))
  assert.ok(refused.caveSurvey.ratio > 0.2 && refused.caveSurvey.longestRun >= 15)
  const allowed = make(true).plan({ ...base, jobId: 'cave-allowed', allowCaves: true })
  assert.ok(!allowed.issues.includes('CAVE_VOLUME_HIGH'))
  assert.ok(allowed.warnings.some(w => w.code === 'CAVE_VOLUME_HIGH' && w.overridden))
})
