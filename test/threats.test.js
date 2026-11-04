'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { threatRadius, evaluateThreats } = require('../src/threats')

test('the explicit mining policy uses a smaller ranged margin only while health is high and restores the reserve when hurt', () => {
  const state = { position: { x: 0, y: 66, z: 0 }, health: 20, threatPolicy: 'balanced_mining' }
  const actors = [{ runtimeId: '9', entityType: 'minecraft:skeleton', position: { x: 20, y: 66, z: 0 }, alive: true }]
  assert.equal(evaluateThreats(state, actors).threats.length, 0)
  assert.equal(evaluateThreats({ ...state, health: 13 }, actors).threats.length, 0)
  assert.equal(evaluateThreats({ ...state, health: 11 }, actors).threats.length, 1)
  assert.equal(evaluateThreats({ ...state, threatPolicy: undefined }, actors).threats.length, 1)
  assert.equal(evaluateThreats(state, [{ ...actors[0], position: { x: 17, y: 66, z: 0 } }]).threats.length, 1)
})

test('healthy coastal work uses drowned shooting range without assuming it is unarmed', () => {
  const state = { position: { x: 0, y: 66, z: 0 }, health: 20, threatPolicy: 'balanced_mining' }
  const actor = { runtimeId: '11', entityType: 'minecraft:drowned', position: { x: 15.36, y: 66, z: 0 }, alive: true }
  assert.equal(evaluateThreats(state, [actor]).threats.length, 0)
  assert.equal(evaluateThreats({ ...state, health: 13 }, [actor]).threats.length, 1)
  assert.equal(evaluateThreats(state, [{ ...actor, position: { x: 13, y: 66, z: 0 } }]).threats.length, 1)
})

const state = () => ({ runtimeEntityId: '1', dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20 })
const mob = (type, x, extra = {}) => ({ runtimeId: '20', kind: 'mob', entityType: `minecraft:${type}`, dimension: 'overworld', alive: true, positionKnown: true, position: { x, y: 70, z: 0 }, ...extra })

test('verified overworld policies distinguish skeleton ranged danger from creeper and melee avoidance', () => {
  assert.equal(threatRadius('minecraft:skeleton'), 24)
  assert.equal(threatRadius(mob('stray', 0)), 24)
  assert.equal(threatRadius(mob('bogged', 0)), 24)
  assert.equal(threatRadius(mob('creeper', 0)), 8)
  assert.equal(threatRadius(mob('zombie', 0)), 12)
  assert.equal(threatRadius(mob('wither_skeleton', 0)), 12)
  assert.equal(threatRadius(mob('witch', 0)), 20)
  assert.equal(threatRadius(mob('pillager', 0)), 24)
  assert.equal(threatRadius(mob('drowned', 0)), 24)
  const evaluated = evaluateThreats(state(), [mob('skeleton', 20)])
  assert.equal(evaluated.threats.length, 1)
  assert.equal(evaluated.threats[0].dangerRadius, 24)
  assert.match(evaluated.threats[0].policyBasis, /15/)
  assert.match(evaluated.threats[0].evidenceUrl, /Mojang\/bedrock-samples/)
  assert.equal(evaluated.recommendation, 'avoid')
})

test('distance and danger are recomputed from state positions instead of trusting stale entity fields', () => {
  const result = evaluateThreats(state(), [
    mob('skeleton', 20, { runtimeId: '2', distance: 1000, dangerRadius: 1, score: -1 }),
    mob('skeleton', 30, { runtimeId: '3', distance: 1, dangerRadius: 99, score: 999 }),
    mob('zombie', 11, { runtimeId: '4', distance: 1000 })
  ])
  assert.equal(result.threats.length, 2)
  assert.equal(result.threats.find(entity => entity.runtimeId === '2').distance, 20)
  assert.equal(result.outsideDanger[0].distance, 30)
  assert.equal(result.outsideDanger[0].dangerous, false)
  assert.ok(result.threats.every(entity => Number.isFinite(entity.score) && entity.score > 0))
  assert.ok(result.threats[0].score >= result.threats[1].score)
})

