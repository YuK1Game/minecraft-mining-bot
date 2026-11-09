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
const baseConfig = (extra = {}) => ({ jobId: 't', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 60, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 }, stand: { x: -3, y: 63, z: -4 } }] }, ...extra })
async function runUntilStopped (j, limitMs = 60000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) { const s = j.status(); if (['PAUSED', 'FINISHED'].includes(s.state)) return s; await new Promise(r => setTimeout(r, 5)) }
  throw new Error(`timeout in ${j.status().state} ${JSON.stringify(j.status().lastDecision)}`)
}

test('display status returns cached counts without a synchronous scan and isolates new jobs', async () => {
  const sim = setup()
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  let reads = 0; let revision = 0
  const read = sim.adapter.getBlock
  sim.adapter.getBlock = (...args) => { reads++; return read(...args) }
  sim.adapter.worldRevision = () => revision
  const { j } = job(sim)
  j.plan(baseConfig({ jobId: 'old', yBottom: 61 }))
  const before = reads
  assert.equal(j.status().counts, null)
  assert.equal(reads, before, 'status did not scan any world cells')
  j.plan(baseConfig({ jobId: 'new', yTop: 62, yBottom: 62 }))
  revision++
  let status = j.status()
  const until = Date.now() + 5000
  while (!status.counts && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 5)); status = j.status() }
  assert.equal(status.jobId, 'new')
  assert.equal(status.counts.remaining, 255)
  assert.equal(status.counts.reserved, 1)
  assert.equal(status.counts.unknown, 0)
})

test('mining never credits air from another dimension or life after an asynchronous result', async () => {
  for (const mode of ['dimension_interrupt', 'new_life_result']) {
    const sim = setup()
    sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
    let changed = false
    const read = sim.adapter.getBlock
    sim.adapter.getBlock = (...args) => changed ? { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } : read(...args)
    sim.adapter.mine = async () => {
      changed = true
      if (mode === 'dimension_interrupt') {
        sim.state.dimension = 'nether'; sim.state.phase = 'connecting'
        await new Promise(resolve => setTimeout(resolve, 50))
      } else sim.state.lifecycle.deathId++
      return { phase: 'completed' }
    }
    const { j } = job(sim)
    assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
    j.start()
    try {
      const until = Date.now() + 3000
      let s = j.status()
      while (s.lastAction?.status !== 'interrupted' && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 5)); s = j.status() }
      assert.equal(s.lastAction?.status, 'interrupted', mode)
      assert.equal(s.lastAction.confirmationSkipped, 'STALE_SCOPE', mode)
      assert.equal(s.ledger.minedBlocks ?? 0, 0, mode)
      assert.equal(sim.stats.mined, 0)
    } finally { await j.pause() }
  }
})

test('mining retains received partial air on same-life combat and manual interruptions', async () => {
  for (const mode of ['combat', 'pause', 'emergencyStop', 'cancel']) {
    const sim = setup()
    sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
    let started = false
    sim.adapter.mine = (targets, { signal }) => new Promise((resolve, reject) => {
      const t = targets[0]
      sim.world.set(t.x, t.y, t.z, 'air')
      sim.stats.mined++
      signal.addEventListener('abort', () => reject(new Error('controller stopped')), { once: true })
      started = true
    })
    const { j } = job(sim)
    assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
    j.start()
    try {
      let until = Date.now() + 3000
      while (!started && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(started, true, mode)
      if (mode === 'combat') {
        sim.setCombat(true)
        until = Date.now() + 3000
        while (j.status().state !== 'COMBAT' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
      } else { await j[mode](); await j.drain() }
      const s = j.status()
      assert.equal(s.ledger.minedBlocks, 1, mode)
      assert.equal(s.lastAction.status, 'interrupted', mode)
      assert.equal(s.lastAction.results.filter(r => r.result === 'removed').length, 1, mode)
    } finally { await j.pause() }
  }
})

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
  assert.ok(shovel.durabilityRemaining >= 1, `shovel kept its last use: ${shovel.durabilityRemaining}`)
})

