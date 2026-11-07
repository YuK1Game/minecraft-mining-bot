'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const handReceipts = require('./fixtures/leaf-litter-bds-1.26.60-hand-receipts.json')
const boxReceipts = require('./fixtures/leaf-litter-bds-1.26.60-box-receipts.json')
const { deriveDropGuarantee, checkDropGuarantees } = require('../src/quarry-drop-guarantee')
const { fullDropBudget } = require('../src/quarry-capacity-batch')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const copy = value => structuredClone(value), key = p => `${p.x},${p.y},${p.z}`
const hand = { kind: 'hand', tier: 0 }
function fromRun (run, p = { x: 1, y: 61, z: 3 }) {
  const b = run.blocks.find(b => b.name === 'leaf_litter')
  assert.equal(b.properties.growth.type, 'int')
  assert.equal(b.properties['minecraft:cardinal_direction'].type, 'string')
  return { known: true, position: copy(p), name: 'minecraft:leaf_litter', runtimeId: b.id, properties: { growth: b.properties.growth.value, 'minecraft:cardinal_direction': b.properties['minecraft:cardinal_direction'].value }, boundingBox: 'empty', diggable: true, extra: [] }
}
const sample = growth => fromRun(handReceipts.runs.find(run => run.growth === growth))
const main = count => count ? [{ slot: 1, name: 'minecraft:leaf_litter', count }] : []

test('all32 isolated same-version ordinary breaks have state, received air, spawned drops and later full-main gains matching growth+1', () => {
  assert.equal(handReceipts.runs.length, 12); assert.equal(boxReceipts.runs.length, 20)
  for (const receipt of [handReceipts, boxReceipts]) {
    assert.equal(receipt.local, true); assert.equal(receipt.version, '1.26.60'); assert.equal(receipt.serverStopped, true)
    for (const run of receipt.runs) {
      const target = fromRun(run), before = run.blocks.find(b => b.name === 'leaf_litter'), air = run.blocks.find(b => b.name === 'air')
      assert.equal(run.serverConfirmed, true); assert.equal(target.properties.growth, run.growth)
      assert.ok(air.seq > before.seq); assert.ok(run.fullMainSeq > air.seq)
      assert.ok(run.mainPackets.some(packet => packet.seq === run.fullMainSeq))
      assert.equal(run.drops.reduce((n, drop) => n + (drop.type === 'minecraft:leaf_litter' ? drop.count : 0), 0), run.growth + 1)
      assert.equal(run.delta, run.growth + 1)
      const result = checkDropGuarantees([target], hand, { beforeItems: run.before, afterItems: run.after })
      assert.equal(result.ok, true)
      assert.deepEqual(result.allocation, [[{ name: 'leaf_litter', count: run.growth + 1 }]])
      assert.deepEqual(fullDropBudget([target], hand), [{ name: 'leaf_litter', count: run.growth + 1 }])
      if (receipt === boxReceipts) {
        assert.match(run.handProof, /LeafHandProof/)
        const held = run.before.find(i => i.name === 'minecraft:undyed_shulker_box')
        assert.ok(held); assert.ok(run.after.some(i => i.name === held.name && i.count === held.count && i.stackId === held.stackId))
      }
    }
  }
})

test('growth0 is a required one-item harvest; missing, abnormal or unobserved states and other tools are not inferred', () => {
  for (let growth = 0; growth <= 3; growth++) {
    const t = sample(growth)
    assert.equal(checkDropGuarantees([t], hand, { beforeItems: [], afterItems: main(growth) }).reason, 'DROP_GAIN_MISSING')
    assert.equal(checkDropGuarantees([t], hand, { beforeItems: [], afterItems: main(growth + 1) }).ok, true)
  }
  for (const props of [null, {}, { growth: 0 }, { growth: -1, 'minecraft:cardinal_direction': 'north' }, { growth: 4, 'minecraft:cardinal_direction': 'north' }, { growth: '1', 'minecraft:cardinal_direction': 'north' }, { growth: 1, 'minecraft:cardinal_direction': 'up' }, { growth: { value: 1 }, 'minecraft:cardinal_direction': 'north' }]) assert.equal(deriveDropGuarantee({ ...sample(1), properties: props }, hand).ok, false)
  for (const tool of [null, { kind: 'shovel', tier: 4, silk: true }, { kind: 'shears' }]) assert.equal(deriveDropGuarantee(sample(1), tool).ok, false)
  assert.equal(deriveDropGuarantee({ ...sample(1), runtimeId: undefined }, hand).ok, false)
  assert.equal(deriveDropGuarantee({ ...sample(1), name: 'minecraft:unknown_litter' }, hand).ok, false)
})

