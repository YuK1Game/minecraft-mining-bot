'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planQuarryExit, permitsExitAction } = require('../src/quarry-exit-plan')
const { buildRegions, permits } = require('../src/quarry-region')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim } = require('./helpers/quarry-sim')

// Synthetic terrain: the quarry's tallest point and the adjacent ground are
// independent. This is not a recording of the user's Realm.
function hillside ({ surface = 63, top = 85, bottom = -64, dug = false, patch = () => null, side = 'east' } = {}) {
  const regions = buildRegions({ target: { chunks: [{ x: -2, z: 1 }] }, yTop: top, yBottom: bottom })
  const calls = []
  const getBlock = (x, y, z) => {
    calls.push({ x, y, z })
    assert.ok(y >= -64 && y <= 319, 'only valid world coordinates may be inspected')
    const changed = patch(x, y, z)
    if (changed && typeof changed === 'object') return changed
    const name = changed ?? (y <= -60 ? 'bedrock' : dug && regions.columns.has(`${x},${z}`) || y > surface ? 'air' : y === surface ? 'grass_block' : 'stone')
    return { known: true, name: `minecraft:${name}`, boundingBox: /^(air|water|lava|short_grass)$/.test(name) ? 'empty' : 'block', extra: [] }
  }
  const inventory = [0, 1, 2].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))
  inventory.push({ slot: 3, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1561 })
  return { calls, regions, args: { regions, getBlock, inventory, feet: { x: -17, y: -59, z: 17 }, preflight: !dug, exit: { side } } }
}