test('T03 ores stay protected through tool resupply and explicit exception acceptance', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.world.set(7, 61, 7, 'iron_ore')
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  let s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS')
  assert.equal(sim.world.name(7, 61, 7), 'iron_ore')
  assert.ok(s.deferred.some(d => d.position === '7,61,7' && d.reason === 'PROTECTED_ORE'))
  sim.give('diamond_pickaxe')
  j.resume()
  s = await runUntilStopped(j)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS')
  assert.equal(sim.world.name(7, 61, 7), 'iron_ore')
  j.acceptExceptions()
  s = await runUntilStopped(j)
  assert.equal(s.result.type, 'COMPLETED_WITH_EXCEPTIONS')
  assert.equal(sim.world.name(7, 61, 7), 'iron_ore')
  assert.equal(sim.chest.some(c => c.name === 'minecraft:raw_iron') || sim.state.inventory.items.some(i => i.name === 'minecraft:raw_iron'), false)
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
  assert.equal(pick.durabilityRemaining, 1, `last use kept: ${pick.durabilityRemaining}`)
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
  assert.equal(sim.world.name(10, 61, 10), 'air', 'a chest does not fall, so the stone under it is mined (2026-11-10)')
  const reasons = Object.fromEntries(s.result.pauseDetails.exceptions.filter(e => e.position).map(e => [e.position, e.reason]))
  assert.equal(reasons['10,62,10'], 'CONTAINER_OR_FACILITY'); assert.equal(reasons['3,61,12'], 'SPAWNER_OR_TRIAL'); assert.equal(reasons['10,61,10'], undefined)
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

test('collection chooses the shorter walking route instead of an item across a wall', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  sim.world.fill(1, 63, -2, 1, 65, 16, 'stone')
  sim.entities.push({ id: 6001, name: 'minecraft:stick', count: 1, position: { x: 3.5, y: 63, z: 5.5 } })
  sim.entities.push({ id: 6002, name: 'minecraft:stick', count: 1, position: { x: -0.5, y: 63, z: 12.5 } })
  const { j } = job(sim)
  let firstMove = null
  const move = sim.adapter.moveTo
  sim.adapter.moveTo = async (stance, options) => { firstMove ??= { ...stance }; return move(stance, options) }
  assert.equal(j.plan(baseConfig({ yTop: 62, yBottom: 62, strategy: { collectPendingDrops: 1 } })).ready, true)
  j.start()
  try {
    const until = Date.now() + 5000
    while (!firstMove && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(firstMove, 'collection makes progress')
    assert.ok(firstMove.z >= 11 && firstMove.x <= 0, JSON.stringify(firstMove))
  } finally { await j.pause() }
})

test('collection visits an old drop before newer closer drops at the collection deadline', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  sim.entities.push({ id: 6101, name: 'minecraft:stick', count: 1, position: { x: 14.5, y: 63, z: 14.5 } })
  let clock = 0; let armed = false; let nextMove = null
  const { j } = job(sim, { now: () => clock })
  sim.hooks.afterMine = () => {
    if (armed) return
    armed = true; clock = 25000
    const f = sim.feet()
    sim.entities.push({ id: 6102, name: 'minecraft:stick', count: 1, position: { x: f.x + 0.5, y: f.y, z: f.z + 3.5 } })
  }
  const move = sim.adapter.moveTo
  sim.adapter.moveTo = async (stance, options) => { if (armed) nextMove ??= { ...stance }; return move(stance, options) }
  assert.equal(j.plan(baseConfig({ yTop: 62, yBottom: 62 })).ready, true)
  j.start()
  try {
    const until = Date.now() + 5000
    while (!nextMove && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(nextMove, 'collection makes progress')
    assert.ok(nextMove.x >= 13 && nextMove.z >= 13, JSON.stringify(nextMove))
  } finally { await j.pause() }
})

test('speed: drops are not collected after every 8-block batch, and batches stay full', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l) })
  const sizes = []
  const mine = sim.adapter.mine
  sim.adapter.mine = async (targets, o) => { sizes.push(targets.length); return mine(targets, o) }
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const s = await runUntilStopped(j)
  assert.ok(['FINISHED', 'PAUSED'].includes(s.state))
  const collects = lines.filter(l => /"to":"COLLECT"/.test(l))
  assert.ok(!collects.some(l => /"collectReason":"batch"/.test(l)), 'no per-batch collection')
  assert.ok(collects.length < sizes.length / 2, `collections ${collects.length} vs batches ${sizes.length}`)
  const small = sizes.filter(n => n < 4).length
  assert.ok(small <= sizes.length / 4, `small batches ${small}/${sizes.length}: ${sizes.join(',')}`)
  assert.equal(sim.entities.filter(e => !e.stuck).length, 0, 'every drop still ends up collected')
})

test('speed: an item that stays on the ground after a visit is skipped as stuck, not revisited every collection', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  sim.entities.push({ id: 9001, name: 'minecraft:stick', count: 1, position: { x: 7.5, y: 63, z: 7.5 }, stuck: true })
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l) })
  const visits = []
  const moveTo = sim.adapter.moveTo
  sim.adapter.moveTo = async (stance, o) => { if (Math.abs(stance.x - 7) <= 1 && Math.abs(stance.z - 7) <= 1 && stance.y === 63) visits.push(stance); return moveTo(stance, o) }
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  await runUntilStopped(j)
  const stuck = lines.filter(l => /item_stuck/.test(l))
  assert.ok(stuck.length >= 1, 'the stuck item is reported')
  assert.ok(stuck.length <= 3, `stuck visits are bounded (${stuck.length})`)
})

