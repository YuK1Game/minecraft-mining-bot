'use strict'

// Isolated integration of the saved Runtime selection, native Nav/physics,
// and native Guard. Fixture movement advances the real physics without IO.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const capture = require('./fixtures/post-grass-runtime-recenter.json')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const combatExposure = require('../src/combat-exposure')
const file = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let setup = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
// The old shared harness omitted this production movement option. Forward it
// here so both Runtime's preview and Guard's preview use the real partial start.
assert.equal(setup.split('shoreRecenter: options.shoreRecenter ?? false').length, 3)
setup = setup.replaceAll('shoreRecenter: options.shoreRecenter ?? false', 'shoreRecenter: options.shoreRecenter ?? false, stablePartialOrigin: options.stablePartialOrigin ?? false')
setup = setup.replace('predicted: { physicsState: copy(frame.predictedState) }', 'predicted: { position: navigator.physics.toServerPosition(frame.predictedState), physicsState: copy(frame.predictedState) }')
setup = setup.replace('const preview = (target, options = {}) => {', `const preview = (target, options = {}) => {
          if (actor.previewHook) { const route = actor.previewHook(target, options); actor.previews.push({ target: copy(target), options, route: copy(route) }); return route }
`)
const targetModule = { exports: {} }
const initialize = new vm.Script('(function(require,module,__filename,__dirname){' + setup + ';module.exports={prepare,context};})', { filename: file }).runInThisContext()
initialize(Module.createRequire(file), targetModule, file, path.dirname(file))
const { prepare, context } = targetModule.exports
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const eye = p => ({ ...p, y: p.y + 1.62 })
function segmentDistance (p, a, b) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const length = d.x ** 2 + d.y ** 2 + d.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y + (p.z - a.z) * d.z) / length)) : 0
  return distance(p, { x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t })
}

function capturedRuntime (t, { beforeHandoff = null, attackAccess = 'unknown' } = {}) {
  // These recenter cases deliberately leave attack access unconfirmed while
  // exercising native Runtime/Nav/physics/Guard selection and collision checks.
  // Captured cells, positions, policy radii and assertions remain unchanged;
  // the real-exposure case below separately verifies the capture's known cover.
  if (attackAccess === 'unknown') {
    const createExposure = combatExposure.createCombatExposure
    t.mock.method(combatExposure, 'createCombatExposure', options => ({
      ...createExposure(options),
      evaluate: () => ({ unknown: true, intercept: false, reason: 'ATTACK_ACCESS_UNKNOWN', evidence: { sight: null, routeToBot: null } })
    }))
  } else assert.equal(attackAccess, 'current')
  const f = prepare(t, { realGuard: true, realPhysics: true, preserveTerrainEvidence: true })
  f.raw.health = capture.health
  f.raw.position = structuredClone(capture.rawServerPosition)
  f.raw.positionSource = 'start_game'
  f.raw.positionUpdatedAt = 1
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 2 }]
  f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.shared.physicsWorking = { position: structuredClone(capture.position), positionSource: 'client_prediction', positionUpdatedAt: 1, positionServerConfirmed: false, predicted: structuredClone(capture.predicted) }
  f.actors.splice(0, f.actors.length, ...capture.enemies.map(actor => ({ ...structuredClone(actor), alive: true, hostile: true, positionKnown: true, kind: 'mob' })))
  const blocks = new Map(capture.blocks.map(([x, y, z, name, properties, extra]) => [`${x},${y},${z}`, { known: true, position: { x, y, z }, name: `minecraft:${name}`, properties, extra }]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside received capture' })
  const handoffs = []
  const escape = f.guards[0].native.escape
  f.guards[0].native.escape = async (nodes, bounds) => {
    handoffs.push({ nodes: structuredClone(nodes), bounds, previewsBeforeHandoff: f.movements[0].previews.length })
    beforeHandoff?.({ ...f, blocks }, nodes)
    return escape(nodes, bounds)
  }
  return { ...f, blocks, handoffs }
}

test('current attack exposure keeps the captured occluded archer out of the recenter handoff', async t => {
  // Unlike the isolated recenter cases, use the actual received-terrain
  // exposure implementation here: known cover must not initiate a retreat.
  const f = capturedRuntime(t, { attackAccess: 'current' })
  const state = f.safeties[0].options.getState()
  const archer = f.actors.find(actor => actor.runtimeId === '20')
  const exposure = combatExposure.createCombatExposure({ world: f.host.world, entities: f.host.entities, scopeOf: () => 'captured-current-exposure' }).evaluate(archer, state)
  assert.equal(exposure.unknown, false)
  assert.equal(exposure.evidence.sight, false)
  assert.equal(exposure.reason, 'PROJECTILE_SIGHT_BLOCKED')
  assert.equal(evaluateThreats(state, state.entities, { observationRadius: 32 }).threats.length, 0)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, false)
  assert.deepEqual(f.handoffs, [])
  assert.deepEqual(f.movements[0].starts, [])
  assert.deepEqual(f.packets, [])
})

