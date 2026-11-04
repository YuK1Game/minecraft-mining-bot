'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const observed = require('./fixtures/land-overshot-partial-origin.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const harnessFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let harness = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const oldOptions = 'shoreRecenter: options.shoreRecenter ?? false })'
assert.equal(harness.split(oldOptions).length, 3)
harness = harness.split(oldOptions).join('shoreRecenter: options.shoreRecenter ?? false, stablePartialOrigin: options.stablePartialOrigin ?? false })')
harness = harness.replace("            if (frame.phase !== 'moving') { clearInterval(actor.timer); actor.timer = null }", "            actor.frameHook?.(frame)\n            if (actor.phase !== 'moving') { clearInterval(actor.timer); actor.timer = null }")
harness = harness.replace('positionUpdatedAt: ++stamp', 'positionUpdatedAt: (stamp = Math.max(stamp, raw.positionUpdatedAt ?? 0) + 1)')
harness = harness.split('settle: () => ({})').join('settle: () => { actor.settles = (actor.settles ?? 0) + 1; return {} }')
const harnessModule = { exports: {} }
const initialize = new vm.Script(Module.wrap(harness + '\nmodule.exports = { prepare, context }'), { filename: harnessFile }).runInThisContext()
initialize(harnessModule.exports, Module.createRequire(harnessFile), harnessModule, harnessFile, path.dirname(harnessFile))
const { prepare, context } = harnessModule.exports

function captured (t, { initial = false, realGuard = true } = {}) {
  const f = prepare(t, { realGuard, realPhysics: true })
  f.raw.position = initial ? eye(observed.initialPhysicsState.position) : copy(observed.position)
  f.raw.positionSource = 'client_prediction'
  f.raw.predicted = initial ? { position: copy(f.raw.position), physicsState: copy(observed.initialPhysicsState) } : copy(observed.predicted)
  f.raw.positionUpdatedAt = 1
  f.raw.rawServerPosition = initial ? copy(f.raw.position) : copy(observed.rawServerPosition)
  f.raw.rawServerPositionUpdatedAt = 1
  const map = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  f.host.world.getBlock = (x, y, z) => copy(map.get(`${x},${y},${z}`) ?? { known: false })
  const oldActors = new Map(observed.route.avoidance.map(actor => [actor.id, actor.position]))
  f.actors.splice(0, f.actors.length, ...observed.enemies.map(actor => ({ ...copy(actor), ...(initial && oldActors.has(actor.runtimeId) ? { position: copy(oldActors.get(actor.runtimeId)) } : {}), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })))
  return { ...f, map }
}
function applyCorrection (f, { stamp = 100, stationary = false } = {}) {
  if (!stationary) {
    f.raw.position = copy(observed.rawServerPosition)
    f.raw.predicted = { position: copy(f.raw.position), physicsState: { ...copy(observed.predicted.physicsState), position: { ...copy(observed.rawServerPosition), y: observed.rawServerPosition.y - 1.62 } } }
    f.actors.splice(0, f.actors.length, ...observed.enemies.map(actor => ({ ...copy(actor), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })))
  }
  f.raw.positionUpdatedAt = stamp
  f.raw.rawServerPosition = copy(f.raw.position)
  f.raw.rawServerPositionUpdatedAt = stamp
  f.shared.physicsWorking = { position: copy(f.raw.position), positionSource: 'client_prediction', positionUpdatedAt: stamp, predicted: copy(f.raw.predicted) }
}

test('captured corner prioritizes the proven current-cell centre and reaches strict complete support', async t => {
  const f = captured(t)
  const start = copy(f.raw.position)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape, true)
  assert.deepEqual(f.movements[0].starts[0].target, { x: Math.floor(start.x) + 0.5, y: 68, z: Math.floor(start.z) + 0.5 })
  const current = f.safeties[0].options.getState()
  assert.equal(f.guards[0].options.verifyStanding(current, { ...current.position, y: current.position.y - 1.62 }), true)
  assert.equal(f.movements[0].settles ?? 0, 0)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.packets, [])
})

