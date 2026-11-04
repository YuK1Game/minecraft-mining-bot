'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planEmergencyLeaf, clearanceHandKey, clearanceEquipmentKey } = require('../src/emergency-leaf')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const { createMining } = require('../src/mining')

const key = point => `${point.x},${point.y},${point.z}`
const upper = { x: -16, y: 68, z: 30 }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const segmentDistance = (point, from, to) => {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * delta.x + (point.y - from.y) * delta.y + (point.z - from.z) * delta.z) / length)) : 0
  return distance(point, { x: from.x + t * delta.x, y: from.y + t * delta.y, z: from.z + t * delta.z })
}

function fixture () {
  const observed = require('./fixtures/queued-tail-soil.json')
  const blocks = new Map([...(observed.blocks ?? []), ...(observed.lowerTerrain ?? [])].map(block => [key(block.position), structuredClone(block)]))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const state = {
    phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: observed.health,
    position: structuredClone(observed.position), rawServerPosition: structuredClone(observed.rawServerPosition),
    predicted: structuredClone(observed.predicted), threatPolicy: 'balanced_mining', runtimeEntityId: '9999',
    rawSelectedSlot: 0, rawServerSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true,
    inventory: { known: true, items: [{ slot: 0, name: 'minecraft:rotten_flesh', count: 2 }, { slot: 1, name: 'minecraft:porkchop', count: 2 }] },
    heldItem: { slot: 0, name: 'minecraft:rotten_flesh', count: 2 }, entities: structuredClone(observed.enemies),
    entityStats: { unknownPositions: 0 }, crafting: { openContainer: null }
  }
  return { observed, blocks, world, state }
}

function holding (state, name, count = 2) {
  state.inventory.items = state.inventory.items.filter(item => item.slot !== 0)
  state.heldItem = name ? { slot: 0, name, count } : null
  if (name) state.inventory.items.unshift({ ...state.heldItem })
}

test('captured soil obstruction permits one predicted upper-block clear and a fully simulated uphill escape', () => {
  const f = fixture(); const before = structuredClone([...f.blocks])
  const plan = planEmergencyLeaf(f)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.equal(plan.kind, 'soil')
  assert.deepEqual(plan.block, upper)
  assert.equal(plan.name, 'minecraft:grass_block')
  assert.equal(plan.target.y, 68)
  assert.equal(plan.predictionOnly, true)
  assert.equal(plan.serverConfirmed, false)
  assert.deepEqual([...f.blocks], before)

  const evaluation = evaluateThreats(f.state, f.state.entities, { observationRadius: 32 })
  assert.equal(evaluation.threats.length, 1)
  const primary = evaluation.threats[0]
  const circles = [...evaluation.threats, ...evaluation.outsideDanger].map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.runtimeId === primary.runtimeId ? primary.distance : actor.dangerRadius, padding: 0 }))
  const normal = createNavigator({ world: f.world, version: '1.26.60' })
  const blocked = normal.plan(normal.physics.fromServer(f.state), plan.target, { maxDistance: 2, maxExpanded: 128, exactGoal: true, directFlat: true, avoidance: circles })
  assert.equal(blocked.ready, false, 'the current upper soil block must obstruct this exact landing')
  const overlay = { getBlock: (x, y, z) => key({ x, y, z }) === key(upper) ? { known: true, name: 'minecraft:air', properties: {}, extra: [] } : f.world.getBlock(x, y, z) }
  const nav = createNavigator({ world: overlay, version: '1.26.60' })
  const initial = nav.physics.fromServer(f.state)
  const route = nav.plan(initial, plan.target, { maxDistance: 2, maxExpanded: 128, exactGoal: true, directFlat: true, avoidance: circles })
  assert.equal(route.ready, true, JSON.stringify(route))
  assert.equal(route.waypoints.length, 1)
  assert.equal(route.waypoints[0].action, 'jump')
  assert.equal(route.waypoints[0].medium, 'land')
  const stepper = nav.createStepper(route, initial, { maxTicks: 40, sprint: false })
  let previous = f.state.position; let final = null
  for (let i = 0; i < 40; i++) {
    const frame = stepper.next()
    const eye = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
    assert.equal(frame.predictedState.isInWater, false)
    assert.equal(frame.predictedState.isInLava, false)
    assert.ok(circles.every(circle => segmentDistance(circle.position, previous, eye) >= circle.minDistance - 1e-4), `actor floor crossed at tick ${i}`)
    previous = eye
    if (frame.phase === 'awaiting_server_confirmation') { final = frame.predictedState; break }
    assert.equal(frame.phase, 'moving')
  }
  assert.ok(final, 'the real stepper must settle within the existing 40 tick bound')
  assert.equal(final.onGround, true)
  assert.ok(distance(primary.position, previous) >= primary.distance + 0.25)
  const mining = createMining({ getState: () => f.state, world: f.world, getInput: () => ({}) })
  assert.equal(mining.preview([upper]).ready, true)
  assert.equal(mining.preview([{ x: -16, y: 66, z: 29 }]).ready, false)
})

