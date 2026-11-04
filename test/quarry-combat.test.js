'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryCombatBridge } = require('../src/quarry-combat-bridge')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')

const bot = (x = 0, y = 64, z = 0, extra = {}) => ({ position: { x: x + 0.5, y: y + 1.62, z: z + 0.5 }, health: 20, maxHealth: 20, food: 20, ...extra })
const mob = (type, x, y, z, extra = {}) => ({ kind: 'mob', hostile: true, alive: true, positionKnown: true, entityType: `minecraft:${type}`, runtimeId: `${type}${x}`, uniqueId: `-${x}`, position: { x: x + 0.5, y, z: z + 0.5 }, ...extra })
function bridge () { let t = 1000; const b = createQuarryCombatBridge({ now: () => t }); b.activate({ jobId: 'j', epoch: 1 }); return { b, tick: ms => { t += ms } } }

test('without a quarry job every target and move passes unchanged', () => {
  const b = createQuarryCombatBridge()
  assert.equal(b.canSelectTarget(mob('zombie', 30, 64, 0), bot()).allowed, true)
  assert.equal(b.canMoveTo({ x: 100, y: 64, z: 0 }).allowed, true)
})

test('T28 enter distances per attack type, with route and sight evidence', () => {
  const { b } = bridge()
  assert.equal(b.canSelectTarget(mob('zombie', 10, 64, 0), bot(), { route: true }).allowed, true)
  assert.equal(b.canSelectTarget(mob('husk', 11, 64, 0), bot(), { route: true }).allowed, false)
  assert.equal(b.canSelectTarget(mob('creeper', 16, 64, 0), bot(), { route: true }).allowed, true)
  assert.equal(b.canSelectTarget(mob('creeper', 17, 64, 1), bot(), { route: true, sight: true }).allowed, false)
  assert.equal(b.canSelectTarget(mob('skeleton', 0, 64, 24), bot(), { sight: true }).allowed, true)
  assert.equal(b.canSelectTarget(mob('stray', 0, 64, 25), bot(), { sight: true }).allowed, false)
})

test('T29 a held threat is released only beyond the release distance', () => {
  const { b } = bridge()
  const z = mob('zombie', 9, 64, 0)
  assert.equal(b.canSelectTarget(z, bot(), { route: true }).allowed, true)
  z.position.x = 11.5
  assert.equal(b.canSelectTarget(z, bot(), { route: true }).allowed, true, 'held between 10 and 12')
  z.position.x = 12.6
  assert.equal(b.canSelectTarget(z, bot(), { route: true }).reason, 'OUTSIDE_RELEASE_DISTANCE')
  z.position.x = 11.5
  assert.equal(b.canSelectTarget(z, bot(), { route: true }).allowed, false, 'a released threat must come back inside 10m')
})

test('T30 isolated enemies are watched only; unknown reachability is not safe', () => {
  const { b } = bridge()
  assert.equal(b.canSelectTarget(mob('zombie', 5, 64, 0), bot(), { route: false, sight: true }).allowed, false)
  assert.equal(b.canSelectTarget(mob('skeleton', 5, 64, 0, { runtimeId: 's2' }), bot(), { route: false, sight: false }).allowed, false)
  assert.equal(b.canSelectTarget(mob('creeper', 8, 64, 0), bot(), { route: false, sight: true }).allowed, true, 'creeper with a line of fire stays a bow candidate')
  assert.equal(b.canSelectTarget(mob('zombie', 6, 64, 6, { runtimeId: 'z9' }), bot(), {}).allowed, true, 'unknown route is not treated as safe')
  assert.equal(b.canSelectTarget(mob('zombie', 1, 67, 1, { runtimeId: 'z10' }), bot(), { route: false }).allowed, true, 'one that can drop onto the bot counts')
})

test('T31 immediate danger interrupts beyond the enter distance', () => {
  const { b } = bridge()
  assert.equal(b.canSelectTarget(mob('zombie', 20, 64, 0), bot(), { provoked: true }).reason, 'IMMEDIATE_DANGER')
  assert.equal(b.canSelectTarget(mob('creeper', 2, 64, 0, { primed: true }), bot(), { route: false, sight: false }).allowed, true)
})

test('T34/T35 anchor bound: whole route within 8m, emergency escape separate, anchor fixed', () => {
  const { b } = bridge()
  b.interrupt(bot(0, 64, 0), { reason: 'test' })
  assert.equal(b.canMoveTo({ x: 7.5, y: 64, z: 0.5 }).allowed, true)
  assert.equal(b.canMoveTo({ x: 9.6, y: 64, z: 0.5 }).reason, 'BEYOND_ANCHOR_RADIUS')
  assert.equal(b.canMoveTo({ x: 2, y: 64, z: 0 }, { waypoints: [{ x: 9.8, y: 64, z: 0 }] }).allowed, false)
  assert.equal(b.canMoveTo({ x: 1, y: 61, z: 0 }).reason, 'OTHER_LAYER')
  assert.equal(b.canMoveTo({ x: 30, y: 64, z: 0 }, { reason: 'emergency_escape' }).allowed, true)
  // Re-interrupting (new target, new shot) never moves the anchor.
  b.interrupt(bot(6, 64, 0), { reason: 'retarget' })
  assert.deepEqual(b.anchor(), { x: 0.5, y: 64, z: 0.5 })
})

test('T44 a mid-draw retarget to a far enemy is filtered', () => {
  const { b } = bridge()
  b.interrupt(bot(0, 64, 0))
  assert.equal(b.canSelectTarget(mob('skeleton', 31, 64, 0), bot(), { sight: true }).allowed, false)
})

