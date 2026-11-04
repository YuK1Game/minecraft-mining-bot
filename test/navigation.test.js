'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')

const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
function fixture (override = () => null, options = {}) {
  const world = { getBlock: (x, y, z) => override(x, y, z) ?? block(y < 65 ? 'stone' : 'air') }
  const navigator = createNavigator({ world, ...options })
  const initial = navigator.physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
  return { navigator, initial }
}

test('bounded route planning navigates around a wall and never crosses unknown terrain or deep gaps', () => {
  const { navigator, initial } = fixture((x, y, z) => x === 2 && y >= 65 && y < 68 && z === 0 ? block('stone') : null)
  const route = navigator.plan(initial, { x: 4.5, z: 0.5 })
  assert.equal(route.ready, true)
  assert.ok(route.waypoints.some(point => point.position.z !== 0.5))
  assert.ok(!route.waypoints.some(point => point.position.x === 2.5 && point.position.z === 0.5))
  const unknown = fixture((x) => x >= 1 ? { known: false, reason: 'not received' } : null)
  assert.equal(unknown.navigator.plan(unknown.initial, { x: 4.5, z: 0.5 }, { maxDistance: 5 }).ready, false)
  const gap = fixture((x, y, z) => x === 1 && z === 0 && y < 65 && y > 60 ? block('air') : null)
  const gapRoute = gap.navigator.plan(gap.initial, { x: 2.5, z: 0.5 }, { maxDistance: 4 })
  assert.equal(gapRoute.ready, true)
  assert.ok(!gapRoute.waypoints.some(point => point.position.x === 1.5 && point.position.z === 0.5))
})

test('explicit direct surface route checks the full shore-to-water corridor and avoidance', () => {
  const observed = require('./fixtures/three-threat-dry-edge-latest.json')
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  const make = override => {
    const world = { getBlock: (x, y, z) => override?.(x, y, z) ?? blocks.get(`${x},${y},${z}`) ?? { known: false } }
    const navigator = createNavigator({ world, allowWater: true })
    return { navigator, initial: navigator.physics.fromServer({ position: observed.position, positionSource: 'client_prediction', predicted: observed.predicted, gameMode: 'survival' }) }
  }
  const target = { x: -7.5, y: 63, z: 59.5 }
  const f = make(); const plan = f.navigator.plan(f.initial, target, { directSurface: true, exactGoal: true, maxDistance: 6 })
  assert.equal(plan.ready, true); assert.equal(plan.directSurface, true)
  assert.equal(plan.waypoints[0].medium, 'water'); assert.equal(plan.serverConfirmed, false)
  const wall = make((x, y, z) => x === -9 && y === 63 && z === 59 ? block('stone') : null)
  assert.notEqual(wall.navigator.plan(wall.initial, target, { directSurface: true, exactGoal: true, maxDistance: 6 }).directSurface, true)
  const unknown = make((x, y, z) => x === -9 && y === 62 && z === 59 ? { known: false } : null)
  assert.notEqual(unknown.navigator.plan(unknown.initial, target, { directSurface: true, exactGoal: true, maxDistance: 6 }).directSurface, true)
  const avoid = [{ id: 'enemy', position: { x: -8.4, y: 64.62, z: 59.1 }, minDistance: 0.7, padding: 0 }]
  assert.notEqual(f.navigator.plan(f.initial, target, { directSurface: true, exactGoal: true, maxDistance: 6, avoidance: avoid }).directSurface, true)
})

test('one-block risers get jump actions but low ceilings reject the jump', () => {
  const terrace = (x, y) => x >= 1 && y === 65 ? block('stone') : null
  const { navigator, initial } = fixture(terrace)
  const route = navigator.plan(initial, { x: 2.5, y: 66, z: 0.5 })
  assert.equal(route.ready, true)
  assert.ok(route.waypoints.some(point => point.action === 'jump'))
  const ceiling = fixture((x, y) => y === 67 ? block('stone') : terrace(x, y))
  assert.equal(ceiling.navigator.plan(ceiling.initial, { x: 2.5, y: 66, z: 0.5 }, { maxDistance: 3 }).ready, false)
})

