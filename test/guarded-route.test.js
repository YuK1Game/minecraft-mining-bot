'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGuardedRoute } = require('../src/guarded-route')
const { buildTerrainThreatEvidence } = require('../src/terrain-threats')

const p = x => ({ x, y: 60, z: 0.5 })
function fixture ({ onStart, onEquip, onEngage, onPreview, onReturned, onClose, onProgress, onState, timeout = 500, realDelay = false } = {}) {
  let time = 1000; let stamp = 0; let motion = { phase: 'idle' }
  const calls = []; const progress = []; const actors = []
  const state = { phase: 'spawned', profile: 'route', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', gameMode: 'survival', health: 20, position: { ...p(0.5), y: 61.62 }, rawServerPosition: { ...p(0.5), y: 61.62 }, rawServerPositionUpdatedAt: 0, positionSource: 'start_game', positionUpdatedAt: 0, rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:dirt', count: 2 }, { slot: 5, name: 'minecraft:stone_sword', count: 1 }] }, predicted: { physicsState: { onGround: true } } }
  state.heldItem = { ...state.inventory.items[0] }
  const getState = () => { const value = structuredClone({ ...state, entities: actors }); return onState?.(value) ?? value }
  const arrive = target => { state.position = { ...target, y: target.y + 1.62 }; stamp = Math.max(stamp, state.positionUpdatedAt) + 1; state.positionUpdatedAt = stamp; state.positionSource = 'client_prediction'; state.predicted = { physicsState: { onGround: true } }; motion = { phase: 'awaiting_server_confirmation', onGround: true } }
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', target, options }); return onPreview?.({ target, options, state, calls }) ?? { ready: true, waypoints: [{ position: target, medium: 'land', action: 'walk' }] } },
    start: (target, options) => {
      calls.push({ type: 'start', target: structuredClone(target), options, held: state.heldItem?.name ?? null }); motion = { phase: 'moving' }
      const result = onStart?.({ state, actors, target, options, calls, arrive, setMotion: value => { motion = value } })
      if (result !== undefined) return result
      arrive(target); return motion
    },
    stop: reason => { calls.push({ type: 'stop', reason }); motion = { phase: 'stopped' }; return motion }
  }
  const inventory = { equip: async (slot, options) => {
    calls.push({ type: 'equip', slot })
    const result = await onEquip?.({ state, slot, options })
    if (result !== undefined) return result
    const selected = state.inventory.items.find(item => item.slot === state.rawSelectedSlot)
    const item = state.inventory.items.find(item => item.slot === slot)
    if (selected) selected.slot = slot
    item.slot = state.rawSelectedSlot; state.heldItem = { ...item }
    return { phase: 'completed', slot: state.rawSelectedSlot, serverConfirmed: true, confirmedBy: 'item_stack_response' }
  }, cancel: () => {} }
  const combat = {
    previewEngage: id => { calls.push({ type: 'combat_preview', id }); return { ready: actors.some(actor => actor.runtimeId === id && /zombie|husk|spider|drowned/.test(actor.entityType)) } },
    engage: async (id, options) => { calls.push({ type: 'engage', id, options, held: state.heldItem.name }); return await onEngage?.({ state, actors, id, options }) ?? { phase: 'stopped', mode: 'engage', serverConfirmed: false, enemyDefeated: null } },
    preview: id => ({ ready: actors.some(actor => actor.runtimeId === id && /zombie|husk|spider|drowned/.test(actor.entityType)) }),
    attack: async id => { calls.push({ type: 'push_back', id }); return { phase: 'observed', reaction: 'hurt_animation', targetRuntimeId: id } },
    cancel: reason => calls.push({ type: 'combat_cancel', reason }), drain: async () => {}
  }
  const route = createGuardedRoute({ getState, movement, getMovement: () => structuredClone(motion), inventory, combat, verifyStanding: async s => s.predicted?.physicsState?.onGround === true, closeContainer: onClose ? () => onClose({ state, calls }) : null, onReturned: onReturned ? (returned, context) => onReturned({ state, actors, returned, context, calls }) : null, onProgress: event => { progress.push(event); onProgress?.({ event, state, actors }) }, pollMs: 10, operationTimeoutMs: timeout, clock: () => time, delay: async (ms, signal) => { if (realDelay) await new Promise(resolve => setTimeout(resolve, ms)); else time += ms; if (signal.aborted) throw signal.reason } })
  const enemy = (name, x, id = '9') => ({ runtimeId: id, uniqueId: id, kind: 'mob', entityType: `minecraft:${name}`, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: p(x) })
  return { route, state, actors, calls, progress, enemy, getState, arrive, movement, scope: { profile: 'route', realmId: '42', dimension: 'overworld' } }
}

test('route construction is passive and every movement starts with the real confirmed selected sword', async () => {
  const f = fixture()
  assert.deepEqual(f.calls, [])
  const raw = structuredClone(f.state.rawServerPosition)
  const result = await f.route.execute([p(1.5), p(2.5)])
  assert.equal(result.ok, true)
  assert.equal(result.outwardCompleted, true)
  assert.equal(result.arrived, true)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.held), ['minecraft:stone_sword', 'minecraft:stone_sword'])
  assert.ok(f.calls.findIndex(c => c.type === 'equip') < f.calls.findIndex(c => c.type === 'start'))
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(result.visitedPrefix.length, 3)
})

test('a missing sword, an unconfirmed ack or a lying ack cannot authorize movement', async () => {
  for (const mode of ['missing', 'unconfirmed', 'lying']) {
    const f = fixture({ onEquip: mode === 'unconfirmed' ? () => ({ serverConfirmed: false }) : mode === 'lying' ? () => ({ serverConfirmed: true }) : undefined })
    if (mode === 'missing') f.state.inventory.items = f.state.inventory.items.filter(item => !item.name.endsWith('_sword'))
    const result = await f.route.execute([p(1.5)])
    assert.equal(result.ok, false)
    assert.equal(result.arrived, false)
    assert.equal(result.returned, false)
    assert.equal(f.calls.some(c => c.type === 'start'), false)
  }
})

test('the first damage cancels outward motion and returns only through the actually visited prefix', async () => {
  let damaged = false
  const f = fixture({ onStart: ({ state, target, setMotion }) => {
    if (!damaged && target.x === 2.5) { damaged = true; state.health = 19; state.position.x = 2.1; state.positionUpdatedAt++; setMotion({ phase: 'moving' }); return { phase: 'moving' } }
  } })
  const result = await f.route.execute([p(1.5), p(2.5), p(3.5)])
  assert.equal(result.ok, true)
  assert.equal(result.returned, true)
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.safe, false)
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [1.5, 2.5, 1.5, 0.5])
  assert.deepEqual(result.visitedPrefix.map(p => p.x), [0.5, 1.5])
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.urgent), true)
})

test('a single close melee threat uses the exact bounded engagement and never resumes outward after its removal', async () => {
  const f = fixture({ onEngage: ({ actors, id, options }) => { assert.equal(options.durationMs, 4000); assert.equal(options.maxHits, 6); actors.splice(0); return { phase: 'observed', mode: 'engage', targetRuntimeId: id, reaction: 'target_removed', serverConfirmed: true } } })
  f.arrive(p(2.5)); f.actors.push(f.enemy('zombie', 4.5))
  const result = await f.route.execute([p(3.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5)], scope: f.scope })
  assert.equal(result.returned, true)
  assert.equal(result.outwardCompleted, false)
  assert.deepEqual(f.calls.filter(c => c.type === 'engage').map(c => c.id), ['9'])
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [1.5, 0.5])
  assert.equal(result.defenses[0].enemyDefeated, null)
  assert.equal(f.calls.find(c => c.type === 'engage').held, 'minecraft:stone_sword')
})

