'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createStallProfile, summarize } = require('../src/runtime/stall-profile')

test('the samples inside the stall are summed per function, callers included', () => {
  const frame = (functionName, url, lineNumber) => ({ functionName, url, lineNumber })
  const profile = {
    startTime: 0, endTime: 1000000,
    nodes: [
      { id: 1, callFrame: frame('(root)', '', 0), children: [2, 5] },
      { id: 2, callFrame: frame('plan', 'file:///bot/src/survival/tunneling.js', 177), children: [3] },
      { id: 3, callFrame: frame('edge', 'file:///bot/src/survival/tunneling.js', 231), children: [4] },
      { id: 4, callFrame: frame('get', 'node:internal/map', 1), children: [] },
      { id: 5, callFrame: frame('tick', 'file:///bot/src/combat/combat-coordinator.js', 9), children: [] }
    ],
    // 0.5 s of combat ticks long before the stall, then 0.5 s inside the planner.
    samples: [5, 5, 3, 4, 3, 2, 3],
    timeDeltas: [250000, 250000, 100000, 100000, 100000, 100000, 100000]
  }
  const top = summarize(profile, 450, { root: '/bot' })
  assert.deepEqual(top.map(entry => entry.name), ['plan src/survival/tunneling.js:178', 'edge src/survival/tunneling.js:232'])
  assert.deepEqual(top.map(entry => entry.total), [100, 80])
  assert.equal(top[1].self, 60, 'time in a built-in is not the caller\'s own')
  assert.deepEqual(summarize(null, 500), [])
})

test('a real profile names a busy function, and stop releases the session', async () => {
  const lines = []
  let settled = 0
  assert.equal(await createStallProfile({ root: '/nowhere' }).explain(900), null, 'off without the flag file')
  const profile = createStallProfile({ log: line => lines.push(line), samplingUs: 1000, minStallMs: 50, enabled: () => true, settled: () => settled++ })
  await profile.start()
  const spinForTheTest = () => { const until = Date.now() + 250; let n = 0; while (Date.now() < until) n += Math.sqrt(n + 1); return n }
  spinForTheTest()
  const top = await profile.explain(250)
  await profile.stop()
  assert.ok(top.some(entry => entry.name.startsWith('spinForTheTest ')), JSON.stringify(top))
  assert.match(lines[0], /^処理の停止の内訳 250ms: /)
  assert.equal(await profile.explain(250), null, 'nothing after stop')
  assert.equal(settled, 2, 'the stall watch is told after each profile start')
})
