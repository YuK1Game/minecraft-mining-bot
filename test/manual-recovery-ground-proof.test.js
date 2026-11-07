'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const actual = require('../src/manual-shulker-recovery')
const { proveGroundAccess } = require('../src/ground-access-proof')

function scene ({ type = 'minecraft:zombie', unknown = false, approachAtHand = false, stale = false, fault = null } = {}) {
  let actor, state, proofReads = 0, revision = 4
  const filename = require.resolve('./authorized-shulker-recovery.test'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = name => name === '../src/manual-shulker-recovery' ? {
    ...actual, createManualShulkerRecovery: ports => {
      const originalState = ports.getState, originalBlock = ports.getBlock
      ports.getState = () => ({ ...originalState(), worldRevision: revision })
      const current = ports.getState(); state = current
      actor = { runtimeId: 'enemy', uniqueId: '-22', entityType: type, dimension: current.dimension, kind: 'mob', hostile: true, alive: true, positionKnown: true, position: { x: current.position.x, y: current.position.y - 1.62 - 14, z: current.position.z } }
      actor.runtimeId = '22'
      const enemyCell = { x: Math.floor(actor.position.x), y: Math.floor(actor.position.y), z: Math.floor(actor.position.z) }
      const block = (x, y, z) => x === enemyCell.x && y === enemyCell.y && z === enemyCell.z ? { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } : unknown && x === enemyCell.x + 1 && y === enemyCell.y && z === enemyCell.z ? { known: false } : originalBlock(x, y, z)
      ports.getEntities = () => [structuredClone(actor)]
      ports.getGroundAccessProof = (target, s) => {
        proofReads++
        const proof = proveGroundAccess({ target, state: s, getBlock: block, getWorldRevision: () => revision, now: () => Date.parse(s.startedAt), clock: () => 0 })
        if (stale && proof.scope) proof.scope.connectionId = 'previous'
        return proof
      }
      const hand = ports.prepareHand
      ports.prepareHand = async (...args) => { const r = await hand(...args); if (approachAtHand) actor.position.y = current.position.y - 1.62; return r }
      return actual.createManualShulkerRecovery(ports)
    }
  } : Module.prototype.require.call(loaded, name)
  loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = fixture\n', filename)
  const f = loaded.exports(fault)
  return { f, proofReads: () => proofReads, actor: () => actor, state: () => state }
}

test('the real recovery controller permits only a closed known lower zombie component and retains exact box proof', async () => {
  const { f, proofReads } = scene(), service = f.make()
  const result = await f.run(service, f.document)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.receipt.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.equal(f.events.filter(event => event === 'mine').length, 1)
  assert.ok(proofReads() > 1, 'the proof is revalidated throughout recovery')
})

test('unknown terrain, unsupported actor, and stale identity still reject recovery before any break', async () => {
  for (const settings of [{ unknown: true }, { type: 'minecraft:skeleton' }, { type: 'minecraft:drowned' }, { type: 'minecraft:phantom' }, { stale: true }]) {
    const { f } = scene(settings), result = await f.run(f.make(), f.document)
    assert.equal(result.status, 'blocked', JSON.stringify(settings))
    assert.equal(result.reason, 'MANUAL_RECOVERY_DANGER')
    assert.equal(f.events.includes('mine'), false)
  }
})

test('a lower zombie approaching during preparation revokes the exemption before breaking', async () => {
  const { f } = scene({ approachAtHand: true })
  const result = await f.run(f.make(), f.document)
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'MANUAL_RECOVERY_DANGER')
  assert.equal(f.events.includes('mine'), false)
  assert.notEqual(result.serverConfirmed, true)
})

test('allowing a ground exception never credits an unconfirmed or wrong-content recovery', async () => {
  for (const fault of ['wrong_pickup', 'no_pickup', 'lost_baseline_plus_two']) {
    const { f } = scene({ fault })
    const result = await f.run(f.make(), f.document)
    assert.equal(result.status, 'blocked')
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.receipt, undefined)
  }
})
