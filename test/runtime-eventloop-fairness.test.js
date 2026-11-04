'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { patchRuntimeEventloop } = require('../.local/runtime-eventloop-transform.cjs')
const copy = value => structuredClone(value)

function fixture (t, { mode = 'normal', watchHook = null, observationHook = null } = {}) {
  const file = path.resolve(__dirname, 'runtime-idle-safety.test.js')
  let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  source = source.replace('  const calls = [];', '  const guardCalls = [];\n  const calls = [];')
  source = source.replace('  const overrides = {', `  const overrides = {
    './terrain-threats': { ...nativeRequire('./terrain-threats'), annotateTerrainThreats: (...args) => { if (observationHook?.active) { observationHook.reads++; const end = performance.now() + observationHook.ms; while (performance.now() < end) {} }; return nativeRequire('./terrain-threats').annotateTerrainThreats(...args) } },
    './threats': { ...nativeRequire('./threats'), evaluateThreats: (...args) => { if (watchHook?.active) watchHook.assessments++; return nativeRequire('./threats').evaluateThreats(...args) } },
    './guarded-route': { createGuardedRoute: options => ({ snapshot: () => ({ busy: false }), stop: async () => {}, escape: async (nodes, bounds) => { guardCalls.push({ nodes, bounds }); return { ok: false, arrived: false, escaped: false, movementStarts: 0, code: 'SUPPORT_UNKNOWN', serverConfirmed: false } } }) },`)
  source = source.replace("fs.readFileSync(filename, 'utf8')", "runtimeForTest(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'))")
  source = source.replace('  const target = { exports: {} };', "  overrides['./movement'] = { createMovement: options => nativeRequire('./movement').createMovement(options) }\n  const target = { exports: {} };")
  source = source.replace('return { runtime, create, host, raw, shared,', 'return { guardCalls, runtime, create, host, raw, shared,')
  const loaded = { exports: {} }
  const runtimeForTest = value => value.includes('const yieldCandidatePlanning = async') ? value : patchRuntimeEventloop(value)
  new vm.Script('(function(require,module,__filename,__dirname,runtimeForTest,watchHook,observationHook){' + source + '\nmodule.exports={fixture};})', { filename: file }).runInThisContext()(Module.createRequire(file), loaded, file, path.dirname(file), runtimeForTest, watchHook, observationHook)
  const f = loaded.exports.fixture(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Runtime fairness fixtures remain entirely offline'))
  f.shared.loadingScreenEnded = true
  f.actors.push({ kind: 'mob', runtimeId: '9', uniqueId: '-9', entityType: 'minecraft:creeper', dimension: 'overworld', alive: true, hostile: true, positionKnown: true, charged: false, primed: false, position: { x: -3.5, y: 65, z: 0.5 } })
  const original = f.host.world.getBlock
  let queries = 0, expensive = false
  f.host.world.getBlock = (x, y, z) => {
    queries++
    if (expensive) { const end = performance.now() + 0.2; while (performance.now() < end) {} }
    return original(x, y, z)
  }
  const signal = new AbortController()
  return { ...f, signal, queries: () => queries, setExpensive: value => { expensive = value }, run: () => f.safeties[0].options.escape({ operationId: 7, signal: signal.signal, threats: [], ...(mode === 'actor' ? { onPreMovementReplan: () => false } : {}) }) }
}

test('Runtime ordinary BFS and first-pass headings let a real 50ms heartbeat run during expensive known-block queries', { timeout: 6000 }, async t => {
  const watchHook = { active: false, assessments: 0, samples: [] }, nativeInterval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => nativeInterval(ms !== 25 ? callback : (...values) => {
    const before = watchHook.assessments; watchHook.active = true
    try { callback(...values) } finally { watchHook.active = false; watchHook.samples.push(watchHook.assessments - before) }
  }, ms, ...args))
  const f = fixture(t, { watchHook }); let beats = 0, previous = performance.now(), maxGap = 0
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++ }, 50)
  t.after(() => clearInterval(beat))
  f.setExpensive(true)
  const start = Date.now(), result = await f.run()
  clearInterval(beat); f.setExpensive(false)
  assert.ok(f.queries() > 500)
  assert.ok(beats >= 2, JSON.stringify({ beats, queries: f.queries(), result }))
  assert.ok(maxGap < 200, `50ms heartbeat gap ${maxGap.toFixed(1)}ms`)
  assert.ok(f.shared.lowHealthWaterTiming.maxSlice.escapeCandidateSlice < 100, JSON.stringify(f.shared.lowHealthWaterTiming.maxSlice))
  assert.ok(f.guardCalls.length > 0, JSON.stringify(result))
  assert.ok(watchHook.samples.length > 0)
  assert.ok(watchHook.samples.every(count => count === 1), JSON.stringify(watchHook.samples))
  assert.ok(f.guardCalls.every(call => call.bounds.maxMovementStarts === 5 && call.bounds.timeoutMs <= 4000))
  assert.ok(Date.now() - start < 4000)
  assert.ok(f.packets.every(packet => packet.name !== 'inventory_transaction'))
  t.diagnostic(`50ms heartbeat ${beats} turns, max gap ${maxGap.toFixed(1)}ms; candidate max slice ${f.shared.lowHealthWaterTiming.maxSlice.escapeCandidateSlice}ms`)
})