test('a remaining creeper permits only a verified increasing-distance emergency retreat and is never fought', async () => {
  const f = fixture()
  f.arrive(p(2.5)); f.actors.push(f.enemy('creeper', 8.5))
  const result = await f.route.execute([p(3.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5)], scope: f.scope })
  assert.deepEqual(f.calls.filter(c => c.type === 'engage'), [])
  const moves = f.calls.filter(c => c.type === 'start')
  assert.deepEqual(moves.map(c => c.target.x), [1.5, 0.5])
  assert.ok(moves.every(c => c.options.emergency === true && c.options.sprint === true))
  assert.equal(result.returned, true)
  assert.equal(result.safe, false)
})

test('retreat checks every preview segment, so a safe endpoint cannot hide a detour toward a threat', async () => {
  const f = fixture({ onPreview: ({ target }) => ({ ready: true, waypoints: [{ position: p(7.5), medium: 'land', action: 'walk' }, { position: target, medium: 'land', action: 'walk' }] }) })
  f.arrive(p(2.5)); f.actors.push(f.enemy('creeper', 8.5))
  const result = await f.route.execute([p(3.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5)], scope: f.scope })
  assert.equal(result.ok, false)
  assert.equal(result.returned, false)
  assert.equal(result.arrived, false)
  assert.equal(f.calls.some(c => c.type === 'start'), false)
  assert.equal(f.progress.at(-1).urgent, true)
})

test('multiple threats and bosses are never engaged and an impossible retreat is reported immediately as dangerous', async () => {
  for (const type of ['wither', 'creeper']) {
    const f = fixture({ onPreview: () => ({ ready: false, waypoints: [] }) })
    f.arrive(p(2.5)); f.actors.push(f.enemy(type, 8.5), f.enemy('zombie', 4.5, '10'))
    const result = await f.route.returnRoute([p(0.5), p(1.5), p(2.5)], { scope: f.scope })
    assert.equal(result.ok, false)
    assert.equal(result.arrived, false)
    assert.equal(result.returned, false)
    assert.equal(f.calls.some(c => c.type === 'engage'), false)
    assert.equal(f.calls.some(c => c.type === 'start'), false)
    assert.equal(f.progress.some(event => event.urgent && event.phase === 'retreat_blocked'), true)
  }
})

test('retreat damage also stops the actor before replanning and cannot restore the outward queue', async () => {
  let hits = 0
  const f = fixture({ onStart: ({ state, target, calls, setMotion }) => {
    if (hits === 0 && target.x === 2.5 || hits === 1 && target.x === 1.5 && calls.filter(c => c.type === 'start').length > 2) {
      hits++; state.health--; state.position.x = 2.1; state.positionUpdatedAt++; setMotion({ phase: 'moving' }); return { phase: 'moving' }
    }
  } })
  const result = await f.route.execute([p(1.5), p(2.5), p(3.5)])
  assert.equal(hits, 2)
  assert.equal(result.returned, true)
  assert.equal(f.calls.filter(c => c.type === 'start').some(c => c.target.x === 3.5), false)
  assert.equal(result.interruptions, 2)
})

test('scope changes, unknown support and stale arrival cannot be reported as a completed return', async () => {
  const changed = fixture({ onStart: ({ state }) => { state.realm.id = 'different' } })
  const session = await changed.route.execute([p(1.5)])
  assert.equal(session.code, 'SESSION_CHANGED')
  assert.equal(session.arrived, false)
  const stale = fixture({ onStart: ({ state, target, setMotion }) => { state.position = { ...target, y: target.y + 1.62 }; setMotion({ phase: 'awaiting_server_confirmation' }); return { phase: 'awaiting_server_confirmation' } } })
  const result = await stale.route.execute([p(1.5)])
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.returned, false)
  assert.equal(result.arrived, false)
  assert.equal(result.safe, false)
})

test('cancel and a hanging actor remain bounded, clean up, and fence any late action before reuse', async () => {
  let resolve
  const f = fixture({ timeout: 50, onStart: ({ calls }) => calls.filter(c => c.type === 'start').length === 1 ? new Promise(yes => { resolve = yes }) : undefined })
  const controller = new AbortController()
  const work = f.route.execute([p(1.5)], { signal: controller.signal })
  while (!resolve) await new Promise(yes => setImmediate(yes))
  controller.abort(new Error('test cancel'))
  const result = await work
  assert.equal(result.arrived, false)
  assert.equal(result.returned, false)
  assert.equal(f.route.snapshot().busy, true, 'uncancellable late actor remains fenced')
  assert.throws(() => f.route.execute([p(1.5)]), error => error.code === 'BUSY')
  resolve({ phase: 'stopped' })
  await new Promise(yes => setImmediate(yes))
  assert.equal(f.route.snapshot().busy, false)
  const next = await f.route.execute([p(1.5)])
  assert.equal(next.outwardCompleted, true)
})

test('explicit return validates its prefix scope and only follows known reverse nodes', async () => {
  const f = fixture()
  f.arrive(p(2.5))
  const refused = await f.route.returnRoute([p(0.5), p(1.5), p(2.5)], { scope: { ...f.scope, realmId: 'elsewhere' } })
  assert.equal(refused.code, 'INVALID_PREFIX')
  assert.equal(f.calls.some(c => c.type === 'start'), false)
  const returned = await f.route.returnRoute([p(0.5), p(1.5), p(2.5)], { scope: f.scope })
  assert.equal(returned.returned, true)
  assert.equal(returned.outwardCompleted, false)
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [1.5, 0.5])
})

test('explicit unarmed bootstrap is short and healthy, while default and a failed real-sword equip stay strict', async () => {
  const f = fixture()
  f.state.inventory.items = [f.state.inventory.items[0]]
  const result = await f.route.execute([p(1.5), p(2.5)], { allowUnarmedBootstrap: true })
  assert.equal(result.outwardCompleted, true)
  assert.equal(f.calls.some(c => c.type === 'equip'), false)
  assert.ok(f.calls.filter(c => c.type === 'start').every(c => c.held === 'minecraft:dirt'))
  assert.throws(() => f.route.execute([p(1.5)], { allowUnarmedBootstrap: 'true' }), error => error.code === 'INVALID_BOUNDS')
  assert.throws(() => f.route.execute(Array.from({ length: 9 }, (_, i) => p(i + 0.5)), { allowUnarmedBootstrap: true }), error => error.code === 'BOOTSTRAP_LIMIT')
  const low = fixture(); low.state.inventory.items = []; low.state.heldItem = null; low.state.health = 14
  assert.equal((await low.route.execute([p(1.5)], { allowUnarmedBootstrap: true })).code, 'LOW_HEALTH')
  const lying = fixture({ onEquip: () => ({ serverConfirmed: false }) })
  assert.equal((await lying.route.execute([p(1.5)], { allowUnarmedBootstrap: true })).code, 'EQUIPMENT_UNCONFIRMED')
})

test('lower-health preparation is explicit, sword-required and still stops at ten health', async () => {
  const defaultRoute = fixture(); defaultRoute.state.health = 13
  assert.equal((await defaultRoute.route.execute([p(1.5)])).code, 'LOW_HEALTH')
  const prepared = fixture(); prepared.state.health = 13
  assert.equal((await prepared.route.execute([p(1.5)], { minimumOutwardHealth: 10 })).outwardCompleted, true)
  const critical = fixture(); critical.state.health = 10
  assert.equal((await critical.route.execute([p(1.5)], { minimumOutwardHealth: 10 })).code, 'LOW_HEALTH')
  const unarmed = fixture(); unarmed.state.health = 13; unarmed.state.inventory.items = []; unarmed.state.heldItem = null
  assert.equal((await unarmed.route.execute([p(1.5)], { minimumOutwardHealth: 10 })).code, 'SWORD_REQUIRED')
  assert.throws(() => unarmed.route.execute([p(1.5)], { minimumOutwardHealth: 10, allowUnarmedBootstrap: true }), error => error.code === 'INVALID_BOUNDS')
  for (const value of [9, 15, null, NaN, Infinity, '10']) assert.throws(() => fixture().route.execute([], { minimumOutwardHealth: value }), error => error.code === 'INVALID_BOUNDS')
})

