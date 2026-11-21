'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { createLadderMovement } = require('../src/actions/ladder')
const { createPhysics } = require('../src/movement/physics')
const { requestMine } = require('../src/modes/mining/mine-controller')
const { modeState, playerActivity } = require('../scripts/lib/player-activity')

test('real ladder refusal reaches mining with its code, route evidence and one diagnostic per unchanged stop', async t => {
  const f = createMineWorld(t)
  const getBlock = () => ({ known: false })
  const physics = createPhysics({ world: { getBlock } })
  let sent = 0
  const ladder = createLadderMovement({ getState: f.ctx.runtime.mineState, getBlock, getPhysics: () => physics,
    getInput: () => null, acquireInput: () => { sent++ }, ownsInput: () => false, releaseInput () {} })
  f.ctx.runtime.mineLadderMove = ladder.move
  f.ctx.runtime.mineLadderDiagnostics = () => ({ ladder: ladder.snapshot(), ladderOwnsInput: false, activeBehavior: null, position: null })
  f.branch.shaft = { depth: 68 }
  const request = { from: { x: 1.5, y: 65, z: 0.5 }, to: { x: 1.5, y: 68, z: 0.5 }, column: { x: 0, z: 0 }, operationId: 'mine:result-test' }
  const first = await f.ctx.minePorts.ladderMove(request)
  assert.equal(first.code, 'LADDER_ORIGIN_UNSUPPORTED')
  assert.equal(first.status, 'blocked')
  assert.equal(first.serverConfirmed, false)
  assert.equal(first.retry.kind, 'terrain_received')
  assert.equal(first.evidence.ladder.planId, f.plan.id)
  assert.equal(first.evidence.ladder.depth, 68)
  assert.equal(first.evidence.ladder.phase, 'preparing')
  assert.equal(first.evidence.ladder.operationId, request.operationId)
  assert.deepEqual(first.evidence.ladder.to, request.to)
  assert.match(first.detail, /足場/)
  await f.ctx.minePorts.ladderMove(request)
  assert.equal(f.lines.filter(line => line.includes('LADDER_ORIGIN_UNSUPPORTED')).length, 1)
  assert.equal(sent, 0)
})

test('mining keeps a predicted arrival unconfirmed and carries the position verifier reason', async t => {
  const f = createMineWorld(t), request = { from: f.feet(), to: { ...f.feet(), y: 66 }, operationId: 'mine:receipt-test' }
  f.ctx.runtime.mineLadderMove = async () => ({ status: 'completed', serverConfirmed: false, queuedFrames: 20 })
  f.ctx.runtime.mineLadderDiagnostics = () => ({ ladderOwnsInput: false, position: { pending: false, lastResult: { reason: 'POSITION_TIMEOUT', serverConfirmed: false, feet: request.to } } })
  const unconfirmed = await f.ctx.minePorts.ladderMove(request)
  assert.equal(unconfirmed.status, 'blocked')
  assert.equal(unconfirmed.code, 'LADDER_POSITION_UNCONFIRMED')
  assert.equal(unconfirmed.serverConfirmed, false)
  assert.equal(unconfirmed.evidence.serverConfirmed, false)
  assert.equal(unconfirmed.evidence.ladder.position.reason, 'POSITION_TIMEOUT')
  const witness = { kind: 'server_position', stamp: 'received-2', serverConfirmed: true }
  f.ctx.runtime.mineLadderMove = async () => ({ status: 'completed', serverConfirmed: true, positionEvidence: witness, to: request.to, queuedFrames: 22 })
  const complete = await f.ctx.minePorts.ladderMove(request)
  assert.equal(complete.code, 'MINE_LADDER_ARRIVED')
  assert.equal(complete.serverConfirmed, true)
  assert.equal(complete.retry, null)
  assert.deepEqual(complete.positionEvidence, witness)
})

test('preemption, unavailable input and a changed life remain non-completions', async t => {
  const f = createMineWorld(t), request = { from: f.feet(), to: f.feet(), operationId: 'mine:owner-test' }
  f.ctx.runtime.mineLadderMove = async () => ({ status: 'interrupted', reason: 'LADDER_INPUT_CHANGED', phase: 'climb', queuedFrames: 8 })
  f.ctx.runtime.mineLadderDiagnostics = () => ({ ladderOwnsInput: false, activeBehavior: 'combat' })
  const interrupted = await f.ctx.minePorts.ladderMove(request)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.code, 'LADDER_INPUT_CHANGED')
  assert.equal(interrupted.retry.kind, 'owner_released')
  assert.equal(interrupted.evidence.ladder.activeBehavior, 'combat')
  f.ctx.runtime.mineLadderMove = async () => ({ status: 'interrupted', reason: 'user_behavior' })
  assert.equal((await f.ctx.minePorts.ladderMove(request)).code, 'LADDER_INTERRUPTED')
  delete f.ctx.runtime.mineLadderMove
  assert.equal((await f.ctx.minePorts.ladderMove(request)).code, 'MINE_LADDER_UNAVAILABLE')
  f.ctx.runtime.mineLadderMove = async () => { f.raw.lifecycle.deathId++; return { status: 'completed', serverConfirmed: true } }
  assert.equal((await f.ctx.minePorts.ladderMove(request)).code, 'MINE_SCOPE_CHANGED')
})

test('ladder failure detail reaches the existing player activity through actual mine construction', async t => {
  const f = createMineWorld(t)
  f.ctx.runtime.mineLadderMove = async () => ({ status: 'blocked', reason: 'LADDER_POSITION_UNCONFIRMED', phase: 'climb', queuedFrames: 12 })
  const out = await requestMine(f.ctx, { resource: 'raw_iron', targetHeld: 1 })
  assert.equal(out.result.code, 'LADDER_POSITION_UNCONFIRMED', JSON.stringify(out))
  assert.match(out.reason, /位置.*サーバー/)
  assert.match(out.reason, /昇降/)
  const activity = playerActivity(modeState({ mode: 'player', player: { running: true, reason: out.reason, phase: 'working', stages: [] } }))
  assert.equal(activity.detail, out.reason)
  assert.ok(f.digs.length > 0, 'the real shaft is prepared before the ladder boundary is reached')
})
