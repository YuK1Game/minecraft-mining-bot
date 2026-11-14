'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createIdleSafety } = require('../src/idle-safety')

function fixture (t, hooks = {}) {
  let time = 1000; let idle = true; let generation = true
  const calls = []; const progress = []; const emergencies = []; const actors = []
  const sword = { slot: 0, name: 'minecraft:stone_sword', count: 1 }
  const state = { phase: 'spawned', profile: 'idle', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '1', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: { ...sword }, inventory: { known: true, items: [{ ...sword }] }, predicted: { physicsState: { onGround: true, isInWater: false } }, crafting: { openContainer: null } }
  let safety
  const getState = async () => { calls.push({ type: 'state' }); return structuredClone({ ...state, entities: actors }) }
  const options = {
    getState,
    isIdle: context => { calls.push({ type: 'ownership', ...context }); return hooks.isIdle ? hooks.isIdle(context, { time, idle }) : idle },
    isCurrentGeneration: () => generation,
    equipSword: async context => { calls.push({ type: 'equip', context }); return hooks.equipSword ? hooks.equipSword(context, { state, actors }) : { serverConfirmed: true } },
    closeGui: async context => { calls.push({ type: 'close_gui', context }); state.crafting.openContainer = null },
    verifyBody: async (observed, context) => { calls.push({ type: 'body', context }); return (hooks.verifyBody ? hooks.verifyBody(observed) : hooks.bodyReady !== false) && observed.predicted?.physicsState?.onGround === true },
    verifyMeleeBody: hooks.verifyMeleeBody ? async (observed, context) => { calls.push({ type: 'melee_body', context }); return hooks.verifyMeleeBody(observed) } : null,
    verifyLedgeBody: hooks.verifyLedgeBody ? async (observed, context) => { calls.push({ type: 'ledge_body', context }); return hooks.verifyLedgeBody(observed) } : undefined,
    verifyShallowWater: hooks.verifyShallowWater ? async (observed, context) => { calls.push({ type: 'shallow_water', context }); return hooks.verifyShallowWater(observed) } : undefined,
    verifyNearSurfaceWater: hooks.verifyNearSurfaceWater ? async (observed, context) => { calls.push({ type: 'near_surface_water', context }); return hooks.verifyNearSurfaceWater(observed) } : undefined,
    waterCounter: hooks.waterCounter ? async context => { calls.push({ type: 'water_counter', context }); return hooks.waterCounter(context, { state, actors }) } : undefined,
    previewEngage: async (id, context) => { calls.push({ type: 'preview', id, context }); return hooks.previewEngage ? hooks.previewEngage(id, context, { state, actors }) : { ready: hooks.previewReady !== false } },
    engage: async (id, context) => { calls.push({ type: 'engage', id, context }); if (hooks.engage) return hooks.engage(id, context, { state, actors }); actors.splice(0); return { phase: 'observed', reaction: 'target_removed', serverConfirmed: true, targetStopped: true } },
    previewStrike: hooks.strike ? async () => hooks.strikePreview ? hooks.strikePreview() : ({ ready: hooks.strikeReady !== false, cooldownRemainingMs: 0 }) : null,
    verifyStrikeBody: hooks.strike ? async observed => hooks.verifyStrikeBody ? hooks.verifyStrikeBody(observed) : hooks.strikeBodyReady !== false : null,
    previewEmergency: hooks.emergencyStrike ? async (id, context) => hooks.previewEmergency ? hooks.previewEmergency(id, context, { state, actors }) : ({ ready: hooks.emergencyReady !== false, cooldownRemainingMs: 0 }) : null,
    emergencyStrike: hooks.emergencyStrike ? async (id, context) => { calls.push({ type: 'emergency_strike', id, context }); return hooks.emergencyStrike(id, context, { state, actors }) } : null,
    strike: hooks.strike ? async (id, context) => { calls.push({ type: 'strike', id, context }); return hooks.strike(id, context, { state, actors }) } : null,
    escape: hooks.escape ? async context => { calls.push({ type: 'escape', context }); return hooks.escape(context, { state, actors }) } : null,
    partialEscape: hooks.partialEscape ? async context => { calls.push({ type: 'partial_escape', context }); return hooks.partialEscape(context, { state, actors }) } : null,
    clearEscape: hooks.clearEscape ? async context => { calls.push({ type: 'clear_escape', context }); return hooks.clearEscape(context, { state, actors }) } : null,
    closeHut: hooks.closeHut ? async context => { calls.push({ type: 'close_hut', context }); return hooks.closeHut(context, { state, actors }) } : null,
    cancelOwned: async context => { calls.push({ type: 'cancel', context }); if (hooks.cancelOwned) return hooks.cancelOwned(context) },
    onEmergencyStop: details => { emergencies.push(details); return hooks.onEmergencyStop?.(details) },
    onProgress: value => { progress.push(value); hooks.onProgress?.(value, safety) },
    now: () => time, intervalMs: 20, graceMs: 500, actionTimeoutMs: hooks.actionTimeoutMs ?? 100
  }
  safety = createIdleSafety(options)
  t.after(() => safety.stop('test_cleanup'))
  const tick = async () => { const result = await safety.tick(); await new Promise(resolve => setImmediate(resolve)); return result }
  const start = async () => { safety.start({ enableEpoch: 1 }); await tick(); time += 500; await tick() }
  const enemy = (name = 'zombie', x = 2, id = '9') => ({ kind: 'mob', runtimeId: id, uniqueId: id, entityType: `minecraft:${name}`, dimension: 'overworld', alive: true, positionKnown: true, hostile: true, position: { x, y: 65, z: 0.5 } })
  const cover = () => { state.hut = { inside: true, closed: true, entranceClosed: true, usable: true, serverConfirmed: true, established: true, structureIntact: true } }
  return { safety, state, actors, calls, progress, emergencies, tick, start, enemy, cover, advance: ms => { time += ms }, setIdle: value => { idle = value }, setGeneration: value => { generation = value } }
}

test('constructor and unstarted tick are passive; peaceful idle never equips, fights or leaves the world', async t => {
  const f = fixture(t)
  assert.deepEqual(f.calls, [])
  await f.tick()
  assert.deepEqual(f.calls, [])
  await f.start()
  for (let i = 0; i < 5; i++) { f.advance(100); await f.tick() }
  assert.equal(f.calls.some(call => ['equip', 'close_gui', 'engage', 'escape'].includes(call.type)), false)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().running, true)
})

test('explicit bounded recovery allows low health only while no threat or new damage is observed', async t => {
  for (const mode of ['timeout', 'damage', 'enemy', 'unknown', 'critical']) {
    const f = fixture(t); f.state.health = 9
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 2000 }); await f.tick(); f.advance(501); await f.tick()
    assert.equal(f.safety.snapshot().phase, 'recovering', mode)
    if (mode === 'timeout') f.advance(500)
    if (mode === 'damage') f.state.health = 8
    if (mode === 'critical') f.state.health = 6
    if (mode === 'enemy') f.actors.push(f.enemy('skeleton', 3))
    if (mode === 'unknown') f.actors.push({ ...f.enemy(), positionKnown: false, position: null })
    await f.tick(); await f.safety.drain()
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('low-health recovery can continue an undamaged partial escape and resumes only after danger clears', async t => {
  let attempts = 0
  const f = fixture(t, { escape: (context, { state, actors }) => {
    state.position.x += 1; attempts++
    if (attempts === 2) actors.splice(0)
    return { supported: true, arrived: true, partialEscape: attempts === 1, escaped: attempts === 2 }
  } })
  f.state.health = 10; f.actors.push(f.enemy('zombie', -8)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick()
  assert.equal(attempts, 2)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'recovering')
})

test('critical recovery waits for food only while alive, undamaged and free of observed threats', async t => {
  for (const mode of ['quiet', 'damage', 'enemy', 'unknown', 'timeout']) {
    const f = fixture(t); f.state.health = 4.631
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 2000 }); await f.tick(); f.advance(501); await f.tick()
    assert.equal(f.safety.snapshot().phase, 'recovering', mode)
    if (mode === 'damage') f.state.health = 4
    if (mode === 'enemy') f.actors.push(f.enemy('zombie', 3))
    if (mode === 'unknown') f.actors.push({ ...f.enemy(), positionKnown: false, position: null })
    if (mode === 'timeout') f.advance(500)
    await f.tick(); await f.safety.drain()
    assert.equal(f.emergencies.length, mode === 'quiet' ? 0 : 1, mode)
  }
})

test('successive partial escapes can replan against a pursuing zombie while retaining distance', async t => {
  for (const mode of ['gradual', 'too_fast', 'too_close', 'replacement']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      attempts++; state.position.x += 1
      if (mode === 'gradual' && attempts === 3) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      actors[0].position.x += mode === 'too_fast' ? 2.5 : mode === 'too_close' ? 5.7 : 1.4
      if (mode === 'replacement') actors[0].uniqueId = 'different'
      return { supported: true, arrived: true, partialEscape: true }
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', -8)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'gradual' ? 3 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'gradual' ? 0 : 1, mode)
  }
})

test('idle protection delegates a known shallow-water creeper episode to the counterattack and rechecks it', async t => {
  for (const mode of ['cleared', 'unclear', 'unsupported', 'damage', 'new_actor']) {
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, waterCounter: (context, { state, actors }) => {
      if (mode === 'cleared') actors.splice(0)
      if (mode === 'damage') state.health = 19
      if (mode === 'new_actor') actors.push(f.enemy('zombie', 1, '25'))
      return mode === 'unsupported' ? { supported: false } : { supported: true, attacked: true, escaped: false, reason: 'replan_required' }
    }, escape: () => ({ supported: false, reason: 'no_known_away_route' }) })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.actors.push(f.enemy('creeper', -3, '9'), f.enemy('creeper', -5, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'water_counter').length, 1, mode)
    assert.equal(f.emergencies.length, mode === 'cleared' ? 0 : 1, mode)
    if (mode !== 'unsupported') assert.equal(f.safety.snapshot().lastDefense?.action, 'water_counter', mode)
  }
})

test('a near-surface wait continues only after rising with the same safe pursuers', async t => {
  for (const mode of ['safe', 'static', 'damage', 'primed', 'too_close', 'new_enemy', 'unsafe_water']) {
    let attempts = 0; let change = null
    const f = fixture(t, { bodyReady: false, verifyNearSurfaceWater: () => {
      if (!change && mode !== 'unsafe_water') change = setTimeout(() => {
        if (mode !== 'static') { f.state.position.y += 0.5; f.state.rawServerPosition = { ...f.state.position } }
        if (mode === 'damage') f.state.health = 19
        if (mode === 'primed') f.actors[0].primed = true
        if (mode === 'too_close') f.actors[0].position.x += 1
        if (mode === 'new_enemy') f.actors.push(f.enemy('zombie', 3, '11'))
      }, 75)
      return mode !== 'unsafe_water'
    }, verifyShallowWater: state => state.position.y > 67, escape: (context, { actors }) => { attempts++; actors.splice(0); return { supported: true, arrived: true, escaped: true } } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }
    f.actors.push({ ...f.enemy('creeper', -5.5, '9'), primed: false, charged: false }, { ...f.enemy('spider', 3, '10'), position: { x: 3, y: 65, z: 12 } })
    t.after(() => clearTimeout(change))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 1 : 0, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('near-surface observation handles a known distant drowned and aborts on changes', async t => {
  for (const mode of ['safe', 'damage', 'identity', 'drowned_close', 'creeper_primed']) {
    let attempts = 0; let timer
    const f = fixture(t, { bodyReady: false, verifyNearSurfaceWater: () => {
      if (!timer) timer = setTimeout(() => {
        f.state.position.y += 0.5; f.state.rawServerPosition = { ...f.state.position }
        if (mode === 'damage') f.state.health = 19
        if (mode === 'identity') f.actors[1].uniqueId = 'changed'
        if (mode === 'drowned_close') f.actors[1].position.y += 6
        if (mode === 'creeper_primed') f.actors[0].primed = true
      }, 75)
      return true
    }, verifyShallowWater: state => state.position.y > 67, escape: (context, { actors }) => { attempts++; actors.splice(0); return { supported: true, arrived: true, escaped: true } } })
    f.state.threatPolicy = 'balanced_mining'; f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }
    f.actors.push({ ...f.enemy('creeper', -6.5, '9'), primed: false, charged: false }, { ...f.enemy('drowned', -4, '10'), position: { x: -4, y: 53.5, z: 0.5 } })
    t.after(() => clearTimeout(timer))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 1 : 0, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('a water correction replans only after observed outward progress against the same safe creeper pair', async t => {
  for (const mode of ['safe', 'long_correction', 'too_far', 'short_correction', 'stale', 'no_progress', 'damage', 'identity', 'primed', 'closer', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : mode === 'short_correction' ? 0.02 : mode === 'long_correction' ? 2 : mode === 'too_far' ? 4.6 : 1
      state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'changed'
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'closer') actors[0].position.x += 1.5
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []
    f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -3, '9'), f.enemy('creeper', -4, '10'))
    await f.start(); await f.safety.drain()
    const resumed = ['safe', 'long_correction', 'short_correction'].includes(mode)
    assert.equal(attempts, resumed ? 2 : 1, mode)
    assert.equal(f.emergencies.length, resumed ? 0 : 1, mode)
  }
})

test('land-to-water correction replans only for the same safe mixed group with real server progress', async t => {
  for (const mode of ['safe', 'spider_outside', 'spider_arrives', 'stale', 'damage', 'primed', 'identity', 'no_progress', 'closer_spider', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { verifyShallowWater: () => mode !== 'unknown_water', escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : 1.5
      state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
      actors[0].position.x += 1.6
      if (mode === 'damage') state.health = 19
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'identity') actors[0].uniqueId = 'replacement'
      if (mode === 'closer_spider') actors[2].position.z -= 2
      if (mode === 'spider_outside') actors[2].position.z += 2
      if (mode === 'spider_arrives') actors[2].position.z -= 1
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    const creeper = { ...f.enemy('creeper', -6, '9'), primed: false, charged: false }
    const zombie = f.enemy('zombie', -9.5, '10')
    const spider = { ...f.enemy('spider', 3, '11'), position: { x: 3, y: 65, z: mode === 'spider_arrives' ? 13 : 12 } }
    f.actors.push(creeper, zombie, spider)
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'spider_outside', 'spider_arrives'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'spider_outside', 'spider_arrives'].includes(mode) ? 0 : 1, mode)
  }
})

test('close creeper and distant zombie replan only after confirmed outward water progress', async t => {
  for (const mode of ['safe', 'short', 'stale', 'no_progress', 'closing', 'damage', 'primed', 'identity', 'zombie_close', 'new_enemy', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : mode === 'short' ? 0.17 : 0.47; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      actors[0].position.x += mode === 'closing' ? 0.5 : 0.2
      if (mode === 'damage') state.health = 19
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'identity') actors[0].uniqueId = 'replacement'
      if (mode === 'zombie_close') actors[1].position.x += 5
      if (mode === 'new_enemy') actors.push(f.enemy('skeleton', 3, '11'))
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -3.7, '9'), primed: false, charged: false }, f.enemy('zombie', -10.5, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'short'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'short'].includes(mode) ? 0 : 1, mode)
  }
})