test('a bootstrap hit reverses in the same script and invokes immediate refuge closure before returning', async () => {
  let damaged = false; let closed = false
  const f = fixture({ onStart: ({ state, target, setMotion }) => {
    if (!damaged && target.x === 2.5) { damaged = true; state.health = 15; state.position.x = 2.1; state.positionUpdatedAt++; setMotion({ phase: 'moving' }); return { phase: 'moving' } }
  }, onReturned: ({ state, returned, context, calls }) => {
    closed = true
    assert.equal(returned.position.x, 0.5)
    assert.equal(context.scope.realmId, '42')
    calls.push({ type: 'close_refuge' })
    state.hut = { inside: true, closed: true, usable: true, serverConfirmed: true }
    state.position.x = -0.5; state.positionUpdatedAt++
  } })
  f.state.inventory.items = [f.state.inventory.items[0]]
  const result = await f.route.execute([p(1.5), p(2.5), p(3.5)], { allowUnarmedBootstrap: true })
  assert.equal(closed, true)
  assert.equal(result.returned, true)
  assert.equal(result.refugeConfirmed, true)
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.safe, false)
  assert.equal(f.calls.filter(c => c.type === 'start').some(c => c.target.x === 3.5), false)
})

test('bootstrap uses only a finite exact-target push-back and never fights a skeleton or creeper', async () => {
  for (const name of ['zombie', 'skeleton', 'creeper']) {
    const f = fixture()
    f.state.inventory.items = []; f.state.heldItem = null
    f.arrive(p(2.5)); f.actors.push(f.enemy(name, 4.5))
    const result = await f.route.execute([p(3.5)], { allowUnarmedBootstrap: true, visitedPrefix: [p(0.5), p(1.5), p(2.5)], scope: f.scope })
    assert.equal(f.calls.some(c => c.type === 'engage'), false)
    assert.equal(f.calls.filter(c => c.type === 'push_back').length, name === 'zombie' ? 1 : 0)
    assert.equal(result.outwardCompleted, false)
    assert.equal(result.arrived, false, 'an endpoint still in danger is not a safe completed return')
    assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [1.5, 0.5])
  }
})

test('return accepts only a verified nearby knockback connector and never snaps the received pose', async () => {
  const f = fixture()
  f.arrive(p(2.9))
  const original = structuredClone(f.state.position)
  const result = await f.route.returnRoute([p(0.5), p(1.5)], { scope: f.scope })
  assert.equal(result.returned, true)
  assert.equal(result.visitedPrefix.at(-1).x, original.x)
  assert.equal(f.calls.find(c => c.type === 'start').target.x, 1.5)
  const far = fixture(); far.arrive(p(8.5))
  assert.equal((await far.route.returnRoute([p(0.5), p(1.5)], { scope: far.scope })).code, 'INVALID_PREFIX')
})

test('a bounded return settle handles known airborne knockback before the reverse route', async () => {
  const f = fixture()
  f.arrive(p(2.9)); f.state.position.y += 0.3; f.state.predicted.physicsState.onGround = false
  f.movement.settle = options => { f.calls.push({ type: 'settle', options }); f.arrive(p(2.9)); return { phase: 'awaiting_server_confirmation' } }
  const result = await f.route.returnRoute([p(0.5), p(1.5)], { scope: f.scope })
  assert.equal(result.returned, true)
  assert.equal(f.calls.find(c => c.type === 'settle').options.emergency, true)
  assert.equal(f.calls.find(c => c.type === 'settle').options.maxTicks, 40)
})

test('actual equip GUI is closed before input and a callback claim alone cannot certify refuge closure', async () => {
  const f = fixture({ onEquip: ({ state }) => { state.crafting = { openContainer: { windowId: 7 } } }, onClose: ({ state, calls }) => { calls.push({ type: 'close_gui' }); state.crafting.openContainer = null } })
  assert.equal((await f.route.execute([p(1.5)])).outwardCompleted, true)
  assert.ok(f.calls.findIndex(c => c.type === 'close_gui') < f.calls.findIndex(c => c.type === 'start'))
  const claimed = fixture({ onReturned: () => ({ inside: true, closed: true, usable: true, serverConfirmed: true }) })
  claimed.arrive(p(2.5)); claimed.actors.push(claimed.enemy('creeper', 4.5))
  const result = await claimed.route.returnRoute([p(0.5), p(1.5), p(2.5)], { scope: claimed.scope })
  assert.equal(result.returned, false)
  assert.equal(result.refugeConfirmed, false)
})

test('explicit bootstrap bounds allow the finite starter route without removing strict node and distance ceilings', async () => {
  const f = fixture()
  f.state.inventory.items = []; f.state.heldItem = null
  const path = Array.from({ length: 12 }, (_, i) => p(1.5 + i))
  assert.throws(() => f.route.execute(path, { allowUnarmedBootstrap: true }), error => error.code === 'BOOTSTRAP_LIMIT')
  const result = await f.route.execute(path, { allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(result.outwardCompleted, true)
  for (const options of [{ maxBootstrapNodes: 65 }, { maxBootstrapNodes: '16' }, { maxBootstrapNodes: null }, { maxBootstrapDistance: 49 }, { maxBootstrapDistance: Infinity }, { maxBootstrapDistance: '16' }, { maxBootstrapDistance: null }]) assert.throws(() => f.route.execute([], { allowUnarmedBootstrap: true, ...options }), error => error.code === 'INVALID_BOUNDS')
  assert.throws(() => f.route.execute(path, { allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 10 }), error => error.code === 'BOOTSTRAP_LIMIT')
})

test('an asynchronous in-flight hit cancels the old actor and finishes its cleanup before any reverse movement', async () => {
  let hit = false
  const f = fixture({ onStart: ({ state, target, options }) => {
    if (hit || target.x !== 2.5) return
    hit = true
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { setTimeout(() => reject(options.signal.reason), 10) }, { once: true })
      setTimeout(() => { state.health = 19; state.position.x = 2.1; state.positionUpdatedAt++ }, 15)
    })
  } })
  const result = await f.route.execute([p(1.5), p(2.5), p(3.5)])
  assert.equal(result.returned, true)
  const attempts = f.calls.filter(c => c.type === 'start')
  assert.deepEqual(attempts.map(c => c.target.x), [1.5, 2.5, 1.5, 0.5])
  assert.ok(f.calls.some(c => c.type === 'stop' && /Late cancelled/.test(c.reason)))
  assert.equal(f.route.snapshot().busy, false)
})

test('an unconfirmed delayed stop prevents success and fences the next route until cleanup really finishes', async () => {
  const f = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const stop = f.movement.stop
  f.movement.stop = reason => gate.then(() => stop(reason))
  const result = await f.route.execute([p(1.5)])
  assert.equal(result.ok, false)
  assert.equal(result.arrived, false)
  assert.equal(result.returned, false)
  assert.equal(result.code, 'CLEANUP_UNCONFIRMED')
  assert.equal(f.route.snapshot().busy, true)
  assert.throws(() => f.route.execute([p(2.5)]), error => error.code === 'BUSY')
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.route.snapshot().busy, false)
})

test('a supported final correction after the last leg cannot certify outward arrival or completed return', async () => {
  for (const returning of [false, true]) {
    const endpoint = returning ? 0.5 : 1.5
    const f = fixture({ onProgress: ({ event, state }) => {
      if (event.reached?.x === endpoint) { state.position.x = 4.5; state.positionUpdatedAt++; state.positionSource = 'correct_player_move_prediction' }
    } })
    let result
    if (returning) { f.arrive(p(2.5)); result = await f.route.returnRoute([p(0.5), p(1.5), p(2.5)], { scope: f.scope }) } else result = await f.route.execute([p(1.5)])
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ARRIVAL_UNCONFIRMED')
    assert.equal(result.arrived, false)
    assert.equal(result.returned, false)
    assert.equal(result.outwardCompleted, false)
    assert.equal(result.position.x, 4.5)
    assert.equal(f.progress.some(event => event.phase === 'returned' || event.phase === 'completed'), false)
  }
})

