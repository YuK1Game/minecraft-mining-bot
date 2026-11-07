'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob, defaults } = require('../src/quarry-job')
const { buildRegions } = require('../src/quarry-region')
const { blockRule, selectTool, reserveUses } = require('../src/quarry-rules')
const { planQuarryExit } = require('../src/quarry-exit-plan')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture ({ tool = 'diamond_pickaxe', remaining = 4, material = 'stone', others = true } = {}) {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.fill(0, 60, 0, 15, 62, 15, 'air'); sim.world.set(-4, 63, -4, 'chest')
  for (let x = 5; x < 10; x++) sim.world.set(x, 60, 5, material)
  sim.setFeet({ x: 4, y: 60, z: 5 }); sim.give(tool)
  const item = sim.state.inventory.items[0]
  item.durabilityRemaining = remaining; item.durabilityUsed = item.maxDurability - remaining
  if (others) { sim.give('bread', 5); sim.give('dirt', 64) }
  const config = { jobId: 'last-use', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 60, yBottom: 60, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } }
  const payloads = []; const mine = sim.adapter.mine
  sim.adapter.mine = async (targets, options) => { payloads.push(structuredClone(targets)); return mine(targets, options) }
  const docs = []
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => docs.push(doc) }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  return { sim, item, config, payloads, job, docs }
}

async function until (predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('last-use test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) } }
const observation = (item, known = true) => ({ slot: item.slot, name: item.name, stackId: item.stackId ?? 1, durabilityKnown: known, durabilityRemaining: item.durabilityRemaining })

test('default reserve is exactly one, remaining two permits one use, and unknown durability stays unusable', () => {
  const policy = defaults().tools
  assert.deepEqual([policy.reserveMinUses, policy.reserveFraction, policy.returnUses], [1, 0, 0])
  assert.equal(reserveUses(1561, policy), 1)
  const item = { slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 2 }
  assert.equal(selectTool(blockRule('stone'), [item], policy).reserve, 1)
  assert.equal(selectTool(blockRule('stone'), [item], policy).ok, true)
  assert.equal(selectTool(blockRule('stone'), [{ ...item, durabilityRemaining: 1 }], policy).reason, 'TOOL_DURABILITY_RESERVE')
  assert.equal(selectTool(blockRule('stone'), [{ ...item, durabilityRemaining: 0 }], policy).ok, false)
  assert.equal(selectTool(blockRule('stone'), [{ ...item, durabilityKnown: false }], policy).reason, 'TOOL_DURABILITY_UNKNOWN')
  assert.equal(selectTool(blockRule('dirt'), [{ ...item, durabilityRemaining: 1 }], policy).kind, 'hand')
})

test('the planner and real batch simulator spend only remaining minus one, never the last use', async () => {
  const f = fixture()
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'WAITING_FOR_TOOL')
    assert.equal(f.item.durabilityRemaining, 1)
    assert.equal(f.sim.stats.mined, 3)
    assert.equal(f.payloads.length, 1)
    assert.equal(f.payloads[0].length, 3)
    assert.ok(f.payloads[0].every(t => t.requiredTool.kind === 'pickaxe' && t.requiredTool.reserve === 1))
  } finally { await f.job.pause() }
})

test('soft-block tools carry the same reserve guard and then fall back to an actual non-tool hand', async () => {
  const f = fixture({ tool: 'iron_shovel', remaining: 2, material: 'dirt' })
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.sim.stats.mined === 5)
    assert.equal(f.item.durabilityRemaining, 1)
    assert.equal(f.payloads[0].length, 1)
    assert.deepEqual(f.payloads[0][0].requiredTool, { kind: 'shovel', tier: 3, reserve: 1 })
    assert.ok(f.payloads.slice(1).flat().every(t => t.requiredTool === null))
  } finally { await f.job.pause() }
})

test('a missing non-tool hand item pauses rather than spending a remaining-one held tool', async () => {
  const f = fixture({ tool: 'iron_shovel', remaining: 1, material: 'dirt', others: false })
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'HAND_ITEM_REQUIRED')
    assert.equal(f.sim.stats.mined, 0)
    assert.equal(f.item.durabilityRemaining, 1)
  } finally { await f.job.pause() }
})

test('live reserve rejection retains only received partial air and never labels the cells MINING_FAILED', async () => {
  const f = fixture()
  let calls = 0
  f.sim.adapter.mine = async targets => { calls++; const p = targets[0]; f.sim.world.set(p.x, p.y, p.z, 'air'); f.item.durabilityRemaining = 1; throw Object.assign(new Error('TOOL_DURABILITY_RESERVE'), { code: 'TOOL_DURABILITY_RESERVE' }) }
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'WAITING_FOR_TOOL')
    assert.equal(f.job.status().ledger.minedBlocks, 1)
    assert.equal(calls, 1)
    assert.equal(Object.values(f.job.document().records.deferred).some(d => d.reason === 'MINING_FAILED'), false)
  } finally { await f.job.pause() }
})

test('a fresh observation of remaining one cancels the stale remaining-two plan before dispatch', async () => {
  const f = fixture({ remaining: 2 }); let prepares = 0
  f.sim.adapter.prepareMining = async () => { prepares++; f.item.durabilityRemaining = 1; return { slot: f.item.slot, toolObservation: observation(f.item) } }
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'WAITING_FOR_TOOL')
    assert.equal(prepares, 1)
    assert.equal(f.payloads.length, 0)
    assert.equal(f.item.durabilityRemaining, 1)
  } finally { await f.job.pause() }
})

