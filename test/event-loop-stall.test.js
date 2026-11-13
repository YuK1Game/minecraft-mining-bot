'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createEventLoopStallWatch } = require('../src/event-loop-stall')

test('event-loop stalls are reported with context and rate limited', () => {
  let t = 0; const reports = []
  const watch = createEventLoopStallWatch({ now: () => t, wallNow: () => 0, context: () => 'EGRESS', report: r => reports.push(r), setTimer: () => ({}), clearTimer: () => {} })
  watch.start()
  t += 100; watch.check()                 // on time
  assert.equal(reports.length, 0)
  t += 800; watch.check()                 // blocked 700 ms
  assert.deepEqual(reports[0], { stallMs: 700, doing: 'EGRESS', suppressed: 0, stalls: 1, worstMs: 700 })
  t += 400; watch.check()                 // within the report gap: counted, not logged
  assert.equal(reports.length, 1)
  t += 10000; watch.check()
  assert.equal(reports.length, 2)
  assert.equal(reports[1].suppressed, 1)
  assert.equal(watch.stats().stalls, 3)
})
