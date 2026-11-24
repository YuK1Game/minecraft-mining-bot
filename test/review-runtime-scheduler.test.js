'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createScheduler } = require('../src/common/runtime-scheduler')

test('runtime-scheduler: prevents overlap, throttles errors, wraps spans, and clears on dispose', async () => {
  const callbacks = new Map()
  let nextId = 1
  let cleared = []
  const logs = []
  const spans = []
  let nowMs = 1000
  let disposed = false

  const scheduler = createScheduler({
    isDisposed: () => disposed,
    log: line => logs.push(line),
    wrapSpan: (name, fn) => (...args) => { spans.push(name); return fn(...args) },
    now: () => nowMs,
    setIntervalImpl: fn => { const id = nextId++; callbacks.set(id, fn); return { id, unref () {} } },
    clearIntervalImpl: handle => { cleared.push(handle.id); callbacks.delete(handle.id) }
  })

  let releaseAsync
  let asyncRuns = 0
  const asyncTask = scheduler.every('async-job', 100, () => {
    asyncRuns++
    return new Promise(resolve => { releaseAsync = resolve })
  })

  // First tick starts async job; second tick while in-flight is skipped.
  callbacks.get(1)()
  callbacks.get(1)()
  assert.equal(asyncRuns, 1)
  releaseAsync()
  await Promise.resolve()
  callbacks.get(1)()
  assert.equal(asyncRuns, 2)
  assert.equal(spans[0], 'timer.async-job')

  // Failing task logs once inside throttle window and never throws out.
  const failing = scheduler.every('bad-job', 100, () => { throw new Error('boom') }, { errorThrottleMs: 5000 })
  callbacks.get(2)()
  callbacks.get(2)()
  assert.equal(failing.errors(), 2)
  assert.equal(logs.length, 1)
  nowMs += 6000
  callbacks.get(2)()
  assert.equal(logs.length, 2)

  // Dispose clears all timers cleanly.
  scheduler.disposeAll()
  assert.deepEqual(cleared.sort(), [1, 2])
  assert.equal(asyncTask.active(), false)
  assert.equal(scheduler.snapshot().length, 0)
  disposed = true
})
