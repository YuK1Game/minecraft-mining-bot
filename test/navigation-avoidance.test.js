'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createGuardedRoute } = require('../src/guarded-route')

const copy = value => structuredClone(value)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const block = name => ({ known: true, name: `minecraft:${name}`, properties: {}, extra: [] })
const eye = p => ({ ...p, y: p.y + 1.62 })

function fixture ({ movingSecondary = 0, unknownNorth = false } = {}) {
  let now = 1000
  let motion = { phase: 'idle' }
  let stepper = null
  let moved = false
  const frames = []; const calls = []
  // The short south route follows a wall and grazes the secondary threat;
  // the two-block-longer north route remains entirely known solid land.
  const world = { getBlock: (x, y, z) => {
    if (unknownNorth && x < 0 && z < 0) return { known: false, reason: 'not received' }
    const solid = (x < 0 ? y < 66 : y < 65) || (x === -2 && z >= 0 && z <= 2 && y >= 66 && y <= 68) || (x >= 0 && (z !== 0 || x >= 1) && y >= 65 && y <= 68)
    return block(solid ? 'stone' : 'air')
  } }
  const navigator = createNavigator({ world })
  const actors = [
    { runtimeId: '7', entityType: 'minecraft:creeper', position: { x: 3.5, y: 65, z: 0.5 } },
    { runtimeId: '12', entityType: 'minecraft:drowned', position: { x: 10.5, y: 65, z: 6.5 } }
  ].map(a => ({ ...a, uniqueId: a.runtimeId, kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' }))
  const state = { phase: 'spawned', profile: 'route', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: now, positionSource: 'start_game', rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: null, inventory: { known: true, items: [] }, vitals: { hunger: 20 }, entities: actors }
  state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt = now
  const target = { x: -6.5, y: 66, z: 3.5 }
  const initial = navigator.physics.fromServer(state)
  const avoidance = actors.map(a => ({ id: a.runtimeId, position: copy(a.position), minDistance: distance(state.position, a.position), padding: 0.5 }))
  const getState = () => copy(state)
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', avoidance: copy(options.avoidance) }); return navigator.plan(navigator.physics.fromServer(state), target, options) },
    start: (target, options) => {
      calls.push({ type: 'start', avoidance: copy(options.avoidance) })
      const initial = navigator.physics.fromServer(state)
      const route = navigator.plan(initial, target, options)
      stepper = navigator.createStepper(route, initial, { sprint: options.sprint })
      motion = { phase: 'moving' }
      return motion
    },
    stop: reason => { calls.push({ type: 'stop', reason }); stepper = null; motion = { phase: 'stopped' }; return motion }
  }
  const guard = createGuardedRoute({ getState, movement, getMovement: () => {
    if (!stepper || motion.phase !== 'moving') return copy(motion)
    const frame = stepper.next(); now += 50
    state.position = copy(frame.packetPosition); state.positionUpdatedAt = now; state.positionSource = 'client_prediction'
    state.predicted = { position: copy(state.position), physicsState: copy(frame.predictedState) }
    if (!moved && frames.length === 4 && movingSecondary) { moved = true; actors[1].position.x -= movingSecondary }
    frames.push(copy(frame)); motion = { phase: frame.phase }
    return copy(motion)
  }, inventory: { equip: () => { throw new Error('No synthetic sword') }, cancel: () => {} }, combat: { previewEngage: () => ({ ready: false }), engage: () => { throw new Error('No synthetic combat') }, cancel: () => {}, drain: () => {} }, verifyStanding: s => s.predicted?.physicsState?.onGround !== false && navigator.physics.hasSupport({ ...s.position, y: s.position.y - 1.62 }), pollMs: 50, operationTimeoutMs: 15000, clock: () => now, delay: async (ms, signal) => { if (signal.aborted) throw signal.reason } })
  return { navigator, initial, target, actors, state, avoidance, frames, calls, guard }
}

test('a directly verified flat diagonal can move away from two opposing enemies', () => {
  const world = { getBlock: (x, y, z) => block(y <= 64 ? 'stone' : 'air') }
  const navigator = createNavigator({ world })
  const observed = { position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' }
  const initial = navigator.physics.fromServer(observed, { onGround: true })
  const enemies = [{ x: -1, y: 65, z: 4.9 }, { x: 4.9, y: 66.62, z: -22.5 }]
  const avoidance = enemies.map((position, id) => ({ id: String(id), position, minDistance: distance(observed.position, position), padding: 0.5 }))
  const target = { x: 6.5, y: 65, z: 1.7 }
  const route = navigator.plan(initial, target, { directFlat: true, avoidance, maxDistance: 8 })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.directFlat, true)
  const stepper = navigator.createStepper(route, initial)
  let frame
  for (let tick = 0; tick < 240; tick++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  const blockedWorld = { getBlock: (x, y, z) => x === 3 && z === 1 && y === 64 ? { known: false } : world.getBlock(x, y, z) }
  const blocked = createNavigator({ world: blockedWorld }).plan(initial, target, { directFlat: true, avoidance, maxDistance: 8 })
  assert.notEqual(blocked.directFlat, true, 'unknown support cannot authorize a direct path')
})

test('a supported offset origin can jump away when grid recentering approaches an enemy', () => {
  const world = { getBlock: (x, y, z) => block(y <= 64 || (x >= 1 && y === 65) ? 'stone' : 'air') }
  const navigator = createNavigator({ world })
  const observed = { position: { x: 0.51, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' }
  const initial = navigator.physics.fromServer(observed, { onGround: true })
  const enemy = { x: -4, y: 66.62, z: 0.5 }
  const avoidance = [{ id: 'zombie', position: enemy, minDistance: distance(observed.position, enemy), padding: 0.5 }]
  const route = navigator.plan(initial, { x: 2.5, y: 66, z: 0.5 }, { maxDistance: 4, avoidance })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.waypoints[0].action, 'jump')
  const stepper = navigator.createStepper(route, initial)
  let frame
  for (let tick = 0; tick < 160; tick++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.equal(frame.serverConfirmed, false)
})

test('planning circles find a known alternative to the terrain-shortest jump/south route without changing blocks', () => {
  const f = fixture()
  const original = copy(f.initial)
  const bare = f.navigator.plan(f.initial, f.target, { maxDistance: 12 })
  assert.equal(bare.ready, true)
  assert.ok(bare.waypoints.some(p => p.position.x === -0.5 && p.position.z === 3.5))
  assert.ok(distance(eye({ x: -0.5, y: 66, z: 3.5 }), f.actors[1].position) < f.avoidance[1].minDistance)
  const input = copy(f.avoidance)
  const route = f.navigator.plan(f.initial, f.target, { maxDistance: 12, avoidance: input })
  assert.equal(route.ready, true, route.reason)
  assert.ok(route.waypoints.some(p => p.position.z === -0.5))
  assert.ok(!route.waypoints.some(p => p.position.x === -0.5 && p.position.z >= 1.5))
  assert.deepEqual(input, f.avoidance)
  input[0].position.x = 999
  assert.equal(route.avoidance[0].position.x, 3.5, 'the plan owns a sanitized copy')
  const stepper = f.navigator.createStepper(route, f.initial, { sprint: true })
  let frame
  for (let ticks = 0; ticks < 240; ticks++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.equal(frame.serverConfirmed, false)
  assert.deepEqual(f.initial, original)
})

test('the Guard passes identical fresh circles to preview/start and survives a slight secondary movement on the known alternate route', async () => {
  const f = fixture({ movingSecondary: 0.1 })
  const result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 16, maxBootstrapDistance: 16, timeoutMs: 15000 })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.escaped, true)
  assert.equal(result.interruptions, 0)
  assert.equal(result.movementStarts, 1)
  assert.ok(f.frames.some(frame => frame.controls.jump))
  assert.deepEqual(f.calls.find(call => call.type === 'preview').avoidance, f.calls.find(call => call.type === 'start').avoidance)
  assert.equal(f.calls.find(call => call.type === 'start').avoidance.length, 2)
  assert.deepEqual([...f.calls.find(call => call.type === 'preview').avoidance].sort((a, b) => a.id.localeCompare(b.id)), [...f.avoidance].sort((a, b) => a.id.localeCompare(b.id)), 'the fixed planning thresholds come from the fresh initial eye-space distances')
  assert.equal(f.actors[1].position.x, 10.4)
  assert.equal(result.remainingRouteRejection, null)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.safe, false)
})

test('a real remaining-route violation records the actor/segment/radius and never becomes an escaped endpoint', async () => {
  const f = fixture({ movingSecondary: 11 })
  const result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(result.escaped, false)
  assert.equal(result.arrived, false)
  assert.equal(result.remainingRouteRejection.actorId, '12')
  assert.equal(result.remainingRouteRejection.reason, 'actor_radius')
  assert.ok(result.remainingRouteRejection.minDistance < result.remainingRouteRejection.required)
  assert.ok(Number.isInteger(result.remainingRouteRejection.segment.index))
  assert.ok(result.remainingRouteRejection.latestPose.position)
  assert.ok(result.remainingRouteRejection.actorPosition)
  assert.equal(result.visitedPrefix.length, 1)
  assert.ok(f.calls.some(call => call.type === 'stop'))
})

test('avoidance cannot create a route through unknown terrain when the only known short route violates a circle', () => {
  const f = fixture({ unknownNorth: true })
  const route = f.navigator.plan(f.initial, f.target, { maxDistance: 12, maxExpanded: 5000, avoidance: f.avoidance })
  assert.equal(route.ready, false)
})

test('eye-space avoidance also validates direct-start shortcuts and final exact-target connectors', () => {
  const nav = createNavigator({ world: { getBlock: (x, y, z) => block(y < 65 ? 'stone' : 'air') } })
  const initial = nav.physics.fromServer({ position: { x: 0.05, y: 66.62, z: 0.05 }, gameMode: 'survival' })
  const route = nav.plan(initial, { x: 1.5, y: 65, z: 0.5 }, { maxDistance: 3, avoidance: [{ id: 'shortcut', position: { x: 1, y: 66.62, z: 0.3448275862068966 }, minDistance: 0.1 }] })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 })
  const exact = nav.plan(initial, { x: 1.2, y: 65, z: 0.5 }, { maxDistance: 3, avoidance: [{ id: 'exact', position: { x: 1.19, y: 66.62, z: 0.5 }, minDistance: 0.15 }] })
  assert.equal(exact.ready, false)
  assert.match(exact.reason, /exact target connector/)
  const terrace = createNavigator({ world: { getBlock: (x, y, z) => block(y < 65 || x === 0 && z === 1 && y === 65 ? 'stone' : 'air') } })
  const connector = terrace.plan(initial, { x: 0.5, y: 66, z: 1.5 }, { maxDistance: 3, avoidance: [{ id: 'initial', position: { x: 0.25, y: 66.62, z: 0.25 }, minDistance: 0.12 }] })
  assert.equal(connector.ready, true, connector.reason)
  assert.notDeepEqual(connector.waypoints[0].position, { x: 0.5, y: 65, z: 0.5 }, 'the unsafe closest initial connector must be replaced, not just the later graph edges')
})

test('avoidance is bounded copied planning data and malformed policy never defaults to unrestricted navigation', () => {
  const f = fixture()
  for (const avoidance of [null, {}, [{ id: 'bad', position: { x: NaN, y: 65, z: 0 }, minDistance: 1 }], [{ id: 'bad', position: { x: 0, y: 65, z: 0 }, minDistance: -1 }], [{ id: 'bad', position: { x: 0, y: 65, z: 0 }, minDistance: 1, padding: 2 }], Array.from({ length: 65 }, (_, n) => ({ id: String(n), position: { x: 0, y: 65, z: 0 }, minDistance: 1 }))]) {
    const route = f.navigator.plan(f.initial, f.target, { maxDistance: 12, avoidance })
    assert.equal(route.ready, false)
    assert.match(route.reason, /avoidance policy/)
  }
  const circle = { ...f.avoidance[0], privateActor: { arbitrary: 'not copied' } }
  const route = f.navigator.plan(f.initial, f.target, { maxDistance: 12, avoidance: [circle] })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.avoidance[0].privateActor, undefined)
})