test('captured Runtime promotes a bounded adjacent-cell recenter and hands it to the native Guard', async t => {
  const f = capturedRuntime(t)
  const before = structuredClone(f.shared.physicsWorking.position)
  const episode = context(f)
  const primary = f.actors.find(actor => actor.runtimeId === episode.threats[0].runtimeId)
  const policy = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const floors = [...policy.threats, ...policy.outsideDanger].map(actor => ({ position: actor.position, minimum: actor.dangerous ? actor.distance : actor.dangerRadius }))
  const navigator = createNavigator({ world: f.host.world })
  const initial = navigator.physics.fromServer(f.host.getState())
  assert.equal(navigator.verifyOrigin(initial), false)
  assert.equal(navigator.verifyOrigin(initial, { stablePartialOrigin: true }), true)
  const result = await f.safeties[0].options.escape(episode)
  assert.equal(result.partialEscape, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, ready: p.route?.ready, reason: p.route?.reason })), handoffs: f.handoffs.map(h => h.nodes) }))
  assert.equal(result.arrived, true)
  assert.equal(result.escaped, false)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.handoffs.length, 1)
  assert.equal(f.handoffs[0].previewsBeforeHandoff, 1, 'Runtime rehearses the first bounded landing once before Guard independently checks it')
  assert.equal(f.movements[0].starts.length, 1)
  const landing = f.handoffs[0].nodes[0]
  assert.ok(distance(initial.position, landing) <= 1.2)
  assert.equal(Math.abs(Math.floor(landing.x) - Math.floor(initial.position.x)) + Math.abs(Math.floor(landing.z) - Math.floor(initial.position.z)), 1)
  assert.equal(landing.y, initial.position.y)
  assert.equal(f.movements[0].starts[0].options.stablePartialOrigin, true)
  assert.ok(f.movements[0].starts[0].options.avoidance.some(actor => actor.id === primary.runtimeId))
  assert.equal(f.movements[0].starts[0].options.avoidance.length, capture.enemies.length)
  let previous = before
  for (const frame of f.movements[0].frames) {
    const p = eye(frame.predictedState.position)
    assert.equal(frame.predictedState.onGround, true)
    assert.equal(frame.predictedState.isInWater, false)
    assert.equal(frame.predictedState.isInLava, false)
    assert.ok(floors.every(actor => segmentDistance(actor.position, previous, p) >= actor.minimum - 1e-4))
    previous = p
  }
  const after = f.safeties[0].options.getState()
  assert.equal(navigator.verifyOrigin(navigator.physics.fromServer(after)), true)
  assert.ok(distance(primary.position, after.position) >= distance(primary.position, before) + 0.25, JSON.stringify({ before, after: after.position, physicsWorking: f.shared.physicsWorking, result, lastFrame: f.movements[0].frames.at(-1) }))
  assert.equal(f.raw.health, capture.health)
  assert.deepEqual(f.packets, [])
  assert.equal(f.guards[0].native.snapshot().movementStarts, 1)
})

test('Runtime attempts at most two bounded recenter choices when every movement preview is unavailable', async t => {
  const f = capturedRuntime(t)
  f.movements[0].previewHook = () => ({ ready: false, reason: 'unavailable preview' })
  const origin = capture.predicted.physicsState.position
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.reason, 'no_known_away_route')
  assert.deepEqual(f.handoffs, [])
  assert.deepEqual(f.movements[0].starts, [])
  const shortLevel = f.movements[0].previews.filter(p => p.target.y === origin.y && distance(p.target, origin) <= 1.2)
  assert.equal(shortLevel.length, 2)
  assert.deepEqual(shortLevel[0].target, { x: -10.5, y: 67, z: 28.5 })
  assert.equal(new Set(shortLevel.map(p => JSON.stringify(p.target))).size, 2)
  assert.ok(f.movements[0].previews.every(p => p.options.stablePartialOrigin === true))
  assert.deepEqual(f.packets, [])
})

test('native Guard rejects support that becomes unknown after Runtime rehearses the real recenter', async t => {
  const f = capturedRuntime(t, { beforeHandoff: ({ blocks }) => {
    blocks.set('-11,66,28', { known: false, reason: 'support no longer received' })
  } })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(f.handoffs.length, 1)
  assert.equal(f.handoffs[0].previewsBeforeHandoff, 1)
  assert.equal(result.partialEscape, false)
  assert.equal(result.arrived, false)
  assert.equal(result.code, 'SUPPORT_UNKNOWN')
  assert.deepEqual(f.movements[0].starts, [])
  assert.deepEqual(f.packets, [])
  assert.equal(f.raw.health, capture.health)
})

test('unknown or hazardous partial-origin space never reaches the recenter handoff', async t => {
  const f = capturedRuntime(t)
  for (const replacement of [
    { known: false, reason: 'origin edge not received' },
    { known: true, position: { x: -11, y: 66, z: 29 }, name: 'minecraft:cobweb', properties: {}, extra: [] }
  ]) {
    f.blocks.set('-11,66,29', replacement)
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.reason, 'no_known_escape_origin')
    assert.deepEqual(f.handoffs, [])
    assert.deepEqual(f.movements[0].starts, [])
    assert.deepEqual(f.packets, [])
  }
})
