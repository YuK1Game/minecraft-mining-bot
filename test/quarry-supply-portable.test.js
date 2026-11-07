'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const file = path.resolve(__dirname, 'quarry-portable-storage.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item }\n', file)
const { fixture, item } = loaded.exports

function setup (work, options = {}) {
  const f = fixture('shulker', { full: true, ...options })
  const runner = createQuarryPortableStorage({ ...f.dependencies, workWithContainer: (context, settings) => work(f, context, settings) })
  f.controller.ownsShulker = runner.ownsShulker
  const request = { ...f.request, operationId: 'job:supplies:1:dirt', deposits: [], purpose: 'supply', supply: { binding: { role: 'dirt', itemName: 'minecraft:dirt' } } }
  const run = (checkpoint = null, extra = {}) => runner.storeCarried({ ...request, checkpoint }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(structuredClone(cp)) }, ...extra })
  return { ...f, runner, request, run }
}

function withdrawFive (f, position) {
  const slots = f.containers.get(`${position.x},${position.y},${position.z}`)
  slots[0] = { ...slots[0], count: slots[0].count - 5 }
  f.bag[32] = item(3, 5, 900)
}

test('supply work mounts one owned box, withdraws within the fresh window and recovers all remaining27slots exactly', async () => {
  const f = setup(async (f, context, { onCheckpoint }) => {
    assert.equal(f.dependencies.chest.snapshot().contentsKnown, true)
    assert.equal(context.request.purpose, 'supply')
    withdrawFive(f, context.position)
    await onCheckpoint({ phase: 'completed', jobId: 'job', operationId: context.request.operationId })
    return { status: 'completed', serverConfirmed: true, withdrawn: [{ name: 'minecraft:dirt', count: 5 }], returned: [] }
  })
  const result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(result.deposited.length, 0)
  assert.equal(result.checkpoint.supplyResult.withdrawn[0].count, 5)
  assert.equal(f.bag[32].count, 5)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  const box = f.bag.find(raw => raw.network_id === 2 && raw.count === 1)
  const entries = box.extra.nbt.nbt.value.Items.value.value
  assert.equal(entries.length, 27)
  assert.equal(entries.find(entry => entry.Slot.value === 0).Count.value, 59)
  assert.ok(entries.filter(entry => entry.Slot.value !== 0).every(entry => entry.Count.value === 64))
})

test('an interrupted supply callback persists its child checkpoint and resumes the same owned box without placing twice', async () => {
  let calls = 0
  const f = setup(async (f, context, { onCheckpoint }) => {
    calls++
    if (calls === 1) { await onCheckpoint({ intent: { type: 'withdraw', count: 5 }, marker: 'pending' }); return { status: 'blocked', reason: 'CONTROLLED_INTERRUPT', serverConfirmed: false } }
    assert.equal(context.checkpoint.marker, 'pending')
    withdrawFive(f, context.position)
    await onCheckpoint({ phase: 'completed' })
    return { status: 'completed', serverConfirmed: true, withdrawn: [{ name: 'minecraft:dirt', count: 5 }], returned: [] }
  })
  const first = await f.run()
  assert.equal(first.status, 'blocked'); assert.equal(first.reason, 'CONTROLLED_INTERRUPT')
  assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
  assert.equal(first.checkpoint.supplyCheckpoint.marker, 'pending')
  const second = await f.run(first.checkpoint)
  assert.equal(second.status, 'completed', second.reason)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('missing supply callback, ordinary deposit payload and unknown container contents cannot become supply success', async () => {
  const f = setup(async () => { throw new Error('unexpected callback') })
  const without = createQuarryPortableStorage(f.dependencies)
  assert.equal((await without.storeCarried(f.request, { onCheckpoint: async () => {} })).reason, 'STORAGE_SUPPLY_UNSUPPORTED')
  assert.equal((await f.runner.storeCarried({ ...f.request, deposits: f.dependencies ? [{ slot: 0, name: 'minecraft:dirt', count: 1 }] : [] }, { onCheckpoint: async () => {} })).reason, 'STORAGE_SUPPLY_DEPOSITS_FORBIDDEN')
  let called = false
  const unknown = setup(async () => { called = true }, { unknownContents: true })
  const result = await unknown.run()
  assert.equal(result.status, 'blocked'); assert.equal(called, false)
  assert.equal(unknown.events.filter(e => e.type === 'mine').length, 0)
})

test('a supply checkpoint cannot be adopted as ordinary storage or across a different life', async () => {
  const f = setup(async (f, context, { onCheckpoint }) => { await onCheckpoint({ intent: 'pending' }); return { status: 'blocked', reason: 'CONTROLLED_INTERRUPT' } })
  const first = await f.run()
  const wrong = await f.runner.storeCarried({ ...f.request, purpose: undefined, checkpoint: first.checkpoint }, { onCheckpoint: async () => {} })
  assert.equal(wrong.reason, 'STORAGE_CHECKPOINT_INVALID')
  f.state.lifecycle.deathId++
  const changed = await f.run(first.checkpoint)
  assert.equal(changed.status, 'blocked')
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
})
