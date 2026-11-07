'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryEgressRuntime } = require('../src/quarry-egress-runtime')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

async function until (predicate) {
  const end = Date.now() + 5000
  while (!predicate()) { if (Date.now() >= end) throw new Error('Entry path regression timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
function fixture () {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.fill(0, 60, 0, 15, 62, 15, 'air'); sim.world.set(-4, 63, -4, 'chest')
  sim.setFeet({ x: 15, y: 60, z: 15 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('dirt', 64)
  const config = { jobId: 'long-egress-entry', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90, exit: { mode: 'adjacent_pillar', side: 'west' }, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } }
  const docs = []
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, d) => docs.push(d) }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  return { sim, config, docs, job }
}

test('a far pit entry is saved as a path and reaches the real runner through ordinary short adapter segments', async () => {
  const { sim, config, docs, job } = fixture(), moves = []
  let poseStamp = 1, phase = 'idle', receivedPlan
  const getState = () => ({ ...sim.adapter.getState(), rawServerPosition: { ...sim.state.position }, rawServerPositionUpdatedAt: poseStamp })
  const adapter = createQuarryRuntimeAdapter({ getState, getBlock: sim.adapter.getBlock, entities: () => [],
    movement: {
      preview: target => ({ ready: Math.hypot(target.x - sim.state.position.x, target.z - sim.state.position.z) <= 12, reason: 'Target lies outside the bounded search area' }),
      start: target => {
        const distance = Math.hypot(target.x - sim.state.position.x, target.z - sim.state.position.z)
        assert.ok(distance <= 12, 'the native 12m bound remains intact')
        moves.push({ from: sim.feet(), to: { x: target.x - 0.5, y: target.y, z: target.z - 0.5 }, distance })
        sim.setFeet({ x: target.x - 0.5, y: target.y, z: target.z - 0.5 }); poseStamp++; phase = 'completed'
      }
    }, getMovement: () => ({ phase }), mining: { preview: () => ({ ready: false }), start () {}, stop () {} }, getMining: () => ({ phase: 'idle' }), equip: async () => ({}), placeQuarry: async () => ({}), eat: async () => ({}), chest: {}, stopAll: async () => {}, combatActive: () => false })
  const runner = createQuarryEgressRuntime({ getState, getBlock: sim.adapter.getBlock,
    moveTo: (p, settings) => adapter.moveTo(p, settings),
    mineTargets: async targets => { for (const { position: p } of targets) sim.world.set(p.x, p.y, p.z, 'air') },
    pillarStep: async (r, { onCheckpoint }) => {
      const target = { ...r.column, y: r.feetY }, cp = { jobId: r.jobId, operationId: r.operationId, target, phase: 'intent' }
      await onCheckpoint(cp)
      sim.world.set(target.x, target.y, target.z, 'dirt'); sim.setFeet({ ...target, y: target.y + 1 }); poseStamp++
      sim.state.inventory.items.find(i => i.name === 'minecraft:dirt').count--
      Object.assign(cp, { phase: 'completed', serverConfirmed: true }); await onCheckpoint(cp)
      return { status: 'completed', serverConfirmed: true, checkpoint: cp }
    } })
  sim.adapter.egress = async (request, options) => { receivedPlan = request.plan; return runner.run(request, options) }
  job.plan(config); job.start()
  try {
    await until(() => ['FINISHED', 'PAUSED'].includes(job.status().state))
    assert.equal(job.status().state, 'FINISHED', JSON.stringify(job.status().pauseDetails))
    assert.deepEqual(receivedPlan.entryPath[0], { x: 15, y: 60, z: 15 })
    assert.deepEqual(receivedPlan.entryPath.at(-1), receivedPlan.entry)
    assert.ok(Math.hypot(receivedPlan.entry.x - 15, receivedPlan.entry.z - 15) > 12)
    assert.ok(moves.length >= 5)
    assert.ok(moves.every(m => m.distance <= 12))
    assert.ok(docs.some(d => d.egress?.plan?.entryPath?.length > 12))
    assert.equal(job.status().egress.surfaceReturned, true)
  } finally { await job.pause() }
})

test('a paused entry keeps its operation and recomputes the saved route from the current same-life position', async () => {
  const { sim, config, job } = fixture(), requests = []
  sim.adapter.egress = async request => {
    requests.push(structuredClone(request))
    if (requests.length === 1) return { status: 'blocked', reason: 'EXIT_TEST_HOLD', serverConfirmed: false, checkpoint: { jobId: request.jobId, operationId: request.operationId, phase: 'entry' } }
    sim.setFeet(request.plan.landing)
    return { status: 'completed', serverConfirmed: true, checkpoint: { jobId: request.jobId, operationId: request.operationId, phase: 'completed' } }
  }
  job.plan(config); job.start()
  try {
    await until(() => job.status().state === 'PAUSED')
    assert.equal(job.status().pauseReason, 'EXIT_TEST_HOLD')
    sim.setFeet({ x: 12, y: 60, z: 15 })
    job.resume()
    await until(() => ['FINISHED', 'PAUSED'].includes(job.status().state))
    assert.equal(job.status().state, 'FINISHED', JSON.stringify(job.status().pauseDetails))
    assert.equal(requests[1].operationId, requests[0].operationId)
    assert.deepEqual(requests[0].plan.entryPath[0], { x: 15, y: 60, z: 15 })
    assert.deepEqual(requests[1].plan.entryPath[0], { x: 12, y: 60, z: 15 })
    assert.deepEqual(requests[1].plan.entryPath.at(-1), requests[1].plan.entry)
  } finally { await job.pause() }
})