test('a stalled water input can replan only after fresh outward server progress', async t => {
  for (const mode of ['safe', 'missed_ticks', 'stale', 'no_progress', 'damage', 'identity', 'other_failure']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : 0.6; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      actors[0].position.x += 0.2
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'replacement'
      return { supported: true, arrived: false, code: 'SHALLOW_MOVEMENT_FAILED', partialFailure: mode === 'other_failure' ? 'unexpected failure' : mode === 'missed_ticks' ? 'Too many movement ticks were missed' : 'Movement input timer stalled', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -5.5, '9'), primed: false, charged: false }, f.enemy('zombie', -10.5, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'missed_ticks'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'missed_ticks'].includes(mode) ? 0 : 1, mode)
  }
})

test('a tiny first stalled water input retries only with a well-separated unchanged creeper', async t => {
  for (const mode of ['safe', 'first_correction', 'repeated', 'stale', 'no_progress', 'damage', 'primed', 'identity', 'closing', 'too_close', 'other_failure']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2 && mode !== 'repeated') { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : 0.02; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt++
      actors[0].position.x += mode === 'closing' ? 0.5 : mode === 'too_close' ? 1.5 : 0.25
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'replacement'
      if (mode === 'primed') actors[0].primed = true
      return { supported: true, arrived: false, code: mode === 'first_correction' ? 'SHALLOW_CORRECTION_REPLAN' : 'SHALLOW_MOVEMENT_FAILED', partialFailure: mode === 'other_failure' ? 'unexpected failure' : 'Movement input timer stalled', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -6.5, '9'), primed: false, charged: false })
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'first_correction', 'repeated'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'first_correction'].includes(mode) ? 0 : 1, mode)
  }
})

test('a stalled water route waits briefly for an actual server position before retrying', async t => {
  for (const mode of ['confirmed', 'timeout', 'damage', 'new_enemy']) {
    let attempts = 0; let timer
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.6
      timer = setTimeout(() => {
        if (mode === 'confirmed') { state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = 2 }
        if (mode === 'damage') state.health = 19
        if (mode === 'new_enemy') actors.push(f.enemy('zombie', 2, '10'))
      }, 80)
      return { supported: true, arrived: false, code: 'SHALLOW_MOVEMENT_FAILED', partialFailure: 'Movement input timer stalled', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -6.5, '9'), primed: false, charged: false })
    t.after(() => clearTimeout(timer))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'confirmed' ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, mode === 'confirmed' ? 0 : 1, mode)
  }
})

test('tracked outside spider may enter danger during a corrected single-creeper retreat', async t => {
  for (const mode of ['known', 'replacement', 'too_close', 'damage']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.6; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = 2
      actors[0].position.x += 0.2
      actors[1].position.z -= mode === 'too_close' ? 2 : 0.5
      if (mode === 'replacement') actors[1].uniqueId = 'different'
      if (mode === 'damage') state.health = 19
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -5, '9'), primed: false, charged: false }, { ...f.enemy('spider', 3, '10'), position: { x: 3, y: 65, z: 12.5 } })
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('single zombie water correction replans only after confirmed progress and safe identity', async t => {
  for (const mode of ['safe', 'stale', 'closing', 'damage', 'identity', 'too_close', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.5; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      actors[0].position.x += mode === 'closing' ? 0.6 : 0.1
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'replacement'
      if (mode === 'too_close') actors[0].position.x += 2
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('zombie', -9, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'closing'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'closing'].includes(mode) ? 0 : 1, mode)
  }
})

test('surface correction replans around the same distant drowned only with observed progress', async t => {
  for (const mode of ['safe', 'drowned_rises', 'toward_drowned', 'stale', 'damage', 'identity', 'drowned_close', 'creeper_primed', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'toward_drowned' ? -0.4 : 0.8; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[1].uniqueId = 'replacement'
      if (mode === 'drowned_close') actors[1].position.y += 6
      if (mode === 'drowned_rises') actors[1].position.y += 1
      if (mode === 'creeper_primed') actors[0].primed = true
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.threatPolicy = 'balanced_mining'; f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -6, '9'), primed: false, charged: false }, { ...f.enemy('drowned', -4, '10'), position: { x: -4, y: 53.5, z: 0.5 } })
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'drowned_rises', 'toward_drowned'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'drowned_rises', 'toward_drowned'].includes(mode) ? 0 : 1, mode)
  }
})

function receivedMixedWater (t, mode = 'safe') {
  let attempts = 0
  const creeperHorizontal = Math.sqrt(7.9 ** 2 - 1.62 ** 2)
  const drownedDepth = 10.92
  const drownedHorizontal = Math.sqrt(12.1 ** 2 - drownedDepth ** 2)
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
    attempts++
    if (attempts === 2 && !['cap', 'large_loss'].includes(mode)) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
    const step = mode === 'no_progress' || mode === 'cap' && attempts > 8 ? 0 : mode === 'too_far' ? 4.501 : mode === 'long_leg' ? 4.5 : mode === 'cap' ? 0.125 : 0.383
    state.position.z -= step; state.rawServerPosition = { ...state.position }
    if (mode !== 'stale') state.rawServerPositionUpdatedAt++
    const loss = mode === 'large_loss' ? attempts * 0.4 : 0.098
    const creepH = creeperHorizontal + 0.098 - loss
    actors[0].position = { x: state.position.x + 3, y: state.position.y - 1.62, z: state.position.z + Math.sqrt(creepH ** 2 - 9) }
    let depth = mode === 'vertical_low' ? 7.99 : drownedDepth
    let drownedH = mode === 'large_loss' ? drownedHorizontal + 0.098 - loss : drownedHorizontal
    if (mode === 'below_floor') drownedH = Math.sqrt(10.749 ** 2 - 10 ** 2)
    if (mode === 'below_floor') depth = 10
    actors[1].position = { x: state.position.x - drownedH, y: state.position.y - depth, z: state.position.z }
    if (mode === 'primed') actors[0].primed = true
    if (mode === 'identity') actors[1].uniqueId = 'different'
    if (mode === 'new_actor') actors.push({ ...f.enemy('zombie', state.position.x + 10, '11'), position: { x: state.position.x + 10, y: state.position.y, z: state.position.z } })
    if (mode === 'missing') actors.splice(1, 1)
    if (mode === 'unknown') { actors[1].positionKnown = false; actors[1].position = null }
    if (mode === 'damage') state.health = 19
    if (mode === 'drift') state.position.y += 0.751
    return { supported: mode !== 'unsupported', arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
  } })
  f.state.threatPolicy = 'balanced_mining'; f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
  f.actors.push({ ...f.enemy('creeper', f.state.position.x + 3, '9'), primed: false, charged: false, position: { x: f.state.position.x + 3, y: f.state.position.y - 1.62, z: f.state.position.z + Math.sqrt((creeperHorizontal + 0.098) ** 2 - 9) } }, { ...f.enemy('drowned', f.state.position.x - drownedHorizontal - 0.098, '10'), position: { x: f.state.position.x - drownedHorizontal - 0.098, y: f.state.position.y - drownedDepth, z: f.state.position.z } })
  return { ...f, attempts: () => attempts, begin: async () => { f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain() } }
}

test('received water progress replans an eligible creeper and submerged drowned despite a small historical distance loss', async t => {
  const f = receivedMixedWater(t)
  await f.begin()
  assert.equal(f.attempts(), 2)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'observing')
  const replan = f.safety.snapshot().lastWaterReplan
  assert.equal(replan.drownedCandidate, false)
  assert.equal(replan.receivedWaterReplan, true)
  assert.ok(Math.abs(replan.rawSwimProgress - 0.383) < 1e-6)
  assert.ok(Math.abs(replan.nearestGain + 0.098) < 1e-6)
  const second = f.calls.filter(call => call.type === 'escape')[1].context
  assert.ok(Math.abs(second.threats.find(actor => actor.name === 'minecraft:drowned').distance - 12.1) < 1e-6)
  assert.ok(Math.abs(second.state.position.y - 1.62 - second.threats.find(actor => actor.name === 'minecraft:drowned').position.y - 9.3) < 1e-6)
})

test('received water replanning preserves existing group distance, depth, identity and fresh-position requirements', async t => {
  for (const mode of ['below_floor', 'vertical_low', 'primed', 'stale', 'no_progress', 'new_actor', 'identity', 'missing', 'unknown', 'damage', 'drift', 'unknown_water', 'too_far', 'unsupported']) {
    const f = receivedMixedWater(t, mode)
    await f.begin()
    assert.equal(f.attempts(), 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, 1, mode)
    assert.notEqual(f.safety.snapshot().lastWaterReplan?.receivedWaterReplan, true, mode)
    await f.safety.stop()
  }
})

test('unified received water handoff retains the total eight-action cap and requires fresh progress in a new episode', async t => {
  const f = receivedMixedWater(t, 'cap')
  await f.begin()
  assert.equal(f.attempts(), 8)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'escape_replan')
  assert.equal(f.safety.snapshot().busy, false)
  f.advance(501); await f.tick(); await f.safety.drain()
  assert.equal(f.attempts(), 9)
  assert.equal(f.emergencies.length, 1)
})

test('unified water handoff accepts a full 4.5m guarded leg but refuses cumulative loss beyond one block', async t => {
  const long = receivedMixedWater(t, 'long_leg')
  await long.begin()
  assert.equal(long.attempts(), 1)
  assert.equal(long.emergencies.length, 0)
  assert.equal(long.safety.snapshot().phase, 'escape_replan')
  await long.safety.stop()
  const closing = receivedMixedWater(t, 'large_loss')
  await closing.begin()
  assert.equal(closing.attempts(), 6)
  assert.equal(closing.emergencies.length, 1)
  assert.equal(closing.progress.some(value => value.phase === 'escape_replan'), false)
})

test('two tiny water corrections cannot repeat indefinitely', async t => {
  let attempts = 0
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state }) => {
    attempts++; state.position.x += 0.02; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++
    return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
  } })
  f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
  f.actors.push(f.enemy('creeper', -3, '9'), f.enemy('creeper', -4, '10'))
  await f.start(); await f.safety.drain()
  assert.equal(attempts, 2)
  assert.equal(f.emergencies.length, 1)
})

test('a single known unarmed creeper permits only one fresh, low-approach water correction', async t => {
  for (const mode of ['safe', 'forward', 'repeated', 'stale', 'no_progress', 'damage', 'identity', 'primed', 'charged', 'closing', 'too_close', 'unknown_water', 'velocity']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 2 && mode !== 'repeated') { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : mode === 'forward' ? 0.34 : 0.02
      state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt++
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'different'
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'charged') actors[0].charged = true
      if (mode === 'closing') actors[0].position.x += 0.2
      if (mode === 'too_close') actors[0].position.x += 1.3
      return { supported: true, arrived: false, code: mode === 'velocity' ? 'SHALLOW_MOTION_REPLAN' : 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -4.65, '9'), primed: false, charged: false })
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['safe', 'forward', 'repeated'].includes(mode) ? 2 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['safe', 'forward'].includes(mode) ? 0 : 1, mode)
  }
})

test('a lone creeper permits later replans only with substantial observed separation', async t => {
  for (const mode of ['outward', 'closing', 'small_progress', 'stale']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 3) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      const distance = attempts === 1 ? 0.02 : mode === 'small_progress' ? 0.2 : 0.6
      state.position.x += distance; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale' || attempts === 1) state.rawServerPositionUpdatedAt++
      if (attempts === 2 && mode === 'closing') actors[0].position.x += 0.7
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', -4.65, '9'), primed: false, charged: false })
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['outward', 'small_progress'].includes(mode) ? 3 : 2, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, ['outward', 'small_progress'].includes(mode) ? 0 : 1, mode)
  }
})

test('a water velocity update only replans with independent fresh server-position progress', async t => {
  for (const mode of ['confirmed', 'stale', 'short', 'damage', 'changed_actor']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'short' ? 0.02 : 0.5
      state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'damage') state.health = 19
      if (mode === 'changed_actor') actors[0].uniqueId = 'other'
      return { supported: true, arrived: false, code: 'SHALLOW_MOTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -3, '9'), f.enemy('creeper', -4, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'confirmed' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'confirmed' ? 0 : 1, mode)
  }
})

test('water correction can replan for one remaining known creeper without treating a vanished one as safe', async t => {
  for (const mode of ['single', 'outside', 'vanished', 'too_close', 'primed', 'replacement']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.5; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = 2
      if (mode === 'vanished') actors.splice(1, 1)
      if (mode === 'too_close') actors[0].position.x += 1
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -5.25, '9'))
    if (mode !== 'single') f.actors.push(f.enemy('creeper', -7, '10'))
    await f.start(); await f.safety.drain()
    const resumed = mode === 'single' || mode === 'outside'
    assert.equal(attempts, resumed ? 2 : 1, mode)
    assert.equal(f.emergencies.length, resumed ? 0 : 1, mode)
  }
})

