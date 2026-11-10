'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createCombatCoordinator } = require('../src/combat-coordinator')

function fixture ({ type = 'creeper', range = 3.2, bow = false, approach = null, meleeReady = null, rangedReady = false, rangedPreview = null, rangedPending = false, onSleep = null } = {}) {
  let time = 1000, pendingResolve = null, activeRanged = false
  const events = [], logs = [], attacks = [], approaches = [], retreats = [], resumes = []
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'scope-A', startedAt: '2026-11-06T13:00:00Z', runtimeEntityId: '1', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, lifecycle: { deathId: 3 }, inventory: { known: true, items: bow ? [{ name: 'minecraft:bow', count: 1 }, { name: 'minecraft:arrow', count: 8 }] : [] } }
  const actor = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: `minecraft:${type}`, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 0.5 + Math.sqrt(range * range - 0.72 * 0.72), y: 65, z: 0.5 } }
  const context = () => ({ state, actor, events, logs, time, advance: ms => { time += ms } })
  const distance = () => Math.hypot(state.position.x - actor.position.x, state.position.y - actor.position.y - 0.9, state.position.z - actor.position.z)
  const result = code => ({ code, targetRuntimeId: actor.runtimeId, targetUniqueId: actor.uniqueId, targetDead: false, serverConfirmed: false })
  const controller = name => ({
    preview: (_id, options = {}) => {
      const ready = name === 'melee' ? distance() <= (options.reachLimit ?? 3) && (meleeReady ? meleeReady(context()) : true) : rangedPreview ? rangedPreview(context()) : rangedReady
      events.push({ event: `preview_${name}`, ready, at: time })
      return { ready, code: ready ? null : name === 'melee' ? 'OUT_OF_REACH' : 'RANGE' }
    },
    survey: () => ({ ready: rangedReady, code: rangedReady ? null : 'RANGE' }),
    engage: (_id, options = {}) => {
      events.push({ event: `engage_${name}`, at: time }); attacks.push({ name, at: time, reachLimit: options.reachLimit ?? null })
      if (name === 'ranged' && rangedPending) { activeRanged = true; return new Promise(resolve => { pendingResolve = resolve }) }
      return Promise.resolve({ ...result('TARGET_DEAD'), targetDead: true, serverConfirmed: true })
    },
    cancel: (reason, code) => { events.push({ event: `cancel_${name}`, code, at: time }); pendingResolve?.(result(code)); pendingResolve = null; activeRanged = false },
    drain: async () => {},
    snapshot: () => ({ cleanupUnconfirmed: false, phase: activeRanged ? 'charging' : 'idle', targetRuntimeId: activeRanged ? actor.runtimeId : null })
  })
  const coordinator = createCombatCoordinator({ getState: () => state, entities: { snapshot: () => [structuredClone(actor)] }, melee: controller('melee'), ranged: controller('ranged'), canAct: () => true, canEngage: () => true, canAcquireMeleeApproach: () => true,
    acquire: async () => ({ acquired: true, token: 'combat-owner' }), resume: async value => { resumes.push(value) },
    approach: async (target, options) => { approaches.push({ target, options, at: time }); return approach ? approach({ ...context(), options }) : { ready: false, reason: 'No known bounded melee stance' } },
    retreat: async (target, options) => { retreats.push({ target, options, at: time }); return { ready: false, reason: 'No known retreat standpoint' } },
    log: message => logs.push(message), now: () => time, sleep: async ms => { time += ms; events.push({ event: 'sleep', at: time }); onSleep?.(context()); await turn() }
  })
  return { ...context(), coordinator, attacks, approaches, retreats, resumes, advance: ms => { time += ms } }
}

async function corner (f) {
  assert.equal((await f.coordinator.tick()).code, 'CREEPER_EVADE_UNAVAILABLE')
  f.advance(1)
}

test('a cornered creeper with no reachable melee stance ends without the ordinary two-second close hold', async () => {
  const f = fixture({ range: 4.0 }); await corner(f)
  const before = f.events.length
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'CREEPER_APPROACH_BLOCKED')
  assert.equal(f.approaches.length, 2)
  assert.equal(f.attacks.length, 0)
  assert.ok(f.events.slice(before).filter(e => e.event === 'sleep').length < 8)
  assert.equal(f.coordinator.snapshot().busy, false)
  assert.equal(f.resumes.length, 2)
  assert.equal(result.serverConfirmed, false)
})

test('an urgent creeper counterstep still awaiting its route is aborted within its short total budget', async () => {
  const f = fixture({ range: 3.8, approach: ({ options }) => new Promise(resolve => { options.signal.addEventListener('abort', () => resolve({ ready: false, reason: 'counterstep aborted' }), { once: true }) }) })
  await corner(f)
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'CREEPER_APPROACH_BLOCKED')
  assert.equal(f.approaches.length, 1)
  assert.equal(f.approaches[0].options.signal.aborted, true)
  assert.equal(f.retreats.length, 2, 'one failed initial evade and one bounded final retreat')
  assert.equal(f.attacks.length, 0)
  assert.equal(f.coordinator.snapshot().busy, false)
})

