'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')

const LOADED = { xMin: -12, xMax: 28, yMin: 50, yMax: 90, zMin: -12, zMax: 28 }
function setup ({ stoneTop = 60, top = 62, chestSlots = 27 } = {}) {
  const sim = createSim({ loaded: LOADED, chestSlots })
  flatTerrain(sim, { x1: LOADED.xMin, x2: LOADED.xMax, z1: LOADED.zMin, z2: LOADED.zMax, bedrock: 50, stoneTop, top })
  sim.world.set(-4, top + 1, -4, 'chest')
  sim.setFeet({ x: -3, y: top + 1, z: 5 })
  return sim
}
function job (sim, opts = {}) {
  const docs = []
  const j = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => { docs.push(doc) } }, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5, ...opts })
  return { j, docs }
}
const baseConfig = (extra = {}) => ({ jobId: 't', target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 60, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 }, stand: { x: -3, y: 63, z: -4 } }] }, ...extra })
async function runUntilStopped (j, limitMs = 60000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) { const s = j.status(); if (['PAUSED', 'FINISHED'].includes(s.state)) return s; await new Promise(r => setTimeout(r, 5)) }
  throw new Error(`timeout in ${j.status().state} ${JSON.stringify(j.status().lastDecision)}`)
}

test('T02 dry test area: top-down layers removed, drops stored, stair kept as an exception', async () => {
  const sim = setup()
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 10); sim.give('cobblestone', 16)
  const { j } = job(sim)
  const plan = j.plan(baseConfig())
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  assert.equal(plan.yTop, 62)
  j.start()
  let s = await runUntilStopped(j)
  assert.equal(s.state, 'PAUSED', JSON.stringify(s.result))
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', JSON.stringify(s.result))
  j.acceptExceptions()
  s = await runUntilStopped(j)
  assert.equal(s.result.type, 'COMPLETED_WITH_EXCEPTIONS', JSON.stringify(s.result))
  // Everything but the three stair steps is gone; nothing outside changed.
  let left = 0
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 60; y <= 62; y++) if (sim.world.name(x, y, z) !== 'air') left++
  assert.equal(left, 3)
  for (let y = 60; y <= 62; y++) for (const [x, z] of [[-1, 5], [16, 5], [5, -1], [5, 16]]) assert.notEqual(sim.world.name(x, y, z), 'air', `outside ${x},${y},${z}`)
  assert.equal(sim.world.name(5, 59, 5), 'stone')
  const stored = sim.chest.reduce((m, c) => { m[c.name] = (m[c.name] ?? 0) + c.count; return m }, {})
  const carried = sim.state.inventory.items.reduce((m, c) => { m[c.name] = (m[c.name] ?? 0) + c.count; return m }, {})
  // One layer each of grass, dirt and stone minus the three kept stair steps.
  assert.equal(s.ledger.minedBlocks, 765)
  assert.equal((stored['minecraft:cobblestone'] ?? 0) + (carried['minecraft:cobblestone'] ?? 0), 255 + 16)
  assert.equal((stored['minecraft:dirt'] ?? 0) + (carried['minecraft:dirt'] ?? 0), 510)
  assert.equal(s.ledgerDetail.lost.cobblestone ?? 0, 0)
  assert.equal(sim.entities.length, 0)
  const pick = sim.state.inventory.items.find(i => i.name === 'minecraft:diamond_pickaxe')
  assert.ok(pick.durabilityRemaining > 1000)
  const shovel = sim.state.inventory.items.find(i => i.name === 'minecraft:iron_shovel')
  assert.ok(shovel.durabilityRemaining >= 25, `shovel kept its reserve: ${shovel.durabilityRemaining}`)
})

test('T03 ore without a harvesting pickaxe is kept and mined after resupply', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.set(7, 61, 7, 'iron_ore')
  sim.give('wooden_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  let s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS')
  assert.equal(sim.world.name(7, 61, 7), 'iron_ore')
  assert.ok(s.deferred.some(d => d.position === '7,61,7' && d.reason === 'WAITING_FOR_TOOL'))
  sim.give('stone_pickaxe')
  j.resume()
  s = await runUntilStopped(j)
  assert.equal(sim.world.name(7, 61, 7), 'air')
  assert.ok(sim.chest.some(c => c.name === 'minecraft:raw_iron') || sim.state.inventory.items.some(i => i.name === 'minecraft:raw_iron'))
})