for (const surface of [69, 68, 63, 0, -50]) test(`review: Y85 quarry may land on observed surface Y${surface} regardless of a 16-block gap`, () => {
  const f = hillside({ surface }), r = planQuarryExit(f.args)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.landing.y, surface + 1)
  assert.equal(r.plan.startFeet.y, -59)
  assert.equal(r.plan.requiredDirt, surface + 1 + 59)
  assert.equal(r.plan.totalDirt, r.plan.requiredDirt + 8)
  assert.equal(r.plan.clearTopY, surface + 3)
  assert.equal(f.regions.yTop, 85)
  assert.equal(f.regions.yBottom, -64)
  assert.equal(r.serverConfirmed, false, 'planning is never an execution receipt')
  assert.equal(permitsExitAction(r.plan, 'break', r.plan.landing), false)
  assert.equal(permitsExitAction(r.plan, 'place', r.plan.landing), false)
  f.regions.exitReservation = r.plan
  assert.equal(permits(f.regions, 'seal', { ...r.plan.landing, y: surface }).reason, 'EXIT_RESERVED')
})
for (const side of ['east', 'west', 'north', 'south']) test(`review: lower landing preserves ${side} boundary selection`, () => {
  const r = planQuarryExit(hillside({ side }).args)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.side, side)
  assert.equal(r.plan.landing.y, 64)
})
test('review: a saved lower exit is revalidated against real air and actual reachability', () => {
  const f = hillside(), planned = planQuarryExit(f.args)
  assert.equal(planned.ok, true)
  const cut = hillside({ dug: true }), p = planned.plan
  const reachable = new Set([`${p.entry.x},${p.entry.y},${p.entry.z}`])
  const r = planQuarryExit({ ...cut.args, reservation: p, reachable })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.plan.landing, p.landing)
  assert.deepEqual(r.plan.column, p.column)
  assert.equal(planQuarryExit({ ...f.args, preflight: false, reservation: p, reachable }).ok, false)
  assert.equal(planQuarryExit({ ...cut.args, reservation: p, reachable: new Set() }).ok, false)
})
for (const [name, cause] of [['water', 'FLUID_OR_EXTRA_LAYER'], ['lava', 'FLUID_OR_EXTRA_LAYER'], ['gravel', 'FALLING_BLOCK'], ['chest', 'PROTECTED'], ['oak_leaves', 'UNSAFE_LANDING_FLOOR'], ['short_grass', 'UNSAFE_LANDING_FLOOR'], ['magma', 'UNSAFE_LANDING_FLOOR']]) test(`review: lower search never skips ${name} to select a cave beneath`, () => {
  const f = hillside({ patch: (x, y) => x === -15 && y === 70 ? name : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.ok(r.details.attempts.every(a => a.reason === 'LANDING_UNAVAILABLE' && a.cause === cause), JSON.stringify(r))
  assert.equal(r.details.cause, cause)
  assert.deepEqual(r.details.position, { x: -15, y: 70, z: 16 })
})
for (const y of [319, 200, 67]) test(`review: unreceived landing column at Y${y} is not inferred to be sky`, () => {
  const f = hillside({ patch: (x, cy) => x === -15 && cy === y ? { known: false, reason: 'subchunk_not_received' } : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.equal(r.details.cause, 'UNKNOWN')
  assert.deepEqual(r.details.position, { x: -15, y, z: 16 })
  assert.ok(r.details.attempts.every(a => a.reason === 'LANDING_UNAVAILABLE' && a.cause === 'UNKNOWN' && a.observation === 'subchunk_not_received'))
})
test('review: roof above the allowed upper landing height is not bypassed', () => {
  const f = hillside({ patch: (x, y) => x === -15 && y === 130 ? 'stone' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.ok(r.details.attempts.every(a => a.cause === 'LANDING_TOO_HIGH' && a.position.y === 130))
})
test('review: first safe surface is chosen, never the cavity below its roof', () => {
  const f = hillside({ patch: (x, y) => x === -15 && y === 70 ? 'stone' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.plan.landing.y, 71)
})
test('review: lower surface outside the height available for an upward exit remains unavailable', () => {
  const f = hillside({ patch: (x, y) => x === -15 && y >= -59 ? 'air' : null })
  const r = planQuarryExit(f.args)
  assert.equal(r.ok, false)
  assert.equal(r.details.cause, 'NO_SURFACE_ABOVE_ENTRY')
  assert.ok(f.calls.every(p => p.y >= -64 && p.y <= 319))
})
test('review: protected surface and secondary liquid layer do not become valid lower landings', () => {
  for (const field of [{ protected: true }, { protectionSource: 'user' }, { extra: [{ name: 'minecraft:water' }] }]) {
    const f = hillside({ patch: (x, y) => x === -15 && y === 63 ? { known: true, name: 'minecraft:grass_block', boundingBox: 'block', extra: [], ...field } : null })
    assert.equal(planQuarryExit(f.args).ok, false)
  }
})
test('review: lower landing still needs dirt, a tool and inventory capacity', () => {
  const f = hillside({ dug: true }), a = f.args
  assert.equal(planQuarryExit({ ...a, inventory: a.inventory.filter(i => i.name !== 'minecraft:dirt') }).reason, 'EXIT_MATERIAL_MISSING')
  assert.equal(planQuarryExit({ ...a, inventory: a.inventory.filter(i => i.name !== 'minecraft:diamond_pickaxe') }).reason, 'EXIT_TOOL_MISSING')
  const full = a.inventory.concat(Array.from({ length: 32 }, (_, i) => ({ slot: i + 4, name: 'minecraft:dirt', count: 64 })))
  assert.equal(planQuarryExit({ ...a, inventory: full }).reason, 'EXIT_INVENTORY_CAPACITY')
})

async function until (check) {
  const end = Date.now() + 10000
  while (!check()) { if (Date.now() > end) throw Error('landing regression timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
for (const action of ['start', 'resume']) test(`review: ${action} of Y85 to -64 job passes preflight with a Y63 surrounding surface`, async () => {
  const sim = createSim({ loaded: { xMin: -36, xMax: -12, yMin: -64, yMax: 100, zMin: 12, zMax: 36 } })
  sim.world.fill(-36, -64, 12, -12, -60, 36, 'bedrock')
  sim.world.fill(-36, -59, 12, -12, 63, 36, 'stone')
  sim.setFeet({ x: -17, y: 64, z: 18 }); sim.give('diamond_pickaxe'); sim.give('bread', 20); sim.give('dirt', 192)
  let release, reserved = null
  const barrier = new Promise(resolve => { release = resolve })
  sim.adapter.egress = async () => { throw Error('preflight test must not run the exit') }
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, storage: { save: async (_id, doc) => {
    if (!reserved && doc.exitReservation) { reserved = doc; await barrier }
  } } })
  assert.equal(job.plan({ jobId: 'lower-landing-' + action, target: { chunks: [{ x: -2, z: 1 }] }, yTop: 85, yBottom: -64, worldMaxY: 100, inventory: { carryOnly: true } }).ready, true)
  if (action === 'resume') {
    const old = job.document()
    Object.assign(old, { state: 'PAUSED', pauseReason: 'EXIT_COLUMN_UNAVAILABLE', userRunIntent: 'running', scope: JSON.stringify(['bot', '1', 'overworld', 'c1', 't0']), life: 0 })
    // The previous observation budget is intentionally exhausted; the received
    // ground must work without manufacturing another terrain response.
    old.terrainObservation = { scope: old.scope, life: 0, requests: 2, purpose: 'egress', phase: 'exhausted' }
    job.load(old); job.resume()
  } else job.start()
  try {
    await until(() => reserved || job.status().state === 'PAUSED')
    assert.ok(reserved, JSON.stringify(job.status().pauseDetails))
    assert.equal(reserved.exitReservation.plan.landing.y, 64)
    assert.equal(reserved.exitReservation.plan.startFeet.y, -59)
    assert.equal(reserved.config.yBottom, -64)
    assert.equal(reserved.yTop, 85)
    assert.equal(reserved.acceptedExceptions, undefined)
    assert.equal(sim.stats.mined, 0, 'assert before allowing any excavation')
  } finally { const stop = job.pause(); release(); await stop }
})
test('review (2026-11-10): a job continuing under an open pit may land on the surface with a larger landing rise', () => {
  const f = hillside({ patch: (x, y) => x === -15 && y === 130 ? 'stone' : null })
  assert.ok(planQuarryExit(f.args).details.attempts.every(a => a.cause === 'LANDING_TOO_HIGH'), 'the default rise still refuses')
  const r = planQuarryExit({ ...f.args, exit: { ...(f.args.exit ?? {}), landingRise: 160 } })
  assert.ok(!(r.details?.attempts ?? []).some(a => a.cause === 'LANDING_TOO_HIGH'), JSON.stringify(r.details).slice(0, 200))
  const { normalizeExit } = require('../src/quarry-exit-plan')
  assert.throws(() => normalizeExit({ landingRise: 10 }), /landing rise/)
  assert.equal(normalizeExit({}).landingRise, undefined)
})
