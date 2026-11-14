'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createEntities } = require('../src/entities')
const { createCombatExposure } = require('../src/combat-exposure')
const reachability = require('../src/threat-reachability')

// Reuse the actual Runtime construction with passive service actors, without
// registering the unrelated tests. Only configure the received world/tracker
// and observe the real combat-exposure result before Runtime consumes it.
function loadScene () {
  const filename = require.resolve('./runtime-idle-safety.test.js')
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const signature = 'function fixture (t, { realSafety = false, wanted = false } = {})'
  const boundary = '  const target = { exports: {} };'
  assert.equal(source.split(signature).length, 2)
  assert.equal(source.split(boundary).length, 2)
  source = source.replace(signature, 'function fixture (t, { realSafety = false, wanted = false, configure } = {})')
    .replace(boundary, '  configure({ host, raw, shared, overrides })\n' + boundary)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source + '\nmodule.exports = fixture\n', filename)
  return loaded.exports
}
const scene = loadScene()

function receivedWallScene (t, { type = 'minecraft:zombie', closing = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  reachability.clear()
  t.after(() => reachability.clear())
  let time = 1000
  const entities = createEntities({ now: () => time })
  entities.applyPacket('start_game', { runtime_entity_id: 41n, entity_id: 441n, dimension: 0 })
  entities.applyPacket('add_entity', { runtime_id: 70n, unique_id: -700n, entity_type: type, position: { x: closing ? 6.5 : 6.25, y: 65, z: 0.5 } })
  time += 50
  entities.applyPacket('move_entity', { runtime_entity_id: 70n, position: { x: 6.25, y: 65, z: 0.5 } })
  const evaluations = []
  const f = scene(t, { configure: ({ host, shared, overrides }) => {
    host.entities = entities
    shared.loadingScreenEnded = true
    host.world.revision = () => 1
    host.world.getBlock = (x, y, z) => {
      // A known two-cell-wide tunnel: direct sight hits the wall at x=3,
      // while the enemy can walk around it through the adjacent z=1 lane.
      const clear = x >= 0 && x <= 6 && (z === 0 || z === 1) && (y === 65 || y === 66) && !(x === 3 && z === 0)
      return { known: true, position: { x, y, z }, name: clear ? 'minecraft:air' : 'minecraft:stone', boundingBox: clear ? 'empty' : 'block', properties: {}, extra: [] }
    }
    overrides['./combat-exposure'] = { createCombatExposure: options => {
      const actual = createCombatExposure(options)
      return { ...actual, evaluate: (actor, state) => {
        const value = actual.evaluate(actor, state)
        evaluations.push(value)
        return value
      } }
    } }
  } })
  const actor = entities.get('70')
  const feet = { ...f.raw.position, y: f.raw.position.y - 1.62 }
  assert.equal(reachability.seekCells(f.host.world, actor.position, feet), true, 'the received ground gives an actual enemy-to-bot walk route')
  const motion = entities.motion('70')
  assert.equal(motion.samples, 2)
  assert.equal(motion.ageMs, 0)
  assert.equal(motion.discarded, undefined)
  const state = f.safeties[0].options.getState()
  assert.equal(evaluations.length, 1, 'the real Runtime evaluates this received actor')
  const exposure = evaluations[0]
  assert.equal(exposure.evidence.sight, false)
  assert.equal(exposure.evidence.closing, closing)
  assert.equal(exposure.unknown, false)
  assert.deepEqual(entities.get('70'), actor, 'the safety view does not rewrite the raw entity catalogue')
  assert.equal(f.packets.length, 0, 'observing the view sends no game action')
  return { state, exposure }
}

test('Runtime safety view retains a closing ground hostile with a known route behind a wall', t => {
  const { state, exposure } = receivedWallScene(t)
  assert.equal(exposure.evidence.routeToBot, true)
  assert.equal(exposure.intercept, true)
  assert.equal(exposure.awareness, 'observed_closing')
  assert.equal(exposure.reason, 'CURRENT_THREAT_WITH_ATTACK_ACCESS')
  assert.equal(state.entities.some(actor => actor.runtimeId === '70'), true, 'a known walking route and received closing motion remain a threat despite blocked sight')
})

test('Runtime safety view omits the same ground hostile when the wall has no closing evidence', t => {
  const { state, exposure } = receivedWallScene(t, { closing: false })
  assert.equal(exposure.evidence.routeToBot, true)
  assert.equal(exposure.intercept, false)
  assert.equal(exposure.reason, 'NO_CURRENT_RECOGNITION')
  assert.equal(state.entities.some(actor => actor.runtimeId === '70'), false)
})

test('Runtime safety view omits a closing ranged hostile whose received firing line is blocked', t => {
  const { state, exposure } = receivedWallScene(t, { type: 'minecraft:skeleton' })
  assert.equal(exposure.accessKind, 'projectile_sight')
  assert.equal(exposure.intercept, false)
  assert.equal(exposure.reason, 'PROJECTILE_SIGHT_BLOCKED')
  assert.equal(state.entities.some(actor => actor.runtimeId === '70'), false)
})