test('the captured upper soil escape accepts only confirmed empty or harmless hand equipment', () => {
  for (const name of [null, 'minecraft:rotten_flesh', 'minecraft:porkchop']) {
    const f = fixture(); holding(f.state, name)
    assert.equal(planEmergencyLeaf(f).ready, true, name ?? 'empty hand')
  }
  for (const mode of ['mismatch', 'held_count', 'held_slot', 'held_absent', 'fractional_count', 'zero_count', 'inventory_unknown', 'inventory_uncertain', 'equipment_unconfirmed', 'bad_slot', 'container', 'other_item']) {
    const f = fixture()
    if (mode === 'mismatch') f.state.inventory.items[0].name = 'minecraft:porkchop'
    if (mode === 'held_count') f.state.heldItem.count = 1
    if (mode === 'held_slot') f.state.heldItem.slot = 1
    if (mode === 'held_absent') f.state.heldItem = null
    if (mode === 'fractional_count') { f.state.heldItem.count = 1.5; f.state.inventory.items[0].count = 1.5 }
    if (mode === 'zero_count') { f.state.heldItem.count = 0; f.state.inventory.items[0].count = 0 }
    if (mode === 'inventory_unknown') f.state.inventory.known = false
    if (mode === 'inventory_uncertain') f.state.inventory.uncertain = true
    if (mode === 'equipment_unconfirmed') f.state.equipmentServerConfirmed = false
    if (mode === 'bad_slot') f.state.rawServerSelectedSlot = 9
    if (mode === 'container') f.state.crafting.openContainer = 4
    if (mode === 'other_item') holding(f.state, 'minecraft:stick')
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})

test('upper soil clearing requires the existing healthy dry supported origin', () => {
  for (const mode of ['low_health', 'airborne', 'water', 'lava', 'fractional_floor']) {
    const f = fixture()
    if (mode === 'low_health') f.state.health = 8.9
    if (mode === 'airborne') f.state.predicted.physicsState.onGround = false
    if (mode === 'water') f.state.predicted.physicsState.isInWater = true
    if (mode === 'lava') f.state.predicted.physicsState.isInLava = true
    if (mode === 'fractional_floor') f.state.position.y += 0.1
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})

test('clearance equipment receipts retain exact slot, harmless item and stack count', () => {
  const f = fixture()
  const key = clearanceHandKey(f.state)
  assert.equal(typeof key, 'string')
  assert.equal(clearanceHandKey(structuredClone(f.state)), key)
  assert.equal(clearanceEquipmentKey(f.state), key)
  holding(f.state, 'minecraft:rotten_flesh', 1)
  assert.notEqual(clearanceHandKey(f.state), key)
  holding(f.state, 'minecraft:porkchop', 2)
  assert.notEqual(clearanceHandKey(f.state), key)
  f.state.rawServerSelectedSlot = 1; f.state.rawSelectedSlot = 1; f.state.selectedSlot = 1
  f.state.inventory.items = [{ slot: 1, name: 'minecraft:rotten_flesh', count: 2 }]
  f.state.heldItem = { slot: 1, name: 'minecraft:rotten_flesh', count: 2 }
  assert.notEqual(clearanceHandKey(f.state), key)
  holding(f.state, 'minecraft:stone_sword', 1)
  f.state.rawServerSelectedSlot = 0; f.state.rawSelectedSlot = 0; f.state.selectedSlot = 0
  assert.equal(clearanceHandKey(f.state), null)
  assert.equal(typeof clearanceEquipmentKey(f.state), 'string')
})

test('only the adjacent upper dirt or grass obstruction is eligible for this hand escape', () => {
  const dirt = fixture(); dirt.blocks.get(key(upper)).name = 'minecraft:dirt'
  assert.equal(planEmergencyLeaf(dirt).ready, true)
  for (const mode of ['protected', 'protection_source', 'unnatural', 'layer', 'unknown', 'undiggable', 'unbreakable', 'stone', 'gravity']) {
    const f = fixture(); const block = f.blocks.get(key(upper))
    if (mode === 'protected') block.protected = true
    if (mode === 'protection_source') block.protectionSource = 'bot_base'
    if (mode === 'unnatural') block.natural = false
    if (mode === 'layer') block.extra.push({ name: 'minecraft:water' })
    if (mode === 'unknown') block.known = false
    if (mode === 'undiggable') block.diggable = false
    if (mode === 'unbreakable') block.hardness = -1
    if (mode === 'stone') block.name = 'minecraft:stone'
    if (mode === 'gravity') block.name = 'minecraft:sand'
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})

test('upper soil clearance rejects unsafe neighbours, missing support, own footprint and unknown landing body', () => {
  for (const mode of ['water_neighbour', 'gravity_neighbour', 'unknown_neighbour', 'missing_support', 'own_footprint', 'landing_body']) {
    const f = fixture()
    if (mode === 'water_neighbour') f.blocks.get('-17,68,30').name = 'minecraft:water'
    if (mode === 'gravity_neighbour') f.blocks.get('-17,68,30').name = 'minecraft:gravel'
    if (mode === 'unknown_neighbour') f.blocks.get('-17,68,30').known = false
    if (mode === 'missing_support') f.blocks.get('-16,67,30').name = 'minecraft:air'
    if (mode === 'own_footprint') {
      f.state.position.z = 29.75; f.state.predicted.physicsState.position.z = 29.75
      f.state.predicted.position.z = 29.75; f.state.predicted.feetPosition.z = 29.75
    }
    if (mode === 'landing_body') f.blocks.get('-16,69,30').known = false
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})

test('upper soil prediction preserves current actor floors and rejects changed or unknown dangers', () => {
  for (const mode of ['primed', 'charged', 'close', 'identity', 'new_enemy', 'unknown_enemy', 'outside_floor', 'player']) {
    const f = fixture()
    const creeper = f.state.entities.find(actor => actor.runtimeId === '24')
    if (mode === 'primed') creeper.primed = true
    if (mode === 'charged') creeper.charged = true
    if (mode === 'close') creeper.position = { x: f.state.position.x, y: 68, z: f.state.position.z - 3 }
    if (mode === 'identity') delete creeper.uniqueId
    if (mode === 'new_enemy') f.state.entities.push({ runtimeId: '9001', uniqueId: '9001', entityType: 'minecraft:zombie', position: { x: -15, y: 68, z: 25 } })
    if (mode === 'unknown_enemy') f.state.entities.push({ runtimeId: '9001', uniqueId: '9001', entityType: 'minecraft:zombie', positionKnown: false })
    if (mode === 'outside_floor') f.state.entities.push({ runtimeId: '9001', uniqueId: '9001', entityType: 'minecraft:creeper', primed: false, charged: false, position: { x: -15.5, y: 68, z: 38 } })
    if (mode === 'player') f.state.entities.push({ kind: 'player', runtimeId: '9001', uniqueId: '9001', position: { x: -15.5, y: 68, z: 30.5 } })
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})