test('live case 2026-11-04: a job started under an earlier pit gets a stair that reaches the real ground', async () => {
  const sim = setup({ stoneTop: 60, top: 66 })
  // An earlier job removed y64..66 inside the chunk and left its stair steps.
  sim.world.fill(0, 64, 0, 15, 66, 15, 'air')
  sim.world.set(0, 66, 0, 'stone'); sim.world.set(1, 65, 0, 'stone'); sim.world.set(2, 64, 0, 'stone')
  sim.setFeet({ x: -3, y: 67, z: 5 })
  sim.world.set(-4, 67, -4, 'chest')
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const { j } = job(sim)
  const plan = j.plan(baseConfig({ yTop: 63, yBottom: 62, inventory: { storage: [{ position: { x: -4, y: 67, z: -4 }, stand: { x: -3, y: 67, z: -4 } }] } }))
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  assert.equal(plan.stair.startY, 66, 'the stair continues up to the old steps instead of ending below the rim')
})

test('live case 2026-11-04: SLOW_BREAK (server slot differs from ours) resyncs the inventory and keeps quarrying', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l) })
  let slow = 1; let resyncs = 0
  const mine = sim.adapter.mine
  sim.adapter.mine = async (targets, o) => { if (slow-- > 0) throw Object.assign(new Error('quarry mine: block took 9000ms with minecraft:diamond_pickaxe in hand'), { code: 'SLOW_BREAK' }); return mine(targets, o) }
  sim.adapter.resyncInventory = async () => { resyncs++; return true }
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const s = await runUntilStopped(j)
  assert.equal(resyncs, 1)
  assert.ok(lines.some(l => /slow_break/.test(l)))
  // Same ending as a normal run of this setup (final check with the stair kept).
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', `${s.state} ${s.pauseReason}`)
  assert.ok(sim.stats.mined > 100, `kept mining after the resync (${sim.stats.mined})`)
})

test('live case 2026-11-05: an ACTION_FAILED pause resumes itself (bounded) instead of sitting idle', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l), autoResumeMs: 30 })
  let failures = 5
  // Moves fail until the job pauses with ACTION_FAILED, then work again.
  const moveTo = sim.adapter.moveTo
  sim.adapter.moveTo = async (stance, o) => { if (failures > 0 && !/^ACTION_FAILED/.test(j.status().pauseReason ?? '')) throw new Error('transient controller failure'); failures = 0; return moveTo(stance, o) }
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  // The first pause is ACTION_FAILED; wait past it for the normal ending.
  const until = Date.now() + 60000; let s
  while (Date.now() < until) { s = j.status(); if (/^ACTION_FAILED/.test(s.pauseReason ?? '')) failures = 0; if (s.state === 'PAUSED' && !/^ACTION_FAILED/.test(s.pauseReason ?? '')) break; await new Promise(r => setTimeout(r, 10)) }
  assert.ok(lines.some(l => /auto_resume/.test(l)), 'resumed automatically')
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS', `${s.state} ${s.pauseReason}`)
  assert.ok(sim.stats.mined > 100)
})

test('live case 2026-11-05: with several hostiles around the chests the job waits in the pit before leaving to deposit', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  for (let n = 0; n < 31; n++) sim.give('andesite', 64) // nearly full bag: the first capacity check returns to the chest
  let checks = 0
  sim.adapter.actors = () => (checks++ < 4 ? [{ kind: 'mob', hostile: true, alive: true, entityType: 'minecraft:zombie', position: { x: -6, y: 63, z: -4 } }, { kind: 'mob', hostile: true, alive: true, entityType: 'minecraft:skeleton', position: { x: -2, y: 63, z: -8 } }, { kind: 'mob', hostile: true, alive: true, entityType: 'minecraft:spider', position: { x: -8, y: 63, z: -2 } }] : [])
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l) })
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const until = Date.now() + 30000
  while (Date.now() < until && !sim.stats.deposits) await new Promise(r => setTimeout(r, 10))
  assert.ok(lines.some(l => /storage_area_hostile/.test(l)), 'the busy chest area was noticed')
  assert.ok(lines.some(l => /storage_area_clear/.test(l)), 'it went once the area cleared')
  assert.ok(sim.stats.deposits >= 1)
  j.emergencyStop?.()
})