test('an exact adjacent uphill landing still requires known clear support and respects danger circles', () => {
  const terrace = (x, y) => x >= 1 && y === 65 ? block('stone') : null
  const target = { x: 1.65, y: 66, z: 0.35 }
  const f = fixture(terrace)
  const route = f.navigator.plan(f.initial, target, { exactGoal: true, maxDistance: 3 })
  assert.equal(route.ready, true)
  assert.deepEqual(route.waypoints.at(-1).position, target)
  const stepper = f.navigator.createStepper(route, f.initial)
  let frame
  for (let i = 0; i < 100; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  for (const mode of ['unknown', 'floor', 'wall']) {
    const bad = fixture((x, y, z) => {
      if (x === 1 && z === 0 && y === 65 && mode === 'unknown') return { known: false }
      if (x === 1 && z === 0 && y === 65 && mode === 'floor') return block('air')
      if (x === 1 && z === 0 && y === 66 && mode === 'wall') return block('stone')
      return terrace(x, y)
    })
    assert.equal(bad.navigator.plan(bad.initial, target, { exactGoal: true, maxDistance: 3 }).ready, false, mode)
  }
  assert.equal(f.navigator.plan(f.initial, target, { exactGoal: true, maxDistance: 3, avoidance: [{ id: 'enemy', position: { x: target.x, y: target.y + 1.62, z: target.z }, minDistance: 1, padding: 0 }] }).ready, false)
})

test('partial ledge descent pre-simulates a bounded known landing and all enemy distances', () => {
  const observed = require('./fixtures/partial-ledge-drop.json')
  const { evaluateThreats } = require('../src/threats')
  const state = { position: observed.position, health: 10, dimension: 'overworld', gameMode: 'survival', threatPolicy: 'balanced_mining', runtimeEntityId: 'self' }
  const threats = evaluateThreats(state, observed.enemies, { observationRadius: 32 })
  const primary = threats.threats.reduce((a, b) => a.distance < b.distance ? a : b)
  const avoid = [...threats.threats, ...threats.outsideDanger].map(actor => {
    const floor = actor.name.includes('skeleton') ? 18 : 7.5
    const currentThreat = threats.threats.some(a => a.runtimeId === actor.runtimeId)
    const minimum = actor.runtimeId === primary.runtimeId ? actor.distance : currentThreat && actor.distance >= floor + 0.25 ? Math.max(floor, actor.distance - 1.5) : Math.min(actor.distance, actor.dangerRadius)
    return { id: actor.runtimeId, position: actor.position, minDistance: minimum, padding: 0 }
  })
  const target = { x: 0.7, y: 74, z: 0.5 }
  const make = override => {
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    const navigator = createNavigator({ world: { getBlock: (x, y, z) => override?.(x, y, z) ?? blocks.get(`${x},${y},${z}`) ?? { known: false } } })
    return { navigator, initial: navigator.physics.fromServer(state, { onGround: true }) }
  }
  const f = make(); const plan = f.navigator.plan(f.initial, target, { partialDrop: true, maxDistance: 2, avoidance: avoid })
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.partialDrop, true)
  assert.equal(plan.serverConfirmed, false)
  assert.ok(plan.predictedTrace.length > 2)
  for (const mode of ['unknown', 'no_floor', 'wall', 'water']) {
    const bad = make((x, y, z) => {
      if (x !== 0 || z !== 0) return null
      if (y === 73 && mode === 'unknown') return { known: false }
      if (y === 73 && mode === 'no_floor') return block('air')
      if (y === 74 && mode === 'wall') return block('stone')
      if (y === 74 && mode === 'water') return block('water', { liquid_depth: 0 })
      return null
    })
    assert.equal(bad.navigator.plan(bad.initial, target, { partialDrop: true, maxDistance: 2, avoidance: avoid }).ready, false, mode)
  }
  assert.equal(f.navigator.plan(f.initial, { ...target, y: 73 }, { partialDrop: true, maxDistance: 2, avoidance: avoid }).ready, false)
  assert.equal(f.navigator.plan(f.initial, target, { partialDrop: true, maxDistance: 2, avoidance: [...avoid, { id: 'new-danger', position: { x: target.x, y: target.y + 1.62, z: target.z }, minDistance: 0.5, padding: 0 }] }).ready, false)
})

test('stepper continuously predicts a flat route without changing authoritative input or claiming success', () => {
  const { navigator, initial } = fixture()
  const before = structuredClone(initial)
  const route = navigator.plan(initial, { x: 3.5, z: 0.5 })
  const stepper = navigator.createStepper(route, initial)
  let output
  for (let tick = 0; tick < 200; tick++) {
    output = stepper.next()
    if (output.phase !== 'moving') break
  }
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.ok(Math.abs(output.predictedState.position.x - 3.5) < 0.25)
  assert.deepEqual(initial, before)
  assert.equal(output.serverConfirmed, false)
  assert.equal(output.requiresServerConfirmation, true)
})

