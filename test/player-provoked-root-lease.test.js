'use strict'
// The fight with the neutral mob that hit the Bot, joined from the candidate scan to the root's lease.
//
// Real Realm 2026-11-21 03:48:39-03:48:51 JST, beside the house (9859, 66, 10109): an enderman 0.6 m away hit the Bot
// from 8.33 to 4.55 to 1.77 to 0. The coordinator chose it 75 times in 11 s (「戦闘開始: target=enderman mode=melee」)
// and every claim ended 3 ms later with 「戦闘終了: target=enderman code=ACQUIRE_DENIED … calls=0/0 reason=Root did
// not grant the protective combat lease」. The sword was never swung.
//
// Here: the real root (user-control-runtime.js acquireUserControl / resumeUserControl), the real behaviours
// (user-behaviors.js: provocation, acquireCombat), the real coordinator and the real attack-access evaluation.
// In place of the game: flat ground, one actor, and sword and bow controllers that record what they are asked.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createUserControlRuntime } = require('../src/runtime/user-control-runtime')
const { createUserBehaviors } = require('../src/combat/user-behaviors')
const { createCombatExposure } = require('../src/combat/combat-exposure')
const { evaluateThreats } = require('../src/combat/threats')
const { createNavigator } = require('../src/movement/navigation')

function scene (t, { type = 'enderman', hostile = false, distance = 0.6, wall = false } = {}) {
  let time = Date.now()
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '1' }, connectionId: 'a', startedAt: 'b', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', health: 8.33,
    position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', lifecycle: { deathId: 0, phase: 'alive' }, inventory: { known: true, items: [] } }
  const actor = { kind: 'mob', entityType: `minecraft:${type}`, hostile, alive: true, positionKnown: true, positionSource: 'move_entity', dimension: 'overworld', runtimeId: '71', uniqueId: '-71', position: { x: 0.5 + distance, y: 65, z: 0.5 } }
  const block = (x, y, z, solid) => ({ known: true, position: { x, y, z }, name: solid ? 'minecraft:stone' : 'minecraft:air', boundingBox: solid ? 'block' : 'empty', extra: [] })
  const world = { getBlock: (x, y, z) => block(x, y, z, y < 65 || wall && x === 1), revision: () => 1 }
  const entities = { snapshot: () => [structuredClone(actor)], snapshotRemoved: () => [], motion: () => null }
  const f = { engaged: [], logs: [], shared: { autoWanted: true, userBehaviorsEnabled: true, loadingScreenEnded: true, deathRespawn: { deathId: 0 }, recentDamageNoPrimary: null } }
  const current = () => ({ ...structuredClone(state), entities: entities.snapshot() })
  const idle = () => ({ busy: false, pendingRequestId: null, phase: 'idle', running: false, actionActive: false })
  const inert = () => ({ snapshot: idle, cancel () {}, stop () {}, drain: async () => {} })
  const controller = name => ({ preview: () => ({ ready: true }), survey: () => ({ ready: true }), cancel () {}, drain: async () => {}, snapshot: () => ({}),
    engage: async id => { f.engaged.push([name, id]); return { phase: 'completed', code: 'TARGET_DEAD', targetRuntimeId: id, targetUniqueId: actor.uniqueId, targetDead: true, serverConfirmed: true } } })
  const exposure = createCombatExposure({ world, entities, scopeOf: () => 'scope' })
  const navigator = createNavigator({ world })
  const rt = {
    require: createRequire(require.resolve('../src/runtime.js')),
    host: { shared: f.shared, client: { queue () {} }, world, entities, meta: { version: '1.26.60', startGame: { entity_id: 1n } }, log: line => f.logs.push(String(line)), commitSelection () {} },
    requireGeneration () {}, currentGeneration: () => true, lightweightUserState: current, lightweightRawState: current, working: current, raw: current, rawScope: current,
    userScope: value => `${value.connectionId}:${value.dimension}:${value.runtimeEntityId}`, actualLifeId: () => 0, evaluateThreats, resourceMinHealth: () => 0,
    userBehaviorTimer: 1, userBehaviorLease: null, userBehaviorSleeping: false, userBehaviorWakePending: false, replaying: false, pendingStops: new Set(), generationStream: {},
    userBehaviorSnapshot: () => ({ sleeping: false }), createSightStanceSearch: () => () => null,
    // The real behaviours; only the two weapon controllers are stand-ins.
    createUserBehaviors: options => { f.acquireControl = options.acquireControl; return createUserBehaviors({ ...options, controllers: { melee: controller('melee'), ranged: controller('ranged') }, now: () => time, wallNow: () => time, sleep: async ms => { time += ms; await turn() } }) },
    combatExposure: exposure, combatAttackExposure: (target, s) => exposure.evaluate(target, s), threatReachability: { ENGAGE_RADIUS: 32 },
    quarryCanSelectTarget: () => ({ allowed: true }), quarryCanContinue: () => ({ allowed: true }),
    resetHeld: () => false, defenseEnabled: () => true, chunkMoveHeld: () => false,
    generationSafety: { snapshot: () => ({ running: false, busy: false }), stop () {}, drain: async () => {} },
    idleSafetyRuntime: { owners: {}, generationGuardRoute: inert() },
    generationPhysics: navigator.physics, createNavigator, generationMovement: { ...inert(), snapshot: () => ({ running: false }) }, generationInput: {},
    generationCombat: inert(), generationShelter: inert(), generationHut: inert(),
    mining: inert(), food: inert(), armor: {}, interactions: inert(), prospecting: inert(), chest: inert(), furnace: inert(), autonomy: inert(),
    inventory: { ...inert(), equipForCombat: async slot => ({ slot, serverConfirmed: true }) },
    craftStatus: idle, chestStatus: idle, crafting: { cancel () {}, closeContainer () {}, snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [], pendingRequestId: null }) }, craftInventory: () => ({ inventory: [] }),
    cancelChunkMovement () {}, stopOrdinaryUserStream () {}, startIdle () {}, onUncertain () {},
    delay: async ms => { time += ms; await turn() },
    userBehaviorError: error => { throw error }
  }
  createUserControlRuntime(rt)
  assert.ok(rt.userBehaviors, 'the behaviours were built by the real root')
  t.after(() => rt.userBehaviors.cancel('test_cleanup'))
  f.rt = rt
  f.actor = actor
  f.hit = to => { state.health = to; f.shared.recentDamageNoPrimary = { at: time }; time += 100 }
  f.tick = async () => { rt.userBehaviors.tick(); for (let i = 0; i < 20; i++) await turn() }
  f.denied = () => f.shared.lastUserAcquireDenial?.reason ?? null
  f.ended = code => f.logs.filter(line => line.includes(`code=${code}`)).length
  return f
}