test('live case 2026-11-05: a stance whose mining preview is refused (pose not settled) does not leave the cells unmined', async () => {
  const sim = setup({ stoneTop: 60, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 16)
  let refusals = 6
  const mine = sim.adapter.mine
  sim.adapter.mine = async (targets, o) => { if (refusals-- > 0) throw new Error('quarry mining preview refused: 1,62,1: 通常の地面に静止していることを確認できません。'); return mine(targets, o) }
  const { j } = job(sim)
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const s = await runUntilStopped(j)
  const failed = (s.deferred ?? []).filter(d => d.reason === 'MINING_FAILED')
  assert.equal(failed.length, 0, `cells written off: ${JSON.stringify(failed.slice(0, 3))}`)
  assert.equal(s.pauseReason, 'UNRESOLVED_EXCEPTIONS')
})

test('live case 2026-11-05: after a deposit the chest area is lit with crafted torches (normal placement, once)', async () => {
  const sim = setup({ stoneTop: 60, top: 62, chestSlots: 64 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  for (let n = 0; n < 31; n++) sim.give('andesite', 64) // nearly full: the first capacity check deposits
  sim.give('coal', 2)
  let crafts = 0; const placed = []
  sim.adapter.craftTorches = async ({ want }) => { crafts++; sim.give('torch', 8); return { ok: true, torches: 8 } }
  sim.adapter.placeTorch = async ({ position }) => { sim.world.set(position.x, position.y, position.z, 'torch'); placed.push(position); return { ok: true } }
  const lines = []
  const { j } = job(sim, { log: l => lines.push(l) })
  assert.equal(j.plan(baseConfig({ yBottom: 61 })).ready, true)
  j.start()
  const until = Date.now() + 30000
  while (Date.now() < until && !lines.some(l => /storage_lit/.test(l))) await new Promise(r => setTimeout(r, 10))
  j.emergencyStop?.()
  assert.equal(crafts, 1)
  assert.ok(placed.length >= 2, `torches placed: ${placed.length}`)
  assert.ok(placed.every(p => !(p.x >= 0 && p.x <= 15 && p.z >= 0 && p.z <= 15)), 'never inside the quarry columns')
})

test('live case 2026-11-10: one cell that stays slow after a resync is deferred instead of pausing the job', async () => {
  const sim = setup({ stoneTop: 61, top: 62 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  const mine = sim.adapter.mine
  let slow = 0
  sim.adapter.mine = async (targets, options) => {
    const bad = targets.find(t => t.x === 5 && t.y === 62 && t.z === 5)
    if (bad) { slow++; throw Object.assign(new Error('quarry mine: block 5,62,5 took 1520ms (limit 1500ms)'), { code: 'SLOW_BREAK', target: { x: 5, y: 62, z: 5 } }) }
    return mine(targets, options)
  }
  sim.adapter.resyncInventory = async () => ({ ok: true })
  const { j } = job(sim)
  j.plan(baseConfig({ yBottom: 62 }))
  j.start()
  const s = await runUntilStopped(j)
  assert.notEqual(s.pauseReason, 'SLOW_BREAK_PERSISTS', JSON.stringify(s.pauseDetails ?? s.result).slice(0, 300))
  assert.ok(slow >= 2, 'the slow cell was retried once after the resync')
  assert.notEqual(sim.world.name(5, 62, 5), 'air', 'the slow cell itself is left')
  assert.equal(sim.world.name(6, 62, 6), 'air', 'the rest of the layer is mined')
})

test('live case 2026-11-10: a pose that moved far while paused is confirmed with the server before resuming', async () => {
  for (const confirmed of [false, true]) {
    const sim = setup({ stoneTop: 61, top: 62 })
    sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
    const probes = []
    sim.adapter.confirmPosition = async (feet, options) => { probes.push({ feet, radius: options?.radius }); return confirmed ? { serverConfirmed: true } : { serverConfirmed: false, reason: 'POSITION_NOT_FOUND' } }
    const { j } = job(sim)
    j.plan(baseConfig({ yBottom: 62 }))
    j.start()
    while (!(j.status().ledger?.minedBlocks > 0)) await new Promise(r => setTimeout(r, 5))
    await j.pause(); await j.drain()
    sim.setFeet({ x: 8, y: 63, z: 8 }) // knocked far away while paused, still inside the chunk
    j.resume()
    const until = Date.now() + 10000
    while (probes.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 5))
    assert.equal(probes.length >= 1, true, 'the server was asked')
    assert.equal(probes[0].radius, 1.5)
    if (!confirmed) {
      const s = await runUntilStopped(j)
      assert.equal(s.pauseReason, 'POSITION_UNCONFIRMED')
      // A second resume asks again: the original reference is kept.
      j.resume()
      while (probes.length < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 5))
      assert.equal(probes.length >= 2, true)
    } else {
      while (!(j.status().ledger?.minedBlocks > 1) && Date.now() < until) await new Promise(r => setTimeout(r, 5))
      assert.notEqual(j.status().pauseReason, 'POSITION_UNCONFIRMED')
    }
    await j.pause(); await j.drain()
  }
})
