'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { summarizeCpuProfile, profileCpu, measureSnapshots } = require('../src/runtime-diagnostics')

const profile = () => ({ nodes: [
  { id: 1, callFrame: { functionName: 'read actors', url: 'file:///G:/Project/src/actor view.js', lineNumber: 4 } },
  { id: 2, callFrame: { functionName: 'snapshot', url: 'G:\\Project\\src\\actor view.js', lineNumber: 9 } },
  { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } }
], samples: [1, 2, 1, 3], timeDeltas: [1000, 2000, 1000, 4000] })

test('CPU summaries keep self time, idle denominator and paths with spaces without mutating the recording', () => {
  const recorded = profile(), before = structuredClone(recorded)
  const summary = summarizeCpuProfile(recorded)
  assert.equal(summary.totalMs, 8)
  assert.deepEqual(summary.topFunctions, [{ k: '(idle) :0', ms: 4, pct: 50 }, { k: 'read actors actor view.js:5', ms: 2, pct: 25 }, { k: 'snapshot actor view.js:10', ms: 2, pct: 25 }])
  assert.deepEqual(summary.topFiles, [{ k: 'actor view.js', ms: 4, pct: 50 }, { k: '', ms: 4, pct: 50 }])
  assert.deepEqual(recorded, before)
  assert.deepEqual(summarizeCpuProfile({ nodes: [], samples: [], timeDeltas: [] }), { totalMs: 0, topFunctions: [], topFiles: [] })
})

test('snapshot timing failures are isolated and preserve the existing snapshot-only duration and length fields', () => {
  let tick = 0
  const value = { health: 20 }, result = measureSnapshots({ state: () => value, missing: () => undefined, failure: () => { throw new Error('x'.repeat(100)) }, unserializable: () => 1n }, { now: () => tick++ })
  assert.deepEqual(result.state, { ms: 1, bytes: JSON.stringify(value).length })
  assert.deepEqual(result.missing, { ms: 1, bytes: 4 })
  assert.equal(result.failure.error.length, 80)
  assert.match(result.unserializable.error, /BigInt/)
  assert.deepEqual(value, { health: 20 })
})

function capture ({ failAt = null, writeFails = false } = {}) {
  const calls = [], recording = profile()
  const session = { connect: () => calls.push('connect'), disconnect: () => calls.push('disconnect'), post: (method, params, done) => { calls.push([method, params]); done(method === failAt ? new Error('profile failed') : null, method === 'Profiler.stop' ? { profile: recording } : {}) } }
  const options = { outputDir: path.join('fixture', '.local'), createSession: () => session, sleep: async ms => calls.push(['sleep', ms]), now: () => 42, writeFile: async (file, text) => { calls.push(['write', file, JSON.parse(text)]); if (writeFails) throw new Error('write failed') } }
  return { calls, options, recording }
}

test('CPU capture is explicit, clamps duration, writes the recording and always closes its session', async () => {
  for (const [requested, expected] of [[10, 1000], [90000, 60000]]) {
    const f = capture()
    assert.deepEqual(f.calls, [])
    const result = await profileCpu(requested, f.options)
    assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'sleep'), ['sleep', expected])
    assert.equal(result.file, path.join('fixture', '.local', 'cpu-42.cpuprofile'))
    assert.equal(result.totalMs, 8)
    assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'write')[2], f.recording)
    assert.equal(f.calls.at(-2)[0], 'Profiler.disable')
    assert.equal(f.calls.at(-1), 'disconnect')
  }
})

test('CPU capture failure still disables and disconnects the inspector', async () => {
  for (const failure of [{ failAt: 'Profiler.start' }, { writeFails: true }]) {
    const f = capture(failure)
    await assert.rejects(profileCpu(1000, f.options), /failed/)
    assert.equal(f.calls.at(-2)[0], 'Profiler.disable')
    assert.equal(f.calls.at(-1), 'disconnect')
  }
})
