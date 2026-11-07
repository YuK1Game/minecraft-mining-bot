'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

function fixtureFrom (name) {
  const file = path.join(__dirname, name), loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = fixture\n', file)
  return loaded.exports
}

const contextOf = line => JSON.parse(line.slice(line.indexOf(' context=') + ' context='.length))

test('a received hurt event after a bow release records the bound individual without claiming an attributed hit', async () => {
  const logs = [], fixture = fixtureFrom('ranged-combat.test.js')
  const f = fixture({ log: line => logs.push(line), onRelease: ({ ranged }) => ranged.applyPacket('entity_event', { runtime_entity_id: '70', event_id: 'hurt_animation' }) })
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  const released = logs.find(line => line.startsWith('矢を発射:'))
  const hurt = logs.find(line => line.startsWith('射撃後の標的ダメージ:'))
  assert.ok(released); assert.ok(hurt)
  const context = contextOf(hurt)
  assert.equal(context.runtimeId, String(f.target.runtimeId))
  assert.equal(context.uniqueId, String(f.target.uniqueId))
  assert.equal(context.scope.connectionId, f.state.connectionId)
  assert.equal(context.scope.dimension, f.state.dimension)
  assert.equal(context.life, f.state.lifecycle.deathId)
  assert.equal(context.damageSource, 'unknown')
  assert.equal(context.hitConfirmed, false)
  assert.equal(logs.some(line => line.startsWith('矢が命中:')), false)
  assert.equal(result.shotsConfirmed, 1)
  assert.ok(result.attempts.every(attempt => attempt.hitConfirmed === false))
})

test('melee request diagnostics identify the bound target and life without marking the request as confirmed damage', async () => {
  const logs = [], fixture = fixtureFrom('melee-combat.test.js')
  const f = fixture({ log: line => logs.push(line) })
  const result = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  const line = logs.find(value => value.startsWith('剣で攻撃:'))
  assert.ok(line)
  const context = contextOf(line)
  assert.equal(context.runtimeId, String(f.target.runtimeId))
  assert.equal(context.uniqueId, String(f.target.uniqueId))
  assert.equal(context.scope.connectionId, f.state.connectionId)
  assert.equal(context.life, f.state.lifecycle.deathId)
  assert.equal(result.hitsRequested, 1)
  assert.equal(result.botCausedDamage, null)
  assert.equal(result.attribution, 'unconfirmed')
})

test('a reused runtime ID cannot attach a different individual hurt event to the released arrow target', async () => {
  const logs = [], fixture = fixtureFrom('ranged-combat.test.js')
  const f = fixture({ log: line => logs.push(line), onRelease: ({ target, ranged }) => {
    target.uniqueId = '-701'
    ranged.applyPacket('entity_event', { runtime_entity_id: '70', event_id: 'hurt_animation' })
  } })
  await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.ok(logs.some(line => line.startsWith('矢を発射:')))
  assert.equal(logs.some(line => line.startsWith('射撃後の標的ダメージ:')), false)
})
