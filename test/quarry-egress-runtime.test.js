'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryEgressRuntime } = require('../src/quarry-egress-runtime')

function fixture ({ dirt = 10, mineConfirmed = true, poseConfirmed = true, stepFailure = null, oracle = null } = {}) {
  const blocks = new Map(), moves = [], mines = [], steps = [], checkpoints = []
  const state = { phase: 'spawned', health: 20, profile: 'test', realm: { id: 'realm' }, connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 1 }, inventory: { known: true, items: [{ name: 'minecraft:dirt', count: dirt, slot: 0 }] }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1 }
  state.position = { ...state.rawServerPosition }
  let oracleCalls = 0
  const plan = { column: { x: 1, z: 0 }, entry: { x: 0, y: 65, z: 0 }, startFeet: { x: 1, y: 65, z: 0 }, targetFeetY: 67, requiredDirt: 2, reserveDirt: 8, clearTopY: 69, landing: { x: 2, y: 67, z: 0 }, shaftCells: [] }
  for (let y = 65; y <= 69; y++) { blocks.set(`1,${y},0`, 'minecraft:stone'); plan.shaftCells.push({ position: { x: 1, y, z: 0 }, name: 'minecraft:stone', expectedRuntimeId: 1, requiredTool: { slot: 1 } }) }
  const getBlock = (x, y, z) => { const name = blocks.get(`${x},${y},${z}`) ?? (y < 65 || x === 2 && y === 66 ? 'minecraft:stone' : 'minecraft:air'); return { known: true, name, runtimeId: name === 'minecraft:stone' ? 1 : name === 'minecraft:dirt' ? 2 : 0, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] } }
  const updatePose = p => { state.position = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 }; if (poseConfirmed) { state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++ } }
  const runtime = createQuarryEgressRuntime({ getState: () => state, getBlock,
    now: () => 10000,
    ...(oracle ? { confirmPosition: async (feet, options) => {
      const receipt = { serverConfirmed: true, kind: 'server_position_volume', feet: { ...feet }, radius: 0.12, requestId: 'runner-position-' + (++oracleCalls), receivedAt: new Date(10000).toISOString(), scope: JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, state.dimension, String(state.runtimeEntityId), state.lifecycle.deathId]) }
      return typeof oracle === 'function' ? oracle({ feet, options, receipt, state, count: oracleCalls }) : receipt
    } } : {}),
    moveTo: async p => { moves.push(p); updatePose(p) },
    mineTargets: async targets => { mines.push(targets); if (mineConfirmed) targets.forEach(t => blocks.set(`${t.position.x},${t.position.y},${t.position.z}`, 'minecraft:air')) },
    pillarStep: async (request, { onCheckpoint }) => {
      steps.push(request)
      const target = { ...request.column, y: request.feetY }, cp = { target, phase: 'intent', serverConfirmed: false }
      await onCheckpoint(cp)
      if (stepFailure) return { status: 'blocked', reason: stepFailure, checkpoint: cp, serverConfirmed: false }
      blocks.set(`${target.x},${target.y},${target.z}`, 'minecraft:dirt'); state.inventory.items[0].count--; updatePose({ ...target, y: target.y + 1 })
      Object.assign(cp, { phase: 'completed', serverConfirmed: true }); await onCheckpoint(cp)
      return { status: 'completed', serverConfirmed: true, checkpoint: cp }
    } })
  const run = checkpoint => runtime.run({ jobId: 'job', operationId: 'exit', plan, checkpoint }, { onCheckpoint: cp => checkpoints.push(cp) })
  return { run, state, plan, blocks, moves, mines, steps, checkpoints, get oracleCalls () { return oracleCalls } }
}

test('entry, bounded shaft mining, consecutive pillars and safe ground landing complete in order', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.serverConfirmed, true)
  assert.deepEqual(f.steps.map(s => s.feetY), [65, 66])
  assert.deepEqual(f.moves, [f.plan.startFeet, f.plan.landing])
  assert.equal(f.mines.length, 2)
  assert.equal(f.state.inventory.items[0].count, 8)
  assert.equal(result.checkpoint.pendingStep, null)
  assert.equal(result.checkpoint.steps.length, 2)
})

test('dirt reserve is checked before entering the outside column', async () => {
  const f = fixture({ dirt: 9 }), result = await f.run()
  assert.equal(result.reason, 'EXIT_DIRT_REQUIRED')
  assert.equal(f.moves.length, 0)
  assert.equal(f.mines.length, 0)
})

test('predicted mining success and predicted movement alone do not progress the exit', async () => {
  for (const options of [{ mineConfirmed: false }, { poseConfirmed: false }]) {
    const f = fixture(options), result = await f.run()
    assert.equal(result.status, 'blocked')
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.steps.length, 0)
  }
})

test('an uncertain interrupted pillar is checkpointed and never automatically placed again', async () => {
  const f = fixture({ stepFailure: 'COMBAT' }), first = await f.run()
  assert.equal(first.reason, 'COMBAT')
  assert.equal(first.checkpoint.pendingStep.phase, 'intent')
  const resumed = await f.run(first.checkpoint)
  assert.equal(resumed.reason, 'ASCENT_UNCERTAIN_STEP')
  assert.equal(f.steps.length, 1)
})