test('the same pursuer closing by a hundredth during escape acceleration does not interrupt an otherwise away route', async () => {
  for (const type of ['skeleton', 'creeper']) {
    const f = fixture({ onStart: ({ state, actors, target, options, arrive }) => {
      if (!options.emergency) return
      const change = target.x - state.position.x
      arrive(target)
      actors[0].position.x += change - 0.01
      return { phase: 'awaiting_server_confirmation' }
    }, onReturned: ({ state }) => { state.hut = { inside: true, closed: true, usable: true, serverConfirmed: true } } })
    f.arrive(p(3.5)); f.actors.push(f.enemy(type, 9.5))
    const result = await f.route.execute([p(4.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5), p(3.5)], scope: f.scope })
    assert.equal(result.returned, true)
    assert.equal(result.refugeConfirmed, true)
    assert.equal(result.interruptions, 1, 'the initial danger stops outward; simple pursuit must not repeatedly stop escape')
    assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [2.5, 1.5, 0.5])
    assert.equal(f.calls.some(c => c.type === 'engage'), false)
  }
})

test('known pursuit does not permit a changed actor, a charged creeper, unknown position or a route that now approaches it', async () => {
  for (const kind of ['replacement', 'charged', 'unknown', 'ahead']) {
    let changed = false
    const f = fixture({ onStart: ({ actors, target, options, arrive }) => {
      if (!options.emergency || changed) return
      changed = true; arrive(target)
      if (kind === 'replacement') actors[0].uniqueId = 'different'
      if (kind === 'charged') actors[0].charged = true
      if (kind === 'unknown') { actors[0].positionKnown = false; actors[0].position = null }
      if (kind === 'ahead') actors[0].position.x = target.x - 1
      return { phase: 'awaiting_server_confirmation' }
    } })
    f.arrive(p(3.5)); f.actors.push(f.enemy('creeper', 9.5))
    const result = await f.route.execute([p(4.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5), p(3.5)], scope: f.scope })
    if (kind !== 'replacement') assert.equal(result.arrived, false)
    assert.equal(result.outwardCompleted, false)
    assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'NEARBY_THREAT') || result.code === 'THREAT_OBSERVATION_UNKNOWN', true)
    const firstStart = f.calls.findIndex(c => c.type === 'start')
    assert.ok(f.calls.slice(firstStart + 1).some(c => c.type === 'stop'))
    assert.equal(f.calls.some(c => c.type === 'engage'), false)
  }
})

test('a new dangerous actor still stops an escape immediately instead of joining the pursuit exemption', async () => {
  let added = false
  const f = fixture({ onStart: ({ actors, target, options, arrive }) => {
    if (!options.emergency || added) return
    added = true; arrive(target)
    actors.push(f.enemy('zombie', 8.5, '10'))
    return { phase: 'awaiting_server_confirmation' }
  } })
  f.arrive(p(3.5)); f.actors.push(f.enemy('creeper', 9.5))
  await f.route.execute([p(4.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5), p(3.5)], scope: f.scope })
  assert.ok(f.progress.filter(event => event.phase === 'interrupted').length >= 2)
  assert.equal(f.calls.some(c => c.type === 'start' && c.target.x === 4.5), false)
})

test('a slight known pursuit during an unfinished movement keeps the remaining safe escape segments running', async () => {
  const f = fixture({ realDelay: true, onStart: ({ state, actors, target, options, arrive, setMotion }) => {
    if (!options.emergency) return
    state.position.x -= 0.1; state.positionUpdatedAt++
    actors[0].position.x -= 0.11
    setMotion({ phase: 'moving' })
    setTimeout(() => arrive(target), 15)
    return { phase: 'moving' }
  }, onReturned: ({ state }) => { state.hut = { inside: true, closed: true, usable: true, serverConfirmed: true } } })
  f.arrive(p(3.5)); f.actors.push(f.enemy('skeleton', 9.5))
  const result = await f.route.execute([p(4.5)], { visitedPrefix: [p(0.5), p(1.5), p(2.5), p(3.5)], scope: f.scope })
  assert.equal(result.returned, true)
  assert.equal(result.interruptions, 1)
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [2.5, 1.5, 0.5])
})

test('explicit escape leaves a currently known threat along safe segments without invoking return or resource completion', async () => {
  let returned = 0
  const f = fixture({ onReturned: () => { returned++; throw new Error('Escape success must not return to the Hut') } })
  f.arrive(p(3.5)); f.actors.push(f.enemy('creeper', 9.5))
  const raw = structuredClone(f.state.rawServerPosition)
  const result = await f.route.escape([p(2.5), p(1.5), p(0.5)])
  assert.equal(result.ok, true)
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.returned, false)
  assert.equal(result.refugeConfirmed, false)
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(returned, 0)
  assert.ok(f.calls.filter(c => c.type === 'start').every(c => c.options.emergency && c.options.sprint && !c.options.allowWater))
  assert.deepEqual(result.visitedPrefix.map(point => point.x), [3.5, 2.5, 1.5, 0.5])
  assert.deepEqual(f.state.rawServerPosition, raw)
})

test('escape is explicit and needs an actual known current threat; ordinary outward still refuses danger', async () => {
  const clear = fixture()
  const unnecessary = await clear.route.escape([p(1.5)])
  assert.equal(unnecessary.code, 'ESCAPE_NOT_REQUIRED')
  assert.equal(unnecessary.escaped, false)
  assert.equal(clear.calls.some(c => c.type === 'start'), false)
  const ordinary = fixture(); ordinary.arrive(p(3.5)); ordinary.actors.push(ordinary.enemy('creeper', 9.5))
  const refused = await ordinary.route.execute([p(2.5)], { escapeOnly: true })
  assert.equal(refused.escaped, false)
  assert.equal(refused.outwardCompleted, false)
  assert.equal(ordinary.calls.some(c => c.type === 'start'), false)
  assert.throws(() => ordinary.route.escape([]), error => error.code === 'INVALID_ROUTE')
})

test('an escape endpoint that remains within the danger radius reports remaining risk without pretending refuge or safety', async () => {
  const f = fixture()
  f.arrive(p(3.5)); f.actors.push(f.enemy('skeleton', 9.5))
  const result = await f.route.escape([p(2.5)])
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.riskRemains, true)
  assert.equal(result.currentThreats.length, 1)
  assert.equal(result.returned, false)
  assert.equal(result.refugeConfirmed, false)
  assert.equal(result.safe, false)
  assert.equal(f.progress.at(-1).phase, 'escaped')
  assert.equal(f.progress.at(-1).urgent, true)
})

test('an escape hit stops immediately and can keep the freshly validated away direction instead of reversing toward the pursuer', async () => {
  let hit = false; let returned = false
  const f = fixture({ onStart: ({ state, target, setMotion }) => {
    if (hit) return
    hit = true; state.health = 19; state.position.x = 3; state.positionUpdatedAt++; setMotion({ phase: 'moving' }); return { phase: 'moving' }
  }, onReturned: () => { returned = true } })
  f.arrive(p(3.5)); f.actors.push(f.enemy('creeper', 9.5))
  const result = await f.route.escape([p(2.5), p(1.5), p(0.5)])
  assert.equal(result.escaped, true)
  assert.equal(result.interruptions, 1)
  assert.equal(returned, false)
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [2.5, 2.5, 1.5, 0.5])
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'TOOK_DAMAGE'), true)
})

test('an escape cannot continue or reverse when a new actor blocks the forward route and the original pursuer blocks the reverse', async () => {
  let added = false
  const f = fixture({ onStart: ({ actors, target, arrive }) => {
    if (added) return
    added = true; arrive(target); actors.push(f.enemy('skeleton', 0.5, '10')); return { phase: 'awaiting_server_confirmation' }
  } })
  f.arrive(p(3.5)); f.actors.push(f.enemy('creeper', 9.5))
  const result = await f.route.escape([p(2.5), p(1.5), p(0.5)])
  assert.equal(result.escaped, false)
  assert.equal(result.arrived, false)
  assert.equal(result.returned, false)
  assert.equal(result.safe, false)
  assert.equal(f.calls.some(c => c.type === 'engage'), false)
  assert.deepEqual(f.calls.filter(c => c.type === 'start').map(c => c.target.x), [2.5])
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'NEARBY_THREAT'), true)
})

