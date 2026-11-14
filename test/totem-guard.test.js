'use strict'
// 2026-11-14 01:59 user: "クリーパーに爆破され落下しました。不死のトーテムを持っている限り
// 死ぬことはないので、過剰な待機保護をやめてください". While the received offhand holds a
// totem (state.totemGuard), health alone stops no work; without it, unchanged.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resourceMinHealth, totemGuarded } = require('../src/learning-health')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')

test('the minimum working health is zero only while a received offhand totem is held and the bot is alive', () => {
  const alive = { phase: 'spawned', health: 4, threatPolicy: 'balanced_mining' }
  assert.equal(resourceMinHealth(alive), 6)
  assert.equal(resourceMinHealth({ ...alive, totemGuard: true }), 0)
  assert.equal(resourceMinHealth({ ...alive, totemGuard: true }, 10), 0)
  assert.equal(resourceMinHealth({ ...alive, totemGuard: false }, 10), 10, 'a used totem restores the ordinary minimum')
  assert.equal(resourceMinHealth({ ...alive, totemGuard: true, health: 0 }), 6)
  assert.equal(resourceMinHealth({ ...alive, totemGuard: true, dead: true }), 6)
  assert.equal(totemGuarded({ ...alive, totemGuard: 'yes' }), false, 'only the runtime flag from the received offhand counts')
})

const LOADED = { xMin: -12, xMax: 28, yMin: 50, yMax: 90, zMin: -12, zMax: 28 }
async function lowHealthRun (totemGuard) {
  const sim = createSim({ loaded: LOADED, chestSlots: 27 })
  flatTerrain(sim, { x1: LOADED.xMin, x2: LOADED.xMax, z1: LOADED.zMin, z2: LOADED.zMax, bedrock: 50, stoneTop: 60, top: 62 })
  sim.world.set(-4, 63, -4, 'chest')
  sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  sim.state.health = 4
  if (totemGuard) sim.state.totemGuard = true
  const j = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5 })
  const plan = j.plan({ jobId: 'totem', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 62, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } })
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  j.start()
  const until = Date.now() + 4000
  while (Date.now() < until && !(j.status().ledger?.minedBlocks > 0) && !j.status().events?.some(e => e.type === 'low_health')) await new Promise(r => setTimeout(r, 5))
  const s = j.status(); await j.pause()
  return s
}

test('quarry: HP 4/20 with a received offhand totem keeps mining instead of the 40% retreat', async () => {
  const s = await lowHealthRun(true)
  assert.ok(s.ledger.minedBlocks > 0, JSON.stringify({ state: s.state, reason: s.pauseReason, events: (s.events ?? []).slice(-5) }))
  assert.equal((s.events ?? []).some(e => e.type === 'low_health'), false)
})

test('quarry: HP 4/20 without a totem still retreats as before', async () => {
  const s = await lowHealthRun(false)
  assert.ok((s.events ?? []).some(e => e.type === 'low_health'), JSON.stringify({ state: s.state, events: (s.events ?? []).slice(-5) }))
  assert.equal(s.ledger.minedBlocks ?? 0, 0)
})

// Live 2026-11-14 03:56:45: the totem fired (HP 1.19 -> 1) but the offhand
// record kept it and the health protections stayed off until death at 04:00.
test('a consumed totem empties the trusted offhand at once', () => {
  const { createInventoryStore } = require('../src/inventory-store')
  const store = createInventoryStore({ shared: {} })
  const totem = { network_id: 578, count: 1, metadata: 0, has_stack_id: true, stack_id: 7, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }
  store.commit('offhand', 0, totem, 'server_inventory_slot')
  assert.ok(store.raw('offhand', 0), 'a received totem is trusted')
  store.forget('offhand', 0, 'totem_consumed')
  assert.equal(store.raw('offhand', 0), null, 'after consumption the offhand is unreceived, not a totem')
  const source = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(source, /consume_totem' \|\| packet\.event_id === 65/)
  assert.match(source, /inventoryStore\.forget\('offhand', 0, 'totem_consumed'\)/)
  assert.match(source, /totemConsumedAt\) && !\(Date\.parse\(info\?\.at/)
})

// 2026-11-14 user decision (relay): with the long-trip preparation allowance and
// a server-confirmed empty inventory, gathering may start at low health.
test('empty-handed preparation lowers the working minimum to zero; anything else keeps it', () => {
  const { emptyHandedPrep } = require('../src/learning-health')
  const alive = { phase: 'spawned', health: 3, threatPolicy: 'balanced_mining' }
  assert.equal(resourceMinHealth({ ...alive, emptyHandedPrep: true }), 0)
  assert.equal(resourceMinHealth({ ...alive, emptyHandedPrep: false }), 6)
  assert.equal(emptyHandedPrep({ ...alive, emptyHandedPrep: true, dead: true }), false)
  const source = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(source, /if \(!longTravelLogAllowance\(\)\) return false/)
  assert.match(source, /slot\.received === true && slot\.raw && \(slot\.raw\.network_id === 0 \|\| slot\.raw\.count === 0\)/)
})

// Coordinator 2026-11-14: the empty-handed exceptions end as soon as anything is
// in hand. They all key on state.emptyHandedPrep, which the runtime derives only
// from every received slot being empty while the preparation allowance holds.
test('every empty-handed exception keys on the derived flag, and one item ends it', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  const derive = source.slice(source.indexOf('  function emptyHandedPrep () {'), source.indexOf('  function longTravelLogAllowance () {'))
  assert.match(derive, /for \(const \[container, size\] of \[\['main', 36\], \['armor', 4\], \['offhand', 1\]\]\)/)
  assert.match(derive, /v\.slots\.every\(slot => slot\.received === true && slot\.raw && \(slot\.raw\.network_id === 0 \|\| slot\.raw\.count === 0\)\)/)
  for (const pattern of [/state\.emptyHandedPrep !== true\) return \{ type: 'avoid_threat'/, /if \(current\.emptyHandedPrep === true\) \{\}/, /current\.emptyHandedPrep!==true&&\(current\.health<initial\.health/, /st\.emptyHandedPrep !== true\) \{ try \{ movement\?\.stop\?\.\('damage'\)/]) assert.match(source, pattern)
  assert.equal(resourceMinHealth({ phase: 'spawned', health: 3, emptyHandedPrep: false }), 6, 'with an item in hand the ordinary minimum applies')
})
