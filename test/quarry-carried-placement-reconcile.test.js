'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createQuarryPortableStorage, UNSENT_PLACE_REASON } = require('../src/quarry-portable-storage')
const file = path.resolve(__dirname, 'quarry-portable-storage.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', file)

function setup ({ preview = null } = {}) {
  const f = loaded.exports.fixture('shulker'); let refuse = true, fresh = true, refreshes = 0
  const interaction = { pendingOperation: null, lastResult: { phase: 'completed', operation: 'open', windowId: 16 } }
  const request = { ...f.request, operationId: 'job:storage:27' }
  const runner = createQuarryPortableStorage({ ...f.dependencies, interactions: { snapshot: () => structuredClone(interaction), ...(preview ? { previewPlace: preview } : {}), placeBlock: options => { if (refuse) throw Error(UNSENT_PLACE_REASON); return f.dependencies.interactions.placeBlock(options) } }, refreshInventory: async () => { refreshes++; return fresh } })
  f.controller.ownsShulker = runner.ownsShulker
  const run = checkpoint => runner.storeCarried({ ...request, checkpoint }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(structuredClone(cp)) } })
  const reconcile = (checkpoint, extra = {}, args = {}) => runner.reconcileUnsentPlacement({ jobId: request.jobId, operationId: request.operationId, purpose: 'cargo', selection: structuredClone(request.selection), checkpoint, reason: UNSENT_PLACE_REASON, ...args }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(structuredClone(cp)) }, ...extra })
  return { ...f, runner, request, run, reconcile, interaction, allow: () => { refuse = false }, fresh: value => { fresh = value }, refreshes: () => refreshes }
}

test('normal cargo reconciliation reads fresh exact source and preserves op27, its transfers and inventory without dispatch', async () => {
  const f = setup(), failed = await f.run(), before = structuredClone(f.bag), events = f.events.length
  const r = await f.reconcile(failed.checkpoint)
  assert.equal(r.status, 'reconciled', r.reason); assert.equal(r.notSent, true); assert.equal(f.refreshes(), 1)
  assert.equal(r.checkpoint.operationId, 'job:storage:27'); assert.deepEqual(r.checkpoint.plan, failed.checkpoint.plan)
  assert.deepEqual(r.checkpoint.deposited, []); assert.deepEqual(r.checkpoint.placed, [])
  assert.equal(r.checkpoint.intent, null); assert.equal(r.checkpoint.stage, 'planned')
  assert.equal(r.checkpoint.placementSourcePin.stackId, f.bag[failed.checkpoint.intent.slot].stack_id)
  assert.deepEqual(f.bag, before); assert.equal(f.events.length, events)
  assert.notDeepEqual(r.checkpoint.positions, failed.checkpoint.positions)
  f.allow(); const completed = await f.run(r.checkpoint)
  assert.equal(completed.status, 'completed', completed.reason); assert.equal(completed.recovered, true)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
})

test('normal cargo uncertain source, pending/sent transaction, changed world/scope and failed freshness never clear intent', async t => {
  for (const mode of ['source', 'source_binding', 'pending', 'sent', 'occupied', 'unknown', 'life', 'fresh', 'capacity', 'transferred']) await t.test(mode, async () => {
    const f = setup(), failed = await f.run(), checkpoint = structuredClone(failed.checkpoint), p = checkpoint.intent.position
    if (mode === 'source') f.bag[checkpoint.intent.slot].stack_id++
    if (mode === 'source_binding') f.request.selection.sources[0].stackId++
    if (mode === 'pending') f.interaction.pendingOperation = 'place'
    if (mode === 'sent') f.interaction.lastResult = { phase: 'requested', operation: 'place' }
    if (mode === 'occupied') f.blocks.set(`${p.x},${p.y},${p.z}`, { known: true, name: 'minecraft:stone', boundingBox: 'block', runtimeId: 7 })
    if (mode === 'unknown') f.blocks.set(`${p.x},${p.y},${p.z}`, { known: false })
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'fresh') f.fresh(false)
    if (mode === 'capacity') checkpoint.purpose = 'capacity_batch'
    if (mode === 'transferred') checkpoint.plan[0].transferred = 1
    let saves = 0
    const r = await f.reconcile(checkpoint, { onCheckpoint: async () => { saves++ } })
    assert.equal(r.status, 'blocked'); assert.equal(saves, 0)
    assert.deepEqual(r.checkpoint.intent, checkpoint.intent)
    assert.equal(f.events.filter(e => e.type === 'place').length, 0)
  })
})

test('only the exact recorded pre-begin reason and explicit cargo binding may use the normal recovery path', async () => {
  const f = setup(), failed = await f.run()
  for (const args of [{ reason: 'timeout' }, { purpose: undefined }, { selection: { ...f.request.selection, key: 'wrong' } }]) assert.equal((await f.reconcile(failed.checkpoint, {}, args)).status, 'blocked')
  const r = await f.reconcile(failed.checkpoint, { onCheckpoint: async () => { throw Error('write failed') } })
  assert.equal(r.status, 'blocked'); assert.deepEqual(r.checkpoint, failed.checkpoint)
})

test('a known final-eye preview refusal creates no placement intent and excludes that site before bounded retry', async () => {
  const f = setup({ preview: () => ({ ready: false, errors: [UNSENT_PLACE_REASON] }) })
  const first = await f.run()
  assert.equal(first.status, 'replan'); assert.equal(first.serverConfirmed, false)
  assert.equal(first.checkpoint.stage, 'planned'); assert.equal(first.checkpoint.intent, null)
  assert.equal(first.checkpoint.rejectedPlacementSites.length, 1)
  assert.equal(f.events.filter(e => e.type === 'place').length, 0)
  const second = await f.run(first.checkpoint)
  assert.equal(second.status, 'replan'); assert.equal(second.checkpoint.rejectedPlacementSites.length, 2)
  assert.notDeepEqual(second.checkpoint.positions, first.checkpoint.positions)
})