test('a corrected water-to-bank jump can settle before replanning while a known creeper stays clear', async t => {
  for (const mode of ['safe', 'primed', 'damage', 'blocked']) {
    let attempts = 0
    const f = fixture(t, { verifyShallowWater: state => state.predicted?.physicsState?.isInWater === true, strike: () => ({}), strikeBodyReady: mode !== 'blocked', escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.5; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = 2
      state.predicted.physicsState = { onGround: false, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.1, z: 0 } }
      if (mode === 'safe') setTimeout(() => { state.predicted.physicsState.onGround = true }, 75)
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'damage') state.health = 19
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -6, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('one distant water pursuer may close slightly during a confirmed move, but not approach rapidly', async t => {
  for (const mode of ['steady', 'short_steady', 'short_bounded', 'moderate_closing', 'bounded_closing', 'fast', 'close', 'stale', 'damage']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'short_steady' ? 0.45 : mode === 'short_bounded' ? 0.22 : mode === 'moderate_closing' ? 0.38 : 0.5; state.rawServerPosition = { ...state.position }; if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      actors[0].position.x += mode === 'fast' ? 1.2 : mode === 'close' ? 2 : mode === 'short_steady' ? 0.52 : mode === 'short_bounded' ? 0.6 : mode === 'moderate_closing' ? 0.51 : mode === 'bounded_closing' ? 0.9 : 0.55
      if (mode === 'damage') state.health = 19
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1; f.actors.push(f.enemy('creeper', -7, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, ['steady', 'short_steady', 'short_bounded', 'moderate_closing', 'bounded_closing'].includes(mode) ? 2 : 1, mode)
    assert.equal(f.emergencies.length, ['steady', 'short_steady', 'short_bounded', 'moderate_closing', 'bounded_closing'].includes(mode) ? 0 : 1, mode)
  }
})

function terminalWaterEpisode (t, mode = 'safe', { code = 'SHALLOW_CORRECTION_REPLAN', partialFailure, legs = 2 } = {}) {
  let attempts = 0
  const origin = { x: 63.7994155884, y: 64.2349777222, z: 65.5253829956 }
  const destination = { x: 65.4380187988, y: 63.9444732666, z: 65.3515472412 }
  const finalActor = { x: 58.8338165283, y: 62.4470939636, z: 63.5001029968 }
  const finalClearance = Math.hypot(finalActor.x - destination.x, finalActor.z - destination.z)
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts < legs, escape: (context, { state, actors }) => {
    attempts++
    if (attempts > legs) return { supported: true, arrived: false, code, partialFailure }
    const last = attempts === legs
    const fraction = last ? 1 : attempts / (legs - 1)
    state.position = { x: origin.x + (destination.x - 0.168 - origin.x) * fraction, y: origin.y, z: origin.z + (destination.z - origin.z) * fraction }
    if (mode === 'no_net') state.position.x = origin.x + (last ? 0.768 : 0.6)
    if (last && mode !== 'no_net') state.position = { ...destination }
    if (last && mode === 'latest_zero') state.position = { ...state.rawServerPosition }
    if (!last) actors[0].position = { x: state.position.x - Math.sqrt((finalClearance + 0.362) ** 2 - (finalActor.z - state.position.z) ** 2), y: finalActor.y, z: finalActor.z }
    if (last) actors[0].position = { ...finalActor }
    if (mode === 'no_net') actors[0].position.x = state.position.x - Math.sqrt((last ? finalClearance : finalClearance + 0.362) ** 2 - (finalActor.z - state.position.z) ** 2)
    if (mode === 'clearance_loss') actors[0].position = { x: state.position.x - (last ? 6.55 : 7.2), y: state.position.y, z: state.position.z }
    state.rawServerPosition = { ...state.position }
    if (!last || mode !== 'latest_stale') state.rawServerPositionUpdatedAt++
    if (last) {
      if (mode === 'safe') state.position = { x: 65.5014684839, y: 64.3057610671, z: 65.1675290595 }
      if (mode === 'identity') actors[0].uniqueId = 'replaced'
      if (mode === 'runtime_id') actors[0].runtimeId = '11'
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'charged') actors[0].charged = true
      if (mode === 'too_close') actors[0].position = { x: state.position.x - 4.49, y: state.position.y, z: state.position.z }
      if (mode === 'raw_close') { actors[0].position = { x: state.position.x - 5.4, y: state.position.y, z: state.position.z }; state.position.x += 0.3 }
      if (mode === 'predicted_close') { actors[0].position = { x: state.position.x - 5.8, y: state.position.y, z: state.position.z }; state.position.x -= 0.4 }
      if (mode === 'damage') state.health = 19
      if (mode === 'unknown_actor') actors.push({ ...f.enemy('zombie', 3, '10'), positionKnown: false, position: null })
      if (mode === 'new_enemy') actors.push(f.enemy('zombie', state.position.x - 10, '10'))
      if (mode === 'drift') state.position.y += 0.751
      if (mode === 'inventory') state.inventory.uncertain = true
      if (mode === 'thrown_unsafe') throw new Error('Shallow escape terrain or headroom changed')
      if (mode === 'unsupported') return { supported: false, arrived: false, code, reason: 'no_known_away_route' }
      if (mode === 'unsafe_result') return { supported: true, code, routeInterruption: { reason: 'The remaining escape route no longer leads away from current danger' } }
    }
    return { supported: true, arrived: false, escaped: false, code, partialFailure, serverConfirmed: false }
  } })
  f.state.position = { ...origin }; f.state.rawServerPosition = { ...origin }; f.state.rawServerPositionUpdatedAt = 1
  f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  const actor = { ...f.enemy('creeper', 57.069934845, '9'), primed: false, charged: false, position: { x: 57.069934845, y: 62.33638382, z: 63.50065994 } }
  if (mode === 'clearance_loss') actor.position = { x: origin.x - 7.6, y: origin.y, z: origin.z }
  f.actors.push(actor)
  return { ...f, attempts: () => attempts, begin: async () => { f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain() } }
}

test('a bounded water episode hands ownership back only after cumulative received progress with a fresh final leg', async t => {
  for (const options of [{}, { code: 'SHALLOW_MOTION_REPLAN' }, { code: 'SHALLOW_MOVEMENT_FAILED', partialFailure: 'Movement input timer stalled' }, { code: 'SHALLOW_MOVEMENT_FAILED', partialFailure: 'Too many movement ticks were missed' }, { legs: 8 }]) {
    const f = terminalWaterEpisode(t, 'safe', options)
    await f.begin()
    const status = f.safety.snapshot()
    assert.equal(f.attempts(), options.legs ?? 2, JSON.stringify(options))
    assert.equal(f.emergencies.length, 0, JSON.stringify(options))
    assert.equal(status.phase, 'escape_replan')
    assert.equal(status.running, true); assert.equal(status.busy, false); assert.equal(status.active, null); assert.equal(status.emergencySent, false)
    assert.equal(f.progress.some(value => value.phase === 'observing' && value.escapes > 0), false)
    assert.ok(Math.abs(status.lastWaterReplan.rawSwimProgress - 0.168) < 0.001)
    assert.ok(Math.abs(status.lastWaterReplan.nearestGain + 0.362) < 0.001)
    assert.ok(Math.abs(Math.hypot(f.state.rawServerPosition.x - 63.7994155884, f.state.rawServerPosition.z - 65.5253829956) - 1.648) < 0.001)
    await f.safety.stop()
  }
})

test('terminal water handoff refuses changed danger, unknown surface, damage and insufficient fresh progress', async t => {
  for (const mode of ['identity', 'runtime_id', 'primed', 'charged', 'too_close', 'raw_close', 'predicted_close', 'damage', 'unknown_actor', 'new_enemy', 'unknown_water', 'drift', 'inventory', 'no_net', 'latest_stale', 'latest_zero', 'clearance_loss', 'thrown_unsafe', 'unsupported', 'unsafe_result']) {
    const f = terminalWaterEpisode(t, mode)
    await f.begin()
    assert.equal(f.attempts(), ['no_net', 'clearance_loss'].includes(mode) ? 3 : 2, mode)
    assert.equal(f.emergencies.length, 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.progress.some(value => value.phase === 'escape_replan'), false, mode)
    await f.safety.stop()
  }
  for (const options of [{ code: 'SHALLOW_MOVEMENT_STOPPED' }, { code: 'SHALLOW_MOVEMENT_FAILED', partialFailure: 'unexpected failure' }]) {
    const f = terminalWaterEpisode(t, 'safe', options)
    await f.begin()
    assert.equal(f.emergencies.length, 1)
    assert.equal(f.progress.some(value => value.phase === 'escape_replan'), false)
    await f.safety.stop()
  }
})

test('a handed-off water episode must independently earn progress before another handoff', async t => {
  const f = terminalWaterEpisode(t)
  await f.begin()
  assert.equal(f.safety.snapshot().phase, 'escape_replan')
  assert.equal(f.attempts(), 2)
  assert.equal(f.calls.filter(call => call.type === 'escape').map(call => call.context.operationId).every(id => id === f.calls.find(call => call.type === 'escape').context.operationId), true)
  f.advance(501); await f.tick(); await f.safety.drain()
  assert.equal(f.attempts(), 3)
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.progress.filter(value => value.phase === 'escape_replan').length, 1)
  const operations = f.calls.filter(call => call.type === 'escape').map(call => call.context.operationId)
  assert.notEqual(operations[1], operations[2])
})

test('a closer water pursuer permits handoff with current eligibility and bounded cumulative clearance loss', async t => {
  // This case drives the fake clock and explicit ticks; an automatic tick
  // must not overwrite the handoff phase before its assertions run.
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['safe', 'stationary', 'approaching', 'small_total_gain', 'below_floor', 'identity', 'primed', 'stale']) {
    let attempts = 0
    const originClearance = mode === 'below_floor' ? 3.8 : mode === 'small_total_gain' ? 6.1 : 5.4
    const firstClearance = mode === 'below_floor' ? 4.35 : 6.15
    const finalClearance = mode === 'below_floor' ? 4.49 : mode === 'approaching' ? 6.05 : 6.3
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      attempts++
      state.position.z = attempts === 1 || mode === 'stationary' ? -0.85 : -1
      state.rawServerPosition = { ...state.position }
      if (attempts !== 2 || mode !== 'stale') state.rawServerPositionUpdatedAt++
      actors[0].position = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z + (attempts === 1 ? firstClearance : finalClearance) }
      if (attempts === 2 && mode === 'identity') actors[0].uniqueId = 'different'
      if (attempts === 2 && mode === 'primed') actors[0].primed = true
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', f.state.position.x, '9'), primed: false, charged: false, position: { x: f.state.position.x, y: f.state.position.y - 1.62, z: f.state.position.z + originClearance } })
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(attempts, 2, mode)
    const safe = ['safe', 'approaching', 'small_total_gain'].includes(mode)
    assert.equal(f.emergencies.length, safe ? 0 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.safety.snapshot().phase, safe ? 'escape_replan' : 'emergency_stopped', mode)
    if (mode === 'safe') { assert.ok(Math.abs(f.state.rawServerPosition.z - 0.5) === 1.5); assert.equal(f.safety.snapshot().busy, false) }
    await f.safety.stop()
  }
})

test('a known secondary creeper invalidating only the future water corridor earns a fresh guarded episode', async t => {
  for (const mode of ['safe', 'secondary_inside_floor', 'secondary_missing', 'secondary_identity', 'secondary_primed', 'new_actor', 'primary_approach', 'stationary', 'stale', 'damage', 'unknown_water', 'unknown_actor', 'drift']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts < 2, escape: (context, { state, actors }) => {
      attempts++
      state.position.z = attempts === 1 || mode === 'stationary' ? -0.85 : -1
      state.rawServerPosition = { ...state.position }
      if (attempts !== 2 || mode !== 'stale') state.rawServerPositionUpdatedAt++
      actors[0].position = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z + (attempts === 1 ? 6.15 : mode === 'primary_approach' ? 6.05 : 6.3) }
      if (attempts === 1) return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
      actors[1].position = { x: state.position.x - 6, y: state.position.y - 1.62, z: state.position.z + (mode === 'secondary_inside_floor' ? 4.9 : 6.1) }
      if (mode === 'secondary_identity') actors[1].uniqueId = 'different'
      if (mode === 'secondary_primed') actors[1].primed = true
      if (mode === 'secondary_missing') actors.splice(1, 1)
      if (mode === 'new_actor') actors.push({ ...f.enemy('creeper', 30, '12'), primed: false, charged: false })
      if (mode === 'unknown_actor') actors.push({ ...f.enemy('zombie', 3, '10'), positionKnown: false, position: null })
      if (mode === 'damage') state.health = 19
      if (mode === 'drift') state.position.y += 0.751
      throw Object.assign(new Error('Controlled descent actor or remaining path became unsafe'), { escapeDiagnostic: { reason: 'remaining_path_inside_floor', actorId: '11', actorName: 'minecraft:creeper', distance: 8.7068, pathDistance: 7.9514, floor: 8 } })
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', f.state.position.x, '9'), primed: false, charged: false, position: { x: f.state.position.x, y: f.state.position.y - 1.62, z: f.state.position.z + 5.4 } }, { ...f.enemy('creeper', f.state.position.x - 6, '11'), primed: false, charged: false, position: { x: f.state.position.x - 6, y: f.state.position.y - 1.62, z: f.state.position.z + 8.5 } })
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(attempts, 2, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.safety.snapshot().phase, mode === 'safe' ? 'escape_replan' : 'emergency_stopped', mode)
    if (mode === 'safe') {
      assert.equal(f.safety.snapshot().busy, false)
      assert.equal(f.safety.snapshot().lastEscapeDiagnostic.pathDistance, 7.9514)
      f.advance(501); await f.tick(); await f.safety.drain()
      assert.equal(attempts, 3)
      assert.equal(f.emergencies.length, 1)
      assert.notEqual(f.calls.filter(call => call.type === 'escape')[1].context.operationId, f.calls.filter(call => call.type === 'escape')[2].context.operationId)
    }
    await f.safety.stop()
  }
})

test('correction replans do not consume the separate budget for a previously known outside creeper entering danger', async t => {
  for (const mode of ['safe', 'identity', 'new_actor', 'damage', 'primed', 'charged', 'current_floor', 'unknown', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts < 3, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 4) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.z -= 0.4; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++
      actors[0].position = { x: state.position.x, y: state.position.y, z: state.position.z + (attempts === 1 ? 7.2 : attempts === 2 ? 7.4 : mode === 'current_floor' ? 5.9 : 7.4) }
      if (attempts < 3) return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
      actors[1].position = { x: state.position.x - 1, y: state.position.y, z: state.position.z + Math.sqrt(7.9 ** 2 - 1) }
      if (mode === 'identity') actors[1].uniqueId = 'different'
      if (mode === 'new_actor') actors[1].runtimeId = '12'
      if (mode === 'damage') state.health = 19
      if (mode === 'primed') actors[1].primed = true
      if (mode === 'charged') actors[1].charged = true
      if (mode === 'unknown') { actors[1].positionKnown = false; actors[1].position = null }
      throw new Error('Idle escape danger changed')
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', f.state.position.x, '9'), primed: false, charged: false, position: { x: f.state.position.x, y: f.state.position.y, z: f.state.position.z + 7 } }, { ...f.enemy('creeper', f.state.position.x - 1, '11'), primed: false, charged: false, position: { x: f.state.position.x - 1, y: f.state.position.y, z: f.state.position.z + 9 } })
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 4 : 3, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
    if (mode === 'safe') {
      const routes = f.calls.filter(call => call.type === 'escape')
      assert.equal(routes[3].context.threats.length, 2)
      assert.equal(routes[3].context.threats.find(actor => actor.runtimeId === '11').distance, 7.9)
      assert.equal(f.safety.snapshot().phase, 'observing')
    }
    await f.safety.stop()
  }
})

test('the actor-transition budget still stops after two retries independently of earlier corrections', async t => {
  let attempts = 0
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
    attempts++; state.position.z -= 0.4; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++
    actors[0].position = { x: state.position.x, y: state.position.y, z: state.position.z + (attempts === 1 ? 7.2 : 7.4) }
    if (attempts < 3) return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
    actors[1].position = { x: state.position.x - 1, y: state.position.y, z: state.position.z + Math.sqrt(7.9 ** 2 - 1) }
    throw new Error('Idle escape danger changed')
  } })
  f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
  f.actors.push({ ...f.enemy('creeper', f.state.position.x, '9'), primed: false, charged: false, position: { x: f.state.position.x, y: f.state.position.y, z: f.state.position.z + 7 } }, { ...f.enemy('creeper', f.state.position.x - 1, '11'), primed: false, charged: false, position: { x: f.state.position.x - 1, y: f.state.position.y, z: f.state.position.z + 9 } })
  f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.equal(attempts, 5)
  assert.equal(f.emergencies.length, 1)
})