test('stepper selects a jump over a one-block terrace and lands on its top', () => {
  const { navigator, initial } = fixture((x, y) => x >= 1 && y === 65 ? block('stone') : null)
  const route = navigator.plan(initial, { x: 2.5, y: 66, z: 0.5 })
  const stepper = navigator.createStepper(route, initial)
  let output
  let sawJump = false
  for (let tick = 0; tick < 240; tick++) {
    output = stepper.next()
    sawJump ||= output.controls.jump
    if (output.phase !== 'moving') break
  }
  assert.equal(sawJump, true)
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.ok(Math.abs(output.predictedState.position.y - 66) < 1e-5)
  assert.ok(Math.abs(output.predictedState.position.x - 2.5) < 0.3)
})

test('authoritative correction ends the current plan and changed terrain prevents continuing', () => {
  let obstructed = false
  const { navigator, initial } = fixture((x, y) => obstructed && x === 1 && y >= 65 && y < 67 ? block('stone') : null)
  const route = navigator.plan(initial, { x: 3.5, z: 0.5 })
  const stepper = navigator.createStepper(route, initial)
  stepper.next()
  const server = { ...structuredClone(initial), position: { x: 0.6, y: 65, z: 0.5 } }
  assert.equal(stepper.reconcile(server).phase, 'replan_required')
  assert.equal(stepper.next().phase, 'replan_required')
  const changed = navigator.createStepper(route, initial)
  obstructed = true
  assert.equal(changed.next().phase, 'failed')
})

test('water route remains opt-in, surface-only and explicitly unverified', () => {
  const ocean = (x, y) => x >= 1 && y >= 60 && y <= 64 ? block('water', { liquid_depth: 0 }) : null
  const dry = fixture(ocean)
  const denied = dry.navigator.plan(dry.initial, { x: 3.5, z: 0.5 }, { maxDistance: 4 })
  assert.equal(denied.ready, false)
  const wet = fixture(ocean, { allowWater: true })
  const allowed = wet.navigator.plan(wet.initial, { x: 3.5, z: 0.5 }, { maxDistance: 4 })
  assert.equal(allowed.ready, true)
  assert.ok(allowed.waypoints.some(point => point.action === 'swim'))
  assert.equal(allowed.water, 'experimental-unverified')
  assert.equal(wet.navigator.capabilities.serverAcceptanceVerified, false)
  const stepper = wet.navigator.createStepper(allowed, wet.initial)
  let output
  for (let tick = 0; tick < 240; tick++) {
    output = stepper.next()
    if (output.phase !== 'moving') break
  }
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.ok(output.predictedState.position.x > 3.1)
  assert.equal(output.serverConfirmed, false)
})

