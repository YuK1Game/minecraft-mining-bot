'use strict'

// Run the production Runtime's water candidate filter/preview/Guard against a
// controlled observed world. The score seam substitutes only cached landmark
// ranking; it cannot supply terrain or authorize a route.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createShoreLandmarks } = require('../src/shore-landmarks')
const { createCombatExposure } = require('../src/combat-exposure')
const fixtureFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const seam = 'const runtimeSource = originalRuntime'
const marker = '  function shoreScore (state, from, target) {'
const injected = marker + '\n    if (host.shared.shoreScoreProbe) return host.shared.shoreScoreProbe(state, from, target)'
assert.equal(fixtureSource.split(seam).length, 2)
fixtureSource = fixtureSource.replace(seam, `const runtimeSource = originalRuntime.replace(${JSON.stringify(marker)}, ${JSON.stringify(injected)})`)
const target = { exports: {} }
const load = new vm.Script('(function(require,module,__filename,__dirname){' + fixtureSource + ';module.exports={prepare,context};})', { filename: fixtureFile }).runInThisContext()
load(Module.createRequire(fixtureFile), target, fixtureFile, path.dirname(fixtureFile))
const { prepare, context } = target.exports

function waterWorld (mode = 'known') {
  return { getBlock: (x, y, z) => {
    if (mode === 'unknown_north' && z < 0) return { known: false }
    if (mode === 'blocked_north' && z < 0 && y >= 62 && y <= 65) return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
    const name = y < 58 ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air'
    return { known: true, name, position: { x, y, z }, properties: name === 'minecraft:water' ? { liquid_depth: 0 } : {}, boundingBox: name === 'minecraft:stone' ? 'block' : 'empty', extra: [] }
  } }
}
function setup (t, { memory = true, mode = 'known', outsideEnemy = false } = {}) {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.position = { x: 0.5, y: 64.1, z: 0.5 }; f.raw.positionSource = 'client_prediction'
  const feet = { x: 0.5, y: 62.48, z: 0.5 }
  f.raw.predicted = { position: { ...f.raw.position }, feetPosition: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, physicsState: { position: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, gameMode: 'survival', onGround: false, isInWater: true, isInLava: false, controls: {} } }
  f.raw.health = 20; f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  // The received pursuers are at the surface, with a current visible attack
  // path. A submerged, unrecognised actor must not request this retreat.
  f.actors.splice(0, f.actors.length, { ...f.enemy(), runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', primed: false, charged: false, position: { x: -6.5, y: 63, z: 0.5 } })
  if (outsideEnemy) f.actors.push({ ...f.enemy(), runtimeId: '10', uniqueId: '10', entityType: 'minecraft:creeper', primed: false, charged: false, position: { x: 0.5, y: 63, z: -9.5 } })
  f.host.world.getBlock = waterWorld(mode).getBlock
  const exposure = createCombatExposure({ world: f.host.world, entities: f.host.entities, scopeOf: () => 'shore-ranking-fixture' })
  for (const actor of f.actors) {
    const observed = exposure.evaluate(actor, f.host.getState())
    assert.equal(observed.evidence.sight, true)
    assert.equal(observed.intercept, true, JSON.stringify(observed))
  }
  if (memory) {
    const landmarks = createShoreLandmarks({ workspaceRoot: path.resolve(__dirname, '..'), clock: () => 1000 })
    landmarks.rememberSurvey({ profile: 'bot', realmId: '42', dimension: 'overworld' }, { observationOnly: true, origin: { x: 0.5, y: 64.1, z: 0.5 }, radius: 8, knownCandidateCount: 1, candidates: [{ x: 0.5, y: 63, z: -7.5, distance: 8, floor: 'minecraft:stone' }] })
    f.shared.shoreScoreProbe = (state, from, to) => landmarks.directionScore({ profile: state.profile, realmId: state.realm.id, dimension: state.dimension }, from, to)
  }
  return f
}

test('remembered north shore changes a safe water retreat from the default east heading', async t => {
  const ordinary = setup(t, { memory: false })
  const baseline = await ordinary.safeties[0].options.escape(context(ordinary))
  assert.equal(baseline.supported, true, JSON.stringify(baseline))
  const east = ordinary.movements[0].starts.find(start => start.options.allowWater)
  assert.ok(east.target.x > ordinary.raw.position.x)
  const remembered = setup(t)
  const result = await remembered.safeties[0].options.escape(context(remembered))
  assert.equal(result.supported, true, JSON.stringify(result))
  const north = remembered.movements[0].starts.find(start => start.options.allowWater)
  assert.ok(north.target.z < -1, JSON.stringify(north.target))
  assert.ok(north.target.z < east.target.z)
})

for (const mode of ['unknown_north', 'blocked_north']) test(`shore memory cannot authorize ${mode}`, async t => {
  const f = setup(t, { mode })
  const result = await f.safeties[0].options.escape(context(f))
  if (result.supported) {
    assert.ok(f.movements[0].starts.length > 0)
    for (const start of f.movements[0].starts) assert.ok(start.target.z >= 0.3, JSON.stringify(start.target))
    for (const frame of f.movements[0].frames) assert.ok(frame.predictedState.position.z >= 0.3 - 1e-4)
  } else assert.equal(f.movements[0].starts.length, 0)
})

test('shore ranking still preserves the full avoidance corridor of an outside hostile', async t => {
  const f = setup(t, { outsideEnemy: true })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  const outside = f.actors.find(actor => actor.runtimeId === '10')
  for (const frame of f.movements[0].frames) {
    const position = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
    assert.ok(Math.hypot(position.x - outside.position.x, position.y - outside.position.y, position.z - outside.position.z) >= 8 - 1e-4)
  }
  const start = f.movements[0].starts[0]
  assert.ok(Math.hypot(start.target.x - outside.position.x, start.target.y + 1.62 - outside.position.y, start.target.z - outside.position.z) >= 8)
})
