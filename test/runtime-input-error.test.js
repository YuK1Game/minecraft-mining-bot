'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.resolve(__dirname, '../src/runtime.js'), 'utf8')
const start = source.indexOf('    function onInputError (error) {')
const end = source.indexOf('    const generationStream =', start)
assert.ok(start >= 0 && end > start)

function fixture (owner, phase, activeTarget) {
  const stopped = [], invalidated = [], pillarCancelled = []
  let cursor = { tick: '7001', queuedAt: Date.now() - 235 }
  const context = { currentGeneration: () => true, inputOwner: owner, idleFailureAt: 0,
    generationPillar: { cancel: reason => pillarCancelled.push(reason) }, queuedForageLandingFrames: [],
    generationHistory: { snapshot: () => ({ cursor }), invalidate: reason => { invalidated.push(reason); cursor = null } },
    raw: () => ({ phase: 'spawned', dead: false, positionSource: 'server_post_move' }),
    movement: { snapshot: () => ({ phase: 'stopped' }) },
    mining: { snapshot: () => ({ phase, activeTarget }), stop: (...args) => stopped.push(args) },
    host: { shared: { motionSource: 'idle_physics', deathRespawn: { deathId: 1 } } }, Date }
  const handler = vm.runInNewContext(source.slice(start, end) + '\nonInputError', context)
  return { context, stopped, invalidated, pillarCancelled, handler }
}

test('idle input error captures the real cursor before reset without inventing a mining failure', () => {
  const f = fixture('idle', 'idle', null)
  f.handler(new Error('Queued input handoff timer stalled'))
  assert.equal(f.stopped.length, 0)
  assert.deepEqual(f.invalidated, ['input_failed'])
  const detail = f.context.host.shared.lastInputFailure
  assert.equal(detail.owner, 'idle')
  assert.equal(detail.cursorTick, '7001')
  assert.ok(detail.cursorAgeMs >= 235)
  assert.equal(detail.deathId, 1)
  assert.equal(detail.rawPhase, 'spawned')
  assert.equal(detail.rawSource, 'server_post_move')
  assert.equal(detail.movementPhase, 'stopped')
  assert.equal(detail.lastSource, 'idle_physics')
  assert.equal(f.context.inputOwner, 'none')
  assert.equal(f.context.host.shared.idleError, detail.error)
  assert.ok(JSON.stringify(detail).length < 1024)
  assert.deepEqual(f.pillarCancelled, ['Queued input handoff timer stalled'])
})

test('cancelling an active pillar does not erase the original input failure owner or queued cursor', () => {
  const f = fixture('task', 'idle', null)
  f.context.generationPillar.cancel = () => { f.context.inputOwner = 'idle' }
  f.handler(new Error('pillar input failed'))
  assert.equal(f.context.host.shared.lastInputFailure.owner, 'task')
  assert.equal(f.context.host.shared.lastInputFailure.cursorTick, '7001')
  assert.equal(f.context.inputOwner, 'none')
  assert.equal(f.stopped.length, 0)
})

test('only active mining owned by the task fails; confirmation and inactive targets retain their state', () => {
  for (const [owner, phase, target, expected] of [['task', 'mining', { x: 1, y: 2, z: 3 }, 1], ['task', 'confirming', { x: 1, y: 2, z: 3 }, 0], ['idle', 'mining', { x: 1, y: 2, z: 3 }, 0], ['task', 'mining', null, 0]]) {
    const f = fixture(owner, phase, target)
    f.handler(new Error('input failed'))
    assert.equal(f.stopped.length, expected, `${owner}:${phase}`)
    if (expected) assert.deepEqual(f.stopped[0], ['input failed', 'failed'])
  }
})
