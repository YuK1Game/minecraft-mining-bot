'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn, setTimeout: delay } = require('node:timers/promises')
const { createChunkTravel } = require('../src/chunk-travel')
const { observedScope } = require('../src/server-position-verifier')
const { areaContainsFeet } = require('../src/chunk-area')
const copy = value => structuredClone(value)
const feetOf = state => ({ x: state.position.x, y: state.position.y - 1.62, z: state.position.z })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function fixture (options = {}) {
  let clock = 100000, codeGeneration = 7, identity = { instanceId: 'old-paused-job', state: 'PAUSED' }, lease = null, motion = { phase: 'idle', running: false }
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'same-connection', startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '80', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20,
    position: { x: 0.5, y: 64.62, z: 0.5 }, inventory: { known: true, items: [] } }
  const events = [], plans = [], previews = [], moves = [], stops = [], witnesses = [], blocks = new Map()
  const getBlock = (x, y, z) => options.unknown ? { known: false } : blocks.get([x, y, z].join(',')) ?? { known: true, name: y < 63 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 63 ? 'block' : 'empty', extra: [] }
  const route = (target, planningOnly) => {
    const origin = feetOf(state), count = Math.ceil(distance(origin, target)), waypoints = []
    for (let i = 1; i <= count; i++) waypoints.push({ position: { x: origin.x + (target.x - origin.x) * i / count, y: origin.y + (target.y - origin.y) * i / count, z: origin.z + (target.z - origin.z) * i / count }, action: 'walk', medium: 'land' })
    return { ready: true, planningOnly, origin, target: copy(target), waypoints }
  }
  const ports = {
    getState: () => copy(state), getBlock, getMovement: () => copy(motion), generation: () => codeGeneration, jobIdentity: () => copy(identity), now: () => clock,
    sleep: async ms => { clock += Math.max(1, ms); await turn() }, uuid: () => '01234567-89ab-4cde-8123-456789abcdef', pollMs: 5,
    async acquire (id, value) { events.push('acquire'); lease = id; assert.equal(value.scope, observedScope(state)); await options.acquire?.(value) },
    async release (id) { assert.equal(id, lease); events.push('release'); lease = null },
    async planRoute (target, value) { plans.push({ target: copy(target), options: copy(value) }); await options.plan?.(state); return options.noRoute ? { ready: false } : route(target, true) },
    async previewMove (target, value) { previews.push({ target: copy(target), options: copy(value) }); await options.preview?.(state); return options.noShort ? { ready: false } : route(target, false) },
    startMove (target, value) {
      assert.equal(lease, value.operationId); assert.equal(value.allowWater, true); assert.equal(value.maxDistance, 6)
      options.beforeInput?.(state)
      assert.equal(value.beforeInput(), true)
      events.push('move'); moves.push({ origin: feetOf(state), target: copy(target), options: value })
      motion = { phase: options.hangMove ? 'moving' : 'awaiting_server_confirmation', running: options.hangMove === true, sent: 1 }
      if (!options.hangMove) state.position = { x: target.x, y: target.y + 1.62, z: target.z }
      return copy(motion)
    },
    stopMove (id, reason) { assert.equal(id, lease, 'cleanup may stop only its own lease'); stops.push({ id, reason }); motion = { ...motion, running: false, phase: 'stopped' } },
    async confirmPosition (feet, value) {
      witnesses.push(copy(feet)); events.push('witness'); await options.witness?.(state, feet, value)
      return { serverConfirmed: options.witnessOk !== false, kind: options.witnessKind ?? 'server_position_volume', scope: options.wrongScope ? 'other-scope' : observedScope(state), feet: copy(feet), radius: value.radius, receivedAt: clock }
    }
  }
  const travel = createChunkTravel({ ...ports, ...(options.bounds ?? {}) })
  return { travel, ports, state, blocks, events, plans, previews, moves, stops, witnesses, route,
    setGeneration: value => { codeGeneration = value }, setJob: value => { identity = value }, advance: ms => { clock += ms } }
}
async function waitFor (predicate) {
  const until = Date.now() + 1500
  while (!predicate() && Date.now() < until) await delay(5)
  assert.ok(predicate(), 'bounded test event was reached')
}

test('status is passive and start synchronously accepts an owned walk without starting mining or a quarry job', async () => {
  const f = fixture()
  assert.deepEqual(f.events, []); assert.equal(f.travel.status().phase, 'idle')
  const accepted = f.travel.start({ area: { x1: 1, z1: 0 } })
  assert.equal(accepted.then, undefined); assert.equal(accepted.busy, true); assert.equal(accepted.phase, 'planning')
  assert.deepEqual(f.events, [])
  await f.travel.drain()
  const result = f.travel.status()
  assert.equal(result.phase, 'arrived'); assert.equal(result.serverConfirmed, true); assert.equal(result.busy, false)
  assert.ok(areaContainsFeet(result.area, feetOf(f.state), 0.2))
  assert.equal(f.events.at(-1), 'release')
  assert.ok(f.events.indexOf('witness') > f.events.indexOf('move'))
})

