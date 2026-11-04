'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const capture = require('./fixtures/near-creeper-route-choice.json')
const copy = value => structuredClone(value)
const file = path.resolve(__dirname, 'runtime-jump-handoff.test.js')
const parent = { exports: {} }
const prefix = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
new vm.Script(Module.wrap(prefix + '\nmodule.exports={source}'), { filename: file }).runInThisContext()(parent.exports, Module.createRequire(file), parent, file, path.dirname(file))
let source = parent.exports.source
source = source.replace('inventory: { known: true, items: [] }', 'inventory: copy(jumpCapture.inventory)')
const loaded = { exports: {} }
const harness = path.resolve(__dirname, 'runtime-idle-safety.test.js')
new vm.Script('(function(require,module,__filename,__dirname,jumpCapture){' + source + '\nmodule.exports={fixture};})', { filename: harness }).runInThisContext()(Module.createRequire(harness), loaded, harness, path.dirname(harness), capture)

test('urgent real-map pursuit selects stronger native jump before a tiny ordinary partial with continuous real input', { timeout: 8000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Route-choice regression remains offline'))
  const f = loaded.exports.fixture(t, { mode: 'wall_priority' })
  f.runtime.resumeRequested(); await f.advance(150)
  const prior = copy(f.host.getState().position), raw = copy(f.raw.position)
  const pursuer = f.actors.find(actor => actor.runtimeId === '11')
  const pursuit = setInterval(() => {
    const dx = prior.x - pursuer.position.x, dz = prior.z - pursuer.position.z, length = Math.hypot(dx, dz)
    if (length > 0.1) { pursuer.position.x += dx / length * 0.1; pursuer.position.z += dz / length * 0.1 }
  }, 50)
  t.after(() => clearInterval(pursuit))
  const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
  assert.equal(f.guardCalls[0].boundedJump.driveTicks, 9, JSON.stringify({ result, calls: f.guardCalls }))
  assert.equal(f.guardResults[0].arrived, true)
  assert.equal(f.guardResults[0].routeInterruption, null)
  assert.equal(f.guardResults[0].remainingRouteRejection, null)
  assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 1)
  assert.ok(f.guardCalls.length >= 2)
  assert.equal(f.guardCalls[1].boundedJump, null)
  assert.equal(f.guardCalls[1].maxMovementStarts, 4)
  assert.ok(f.guardCalls[1].timeoutMs < f.guardCalls[0].timeoutMs)
  assert.ok(result.movementStarts >= 2 && result.movementStarts <= 5)
  const diagnostic = f.runtime.snapshot().boundedJumpSearch
  assert.ok(diagnostic.chosen.expectedGain > 2)
  assert.ok(diagnostic.candidates <= 21, JSON.stringify(diagnostic))
  const packets = f.packets.filter(row => row.name === 'player_auth_input')
  for (let index = 1; index < packets.length; index++) assert.equal(packets[index].packet.tick, packets[index - 1].packet.tick + 1n)
  const times = [...f.inputSamples.map(value => value.at), ...f.records.map(value => value.queuedAt)].sort((a, b) => a - b)
  const maxQueueGapMs = Math.max(0, ...times.slice(1).map((value, index) => value - times[index]))
  assert.ok(maxQueueGapMs < 200, JSON.stringify({ maxQueueGapMs, diagnostic }))
  assert.equal(f.inputErrors.length, 0)
  assert.equal(f.coldPhysics(), 1)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.raw.position, raw)
  assert.equal(f.raw.health, capture.health)
  assert.deepEqual(f.raw.inventory, capture.inventory)
  t.diagnostic(JSON.stringify({ searchMs: diagnostic.elapsedMs, candidates: diagnostic.candidates, queuedJumpFrames: f.guardCalls[0].queuedFramesAtReturn, maxQueueGapMs, gain: diagnostic.chosen.expectedGain }))
})

test('ineligible jump hunger preserves the same real tiny ordinary fallback without granting jump permission', { timeout: 5000 }, async t => {
  const f = loaded.exports.fixture(t, { mode: 'stale_hunger' })
  f.runtime.resumeRequested(); await f.advance(150)
  const prior = f.host.getState().position
  const result = await f.safeties[0].options.escape({ operationId: 8, signal: new AbortController().signal, threats: [] })
  assert.equal(f.guardCalls[0].boundedJump, null, JSON.stringify(f.guardCalls))
  assert.ok(Math.hypot(f.guardCalls[0].nodes[0].x - prior.x, f.guardCalls[0].nodes[0].z - prior.z) < 1)
  assert.equal(result.arrived, true)
  assert.equal(result.partialEscape, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.runtime.snapshot().boundedJumpSearch.hungerReady, false)
})
