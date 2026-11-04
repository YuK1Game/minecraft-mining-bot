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
  assert.equal(s.pauseReason, 'WAITING_FOR_TOOL')
  assert.equal(s.pauseDetails.needs['pickaxe:2'], 1)
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
  // The only chest is full and there is no chest or wood to add another one.
  assert.equal(s.pauseDetails.reason, 'all chests full', JSON.stringify(s.pauseDetails))
  assert.equal(s.pauseDetails.addChest?.reason, 'NO_CHEST_MATERIAL', JSON.stringify(s.pauseDetails))
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

test('live case: no pickaxe digs the soft layers, then waits for a tool instead of finishing', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('bread', 5); sim.give('cobblestone', 8)
  const { j } = job(sim)
  const plan = j.plan(baseConfig({ yBottom: 59 }))
  assert.equal(plan.ready, true)
  assert.ok(plan.warnings.some(w => w.code === 'NO_PICKAXE'))
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(s.state, 'PAUSED')
  assert.equal(s.pauseReason, 'WAITING_FOR_TOOL')
  assert.ok(s.pauseDetails.needs['pickaxe:1'] > 0)
  assert.ok(s.ledger.minedBlocks > 0, 'grass and dirt are still dug')
  const again = await j.pause()
  assert.equal(again.userRunIntent, 'paused')
})

test('live case: an escape that carries the bot outside the area does not defer the job as unreachable', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('stone_pickaxe'); sim.give('stone_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const deadline = Date.now() + 20000
  while (sim.stats.mined < 10 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  sim.setCombat(true)
  while (j.status().state !== 'COMBAT' && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  sim.setFeet({ x: 8, y: 63, z: 24 }) // escape ends 7 blocks outside the chunk
  sim.setCombat(false)
  const s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', JSON.stringify(s.pauseDetails))
  assert.equal(s.pauseDetails.byReason.UNREACHABLE ?? 0, 0, JSON.stringify(s.pauseDetails.byReason))
  assert.ok(sim.stats.mined > 300)
})

test('live case: escape to lower ground outside the area (below the job bottom) rebinds once and returns', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.world.fill(6, 61, 22, 10, 62, 26, 'air') // a dip beside the area, lower than the job bottom
  sim.world.set(8, 61, 22, 'dirt') // one step out of the dip
  sim.give('stone_pickaxe'); sim.give('stone_shovel'); sim.give('bread', 5)
  const lines = []
  const { j } = job(sim, { log: m => lines.push(m) })
  assert.equal(j.plan(baseConfig({ yBottom: 62 })).ready, true)
  j.start()
  const deadline = Date.now() + 20000
  while (sim.stats.mined < 5 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  sim.setCombat(true)
  while (j.status().state !== 'COMBAT' && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  sim.setFeet({ x: 8, y: 61, z: 24 })
  sim.setCombat(false)
  const s = await runUntilStopped(j)
  assert.equal(s.pauseDetails?.byReason?.UNREACHABLE ?? 0, 0, JSON.stringify(s.pauseDetails))
  const rebinds = lines.filter(m => m.includes('travel_rebound')).length
  assert.ok(rebinds <= 2, `rebinds ${rebinds}`)
  assert.ok(sim.stats.mined >= 250, `mined ${sim.stats.mined} ${s.pauseReason} ${JSON.stringify(s.pauseDetails?.byReason)} ${JSON.stringify(s.counts)}`)
})

test('live case: digging by hand with an empty hotbar swaps in a stack from the main inventory', async () => {
  const sim = setup({ stoneTop: 58, top: 62 })
  sim.give('diamond_pickaxe')
  // Hotbar 1..8 empty (as right after a deposit); the only non-tool stacks are in the main inventory.
  sim.give('bread', 5); sim.give('cobblestone', 8)
  for (const i of sim.state.inventory.items) if (/bread|cobblestone/.test(i.name)) i.slot += 20
  sim.state.selectedSlot = 0; sim.state.heldItem = { name: 'minecraft:diamond_pickaxe', slot: 0 }
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const s = await runUntilStopped(j)
  assert.ok(!String(s.pauseReason).startsWith('ACTION_FAILED'), JSON.stringify(s.result))
  assert.ok(s.ledger.minedBlocks > 0)
})

test('full chest: the bot adds a chest beside it (from carried wood) and keeps depositing', async () => {
  const sim = setup({ stoneTop: 62, top: 62, chestSlots: 1 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('oak_log', 4)
  for (let i = 0; i < 26; i++) sim.give('andesite', 64)
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 62 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.ok((sim.stats.chestsAdded ?? 0) >= 1, `chests added ${sim.stats.chestsAdded} ${s.pauseReason} ${JSON.stringify(s.pauseDetails)}`)
  const doc = j.document()
  const added = doc.config.inventory.storage.slice(1)
  assert.ok(added.length >= 1)
  const first = doc.config.inventory.storage[0].position
  for (const st of added) {
    const p = st.position
    assert.equal(sim.getBlock(p.x, p.y, p.z).name, 'minecraft:chest')
    assert.ok(p.x < 0 || p.z < 0 || p.x > 15 || p.z > 15, `new chest ${JSON.stringify(p)} is outside the dug chunk`)
    assert.ok(Math.abs(p.x - first.x) + Math.abs(p.z - first.z) > 1 || p.y !== first.y, 'new chest does not touch the first one')
    assert.ok(sim.chests.get(`${p.x},${p.y},${p.z}`)?.length >= 1, 'items went into the new chest')
  }
  assert.equal(s.ledger.lost ?? 0, 0)
  // With wood used up and every chest full it finally waits for the user.
  if (s.pauseReason === 'WAITING_FOR_STORAGE') assert.equal(s.pauseDetails.reason, 'all chests full')
})

test('collection picks up every item lying in the area, not just the first 24', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  // 40 stray items scattered on the surface inside the area.
  for (let n = 0; n < 40; n++) sim.entities.push({ id: 5000 + n, name: 'minecraft:stick', count: 1, position: { x: 1.5 + (n % 8) * 1.7, y: 63, z: 1.5 + Math.floor(n / 8) * 2.5 } })
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const s = await runUntilStopped(j)
  const sticks = sim.entities.filter(e => e.name === 'minecraft:stick').length
  assert.equal(sticks, 0, `sticks left ${sticks} (${s.pauseReason})`)
})