test('Runtime fresh post-yield death, actor identity and cancellation checks reject planning before any route queue', { timeout: 6000 }, async t => {
  for (const mode of ['death', 'actor', 'cancel']) await t.test(mode, async t => {
    const f = fixture(t, { mode }), nativeImmediate = globalThis.setImmediate
    let changed = false
    t.mock.method(globalThis, 'setImmediate', (callback, ...args) => nativeImmediate(() => {
      if (!changed) {
        changed = true
        if (mode === 'death') { f.raw.health = 0; f.raw.dead = true }
        if (mode === 'actor') f.actors[0].uniqueId = '-999'
        if (mode === 'cancel') f.signal.abort(new Error('explicit planning cancellation'))
      }
      callback(...args)
    }))
    try { await f.run() } catch { /* Rejection is the expected bounded outcome. */ }
    assert.equal(changed, true)
    assert.equal(f.guardCalls.length, 0, mode)
    assert.equal(f.packets.length, 0, mode)
  })
})

test('Runtime full-depth cheap-cell enumeration with 20ms fresh observations still reaches a planned route inside its original four seconds', { timeout: 6000 }, async t => {
  const observationHook = { active: false, ms: 20, reads: 0 }, f = fixture(t, { observationHook })
  f.actors[0].position.x = -5.5 // Ordinary 256-node bound, rather than urgent 24-node mode.
  let beats = 0, previous = performance.now(), maxGap = 0
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; beats++ }, 50)
  t.after(() => clearInterval(beat))
  observationHook.active = true
  const started = Date.now(), result = await f.run(), elapsed = Date.now() - started
  observationHook.active = false; clearInterval(beat)
  assert.ok(f.queries() > 1000, String(f.queries()))
  assert.ok(f.guardCalls.length > 0, JSON.stringify({ result, elapsed, reads: observationHook.reads }))
  assert.ok(elapsed < 4000, String(elapsed))
  assert.ok(f.guardCalls[0].bounds.timeoutMs > 0 && f.guardCalls[0].bounds.timeoutMs < 4000)
  assert.equal(f.guardCalls[0].bounds.maxMovementStarts, 5)
  assert.ok(beats >= 2); assert.ok(maxGap < 200, String(maxGap))
  t.diagnostic(`Reached native-previewed Guard route in ${elapsed}ms with ${observationHook.reads} slow observations; ${beats} heartbeat turns, max gap ${maxGap.toFixed(1)}ms`)
})