test('cornered evidence cannot cross a new connection, life, dimension or session start', async t => {
  for (const key of ['connectionId', 'life', 'dimension', 'startedAt']) await t.test(key, async () => {
    const f = fixture(); await corner(f)
    if (key === 'life') f.state.lifecycle.deathId++
    else if (key === 'dimension') { f.state.dimension = 'nether'; f.actor.dimension = 'nether' }
    else f.state[key] = `${f.state[key]}-new`
    const result = await f.coordinator.tick()
    assert.equal(result.code, 'CREEPER_EVADE_UNAVAILABLE')
    assert.equal(f.approaches.length, 0)
    assert.equal(f.attacks.length, 0)
  })
})

test('a failed creeper approach that ends inside the same real melee preview attacks without an extra poll', async () => {
  let fallbackReadyAt = null
  const f = fixture({ range: 3.8, approach: ({ actor }) => { actor.position.x = 2.2; throw new Error('route invalidated after a short step') }, meleeReady: ({ time }) => { fallbackReadyAt ??= time; return true } })
  await corner(f)
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'TARGET_DEAD')
  assert.equal(f.attacks.length, 1)
  assert.equal(f.attacks[0].name, 'melee')
  assert.ok(f.attacks[0].at - fallbackReadyAt <= 50, 'no ordinary close-hold or extra post-approach poll before a fresh melee attempt')
  assert.equal(f.approaches.length, 1)
  assert.equal(f.resumes.length, 2)
})

test('ordinary non-creeper close holds retain their existing bounded behaviour', async () => {
  const f = fixture({ type: 'zombie' })
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'APPROACH_NOT_READY')
  assert.equal(f.approaches.length, 1)
  assert.ok(f.events.filter(e => e.event === 'sleep').length >= 40)
  assert.equal(f.retreats.length, 0)
})

test('a creeper that cannot use its permitted attack does not enter the generic profile wait', async () => {
  const f = fixture({ range: 10, bow: true, rangedReady: true, rangedPreview: () => false })
  const result = await f.coordinator.tick()
  assert.equal(result.code, 'PROFILE_MODE_BLOCKED')
  assert.equal(f.attacks.length, 0)
  assert.equal(f.retreats.length, 1)
  assert.ok(f.events.filter(e => e.event === 'sleep').length < 8)
})

test('combat start, phases, interrupted shots and finish retain bounded bound-target context', async () => {
  let moved = false
  const f = fixture({ range: 10, bow: true, rangedReady: true, rangedPending: true, onSleep: ({ actor, events }) => { if (!moved && events.some(e => e.event === 'engage_ranged')) { moved = true; actor.position.x = 5 } } })
  f.state.connectionId = 'scope-A\nnot-another-log'
  await f.coordinator.tick()
  for (const prefix of ['戦闘開始:', '戦闘状態:', '射撃中断:', '戦闘終了:']) assert.ok(f.logs.some(line => line.startsWith(prefix)), `missing ${prefix}`)
  for (const line of f.logs) {
    assert.equal(line.includes('\n'), false)
    assert.ok(line.length < 1100)
    const context = JSON.parse(line.split(' context=')[1])
    assert.equal(context.runtimeId, '70'); assert.equal(context.uniqueId, '-700'); assert.equal(context.life, 3)
    assert.equal(context.scope.connectionId, f.state.connectionId); assert.equal(context.scope.dimension, 'overworld'); assert.equal(context.scope.selfRuntimeId, '1')
    assert.ok(Number.isSafeInteger(context.claimId))
    assert.equal(Object.hasOwn(context, 'attackerRuntimeId'), false)
  }
})

test('live case 2026-11-10: a cornered creeper within 3.5m is struck in place without stepping', async () => {
  const f = fixture({ range: 3.2 }); await corner(f)
  const approachesBefore = f.approaches.length
  await f.coordinator.tick()
  assert.equal(f.attacks.filter(a => a.name === 'melee').length >= 1, true, 'swung from where it stands')
  assert.equal(f.attacks.find(a => a.name === 'melee').reachLimit, 3.5)
  assert.equal(f.approaches.length, approachesBefore, 'no step toward the creeper')
  assert.ok(f.logs.some(line => line.includes('クリーパー至近の打撃')))
})

test('a creeper that is not cornered keeps the normal 3.0m melee reach', async () => {
  const f = fixture({ range: 3.2 })
  const first = await f.coordinator.tick()
  assert.equal(f.attacks.some(a => a.reachLimit === 3.5), false, JSON.stringify(first))
})
