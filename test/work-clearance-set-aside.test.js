'use strict'

// A work-clearance record is kept for a pursuer the work has to get clear of.
// When the canonical evaluation or the safety view leaves that actor out
// itself, the record is released; it is not an actor whose identity changed.
// Live 2026-11-18 17:43-18:17 JST: a zombie standing 11.5 m away, in the
// safety view on one pass and out of it on the next, made every idle retreat
// end after 13 ms with 「Idle escape retained actor identity, policy or scope
// changed」, about ten times a second for 34 minutes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateThreats } = require('../src/combat/threats')
const { captureWorkActors, resolveWorkActors, workMargin } = require('../src/safety/work-clearance')
const { splitExposed, exposedView } = require('../src/safety/exposed-actors')
const { createIdleSafety } = require('../src/safety/idle-safety')

const ago = ms => new Date(Date.now() - ms).toISOString()
const actor = (name, x, id = '9') => ({ runtimeId: id, uniqueId: `u${id}`, kind: 'mob', entityType: `minecraft:${name}`, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 66.62, z: 0.5 }, updatedAt: ago(1000), positionUpdatedAt: ago(1000) })
const body = (entities, extra = {}) => ({ phase: 'spawned', profile: 'work', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, inventory: { known: true, items: [] }, predicted: { physicsState: { onGround: true } }, entities, ...extra })
const held = (state, list = 'outsideDanger') => { const evaluation = evaluateThreats(state, state.entities); return captureWorkActors(state, evaluation, evaluation[list], Date.now()) }

test('an actor nothing was received about for five minutes is released as stale, not invalid', () => {
  const zombie = actor('zombie', 14.5)
  const records = held(body([zombie]))
  assert.equal(records.length, 1)
  zombie.updatedAt = ago(6 * 60000)
  const state = body([zombie]); const current = evaluateThreats(state, state.entities)
  assert.equal(current.ignored.some(value => value.runtimeId === '9' && value.reason === 'stale'), true)
  const result = resolveWorkActors(state, current, records)
  assert.deepEqual(result.invalid, [])
  assert.deepEqual(result.released, [{ runtimeId: '9', reason: 'stale' }])
  assert.equal(result.actors.length, 0)
})

test('an actor inside its radius that has stood still for five minutes is released as standing still', () => {
  const zombie = actor('zombie', 6.5)
  const records = held(body([zombie]), 'threats')
  assert.equal(records.length, 1)
  zombie.positionUpdatedAt = ago(6 * 60000)
  const state = body([zombie]); const current = evaluateThreats(state, state.entities)
  assert.equal(current.unreachable.some(value => value.runtimeId === '9' && value.standingStill === true), true)
  const result = resolveWorkActors(state, current, records)
  assert.deepEqual(result.invalid, [])
  assert.deepEqual(result.released, [{ runtimeId: '9', reason: 'standing_still' }])
})

test('an actor the safety view left out is released; a different actor under its id, or plain absence, is still invalid', () => {
  const zombie = actor('zombie', 14.5)
  const records = held(body([zombie]))
  const without = extra => { const state = body([], extra); return resolveWorkActors(state, evaluateThreats(state, state.entities), records) }
  const same = without({ unexposedEntities: [zombie] })
  assert.deepEqual(same.invalid, [])
  assert.deepEqual(same.released, [{ runtimeId: '9', reason: 'no_attack_access' }])
  assert.deepEqual(without({ unexposedEntities: [{ ...zombie, uniqueId: 'other' }] }).invalid, ['9'])
  assert.deepEqual(without({ unexposedEntities: [{ ...zombie, entityType: 'minecraft:husk' }] }).invalid, ['9'])
  assert.deepEqual(without({}).invalid, ['9'])
})