test('the three actual Realm runtime/state variants require nine new items, without borrowing existing stock or reusing a gain', () => {
  const expected = [[3, 'south', 1541214755], [1, 'north', 3248259543], [2, 'north', 3947055068]]
  const targets = expected.map(([growth, direction, runtimeId], i) => {
    const run = [...handReceipts.runs, ...boxReceipts.runs].find(r => { const b = fromRun(r); return r.growth === growth && b.properties['minecraft:cardinal_direction'] === direction && b.runtimeId === runtimeId })
    assert.ok(run); return fromRun(run, { x: -44 + i, y: 94, z: -208 })
  })
  assert.equal(checkDropGuarantees(targets, hand, { beforeItems: main(10), afterItems: main(18) }).ok, false)
  assert.equal(checkDropGuarantees(targets, hand, { beforeItems: main(10), afterItems: main(19) }).ok, true)
  assert.deepEqual(fullDropBudget(targets, hand).map(d => d.count), [4, 2, 3])
})

function worldFixture ({ missing = false, changeOnMove = false } = {}) {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 75, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 59, top: 60 })
  const block = sample(2); block.position = { x: 7, y: 61, z: 7 }
  if (missing) delete block.properties
  sim.world.set(block.position.x, block.position.y, block.position.z, block.name)
  sim.setFeet({ x: -3, y: 61, z: 5 }); sim.give('undyed_shulker_box'); sim.give('bread', 64); sim.give('dirt', 224)
  sim.state.heldItem = { name: 'minecraft:undyed_shulker_box', slot: 0 }; sim.state.selectedSlot = 0
  const read = sim.adapter.getBlock
  sim.adapter.getBlock = (x, y, z) => key({ x, y, z }) === key(block.position) && sim.world.name(x, y, z) === 'leaf_litter' ? copy(block) : read(x, y, z)
  let calls = 0; const payloads = []
  sim.adapter.mine = async targets => {
    calls++; payloads.push(copy(targets))
    for (const target of targets) {
      assert.deepEqual(target.expectedProperties, block.properties)
      sim.world.set(target.x, target.y, target.z, 'air')
      sim.entities.push({ id: 900, name: 'minecraft:leaf_litter', count: block.properties.growth + 1, position: { x: target.x + .5, y: target.y, z: target.z + .5 } })
    }
    return { phase: 'completed' }
  }
  if (changeOnMove) sim.hooks.afterMove = () => { block.properties.growth = 3 }
  const config = { jobId: 'stateful-leaf', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 61, yBottom: 61, worldMinY: 50, worldMaxY: 75, inventory: { carryOnly: true, minFreeSlots: 1 } }
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, sleep: () => new Promise(resolve => setImmediate(resolve)) })
  assert.equal(job.plan(config).ready, true)
  return { sim, block, config, job, calls: () => calls, payloads }
}
async function until (fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('stateful leaf test timed out'); await new Promise(resolve => setTimeout(resolve, 3)) } }

test('planner, normal job dispatch and action checkpoint retain independent copies of the received state', async () => {
  const f = worldFixture(), regions = buildRegions({ ...f.config, travelRegion: [{ xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 }] })
  const planner = createQuarryPlanner({ regions, getBlock: f.sim.adapter.getBlock, exit: { mode: 'adjacent_pillar' } })
  const d = await planner.next({ feet: { x: -3, y: 61, z: 5 }, yTop: 61, tools: f.sim.state.inventory.items, inventoryItems: f.sim.state.inventory.items })
  assert.equal(d.action, 'mine'); assert.deepEqual(d.targets[0].properties, f.block.properties)
  assert.notEqual(d.targets[0].properties, f.block.properties)
  f.job.start()
  try {
    await until(() => f.job.status().ledger.picked === 3 || f.job.status().state === 'PAUSED')
    assert.equal(f.calls(), 1, JSON.stringify(f.job.status()))
    assert.equal(f.job.status().ledger.minedBlocks, 1); assert.equal(f.job.status().ledger.picked, 3)
    assert.deepEqual(f.payloads[0][0].expectedProperties, f.block.properties)
    const action = f.job.document().actions.find(a => a.type === 'mine')
    assert.deepEqual(action.targets[0].properties, f.block.properties)
    assert.equal(action.targets[0].runtimeId, f.block.runtimeId)
  } finally { await f.job.pause() }
})