test('a corrected shallow-water escape keeps observing when the same pursuer is outside danger', async t => {
  for (const mode of ['safe', 'missing', 'replacement', 'primed', 'stale', 'damage', 'water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'water' || attempts === 0, escape: (context, { state, actors }) => {
      attempts++; state.position.x += 1; state.rawServerPosition = { ...state.position }; if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'missing') actors.splice(0)
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'damage') state.health = 19
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1; f.actors.push(f.enemy('creeper', -7, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
    if (mode === 'safe') assert.equal(f.safety.snapshot().phase, 'observing')
  }
})

test('fresh current water safety permits stationary observation after both exact pursuers leave danger', async t => {
  for (const mode of ['safe', 'stale', 'future', 'unknown', 'missing', 'replacement', 'primed', 'charged', 'damage', 'water', 'drift', 'raw_inside', 'verify_change']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => {
      if (attempts && mode === 'verify_change') f.actors[0].uniqueId = 'changed_during_verification'
      return mode !== 'water' || attempts === 0
    }, escape: (context, { state, actors }) => {
      attempts++
      actors[0].position.x = -9.4; actors[1].position.x = -8.5
      if (mode === 'unknown') { actors[1].positionKnown = false; actors[1].position = null }
      if (mode === 'missing') actors.splice(1, 1)
      if (mode === 'replacement') actors[1].uniqueId = 'different'
      if (mode === 'primed') { actors[1].primed = true; actors[1].position.x = -15 }
      if (mode === 'charged') { actors[1].charged = true; actors[1].position.x = -18 }
      if (mode === 'damage') state.health = 19
      if (mode === 'drift') state.position.y += 0.751
      if (mode === 'raw_inside') { actors[1].position = { x: state.rawServerPosition.x - 7.9, y: state.rawServerPosition.y, z: state.rawServerPosition.z }; state.position.x += 0.6 }
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = mode === 'stale' ? -1 : mode === 'future' ? 1001 : 800
    f.actors.push({ ...f.enemy('creeper', -6.5, '9'), primed: false, charged: false }, { ...f.enemy('creeper', -7, '11'), primed: false, charged: false })
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(attempts, 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.safety.snapshot().phase, mode === 'safe' ? 'observing' : 'emergency_stopped', mode)
    if (mode === 'safe') {
      assert.equal(f.safety.snapshot().running, true); assert.equal(f.safety.snapshot().busy, false)
      assert.deepEqual(f.state.rawServerPosition, f.state.position)
      assert.equal(f.state.rawServerPositionUpdatedAt, 800)
    }
    await f.safety.stop()
  }
})

test('completed surface motion keeps observing only when the known pursuer remains outside danger', async t => {
  for (const mode of ['safe', 'missing', 'replacement', 'damage', 'water', 'drift', 'stale', 'new_enemy']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'water' || attempts === 0, escape: (context, { state, actors }) => {
      attempts++; state.position.x += mode === 'drift' ? 1.2 : 0.7
      if (mode !== 'drift') state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'missing') actors.splice(0)
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      if (mode === 'damage') state.health = 19
      if (mode === 'new_enemy') actors.push(f.enemy('zombie', 3, '10'))
      return { supported: true, arrived: false, escaped: false, serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -7, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    if (mode === 'safe') assert.equal(f.safety.snapshot().phase, 'observing')
  }
})

test('a longer corrected bank jump can finish settling after the known pursuer leaves danger', async t => {
  for (const mode of ['safe', 'vanished', 'blocked', 'damage']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: true, strike: () => ({}), strikeBodyReady: mode !== 'blocked', verifyShallowWater: state => state.predicted?.physicsState?.isInWater === true, escape: (context, { state, actors }) => {
      attempts++; state.position.x += 2; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = 2
      state.predicted.physicsState = { onGround: false, isInWater: false, isInLava: false, velocity: { x: 0, y: -0.1, z: 0 } }
      if (mode === 'safe') setTimeout(() => { state.predicted.physicsState.onGround = true }, 75)
      if (mode === 'vanished') actors.splice(0)
      if (mode === 'damage') state.health = 19
      return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1; f.actors.push(f.enemy('creeper', -6, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
    if (mode === 'safe') assert.equal(f.safety.snapshot().phase, 'observing')
  }
})

test('a water route invalidated by pursuing creepers replans only with safe actors and confirmed progress', async t => {
  for (const mode of ['safe', 'stale', 'no_progress', 'damage', 'identity', 'primed', 'close', 'unknown_water']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts === 0, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += mode === 'no_progress' ? 0 : 0.5
      state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'damage') state.health = 19
      if (mode === 'identity') actors[0].uniqueId = 'other'
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'close') actors[0].position.x += 2
      throw new Error('Shallow escape creeper horizontal distance became unsafe')
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -4.5, '9'), f.enemy('creeper', -5, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('a moved water pursuer may cause one replan without a fresh correction only while both observed poses are clear', async t => {
  for (const mode of ['safe', 'unchanged', 'close', 'primed', 'replacement', 'damage', 'raw_drift', 'new_actor']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
      if (++attempts === 2) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      if (mode !== 'unchanged') actors[0].position.x += mode === 'close' ? 2 : 0.2
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'replacement') actors[0].uniqueId = 'different'
      if (mode === 'damage') state.health = 19
      if (mode === 'raw_drift') state.rawServerPosition.x -= 2
      if (mode === 'new_actor') actors.push(f.enemy('zombie', 2, '25'))
      throw new Error('Shallow escape creeper horizontal distance became unsafe')
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('creeper', -5.35, '9'), f.enemy('creeper', -5.6, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('water corrections may continue after two replans only with repeated server-observed outward progress', async t => {
  let attempts = 0
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
    attempts++; state.position.x += 0.4; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++
    if (attempts === 4) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
    return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN', serverConfirmed: false }
  } })
  f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
  f.actors.push(f.enemy('creeper', -3, '9'), f.enemy('creeper', -4, '10'))
  await f.start(); await f.safety.drain()
  assert.equal(attempts, 4)
  assert.equal(f.emergencies.length, 0)
})

test('an undamaged pursuit can chain up to eight freshly checked escape segments', async t => {
  let attempts = 0
  const f = fixture(t, { escape: (context, { state, actors }) => {
    attempts++; state.position.x += 1; actors[0].position.x += 1
    if (attempts === 7) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
    return { supported: true, arrived: true, partialEscape: true }
  } })
  f.state.health = 7.631; f.actors.push(f.enemy('creeper', -6, '9'))
  f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); await f.safety.drain()
  assert.equal(attempts, 7)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'recovering')
})

test('a received partial water leg can resume moving away after earlier pursuit reduced the original clearance', async t => {
  for (const mode of ['safe', 'long_leg', 'too_long', 'approach', 'stale', 'primed', 'charged', 'identity', 'unknown', 'unknown_water', 'damage', 'drift', 'small_progress', 'unsupported', 'unsafe_result']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => mode !== 'unknown_water' || attempts < 3, escape: (context, { state, actors }) => {
      attempts++
      if (attempts === 4) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += attempts === 3 ? mode === 'small_progress' ? 0.249 : mode === 'long_leg' ? 2.4 : mode === 'too_long' ? 4.501 : 0.4 : 0.4
      state.rawServerPosition = { ...state.position }
      if (attempts !== 3 || mode !== 'stale') state.rawServerPositionUpdatedAt++
      const clearance = attempts === 1 ? 7.2 : attempts === 2 ? 6.8 : mode === 'approach' ? 6.6 : 6.95
      actors[0].position = { x: state.position.x - clearance, y: state.position.y, z: state.position.z }
      if (attempts < 3) return { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' }
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'charged') actors[0].charged = true
      if (mode === 'identity') actors[0].uniqueId = 'different'
      if (mode === 'unknown') actors.push({ ...f.enemy('zombie', 3, '10'), positionKnown: false, position: null })
      if (mode === 'damage') state.health = 19
      if (mode === 'drift') state.position.y += 0.751
      return { supported: mode !== 'unsupported', arrived: true, partialEscape: true, ...(mode === 'unsafe_result' ? { routeInterruption: { reason: 'The remaining escape route no longer leads away from current danger' } } : {}) }
    } })
    f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
    f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push({ ...f.enemy('creeper', f.state.position.x - 7.6, '9'), position: { x: f.state.position.x - 7.6, y: f.state.position.y, z: f.state.position.z }, primed: false, charged: false })
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    const safe = ['safe', 'long_leg'].includes(mode)
    assert.equal(attempts, safe ? 4 : 3, `${mode}: ${JSON.stringify(f.safety.snapshot())}`)
    assert.equal(f.emergencies.length, safe ? 0 : 1, mode)
    if (safe) assert.equal(f.safety.snapshot().phase, 'observing')
    await f.safety.stop()
  }
})

test('successful partial water legs retain the eight-action cap before the existing guarded handoff', async t => {
  let attempts = 0
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: (context, { state, actors }) => {
    attempts++; state.position.x += 0.4; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt++
    const clearance = attempts <= 2 ? 7.6 - attempts * 0.4 : 6.8 + (attempts - 2) * 0.11
    actors[0].position = { x: state.position.x - clearance, y: state.position.y, z: state.position.z }
    return attempts <= 2 ? { supported: true, arrived: false, code: 'SHALLOW_CORRECTION_REPLAN' } : { supported: true, arrived: true, partialEscape: true }
  } })
  f.state.heldItem = null; f.state.inventory.items = []; f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
  f.actors.push({ ...f.enemy('creeper', f.state.position.x - 7.6, '9'), position: { x: f.state.position.x - 7.6, y: f.state.position.y, z: f.state.position.z }, primed: false, charged: false })
  f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.equal(attempts, 8)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'escape_replan')
  assert.equal(f.safety.snapshot().busy, false)
})

test('a previously observed outside skeleton can be tracked after a constrained partial escape', async t => {
  let attempts = 0
  const f = fixture(t, { escape: (context, { state, actors }) => {
    attempts++; state.position.x += 1
    if (attempts === 2) { actors.splice(0); return { supported: true, escaped: true, arrived: true } }
    return { supported: true, arrived: true, partialEscape: true, constrainedEscape: true, constrainedPrimaryId: '9' }
  } })
  f.state.health = 10.631; f.actors.push(f.enemy('zombie', -6, '9'), f.enemy('spider', -8.5, '10'), f.enemy('skeleton', 25, '11'))
  f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
  assert.equal(attempts, 2)
  assert.equal(f.emergencies.length, 0)
})

