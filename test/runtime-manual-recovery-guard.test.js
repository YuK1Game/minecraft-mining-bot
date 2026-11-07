'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const actualManual = require('../src/manual-shulker-recovery')
const filename = require.resolve('./runtime-user-behaviors.test'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = scene\n', filename)
const scene = loaded.exports

test('the actual runtime permits observing safety and independent defense, while ownership and emergency guards remain mandatory', async t => {
  let captured
  const safety = { running: true, phase: 'observing', busy: false, cleanupUnconfirmed: false }
  const document = actualManual.createRecoveryDocument({ id: 'guard_test', world: { profile: 'bot', realmId: '21225335', dimension: 'overworld' }, position: { x: 2, y: 65, z: 0 }, expectedContents: { known: true, slotCount: 27, slots: Array(27).fill(null) } })
  const f = scene(t, { runtimeOverrides: {
    'node:fs/promises': { stat: async () => ({ size: 1024 }), readFile: async () => JSON.stringify(document) },
    './manual-shulker-recovery': { ...actualManual, createManualShulkerRecovery: ports => {
      captured = ports
      return { snapshot: () => ({ busy: false }), cancel: () => {}, run: async () => ({ status: 'blocked', reason: 'fixture-read-only' }) }
    } },
    './idle-safety': { createIdleSafety: () => ({ snapshot: () => structuredClone(safety), start: () => {}, stop: async () => {}, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) }) }
  } })
  f.host.world.revision = () => 5
  await f.runtime.operations.shulkerRecovery.load('guard_test')
  await f.runtime.operations.shulkerRecovery.run()
  assert.equal(typeof captured.canAct, 'function')
  assert.equal(typeof captured.getGroundAccessProof, 'function')
  f.shared.combatDefenseWanted = true; f.shared.safetyWanted = true
  assert.equal(captured.canAct(), true)
  assert.equal(f.shared.combatDefenseWanted, true)
  assert.equal(f.shared.safetyWanted, true)
  for (const status of ['scheduled', 'in_flight']) {
    f.shared.safetyEmergency = { status }; assert.equal(captured.canAct(), false)
  }
  delete f.shared.safetyEmergency
  safety.busy = true; assert.equal(captured.canAct(), false); safety.busy = false
  safety.active = 'escape'; assert.equal(captured.canAct(), false); safety.active = null
  safety.cleanupUnconfirmed = true; assert.equal(captured.canAct(), false); safety.cleanupUnconfirmed = false
  f.facadeState.busy = true; assert.equal(captured.canAct(), false); f.facadeState.busy = false
  f.shared.autoWanted = true; assert.equal(captured.canAct(), false); f.shared.autoWanted = false
  f.shared.userBehaviorsEnabled = true; assert.equal(captured.canAct(), false); f.shared.userBehaviorsEnabled = false
  f.host.entities.stats = () => ({ unknownPositions: 1 }); assert.equal(captured.canAct(), false)
  f.host.entities.stats = () => ({ unknownPositions: 0 })
  assert.equal(captured.canAct(), true)
  assert.equal(f.counters.autonomyStarts, 0)
  assert.equal(f.shared.combatDefenseWanted, true)
})
