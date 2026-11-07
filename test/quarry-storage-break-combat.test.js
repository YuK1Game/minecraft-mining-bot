'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createSim } = require('./helpers/quarry-sim')

const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', file)
const copy = value => structuredClone(value)
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const scope = state => JSON.stringify([state.profile, state.realm.id, state.dimension, state.connectionId, state.startedAt])
async function until (predicate) {
  const end = Date.now() + 3500
  while (!predicate()) { if (Date.now() >= end) throw Error('timed out waiting for transition'); await turn() }
}

async function fixture (fault = null) {
  const f = loaded.exports('shulker')
  // Persist our actual placement/window receipt and the exact deposit before
  // the break starts. This is the shape saved for the storage:52 interruption.
  const abort = new AbortController()
  let checkpoint
  await f.run({ signal: abort.signal, onCheckpoint: async cp => {
    if (!checkpoint && cp.stage === 'breaking' && cp.intent?.type === 'break') { checkpoint = copy(cp); abort.abort() }
  } })
  assert.equal(checkpoint.placed[0].confirmedBy, 'server_block_and_inventory')
  assert.equal(checkpoint.deposited[0].count, 8)
  const p = checkpoint.placed[0].position, placed = f.getBlock(p.x, p.y, p.z)
  let stopped, suppressAir = false, invocations = 0, entryContext = null, oldCheckpoint
  let clock = Date.now(), receipt = { sequence: 0 }, job, firstError
  const events = [], stops = []
  const runner = createQuarryPortableStorage({
    ...f.dependencies,
    getBlock: (x,y,z) => suppressAir && same({x,y,z}, p) ? copy(placed) : f.getBlock(x,y,z),
    mine: async target => {
      assert.equal(target.ownershipKey, checkpoint.operationId)
      // The server has accepted this single break. Delay the observed air
      // until the storage monitor has read the intervening mining stop.
      const started = await f.dependencies.mine(target)
      suppressAir = true
      stopped = { phase: 'stopped', operation: 'owned_shulker', reason: 'user_behavior', completed: [], remaining: [copy(target)] }
      if (fault === 'other_reason') stopped.reason = 'tool changed'
      if (fault === 'no_reason') delete stopped.reason
      if (fault === 'failed') stopped.phase = 'failed'
      if (fault === 'other_operation') stopped.operation = 'access_clearance'
      if (fault === 'other_target') stopped.remaining[0].x++
      if (fault === 'other_runtime') stopped.remaining[0].expectedRuntimeId++
      if (fault === 'other_name') stopped.remaining[0].expectedName = 'minecraft:red_shulker_box'
      if (fault === 'other_owner') stopped.remaining[0].ownershipKey += ':other'
      if (fault === 'completed_target') stopped.completed = [copy(target)]
      if (fault === 'second_target') stopped.remaining.push(copy(target))
      return started
    },
    getMining: () => copy(stopped ?? { phase: 'idle' })
  })
  f.controller.ownsShulker = runner.ownsShulker
  let settleSecond
  const secondGate = new Promise(resolve => { settleSecond = resolve })
  const sim = createSim(), adapter = {
    ...sim.adapter, getBlock: f.getBlock, getState: () => ({ ...f.getState(), food: 20, maxHealth: 20 }),
    combatActive: () => false, userControlInterruption: () => copy(receipt), stopAll: async why => stops.push(why),
    storeCarried: async (req, options) => {
      assert.equal(req.operationId, checkpoint.operationId)
      invocations++
      if (invocations === 2 && fault === 'late_callback') await secondGate
      if (invocations !== 1) return runner.storeCarried(req, options)
      oldCheckpoint = options.onCheckpoint
      entryContext = job.storageInterruptionContext()
      if (fault !== 'no_evidence') receipt = { ...entryContext, kind: 'combat', sequence: 1, claimedAt: clock, claimId:'owned-break', life:f.state.lifecycle.deathId, scope:scope(f.state), outcome:'ready', preemptionStarted:true }
      if (fault === 'foreign_claim_scope') receipt.scope += ':foreign'
      if (fault === 'foreign_claim_life') receipt.life++
      const result = await runner.storeCarried(req, options)
      assert.equal(result.reason, 'STORAGE_BREAK_FAILED')
      firstError = copy(result)
      suppressAir = false
      if (fault === 'legacy') delete result.details
      if (fault === 'foreign_stop_scope') result.details.scope.connectionId += ':other'
      if (fault === 'foreign_stop_op') result.details.operationId += ':other'
      if (fault === 'tampered_intent') result.checkpoint.intent.position.x++
      if (fault === 'tampered_placement') result.checkpoint.placed[0].runtimeId++
      return result
    }
  }
  job = createQuarryJob({ adapter, pollMs: 25, now: () => clock, log: line => events.push(line), storage:{save:async()=>{}},
    sleep: async ms => { clock += ms; await turn() } })
  job.plan({jobId: f.request.jobId, yTop:65, yBottom:65, worldMinY:63, worldMaxY:69, target:{chunks:[{x:0,z:0}]}, quarryCombat:{enabled:true}, inventory:{carryOnly:true}})
  const saved = job.document()
  Object.assign(saved, { state:'PAUSED', userRunIntent:'paused', pauseReason:'MANUAL_PAUSE', scope:scope(f.state), life:f.state.lifecycle.deathId,
    portableStorage:{operationId:checkpoint.operationId, why:'capacity', selection:f.request.selection, checkpoint} })
  job.load(saved); f.events.length=0
  return { job, f, checkpoint, events, stops, calls:()=>invocations, error:()=>firstError, old:()=>oldCheckpoint, release:settleSecond }
}