test('missing metadata and same-name/same-runtime state changes remain unsent in the normal job', async () => {
  for (const options of [{ missing: true }, { changeOnMove: true }]) {
    const f = worldFixture(options); f.job.start()
    try {
      await until(() => f.job.status().state === 'PAUSED')
      assert.equal(f.job.status().pauseReason, options.missing ? 'DROP_RULE_UNKNOWN' : 'DROP_TARGET_STATE_CHANGED')
      assert.equal(f.calls(), 0); assert.equal(f.job.status().ledger.minedBlocks, 0)
      assert.equal(f.sim.world.name(7, 61, 7), 'leaf_litter')
    } finally { await f.job.pause() }
  }
})

test('runtime adapter preserves exact expected state in both batch preview and per-target fallback', async () => {
  const targets = [sample(1), sample(3)]; targets[1].position.x = 2
  const blocks = new Map(targets.map(t => [key(t.position), copy(t)])), seen = []; let phase = 'idle'
  const adapter = createQuarryRuntimeAdapter({ getState: () => ({}), getBlock: (x, y, z) => blocks.get(key({ x, y, z })), entities: () => [], mining: { preview: data => { seen.push(copy(data)); return { ready: data.length === 1 } }, start: async data => { seen.push(copy(data)); for (const t of data) blocks.set(key(t), { known: true, name: 'minecraft:air' }); phase = 'completed' } }, getMining: () => ({ phase }), movement: {}, getMovement: () => ({}), equip: async () => {}, placeQuarry: async () => {}, eat: async () => {}, chest: {}, stopAll: async () => {}, combatActive: () => false })
  await adapter.mine(targets.map(t => ({ ...t.position, expectedName: t.name, expectedRuntimeId: t.runtimeId, expectedProperties: copy(t.properties) })))
  assert.ok(seen.some(data => data.length === 2)); assert.ok(seen.some(data => data.length === 1))
  for (const t of seen.flat()) assert.deepEqual(t.expectedProperties, targets.find(expected => expected.position.x === t.x).properties)
})

const capacityFile = path.resolve(__dirname, 'quarry-capacity-batch.test.js'), capacityModule = new Module(capacityFile, module)
capacityModule.filename = capacityFile; capacityModule.paths = Module._nodeModulePaths(path.dirname(capacityFile))
capacityModule._compile(fs.readFileSync(capacityFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', capacityFile)
function capacityFixture (mode = 'normal') {
  const f = capacityModule.exports.fixture({ mode }), target = sample(3); target.position = { x: 1, y: 1, z: 4 }
  f.input.request.capacityBatch.decision.targets = [copy(target)]
  f.blocks.set(key(target.position), copy(target))
  f.ports.collectBatch = async ({ actionId }, { onCheckpoint }) => {
    const count = 4; f.state.inventory.items.push({ slot: 0, name: 'minecraft:leaf_litter', count, stackId: 800 })
    const receivedDrops = [{ runtimeId: '99', name: 'minecraft:leaf_litter', count }]
    await onCheckpoint({ receivedDrops }); return { actionId, serverConfirmed: true, receivedDrops, pendingDropIds: [] }
  }
  return { ...f, target }
}

test('capacity persists state fingerprints and never repairs a legacy missing-property or altered-property checkpoint', async () => {
  for (const missing of [true, false]) {
    const f = capacityFixture('mine_late_throw'); const first = await f.run()
    assert.equal(first.checkpoint.phase, 'mining')
    assert.deepEqual(first.checkpoint.originalTargets[0].properties, f.target.properties)
    const checkpoint = f.saved()
    if (missing) delete checkpoint.originalTargets[0].properties
    else checkpoint.originalTargets[0].properties.growth = 0
    const r = await f.run(f.create(), checkpoint)
    assert.equal(r.reason, 'CAPACITY_CHECKPOINT_INVALID'); assert.equal(f.mineCalls(), 1)
  }
})

test('capacity fresh metadata changes reject before mining, while unchanged saved state can reconcile without a second break', async () => {
  const changed = capacityFixture()
  changed.ports.refreshInventory = async () => { changed.blocks.get(key(changed.target.position)).properties.growth = 0; return true }
  assert.equal((await changed.run()).reason, 'CAPACITY_TARGET_CHANGED'); assert.equal(changed.mineCalls(), 0)
  const same = capacityFixture('mine_late_throw'); const first = await same.run()
  const r = await same.run(same.create(), first.checkpoint)
  assert.equal(r.status, 'completed', r.reason); assert.equal(same.mineCalls(), 1)
  assert.deepEqual(r.checkpoint.inventoryEvidence.minimum, [[{ name: 'leaf_litter', count: 4 }]])
})