test('actual corrected overshoot drains the old leg and resamples a new current-cell target in the same episode', async t => {
  const f = captured(t, { initial: true })
  const calls = []; const results = []
  const guard = f.guards[0].native
  const original = guard.escape
  guard.escape = async (nodes, bounds) => { calls.push({ nodes: copy(nodes), bounds: { ...bounds } }); const result = await original(nodes, bounds); results.push(copy(result)); return result }
  let corrected = false
  f.movements[0].frameHook = () => {
    if (corrected || f.movements[0].frames.length < 6) return
    corrected = true
    applyCorrection(f)
    f.movements[0].phase = 'replan_required'
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, calls: calls.map(call => ({ nodes: call.nodes, maxMovementStarts: call.bounds.maxMovementStarts })), results }))
  assert.equal(result.partialEscape, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].nodes[0], observed.target)
  assert.equal(results[0].code, 'ESCAPE_PROGRESS_REPLAN')
  assert.equal(results[0].arrived, false)
  assert.equal(results[0].escaped, false)
  assert.equal(results[0].returned, false)
  assert.equal(results[0].visitedPrefix.length, 1)
  assert.deepEqual(calls[1].nodes[0], { x: -16.5, y: 68, z: 25.5 })
  assert.equal(calls[1].bounds.maxMovementStarts, 5 - results[0].movementStarts)
  assert.ok(calls[1].bounds.timeoutMs < calls[0].bounds.timeoutMs)
  assert.equal(result.movementStarts, results.reduce((sum, value) => sum + value.movementStarts, 0))
  const state = f.safeties[0].options.getState()
  assert.equal(f.guards[0].options.verifyStanding(state, { ...state.position, y: state.position.y - 1.62 }), true)
  assert.equal(f.movements[0].settles ?? 0, 0)
  assert.equal(f.raw.health, 20)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.packets, [])
})

test('progress replanning shares the remaining movement-start and four-second budgets', async t => {
  let time = 10000
  t.mock.method(Date, 'now', () => time)
  const f = captured(t, { initial: true, realGuard: false })
  f.guards[0].work = async nodes => {
    if (f.guards[0].calls.length === 1) {
      applyCorrection(f)
      time += 1250
      return { ok: false, code: 'ESCAPE_PROGRESS_REPLAN', arrived: false, escaped: false, movementStarts: 3, progressReplan: { position: copy(f.raw.position), authoritativePosition: copy(f.raw.position), horizontalProgress: 1.14, targetOvershoot: 0.3, authoritativeStamp: 100 } }
    }
    f.raw.position = eye(nodes[0]); f.raw.positionUpdatedAt++
    f.raw.predicted = { position: copy(f.raw.position), physicsState: { ...copy(observed.predicted.physicsState), position: copy(nodes[0]), velocity: { x: 0, y: -0.0784, z: 0 } } }
    f.shared.physicsWorking = { position: copy(f.raw.position), positionSource: 'client_prediction', positionUpdatedAt: f.raw.positionUpdatedAt, predicted: copy(f.raw.predicted) }
    return { ok: true, arrived: true, escaped: true, riskRemains: true, movementStarts: 2 }
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.partialEscape, true, JSON.stringify(result))
  assert.equal(result.movementStarts, 5)
  assert.equal(f.guards[0].calls.length, 2)
  assert.equal(f.guards[0].calls[0].bounds.maxMovementStarts, 5)
  assert.equal(f.guards[0].calls[1].bounds.maxMovementStarts, 2)
  assert.ok(f.guards[0].calls[1].bounds.timeoutMs <= 2750)
})

test('stationary, stale, exhausted, damaged, changed-actor, unknown or invalid progress cannot restart planning', async t => {
  for (const mode of ['stationary', 'stale', 'exhausted', 'damage', 'actor', 'unknown', 'falling']) {
    const f = captured(t, { initial: true, realGuard: false })
    f.guards[0].work = async () => {
      applyCorrection(f, { stamp: mode === 'stale' ? 1 : 100, stationary: mode === 'stationary' })
      if (mode === 'damage') f.raw.health = 19
      if (mode === 'actor') f.actors[0].uniqueId = 'replacement'
      if (mode === 'unknown') f.map.set('-17,67,24', { known: false })
      if (mode === 'falling') f.shared.physicsWorking.predicted.physicsState.onGround = false
      return { ok: false, code: 'ESCAPE_PROGRESS_REPLAN', arrived: false, escaped: false, movementStarts: mode === 'exhausted' ? 5 : 1, progressReplan: { position: copy(f.raw.position), authoritativePosition: copy(f.raw.position), horizontalProgress: mode === 'stationary' ? 0 : 1.14, targetOvershoot: 0.3, authoritativeStamp: mode === 'stale' ? 1 : 100 } }
    }
    let result
    try { result = await f.safeties[0].options.escape(context(f)) } catch (error) { assert.ok(['damage', 'actor'].includes(mode), `${mode}: ${error.message}`) }
    assert.equal(f.guards[0].calls.length, 1, mode)
    assert.notEqual(result?.arrived, true, mode)
    assert.notEqual(result?.partialEscape, true, mode)
    assert.deepEqual(f.packets, [])
  }
})