test('escape replans only for the same previously observed distant ranged enemy', async t => {
  for (const mode of ['safe', 'unseen', 'replacement', 'close', 'damage']) {
    let attempts = 0
    const f = fixture(t, { actionTimeoutMs: 500, escape: (context, { state, actors }) => {
      attempts++
      if (attempts > 1) { state.position.x += 1; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        setTimeout(() => {
          const skeleton = actors.find(actor => actor.runtimeId === '10')
          if (mode === 'unseen') actors.push(f.enemy('skeleton', 22, '10'))
          else { skeleton.position.x = mode === 'close' ? 10 : 22; if (mode === 'replacement') skeleton.uniqueId = '99' }
          if (mode === 'damage') state.health--
        }, 5)
      })
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', -8)); if (mode !== 'unseen') f.actors.push(f.enemy('skeleton', 27, '10'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('an interrupted escape replans for the same moved enemy only with safe fresh state', async t => {
  for (const mode of ['safe', 'unmoved', 'damage', 'close', 'replacement']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      if (++attempts > 1) { state.position.x += 1; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      if (mode !== 'unmoved') actors[0].position.x += mode === 'close' ? 6 : 0.3
      if (mode === 'damage') state.health--
      if (mode === 'replacement') actors[0].uniqueId = 'replacement'
      return { supported: true, code: 'RETREAT_BLOCKED', routeInterruption: { reason: 'The remaining escape route no longer leads away from current danger' } }
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', -8)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'safe' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('an escape error rechecks a moved known enemy or resumes recovery if danger cleared', async t => {
  for (const mode of ['moved', 'cleared', 'unchanged', 'damage', 'replacement']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      if (++attempts > 1) { state.position.x += 1; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      if (mode === 'cleared') actors.splice(0)
      else if (mode !== 'unchanged') actors[0].position.x += 0.3
      if (mode === 'damage') state.health--
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      throw new Error('Idle escape remaining path danger changed')
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', -8)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'moved' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, ['moved', 'cleared'].includes(mode) ? 0 : 1, mode)
  }
})

test('a failed route can be replanned for a moved known creeper only outside its immediate reach', async t => {
  for (const mode of ['moved', 'unchanged', 'close', 'primed', 'replacement']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      if (++attempts > 1) { state.position.x -= 1; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      if (mode !== 'unchanged') actors[0].position.x = mode === 'close' ? 4 : 6.8
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      return { supported: false, reason: 'no_known_away_route' }
    } })
    f.state.health = 10; f.actors.push(f.enemy('creeper', 7)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'moved' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'moved' ? 0 : 1, mode)
  }
})

test('a single moved creeper can be replanned at low health only while identity, distance and health remain valid', async t => {
  for (const mode of ['moved', 'error', 'unmoved', 'close', 'primed', 'replacement', 'damage', 'new_enemy']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      if (++attempts > 1) { state.position.x -= 1; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      if (mode !== 'unmoved') actors[0].position.x = mode === 'close' ? 3.5 : 5.3
      if (mode === 'primed') actors[0].primed = true
      if (mode === 'replacement') actors[0].uniqueId = 'other'
      if (mode === 'damage') state.health--
      if (mode === 'new_enemy') actors.push(f.enemy('zombie', -3, '10'))
      if (mode === 'error') throw new Error('Idle escape remaining path danger changed')
      return { supported: false, reason: 'no_known_away_route' }
    } })
    f.state.health = 9.631; f.actors.push(f.enemy('creeper', 5.8)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, ['moved', 'error'].includes(mode) ? 2 : 1, mode)
    assert.equal(f.emergencies.length, ['moved', 'error'].includes(mode) ? 0 : 1, mode)
  }
})

test('one close zombie can be struck once while an identified second zombie remains distant', async t => {
  for (const mode of ['ready', 'near', 'unknown', 'low_health', 'different_enemy']) {
    const f = fixture(t, { strike: () => ({}), emergencyStrike: (id, context, { actors }) => { actors.splice(actors.findIndex(actor => actor.runtimeId === id), 1); return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = mode === 'low_health' ? 9.631 : 12.631
    f.actors.push(f.enemy('zombie', 2, '9'), f.enemy(mode === 'different_enemy' ? 'creeper' : 'zombie', mode === 'near' ? 6 : 8.5, '10'))
    if (mode === 'unknown') f.actors[1].uniqueId = null
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    const strikes = f.calls.filter(call => call.type === 'emergency_strike')
    assert.equal(strikes.length, mode === 'ready' ? 1 : 0, JSON.stringify({ mode, calls: f.calls, status: f.safety.snapshot() }))
    if (mode === 'ready') assert.equal(strikes[0].context.allowDistantZombie, true)
  }
})

test('a single emergency strike monitors every identified secondary enemy', async t => {
  for (const mode of ['ready', 'spider_close', 'witch_close', 'unknown', 'creeper', 'low_health', 'extra']) {
    const f = fixture(t, { strike: () => ({}), emergencyStrike: (id, context, { actors }) => { actors.splice(actors.findIndex(actor => actor.runtimeId === id), 1); return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = mode === 'low_health' ? 10 : 12.631
    f.actors.push(f.enemy('zombie', 2, '9'), f.enemy('zombie', 10, '10'), f.enemy(mode === 'creeper' ? 'creeper' : 'spider', mode === 'spider_close' ? 6 : mode === 'creeper' ? 7 : 8.5, '11'), f.enemy('witch', mode === 'witch_close' ? 17 : 19, '12'))
    if (mode === 'unknown') f.actors[1].uniqueId = null
    if (mode === 'extra') f.actors.push(f.enemy('skeleton', 20, '13'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); await f.safety.drain()
    const strikes = f.calls.filter(call => call.type === 'emergency_strike')
    assert.equal(strikes.length, mode === 'ready' ? 1 : 0, mode)
    if (mode === 'ready') assert.equal(strikes[0].context.allowGuardedGroup, true)
  }
})

test('a close spider can receive one guarded strike with a distant zombie', async t => {
  for (const mode of ['ready', 'zombie_close', 'low_health', 'replacement', 'creeper']) {
    const f = fixture(t, { strike: () => ({}), emergencyStrike: (id, context, { actors }) => { actors.splice(actors.findIndex(actor => actor.runtimeId === id), 1); return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = mode === 'low_health' ? 10 : 10.631
    f.actors.push(f.enemy('spider', 2, '9'), f.enemy('zombie', mode === 'zombie_close' ? 6 : 11, '10'))
    if (mode === 'replacement') f.actors[1].uniqueId = null
    if (mode === 'creeper') f.actors.push(f.enemy('creeper', 5, '11'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); await f.safety.drain()
    const strikes = f.calls.filter(call => call.type === 'emergency_strike')
    assert.equal(strikes.length, mode === 'ready' ? 1 : 0, mode)
    if (mode === 'ready') { assert.equal(strikes[0].id, '9'); assert.equal(strikes[0].context.allowDistantZombie, true) }
  }
})

test('critical health permits one immediate strike with verified ground or controlled falling body', async t => {
  for (const mode of ['ready', 'falling', 'airborne', 'fast_fall', 'rising', 'support_unknown', 'close_skeleton', 'creeper', 'damage']) {
    const f = fixture(t, { strike: () => ({}), verifyMeleeBody: () => mode !== 'support_unknown', emergencyStrike: (id, context, { state }) => { if (mode === 'damage') state.health--; return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = 4.631; f.state.predicted.physicsState.onGround = !['airborne', 'falling', 'fast_fall', 'rising'].includes(mode)
    if (mode === 'falling') f.state.predicted.physicsState.velocity = { x: 0, y: -0.08, z: 0 }
    if (mode === 'fast_fall') f.state.predicted.physicsState.velocity = { x: 0, y: -0.41, z: 0 }
    if (mode === 'rising') f.state.predicted.physicsState.velocity = { x: 0, y: 0.1, z: 0 }
    f.actors.push(f.enemy('zombie', 2, '9'), f.enemy(mode === 'creeper' ? 'creeper' : 'skeleton', mode === 'close_skeleton' ? 19 : mode === 'creeper' ? 6 : 23, '10'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); await f.safety.drain()
    const strikes = f.calls.filter(call => call.type === 'emergency_strike')
    assert.equal(strikes.length, ['ready', 'falling', 'damage'].includes(mode) ? 1 : 0, mode)
    if (strikes.length) assert.equal(strikes[0].context.allowCritical, true)
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('healthy unarmed emergency defense commits one exact zombie engagement only with known support', async t => {
  for (const mode of ['ready', 'low_health', 'extra', 'inventory', 'support', 'creeper']) {
    const f = fixture(t, { bodyReady: mode !== 'support', verifyMeleeBody: () => mode !== 'support', strike: (id, context, { actors }) => { actors.splice(0); return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = mode === 'low_health' ? 17 : 20; f.state.inventory.items = []; f.state.heldItem = null
    f.actors.push(f.enemy(mode === 'creeper' ? 'creeper' : 'zombie', 2, '9'))
    if (mode === 'extra') f.actors.push(f.enemy('spider', 4, '10'))
    if (mode === 'inventory') f.state.inventory.known = false
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    const engagements = f.calls.filter(call => call.type === 'engage')
    assert.equal(engagements.length, mode === 'ready' ? 1 : 0, mode)
    if (engagements.length) { assert.equal(engagements[0].context.allowUnarmed, true); assert.equal(engagements[0].context.maxHits, 24); assert.equal(engagements[0].context.durationMs, 30000) }
    assert.equal(f.emergencies.length, mode === 'ready' ? 0 : 1, mode)
  }
})

test('the committed unarmed monitor keeps normal damage latched through a known airborne body and clears only observed defeat', async t => {
  for (const mode of ['removed', 'unconfirmed', 'health_six', 'body', 'water', 'hand', 'new_actor']) {
    const body = { known: true }; let finish
    const f = fixture(t, {
      verifyBody: observed => body.known && observed.predicted.physicsState.onGround === true,
      verifyMeleeBody: observed => body.known && observed.predicted.physicsState.onGround === true,
      verifyStrikeBody: () => body.known,
      strike: () => { throw new Error('Committed single-zombie defense must not call one-shot strike') },
      engage: (id, context) => new Promise((resolve, reject) => {
        finish = resolve
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      })
    })
    f.state.inventory.items = []; f.state.heldItem = null; f.actors.push(f.enemy('zombie', 2, '9'))
    f.safety.start({ enableEpoch: 1 }); const episode = f.tick()
    for (let n = 0; n < 30 && !finish; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(typeof finish, 'function', mode)
    f.state.health = 17; f.state.predicted.physicsState.onGround = false; f.state.predicted.physicsState.velocity = { x: -0.12, y: 0.24, z: 0 }
    await new Promise(resolve => setTimeout(resolve, 45))
    assert.equal(f.safety.snapshot().active, 'engage', mode)
    assert.equal(f.emergencies.length, 0, 'HP17 and bounded known air retain the exact committed fight')
    if (mode === 'health_six') f.state.health = 6
    if (mode === 'body') body.known = false
    if (mode === 'water') f.state.predicted.physicsState.isInWater = true
    if (mode === 'hand') { f.state.inventory.items = [{ slot: 0, name: 'minecraft:dirt', count: 1 }]; f.state.heldItem = { ...f.state.inventory.items[0] } }
    if (mode === 'new_actor') f.actors.push(f.enemy('creeper', 3, '10'))
    if (['removed', 'unconfirmed'].includes(mode)) {
      f.actors.splice(0); f.state.predicted.physicsState.onGround = true
      finish({ phase: 'observed', reaction: 'target_removed', targetStopped: mode === 'removed', serverConfirmed: mode === 'removed', hitsRequested: 6 })
    }
    await episode; await f.safety.drain()
    assert.equal(f.emergencies.length, mode === 'removed' ? 0 : 1, mode)
    if (mode === 'removed') {
      assert.equal(f.safety.snapshot().lastDefense.action, 'unarmed_engage')
      assert.equal(f.safety.snapshot().phase, 'observing')
      await f.tick()
      assert.equal(f.emergencies.length, 0, 'only confirmed defeat with fresh threat-free body clears the damage latch')
    }
  }
})

test('unarmed defense strikes only an already-close, confirmed drowned and never waits for a ranged approach', async t => {
  for (const mode of ['ready', 'distant', 'no_line_of_sight', 'other_threat', 'health', 'missing_id']) {
    const f = fixture(t, { verifyMeleeBody: () => true, strikeReady: mode !== 'no_line_of_sight', strike: (id, context, { actors }) => { actors.splice(0); return { phase: 'observed', reaction: 'hurt_animation' } } })
    f.state.health = mode === 'health' ? 17 : 20; f.state.inventory.items = []; f.state.heldItem = null
    f.actors.push(f.enemy('drowned', mode === 'distant' ? 8 : 2, '9'))
    if (mode === 'other_threat') f.actors.push(f.enemy('skeleton', 16.5, '10'))
    if (mode === 'missing_id') f.actors[0].uniqueId = null
    await f.start(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'strike').length, mode === 'ready' ? 1 : 0, mode)
    assert.equal(f.emergencies.length, mode === 'ready' ? 0 : 1, mode)
  }
})

test('the already-close unarmed drowned fallback keeps its bounded strikes and first-damage stop', async t => {
  for (const mode of ['sixth_removed', 'limit', 'damage', 'replacement', 'new_enemy']) {
    let strikes = 0
    const f = fixture(t, { verifyMeleeBody: () => true, strike: (id, context, { state, actors }) => {
      strikes++
      if (mode === 'sixth_removed' && strikes === 6) actors.splice(0)
      if (mode === 'damage') state.health--
      if (mode === 'replacement') actors[0].uniqueId = 'different'
      if (mode === 'new_enemy') actors.push(f.enemy('creeper', 4, '10'))
      return { phase: 'observed', reaction: 'hurt_animation' }
    } })
    f.state.health = 20; f.state.inventory.items = []; f.state.heldItem = null; f.actors.push(f.enemy('drowned', 2, '9'))
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(strikes, mode === 'sixth_removed' ? 6 : mode === 'limit' ? 24 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'sixth_removed' ? 0 : 1, mode)
  }
})

test('healthy bootstrap defense can monitor one ranged enemy while holding rotten flesh', async t => {
  for (const mode of ['ready', 'ranged_close', 'extra', 'wrong_hand', 'missing_id']) {
    const f = fixture(t, { verifyMeleeBody: () => true, strike: () => ({ phase: 'observed', reaction: 'hurt_animation' }) })
    f.state.health = 20
    f.state.inventory.items = [{ slot: 0, name: mode === 'wrong_hand' ? 'minecraft:dirt' : 'minecraft:rotten_flesh', count: 1 }]; f.state.heldItem = { ...f.state.inventory.items[0] }
    f.actors.push(f.enemy('zombie', 2, '9'), f.enemy('skeleton', mode === 'ranged_close' ? 15 : 16.5, '10'))
    if (mode === 'extra') f.actors.push(f.enemy('creeper', 5, '11'))
    if (mode === 'missing_id') f.actors[1].uniqueId = null
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'strike').length, mode === 'ready' ? 24 : 0, mode)
  }
})

test('unarmed defense with a distant skeleton waits only for an in-range attack cooldown', async t => {
  let strikes = 0; let previews = 0
  const f = fixture(t, { verifyMeleeBody: () => true, strikePreview: () => ({ ready: true, cooldownRemainingMs: ++previews === 2 ? 50 : 0 }), strike: (id, context, { actors }) => { if (++strikes === 2) actors.splice(actors.findIndex(actor => actor.runtimeId === id), 1); return { phase: 'observed', reaction: 'hurt_animation' } } })
  f.state.health = 20; f.state.inventory.items = []; f.state.heldItem = null
  f.actors.push(f.enemy('zombie', 2, '9'), f.enemy('skeleton', 16.5, '10'))
  f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.equal(strikes, 2)
  assert.ok(previews >= 3)
})

test('an imminent unprimed creeper may receive one guarded emergency strike before retreat', async t => {
  for (const mode of ['ready', 'primed', 'charged', 'extra', 'low_health', 'unarmed', 'airborne', 'no_support', 'unknown']) {
    const f = fixture(t, { strike: () => ({}), verifyMeleeBody: () => mode !== 'no_support', emergencyStrike: () => ({ phase: 'observed', reaction: 'hurt_animation' }) })
    f.state.health = mode === 'low_health' ? 6 : 7.631; f.actors.push(f.enemy('creeper', 2.5, '9'))
    if (mode === 'primed') f.actors[0].primed = true
    if (mode === 'charged') f.actors[0].charged = true
    if (mode === 'extra') f.actors.push(f.enemy('zombie', 4, '10'))
    if (mode === 'unarmed') { f.state.inventory.items = []; f.state.heldItem = null }
    if (mode === 'airborne') f.state.predicted.physicsState.onGround = false
    if (mode === 'unknown') f.actors[0].positionKnown = false
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    const strikes = f.calls.filter(call => call.type === 'emergency_strike')
    assert.equal(strikes.length, mode === 'ready' ? 1 : 0, mode)
    if (strikes.length) assert.equal(strikes[0].context.allowEmergencyCreeper, true)
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('one confirmed emergency leaf clearance permits a fresh escape; danger or unconfirmed clearance does not', async t => {
  for (const mode of ['confirmed', 'unconfirmed', 'closing', 'damage']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      if (++attempts > 1) { state.position.x -= 2; actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      return { supported: false, reason: 'no_known_away_route' }
    }, clearEscape: (context, { state, actors }) => {
      if (mode === 'confirmed' || mode === 'unconfirmed') return { cleared: true, serverConfirmed: mode === 'confirmed' }
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        setTimeout(() => { if (mode === 'closing') actors[0].position.x = 4; else state.health-- }, 5)
      })
    } })
    f.state.health = 9.6; f.actors.push(f.enemy('creeper', 7)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'clear_escape').length, 1, mode)
    assert.equal(attempts, mode === 'confirmed' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'confirmed' ? 0 : 1, mode)
  }
})

test('known closed usable refuge and death need no idle action, even with low health and a nearby enemy', async t => {
  for (const dead of [false, true]) {
    const f = fixture(t); f.cover(); f.state.health = dead ? 0 : 3; f.state.dead = dead; f.actors.push(f.enemy('skeleton'))
    await f.start(); f.advance(1000); await f.tick()
    assert.equal(f.calls.some(call => ['equip', 'engage', 'escape'].includes(call.type)), false)
    assert.equal(f.emergencies.length, 0)
  }
})

test('idle defense accepts a matching resent sword selection without treating another stack as ready', async t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t, { equipSword: (context, { state }) => {
      const item = state.inventory.items[0]
      return { phase: 'completed', sourceSlot: item.slot, slot: item.slot, selectionSent: true, serverConfirmed: false, selectedItem: { ...item, stackId: item.stackId + Number(corrupt) } }
    } })
    Object.assign(f.state.inventory.items[0], { networkId: 300, stackId: 90, metadata: 0 })
    f.state.heldItem = { ...f.state.inventory.items[0] }
    await f.start(); f.actors.push(f.enemy()); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.some(call => call.type === 'engage'), !corrupt)
  }
})

test('a single known close melee enemy uses confirmed sword, closed GUI and exact bounded oracle defense', async t => {
  const f = fixture(t); await f.start(); f.state.crafting.openContainer = { windowId: 7 }; f.actors.push(f.enemy())
  await f.tick()
  const action = f.calls.filter(call => ['equip', 'close_gui', 'preview', 'engage'].includes(call.type))
  assert.deepEqual(action.map(call => call.type), ['equip', 'close_gui', 'preview', 'engage'])
  assert.equal(action.at(-1).id, '9')
  assert.equal(action.at(-1).context.durationMs, 5500)
  assert.equal(action.at(-1).context.maxHits, 8)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().lastResult.enemyDefeated, null)
  assert.equal(f.safety.snapshot().defenses, 1)
})

test('defense outcome remains visible after a subsequent failed escape', async t => {
  const f = fixture(t, { engage: () => ({ phase: 'stopped', code: 'duration_limit', hitsRequested: 2, serverConfirmed: false }), escape: () => ({ supported: false, reason: 'no_known_away_route' }) })
  await f.start(); f.actors.push(f.enemy()); await f.tick()
  assert.equal(f.safety.snapshot().lastResult.action, 'escape')
  assert.equal(f.safety.snapshot().lastDefense.code, 'duration_limit')
  assert.equal(f.safety.snapshot().lastDefense.hitsRequested, 2)
  assert.equal(f.safety.snapshot().lastDefense.enemyDefeated, null)
})

test('defense retains a bounded diagnostic for interrupted line of sight', async t => {
  const f = fixture(t, { engage: () => ({ phase: 'stopped', code: 'unsafe_observation', reason: '対象への視線が遮られているか、地形が不明です。', hitsRequested: 1 }), escape: () => ({ supported: false }) })
  await f.start(); f.actors.push(f.enemy()); await f.tick()
  assert.equal(f.safety.snapshot().lastDefense.reasonCode, 'SIGHT')
  assert.equal(f.safety.snapshot().lastDefense.hitsRequested, 1)
})

test('ongoing engagement may retain proven partial support, but stops if support is unproven', async t => {
  for (const supported of [true, false]) {
    let full = true
    const f = fixture(t, {
      actionTimeoutMs: 500,
      verifyBody: () => full,
      verifyMeleeBody: () => supported,
      engage: async (id, context, { actors }) => {
        full = false
        await new Promise(resolve => setTimeout(resolve, 70))
        if (!context.signal.aborted) actors.splice(0)
        return { phase: 'observed', serverConfirmed: !context.signal.aborted }
      }
    })
    await f.start(); f.actors.push(f.enemy()); await f.tick(); await f.safety.drain()
    assert.ok(f.calls.some(call => call.type === 'melee_body'))
    assert.equal(f.emergencies.length, supported ? 0 : 1)
  }
})

test('known partial support permits stationary defense but not escape movement', async t => {
  const defended = fixture(t, { bodyReady: false, verifyMeleeBody: () => true })
  await defended.start(); defended.actors.push(defended.enemy()); await defended.tick()
  assert.equal(defended.calls.filter(call => call.type === 'engage').length, 1)
  assert.equal(defended.emergencies.length, 0)
  const trapped = fixture(t, { bodyReady: false, verifyMeleeBody: () => true, previewReady: false, escape: () => ({ supported: true }) })
  await trapped.start(); trapped.actors.push(trapped.enemy()); await trapped.tick()
  assert.equal(trapped.calls.filter(call => call.type === 'escape').length, 0)
  assert.equal(trapped.emergencies.length, 1)
})

test('partial ledge recovery needs a dedicated supported escape implementation', async t => {
  for (const mode of ['supported', 'unknown', 'airborne']) {
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => mode !== 'unknown', partialEscape: (context, { actors }) => { actors.splice(0); return { supported: true, arrived: true, escaped: true } } })
    await f.start(); f.actors.push(f.enemy('creeper')); if (mode === 'airborne') f.state.predicted.physicsState.onGround = false
    await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'partial_escape').length, mode === 'supported' ? 1 : 0, mode)
    assert.equal(f.emergencies.length, mode === 'supported' ? 0 : 1, mode)
  }
})

test('partial escape retries a correction or timer stall only after a fresh bounded server pose and no new danger', async t => {
  for (const mode of ['fresh', 'airborne', 'stale', 'damage', 'replacement', 'stall_fresh', 'stall_stale']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => true, strike: () => ({}), partialEscape: (context, { state, actors }) => {
      attempts++
      if (attempts > 1) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 0.05; state.rawServerPosition = { ...state.position }; if (!['stale', 'stall_stale'].includes(mode)) state.rawServerPositionUpdatedAt = 2
      if (mode === 'damage') state.health--
      if (mode === 'replacement') actors[0].uniqueId = 'different'
      if (mode === 'airborne') { state.predicted.physicsState.onGround = false; setTimeout(() => { state.predicted.physicsState.onGround = true }, 35) }
      return { supported: true, arrived: false, code: mode.startsWith('stall_') ? 'PARTIAL_STALLED' : 'PARTIAL_REPLAN' }
    } })
    f.state.health = 10; f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1; f.actors.push(f.enemy('zombie', 7))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, ['fresh', 'airborne', 'stall_fresh'].includes(mode) ? 2 : 1, mode)
    assert.equal(f.emergencies.length, ['fresh', 'airborne', 'stall_fresh'].includes(mode) ? 0 : 1, mode)
  }
})

test('a previously identified drowned entering its danger radius can trigger a bounded replan with the same spider', async t => {
  for (const mode of ['known', 'replaced', 'too_close', 'damage', 'unseen']) {
    let attempts = 0
    const f = fixture(t, { escape: (context, { state, actors }) => {
      attempts++
      if (attempts > 1) { actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      const drowned = actors.find(a => a.entityType === 'minecraft:drowned')
      if (mode === 'unseen') actors.push(f.enemy('drowned', 13, '11'))
      else { drowned.position.x = mode === 'too_close' ? 10 : 13; if (mode === 'replaced') drowned.uniqueId = 'replacement' }
      if (mode === 'damage') state.health--
      throw new Error('Idle escape danger changed')
    } })
    f.state.threatPolicy = 'balanced_mining'
    f.actors.push(f.enemy('spider', 8, '9'))
    if (mode !== 'unseen') f.actors.push(f.enemy('drowned', 16, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('a changed known spider position can replan a dry ledge retreat without yielding safety ownership', async t => {
  for (const mode of ['known', 'replacement', 'close', 'damage', 'wet', 'unsupported']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => false, verifyLedgeBody: () => mode !== 'unsupported', partialEscape: (context, { state, actors }) => {
      if (++attempts > 1) { actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      actors[0].position.x = mode === 'close' ? 3 : 10.5
      if (mode === 'replacement') actors[0].uniqueId = 'replacement'
      if (mode === 'damage') state.health--
      if (mode === 'wet') state.predicted.physicsState.isInWater = true
      throw new Error('Partial escape actor approached distance floor')
    } })
    f.actors.push(f.enemy('spider', 11, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : mode === 'unsupported' ? 0 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('a vanished actor keeps a dry ledge session online only after fresh safe observations', async t => {
  for (const mode of ['clear', 'other_threat', 'unknown', 'damage', 'wet', 'unsupported']) {
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => false, verifyLedgeBody: () => mode !== 'unsupported', partialEscape: (context, { state, actors }) => {
      actors.splice(0)
      if (mode === 'other_threat') actors.push(f.enemy('creeper', 3, '10'))
      if (mode === 'unknown') actors.push({ ...f.enemy('spider', 3, '10'), positionKnown: false, position: null })
      if (mode === 'damage') state.health--
      if (mode === 'wet') state.predicted.physicsState.isInWater = true
      throw new Error('Partial escape actor no longer observed')
    } })
    f.actors.push(f.enemy('spider', 11, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(f.emergencies.length, mode === 'clear' ? 0 : 1, mode)
    if (mode === 'clear') assert.equal(f.safety.snapshot().running, true)
  }
})

test('an unstarted failed escape may resume observation when the threat leaves and the pose remains supported', async t => {
  for (const mode of ['clear', 'moved', 'new_threat', 'unknown', 'damage', 'wet', 'unsupported']) {
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => false, verifyLedgeBody: () => mode !== 'unsupported', partialEscape: (context, { state, actors }) => {
      actors.splice(0)
      if (mode === 'moved') state.position.x += 0.1
      if (mode === 'new_threat') actors.push(f.enemy('creeper', 3, '10'))
      if (mode === 'unknown') actors.push({ ...f.enemy('spider', 3, '10'), positionKnown: false, position: null })
      if (mode === 'damage') state.health--
      if (mode === 'wet') state.predicted.physicsState.isInWater = true
      return { supported: false, reason: 'no_known_away_route' }
    } })
    f.actors.push(f.enemy('spider', 11, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(f.emergencies.length, mode === 'clear' ? 0 : 1, mode)
    if (mode === 'clear') assert.equal(f.safety.snapshot().running, true)
  }
})

test('a previously seen second spider crossing the danger boundary permits a freshly checked ledge replan', async t => {
  for (const mode of ['known', 'unseen', 'replacement', 'close', 'damage']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => false, verifyLedgeBody: () => true, partialEscape: (context, { state, actors }) => {
      if (++attempts > 1) { actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      if (mode === 'unseen') actors.push(f.enemy('spider', 11, '10'))
      else { const actor = actors.find(a => a.runtimeId === '10'); actor.position.x = mode === 'close' ? 4 : 11; if (mode === 'replacement') actor.uniqueId = 'other' }
      if (mode === 'damage') state.health--
      throw new Error('Partial escape danger changed')
    } })
    f.actors.push(f.enemy('spider', 10, '9'))
    if (mode !== 'unseen') f.actors.push(f.enemy('spider', 15, '10'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('a changed known creeper can trigger a shallow-water replan only with current safe evidence', async t => {
  for (const mode of ['known', 'replacement', 'close', 'damage', 'unsafe_water', 'new_enemy']) {
    let attempts = 0; let waterSafe = true
    const f = fixture(t, { bodyReady: false, verifyShallowWater: () => waterSafe, escape: (context, { state, actors }) => {
      if (++attempts > 1) { actors.splice(0); return { supported: true, escaped: true, arrived: true } }
      actors[0].position.x = mode === 'close' ? 3 : 7.2
      if (mode === 'replacement') actors[0].uniqueId = 'replacement'
      if (mode === 'damage') state.health--
      if (mode === 'unsafe_water') waterSafe = false
      if (mode === 'new_enemy') actors.push(f.enemy('spider', 2, '11'))
      throw new Error('Controlled descent actor or remaining path became unsafe')
    } })
    f.state.predicted.physicsState.onGround = false; f.state.predicted.physicsState.isInWater = true
    f.actors.push(f.enemy('creeper', 7.6, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('escape corridor diagnostics survive cleanup without authorizing movement', async t => {
  const diagnostic = { reason: 'remaining_path_inside_floor', actorId: '9', actorName: 'minecraft:creeper', distance: 5, pathDistance: 4.7, floor: 4.8 }
  const f = fixture(t, { bodyReady: false, verifyShallowWater: () => true, escape: () => { throw Object.assign(new Error('Controlled descent actor or remaining path became unsafe'), { escapeDiagnostic: diagnostic }) } })
  f.state.predicted.physicsState = { onGround: false, isInWater: true, isInLava: false }
  f.actors.push(f.enemy('creeper', -4, '9'))
  await f.start(); await f.safety.drain()
  assert.deepEqual(f.safety.snapshot().lastEscapeDiagnostic, diagnostic)
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.calls.filter(call => call.type === 'escape').length, 1)
})

test('an airborne healthy player waits for verified landing only when a known drowned remains outside the distance floor', async t => {
  for (const mode of ['safe', 'too_close', 'health']) {
    const f = fixture(t, { verifyMeleeBody: () => true, strike: () => ({}), escape: (context, { actors }) => { actors.splice(0); return { supported: true, escaped: true, arrived: true } } })
    f.state.threatPolicy = 'balanced_mining'; f.state.predicted.physicsState.onGround = false; if (mode === 'health') f.state.health = 17
    f.actors.push(f.enemy('drowned', mode === 'too_close' ? 10.4 : 10.8, '9'))
    f.safety.start({ enableEpoch: 1 }); await f.tick(); f.advance(501)
    setTimeout(() => { f.state.predicted.physicsState.onGround = true }, 30)
    await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, mode === 'safe' ? 1 : 0, mode)
    assert.equal(f.emergencies.length, mode === 'safe' ? 0 : 1, mode)
  }
})

test('a partial correction may resume recovery after danger clears and support is verified', async t => {
  for (const mode of ['supported', 'landing', 'unknown', 'damage']) {
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => true, strike: () => ({}), partialEscape: (context, { state, actors }) => {
      actors.splice(0)
      if (mode === 'landing') { state.predicted.physicsState.onGround = false; setTimeout(() => { state.predicted.physicsState.onGround = true }, 35) }
      if (mode === 'damage') state.health--
      if (mode === 'unknown') actors.push({ ...f.enemy('zombie', 5, '10'), positionKnown: false, position: null })
      return { supported: true, arrived: false, code: 'PARTIAL_REPLAN' }
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', 7)); f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(f.emergencies.length, ['supported', 'landing'].includes(mode) ? 0 : 1, mode)
    if (['supported', 'landing'].includes(mode)) assert.equal(f.safety.snapshot().phase, 'recovering')
  }
})

test('a healthy partial correction keeps the session when danger clears and fresh supported position is observed', async t => {
  for (const mode of ['ground', 'landing', 'stale', 'unknown', 'damage', 'unsupported']) {
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => mode !== 'unsupported', strike: () => ({}), partialEscape: (context, { state, actors }) => {
      actors.splice(0)
      state.position.x += 0.05; state.rawServerPosition = { ...state.position }
      if (mode !== 'stale') state.rawServerPositionUpdatedAt = 2
      if (mode === 'landing') { state.predicted.physicsState.onGround = false; setTimeout(() => { state.predicted.physicsState.onGround = true }, 35) }
      if (mode === 'damage') state.health--
      if (mode === 'unknown') actors.push({ ...f.enemy('spider', 3, '10'), positionKnown: false, position: null })
      return { supported: true, arrived: false, code: 'PARTIAL_REPLAN' }
    } })
    f.state.health = 20; f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = 1
    f.actors.push(f.enemy('spider', 10, '9'))
    await f.start(); await f.safety.drain()
    assert.equal(f.emergencies.length, ['ground', 'landing'].includes(mode) ? 0 : 1, mode)
    if (['ground', 'landing'].includes(mode)) assert.equal(f.safety.snapshot().running, true)
  }
})

test('a partial descent can replan when a previously observed distant skeleton crosses its broad radius', async t => {
  for (const mode of ['known', 'new', 'near', 'replacement', 'damage']) {
    let attempts = 0
    const f = fixture(t, { bodyReady: false, verifyMeleeBody: () => true, partialEscape: (context, { state, actors }) => {
      if (++attempts > 1) { actors.splice(0); return { supported: true, arrived: true, escaped: true } }
      state.position.x += 1
      if (mode === 'new') actors.push(f.enemy('skeleton', 22, '10'))
      else { const other = actors.find(actor => actor.runtimeId === '10'); other.position.x = mode === 'near' ? 17 : 22; if (mode === 'replacement') other.uniqueId = 'other' }
      if (mode === 'damage') state.health--
      return { supported: true, arrived: true, partialEscape: true, constrainedEscape: true, constrainedPrimaryId: '9' }
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie', -5)); if (mode !== 'new') f.actors.push(f.enemy('skeleton', 25, '10'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(attempts, mode === 'known' ? 2 : 1, mode)
    assert.equal(f.emergencies.length, mode === 'known' ? 0 : 1, mode)
  }
})

test('immediate hostile range overrides spawn grace, but foreign ownership still wins', async t => {
  const available = fixture(t); available.actors.push(available.enemy()); available.safety.start({ enableEpoch: 1 }); await available.tick()
  assert.equal(available.calls.filter(call => call.type === 'engage').length, 1)
  const occupied = fixture(t); occupied.setIdle(false); occupied.actors.push(occupied.enemy()); occupied.safety.start({ enableEpoch: 1 }); await occupied.tick()
  assert.equal(occupied.calls.some(call => call.type === 'engage' || call.type === 'escape'), false)
  assert.equal(occupied.emergencies.length, 0)
})

test('an observed creeper inside its danger radius is handled immediately at spawn', async t => {
  const available = fixture(t, { escape: (context, { actors }) => { actors.splice(0); return { supported: true, escaped: true, arrived: true } } })
  available.actors.push(available.enemy('creeper', 7)); available.safety.start({ enableEpoch: 1 }); await available.tick()
  assert.equal(available.calls.filter(call => call.type === 'escape').length, 1)
  assert.equal(available.emergencies.length, 0)
  const occupied = fixture(t, { escape: () => ({ supported: true }) }); occupied.setIdle(false); occupied.actors.push(occupied.enemy('creeper', 7)); occupied.safety.start({ enableEpoch: 1 }); await occupied.tick()
  assert.equal(occupied.calls.some(call => call.type === 'escape'), false)
})

test('a single airborne strike requires a confirmed sword and exact attack preview', async t => {
  for (const ready of [true, false]) {
    const f = fixture(t, { strikeReady: ready, strike: (id, context, { actors }) => { actors.splice(0); return { phase: 'observed' } } })
    await f.start(); f.state.predicted.physicsState.onGround = false; f.actors.push(f.enemy())
    await f.tick()
    assert.equal(f.calls.filter(call => call.type === 'strike').length, ready ? 1 : 0)
    assert.equal(f.emergencies.length, ready ? 0 : 1)
    if (ready) assert.equal(f.safety.snapshot().lastResult.enemyDefeated, null)
  }
})

test('low-health close zombie gets at most one emergency strike before retreat or stop', async t => {
  const f = fixture(t, { strike: () => ({}), emergencyStrike: () => ({ phase: 'observed', reaction: 'hurt_animation' }) })
  f.state.health = 9.631; f.actors.push(f.enemy()); f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.equal(f.calls.filter(call => call.type === 'emergency_strike').length, 1)
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.safety.snapshot().lastDefense.enemyDefeated, null)
})

test('low-health zombie just outside reach can approach a stationary verified defender', async t => {
  const f = fixture(t, { strike: () => ({}), previewEmergency: (id, context, { state, actors }) => ({ ready: Math.hypot(actors[0].position.x - state.position.x, actors[0].position.y + 0.9 - state.position.y) <= 2.8 }), emergencyStrike: () => ({ phase: 'observed' }) })
  await f.start(); f.state.health = 10; f.actors.push(f.enemy('zombie', 5.1))
  const task = f.tick(); setTimeout(() => { f.actors[0].position.x = 2.5 }, 70)
  await task; await f.safety.drain()
  assert.equal(f.calls.filter(call => call.type === 'emergency_strike').length, 1)
  assert.equal(f.emergencies.length, 1)
})

test('low-health emergency strike refuses additional threats, unconfirmed weapon or unsafe body', async t => {
  for (const mode of ['other', 'weapon', 'body', 'health']) {
    const f = fixture(t, { strike: () => ({}), strikeBodyReady: mode !== 'body', emergencyStrike: () => ({ phase: 'observed' }) })
    f.state.health = mode === 'health' ? 6 : 9; f.actors.push(f.enemy())
    if (mode === 'other') f.actors.push(f.enemy('creeper', 3, '10'))
    if (mode === 'weapon') f.state.heldItem = null
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'emergency_strike').length, 0, mode)
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('low-health protection can restore an observed sword only when enemies and footing remain sufficiently distant', async t => {
  for (const mode of ['safe', 'near', 'unknown', 'damage', 'unsupported']) {
    const f = fixture(t, { verifyMeleeBody: () => mode !== 'unsupported', equipSword: (context, { state }) => {
      if (mode === 'damage') return new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); setTimeout(() => { state.health-- }, 5) })
      state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }, { slot: 1, name: 'minecraft:rotten_flesh', count: 1 }]
      state.heldItem = { ...state.inventory.items[0] }; return { serverConfirmed: true }
    } })
    f.state.health = 9.6; f.state.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }, { slot: 1, name: 'minecraft:stone_sword', count: 1 }]; f.state.heldItem = { ...f.state.inventory.items[0] }
    if (mode === 'unknown') f.state.inventory.known = false
    f.actors.push(f.enemy('zombie', mode === 'near' ? 3 : 7))
    f.safety.start({ enableEpoch: 1 }); await f.tick(); f.advance(501); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'equip').length, ['safe', 'damage'].includes(mode) ? 1 : 0, mode)
    if (mode === 'safe') { assert.equal(f.state.heldItem.name, 'minecraft:stone_sword'); assert.doesNotMatch(f.safety.snapshot().lastError ?? '', /constant variable/) }
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('low-health zombie defense monitors one distant skeleton and stops if it closes', async t => {
  for (const mode of ['distant', 'closing', 'near', 'extra']) {
    const f = fixture(t, { strike: () => ({}), emergencyStrike: (id, context, { actors }) => {
      assert.equal(context.allowDistantRanged, true)
      if (mode !== 'closing') return { phase: 'observed' }
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        setTimeout(() => { actors.find(actor => actor.runtimeId === '10').position.x = 17 }, 5)
      })
    } })
    f.state.health = 10; f.actors.push(f.enemy('zombie'), f.enemy('skeleton', mode === 'near' ? 17 : 21, '10'))
    if (mode === 'extra') f.actors.push(f.enemy('zombie', 5, '11'))
    f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'emergency_strike').length, ['distant', 'closing'].includes(mode) ? 1 : 0, mode)
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('damage during the low-health emergency strike aborts the owned attack', async t => {
  const f = fixture(t, { strike: () => ({}), emergencyStrike: (id, context, { state }) => new Promise((resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    setTimeout(() => { state.health -= 1 }, 5)
  }) })
  f.state.health = 9; f.actors.push(f.enemy()); f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.equal(f.calls.filter(call => call.type === 'emergency_strike').length, 1)
  assert.equal(f.emergencies.length, 1)
  assert.ok(f.calls.some(call => call.type === 'cancel'))
})

test('an airborne retreat waits briefly for real supported landing while known enemies stay distant', async t => {
  for (const mode of ['landing', 'slow_landing', 'damage', 'nearby', 'unknown', 'timeout']) {
    const f = fixture(t, { strike: () => ({}), escape: (context, { state, actors }) => { state.position.x -= 2; actors.splice(0); return { supported: true, escaped: true, arrived: true } } })
    f.state.health = 10; f.state.predicted.physicsState.onGround = false; f.actors.push(f.enemy('zombie', 7))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501)
    const task = f.tick()
    setTimeout(() => {
      if (mode === 'landing' || mode === 'slow_landing') f.state.predicted.physicsState.onGround = true
      if (mode === 'damage') f.state.health--
      if (mode === 'nearby') f.actors[0].position.x = 3
      if (mode === 'unknown') { f.actors[0].positionKnown = false; f.actors[0].position = null }
    }, mode === 'slow_landing' ? 550 : 35)
    await task; await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, ['landing', 'slow_landing'].includes(mode) ? 1 : 0, mode)
    assert.equal(f.emergencies.length, ['landing', 'slow_landing'].includes(mode) ? 0 : 1, mode)
  }
})

test('airborne recovery waits for landing only while the same ordinary creeper remains sufficiently distant', async t => {
  for (const mode of ['landing', 'close', 'primed', 'damage', 'unknown']) {
    const f = fixture(t, { strike: () => ({}), escape: (context, { state, actors }) => { state.position.x -= 2; actors.splice(0); return { supported: true, escaped: true, arrived: true } } })
    f.state.health = 9.631; f.state.predicted.physicsState.onGround = false; f.actors.push(f.enemy('creeper', 4.8))
    setTimeout(() => {
      if (mode === 'landing') f.state.predicted.physicsState.onGround = true
      if (mode === 'close') f.actors[0].position.x = 2.5
      if (mode === 'primed') f.actors[0].primed = true
      if (mode === 'damage') f.state.health--
      if (mode === 'unknown') { f.actors[0].positionKnown = false; f.actors[0].position = null }
    }, 35)
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, mode === 'landing' ? 1 : 0, mode)
    assert.equal(f.emergencies.length, mode === 'landing' ? 0 : 1, mode)
  }
})

test('an unseeded received pose briefly waits for a verified ledge before choosing a partial escape', async t => {
  const f = fixture(t, { strike: () => ({}), bodyReady: false, verifyLedgeBody: observed => observed.predicted?.physicsState?.onGround === true, partialEscape: (context, { actors }) => { actors.splice(0); return { supported: true, arrived: true, escaped: true } } })
  f.state.predicted = null; f.state.positionSource = 'start_game'; f.state.positionServerConfirmed = true
  f.actors.push(f.enemy('creeper', 6.5))
  setTimeout(() => { f.state.predicted = { physicsState: { onGround: true, isInWater: false, isInLava: false } } }, 35)
  f.safety.start({ enableEpoch: 1 }); await f.tick(); await f.safety.drain()
  assert.ok(f.calls.some(call => call.type === 'partial_escape'))
  assert.equal(f.emergencies.length, 0)
})

test('airborne recovery can wait for landing with one spider while distance remains bounded', async t => {
  for (const mode of ['landing', 'close', 'damage', 'low_health', 'new_enemy']) {
    const f = fixture(t, { strike: () => ({}), escape: (context, { state, actors }) => { state.position.x -= 2; actors.splice(0); return { supported: true, escaped: true, arrived: true } } })
    f.state.health = mode === 'low_health' ? 10 : 10.631; f.state.predicted.physicsState.onGround = false; f.actors.push(f.enemy('spider', 5.3))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501)
    const task = f.tick()
    setTimeout(() => {
      if (mode === 'landing') f.state.predicted.physicsState.onGround = true
      if (mode === 'close') f.actors[0].position.x = 2
      if (mode === 'damage') f.state.health--
      if (mode === 'new_enemy') f.actors.push(f.enemy('zombie', -3, '10'))
    }, 35)
    await task; await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, mode === 'landing' ? 1 : 0, mode)
  }
})

test('critical health can wait briefly for an observed landing while a zombie and skeleton remain distant', async t => {
  for (const mode of ['landing', 'close_zombie', 'close_skeleton', 'damage', 'extra_enemy']) {
    const f = fixture(t, { strike: () => ({}), escape: () => ({ supported: false, reason: 'no_known_away_route' }) })
    f.state.health = 4.631; f.state.predicted.physicsState.onGround = false; f.actors.push(f.enemy('zombie', 6.5, '9'), f.enemy('skeleton', 23, '10'))
    f.safety.start({ enableEpoch: 1, recoveryDeadline: 3000 }); await f.tick(); f.advance(501)
    const task = f.tick()
    setTimeout(() => {
      if (mode === 'landing') f.state.predicted.physicsState.onGround = true
      if (mode === 'close_zombie') f.actors[0].position.x = 3
      if (mode === 'close_skeleton') f.actors[1].position.x = 18
      if (mode === 'damage') f.state.health--
      if (mode === 'extra_enemy') f.actors.push(f.enemy('spider', -3, '11'))
    }, 35)
    await task; await f.safety.drain()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, mode === 'landing' ? 1 : 0, mode)
    assert.equal(f.emergencies.length, 1, mode)
  }
})

test('an unknown ground flag still requires verified body clearance before a strike', async t => {
  for (const bodyReady of [true, false]) {
    const f = fixture(t, { strikeBodyReady: bodyReady, strike: (id, context, { actors }) => { actors.splice(0); return { phase: 'observed' } } })
    await f.start(); delete f.state.predicted; f.actors.push(f.enemy())
    await f.tick()
    assert.equal(f.calls.filter(call => call.type === 'strike').length, bodyReady ? 1 : 0)
  }
})

test('a distant melee threat does not bypass the spawn grace', async t => {
  const f = fixture(t); f.actors.push(f.enemy('zombie', 7)); f.safety.start({ enableEpoch: 1 }); await f.tick()
  assert.equal(f.calls.some(call => call.type === 'equip' || call.type === 'engage'), false)
  assert.equal(f.safety.snapshot().phase, 'grace')
})

test('a sword-equipped bot attacks when the body-range oracle becomes ready', async t => {
  const f = fixture(t, { previewEngage: (id, context, { state, actors }) => ({ ready: Math.hypot(actors[0].position.x - state.position.x, actors[0].position.y + 0.9 - state.position.y) <= 2.8 }) })
  await f.start(); f.actors.push(f.enemy('zombie', 4.5))
  const task = f.tick(); setTimeout(() => { f.actors[0].position.x = 3.15 }, 100)
  await task
  assert.equal(f.calls.filter(call => call.type === 'engage').length, 1)
  assert.equal(f.emergencies.length, 0)
})

test('a close feet-distance still observes approach when the body is out of reach', async t => {
  const f = fixture(t, { previewEngage: (id, context, { state, actors }) => ({ ready: Math.hypot(actors[0].position.x - state.position.x, actors[0].position.y + 0.9 - state.position.y) <= 2.8 }) })
  await f.start(); f.actors.push({ ...f.enemy('zombie', 3.25), position: { x: 3.25, y: 66.62, z: 0.5 } })
  const task = f.tick(); setTimeout(() => { f.actors[0].position.x = 3.1 }, 70)
  await task
  assert.equal(f.calls.filter(call => call.type === 'engage').length, 1)
  assert.equal(f.emergencies.length, 0)
})

test('a lone approaching zombie within the melee danger radius can reach the defense range', async t => {
  const f = fixture(t, { previewEngage: (id, context, { state, actors }) => ({ ready: Math.hypot(actors[0].position.x - state.position.x, actors[0].position.y + 0.9 - state.position.y) <= 2.8 }) })
  await f.start(); f.actors.push(f.enemy('zombie', 9.5))
  const task = f.tick(); setTimeout(() => { f.actors[0].position.x = 3.1 }, 70)
  await task
  assert.equal(f.calls.filter(call => call.type === 'engage').length, 1)
  assert.equal(f.emergencies.length, 0)
})

test('a second threat interrupts the approach observation without attacking', async t => {
  const f = fixture(t, { previewEngage: () => ({ ready: false }) })
  await f.start(); f.actors.push(f.enemy('zombie', 4.5))
  const task = f.tick(); setTimeout(() => { f.actors.push(f.enemy('creeper', 3, '10')) }, 100)
  await task
  assert.equal(f.calls.some(call => call.type === 'engage'), false)
  assert.equal(f.emergencies.length, 1)
})

test('unsupported ranged, explosive and boss enemies are never hit and cause exactly one emergency if escape is unavailable', async t => {
  for (const type of ['skeleton', 'creeper', 'wither']) {
    const f = fixture(t); await f.start(); f.actors.push(f.enemy(type))
    await f.tick(); await f.tick(); await f.safety.drain()
    assert.equal(f.calls.some(call => call.type === 'engage' || call.type === 'equip'), false)
    assert.equal(f.emergencies.length, 1)
    assert.equal(f.safety.snapshot().running, false)
    assert.equal(f.safety.snapshot().emergencySent, true)
  }
})

test('players are not attacked and an unexplained idle hit uses the emergency path', async t => {
  const f = fixture(t); await f.start()
  f.actors.push({ ...f.enemy(), kind: 'player', entityType: 'minecraft:player', username: 'player' })
  await f.tick(); assert.equal(f.emergencies.length, 0)
  f.state.health = 19; await f.tick()
  assert.equal(f.calls.some(call => call.type === 'engage'), false)
  assert.equal(f.emergencies.length, 1)
})

test('unknown body, inventory or equipment acknowledgement cannot authorize an idle attack', async t => {
  for (const mode of ['body', 'inventory', 'ack', 'held', 'oracle']) {
    const f = fixture(t, { bodyReady: mode !== 'body', previewReady: mode !== 'oracle', equipSword: mode === 'ack' ? () => ({ serverConfirmed: false }) : undefined })
    await f.start()
    if (mode === 'inventory') f.state.inventory.uncertain = true
    if (mode === 'held') f.state.heldItem = { name: 'minecraft:dirt', count: 1, slot: 0 }
    f.actors.push(f.enemy()); await f.tick()
    assert.equal(f.calls.some(call => call.type === 'engage'), false)
    assert.equal(f.emergencies.length, 1)
  }
})

test('actual successful escape must remove current idle risk; predicted arrival with danger remaining is not protection', async t => {
  for (const clears of [true, false]) {
    const f = fixture(t, { escape: (context, { actors }) => { if (clears) actors.splice(0); return { supported: true, escaped: true, arrived: true, serverConfirmed: false } } })
    await f.start(); f.actors.push(f.enemy('skeleton', 6)); await f.tick()
    assert.equal(f.calls.filter(call => call.type === 'escape').length, 1)
    assert.equal(f.emergencies.length, clears ? 0 : 1)
    assert.equal(f.safety.snapshot().lastResult.enemyDefeated, null)
  }
})

test('bounded partial escapes reobserve and continue away from the same enemy', async t => {
  const f = fixture(t, { escape: (context, { state, actors }) => { state.position.x -= 3; const remaining = Math.hypot(state.position.x - actors[0].position.x, state.position.y - actors[0].position.y) <= 12; return { supported: true, escaped: !remaining, partialEscape: remaining, arrived: true, serverConfirmed: false } } })
  await f.start(); f.actors.push(f.enemy('zombie', 2)); f.state.inventory.items = []; f.state.heldItem = null
  await f.tick()
  assert.equal(f.calls.filter(call => call.type === 'escape').length, 4)
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().running, true)
})

test('a pursuing enemy can close some distance without undoing progress from the episode origin', async t => {
  let calls = 0
  const f = fixture(t, { escape: (context, { state, actors }) => {
    calls++; state.position.x -= 4
    if (calls === 2) actors[0].position.x -= 7
    const remaining = Math.hypot(state.position.x - actors[0].position.x, state.position.y - actors[0].position.y) <= 12
    return { supported: true, escaped: !remaining, partialEscape: remaining, arrived: true }
  } })
  await f.start(); f.actors.push(f.enemy('zombie', 4.5)); f.state.inventory.items = []; f.state.heldItem = null
  await f.tick()
  assert.equal(calls, 4)
  assert.equal(f.emergencies.length, 0)
})

test('failed escape exposes only a recognized diagnostic reason', async t => {
  const f = fixture(t, { escape: () => ({ supported: false, reason: 'no_known_away_route' }) })
  await f.start(); f.actors.push(f.enemy('creeper'))
  await f.tick()
  assert.equal(f.safety.snapshot().lastResult.reason, 'no_known_away_route')
  assert.equal(f.safety.snapshot().emergencySent, true)
})

test('escape search reports only bounded numeric diagnostics', async t => {
  const diagnostics = { visited: 5, candidates: 0, partials: 0, previews: 0, readyPreviews: 0, floorBlocked: 2, bodyBlocked: 1, terrainUnknown: 0, awayBlocked: 3, gainBlocked: 0, privateText: 'not forwarded' }
  const f = fixture(t, { escape: () => ({ supported: false, reason: 'no_known_away_route', diagnostics }) })
  await f.start(); f.actors.push(f.enemy('creeper')); await f.tick()
  assert.deepEqual(f.safety.snapshot().lastResult.diagnostics, { visited: 5, candidates: 0, partials: 0, previews: 0, readyPreviews: 0, floorBlocked: 2, bodyBlocked: 1, terrainUnknown: 0, awayBlocked: 3, gainBlocked: 0 })
})

test('escape interruption uses a bounded cause instead of raw diagnostic text', async t => {
  const f = fixture(t, { escape: () => ({ supported: true, escaped: false, code: 'NEARBY_THREAT', routeInterruption: { reason: 'A current or approaching threat stops movement' }, remainingRouteRejection: { reason: 'closer_actor', detail: null, previewCode: null, actorName: 'minecraft:zombie', minDistance: 5, required: 6 } }) })
  await f.start(); f.actors.push(f.enemy('creeper'))
  await f.tick()
  assert.equal(f.safety.snapshot().lastResult.cause, 'NEW_THREAT')
  assert.deepEqual(f.safety.snapshot().lastResult.rejection, { reason: 'closer_actor', detail: null, previewCode: null, actorName: 'minecraft:zombie', minDistance: 5, required: 6 })
})

test('foreign jobs own the actor and their last observed busy time grants exactly the catch-retreat grace', async t => {
  const f = fixture(t); await f.start(); f.actors.push(f.enemy('skeleton')); f.setIdle(false)
  f.state.health = 19; await f.tick(); f.advance(400); await f.tick()
  f.setIdle(true); f.advance(499); await f.tick()
  assert.equal(f.emergencies.length, 0)
  f.advance(1); await f.tick()
  assert.equal(f.emergencies.length, 1)
})

test('dead and closed refuge retain recovery grace; initial loading responds to immediate danger', async t => {
  for (const mode of ['dead', 'loading', 'covered']) {
    const f = fixture(t)
    if (mode === 'dead') { f.state.dead = true; f.state.health = 0 }
    if (mode === 'loading') f.state.phase = 'loading'
    if (mode === 'covered') f.cover()
    await f.start(); f.advance(400); await f.tick()
    f.state.dead = false; f.state.health = 20; f.state.phase = 'spawned'; f.state.hut = null; f.actors.push(f.enemy('skeleton'))
    f.advance(499); await f.tick(); assert.equal(f.emergencies.length, mode === 'loading' ? 1 : 0)
    f.advance(1); await f.tick(); assert.equal(f.emergencies.length, 1)
  }
})

test('a refuge closed by the active script during grace cancels pending damage without an emergency', async t => {
  const f = fixture(t); await f.start(); f.setIdle(false); f.state.health = 19; await f.tick()
  f.setIdle(true); f.cover(); f.advance(600); await f.tick()
  assert.equal(f.emergencies.length, 0)
  assert.equal(f.safety.snapshot().phase, 'covered')
})

test('low health during defense cannot be delayed by a newly updated manual timestamp', async t => {
  let manualUntil = 0
  const f = fixture(t, { isIdle: (context, { time }) => context.episodeActive || time >= manualUntil, engage: (id, context, { state }) => { state.health = 9; manualUntil = 100000; return { phase: 'stopped', serverConfirmed: false } } })
  await f.start(); f.actors.push(f.enemy()); await f.tick()
  assert.equal(f.emergencies.length, 1)
  assert.ok(f.calls.filter(call => call.type === 'ownership' && call.episodeActive).every(call => call.defenseEpisode))
})

test('close_hut is immediate only with real open established geometry and two actual dirt, and a one-dirt deficit never waits', async t => {
  for (const dirt of [1, 2]) {
    const f = fixture(t, { closeHut: (context, { state }) => { state.hut.closed = true; state.hut.entranceClosed = true; state.hut.usable = true; return { phase: 'completed' } } })
    f.state.hut = { inside: true, closed: false, entranceClosed: false, usable: false, established: true, structureIntact: true, serverConfirmed: true, memo: { site: { id: 'hut' }, pendingPlacement: null } }
    f.state.inventory.items.push({ slot: 4, name: 'minecraft:dirt', count: dirt })
    await f.start()
    assert.equal(f.calls.filter(call => call.type === 'close_hut').length, dirt === 2 ? 1 : 0)
    assert.equal(f.calls.some(call => call.type === 'engage'), false)
    assert.equal(f.emergencies.length, 0)
    if (dirt === 1) { f.actors.push(f.enemy('skeleton')); await f.tick(); assert.equal(f.emergencies.length, 1) }
  }
})

test('an unsupported close is not retried every idle tick and memo-only or pending placement cannot request construction', async t => {
  const f = fixture(t, { closeHut: () => ({ supported: false }) })
  f.state.hut = { inside: true, closed: false, established: true, structureIntact: true, serverConfirmed: true, memo: { site: { id: 'hut' } } }
  f.state.inventory.items.push({ slot: 4, name: 'minecraft:dirt', count: 2 })
  await f.start(); for (let n = 0; n < 5; n++) { f.advance(100); await f.tick() }
  assert.equal(f.calls.filter(call => call.type === 'close_hut').length, 1)
  assert.equal(f.emergencies.length, 0)
  const pending = fixture(t, { closeHut: () => { throw new Error('must not build') } }); pending.state.inventory.items.push({ name: 'minecraft:dirt', count: 2, slot: 4 }); pending.state.hut = { ...f.state.hut, pendingPlacement: {} }
  await pending.start(); assert.equal(pending.calls.some(call => call.type === 'close_hut'), false)
})

test('stop/drain cancel only owned work and a changed generation or scope never disconnects a new session', async t => {
  for (const mode of ['stop', 'generation', 'scope']) {
    let entered
    const begun = new Promise(resolve => { entered = resolve })
    const f = fixture(t, { engage: (id, context) => new Promise((resolve, reject) => { entered(); context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }) }) })
    await f.start(); f.actors.push(f.enemy()); const work = f.safety.tick(); await begun
    if (mode === 'stop') await f.safety.stop('normal source update')
    if (mode === 'generation') f.setGeneration(false)
    if (mode === 'scope') f.state.realm.id = 'another'
    await work; await f.safety.drain()
    assert.equal(f.emergencies.length, 0)
    assert.ok(f.calls.some(call => call.type === 'cancel'))
  }
})

test('the emergency callback is not awaited by drain, and same enable epoch cannot send twice', async t => {
  const f = fixture(t, { onEmergencyStop: () => new Promise(() => {}) }); await f.start(); f.actors.push(f.enemy('skeleton')); await f.tick()
  await f.safety.drain()
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.emergencies[0].enableEpoch, '1')
  assert.throws(() => f.safety.start({ enableEpoch: 1 }), error => error.code === 'BUSY')
  await f.safety.stop('explicit stop')
  f.actors.splice(0); f.safety.start({ enableEpoch: 2 }); await f.tick(); f.advance(500); await f.tick()
  assert.equal(f.safety.snapshot().emergencySent, false)
  assert.equal(f.safety.snapshot().enableEpoch, '2')
})

test('a normal reload revokes an armed emergency dispatch before it can disconnect', async t => {
  const f = fixture(t, { onProgress: (value, safety) => { if (value.phase === 'emergency_stopped') void safety.stop('normal reload boundary') } })
  await f.start(); f.actors.push(f.enemy('skeleton')); await f.tick(); await f.safety.drain()
  assert.equal(f.emergencies.length, 0)
})

test('fresh low or unknown health after an oracle preview cannot authorize a hit', async t => {
  for (const health of [9, NaN]) {
    const f = fixture(t, { previewEngage: (id, context, { state }) => { state.health = health; return { ready: true } } })
    await f.start(); f.actors.push(f.enemy()); await f.tick()
    assert.equal(f.calls.some(call => call.type === 'engage'), false)
    assert.equal(f.emergencies.length, 1)
  }
})

test('known nearby danger with unknown health or a new idle hit with unknown pose uses emergency rather than unprotected waiting', async t => {
  for (const mode of ['health', 'pose']) {
    const f = fixture(t); await f.start()
    if (mode === 'health') { f.state.health = NaN; f.actors.push(f.enemy()) } else { f.state.health = 19; f.state.position = null }
    await f.tick()
    assert.equal(f.calls.some(call => call.type === 'engage'), false)
    assert.equal(f.emergencies.length, 1)
  }
})

test('new actors, body loss and low health interrupt an owned asynchronous defense and produce one emergency', async t => {
  for (const mode of ['actor', 'body', 'health']) {
    const f = fixture(t, { engage: (id, context, { state, actors }) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      setTimeout(() => {
        if (mode === 'actor') actors.push({ ...f.enemy('skeleton', 3, '10') })
        if (mode === 'body') state.predicted.physicsState.onGround = false
        if (mode === 'health') state.health = 9
      }, 5)
    }) })
    await f.start(); f.actors.push(f.enemy()); await f.tick()
    assert.equal(f.emergencies.length, 1)
    assert.equal(f.calls.filter(call => call.type === 'engage').length, 1)
    assert.equal(f.safety.snapshot().lastResult?.enemyDefeated ?? null, null)
  }
})

test('new server health loss overrides predicted closed-refuge protection and its grace window', async t => {
  const f = fixture(t)
  f.cover()
  await f.start()
  assert.equal(f.safety.snapshot().phase, 'covered')
  assert.equal(f.emergencies.length, 0)
  f.state.positionSource = 'client_prediction'
  f.state.health = 17
  await f.tick()
  assert.equal(f.emergencies.length, 1)
  assert.equal(f.safety.snapshot().emergencySent, true)
  assert.equal(f.calls.some(call => call.type === 'engage'), false, 'no visible hostile cannot be invented from a health update')
})