test('escape preserves the strict sword default and bounded explicit bootstrap permission', async () => {
  const required = fixture(); required.state.inventory.items = []; required.state.heldItem = null; required.actors.push(required.enemy('spider', 8.5))
  assert.equal((await required.route.escape([p(-0.5)])).code, 'SWORD_REQUIRED')
  const bootstrap = fixture(); bootstrap.state.inventory.items = []; bootstrap.state.heldItem = null; bootstrap.actors.push(bootstrap.enemy('spider', 8.5))
  const result = await bootstrap.route.escape([p(-0.5), p(-1.5)], { allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(result.escaped, true)
  assert.equal(result.safe, false)
  assert.throws(() => bootstrap.route.escape(Array.from({ length: 17 }, (_, index) => p(-index)), { allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 }), error => error.code === 'BOOTSTRAP_LIMIT')
})

test('constrained one-step escape allows a bounded approach to a distant secondary skeleton', async () => {
  const setup = extra => {
    const f = fixture(extra)
    f.state.health = 10
    f.state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]
    f.state.heldItem = { ...f.state.inventory.items[0] }
    f.actors.push(f.enemy('zombie', 6), f.enemy('skeleton', -20, '10'))
    return f
  }
  const strict = setup(); assert.equal((await strict.route.escape([p(-0.5)])).arrived, false)
  const limited = setup(); const result = await limited.route.escape([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 })
  assert.equal(result.arrived, true)
  assert.equal(result.riskRemains, true)
  assert.equal(result.safe, false)
  const clipped = setup(); clipped.actors[1].position.x = -18
  const clippedResult = await clipped.route.escape([p(0)], { allowConstrainedEscape: true, maxLegDistance: 2 })
  assert.equal(clippedResult.arrived, true, 'limited approach remains above the absolute 18-block floor')
  for (const change of ['health', 'weapon', 'secondary_near', 'identity', 'damage', 'approach', 'new_enemy']) {
    const f = setup(['identity', 'damage', 'approach', 'new_enemy'].includes(change) ? { onStart: ({ state, actors, target, arrive }) => { if (change === 'identity') actors[1].uniqueId = 'other'; if (change === 'damage') state.health--; if (change === 'approach') actors[1].position.x = -17; if (change === 'new_enemy') actors.push({ ...actors[0], runtimeId: '11', uniqueId: '11' }); arrive(target); return { phase: 'awaiting_server_confirmation' } } } : {})
    if (change === 'health') f.state.health = 6
    if (change === 'weapon') f.state.heldItem = null
    if (change === 'secondary_near') f.actors[1].position.x = -18
    const out = await f.route.escape([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 })
    assert.equal(out.arrived, false, change)
  }
  const invalid = setup()
  assert.throws(() => invalid.route.escape([p(-0.5), p(-1.5)], { allowConstrainedEscape: true, maxLegDistance: 2 }), /one short/)
  assert.throws(() => invalid.route.execute([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 }), /one short/)
  const wrongUnarmed = setup()
  const wrongUnarmedResult = await wrongUnarmed.route.escape([p(-0.5)], { allowConstrainedEscape: true, allowUnarmedBootstrap: true, maxLegDistance: 2 })
  assert.equal(wrongUnarmedResult.code, 'INVALID_BOUNDS')
  assert.equal(wrongUnarmed.calls.some(call => call.type === 'start'), false)
  const detour = setup({ onPreview: ({ target }) => ({ ready: true, waypoints: [{ position: p(-0.3), action: 'walk', medium: 'land' }, { position: target, action: 'walk', medium: 'land' }] }) })
  const rejected = await detour.route.escape([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 })
  assert.equal(rejected.arrived, false)
  assert.equal(rejected.routeRejection.reason, 'constrained_requires_one_segment')
  assert.equal(detour.calls.some(call => call.type === 'start'), false)
})

test('constrained escape limits approach to a secondary spider and rejects a closer or replaced spider', async () => {
  const setup = extra => {
    const f = fixture(extra); f.state.health = 9.631
    f.state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.state.heldItem = { ...f.state.inventory.items[0] }
    f.actors.push(f.enemy('creeper', 6), f.enemy('spider', -11, '10'))
    return f
  }
  const strict = setup(); assert.equal((await strict.route.escape([p(-0.5)])).arrived, false)
  const limited = setup(); assert.equal((await limited.route.escape([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 })).arrived, true)
  for (const mode of ['too_close', 'replacement', 'rush']) {
    const f = setup(mode === 'replacement' || mode === 'rush' ? { onStart: ({ actors, target, arrive }) => { if (mode === 'replacement') actors[1].uniqueId = 'other'; else actors[1].position.x = -7; arrive(target); return { phase: 'awaiting_server_confirmation' } } } : {})
    if (mode === 'too_close') f.actors[1].position.x = -8
    assert.equal((await f.route.escape([p(-0.5)], { allowConstrainedEscape: true, maxLegDistance: 2 })).arrived, false, mode)
  }
})

test('long unarmed legs are explicit escape only and retain total budgets, current danger and whole-preview dry validation', async () => {
  const options = { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 32, maxBootstrapDistance: 24 }
  const unarmed = extra => {
    const f = fixture(extra)
    f.state.inventory.items = []; f.state.heldItem = null
    f.actors.push(f.enemy('creeper', 5.5))
    return f
  }
  const ordinary = unarmed()
  assert.throws(() => ordinary.route.execute([p(-7.5)], options), error => error.code === 'BOOTSTRAP_LIMIT')
  assert.throws(() => ordinary.route.returnRoute([p(-7.5), p(0.5)], { ...options, scope: ordinary.scope }), error => error.code === 'BOOTSTRAP_LIMIT')
  assert.throws(() => ordinary.route.escape([p(-7.5)], { ...options, maxLegDistance: 12.01 }), error => error.code === 'INVALID_BOUNDS')
  assert.throws(() => ordinary.route.escape(Array.from({ length: 33 }, (_, index) => p(0.5 - index * 0.25)), options), error => error.code === 'BOOTSTRAP_LIMIT')
  assert.throws(() => ordinary.route.escape([p(0.5), p(-10.5), p(-21.5), p(-25.5)], options), error => error.code === 'BOOTSTRAP_LIMIT')
  const tooFar = unarmed()
  assert.equal((await tooFar.route.escape([p(-7.5)], { ...options, maxBootstrapDistance: 7 })).code, 'BOOTSTRAP_LIMIT')
  assert.equal(tooFar.calls.some(call => call.type === 'start'), false)
  const peaceful = unarmed(); peaceful.actors.length = 0
  assert.equal((await peaceful.route.escape([p(-7.5)], options)).code, 'ESCAPE_NOT_REQUIRED')
  for (const kind of ['water', 'unknown', 'unsafe_detour']) {
    const f = unarmed({ onPreview: ({ target }) => kind === 'unknown' ? { ready: false, reason: 'Unknown terrain' } : { ready: true, waypoints: [{ position: p(kind === 'unsafe_detour' ? 4.5 : -2.5), medium: kind === 'water' ? 'water' : 'land', action: kind === 'water' ? 'swim' : 'walk' }, { position: target, medium: 'land', action: 'walk' }] } })
    const result = await f.route.escape([p(-7.5)], options)
    assert.equal(result.escaped, false, kind)
    assert.equal(f.calls.some(call => call.type === 'start'), false, kind)
  }
})

test('explicit bootstrap accepts at most sixty-four nodes and forty-eight blocks while defaults and ordinary two-block legs stay unchanged', async () => {
  const f = fixture()
  f.state.inventory.items = []; f.state.heldItem = null
  const route = Array.from({ length: 64 }, (_, index) => p(0.5 + index * 48 / 63))
  assert.throws(() => f.route.execute(route, { allowUnarmedBootstrap: true }), error => error.code === 'BOOTSTRAP_LIMIT', 'the default eight-node limit is unchanged')
  const distanceOnly = Array.from({ length: 8 }, (_, index) => p(0.5 + index * 2))
  assert.throws(() => f.route.execute(distanceOnly, { allowUnarmedBootstrap: true }), error => error.code === 'BOOTSTRAP_LIMIT', 'the default twelve-block limit is unchanged')
  assert.throws(() => f.route.execute(route, { allowUnarmedBootstrap: true, maxBootstrapNodes: 64, maxBootstrapDistance: 40 }), error => error.code === 'BOOTSTRAP_LIMIT')
  assert.throws(() => f.route.execute(route, { allowUnarmedBootstrap: true, maxBootstrapNodes: 64, maxBootstrapDistance: 48, maxLegDistance: 3 }), error => error.code === 'BOOTSTRAP_LIMIT')
  for (const value of [0, -1, 64.1, 65, NaN, Infinity, '64', null]) assert.throws(() => f.route.execute([], { allowUnarmedBootstrap: true, maxBootstrapNodes: value }), error => error.code === 'INVALID_BOUNDS')
  for (const value of [0, -1, 48.00001, 49, NaN, Infinity, '48', null]) assert.throws(() => f.route.execute([], { allowUnarmedBootstrap: true, maxBootstrapDistance: value }), error => error.code === 'INVALID_BOUNDS')
  const result = await f.route.execute(route, { allowUnarmedBootstrap: true, maxBootstrapNodes: 64, maxBootstrapDistance: 48 })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.outwardCompleted, true)
  assert.equal(result.visitedPrefix.length, 64)
  assert.equal(result.visitedPrefix.at(-1).x - result.visitedPrefix[0].x, 48)
  assert.ok(f.calls.filter(call => call.type === 'start').every(call => call.options.maxDistance === 2))
})

