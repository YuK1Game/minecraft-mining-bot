'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createEntities } = require('../src/entities')
const numeric = require('protodef/src/datatypes/numeric')
// Reuse the existing real controller/input-receipt fixture, without registering
// that file's tests. This keeps protocol and aim/wire behavior in one fixture.
const filename = path.join(__dirname, 'melee-combat.test.js')
const original = fs.readFileSync(filename, 'utf8'), end = original.indexOf("test('near current trusted")
if (end < 0) throw new Error('Melee fixture boundary changed')
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname)
loaded._compile(original.slice(0, end) + '\nmodule.exports = { fixture }\n', filename)
const { fixture } = loaded.exports

function observedPlayer (position = { x: 1.3, y: 65, z: 5.5 }) {
  const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(-639950116340n)
  const decoded = numeric.li64[0](bytes, 0).value
  assert.equal(Array.isArray(decoded), true, 'the installed Bedrock li64 decoder returns its signed two-word array type')
  assert.equal(decoded.toString(), '-639950116340')
  const entities = createEntities()
  entities.applyPacket('start_game', { runtime_entity_id: 1n, entity_id: 101n, dimension: 0 })
  entities.applyPacket('add_player', { runtime_id: 11043n, unique_id: decoded, username: 'observed-player', position })
  return entities.snapshot({ kind: 'all' })[0]
}

test('a protocol-decoded non-target player off the aim ray permits a real ordinary NPC attack request', async () => {
  const f = fixture({ noWeapon: true })
  f.actors.push(observedPlayer())
  assert.equal(f.melee.preview('70').ready, true)
  const result = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  assert.equal(result.hitsRequested, 1)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.attacks.length, 1)
  assert.equal(String(f.attacks[0].params.transaction.transaction_data.entity_runtime_id), '70')
})

test('missing non-target unique ID still protects a player actually in the melee ray', () => {
  const f = fixture(); f.actors.push({ ...observedPlayer({ x: 1.3, y: 65, z: 0.5 }), uniqueId: null })
  assert.equal(f.melee.preview('70').code, 'FRIENDLY_IN_PATH')
  assert.equal(f.attacks.length, 0)
})

test('non-target runtime, position and world must remain known; player or unbound NPC targets are still forbidden', () => {
  for (const change of [{ runtimeId: null }, { positionKnown: false }, { position: null }, { dimension: null }]) {
    const f = fixture(); f.actors.push({ ...observedPlayer(), ...change })
    assert.equal(f.melee.preview('70').code, 'ACTOR_UNKNOWN')
    assert.equal(f.attacks.length, 0)
  }
  for (const change of [{ kind: 'player', entityType: 'minecraft:player' }, { uniqueId: null }]) {
    const f = fixture(); Object.assign(f.target, change)
    assert.equal(f.melee.preview('70').code, 'INVALID_TARGET')
    assert.equal(f.attacks.length, 0)
  }
})