test('a long planning-only path executes fresh short prefixes and succeeds on area membership rather than its center', async () => {
  const f = fixture(); f.travel.start({ area: { x1: 2, z1: 0 } }); await f.travel.drain()
  const result = f.travel.status()
  assert.equal(result.phase, 'arrived', JSON.stringify(result))
  assert.ok(f.moves.length > 5 && f.moves.length <= 32)
  assert.equal(f.moves.length, f.witnesses.length)
  for (const move of f.moves) assert.ok(distance(move.origin, move.target) <= 4.5 + 1e-6)
  assert.equal(f.previews.length, f.moves.length)
  assert.ok(distance(feetOf(f.state), result.target) > 0.4, 'entering the safe selected area is sufficient')
  assert.equal(result.positionProof.scope, observedScope(f.state)); assert.equal(result.positionProof.source, 'server_position_volume')
})

for (const option of [{ witnessOk: false }, { wrongScope: true }, { witnessKind: 'client_prediction' }]) test(`predicted completion without a matching actual witness cannot arrive: ${JSON.stringify(option)}`, async () => {
  const f = fixture(option); f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().serverConfirmed, false)
  assert.equal(f.travel.status().error.code, 'CHUNK_TRAVEL_POSITION_UNCONFIRMED')
  assert.equal(f.moves.length, 1, 'no subsequent leg follows missing actual evidence')
})

test('already being inside the area still requires safe terrain and a fresh actual witness', async () => {
  const f = fixture(); f.travel.start({ area: { x1: 0, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().phase, 'arrived'); assert.equal(f.moves.length, 0); assert.equal(f.witnesses.length, 1)
})

for (const mode of ['unknown', 'noRoute', 'noShort']) test(`${mode} never starts mutable movement`, async () => {
  const f = fixture({ [mode]: true }); f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().phase, 'failed'); assert.equal(f.moves.length, 0)
  assert.ok(f.plans.length <= 32); assert.equal(f.travel.status().serverConfirmed, false)
})

test('area inputs normalize negative/reversed rectangles and reject oversized or extra coordinate controls', async () => {
  const f = fixture(); f.state.position = { x: -8.5, y: 64.62, z: -8.5 }
  const result = f.travel.start({ area: { x1: -1, z1: -1, x2: -2, z2: -1 } })
  assert.deepEqual(result.area, { x1: -2, z1: -1, x2: -1, z2: -1 })
  await f.travel.drain(); assert.equal(f.travel.status().serverConfirmed, true)
  for (const area of [{ x1: 0, z1: 0, x2: 4, z2: 0 }, { x1: '1', z1: 0 }, { x1: 0, z1: 0, y: 80 }, { x1: -1875001, z1: 0 }]) assert.throws(() => f.travel.start({ area }), { code: 'INVALID_CHUNK_AREA' })
})

for (const mode of ['connection', 'life', 'generation', 'job', 'damage']) test(`${mode} change during preview stops before dispatch`, async () => {
  let f
  f = fixture({ preview: state => {
    if (mode === 'connection') state.connectionId = 'changed'
    if (mode === 'life') state.lifecycle.deathId++
    if (mode === 'generation') f.setGeneration(8)
    if (mode === 'job') f.setJob({ instanceId: 'another-job' })
    if (mode === 'damage') state.health--
  } })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.moves.length, 0); assert.equal(f.travel.status().phase, 'failed')
  assert.equal(f.travel.status().error.code, mode === 'damage' ? 'CHUNK_TRAVEL_DAMAGED' : 'CHUNK_TRAVEL_CONTEXT_CHANGED')
})

test('the final beforeInput guard rejects damage arriving after preview but before a packet', async () => {
  const f = fixture({ beforeInput: state => { state.health-- } })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.moves.length, 0); assert.equal(f.travel.status().serverConfirmed, false)
})

test('cancel before acquisition performs no action and cancel during a leg stops only the owned move', async () => {
  const early = fixture(); early.travel.start({ area: { x1: 1, z1: 0 } }); early.travel.cancel(); await early.travel.drain()
  assert.equal(early.events.length, 0); assert.equal(early.travel.status().phase, 'cancelled')
  const f = fixture({ hangMove: true }); f.travel.start({ area: { x1: 1, z1: 0 } }); await waitFor(() => f.moves.length === 1)
  const returned = f.travel.cancel(); assert.equal(returned.busy, true)
  await f.travel.drain()
  assert.equal(f.travel.status().phase, 'cancelled'); assert.equal(f.stops.length, 1); assert.equal(f.witnesses.length, 0)
  f.travel.cancel(); assert.equal(f.stops.length, 1, 'a late cancellation cannot stop a later owner')
})

test('cancel releases a lease even when a read-only long planner has not resolved', async () => {
  const wait = deferred(), f = fixture({ plan: () => wait.promise })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await waitFor(() => f.plans.length === 1)
  f.travel.cancel(); await f.travel.drain()
  assert.equal(f.events.at(-1), 'release'); assert.equal(f.moves.length, 0)
  wait.resolve()
})