test('route rejection records a bounded invalid-preview contract through successful return and resets on the next execute', async () => {
  let invalid = true
  const f = fixture({ onPreview: ({ target }) => invalid ? { ready: true, origin: p(0.5), target, reason: 'r'.repeat(2000), privatePayload: 'never copy arbitrary data', waypoints: Array.from({ length: 20 }, () => ({ position: target, action: 'walk', medium: 'not-land-' + 'x'.repeat(200) })) } : undefined })
  const result = await f.route.execute([p(1.5)])
  assert.equal(result.returned, true)
  assert.equal(result.outwardCompleted, false)
  const rejection = result.routeRejection
  assert.equal(rejection.reason, 'invalid_route')
  assert.equal(rejection.detail, 'unsupported_waypoint')
  assert.equal(rejection.mode, 'outward')
  assert.equal(rejection.preview.ready, true)
  assert.equal(rejection.preview.waypointCount, 20)
  assert.equal(rejection.preview.waypoints.length, 6)
  assert.equal(rejection.preview.reason.length, 500)
  assert.equal(rejection.preview.waypoints[0].medium.length, 40)
  assert.equal(JSON.stringify(rejection).includes('privatePayload'), false)
  assert.ok(JSON.stringify(rejection).length < 5000)
  assert.equal(f.calls.some(c => c.type === 'start'), false)
  rejection.preview.waypoints[0].position.x = 999
  assert.equal(f.route.snapshot().routeRejection.preview.waypoints[0].position.x, 1.5)
  invalid = false
  const next = await f.route.execute([p(1.5)])
  assert.equal(next.outwardCompleted, true)
  assert.equal(next.routeRejection, null)
})

test('target mismatch diagnostics retain feet preview coordinates and the latest real eye pose', async () => {
  const f = fixture({ onPreview: ({ target }) => ({ ready: true, origin: p(0.5), target: p(target.x + 1), waypoints: [{ position: p(target.x + 1), action: 'walk', medium: 'land' }] }) })
  const result = await f.route.execute([p(1.5)])
  const rejection = result.routeRejection
  assert.equal(rejection.reason, 'target_mismatch')
  assert.equal(rejection.distance, 1)
  assert.equal(rejection.required, 0.4)
  assert.deepEqual(rejection.requestedTarget, p(1.5))
  assert.deepEqual(rejection.preview.origin, p(0.5))
  assert.deepEqual(rejection.preview.target, p(2.5))
  assert.deepEqual(rejection.latestPose.position, { ...p(0.5), y: 61.62 })
  assert.equal(result.movementStarts, 0)
})

test('an outside-danger actor that the planned segment approaches records its exact radius rejection', async () => {
  const f = fixture()
  f.actors.push(f.enemy('skeleton', 25.5))
  const result = await f.route.execute([p(2)])
  const rejection = result.routeRejection
  assert.equal(rejection.reason, 'actor_radius')
  assert.equal(rejection.actorId, '9')
  assert.equal(rejection.actorName, 'minecraft:skeleton')
  assert.equal(rejection.segment.index, 0)
  assert.ok(rejection.minDistance < rejection.required)
  assert.equal(rejection.required, 24)
  assert.equal(result.movementStarts, 0)
  assert.equal(result.returned, true)
})

test('an escape that does not gain enough primary-threat separation records the gain requirement', async () => {
  const f = fixture()
  f.actors.push(f.enemy('creeper', 6.5))
  const result = await f.route.escape([{ x: 0.5, y: 60, z: 1.5 }])
  assert.equal(result.routeRejection.reason, 'primary_no_gain')
  assert.equal(result.routeRejection.mode, 'escape')
  assert.equal(result.routeRejection.actorId, '9')
  assert.ok(result.routeRejection.minDistance < result.routeRejection.required)
  assert.equal(result.movementStarts, 0)
})