test('T38 settle: 3s of fresh calm; attackers, projectiles and threats reset it', () => {
  const { b, tick } = bridge()
  const s = bot()
  assert.equal(b.settle(s, []).settled, false)
  tick(2000); assert.equal(b.settle(s, []).settled, false)
  tick(500); assert.equal(b.settle(s, [{ entityType: 'minecraft:arrow', position: { x: 2, y: 64, z: 0 } }]).settled, false)
  tick(3000); assert.equal(b.settle(s, []).settled, false, 'reset by the projectile')
  tick(3000); assert.equal(b.settle(s, []).settled, true)
  assert.equal(b.settle(s, [], { recentDamageAt: 1000 + 2000 + 500 + 6000 - 1000 }).settled, false, 'unresolved attacker in the 5s memory')
  assert.ok(b.settle(s, [mob('zombie', 5, 64, 0)], { evidenceFor: () => ({ route: true }) }).reasons[0].startsWith('THREAT'))
  const far = b.settle(s, [mob('zombie', 30, 64, 0)], { evidenceFor: () => ({ route: true }) })
  assert.deepEqual(far.reasons, [], 'a far enemy alone never blocks forever')
})

test('T36/T37 resume gate: 90% health and food 18; combat HP rules are not touched', () => {
  const { b } = bridge()
  assert.deepEqual(b.resumeGate(bot(0, 64, 0, { health: 17.8 })).missing, ['HEALTH'])
  assert.equal(b.resumeGate(bot(0, 64, 0, { health: 18 })).ready, true)
  assert.deepEqual(b.resumeGate(bot(0, 64, 0, { health: 20, food: 17 })).missing, ['FOOD'])
  assert.equal(b.resumeGate(bot(0, 64, 0), { harmfulEffect: true }).ready, false)
})

// Job-level interruption cycle with the simulation.
const LOADED = { xMin: -12, xMax: 28, yMin: 50, yMax: 90, zMin: -12, zMax: 28 }
function setup () {
  const sim = createSim({ loaded: LOADED })
  flatTerrain(sim, { x1: LOADED.xMin, x2: LOADED.xMax, z1: LOADED.zMin, z2: LOADED.zMax, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.set(-4, 63, -4, 'chest'); sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('iron_shovel'); sim.give('bread', 5); sim.give('cobblestone', 8)
  return sim
}
const cfg = { jobId: 'c', target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 61, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 }, stand: { x: -3, y: 63, z: -4 } }] } }
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('condition timeout') }

test('T19/T32/T37/T39 combat suspends work, settles 3s, waits for 90% HP, then replans', async () => {
  const sim = setup()
  const j = createQuarryJob({ adapter: sim.adapter, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5 })
  j.plan(cfg)
  let mineDuringCombat = 0
  sim.hooks.beforeMine = () => { if (j.status().state === 'COMBAT') mineDuringCombat++ }
  j.start()
  await until(() => sim.stats.mined > 40)
  sim.setCombat(true)
  await until(() => j.status().state === 'COMBAT')
  const minedAtCombat = sim.stats.mined
  const anchor = j.status().combat.anchor
  assert.ok(anchor)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(sim.stats.mined, minedAtCombat, 'no new digging while combat owns input')
  sim.state.health = 14
  sim.setCombat(false)
  await until(() => j.status().state === 'COMBAT_SETTLE')
  await new Promise(r => setTimeout(r, 1000))
  assert.equal(j.status().state, 'COMBAT_SETTLE', 'still inside the 3s calm window')
  await until(() => j.status().state === 'RECOVER_AFTER_COMBAT', 5000)
  await new Promise(r => setTimeout(r, 300))
  assert.equal(j.status().state, 'RECOVER_AFTER_COMBAT', 'below 90% health: no work')
  assert.equal(sim.stats.mined, minedAtCombat)
  sim.state.health = 19
  await until(() => sim.stats.mined > minedAtCombat + 5)
  assert.equal(mineDuringCombat, 0)
  assert.equal(j.status().combat.anchor, null, 'anchor released only on resume')
  await j.pause()
  assert.equal(j.status().state, 'PAUSED')
})

test('T42 manual pause during combat is never resumed automatically; death pauses', async () => {
  const sim = setup()
  const j = createQuarryJob({ adapter: sim.adapter, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5 })
  j.plan(cfg)
  j.start()
  await until(() => sim.stats.mined > 10)
  sim.setCombat(true)
  await until(() => j.status().state === 'COMBAT')
  await j.pause()
  sim.setCombat(false)
  await new Promise(r => setTimeout(r, 500))
  assert.equal(j.status().state, 'PAUSED')
  assert.equal(j.status().pauseReason, 'MANUAL_PAUSE')
  j.resume()
  await until(() => j.status().state !== 'RECONCILE' && sim.stats.mined > 12)
  sim.state.lifecycle.deathId = 1
  await until(() => j.status().state === 'PAUSED')
  assert.equal(j.status().pauseReason, 'DEATH')
  assert.equal(j.status().deaths.length, 1)
})

test('T16 disconnect: work stops, reconnect reconciles and continues without re-mining', async () => {
  const sim = setup()
  const j = createQuarryJob({ adapter: sim.adapter, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5 })
  j.plan(cfg)
  j.start()
  await until(() => sim.stats.mined > 10)
  sim.state.phase = 'connecting'
  await until(() => j.status().state === 'DISCONNECTED')
  const mined = sim.stats.mined
  await new Promise(r => setTimeout(r, 100))
  assert.equal(sim.stats.mined, mined)
  sim.state.connectionId = 'c2'; sim.state.phase = 'spawned'
  await until(() => sim.stats.mined > mined + 5)
  await j.pause()
})
