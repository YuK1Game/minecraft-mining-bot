'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { defenseEnabled, behaviorEnabled, createDefenseAnchor, defenseMovementAllowed, defenseTargetAllowed } = require('../src/combat-defense-policy')

const state = () => ({ phase: 'spawned', profile: 'bot', realm: { id: 'realm' }, connectionId: 'connection', startedAt: '2026-11-06T00:00:00.000Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20, gameMode: 'survival', position: { x: 0.5, y: 65.62, z: 0.5 } })
const target = (x, z = 0.5) => ({ entityType: 'minecraft:zombie', position: { x, y: 64, z } })

test('defense defaults on independently of work, and explicit false always wins', () => {
  assert.equal(defenseEnabled(), true)
  assert.equal(behaviorEnabled('combat', { autoWanted: false, userBehaviorsEnabled: false }), true)
  assert.equal(behaviorEnabled('combat', { combatDefenseWanted: false, autoWanted: true, userBehaviorsEnabled: true, quarryCombatArmed: true }), false)
  assert.equal(behaviorEnabled('combat', { combatDefenseWanted: true, autoWanted: false }), true)
})

test('defense alone cannot enable bed, another behavior, or mutate work intent', () => {
  const shared = { combatDefenseWanted: true, autoWanted: false, userBehaviorsEnabled: false, userRunIntent: 'paused', quarry: { state: 'PAUSED', reason: 'STORAGE_WINDOW_CHANGED' } }, before = structuredClone(shared)
  assert.equal(behaviorEnabled('bed', shared), false)
  assert.equal(behaviorEnabled('mining', shared), false)
  assert.equal(behaviorEnabled('bed', { ...shared, autoWanted: true, userBehaviorsEnabled: true }), true)
  assert.deepEqual(shared, before)
})

test('anchor is fixed at current feet in a fully known living scope and cannot be enlarged', () => {
  const s = state(), a = createDefenseAnchor(s)
  assert.deepEqual(a.feet, { x: 0.5, y: 64, z: 0.5 })
  assert.equal(a.radius, 8)
  s.position.x = 5
  assert.equal(a.feet.x, 0.5)
  assert.equal(defenseMovementAllowed({ anchor: { ...a, radius: 32 }, state: s, position: { x: 10, y: 64, z: 0.5 } }).allowed, false)
  for (const change of [{ dead: true }, { health: 0 }, { phase: 'connecting' }, { startedAt: 'unknown' }, { runtimeEntityId: null }, { lifecycle: { deathId: null } }]) assert.equal(createDefenseAnchor({ ...state(), ...change }), null)
})

test('every native waypoint is checked, including a forbidden detour between permitted endpoints', () => {
  const s = state(), a = createDefenseAnchor(s), goal = { x: 7.5, y: 64, z: 0.5 }
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: goal, waypoints: [{ position: { x: 3, y: 64, z: 0.5 } }] }).allowed, true)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: goal, waypoints: [{ position: { x: 3, y: 64, z: 9 } }] }).reason, 'BEYOND_ANCHOR_RADIUS')
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: { x: 8.5, y: 64, z: 0.5 } }).allowed, true)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: { x: 8.5001, y: 64, z: 0.5 } }).allowed, false)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: goal, waypoints: [{ x: 3, y: 66, z: 0.5 }] }).reason, 'OTHER_LAYER')
})

test('normal travel checks feet, head and partial-jump headroom; unknown or throwing permission rejects', () => {
  const s = state(), a = createDefenseAnchor(s), position = { x: 1.5, y: 64.4, z: 0.5 }, seen = []
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position, travel: p => { seen.push(p); return p.y < 66 } }).reason, 'OUTSIDE_TRAVEL_REGION')
  assert.deepEqual(seen.map(p => p.y), [64, 65, 66])
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position, travel: () => null }).allowed, false)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position, travel: () => { throw Error('unknown') } }).allowed, false)
})

test('emergency retreat exempts the anchor and layer, while retaining known scope, finite points and supplied permission', () => {
  const s = state(), a = createDefenseAnchor(s), position = { x: 30, y: 67, z: 10 }
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position, retreating: true }).allowed, true)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position, retreating: true, travel: () => false }).allowed, false)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: { x: NaN, y: 67, z: 10 }, retreating: true }).allowed, false)
  assert.equal(defenseMovementAllowed({ anchor: a, state: { ...s, health: 0 }, position, retreating: true }).allowed, false)
})

test('connection, session, self, dimension and life changes cannot reuse a paused anchor even for retreat', () => {
  const s = state(), a = createDefenseAnchor(s), position = { x: 1, y: 64, z: 1 }
  for (const change of [{ connectionId: 'next' }, { startedAt: '2026-11-06T00:00:01Z' }, { runtimeEntityId: '2' }, { dimension: 'nether' }, { lifecycle: { deathId: 1 } }, { profile: 'other' }, { realm: { id: 'other' } }]) {
    const changed = { ...s, ...change }
    assert.equal(defenseMovementAllowed({ anchor: a, state: changed, position, retreating: true }).reason, 'DEFENSE_SCOPE_CHANGED')
    assert.equal(defenseTargetAllowed({ anchor: a, state: changed, target: target(1) }).allowed, false)
  }
})

test('current ranged contact and immediate threats enter combat after displacement, without permitting a chase', () => {
  const s = state(), a = createDefenseAnchor(s); s.position.x = 10
  assert.equal(defenseTargetAllowed({ anchor: a, state: s, target: target(12) }).reason, 'IMMEDIATE_DANGER')
  assert.equal(defenseTargetAllowed({ anchor: a, state: s, target: target(17.9) }).allowed, true)
  assert.equal(defenseTargetAllowed({ anchor: a, state: s, target: target(20) }).allowed, true)
  assert.equal(defenseTargetAllowed({ anchor: a, state: s, target: target(20), provoked: true }).allowed, true)
  assert.equal(defenseTargetAllowed({ anchor: a, state: s, target: { ...target(20), entityType: 'minecraft:creeper', primed: true } }).allowed, true)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: { x: 11, y: 64, z: 0.5 } }).allowed, false)
})

test('invalid or missing routes fail closed and all policy checks leave caller state unchanged', () => {
  const s = state(), a = createDefenseAnchor(s), before = structuredClone({ s, a })
  for (const waypoints of [null, [null], [{ position: { x: Infinity, y: 64, z: 0 } }]]) assert.equal(defenseMovementAllowed({ anchor: a, state: s, position: { x: 1, y: 64, z: 1 }, waypoints }).allowed, false)
  assert.equal(defenseMovementAllowed({ anchor: a, state: s }).allowed, false)
  assert.deepEqual({ s, a }, before)
})
