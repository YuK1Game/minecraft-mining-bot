'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getEventListeners } = require('node:events')
const { createOperationScope } = require('../src/operation-scope')
const { createActionOwnerTracker } = require('../src/action-owner-tracker')

test('aborting a pending child cancels both owned controllers once and fences later work', async () => {
  const abort = new AbortController(), owners = createActionOwnerTracker(), stopped = []
  const native = kind => ({ start () {}, stop () { stopped.push(kind) } })
  const mining = native('mining'), equip = native('equip')
  for (const controller of [mining, equip]) owners.track(controller, ['start'], { invalidate: ['stop'] })
  let entered, release, laterWork = 0
  const ready = new Promise(resolve => { entered = resolve }), retiring = new Promise(resolve => { release = resolve })
  const scope = createOperationScope({
    signal: abort.signal,
    captureOwner: kind => owners.createOwner({ kind }),
    runOwned: owners.run,
    cancelOwned: (kind, owner) => { const controller = kind === 'mining' ? mining : equip; owners.cancel(controller, owner, () => controller.stop()) }
  })
  const task = scope.perform('mining', async () => {
    mining.start()
    await scope.perform('equip', async () => {
      equip.start(); entered(); await retiring
      // A retired native promise may finish later; its next scoped input is
      // rejected even after the caller has already released the operation.
      await scope.perform('equip', () => { laterWork++ })
    })
    laterWork++
  })
  const rejected = assert.rejects(task, /OPERATION_ABORTED/)
  await ready
  abort.abort(); scope.cancel(); scope.dispose()
  await rejected
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(stopped, ['equip', 'mining'])
  assert.equal(laterWork, 0)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

test('successful nested work releases its listener and never cancels a later operation', async () => {
  const abort = new AbortController(), cancelled = []
  const scope = createOperationScope({ signal: abort.signal, cancelOwned: kind => cancelled.push(kind) })
  assert.equal(await scope.perform('parent', async () => 1 + await scope.perform('child', async () => 2)), 3)
  scope.dispose(); scope.dispose(); abort.abort()
  assert.deepEqual(cancelled, [])
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  await assert.rejects(scope.perform('late', () => assert.fail('disposed scope dispatched')), /OPERATION_ABORTED/)
})

test('cleanup failures preserve the original action failure and still unwind its parent', async () => {
  const cancelled = [], failure = new Error('received action failed')
  const scope = createOperationScope({ cancelOwned: kind => { cancelled.push(kind); if (kind === 'child') throw new Error('cleanup failed'); return Promise.reject(new Error('async cleanup failed')) } })
  await assert.rejects(scope.perform('parent', () => scope.perform('child', () => { throw failure })), error => error === failure)
  scope.cancel(); scope.dispose()
  assert.deepEqual(cancelled, ['child', 'parent'])
})
