'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')

// Modeled on the live 2026-11-10 case: below the work layer is a deep cave
// (known air), so stands exist only on the remaining rock of the work layer.
function cave (solid) {
  const k = (x, y, z) => `${x},${y},${z}`
  const set = new Set(solid.map(([x, y, z]) => k(x, y, z)))
  const read = (x, y, z) => {
    const rock = set.has(k(x, y, z)) || y <= 40
    return { known: true, position: { x, y, z }, name: rock ? 'minecraft:stone' : 'minecraft:air', boundingBox: rock ? 'block' : 'empty', runtimeId: rock ? 2 : 0, properties: {}, extra: [], diggable: true }
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
