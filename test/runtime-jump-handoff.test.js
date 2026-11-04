'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const capture = require('./fixtures/bounded-jump-postlanding.json')
const file = path.resolve(__dirname, 'runtime-bounded-jump.test.js')
const parent = { exports: {} }
const prefix = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
new vm.Script(Module.wrap(prefix + '\nmodule.exports={source}'), { filename: file }).runInThisContext()(parent.exports, Module.createRequire(file), parent, file, path.dirname(file))
let source = parent.exports.source
source = source.replace("  t.mock.timers.enable({ apis: ['setInterval'] })", '')
source = source.replace('  const epoch = Date.parse(jumpCapture.observedAt)', '  const epoch = Date.now()')
source = source.replace("  t.mock.method(Date, 'now', () => epoch + elapsed)", '')
source = source.replace('const advance = ms => { elapsed += ms; t.mock.timers.tick(ms) }', 'const advance = ms => new Promise(resolve => setTimeout(resolve, ms))')
source = source.replaceAll('clock: () => elapsed', 'clock: () => performance.now()')
source = source.replaceAll('epoch + elapsed', 'Date.now()')
source = source.replace('postJump = true', 'postJump = true; await advance(50)')
source = source.replace('  const calls = [];', '  const phases = [], inputSamples = [], inputErrors = []; let coldPhysics = 0, fixturePhysics = null\n  const calls = [];')
source = source.replace('  const overrides = {', `  const overrides = {
    './physics': { createPhysics: options => { coldPhysics++; fixturePhysics = nativeRequire('./physics').createPhysics(options); return fixturePhysics } },
    './navigation': { createNavigator: options => {
      const value = nativeRequire('./navigation').createNavigator(options), create = value.createStepper
      value.createStepper = (...args) => {
        const stepper = create(...args), next = stepper.next
        const profile = { kind: 'rehearsal', postJump, ms: 0, steps: 0, inputBefore: inputSamples.length, inputAfter: inputSamples.length }; phases.push(profile)
        let start = null
        stepper.next = () => { start ??= performance.now(); const result = next(); profile.ms = performance.now() - start; profile.steps++; profile.inputAfter = inputSamples.length; return result }
        return stepper
      }
      return value
    } },`)
source = source.replace("const value = nativeRequire('./input').createInput({ ...options,", "const value = nativeRequire('./input').createInput({ ...options, onQueuedFrame: frame => { inputSamples.push({ at: frame.queuedAt, postJump }); options.onQueuedFrame(frame) }, onError: error => { inputErrors.push({ error: error.message, postJump }); options.onError(error) },")
source = source.replace('return preview(target, settings)', `const started = performance.now(), count = inputSamples.length; try { return preview(target, settings) } finally { phases.push({ kind: 'movement_preview', postJump, ms: performance.now() - started, inputBefore: count, inputAfter: inputSamples.length }) }`)
source = source.replace('postJump = true; await advance(50)', `postJump = true; await advance(50)
          for (let tries = 0; tries < 10 && !inputSamples.some(value => value.postJump); tries++) await advance(10)
          phases.push({ kind: 'landing_handoff', at: performance.now(), point: host.getState().position })
          if (mode === 'wall_native_load') {
            const reader = host.world.getBlock, native = fixturePhysics.withWorld({ getBlock: reader })
            // Controlled native collision-materialization load; coordinates,
            // terrain, physics and clocks remain the captured real geometry.
            host.world.getBlock = (x, y, z) => { const block = reader(x, y, z); if (block.known) for (let index = 0; index < 12; index++) native.blockAt({ x, y, z }); return block }
          }`)
source = source.replace('guardCalls.push(call)', 'call.at = performance.now(); call.cursorAgeMs = histories[0].snapshot().cursor ? Date.now() - histories[0].snapshot().cursor.queuedAt : null; guardCalls.push(call)')
source = source.replace('shared.vitals = copy(jumpCapture.vitals)', "shared.vitals = copy(jumpCapture.vitals); for (const entry of Object.values(shared.vitals)) entry.observedAt = new Date(epoch - 2000).toISOString()")
source = source.replace('return { advance, inputs,', 'return { phases, inputSamples, inputErrors, coldPhysics: () => coldPhysics, advance, inputs,')
const loaded = { exports: {} }
const harness = path.resolve(__dirname, 'runtime-idle-safety.test.js')
new vm.Script('(function(require,module,__filename,__dirname,jumpCapture){' + source + '\nmodule.exports={fixture};})', { filename: harness }).runInThisContext()(Module.createRequire(harness), loaded, harness, path.dirname(harness), capture)

test('actual captured jump landing keeps real neutral input alive through native ordinary planning', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Native handoff proof stays offline'))
  const f = loaded.exports.fixture(t, { mode: 'wall_native_load' })
  f.runtime.resumeRequested()
  await f.advance(450)
  let result, error
  try { result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] }) } catch (caught) { error = caught.message }
  const post = f.phases.filter(value => value.postJump)
  const detail = { error, result: result && { arrived: result.arrived, code: result.code, reason: result.reason, supported: result.supported }, inputErrors: f.inputErrors, input: f.inputSamples.slice(-8), phases: post.sort((a, b) => b.ms - a.ms).slice(0, 6), landing: f.phases.find(value => value.kind === 'landing_handoff'), calls: f.guardCalls }
  assert.equal(f.guardResults[0]?.arrived, true, JSON.stringify(detail))
  assert.equal(f.inputErrors.length, 0, JSON.stringify(detail))
  assert.ok(f.inputSamples.some(value => value.postJump), JSON.stringify(detail))
  assert.equal(f.coldPhysics(), 1)
  assert.ok(f.guardCalls.length >= 2, JSON.stringify(detail))
  assert.ok(!f.guardResults.some(value => /handoff timer stalled/.test(value.reason ?? '')), JSON.stringify(detail))
  const landedAt = f.records[f.guardCalls[0].queuedFramesAtReturn - 1].queuedAt
  const queueTimes = [...f.inputSamples.map(value => value.at), ...f.records.map(value => value.queuedAt)].filter(value => value >= landedAt).sort((a, b) => a - b)
  const maxQueueGapMs = Math.max(0, ...queueTimes.slice(1).map((value, index) => value - queueTimes[index]))
  const maxPreviewSliceMs = Math.max(0, ...post.filter(value => value.kind === 'movement_preview').map(value => value.ms))
  const maxCursorAgeMs = Math.max(0, ...f.guardCalls.slice(1).map(value => value.cursorAgeMs))
  assert.ok(maxQueueGapMs < 200, JSON.stringify({ maxQueueGapMs, ...detail }))
  assert.ok(maxPreviewSliceMs < 200, JSON.stringify({ maxPreviewSliceMs, ...detail }))
  assert.ok(maxCursorAgeMs < 200, JSON.stringify({ maxCursorAgeMs, ...detail }))
  assert.deepEqual(f.raw.position, capture.rawServerPosition)
  assert.equal(f.raw.health, capture.health)
  t.diagnostic(JSON.stringify({ maxQueueGapMs, maxPreviewSliceMs, maxCursorAgeMs, coldPhysics: f.coldPhysics() }))
})
