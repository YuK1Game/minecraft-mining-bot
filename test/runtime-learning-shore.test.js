'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const capture = require('./fixtures/learning-shore-partial-origin.json')
const { createNavigator } = require('../src/navigation'), { evaluateThreats } = require('../src/threats')
const file = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let setup = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
setup = setup.replace("fs.readFileSync(runtimeFile, 'utf8')", "fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? runtimeFile, 'utf8')")
setup = setup.replaceAll('shoreRecenter: options.shoreRecenter ?? false', 'shoreRecenter: options.shoreRecenter ?? false, stablePartialOrigin: options.stablePartialOrigin ?? false')
setup = setup.replace('predicted: { physicsState: copy(frame.predictedState) }', 'predicted: { position: navigator.physics.toServerPosition(frame.predictedState), physicsState: copy(frame.predictedState) }')
const targetModule = { exports: {} }
const initialize = new vm.Script('(function(require,module,__filename,__dirname){' + setup + ';module.exports={prepare,context};})', { filename: file }).runInThisContext()
initialize(Module.createRequire(file), targetModule, file, path.dirname(file))
const { prepare, context } = targetModule.exports
function scene (t, { learning = true } = {}) {
  const f = prepare(t, { realPhysics: true, preserveTerrainEvidence: true })
  f.shared.autoWanted = learning; f.raw.health = capture.health; f.raw.position = structuredClone(capture.rawServerPosition); f.raw.positionSource = 'correct_player_move_prediction'; f.raw.positionUpdatedAt = 1
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:arrow', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.shared.physicsWorking = { position: structuredClone(capture.position), positionSource: 'client_prediction', positionUpdatedAt: 1, positionServerConfirmed: false, predicted: structuredClone(capture.predicted) }
  f.actors.splice(0, f.actors.length, ...capture.enemies.map(e => ({ ...structuredClone(e), kind: 'mob', alive: true, hostile: true, positionKnown: true, dimension: 'overworld' })))
  const blocks = new Map(capture.blocks.map(([x, y, z, name, properties, extra]) => [`${x},${y},${z}`, { known: true, position: { x, y, z }, name: `minecraft:${name}`, properties, extra }]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  return { ...f, blocks }
}
test('captured HP9 two-skeleton partial shore restores a full dry Native landing before main origin rejection', async t => {
  const f = scene(t), raw = structuredClone(f.raw.position), before = f.host.getState(), episode = context(f)
  const navigator = createNavigator({ world: f.host.world, allowWater: true }), initial = navigator.physics.fromServer(before)
  assert.equal(initial.onGround, true); assert.equal(initial.isInWater, false); assert.equal(navigator.verifyOrigin(initial), false); assert.equal(navigator.verifyOrigin(initial, { stablePartialOrigin: true }), false)
  const floors = evaluateThreats(f.safeties[0].options.getState(), f.actors).threats.map(a => ({ id: a.runtimeId, distance: a.distance }))
  const result = await f.safeties[0].options.escape(episode)
  assert.equal(result.supported, true, JSON.stringify(result)); assert.equal(result.arrived, true); assert.equal(result.partialEscape, true); assert.equal(result.escaped, false); assert.equal(result.serverConfirmed, false)
  assert.equal(f.movements[0].starts.length, 1); const options = f.movements[0].starts[0].options
  assert.equal(options.partialRecenter, true); assert.equal(options.shoreRecenter, true); assert.equal(options.allowWater, true); assert.equal(options.partialDrop, false)
  assert.ok(floors.every(a => options.avoidance.find(c => c.id === a.id)?.minDistance >= a.distance))
  assert.ok(f.movements[0].frames.every(frame => frame.predictedState.onGround && !frame.predictedState.isInWater && !frame.predictedState.isInLava))
  const after = f.host.getState(); assert.equal(navigator.verifyOrigin(navigator.physics.fromServer(after)), true); assert.deepEqual(f.raw.position, raw); assert.deepEqual(f.packets, [])
})
test('the new shore path remains disabled for balanced and wet or airborne body states', async t => {
  for (const mode of ['balanced', 'wet', 'airborne']) await t.test(mode, async t => {
    const f = scene(t, { learning: mode !== 'balanced' })
    if (mode === 'wet') f.shared.physicsWorking.predicted.physicsState.isInWater = true
    if (mode === 'airborne') f.shared.physicsWorking.predicted.physicsState.onGround = false
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false); assert.equal(f.movements[0].starts.length, 0)
  })
})
test('life, damage, UID and unknown landing terrain changes before dispatch cannot start a shore move', async t => {
  for (const mode of ['life', 'damage', 'uid', 'unknown']) await t.test(mode, async t => {
    const f = scene(t); let changed = false; const previous = f.host.world.getBlock
    if (mode === 'unknown') f.host.world.getBlock = (x, y, z) => x >= -9 && x <= -7 && (z === 28 || z === 29) && y === 61 && !(x === -9 && z === 29) ? { known: false } : previous(x, y, z)
    else setImmediate(() => { changed = true; if (mode === 'life') f.shared.deathRespawn = { deathId: 1 }; if (mode === 'damage') f.raw.health--; if (mode === 'uid') f.actors[0].uniqueId = '-9999' })
    try { await f.safeties[0].options.partialEscape(context(f)) } catch {}
    assert.equal(f.movements[0].starts.length, 0, mode); if (mode !== 'unknown') assert.equal(changed, true)
  })
})