test('the safety view keeps unknown access, drops known negatives, and remembers whom it dropped', () => {
  const [near, blocked, unsure, boss, cow] = [actor('zombie', 3, '1'), actor('zombie', 14.5, '2'), actor('zombie', 9, '3'), actor('warden', 9, '4'), { ...actor('cow', 4, '5'), hostile: false }]
  const answers = { 1: { unknown: false, reason: 'INTERCEPT', evidence: { sight: true } }, 2: { unknown: false, reason: 'ENEMY_ATTACK_ROUTE_BLOCKED', evidence: { sight: true } }, 3: { unknown: true, reason: 'ATTACK_ACCESS_UNKNOWN', evidence: { sight: null } }, 4: { unknown: false, reason: 'PROFILE_DISALLOWS_ENGAGEMENT', evidence: { sight: false } } }
  const state = body([near, blocked, unsure, boss, cow])
  const view = splitExposed(state.entities, state, value => answers[value.runtimeId])
  assert.deepEqual(view.exposed.map(value => value.runtimeId), ['1', '3', '4', '5'])
  assert.deepEqual(view.unexposed.map(value => value.runtimeId), ['2'])
  // A second pass that now knows the third zombie has no route: both are remembered.
  const first = { ...state, entities: view.exposed, unexposedEntities: view.unexposed }
  const second = exposedView(first, view.exposed.filter(value => value.runtimeId !== '3'))
  assert.deepEqual(second.entities.map(value => value.runtimeId), ['1', '4', '5'])
  assert.deepEqual(second.unexposedEntities.map(value => value.runtimeId), ['2', '3'])
  assert.equal(exposedView(first, view.exposed), first)
})

test('the escape port pass that drops a retained actor releases it (the live failure)', () => {
  // The observation kept the zombie (route search out of budget: unknown); the
  // port's own pass, 13 ms later, knows it has no route to the Bot.
  const zombie = actor('zombie', 14.5)
  const observed = body([zombie], { unexposedEntities: [] })
  const records = held(observed)
  assert.equal(records.length, 1)
  const pass = splitExposed(observed.entities, observed, () => ({ unknown: false, reason: 'ENEMY_ATTACK_ROUTE_BLOCKED', evidence: { sight: true } })).exposed
  const canonical = evaluateThreats(observed, pass)
  // As it was read before: the actor is still in state.entities but not in the evaluation.
  assert.deepEqual(resolveWorkActors(observed, canonical, records).invalid, ['9'])
  const result = resolveWorkActors(exposedView(observed, pass), canonical, records)
  assert.deepEqual(result.invalid, [])
  assert.deepEqual(result.released, [{ runtimeId: '9', reason: 'no_attack_access' }])
})

test('player play keeps no work band outside the danger radius', () => {
  const zombie = actor('zombie', 14.5)
  for (const threatPolicy of ['balanced_mining', 'online_learning']) {
    const play = body([zombie], { threatPolicy, playerPlay: true })
    assert.equal(workMargin(play), 0)
    assert.equal(workMargin(play, { name: 'minecraft:skeleton', dangerRadius: 8 }), 0)
    assert.deepEqual(held(play), [])
  }
  // Outside play the band is unchanged: the same zombie is a pursuer to get clear of.
  const quarry = body([zombie], { threatPolicy: 'balanced_mining' })
  assert.equal(workMargin(quarry), 8)
  assert.equal(held(quarry).length, 1)
  // A record from before play began is released by distance at the radius.
  const play = body([zombie], { threatPolicy: 'balanced_mining', playerPlay: true })
  const records = held(quarry).map(record => ({ ...record, dangerRadius: 8 }))
  assert.deepEqual(resolveWorkActors(play, evaluateThreats(play, play.entities), records).released, [{ runtimeId: '9', reason: 'clearance' }])
})

test('idle protection stops asking for clearance from an actor that left the view or went stale, without one retreat', async t => {
  for (const mode of ['unexposed', 'stale']) {
    const zombie = actor('creeper', 9.15)
    const state = body([zombie], { unexposedEntities: [] })
    let escapes = 0
    const safety = createIdleSafety({ getState: () => structuredClone(state), isIdle: () => true, equipSword: () => {}, closeGui: () => {}, previewEngage: () => {}, engage: () => {}, verifyBody: () => true, escape: () => { escapes++; throw new Error('Idle escape retained actor identity, policy or scope changed') }, onEmergencyStop: () => assert.fail(`${mode}: no emergency for an actor that is not a pursuer`), supportsWorkClearance: true, retryAfterEmergency: true, graceMs: 0, intervalMs: 1000 })
    t.after(() => safety.stop())
    safety.start(); await safety.drain()
    assert.equal(safety.requestWorkClearance().pending, true, mode)
    if (mode === 'unexposed') { state.entities = []; state.unexposedEntities = [zombie] } else zombie.updatedAt = ago(6 * 60000)
    await safety.tick()
    assert.equal(safety.snapshot().workClearancePending, false, mode)
    assert.equal(safety.snapshot().phase, 'observing', mode)
    assert.equal(safety.requestWorkClearance().pending, false, mode)
    assert.equal(escapes, 0, mode)
    safety.stop()
  }
})