test('T05 a worn tool is never used below its reserve', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.give('stone_pickaxe'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const pick = sim.state.inventory.items.find(i => i.name === 'minecraft:stone_pickaxe')
  pick.durabilityRemaining = 30; pick.durabilityUsed = 101
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 61 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.state, 'PAUSED')
  assert.ok(pick.durabilityRemaining >= 14, `reserve kept: ${pick.durabilityRemaining}`)
  assert.ok(s.deferred.some(d => d.reason === 'TOOL_DURABILITY_RESERVE'))
})

test('T06/T08 full bag and full storage: no dropping, waits for storage', async () => {
  const sim = setup({ stoneTop: 62, top: 62, chestSlots: 1 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5)
  for (let i = 0; i < 26; i++) sim.give('andesite', 64)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 62 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'WAITING_FOR_STORAGE', JSON.stringify(s.result))
  assert.ok(s.pauseDetails.needFreeSlots === 6)
  // Nothing was thrown away and no extra drops lie around beyond one batch.
  assert.ok(sim.entities.length <= 8, `ground items ${sim.entities.length}`)
})

test('T09 falling blocks are removed from the top, never from below', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.world.fill(5, 61, 5, 5, 64, 5, 'sand'); sim.world.fill(6, 61, 6, 6, 63, 6, 'gravel')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  sim.hooks.beforeMine = t => { const above = sim.world.name(t.x, t.y + 1, t.z); if (/sand|gravel/.test(above)) throw new Error(`dug under falling block at ${t.x},${t.y},${t.z}`) }
  const { j } = job(sim)
  const plan = j.plan(baseConfig({ yBottom: 61 }))
  assert.equal(plan.yTop, 64)
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', JSON.stringify(s.result))
  for (let y = 61; y <= 64; y++) { assert.equal(sim.world.name(5, y, 5), 'air'); assert.equal(sim.world.name(6, y, 6), 'air') }
})

test('T10 a cave under the layer never becomes a standing place', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.fill(3, 55, 3, 12, 60, 12, 'air')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 61 }))
  j.start()
  const s = await runUntilStopped(j)
  // moveTo in the simulation refuses unsupported stances; the job finished the
  // layers without one.
  assert.ok(['UNRESOLVED_EXCEPTIONS'].includes(s.pauseReason), JSON.stringify(s.result))
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (!(x <= 2 && z === 0)) assert.equal(sim.world.name(x, 61, z), 'air', `${x},61,${z}`)
})

test('T11/T12/T22 water: inside pool plugged and re-mined, outside inflow sealed in the margin', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.set(8, 62, 8, 'water'); sim.world.set(9, 62, 8, 'water')
  sim.world.set(16, 61, 4, 'water')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 61 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', JSON.stringify(s.result))
  assert.equal(sim.world.name(16, 61, 4), 'cobblestone')
  assert.ok(s.seals.some(x => x.position === '16,61,4'))
  assert.equal(sim.world.name(8, 62, 8), 'air'); assert.equal(sim.world.name(9, 62, 8), 'air')
  assert.equal(s.ledgerDetail.reminedTemporary.cobblestone, 2)
  assert.equal(s.ledgerDetail.placedSeal.cobblestone, 1)
  // Plug blocks never count as natural mining.
  assert.equal(s.ledger.minedBlocks, 256 * 2 - 2 - 2)
})

test('T24 a seal needed outside the permitted cells pauses with the position', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.set(4, 60, 4, 'water')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 61 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'SEAL_OUTSIDE_PERMITTED_REGION')
  assert.deepEqual(s.pauseDetails.fluid, { x: 4, y: 60, z: 4 })
  assert.equal(sim.world.name(4, 61, 4), 'stone')
})

test('T14 containers and spawners are left with a reason', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.set(10, 62, 10, 'chest'); sim.world.set(3, 61, 12, 'mob_spawner')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 61 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(sim.world.name(10, 62, 10), 'chest'); assert.equal(sim.world.name(3, 61, 12), 'mob_spawner')
  assert.equal(sim.world.name(10, 61, 10), 'stone', 'support under a protected block stays')
  const reasons = Object.fromEntries(s.result.pauseDetails.exceptions.filter(e => e.position).map(e => [e.position, e.reason]))
  assert.equal(reasons['10,62,10'], 'CONTAINER_OR_FACILITY'); assert.equal(reasons['3,61,12'], 'SPAWNER_OR_TRIAL'); assert.equal(reasons['10,61,10'], 'SUPPORTS_PROTECTED')
})
