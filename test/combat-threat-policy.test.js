'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateCombatThreat, recognitionRadius } = require('../src/combat-threat-policy')

const state = () => ({ phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: 0, y: 65.62, z: 0 } })
const mob = (entityType = 'minecraft:creeper', x = 10, extra = {}) => ({ entityType, kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 64, z: 0 }, ...extra })
const check = (target, extra = {}) => evaluateCombatThreat({ target, state: state(), routeToBot: true, sight: true, ...extra })
const closing = (extra = {}) => ({ velocity: { x: -0.05, y: 0, z: 0 }, ageMs: 50, samples: 4, stationary: false, ...extra })

test('policy distances reuse existing interception/avoidance thresholds without claiming server AI range', () => {
  for (const [name, radius] of [['creeper',16],['zombie',12],['skeleton',18],['stray',18],['bogged',18],['pillager',16],['witch',18],['phantom',32]]) assert.equal(recognitionRadius(`minecraft:${name}`), radius)
  assert.equal(recognitionRadius('minecraft:unknown_enemy'), null)
})

test('the real remote behind-ground creeper case does not intercept despite a walk route', () => {
  const r = check(mob('minecraft:creeper', 21.2), { sight: false, motion: closing() })
  assert.equal(r.intercept, false)
  assert.equal(r.reason, 'OUTSIDE_RECOGNITION_RADIUS')
  assert.equal(r.safety, 'not_assessed')
  assert.equal(r.evidence.closing, true)
})

test('a near visible aggressive ground mob requires the enemy-to-bot walking route', () => {
  assert.equal(check(mob()).intercept, true)
  for (const routeToBot of [false, null, undefined]) {
    const r = check(mob(), { routeToBot })
    assert.equal(r.intercept, false)
    assert.equal(r.unknown, routeToBot !== false)
  }
  assert.equal(check(mob('minecraft:zombie', 12)).intercept, true)
  assert.equal(check(mob('minecraft:zombie', 12.001)).intercept, false)
})

test('without sight or other recognition evidence the bot keeps work, including close actors behind a wall', () => {
  const r = check(mob('minecraft:zombie', 3), { sight: false })
  assert.equal(r.intercept, false)
  assert.equal(r.reason, 'NO_CURRENT_RECOGNITION')
  assert.equal(check(mob(), { sight: null }).unknown, true)
})

test('actual recent closing or priming can establish recognition, while blocked/unknown attack routes still deny', () => {
  const r = check(mob(), { sight: false, motion: closing() })
  assert.equal(r.intercept, true)
  assert.equal(r.awareness, 'observed_closing')
  assert.equal(check(mob('minecraft:creeper', 5, { primed: true }), { sight: false }).intercept, true)
  for (const routeToBot of [false, null]) assert.equal(check(mob('minecraft:creeper', 5, { primed: true }), { routeToBot, sight: false, provoked: true }).intercept, false)
})

test('stale, stationary, too-fast, unmeasured and nonclosing movement never manufactures awareness', () => {
  for (const motion of [null, {closing:true}, closing({ageMs:301}), closing({samples:1}), closing({stationary:true}), closing({discarded:'teleport'}), closing({velocity:{x:-2,y:0,z:0}}), closing({velocity:{x:0.05,y:0,z:0}}), closing({velocity:{x:0,y:0,z:0.1}})]) assert.equal(check(mob(), { sight:false, motion }).intercept, false)
})

test('projectile enemies use their sight rather than a bot walking route, within the archer policy distance', () => {
  const shooter = mob('minecraft:skeleton', 17.9)
  const r = check(shooter, { routeToBot: false })
  assert.equal(r.intercept, true)
  assert.equal(r.accessKind, 'projectile_sight')
  assert.equal(check(mob('minecraft:skeleton', 18.01)).intercept, false)
  for (const sight of [false, null]) assert.equal(check(shooter, { sight, provoked:true, motion:closing() }).intercept, false)
})

test('flight interception explicitly uses a sight proxy and never requires a fictitious ground route', () => {
  const flyer = mob('minecraft:phantom', 20)
  const r = check(flyer, { routeToBot: false })
  assert.equal(r.intercept, true)
  assert.equal(r.accessKind, 'flight_sight_proxy')
  assert.equal(check(flyer, { sight: false, motion:closing() }).intercept, false)
})

test('actual individual attack evidence may override distance but never profile or access protection', () => {
  assert.equal(check(mob('minecraft:skeleton', 25), { provoked: true }).intercept, true)
  assert.equal(check(mob('minecraft:zombie', 20), { provoked: true, routeToBot: false }).intercept, false)
  assert.equal(check(mob('minecraft:warden', 2), { provoked: true }).intercept, false)
  assert.equal(check(mob('minecraft:wolf', 2, { hostile: false }), { provoked: true }).intercept, true)
  assert.equal(check(mob('minecraft:wolf', 2)).intercept, false)
})

test('players, dead/unknown actors, missing positions and other dimensions cannot trigger interception', () => {
  for (const target of [mob('minecraft:unknown_enemy'), mob('minecraft:zombie',2,{kind:'player'}), mob('minecraft:zombie',2,{alive:false}), mob('minecraft:zombie',2,{positionKnown:false}), mob('minecraft:zombie',2,{dimension:'nether'}), mob('minecraft:zombie',2,{hostile:null})]) assert.equal(check(target).intercept, false)
  assert.equal(evaluateCombatThreat({target:mob(),state:state()}).unknown, true)
})

test('all returned evidence is observational and inputs/work state remain unchanged', () => {
  const input = { target:mob(), state:{...state(),quarry:{state:'MINE',userRunIntent:'running'}}, routeToBot:true,sight:true,motion:closing() }, before=structuredClone(input)
  const result = evaluateCombatThreat(input)
  assert.equal(result.intercept, true)
  assert.equal(result.awareness,'observed_closing')
  assert.equal(Object.hasOwn(result,'targetingBot'),false)
  assert.deepEqual(input,before)
})