test('live 2026-11-21 03:48 JST: the root grants the lease for the enderman that hit the Bot, and the sword is asked to swing', async t => {
  const f = scene(t)
  await f.tick()
  assert.deepEqual(f.engaged, [], 'a neutral mob is not fought for standing near')
  f.hit(4.55)
  await f.tick()
  assert.equal(f.denied(), null, 'the root did not refuse the claim')
  assert.equal(f.ended('ACQUIRE_DENIED'), 0)
  assert.deepEqual(f.engaged, [['melee', f.actor.runtimeId]])
  assert.equal(f.rt.userBehaviorLease, null, 'the lease was handed back after the fight')
})

test('the root still refuses a neutral mob nobody was hit by, and a target that is no longer there', async t => {
  const f = scene(t), context = kind => ({ kind: 'combat', claimId: `combat:${kind}`, signal: new AbortController().signal, target: structuredClone(f.actor) })
  // Asked directly: the coordinator would not have chosen it.
  assert.deepEqual(await f.acquireControl(context('calm')), { acquired: false, reason: 'target_moved_or_unknown' })
  f.hit(4.55)
  f.actor.alive = false
  assert.deepEqual(await f.acquireControl(context('dead')), { acquired: false, reason: 'target_moved_or_unknown' })
  assert.equal(f.rt.userBehaviorLease, null)
})

test('a hostile mob in reach takes the lease as before', async t => {
  const f = scene(t, { type: 'zombie', hostile: true, distance: 1.5 })
  f.hit(6)
  await f.tick()
  assert.equal(f.denied(), null)
  assert.deepEqual(f.engaged, [['melee', f.actor.runtimeId]])
})