test('fresh midair corrections land within the same forward, escape and return leg before completing it', async () => {
  for (const mode of ['forward', 'escape', 'return']) {
    let first = true; let goal
    const f = fixture({ onStart: ({ state, target, setMotion }) => {
      if (!first) return
      first = false; goal = structuredClone(target)
      state.position = { ...target, y: target.y + 1.62 + 0.2315238 }
      state.positionUpdatedAt++; state.rawServerPositionUpdatedAt = state.positionUpdatedAt
      state.rawServerPosition = { ...state.position }; state.positionSource = 'correct_player_move_prediction'
      state.predicted = { physicsState: { onGround: false, velocity: { x: 0, y: -0.3, z: 0 } } }
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    f.movement.settle = options => { f.calls.push({ type: 'settle', options }); f.arrive(goal); return { phase: 'awaiting_server_confirmation' } }
    let result
    if (mode === 'return') {
      f.arrive({ ...p(1.5), y: 61 })
      result = await f.route.returnRoute([p(0.5), { ...p(1.5), y: 61 }], { scope: f.scope })
    } else if (mode === 'escape') {
      f.actors.push({ ...f.enemy('creeper', 6.5), position: { ...p(6.5), y: 63 } })
      result = await f.route.escape([{ ...p(-0.5), y: 59 }])
    } else result = await f.route.execute([{ ...p(1.5), y: 59 }])
    assert.equal(result.ok, true, `${mode}: ${result.reason}`)
    assert.equal(result.movementStarts, 2, 'one real movement start plus one bounded landing start')
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
    const settle = f.calls.find(call => call.type === 'settle')
    assert.equal(settle.options.maxTicks, 40)
    assert.equal(settle.options.maxDrop, 1)
    assert.equal(settle.options.maxHorizontal, 1)
    assert.equal(settle.options.emergency, true)
    assert.equal(result.escaped, mode === 'escape')
    assert.equal(result.returned, mode === 'return')
    assert.equal(result.outwardCompleted, mode === 'forward')
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.state.rawServerPosition.y, goal.y + 1.62 + 0.2315238, 'landing prediction cannot rewrite received server pose')
  }
})

test('ordinary unsupported origins and stale corrections cannot activate the same-leg landing fallback', async () => {
  const airborne = fixture()
  airborne.state.position.y += 0.23; airborne.state.predicted.physicsState.onGround = false
  airborne.movement.settle = () => { throw new Error('Must not settle an arbitrary outward origin') }
  assert.equal((await airborne.route.execute([p(1.5)])).code, 'SUPPORT_UNKNOWN')
  const stale = fixture({ onStart: ({ state, target, setMotion }) => {
    state.position = { ...target, y: target.y + 1.62 + 0.23 }; state.predicted.physicsState.onGround = false
    setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
  } })
  let settles = 0; stale.movement.settle = () => { settles++; return {} }
  const result = await stale.route.execute([p(1.5)])
  assert.equal(result.arrived, false)
  assert.equal(settles, 0)
})

test('correction landing consumes the existing start budget and cannot extend the fixed route deadline', async () => {
  for (const mode of ['budget', 'deadline']) {
    let setMotion
    const f = fixture({ onStart: context => {
      setMotion = context.setMotion
      context.state.position = { ...context.target, y: context.target.y + 1.62 + 0.23 }
      context.state.positionUpdatedAt++; context.state.rawServerPositionUpdatedAt = context.state.positionUpdatedAt
      context.state.predicted.physicsState.onGround = false
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    let settles = 0
    f.movement.settle = () => { settles++; setMotion({ phase: 'settling' }); return { phase: 'settling' } }
    const result = await f.route.execute([{ ...p(1.5), y: 59 }], mode === 'budget' ? { maxMovementStarts: 1 } : { timeoutMs: 100 })
    assert.equal(result.arrived, false)
    assert.equal(result.outwardCompleted, false)
    assert.equal(result.code, mode === 'budget' ? 'START_LIMIT' : 'TIMEOUT')
    assert.equal(settles, mode === 'budget' ? 0 : 1)
  }
})

test('water, new damage, new actor and changed scope still stop the correction-landing path', async () => {
  for (const mode of ['water', 'damage', 'actor', 'scope']) {
    let setMotion
    const f = fixture({ onStart: context => {
      setMotion = context.setMotion
      context.state.position = { ...context.target, y: context.target.y + 1.62 + 0.23 }
      context.state.positionUpdatedAt++; context.state.rawServerPositionUpdatedAt = context.state.positionUpdatedAt
      context.state.predicted.physicsState.onGround = false
      if (mode === 'water') context.state.predicted.physicsState.isInWater = true
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    let settles = 0
    f.movement.settle = () => {
      settles++; setMotion({ phase: 'settling' })
      if (mode === 'damage') f.state.health--
      if (mode === 'actor') f.actors.push(f.enemy('creeper', 5.5))
      if (mode === 'scope') f.state.realm.id = 'different'
      return { phase: 'settling' }
    }
    const result = await f.route.execute([{ ...p(1.5), y: 59 }])
    assert.equal(result.arrived, false)
    assert.equal(result.outwardCompleted, false)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
    assert.equal(settles, mode === 'water' ? 0 : 1)
    if (mode === 'damage') assert.equal(f.progress.some(event => event.code === 'TOOK_DAMAGE'), true)
    if (mode === 'actor') assert.equal(f.progress.some(event => event.code === 'NEARBY_THREAT'), true)
    if (mode === 'scope') assert.equal(result.code, 'SESSION_CHANGED')
  }
})

test('landing outside the one-block envelope or without a fresh pose cannot certify a corrected arrival', async () => {
  for (const mode of ['horizontal', 'drop', 'stale']) {
    let goal
    const f = fixture({ onStart: ({ state, target, setMotion }) => {
      goal = target; state.position = { ...target, y: target.y + 1.62 + 0.23 }
      state.positionUpdatedAt++; state.rawServerPositionUpdatedAt = state.positionUpdatedAt; state.predicted.physicsState.onGround = false
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    f.movement.settle = () => {
      const stamp = f.state.positionUpdatedAt
      f.arrive({ ...goal, x: goal.x + (mode === 'horizontal' ? 1.1 : 0), y: goal.y - (mode === 'drop' ? 1 : 0) })
      if (mode === 'stale') f.state.positionUpdatedAt = stamp
      return { phase: 'awaiting_server_confirmation' }
    }
    const result = await f.route.execute([{ ...p(1.5), y: 59 }])
    assert.equal(result.arrived, false)
    assert.equal(result.code, 'SUPPORT_UNKNOWN')
  }
})

test('the landing oracle rejecting unknown terrain is fatal and cannot become a fresh supported arrival', async () => {
  const f = fixture({ onStart: ({ state, target, setMotion }) => {
    state.position = { ...target, y: target.y + 1.62 + 0.23 }; state.positionUpdatedAt++; state.rawServerPositionUpdatedAt = state.positionUpdatedAt; state.predicted.physicsState.onGround = false
    setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
  } })
  f.movement.settle = () => { throw new Error('Unknown terrain: next supporting section was not received') }
  const result = await f.route.execute([{ ...p(1.5), y: 59 }])
  assert.equal(result.code, 'SUPPORT_UNKNOWN')
  assert.match(result.reason, /Unknown terrain/)
  assert.equal(result.arrived, false)
  assert.equal(result.returned, false)
  assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
})

test('tiny and zero fresh actual raw corrections earn only the existing bounded same-goal retry', async () => {
  for (const advance of [0, 0.05]) {
    let starts = 0
    const f = fixture({ onStart: ({ state, setMotion }) => {
      if (++starts !== 1) return
      state.position.x += advance; state.positionUpdatedAt++
      state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = state.positionUpdatedAt
      state.positionSource = 'correct_player_move_prediction'
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    const result = await f.route.execute([p(1.5)])
    assert.equal(result.outwardCompleted, true, result.reason)
    assert.equal(result.movementStarts, 2)
    assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target.x), [1.5, 1.5])
    assert.equal(result.serverConfirmed, false, 'the eventual client prediction must remain unconfirmed')
    assert.equal(f.state.rawServerPosition.x, 0.5 + advance)
  }
})

test('three fresh zero-displacement corrections stop at REPLAN_LIMIT without completing the outward goal', async () => {
  const f = fixture({ onStart: ({ state, setMotion }) => {
    state.positionUpdatedAt++
    state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = state.positionUpdatedAt
    state.positionSource = 'correct_player_move_prediction'
    setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
  } })
  const result = await f.route.execute([p(1.5)])
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.escaped, false)
  assert.equal(result.code, 'REPLAN_LIMIT')
  assert.equal(result.movementStarts, 3)
  assert.equal(f.calls.filter(call => call.type === 'start').length, 3)
  assert.deepEqual(result.visitedPrefix, [p(0.5)])
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'REPLAN_LIMIT'), true)
})

test('stale raw timestamps and prediction-only timestamps cannot earn tiny-correction retries', async () => {
  for (const mode of ['stale_raw', 'local_only', 'missing_raw_pose']) {
    const f = fixture({ onStart: ({ state, setMotion }) => {
      state.position.x += 0.05; state.positionUpdatedAt++
      state.positionSource = 'client_prediction'
      if (mode === 'missing_raw_pose') { state.rawServerPositionUpdatedAt++; state.rawServerPosition = null }
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    if (mode === 'local_only') { delete f.state.rawServerPosition; f.state.positionSource = 'client_prediction' } else f.state.rawServerPositionUpdatedAt = 0
    const result = await f.route.execute([p(1.5)])
    assert.equal(result.outwardCompleted, false)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
    assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'NO_MOVEMENT_PROGRESS'), true)
  }
})

test('fresh zero corrections cannot bypass damage, inventory, threat or water checks', async () => {
  for (const mode of ['damage', 'inventory', 'actor', 'water']) {
    const f = fixture({ onStart: ({ state, actors, setMotion }) => {
      state.positionUpdatedAt++; state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = state.positionUpdatedAt; state.positionSource = 'correct_player_move_prediction'
      if (mode === 'damage') state.health--
      if (mode === 'inventory') state.inventory.known = false
      if (mode === 'actor') actors.push(f.enemy('creeper', 4.5))
      if (mode === 'water') state.predicted.physicsState.isInWater = true
      setMotion({ phase: 'replan_required' }); return { phase: 'replan_required' }
    } })
    const result = await f.route.execute([p(1.5)])
    assert.equal(result.outwardCompleted, false)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
    if (mode === 'inventory') assert.equal(result.code, 'INVENTORY_UNKNOWN')
    if (mode === 'water') assert.equal(result.code, 'SUPPORT_UNKNOWN')
  }
})

function rangedCover (state, entity, { thin = false } = {}) {
  const layers = thin ? [55] : [55, 56, 57]
  const world = { getBlock: (x, y, z) => ({ known: true, name: layers.includes(y) || y === 59 || y === 49 ? 'minecraft:stone' : 'minecraft:air', boundingBox: layers.includes(y) || y === 59 || y === 49 ? 'block' : 'empty', extra: [] }) }
  return buildTerrainThreatEvidence(state, entity, { world })
}

test('outward can enter the static radius of an outside actor only while its complete current terrain proof stays valid', async () => {
  const f = fixture({ onState: state => {
    for (const entity of state.entities) entity.terrainOcclusion = rangedCover(state, entity)
    return state
  } })
  f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } })
  const before = f.getState()
  assert.equal(before.entities[0].terrainOcclusion.suppressed, true)
  assert.ok(Math.hypot(22, 11.62) > 24)
  const result = await f.route.execute([p(2.5)])
  assert.equal(result.outwardCompleted, true)
  assert.equal(result.arrived, true)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.routeRejection, null)
  assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target.x), [2.5])
  assert.deepEqual(f.calls.find(call => call.type === 'preview').options.avoidance, [], 'valid current cover also excludes that outside actor from planning circles')
})

test('loss of cover during a short outward leg restores the real current threat and immediately interrupts into retreat', async () => {
  let intact = true
  const f = fixture({ onState: state => {
    for (const entity of state.entities) entity.terrainOcclusion = rangedCover(state, entity, { thin: !intact })
    return state
  }, onStart: ({ target, arrive }) => {
    if (!intact) return
    arrive(target); intact = false
    return { phase: 'awaiting_server_confirmation' }
  } })
  f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } })
  const result = await f.route.execute([p(2.5)])
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.returned, true)
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'NEARBY_THREAT'), true)
  assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target.x), [2.5, 0.5])
  assert.equal(f.calls.some(call => call.type === 'engage'), false)
})