test('players, NPCs, items and custom or unknown types are not asserted hostile even with a claimed hostile flag', () => {
  const actors = [
    mob('skeleton', 1, { runtimeId: '2', kind: 'player', username: 'Zombie', hostile: true }),
    mob('npc', 1, { runtimeId: '3', hostile: true }),
    mob('skeleton', 1, { runtimeId: '4', isNpc: true }),
    mob('skeleton', 1, { runtimeId: '5', kind: 'item' }),
    mob('cow', 1, { runtimeId: '6' }),
    mob('zombie', 1, { runtimeId: '7', entityType: 'custom:zombie', hostile: true }),
    { runtimeId: '8', position: { x: 1, y: 70, z: 0 }, hostile: true }
  ]
  const result = evaluateThreats(state(), actors)
  assert.equal(result.threats.length, 0)
  assert.equal(result.unclassified.length, 7)
  assert.ok(result.unclassified.every(entity => entity.dangerous === null && entity.dangerRadius === null))
  assert.equal(threatRadius(actors[0]), null)
  assert.equal(threatRadius(actors[5]), null)
  assert.equal(result.recommendation, 'continue_observing')
  assert.match(result.reason, /保証する判断ではありません/)
})

test('unknown hostile or player positions never become zero-distance or false-safe observations', () => {
  const unknown = evaluateThreats(state(), [mob('skeleton', 1, { position: null, positionKnown: false })])
  assert.equal(unknown.threats.length, 0)
  assert.equal(unknown.unknownPositions.length, 1)
  assert.equal(unknown.unknownPositions[0].distance, null)
  assert.equal(unknown.unknownPositions[0].dangerous, null)
  assert.equal(unknown.requiresObservation, true)
  assert.equal(unknown.recommendation, 'observe')
  const player = evaluateThreats(state(), [mob('player', 1, { kind: 'player', position: null })])
  assert.equal(player.threats.length, 0)
  assert.equal(player.requiresObservation, true)
  const selfUnknown = evaluateThreats({ ...state(), position: { x: NaN, y: 70, z: 0 } }, [mob('zombie', 1)])
  assert.equal(selfUnknown.playerPositionKnown, false)
  assert.equal(selfUnknown.requiresObservation, true)
  const noList = evaluateThreats(state(), undefined)
  assert.equal(noList.entityListKnown, false)
  assert.equal(noList.requiresObservation, true)
})

test('creeper fuse and explicitly observed charge expand policy while a configured margin does not invent fuse evidence', () => {
  assert.equal(threatRadius(mob('creeper', 1, { lastEvent: { event: 'creeper_prime_fuse' } })), 12)
  assert.equal(threatRadius(mob('creeper', 1, { charged: true })), 16)
  const primed = evaluateThreats(state(), [mob('creeper', 10, { primed: true })])
  assert.equal(primed.threats.length, 1)
  assert.match(primed.threats[0].policyBasis, /起爆準備/)
  const margin = evaluateThreats(state(), [mob('creeper', 10)], { extraMargin: 4 })
  assert.equal(margin.threats[0].dangerRadius, 12)
  assert.ok(margin.threats[0].score < primed.threats[0].score)
})

test('self identity, dead actors and another dimension are excluded without relying on runtime proximity', () => {
  const result = evaluateThreats(state(), [
    mob('zombie', 0, { runtimeId: '1' }),
    mob('creeper', 1, { runtimeId: '2', alive: false }),
    mob('skeleton', 1, { runtimeId: '3', health: 0 }),
    mob('zombie', 1, { runtimeId: '4', dimension: 1 })
  ])
  assert.equal(result.threats.length, 0)
  assert.deepEqual(result.ignored.map(entity => entity.reason), ['self', 'dead', 'dead', 'different_dimension'])
})

test('long-range nether types retain their real sample-based policy and expose inadequate observation coverage', () => {
  assert.equal(threatRadius('minecraft:blaze'), 56)
  assert.equal(threatRadius('minecraft:ghast'), 72)
  const result = evaluateThreats(state(), [mob('blaze', 50), mob('ghast', 70, { runtimeId: '21' })], { observationRadius: 32 })
  assert.equal(result.threats.length, 2)
  assert.equal(result.coverageWarnings.length, 2)
  assert.equal(result.coverageWarnings[0].observationRadius, 32)
  assert.ok(result.coverageWarnings.every(warning => warning.dangerRadius > warning.observationRadius))
})

test('evaluation is deterministic and bounded, does not mutate input, and never aliases output positions', () => {
  const s = state()
  const actors = [mob('skeleton', 10), mob('zombie', 2, { runtimeId: '21' })]
  const before = structuredClone({ s, actors })
  const evaluated = evaluateThreats(s, actors)
  assert.deepEqual(evaluated, evaluateThreats(s, actors))
  assert.deepEqual({ s, actors }, before)
  evaluated.threats[0].position.x = 999
  assert.deepEqual({ s, actors }, before)
  const bounded = evaluateThreats(s, actors, { maxEntities: 1 })
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.requiresObservation, true)
  assert.throws(() => evaluateThreats(s, actors, { extraMargin: -1 }))
  assert.throws(() => evaluateThreats(s, actors, { observationRadius: Infinity }))
})
