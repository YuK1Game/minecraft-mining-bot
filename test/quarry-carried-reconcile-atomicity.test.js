'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { createQuarryPortableStorage, UNSENT_PLACE_REASON } = require('../src/quarry-portable-storage')
const { createQuarryJob } = require('../src/quarry-job')
const { selectCarriedStorage } = require('../src/quarry-inventory')
const { createSim } = require('./helpers/quarry-sim')

const fixtureFile = require.resolve('./quarry-portable-storage.test')
const fixtureModule = new Module(fixtureFile, module)
fixtureModule.filename = fixtureFile
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
fixtureModule._compile(fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports = fixture\n', fixtureFile)

async function setup () {
  const f = fixtureModule.exports('shulker')
  // Match the live failure's hotbar slot. Slot 1 is initially empty and
  // can later receive an indistinguishable box with a different stack ID.
  ;[f.bag[8], f.bag[14]] = [f.bag[14], f.bag[8]]
  f.request.selection = selectCarriedStorage(f.items())
  let refusePlacement = true
  const dispatched = [], writes = [], faults = {}
  const runner = createQuarryPortableStorage({
    ...f.dependencies, refreshInventory: async () => true,
    interactions: {
      ...f.dependencies.interactions,
      snapshot: () => ({ pendingOperation: null, lastResult: { operation: 'open', phase: 'completed' } }),
      placeBlock: options => {
        if (refusePlacement) throw Error(UNSENT_PLACE_REASON)
        dispatched.push(f.bag[options.slot].stack_id)
        return f.dependencies.interactions.placeBlock(options)
      }
    }
  })
  f.controller.ownsShulker = runner.ownsShulker
  const run = (checkpoint, onCheckpoint = async () => {}) => runner.storeCarried({ ...f.request, checkpoint }, { onCheckpoint })
  const failed = await run(null)
  assert.equal(failed.reason, UNSENT_PLACE_REASON)
  assert.equal(failed.checkpoint.intent.slot, 8)
  assert.equal(failed.checkpoint.placed.length, 0)
  refusePlacement = false

  const sim = createSim()
  const adapter = { ...sim.adapter, getState: f.getState, getBlock: f.getBlock,
    reconcileCarriedPlacement: async (request, options) => {
      const result = await runner.reconcileUnsentPlacement(request, options)
      // After the checkpoint proposal but before final acceptance: a
      // failing final inspection must never be recorded as a durable repair.
      return faults.lateRefusal ? { status: 'blocked', reason: 'STORAGE_SCOPE_CHANGED' } : result
    } }
  const job = createQuarryJob({ adapter, storage: { save: async (id, document) => {
    if (faults.persistence) throw Error('test disk write failed')
    writes.push(structuredClone(document))
  } } })
  job.plan({ jobId: f.request.jobId, yTop: 65, yBottom: 65, target: { chunks: [{ x: 0, z: 0 }] }, inventory: { carryOnly: true } })
  const doc = job.document(), op = f.request.operationId
  Object.assign(doc, {
    state: 'PAUSED', pauseReason: 'CARRIED_STORAGE_BLOCKED', userRunIntent: 'paused',
    pauseDetails: { reason: UNSENT_PLACE_REASON, operationId: op, kind: 'shulker' },
    portableStorage: { operationId: op, selection: f.request.selection, why: 'capacity', checkpoint: failed.checkpoint },
    actions: [{ type: 'carried_storage', operationId: op, status: 'blocked', result: failed }]
  })
  job.load(doc)
  return { f, job, original: job.document(), faults, writes, dispatched, run }
}

test('late refusal after a cargo checkpoint proposal retains the saved placement intent and remains retryable', async () => {
  const { job, original, faults, writes } = await setup()
  faults.lateRefusal = true
  const response = await job.reconcileCarriedPlacement()
  assert.equal(response.carriedPlacementReconciliation.status, 'blocked')
  assert.deepEqual(job.document().portableStorage, original.portableStorage)
  assert.deepEqual(job.document().pauseDetails, original.pauseDetails)
  assert.deepEqual(writes, [])
  faults.lateRefusal = false
  assert.equal((await job.reconcileCarriedPlacement()).carriedPlacementReconciliation.status, 'reconciled')
})

test('publish a reconciled checkpoint and pause status together, and restore both when its save fails', async () => {
  const { job, original, faults, writes } = await setup()
  faults.persistence = true
  await Promise.allSettled([job.reconcileCarriedPlacement()])
  const failed = job.document()
  assert.deepEqual(failed.portableStorage, original.portableStorage)
  assert.deepEqual(failed.pauseDetails, original.pauseDetails)
  assert.equal(failed.pauseReason, original.pauseReason)
  assert.deepEqual(writes, [])
  faults.persistence = false
  const response = await job.reconcileCarriedPlacement()
  assert.equal(response.carriedPlacementReconciliation.status, 'reconciled')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].portableStorage.checkpoint.intent, null)
  assert.equal(writes[0].pauseReason, 'MANUAL_PAUSE')
  assert.deepEqual(job.document().portableStorage, writes[0].portableStorage)
})

test('a newly observed identical shulker in an earlier slot cannot replace the reconciled cargo stack', async () => {
  const { job, f, dispatched, run } = await setup()
  const response = await job.reconcileCarriedPlacement()
  assert.equal(response.carriedPlacementReconciliation.status, 'reconciled')
  const originalId = f.bag[8].stack_id
  f.bag[1] = { ...structuredClone(f.bag[8]), stack_id: originalId + 2000 }
  const resumed = await run(job.document().portableStorage.checkpoint)
  assert.equal(resumed.status, 'completed', resumed.reason)
  assert.deepEqual(dispatched, [originalId])
  assert.equal(f.bag[1].stack_id, originalId + 2000)
})

test('an identical replacement occupying the pinned hotbar slot is refused before any placement', async () => {
  const { job, f, dispatched, run } = await setup()
  const response = await job.reconcileCarriedPlacement()
  assert.equal(response.carriedPlacementReconciliation.status, 'reconciled')
  f.bag[8] = { ...structuredClone(f.bag[8]), stack_id: f.bag[8].stack_id + 2000 }
  const blocked = await run(job.document().portableStorage.checkpoint)
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(dispatched, [])
})

test('a server slot replacement received while persisting the placement intent is not dispatched', async () => {
  const { job, f, dispatched, run } = await setup()
  assert.equal((await job.reconcileCarriedPlacement()).carriedPlacementReconciliation.status, 'reconciled')
  const originalId = f.bag[8].stack_id
  const result = await run(job.document().portableStorage.checkpoint, async checkpoint => {
    if (checkpoint.intent?.type === 'place') f.bag[8] = { ...structuredClone(f.bag[8]), stack_id: originalId + 2000 }
  })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(dispatched, [])
})
