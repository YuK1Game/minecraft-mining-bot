'use strict'

// Isolation-aware layer planning (live 2026-11-11 13:08: a layer dug over a
// cave left the bot on an island of kept ore with no way down).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

const bounds = { xMin: -6, xMax: 21, yMin: 50, yMax: 70, zMin: -6, zMax: 21 }
function world ({ caveFrom = 57, caveTo = 60, cave = () => false } = {}) {
  const sim = createSim({ loaded: bounds })
  flatTerrain(sim, { x1: bounds.xMin, x2: bounds.xMax, z1: bounds.zMin, z2: bounds.zMax, bedrock: 50, stoneTop: 61, top: 62 })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (cave(x, z)) for (let y = caveFrom; y <= caveTo; y++) sim.world.set(x, y, z, 'air')
  return sim
}
function planner (sim, { yTop = 62, yBottom = 56 } = {}) {
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop, yBottom, worldMinY: 50, worldMaxY: 70, travelRegion: [{ xMin: 0, xMax: 15, yMin: 50, yMax: 70, zMin: 0, zMax: 15 }] })
  return createQuarryPlanner({ regions, getBlock: (x, y, z) => sim.adapter.getBlock(x, y, z) })
}
const cells = (y, filter = () => true) => {
  const out = []
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (filter(x, z)) out.push({ position: { x, y, z } })
  return out
}

test('isolation: a layer dug over a cave keeps a way down only through its grounded cells', () => {
  // Cave under every column except x >= 12: layer 61 has grounded cells only there.
  const sim = world({ cave: x => x < 12 })
  const p = planner(sim)
  const feet = { x: 5, y: 62, z: 5 } // on layer 61, after layer 62 is dug
  for (const c of cells(62)) sim.world.set(c.position.x, 62, c.position.z, 'air')
  const pending = cells(61)
  assert.equal(p.grounded({ x: 2, y: 61, z: 2 }), false)
  assert.equal(p.grounded({ x: 13, y: 61, z: 2 }), true)
  assert.equal(p.exitAfter(feet, [], 61, pending).down, true, 'grounded cells next to the walkable top keep a way down')
  // Digging the grounded cells themselves opens the way down (they become
  // stances on the next level) ...
  assert.equal(p.exitAfter(feet, cells(61, x => x >= 12), 61, pending).down, true)
  // ... but digging the band over the cave between the bot and them leaves the
  // bot cut off: no way down remains from where it stands.
  assert.equal(p.exitAfter(feet, cells(61, x => x >= 6 && x < 12), 61, pending).down, false)
})

test('isolation: a kept ore over a cave never becomes the last stance (island)', () => {
  // Cave under x < 12; the bot stands on a kept ore at (3,61,3) over it.
  const sim = world({ cave: x => x < 12 })
  sim.world.set(3, 61, 3, 'diamond_ore')
  for (const c of cells(62)) sim.world.set(c.position.x, 62, c.position.z, 'air')
  const p = planner(sim)
  const feet = { x: 3, y: 62, z: 3 }
  const pending = cells(61, (x, z) => !(x === 3 && z === 3))
  // A batch removing the cells that link the ore to the grounded side is cut
  // back so the walkable area still reaches a way down.
  const ring = cells(61, (x, z) => Math.abs(x - 3) <= 1 && Math.abs(z - 3) <= 1 && !(x === 3 && z === 3))
  assert.equal(p.exitAfter(feet, ring, 61, pending).down, false, 'removing the ring strands the bot on the ore')
  assert.equal(p.exitAfter(feet, [], 61, pending).down, true)
})

test('isolation: a layer with a single way down keeps it until the layer allows stepping into it', () => {
  // Only (15,60,15) is solid under layer 61: exactly one way down.
  const sim = world({ cave: (x, z) => !(x === 15 && z === 15) })
  for (const c of cells(62)) sim.world.set(c.position.x, 62, c.position.z, 'air')
  const p = planner(sim)
  const feet = { x: 14, y: 62, z: 14 }
  const pending = cells(61)
  assert.equal(p.exitAfter(feet, [], 61, pending).down, true)
  // Removing the cells around the only grounded cell (but not the cell itself)
  // still leaves it reachable only if a stance next to it remains.
  const around = cells(61, (x, z) => (x === 14 || x === 15) && (z === 14 || z === 15) && !(x === 15 && z === 15))
  assert.equal(p.exitAfter(feet, around, 61, pending).down, false, 'the stances next to the way down are kept')
})

test('isolation: a layer over a cave with no way down pauses before any of its cells is dug', async () => {
  const sim = world({ caveFrom: 60, caveTo: 60, cave: () => true })
  sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 10); sim.give('dirt', 224); sim.give('cobblestone', 64)
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, sleep: () => new Promise(resolve => setImmediate(resolve)) })
  const config = { jobId: 'isolation', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 56, worldMinY: 50, worldMaxY: 70, exit: { mode: 'legacy_stair' }, inventory: { carryOnly: true, minFreeSlots: 1 } }
  const planned = job.plan(config)
  assert.equal(planned.ready, true, JSON.stringify(planned.issues))
  job.start()
  try {
    const end = Date.now() + 20000
    while (job.status().state !== 'PAUSED' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
    const s = job.status()
    assert.equal(s.pauseReason, 'LAYER_ISOLATION_RISK', JSON.stringify(s.pauseDetails))
    assert.equal(s.pauseDetails.y, 61)
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) assert.notEqual(sim.world.name(x, 61, z), 'air', 'no cell of the isolating layer was dug')
  } finally { await job.pause() }
})