test('fresh preparation trims a larger stale batch to the current remaining-minus-one budget', async () => {
  const f = fixture({ remaining: 9 })
  f.sim.adapter.prepareMining = async () => { f.item.durabilityRemaining = 3; return { slot: f.item.slot, toolObservation: observation(f.item) } }
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.sim.stats.mined, 2)
    assert.equal(f.payloads[0].length, 2)
    assert.equal(f.item.durabilityRemaining, 1)
  } finally { await f.job.pause() }
})

test('terminal batches prepare again even after the normal equipment-pending flag was cleared', async () => {
  const f = fixture({ remaining: 2 }); let prepares = 0
  f.sim.adapter.prepareMining = async () => { if (++prepares > 1) f.item.durabilityRemaining = 1; return { slot: f.item.slot, toolObservation: observation(f.item) } }
  const mine = f.sim.adapter.mine
  f.sim.adapter.mine = async (targets, options) => { const remaining = f.item.durabilityRemaining; const r = await mine(targets, options); f.item.durabilityRemaining = remaining; return r }
  f.job.plan(f.config); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(prepares, 2)
    assert.equal(f.payloads.length, 1)
    assert.equal(f.sim.stats.mined, 1)
  } finally { await f.job.pause() }
})

test('unknown terminal observations pause without another break and healthy tools avoid extra preparation', async () => {
  for (const mode of ['unknown', 'missing', 'healthy']) {
    const unknown = mode !== 'healthy'
    const f = fixture({ remaining: unknown ? 2 : 832 }); let prepares = 0
    f.sim.adapter.prepareMining = async () => { prepares++; f.item.durabilityKnown = false; return { slot: f.item.slot, toolObservation: mode === 'missing' ? null : observation(f.item, false) } }
    f.job.plan(f.config); f.job.start()
    try {
      await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state))
      if (unknown) { assert.equal(f.job.status().pauseReason, 'WAITING_FOR_TOOL'); assert.equal(prepares, 1); assert.equal(f.sim.stats.mined, 0) } else { assert.equal(prepares, 0); assert.equal(f.sim.stats.mined, 5) }
    } finally { await f.job.pause() }
  }
})

test('shaft preflight uses the same last-use budget and respects explicit legacy reservations', () => {
  const f = fixture({ remaining: 3 })
  f.sim.world.fill(0, 60, 0, 15, 62, 15, 'air')
  const regions = buildRegions({ target: f.config.target, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90 })
  const args = { regions, feet: f.sim.feet(), getBlock: f.sim.adapter.getBlock, inventory: f.sim.state.inventory.items, policy: defaults().tools, exit: { side: 'east' } }
  let r = planQuarryExit(args)
  assert.equal(r.ok, true)
  assert.equal(r.plan.toolUses[0].count, 2)
  assert.ok(r.plan.shaftCells.filter(c => c.requiredTool).every(c => c.requiredTool.reserve === 1))
  f.item.durabilityRemaining = 2
  assert.equal(planQuarryExit(args).reason, 'EXIT_TOOL_MISSING')
  f.item.durabilityRemaining = 158
  args.policy = { reserveMinUses: 8, reserveFraction: 0.1, returnUses: 0 }
  assert.equal(planQuarryExit(args).reason, 'EXIT_TOOL_MISSING')
  f.item.durabilityRemaining = 159
  r = planQuarryExit(args)
  assert.equal(r.ok, true)
  assert.equal(r.plan.shaftCells.find(c => c.requiredTool).requiredTool.reserve, 157)
})

test('paused configuration preserves progress and only clears current/lower reserve-related deferrals', async () => {
  const f = fixture({ remaining: 157 })
  f.job.plan({ ...f.config, tools: { reserveMinUses: 8, reserveFraction: 0.1, returnUses: 0 } })
  const doc = f.job.document()
  Object.assign(doc, { state: 'PAUSED', deepestY: 60, cursorY: 60, ledger: { minedBlocks: { stone: 17 } } })
  doc.records.deferred = { '5,60,5': { name: 'minecraft:stone', reason: 'TOOL_DURABILITY_RESERVE' }, '6,60,5': { name: 'minecraft:stone', reason: 'TOOL_DURABILITY_UNKNOWN' }, '7,60,5': { name: 'minecraft:stone', reason: 'MINING_FAILED' }, '5,61,5': { name: 'minecraft:stone', reason: 'TOOL_DURABILITY_RESERVE' } }
  f.job.load(doc)
  const before = f.job.document()
  assert.equal(f.job.status().tools.states[0].reserve, 157)
  await f.job.configureTools({ reserveMinUses: 1, reserveFraction: 0, returnUses: 0 })
  const after = f.job.document()
  assert.equal(after.deepestY, doc.deepestY)
  assert.deepEqual(after.ledger, before.ledger)
  assert.deepEqual(after.config.exit, doc.config.exit)
  assert.deepEqual(after.config.inventory.storage, doc.config.inventory.storage)
  assert.equal(after.records.deferred['5,60,5'], undefined)
  assert.equal(after.records.deferred['6,60,5'].reason, 'TOOL_DURABILITY_UNKNOWN')
  assert.equal(after.records.deferred['7,60,5'].reason, 'MINING_FAILED')
  assert.equal(after.records.deferred['5,61,5'].reason, 'TOOL_DURABILITY_RESERVE')
  assert.equal(f.job.status().tools.states[0].reserve, 1)
  assert.equal(f.job.status().tools.states[0].usable, true)
  assert.equal(f.job.status().state, 'PAUSED')
  await assert.rejects(f.job.configureTools({ reserveFraction: -1 }), /Invalid durability/)
  f.job.start()
  try { await assert.rejects(f.job.configureTools({ reserveMinUses: 1 }), /fully paused/) } finally { await f.job.pause() }
})
