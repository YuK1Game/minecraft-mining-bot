'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { threatEvaluationOf } = require('../src/survival/work-threats')

const base = entities => ({ phase: 'spawned', health: 20, position: { x: 0, y: 64, z: 0 }, entities })
const zombie = x => ({ runtimeId: 'z' + x, entityType: 'minecraft:zombie', alive: true, positionKnown: true, position: { x, y: 64, z: 0 } })
const creeper = x => ({ runtimeId: 'c' + x, entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x, y: 64, z: 0 } })

test('player play leaves a hostile beyond 8 m to combat; work only steers around it (live 2026-11-17 16:37-16:58 JST)', () => {
  const far = base([zombie(10)])
  assert.equal(threatEvaluationOf(far).threats.length, 1, 'outside play the policy radius still holds')
  const playing = threatEvaluationOf({ ...far, playerPlay: true })
  assert.equal(playing.threats.length, 0)
  assert.ok(playing.outsideDanger.some(actor => actor.distance === 10))
  assert.equal(threatEvaluationOf({ ...base([zombie(5)]), playerPlay: true }).threats.length, 1)
  assert.equal(threatEvaluationOf({ ...base([creeper(7)]), playerPlay: true }).threats.length, 1)
})

test('evaluateThreats caps a non-creeper avoidance radius at 8 m during player play (live 2026-11-17 17:06 JST: skeleton 11.5 m, archer radius 18 m)', () => {
  const { evaluateThreats } = require('../src/combat/threats')
  const skeleton = { runtimeId: 's1', entityType: 'minecraft:skeleton', alive: true, positionKnown: true, position: { x: 11.5, y: 64, z: 0 } }
  const state = { phase: 'spawned', health: 19.2, position: { x: 0, y: 64, z: 0 }, threatPolicy: 'online_learning' }
  assert.equal(evaluateThreats(state, [skeleton], { observationRadius: 32 }).threats.length, 1)
  const playing = evaluateThreats({ ...state, playerPlay: true }, [skeleton], { observationRadius: 32 })
  assert.equal(playing.threats.length, 0)
  assert.equal(playing.outsideDanger[0].dangerRadius, 8)
  const near = evaluateThreats({ ...state, playerPlay: true }, [{ ...skeleton, position: { x: 6, y: 64, z: 0 } }], { observationRadius: 32 })
  assert.equal(near.threats.length, 1)
  const creeper = { runtimeId: 'c1', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 10, y: 64, z: 0 } }
  assert.equal(evaluateThreats({ ...state, playerPlay: true }, [creeper], { observationRadius: 32 }).outsideDanger[0]?.dangerRadius ?? evaluateThreats({ ...state, playerPlay: true }, [creeper], { observationRadius: 32 }).threats[0].dangerRadius, evaluateThreats(state, [creeper], { observationRadius: 32 }).outsideDanger[0]?.dangerRadius ?? evaluateThreats(state, [creeper], { observationRadius: 32 }).threats[0].dangerRadius, 'creeper radius unchanged')
})

test('every runtime state that sets the threat policy also carries playerPlay (live 2026-11-17 17:44-17:52 JST)', () => {
  const { threatFields } = require('../src/safety/threat-policy')
  assert.deepEqual(threatFields({ autoWanted: true, playerWanted: true }), { threatPolicy: 'online_learning', playerPlay: true })
  assert.deepEqual(threatFields({}), { threatPolicy: 'balanced_mining', playerPlay: false })
  const fs = require('node:fs')
  const { runtimeSource } = require('./helpers/runtime-source')
  const sources = [runtimeSource(), fs.readFileSync(require.resolve('../src/runtime/idle-safety-runtime.js'), 'utf8')]
  for (const source of sources) assert.doesNotMatch(source, /threatPolicy: (?:rt\.)?host\.shared\.autoWanted/)
})
