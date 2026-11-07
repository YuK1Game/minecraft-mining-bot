'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryEgressRuntime } = require('../src/quarry-egress-runtime')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

// Controller integration with explicit simulated server receipts. This does
// not model the network/physics and is not a live-Realm acceptance result.
function fixture ({ failFinalSave = false } = {}) {
  const sim = createSim({ loaded: { xMin: -8, xMax: 24, yMin: 55, yMax: 80, zMin: -8, zMax: 24 } })
  flatTerrain(sim, { x1: -8, x2: 24, z1: -8, z2: 24, bedrock: 55, stoneTop: 61, top: 62 })
  sim.world.fill(0, 62, 0, 15, 62, 15, 'air')
  for (const x of [10, 11, 12]) sim.world.set(x, 62, 4, 'stone')
  sim.world.set(-4, 63, -4, 'chest')
  sim.setFeet({ x: 8, y: 62, z: 4 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 20); sim.give('dirt', 192)
  const pose = () => { sim.state.rawServerPosition = { ...sim.state.position }; sim.state.rawServerPositionUpdatedAt = (sim.state.rawServerPositionUpdatedAt ?? 0) + 1 }
  pose()
  let job
  const steps = [], writes = []
  const egress = createQuarryEgressRuntime({ getState: sim.adapter.getState, getBlock: sim.adapter.getBlock,
    moveTo: async point => { await sim.adapter.moveTo(point); pose() },
    mineTargets: async targets => {
      for (const target of targets) {
        if (target.requiredTool?.slot != null) await sim.adapter.equip(target.requiredTool.slot)
        await sim.adapter.mine([{ ...target.position, expectedName: target.name }])
      }
    },
    pillarStep: async (request, { onCheckpoint }) => {
      assert.equal(job.document().finalDeposited, true, 'storage completes before any pillar step')
      const target = { ...request.column, y: request.feetY }
      const checkpoint = { target, phase: 'intent', serverConfirmed: false }
      await onCheckpoint(checkpoint)
      const dirt = sim.state.inventory.items.find(item => item.name === 'minecraft:dirt')
      await sim.adapter.place({ position: target, slot: dirt.slot, expectedBlock: 'minecraft:dirt' })
      sim.setFeet({ ...target, y: target.y + 1 }); pose()
      Object.assign(checkpoint, { phase: 'completed', serverConfirmed: true })
      await onCheckpoint(checkpoint); steps.push(target)
      return { status: 'completed', serverConfirmed: true, checkpoint }
    }
  })
  sim.adapter.egress = (request, options) => egress.run(request, options)
  job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, storage: { save: async (id, document) => {
    if (failFinalSave && document.state === 'FINISHED') throw new Error('final checkpoint write failed')
    writes.push(structuredClone(document))
  } } })
  const config = { jobId: 'review-lifecycle', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 62, worldMinY: 55, worldMaxY: 80, inventory: { keepSealBlocks: 0, storage: [{ position: { x: -4, y: 63, z: -4 } }] } }
  assert.equal(job.plan(config).ready, true)
  return { sim, job, steps, writes }
}
async function complete (job) {
  job.start()
  const end = Date.now() + 15000
  while (!['PAUSED', 'FINISHED'].includes(job.status().state)) {
    if (Date.now() > end) { await job.pause(); throw new Error('Lifecycle simulation timed out') }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await job.drain()
}
test('review: quarry, observed pickup, storage, shaft mining, pillar and surface return complete in sequence', async () => {
  const { sim, job, steps, writes } = fixture()
  await complete(job)
  assert.equal(job.status().state, 'FINISHED', JSON.stringify(job.status()))
  assert.equal(job.status().egress.miningCompleted, true)
  assert.equal(job.status().egress.surfaceReturned, true)
  assert.ok(sim.stats.mined >= 4)
  assert.ok(sim.stats.deposits > 0)
  assert.ok(sim.chest.some(item => item.name === 'minecraft:cobblestone' && item.count > 0))
  assert.equal(steps.length, 1)
  assert.equal(writes.at(-1).state, 'FINISHED')
  assert.ok(writes.find(document => document.exitPreflight?.ready && !document.miningCompletedAt))
})
test('review: a failed completion checkpoint never publishes durable FINISHED even after a confirmed return', async () => {
  const { job, writes } = fixture({ failFinalSave: true })
  await complete(job)
  assert.equal(job.status().state, 'PAUSED')
  assert.equal(job.status().pauseReason, 'PERSISTENCE_FAILED')
  assert.equal(job.status().result.intendedResult, 'COMPLETED')
  assert.equal(job.status().egress.surfaceReturned, true, 'physical return and durable job completion stay distinct')
  assert.equal(writes.some(document => document.state === 'FINISHED'), false)
  assert.throws(() => job.resume(), { code: 'PERSISTENCE_FAILED' })
})