test('an owned break stopped by this exact combat claim is reconciled from delayed air and new box NBT once', async () => {
  const h=await fixture();h.job.resume()
  try {
    await until(()=>h.job.document().carriedStorageReceipts?.includes(h.checkpoint.operationId)||h.job.status().state==='PAUSED')
    const d=h.job.document(),r=h.error()
    assert.equal(r.details.kind,'owned_shulker_mining_stop')
    assert.equal(r.details.mining.reason,'user_behavior')
    assert.equal(r.details.mining.target.ownershipKey,h.checkpoint.operationId)
    assert.ok(h.events.some(e=>e.includes('"to":"COMBAT"')))
    assert.ok(!h.stops.includes('quarry:COMBAT'))
    assert.equal(d.carriedStorageReceipts.filter(id=>id===h.checkpoint.operationId).length,1)
    assert.equal(h.calls(),2)
    assert.equal(d.ledger.deposited.dirt,8)
    assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
    assert.equal(h.f.events.filter(e=>['place','deposit'].includes(e.type)).length,0)
  } finally { h.release();await h.job.pause() }
})

test('a different or missing stop reason, identity, checkpoint or combat receipt remains a hard storage failure', async t=>{
  for(const fault of ['other_reason','no_reason','failed','other_operation','other_target','other_runtime','other_name','other_owner','completed_target','second_target','foreign_stop_scope','foreign_stop_op','foreign_claim_scope','foreign_claim_life','no_evidence','legacy','tampered_intent','tampered_placement']) await t.test(fault,async()=>{
    const h=await fixture(fault);h.job.resume()
    try {
      await until(()=>h.job.status().state==='PAUSED')
      assert.equal(h.calls(),1)
      assert.ok(!h.events.some(e=>e.includes('"to":"COMBAT"')))
      assert.ok(!h.job.document().carriedStorageReceipts?.includes(h.checkpoint.operationId))
      assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
    } finally {h.release();await h.job.pause()}
  })
})

test('an old break callback is fenced while the next call reconciles the same box', async()=>{
  const h=await fixture('late_callback');h.job.resume()
  try {
    await until(()=>h.calls()===2||h.job.status().state==='PAUSED')
    assert.equal(h.calls(),2)
    const stale=copy(h.checkpoint);stale.stage='placing';stale.placed=[]
    await assert.rejects(h.old()(stale),/STALE_CHECKPOINT/)
    assert.deepEqual(h.job.document().portableStorage.checkpoint,h.checkpoint)
    h.release()
    await until(()=>h.job.document().carriedStorageReceipts?.includes(h.checkpoint.operationId))
    assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
  } finally {h.release();await h.job.pause()}
})