test('a reload between the saved completed step and runner commit reconciles that step once', async () => {
  const f = fixture()
  const result = await f.run()
  const interrupted = f.checkpoints.find(cp => cp.pendingStep?.phase === 'completed' && cp.confirmedFeetY === 65)
  f.state.rawServerPosition = { x: 1.5, y: 67.62, z: 0.5 }; f.state.rawServerPositionUpdatedAt++
  f.blocks.delete('1,66,0'); f.blocks.set('1,66,0', 'minecraft:air'); f.state.inventory.items[0].count = 9
  const count = f.steps.length
  const resumed = await f.run(interrupted)
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
  assert.deepEqual(f.steps.slice(count).map(step => step.feetY), [66])
  assert.equal(result.checkpoint.steps.length, 2)
})

test('water replacing a planned shaft cell is not mined', async () => {
  const f = fixture(); f.blocks.set('1,68,0', 'minecraft:water')
  const result = await f.run()
  assert.equal(result.reason, 'EGRESS_SHAFT_CHANGED')
  assert.equal(f.mines.length, 0)
})

test('persisted completion belongs to its original connection and life even when dirt and position still match', async () => {
  for (const change of [state => { state.connectionId = 'new-socket' }, state => { state.lifecycle.deathId++ }]) {
    const f = fixture(), completed = await f.run()
    assert.equal(completed.status, 'completed')
    assert.equal(completed.checkpoint.life, 1)
    assert.equal(typeof completed.checkpoint.scope, 'string')
    const placements = f.steps.length, moves = f.moves.length
    change(f.state)
    const restored = await f.run(completed.checkpoint)
    assert.equal(restored.reason, 'EGRESS_SCOPE_CHANGED')
    assert.equal(restored.serverConfirmed, false)
    assert.equal(f.steps.length, placements)
    assert.equal(f.moves.length, moves)
  }
})

test('legacy checkpoints without a persisted scope and life require explicit reconciliation', async () => {
  const f = fixture(), completed = await f.run()
  delete completed.checkpoint.scope; delete completed.checkpoint.life
  const restored = await f.run(completed.checkpoint)
  assert.equal(restored.reason, 'EGRESS_SCOPE_CHANGED')
  assert.equal(restored.serverConfirmed, false)
})

test('an unfinished intent from a previous life is rejected before checkpoint reconciliation or resending', async () => {
  const f = fixture({ stepFailure: 'COMBAT' }), interrupted = await f.run()
  assert.equal(interrupted.checkpoint.pendingStep.phase, 'intent')
  f.state.lifecycle.deathId++
  const calls = f.steps.length, saves = f.checkpoints.length
  const restored = await f.run(interrupted.checkpoint)
  assert.equal(restored.reason, 'EGRESS_SCOPE_CHANGED')
  assert.equal(f.steps.length, calls)
  assert.equal(f.checkpoints.length, saves)
})

test('runner move and surface landing use bounded server receipts when the raw pose stays old', async () => {
  const f = fixture({ poseConfirmed: false, oracle: true })
  const original = { ...f.state.rawServerPosition }, stamp = f.state.rawServerPositionUpdatedAt
  const result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.checkpoint.positionEvidence.kind, 'server_position_volume')
  assert.deepEqual(result.checkpoint.positionEvidence.feet, { x: 2.5, y: 67, z: 0.5 })
  assert.ok(f.oracleCalls >= 3)
  assert.deepEqual(f.state.rawServerPosition, original)
  assert.equal(f.state.rawServerPositionUpdatedAt, stamp)
})

test('a failed, queued, stale or wrong-scope runner position receipt stops before entry work', async () => {
  for (const modify of [r => ({ ...r, serverConfirmed: false }), r => ({ ...r, kind: 'queued_command' }), r => ({ ...r, receivedAt: new Date(9999).toISOString() }), r => ({ ...r, scope: 'wrong-scope' })]) {
    const f = fixture({ poseConfirmed: false, oracle: ({ receipt }) => modify(receipt) })
    const result = await f.run()
    assert.equal(result.status, 'blocked')
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.mines.length, 0)
    assert.equal(f.steps.length, 0)
  }
})

test('oracle resume reconciles a persisted completed step without replaying it or changing raw state', async () => {
  const f = fixture({ poseConfirmed: false, oracle: true })
  await f.run()
  const interrupted = f.checkpoints.find(cp => cp.pendingStep?.phase === 'completed' && cp.confirmedFeetY === 65)
  f.state.position = { x: 1.5, y: 67.62, z: 0.5 }
  f.blocks.set('1,66,0', 'minecraft:air'); f.state.inventory.items[0].count = 9
  const before = f.steps.length, raw = { ...f.state.rawServerPosition }, stamp = f.state.rawServerPositionUpdatedAt
  const result = await f.run(interrupted)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(f.steps.slice(before).map(s => s.feetY), [66])
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(f.state.rawServerPositionUpdatedAt, stamp)
})

test('scope changes during a runner oracle response are rejected before mining or movement', async () => {
  const f = fixture({ poseConfirmed: false, oracle: ({ receipt, state }) => { state.lifecycle.deathId++; return receipt } })
  const result = await f.run()
  assert.equal(result.reason, 'EGRESS_SCOPE_CHANGED')
  assert.equal(f.moves.length, 0)
  assert.equal(f.mines.length, 0)
})
