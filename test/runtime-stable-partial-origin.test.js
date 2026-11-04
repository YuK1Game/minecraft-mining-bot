'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const copy = value => structuredClone(value)

// Load only the existing offline fixture definitions, never the long suite.
const harnessFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let harnessSource = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const oldOptions = 'shoreRecenter: options.shoreRecenter ?? false })'
assert.equal(harnessSource.split(oldOptions).length, 3)
harnessSource = harnessSource.split(oldOptions).join('shoreRecenter: options.shoreRecenter ?? false, stablePartialOrigin: options.stablePartialOrigin ?? false })')
harnessSource = harnessSource.split('settle: () => ({})').join('settle: () => { actor.settles = (actor.settles ?? 0) + 1; return {} }')
const fixtureModule = { exports: {} }
const compiled = new vm.Script(Module.wrap(harnessSource + '\nmodule.exports = { prepare, context }'), { filename: harnessFile }).runInThisContext()
compiled(fixtureModule.exports, Module.createRequire(harnessFile), fixtureModule, harnessFile, path.dirname(harnessFile))
const { prepare, context } = fixtureModule.exports

function captured (t, options = {}) {
  const observed = require('./fixtures/land-stable-partial-origin.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, ...options })
  f.raw.position = copy(observed.position)
  f.raw.positionSource = 'client_prediction'
  f.raw.predicted = copy(observed.predicted)
  const map = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  f.host.world.getBlock = (x, y, z) => copy(map.get(`${x},${y},${z}`) ?? { known: false })
  f.actors.splice(0, f.actors.length, ...observed.enemies.map(actor => ({ ...copy(actor), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })))
  return { ...f, observed, map }
}

test('captured stable partial boot is a verified escape origin, while strict arrival verification still rejects it', t => {
  const f = captured(t)
  const state = f.safeties[0].options.getState()
  const feet = { ...state.position, y: state.position.y - 1.62 }
  const hooks = f.guards[0].options
  assert.equal(hooks.verifyStanding(state, feet), false)
  assert.equal(hooks.verifyOrigin(state, feet), false, 'partial support is opt-in')
  assert.equal(hooks.verifyOrigin(state, feet, { stablePartialOrigin: true }), true)
  assert.equal(f.safeties[0].options.verifyBody(state, { signal: new AbortController().signal }), true)
  assert.equal(hooks.verifyStanding(state, feet), false, 'origin authorization cannot certify arrival')
  assert.deepEqual(f.raw.position, f.observed.position)
  assert.deepEqual(f.packets, [])
})

test('ordinary owned escape moves from the captured partial origin without legacy drowned-distance or neutral-settle fallback', async t => {
  const f = captured(t)
  const initial = copy(f.raw.position)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify({ result, previews: f.movements[0].previews.slice(-2).map(preview => ({ target: preview.target, reason: preview.route?.reason, stablePartialOrigin: preview.options.stablePartialOrigin })) }))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape, true, JSON.stringify(result))
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.movements[0].starts.length > 0)
  assert.equal(f.movements[0].settles ?? 0, 0)
  assert.ok(f.movements[0].starts.every(start => start.options.stablePartialOrigin === true))
  assert.ok(f.movements[0].frames.some(frame => frame.predictedState.position.y === 68))
  assert.ok(f.movements[0].frames.at(-1).predictedState.onGround)
  assert.equal(f.raw.health, 20)
  assert.deepEqual(f.raw.position, initial)
  assert.deepEqual(f.packets, [])
})

test('runtime partial-origin proof rejects falling, unknown support, head collision and lava', t => {
  for (const mode of ['falling', 'unknown', 'head', 'lava']) {
    const f = captured(t)
    if (mode === 'falling') f.raw.predicted.physicsState.onGround = false
    if (mode === 'unknown') f.map.set('-17,68,24', { known: false })
    if (mode === 'head') f.map.set('-17,70,23', { known: true, position: { x: -17, y: 70, z: 23 }, name: 'minecraft:stone', properties: {}, extra: [] })
    if (mode === 'lava') f.map.set('-17,68,24', { known: true, position: { x: -17, y: 68, z: 24 }, name: 'minecraft:lava', properties: { liquid_depth: 0 }, extra: [] })
    const state = f.safeties[0].options.getState()
    assert.equal(f.safeties[0].options.verifyBody(state, {}), false, mode)
    assert.deepEqual(f.packets, [])
  }
})