test('outside-radius terrain exemptions reject stale, different-pose and thin-wall evidence', async () => {
  for (const mode of ['stale', 'pose', 'thin']) {
    const f = fixture({ onState: state => {
      for (const entity of state.entities) {
        entity.terrainOcclusion = rangedCover(state, entity, { thin: mode === 'thin' })
        if (mode === 'stale') entity.terrainOcclusion.createdAt -= 2000
        if (mode === 'pose') entity.terrainOcclusion.observerPosition.x += 0.01
      }
      return state
    } })
    f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } })
    const result = await f.route.execute([p(2.5)])
    assert.equal(result.outwardCompleted, false)
    assert.equal(result.movementStarts, 0)
    assert.equal(result.routeRejection.reason, 'actor_radius')
  }
})

test('a creeper cannot obtain an outside-radius terrain exemption even with copied thirteen-ray fields', async () => {
  const f = fixture({ onState: state => {
    const world = { getBlock: (x, y, z) => ({ known: true, name: x >= 2 && x <= 4 ? 'minecraft:stone' : 'minecraft:air', boundingBox: x >= 2 && x <= 4 ? 'block' : 'empty', extra: [] }) }
    for (const entity of state.entities) {
      const proof = buildTerrainThreatEvidence(state, { ...entity, entityType: 'minecraft:skeleton' }, { world })
      assert.equal(proof.suppressed, true)
      entity.terrainOcclusion = { ...proof, entityType: 'minecraft:creeper' }
    }
    return state
  } })
  f.actors.push({ ...f.enemy('creeper', 6.5), position: { ...p(6.5), y: 56 } })
  const result = await f.route.execute([{ ...p(1.5), y: 59 }])
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.movementStarts, 0)
  assert.equal(result.routeRejection.reason, 'actor_radius')
})

test('current complete cover consistently exempts an outside-radius actor during the known reverse route', async () => {
  let hit = false
  const f = fixture({ onState: state => {
    for (const entity of state.entities) entity.terrainOcclusion = rangedCover(state, entity)
    return state
  }, onStart: ({ state, setMotion }) => {
    if (hit) return
    hit = true; state.health--; state.position.x = -0.1; state.positionUpdatedAt++
    setMotion({ phase: 'moving' }); return { phase: 'moving' }
  } })
  f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } })
  const result = await f.route.execute([p(-0.5)], { visitedPrefix: [p(2.5), p(1.5), p(0.5)], scope: f.scope })
  assert.equal(result.outwardCompleted, false)
  assert.equal(result.returned, true)
  assert.equal(result.safe, false)
  assert.equal(result.routeRejection, null)
  assert.deepEqual(f.calls.filter(call => call.type === 'start').map(call => call.target.x), [-0.5, 0.5, 1.5, 2.5])
})

test('a return leg stops when its current complete cover disappears inside the actor radius', async () => {
  let intact = true
  const f = fixture({ onState: state => {
    for (const entity of state.entities) entity.terrainOcclusion = rangedCover(state, entity, { thin: !intact })
    return state
  }, onStart: ({ target, arrive }) => {
    if (!intact) return
    arrive(target); intact = false; return { phase: 'awaiting_server_confirmation' }
  } })
  f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } })
  const result = await f.route.returnRoute([p(2.5), p(0.5)], { scope: f.scope })
  assert.equal(result.returned, false)
  assert.equal(result.arrived, false)
  assert.equal(result.safe, false)
  assert.equal(f.progress.some(event => event.phase === 'interrupted' && event.code === 'NEARBY_THREAT'), true)
  assert.equal(f.calls.filter(call => call.type === 'start').length, 1)
})

test('return and escape still refuse stale, different-pose, thin or ineligible outside-actor cover', async () => {
  for (const mode of ['stale', 'pose', 'thin', 'creeper', 'boss']) {
    const f = fixture({ onState: state => {
      for (const entity of state.entities) {
        if (mode === 'creeper') {
          const world = { getBlock: (x, y, z) => ({ known: true, name: x >= 2 && x <= 4 ? 'minecraft:stone' : 'minecraft:air', boundingBox: x >= 2 && x <= 4 ? 'block' : 'empty', extra: [] }) }
          entity.terrainOcclusion = { ...buildTerrainThreatEvidence(state, { ...entity, entityType: 'minecraft:skeleton' }, { world }), entityType: entity.entityType }
        } else {
          entity.terrainOcclusion = { ...rangedCover(state, { ...entity, entityType: 'minecraft:skeleton' }, { thin: mode === 'thin' }), entityType: entity.entityType }
        }
        if (mode === 'stale') entity.terrainOcclusion.createdAt -= 2000
        if (mode === 'pose') entity.terrainOcclusion.observerPosition.x += 0.01
      }
      return state
    } })
    const target = mode === 'creeper' ? { ...p(1.5), y: 59 } : p(2.5)
    const actor = mode === 'creeper' ? { ...f.enemy('creeper', 6.5), position: { ...p(6.5), y: 56 } } : mode === 'boss' ? { ...f.enemy('wither', 30.7), position: { ...p(30.7), y: 50 } } : { ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } }
    f.actors.push(actor)
    const result = await f.route.returnRoute([target, p(0.5)], { scope: f.scope })
    assert.equal(result.returned, false)
    assert.equal(result.movementStarts, 0)
    assert.equal(result.routeRejection.reason, 'actor_radius')
  }
})

test('escape may pass a proven-covered outside actor while continuing to flee a real current threat', async () => {
  const f = fixture({ onState: state => {
    for (const entity of state.entities) if (entity.entityType === 'minecraft:skeleton') entity.terrainOcclusion = rangedCover(state, entity)
    return state
  } })
  f.actors.push({ ...f.enemy('skeleton', 22.5), position: { ...p(22.5), y: 50 } }, f.enemy('zombie', -5.5, '10'))
  const result = await f.route.escape([p(2.5)])
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.returned, false)
  assert.equal(result.safe, false)
  assert.equal(result.currentThreats.some(actor => actor.runtimeId === '10'), true, 'real current threats stay visible')
  assert.equal(result.routeRejection, null)
})
