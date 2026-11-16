'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecorder, describeRecent } = require('../src/common/work-spans')

test('a wrapped call passes its result, this and errors through and is timed', () => {
  let clock = 0
  const spans = createRecorder({ now: () => clock })
  const slow = spans.wrap('slow', function (ms, value) { clock += ms; return [this?.tag, value] })
  assert.deepEqual(slow.call({ tag: 't' }, 40, 7), ['t', 7])
  const boom = spans.wrap('boom', () => { clock += 30; throw new Error('no') })
  assert.throws(() => boom(), /no/)
  spans.wrap('quick', () => { clock += 2 })()
  assert.deepEqual(spans.recent(1000), { covered: 70, spans: [{ name: 'slow', ms: 40, calls: 1 }, { name: 'boom', ms: 30, calls: 1 }] })
})

test('nested spans are listed but only the outer one counts toward the covered time', () => {
  let clock = 0
  const spans = createRecorder({ now: () => clock })
  const inner = spans.wrap('inner', () => { clock += 20 })
  const outer = spans.wrap('outer', () => { clock += 10; inner(); inner() })
  outer()
  assert.deepEqual(spans.recent(1000), { covered: 50, spans: [{ name: 'outer', ms: 50, calls: 1 }, { name: 'inner', ms: 40, calls: 2 }] })
  assert.equal(describeRecent(1000, spans), 'outer 50ms / inner 40ms×2（計測した処理の合計 50ms）')
})

test('only spans inside the window are reported, and an empty window says nothing', () => {
  let clock = 0
  const spans = createRecorder({ now: () => clock })
  spans.wrap('old', () => { clock += 50 })()
  clock += 1000
  assert.equal(describeRecent(300, spans), null)
  spans.wrap('new', () => { clock += 50 })()
  assert.deepEqual(spans.recent(300).spans.map(span => span.name), ['new'])
})

test('wrapAll wraps functions only; an async function is timed up to its first await', async () => {
  let clock = 0
  const spans = createRecorder({ now: () => clock })
  const wrapped = spans.wrapAll('m', { LIMIT: 3, run: async () => { clock += 12; await null; clock += 500; return 'done' } })
  assert.equal(wrapped.LIMIT, 3)
  assert.equal(await wrapped.run(), 'done')
  assert.deepEqual(spans.recent(10000).spans, [{ name: 'm.run', ms: 12, calls: 1 }])
})