test('a corrected water position does not swim backwards to a redundant grid centre', () => {
  const make = override => {
    const world = { getBlock: (x, y, z) => override?.(x, y, z) ?? block(y < 62 ? 'stone' : y < 65 ? 'water' : 'air', y >= 62 && y < 65 ? { liquid_depth: 0 } : {}) }
    const navigator = createNavigator({ world, allowWater: true })
    const initial = navigator.physics.fromServer({ position: { x: 1.9888, y: 66.183, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' }, { velocity: { x: 0.1119, y: -0.3141, z: 0 }, onGround: false })
    return { navigator, initial }
  }
  const f = make(); const target = { x: 2.5, y: 65, z: 0.5 }
  const avoidance = [{ id: 'creeper', position: { x: -2, y: 64, z: 0.5 }, minDistance: 3.5, padding: 0 }]
  for (const policy of [[], avoidance]) {
    const route = f.navigator.plan(f.initial, target, { exactGoal: true, avoidance: policy })
    assert.equal(route.ready, true, route.reason)
    assert.ok(route.waypoints[0].position.x > f.initial.position.x, JSON.stringify(route.waypoints))
    const frame = f.navigator.createStepper(route, f.initial).next()
    assert.equal(frame.phase, 'moving')
    assert.ok(frame.predictedState.position.x > f.initial.position.x)
  }
  const unknown = make((x, y, z) => x === 2 && z === 0 && y >= 64 ? { known: false, reason: 'not received' } : null)
  const route = unknown.navigator.plan(unknown.initial, target, { exactGoal: true })
  assert.equal(route.ready, false)
  const blockedByActor = f.navigator.plan(f.initial, target, { exactGoal: true, avoidance: [{ id: 'creeper', position: { x: 2.5, y: 66.62, z: 0.5 }, minDistance: 0.5, padding: 0 }] })
  assert.equal(blockedByActor.ready, false)
})

test('an empty completed route must settle on known ground instead of declaring an airborne position reached', () => {
  const { navigator, initial } = fixture()
  const airborne = { ...initial, position: { x: 0.5, y: 65.478686, z: 0.5 }, velocity: { x: 0, y: -0.1, z: 0 }, onGround: false }
  const stepper = navigator.createStepper({ ready: true, target: { x: 0.5, y: 65, z: 0.5 }, waypoints: [] }, airborne)
  const first = stepper.next()
  assert.equal(first.phase, 'moving')
  assert.equal(first.predictedState.onGround, false)
  let result
  for (let i = 0; i < 20; i++) {
    result = stepper.next()
    if (result.phase !== 'moving') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation')
  assert.equal(result.predictedState.onGround, true)
  assert.equal(result.settled, true)
  assert.equal(result.predictedState.position.y, 65)
})

test('neutral settling preflights the whole fall and rejects unknown or excessive drops before live execution', () => {
  const { navigator, initial } = fixture()
  const airborne = { ...initial, position: { x: 0.5, y: 65.478686, z: 0.5 }, velocity: { x: 0, y: -0.23, z: 0 }, onGround: false }
  const settler = navigator.createSettler(airborne, { maxDrop: 1 })
  let result
  for (let i = 0; i < 20; i++) {
    result = settler.next()
    assert.deepEqual(result.controls, {})
    if (result.phase !== 'settling') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation')
  assert.equal(result.predictedState.onGround, true)
  assert.equal(result.settled, true)
  const unknown = createNavigator({ world: { getBlock: (x, y) => y < 65 ? { known: false, reason: 'not received' } : block('air') } })
  assert.throws(() => unknown.createSettler(airborne), /Unknown terrain/)
  assert.throws(() => navigator.createSettler({ ...airborne, position: { ...airborne.position, y: 70 } }), /bounded vertical/)
})

test('live float32 eye height plans and steps on the correct support layer without rounding a real airborne pose', () => {
  const world = { getBlock: (x, y, z) => block(y < 69 ? 'grass_block' : 'air') }
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer({ position: { x: -12.5, y: 70.62001037597656, z: 20.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
  assert.equal(initial.onGround, true)
  const route = navigator.plan(initial, { x: -10.5, z: 20.5 })
  assert.equal(route.ready, true, route.reason)
  const frame = navigator.createStepper(route, initial).next()
  assert.equal(frame.phase, 'moving')
  assert.equal(frame.predictedState.onGround, true)
  assert.ok(Math.abs(frame.predictedState.position.y - 69) < 1e-5)
  const midair = { ...initial, position: { x: -12.5, y: 69.478686, z: 20.5 }, onGround: false }
  const denied = navigator.plan(midair, { x: -10.5, z: 20.5 })
  assert.equal(denied.ready, false)
  assert.match(denied.reason, /supported landing/)
})

test('river surface recovery reaches an adjacent sand bank from the observed float32 airborne pose', () => {
  const world = { getBlock: (x, y) => block(y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air', x >= 8 && y >= 60 && y <= 62 ? { liquid_depth: 0 } : {}) }
  const navigator = createNavigator({ world, allowWater: true })
  const initial = navigator.physics.fromServer({ position: { x: 8.50558, y: 64.91255, z: -1.96432 }, rotation: { yaw: 90, pitch: 0 }, gameMode: 'survival' })
  const before = structuredClone(initial)
  const route = navigator.plan(initial, { x: 7.5, y: 63, z: -1.5 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.origin, initial.position)
  assert.ok(route.waypoints.some(waypoint => waypoint.action === 'swim'))
  assert.equal(route.waypoints.at(-1).medium, 'land')
  const stepper = navigator.createStepper(route, initial)
  let output
  let wet = false
  let floated = false
  for (let index = 0; index < 160; index++) {
    output = stepper.next()
    wet ||= output.predictedState.isInWater
    floated ||= output.predictedState.isInWater && output.controls.jump === true
    if (output.phase !== 'moving') break
  }
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.equal(wet, true)
  assert.equal(floated, true)
  assert.equal(output.predictedState.onGround, true)
  assert.equal(output.predictedState.isInWater, false)
  assert.equal(output.predictedState.position.y, 63)
  assert.ok(Math.hypot(output.predictedState.position.x - 7.5, output.predictedState.position.z + 1.5) < 0.2)
  assert.equal(output.serverConfirmed, false)
  assert.deepEqual(initial, before)
})

test('surface recovery rejects unknown shoreline or submerged-head origins and never grants dry navigation a water fallback', () => {
  const river = (x, y) => block(y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air', x >= 8 && y >= 60 && y <= 62 ? { liquid_depth: 0 } : {})
  const snapshot = { position: { x: 8.50558, y: 64.91255, z: -1.96432 }, gameMode: 'survival' }
  const dry = createNavigator({ world: { getBlock: river } })
  assert.equal(dry.plan(dry.physics.fromServer(snapshot), { x: 7.5, y: 63, z: -1.5 }).ready, false)
  const unknown = createNavigator({ world: { getBlock: (x, y) => x <= 7 ? { known: false, reason: 'not received' } : river(x, y) }, allowWater: true })
  const denied = unknown.plan(unknown.physics.fromServer(snapshot), { x: 7.5, y: 63, z: -1.5 }, { maxDistance: 3 })
  assert.equal(denied.ready, false)
  assert.ok(denied.unknownFrontier.length > 0)
  const wet = createNavigator({ world: { getBlock: river }, allowWater: true })
  const submerged = wet.physics.fromServer({ ...snapshot, position: { ...snapshot.position, y: 61.82 } })
  assert.equal(wet.plan(submerged, { x: 7.5, y: 63, z: -1.5 }).ready, false)
})

function wallContactFixture (override = () => null) {
  // Minimal local geometry from the received nav-stuck capture: a full floor,
  // short grass in the current cell and a one-block grass wall on its north.
  const world = { getBlock: (x, y, z) => override(x, y, z) ?? block(y < 71 ? 'dirt' : y === 71 ? z <= 11 ? 'dirt' : 'grass_block' : y === 72 && z === 11 ? 'grass_block' : y === 72 && z === 12 ? 'short_grass' : 'air') }
  const navigator = createNavigator({ world })
  const snapshot = { position: { x: -22.508010864257812, y: 73.62, z: 12.299997329711914 }, gameMode: 'survival', rotation: { yaw: -90, pitch: 0 } }
  const initial = navigator.physics.fromServer(snapshot, { onGround: true })
  return { navigator, initial, snapshot }
}

test('float32 wall contact uses a fully supported initial skin then walks out without snapping the observation', () => {
  const { navigator, initial, snapshot } = wallContactFixture()
  const before = structuredClone(initial)
  const route = navigator.plan(initial, { x: -22.5, y: 72, z: 13.5 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.origin, initial.position)
  const stepper = navigator.createStepper(route, initial)
  let result
  for (let index = 0; index < 120; index++) {
    result = stepper.next()
    if (index === 0) assert.ok(result.predictedState.position.z > initial.position.z, 'the escape from contact requires ordinary movement')
    if (result.phase !== 'moving') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.predictedState.position.y, 72)
  assert.equal(result.predictedState.onGround, true)
  assert.ok(result.predictedState.position.z > 13.2)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(initial, before)
  assert.equal(snapshot.position.z, 12.299997329711914)
})

test('initial contact skin cannot forgive a real wall overlap, an unknown cell or absent actual support', () => {
  const wall = wallContactFixture()
  wall.initial.position.z = 12.299
  assert.equal(wall.navigator.plan(wall.initial, { x: -22.5, y: 72, z: 13.5 }).ready, false)
  for (const replacement of [{ known: false, reason: 'not received' }]) {
    const floor = wallContactFixture((x, y, z) => z === 11 && y === 71 ? replacement : null)
    assert.equal(floor.navigator.plan(floor.initial, { x: -22.5, y: 72, z: 13.5 }).ready, false)
  }
  const unsupported = wallContactFixture((x, y, z) => y === 71 && (z === 11 || z === 12) ? block('air') : null)
  assert.equal(unsupported.navigator.plan(unsupported.initial, { x: -22.5, y: 72, z: 13.5 }).ready, false)
  const unknownWall = wallContactFixture((x, y, z) => z === 11 && y === 72 ? { known: false, reason: 'not received' } : null)
  const denied = unknownWall.navigator.plan(unknownWall.initial, { x: -22.5, y: 72, z: 13.5 })
  assert.equal(denied.ready, false)
  assert.ok(denied.unknownFrontier.length > 0)
})

function partialCornerContactFixture (override = () => null, options = {}) {
  // Minimal received geometry from the NW platform: full stone to the west,
  // an open shaft under the eastern foot edge, and the Hut wall to the north.
  const world = { getBlock: (x, y, z) => override(x, y, z) ?? block(x === -8 && y === 66 && z === 13 ? 'air' : y < 67 ? 'stone' : (x === -9 || x === -8) && z === 12 && (y === 67 || y === 68) ? y === 67 ? 'dirt' : 'grass_block' : 'air') }
  const navigator = createNavigator({ world, ...options })
  const snapshot = { position: { x: -8.228873, y: 68.62, z: 13.299997329711914 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } }
  const initial = navigator.physics.fromServer(snapshot, { onGround: true })
  return { world, navigator, snapshot, initial }
}

test('grounded partial ledge and float32 Hut-corner contact walk to known full support without changing received pose', () => {
  const { navigator, snapshot, initial } = partialCornerContactFixture()
  const before = structuredClone({ snapshot, initial })
  assert.equal(navigator.physics.hasSupport(initial.position), true)
  assert.equal(navigator.physics.blockAt({ x: -8, y: 66, z: 13 }).shapes.length, 0)
  assert.deepEqual(navigator.physics.blockAt({ x: -9, y: 66, z: 13 }).shapes, [[0, 0, 0, 1, 1, 1]])
  const route = navigator.plan(initial, { x: -8.5, y: 67, z: 13.5 }, { maxDistance: 2 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.origin, initial.position)
  const stepper = navigator.createStepper(route, initial)
  let output
  for (let tick = 0; tick < 120; tick++) {
    output = stepper.next()
    if (tick === 0) {
      assert.ok(output.predictedState.position.x < initial.position.x, 'ordinary input moves away from the shaft edge')
      assert.ok(output.predictedState.position.z > initial.position.z, 'ordinary input moves away from the micro-contact wall')
    }
    if (output.phase !== 'moving') break
  }
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.equal(output.predictedState.onGround, true)
  assert.equal(output.predictedState.position.y, 67)
  assert.ok(output.predictedState.position.x + 0.3 < -8, 'the whole final body footprint is back over the stone column')
  assert.ok(output.predictedState.position.z - 0.3 > 13, 'the final body is outside the corner wall')
  assert.equal(output.serverConfirmed, false)
  assert.deepEqual({ snapshot, initial }, before)
})

test('partial contact skin rejects unknown, water, lava, secondary layers and irregular support', () => {
  for (const replacement of [
    { known: false, reason: 'unreceived eastern edge' }, block('water', { liquid_depth: 0 }), block('lava', { liquid_depth: 0 })
  ]) for (const allowWater of [false, true]) {
    const f = partialCornerContactFixture((x, y, z) => x === -8 && y === 66 && z === 13 ? replacement : null, { allowWater })
    assert.equal(f.navigator.plan(f.initial, { x: -8.5, y: 67, z: 13.5 }).ready, false)
  }
  for (const replacement of [block('oak_slab', { 'minecraft:vertical_half': 'top' }), { ...block('stone'), extra: [block('water', { liquid_depth: 0 })] }]) {
    const f = partialCornerContactFixture((x, y, z) => x === -9 && y === 66 && z === 13 ? replacement : null)
    assert.equal(f.navigator.plan(f.initial, { x: -8.5, y: 67, z: 13.5 }).ready, false)
  }
  const unknownWall = partialCornerContactFixture((x, y, z) => x === -8 && y === 67 && z === 12 ? { known: false, reason: 'corner not received' } : null)
  const denied = unknownWall.navigator.plan(unknownWall.initial, { x: -8.5, y: 67, z: 13.5 })
  assert.equal(denied.ready, false)
  assert.ok(denied.unknownFrontier.length > 0)
})

test('partial contact skin cannot excuse true wall penetration, airborne state or a missing supporting ledge', () => {
  const wall = partialCornerContactFixture()
  wall.initial.position.z = 13.298
  assert.equal(wall.navigator.plan(wall.initial, { x: -8.5, y: 67, z: 13.5 }).ready, false)
  const air = partialCornerContactFixture()
  air.initial.onGround = false
  assert.equal(air.navigator.plan(air.initial, { x: -8.5, y: 67, z: 13.5 }).ready, false)
  const gap = partialCornerContactFixture((x, y, z) => y === 66 && (x === -9 || x === -8) && (z === 12 || z === 13) ? block('air') : null)
  assert.equal(gap.navigator.physics.hasSupport(gap.initial.position), false)
  assert.equal(gap.navigator.plan(gap.initial, { x: -8.5, y: 67, z: 13.5 }).ready, false)
})

test('an excavated three-high descending staircase can be climbed back with clipped jump arcs', () => {
  const opened = new Set()
  for (let x = 0; x <= 3; x++) {
    const feet = 65 - x
    for (let y = feet; y <= feet + 2; y++) opened.add(`${x},${y},0`)
  }
  const world = { getBlock: (x, y, z) => block(opened.has(`${x},${y},${z}`) ? 'air' : 'stone') }
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer({ position: { x: 3.5, y: 63.62, z: 0.5 }, gameMode: 'survival', rotation: { yaw: 90, pitch: 0 } })
  // First prove that the real shared physics can hit the ceiling and still
  // clear a one-block riser; no imaginary jump apex is needed in the planner.
  let physical = initial
  let touchedCeiling = false
  for (let index = 0; index < 24; index++) {
    physical = navigator.physics.step(physical, { forward: true, jump: index === 0 })
    touchedCeiling ||= physical.isCollidedVertically && !physical.onGround
  }
  assert.equal(touchedCeiling, true)
  assert.equal(physical.onGround, true)
  assert.equal(physical.position.y, 63)
  const route = navigator.plan(initial, { x: 0.5, y: 65, z: 0.5 }, { maxDistance: 4 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial)
  let result
  for (let index = 0; index < 240; index++) {
    result = stepper.next()
    if (result.phase !== 'moving') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.predictedState.onGround, true)
  assert.equal(result.predictedState.position.y, 65)
  assert.ok(Math.abs(result.predictedState.position.x - 0.5) < 0.35)
})

function edgeApproachFixture (override = () => null) {
  // Minimal terrain from edge-approach: a supported one-cell depression next
  // to a higher grass ledge. Cells outside the received 7x7x7 remain unknown.
  const world = { getBlock: (x, y, z) => {
    if (x < -12 || x > -6 || y < 65 || y > 71 || z < 16 || z > 22) return { known: false, reason: 'outside received fixture' }
    const supplied = override(x, y, z)
    if (supplied) return supplied
    const top = x <= -10 ? 67 : x === -9 && z === 19 ? 68 : 69
    return x === -8 && y === 69 && z === 19 ? block('acacia_log', { pillar_axis: 'y' }) : block(y < top - 1 ? 'dirt' : y === top - 1 ? 'grass_block' : 'air')
  } }
  const navigator = createNavigator({ world })
  const snapshot = { position: { x: -8.514577865600586, y: 69.62, z: 19.606430294684493 }, gameMode: 'survival', rotation: { yaw: 5.5940093994140625, pitch: -68.41426849365234 } }
  const initial = navigator.physics.fromServer(snapshot, { onGround: true })
  return { navigator, snapshot, initial }
}

test('captured full-support depression starts ordinary up/down movement without any new position correction', () => {
  const { navigator, initial, snapshot } = edgeApproachFixture()
  const before = structuredClone(initial)
  assert.equal(navigator.physics.hasSupport(initial.position), true)
  assert.equal(navigator.physics.blockAt(initial.position).name, 'air')
  for (const target of [{ x: -8.5, y: 69, z: 20.5 }, { x: -9.5, y: 67, z: 19.5 }]) {
    const route = navigator.plan(initial, target)
    assert.equal(route.ready, true, route.reason)
    const stepper = navigator.createStepper(route, initial)
    let result
    for (let index = 0; index < 160; index++) {
      result = stepper.next()
      if (result.phase !== 'moving') break
    }
    assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
    assert.equal(result.predictedState.onGround, true)
    assert.equal(result.predictedState.position.y, target.y)
    assert.equal(result.serverConfirmed, false)
  }
  assert.deepEqual(initial, before)
  assert.deepEqual(snapshot.position, { x: -8.514577865600586, y: 69.62, z: 19.606430294684493 })
  const outside = navigator.plan(initial, { x: -13.5, y: 67, z: 20.5 })
  assert.equal(outside.ready, false, 'the requested outside stance is beyond the received fixture')
  assert.ok(outside.unknownFrontier.length > 0)
})

test('captured raw partial-support ledge connects to a real supported centre using normal physics', () => {
  const { navigator, snapshot } = edgeApproachFixture()
  const raw = { ...snapshot, position: { x: -8.514577865600586, y: 70.62001037597656, z: 19.88666343688965 } }
  const initial = navigator.physics.fromServer(raw)
  const before = structuredClone(initial)
  assert.equal(navigator.physics.hasSupport(initial.position), true)
  assert.equal(navigator.physics.blockAt({ x: -9, y: 68, z: 19 }).shapes.length, 0)
  assert.equal(navigator.physics.blockAt({ x: -9, y: 68, z: 20 }).shapes.length, 1)
  const route = navigator.plan(initial, { x: -8.5, y: 69, z: 20.5 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.origin, initial.position)
  const stepper = navigator.createStepper(route, initial)
  let result
  for (let index = 0; index < 120; index++) {
    result = stepper.next()
    if (result.phase !== 'moving') break
  }
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.predictedState.onGround, true)
  assert.equal(result.predictedState.position.y, 69)
  assert.ok(result.predictedState.position.z > 20.2)
  assert.deepEqual(initial, before)
})

test('a partial-support connector cannot replace unknown, water, missing support or a true wall with safe terrain', () => {
  for (const kind of ['unknown', 'water', 'void', 'wall']) {
    const { navigator, snapshot } = edgeApproachFixture((x, y, z) => {
      if (x !== -9 || z !== 20) return null
      if (kind === 'wall' && y === 69) return block('stone')
      if (y !== 68) return null
      return kind === 'unknown' ? { known: false, reason: 'not received' } : kind === 'water' ? block('water', { liquid_depth: 0 }) : kind === 'void' ? block('air') : null
    })
    const initial = navigator.physics.fromServer({ ...snapshot, position: { x: -8.514577865600586, y: 70.62001037597656, z: 19.88666343688965 } }, { onGround: true })
    assert.equal(navigator.plan(initial, { x: -8.5, y: 69, z: 20.5 }).ready, false, kind)
  }
})

test('opt-in sprint advances a known level corridor faster and brakes to a grounded settled target', () => {
  const { navigator, initial } = fixture()
  const route = navigator.plan(initial, { x: 8.5, y: 65, z: 0.5 })
  const run = sprint => {
    const stepper = navigator.createStepper(route, initial, { sprint })
    const frames = []
    for (let index = 0; index < 240; index++) {
      const frame = stepper.next(); frames.push(frame)
      if (frame.phase !== 'moving') break
    }
    return frames
  }
  const walking = run(false)
  const sprinting = run(true)
  assert.ok(sprinting.some(frame => frame.controls.sprint === true))
  assert.ok(walking.every(frame => !frame.controls.sprint))
  assert.ok(sprinting.length < walking.length)
  const final = sprinting.at(-1)
  assert.equal(final.phase, 'awaiting_server_confirmation', final.reason)
  assert.equal(final.predictedState.onGround, true)
  assert.ok(Math.abs(final.predictedState.position.x - 8.5) < 0.35)
  assert.ok(Math.hypot(final.predictedState.velocity.x, final.predictedState.velocity.z) < 0.006)
  assert.ok(sprinting.filter(frame => Math.abs(frame.predictedState.position.x - 8.5) < 2).every(frame => !frame.controls.sprint))
  assert.equal(final.serverConfirmed, false)
  assert.throws(() => navigator.createStepper(route, initial, { sprint: 'true' }), /boolean/)
})

test('sprint is withheld for sharp turns, one-block jumps, water and nearby targets', () => {
  const straight = fixture()
  const turnRoute = { ready: true, target: { x: 8.5, y: 65, z: 3.5 }, waypoints: [{ x: 2.5, z: 0.5 }, { x: 2.5, z: 3.5 }, { x: 8.5, z: 3.5 }].map(p => ({ position: { ...p, y: 65 }, medium: 'land', action: 'walk' })) }
  const turning = straight.navigator.createStepper(turnRoute, straight.initial, { sprint: true })
  let previous = straight.initial
  let turnCount = 0
  for (let index = 0; index < 240; index++) {
    const frame = turning.next()
    const angle = Math.abs((frame.predictedState.yaw - previous.yaw + 540) % 360 - 180)
    if (angle > 25) { turnCount++; assert.equal(!!frame.controls.sprint, false) }
    previous = frame.predictedState
    if (frame.phase !== 'moving') { assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason); break }
  }
  assert.ok(turnCount > 0)
  const terrace = fixture((x, y) => x >= 4 && y === 65 ? block('stone') : null)
  const jumping = terrace.navigator.createStepper(terrace.navigator.plan(terrace.initial, { x: 9.5, y: 66, z: 0.5 }), terrace.initial, { sprint: true })
  let jumped = false
  let final
  for (let index = 0; index < 240; index++) {
    final = jumping.next()
    jumped ||= final.controls.jump === true
    if (final.controls.jump || !final.predictedState.onGround || final.waypoint?.action === 'jump') assert.equal(!!final.controls.sprint, false)
    if (final.phase !== 'moving') break
  }
  assert.equal(jumped, true)
  assert.equal(final.phase, 'awaiting_server_confirmation', final.reason)
  const wet = fixture((x, y) => x >= 1 && y >= 60 && y <= 64 ? block('water', { liquid_depth: 0 }) : null, { allowWater: true })
  const swimming = wet.navigator.createStepper(wet.navigator.plan(wet.initial, { x: 3.5, z: 0.5 }), wet.initial, { sprint: true })
  for (let index = 0; index < 180; index++) { const frame = swimming.next(); assert.equal(!!frame.controls.sprint, false); if (frame.phase !== 'moving') break }
  const nearby = straight.navigator.createStepper(straight.navigator.plan(straight.initial, { x: 2.5, y: 65, z: 0.5 }), straight.initial, { sprint: true })
  for (let index = 0; index < 80; index++) { const frame = nearby.next(); assert.equal(!!frame.controls.sprint, false); if (frame.phase !== 'moving') break }
})