test('context changes while an awaited planner is pending cancel without later movement', async () => {
  const wait = deferred(), f = fixture({ plan: () => wait.promise })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await waitFor(() => f.plans.length === 1)
  f.state.health--
  await f.travel.drain()
  assert.equal(f.travel.status().error.code, 'CHUNK_TRAVEL_DAMAGED'); assert.equal(f.moves.length, 0)
  wait.resolve()
})

test('candidate planning yields to a scheduled cancellation before attempting the remaining routes', async () => {
  let f, cancelled = false
  f = fixture({ noRoute: true, plan: () => {
    if (f.plans.length === 1) setImmediate(() => { cancelled = true; f.travel.cancel() })
  } })
  f.travel.start({ area: { x1: 1, z1: 0 } })
  await f.travel.drain(); await turn()
  assert.equal(cancelled, true)
  assert.equal(f.plans.length, 1, 'one expensive failed native plan must yield before the next candidate')
  assert.equal(f.previews.length, 0); assert.equal(f.moves.length, 0)
  assert.equal(f.travel.status().phase, 'cancelled')
  assert.equal(f.travel.status().error.code, 'CHUNK_TRAVEL_CANCELLED')
})

test('leg and operation bounds stop unconfirmed progress', async () => {
  const f = fixture({ hangMove: true, bounds: { timeoutMs: 1000, legTimeoutMs: 30 } })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().error.code, 'CHUNK_TRAVEL_LEG_TIMEOUT')
  const limited = fixture({ bounds: { maxLegs: 1 } }); limited.travel.start({ area: { x1: 2, z1: 0 } }); await limited.travel.drain()
  assert.equal(limited.travel.status().error.code, 'CHUNK_TRAVEL_LEG_LIMIT')
})

test('terrain becoming unknown during final position verification never publishes arrival', async () => {
  const f = fixture({ witness: (_state, feet) => {
    if (areaContainsFeet({ x1: 1, z1: 0 }, feet, 0.2)) f.blocks.set([Math.floor(feet.x), 62, Math.floor(feet.z)].join(','), { known: false })
  } })
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().serverConfirmed, false); assert.equal(f.travel.status().positionProof, null)
})

for (const plant of ['minecraft:short_grass', 'minecraft:wildflowers']) test(`known harmless ${plant} can remain in the walking path while the destination stays clear`, async () => {
  const f = fixture(); f.blocks.set('1,63,0', { known: true, name: plant, boundingBox: 'empty', extra: [] })
  const before = copy(f.blocks)
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.travel.status().phase, 'arrived', JSON.stringify(f.travel.status()))
  assert.deepEqual(f.blocks, before, 'normal movement never removes a plant')
})

for (const block of [{ known: false }, { known: true, name: 'minecraft:wither_rose', boundingBox: 'empty', extra: [] },
  { known: true, name: 'minecraft:wildflowers', boundingBox: 'empty', extra: [{ name: 'minecraft:water' }] },
  { known: true, name: 'minecraft:wildflowers', boundingBox: 'empty', extra: [], protected: true }]) test(`unsafe or unknown path body ${JSON.stringify(block)} is refused`, async () => {
  const f = fixture(); f.blocks.set('1,63,0', block)
  f.travel.start({ area: { x1: 1, z1: 0 } }); await f.travel.drain()
  assert.equal(f.moves.length, 0); assert.equal(f.travel.status().serverConfirmed, false)
})

test('a native known shallow-water route uses ordinary short moves and actual witnesses before returning to dry land', async () => {
  const f = fixture()
  for (let x = 1; x <= 15; x++) for (let z = -2; z <= 17; z++) f.blocks.set([x, 62, z].join(','), { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] })
  const nativeRoute = (target, planningOnly) => {
    const origin = feetOf(f.state), count = Math.ceil(Math.abs(target.x - origin.x)), waypoints = []
    for (let i = 1; i <= count; i++) {
      const x = origin.x + (target.x - origin.x) * i / count, z = origin.z + (target.z - origin.z) * i / count, water = x >= 1 && x < 16
      waypoints.push({ position: { x, y: water ? 62 : 63, z }, action: water ? 'swim' : 'walk', medium: water ? 'water' : 'land' })
    }
    return { ready: true, origin, target, waypoints, planningOnly }
  }
  const travel = createChunkTravel({ ...f.ports, planRoute: async target => nativeRoute(target, true), previewMove: async target => nativeRoute(target, false) })
  travel.start({ area: { x1: 1, z1: 0 } }); await travel.drain()
  assert.equal(travel.status().phase, 'arrived', JSON.stringify(travel.status()))
  assert.ok(f.moves.some(move => move.target.y === 62))
  assert.equal(f.witnesses.length, f.moves.length)
  assert.ok(Math.abs(feetOf(f.state).y - 63) < 1e-6)
  assert.ok(areaContainsFeet(travel.status().area, feetOf(f.state), 0.2))
})
