'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planEmergencyLeaf } = require('../src/emergency-leaf')

function fixture () {
  const observed = require('./fixtures/creeper-route-close.json')
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, structuredClone(b)]))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: observed.health, position: structuredClone(observed.position), rawSelectedSlot: 0, equipmentServerConfirmed: true, runtimeEntityId: 'self', inventory: { known: true, items: [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }] }, heldItem: { slot: 0, name: 'minecraft:stone_sword', count: 1 }, entities: structuredClone(observed.enemies), predicted: { physicsState: { onGround: true } } }
  return { state, blocks, world }
}

test('a recorded natural leaf can be previewed as an escape without changing the world', () => {
  const f = fixture(); const before = structuredClone([...f.blocks])
  const plan = planEmergencyLeaf(f)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.equal(plan.name, 'minecraft:oak_leaves')
  assert.equal(plan.predictionOnly, true)
  assert.equal(plan.serverConfirmed, false)
  assert.deepEqual([...f.blocks], before)
})

test('emergency leaf preview refuses close or primed creepers, unsafe inventory and protected leaves', () => {
  for (const mode of ['near', 'primed', 'inventory', 'health', 'persistent', 'unknown', 'water', 'player']) {
    const f = fixture(); const target = f.blocks.get('0,72,1')
    if (mode === 'near') f.state.entities.find(a => a.entityType === 'minecraft:creeper').position = { ...f.state.position }
    if (mode === 'primed') f.state.entities.find(a => a.entityType === 'minecraft:creeper').primed = true
    if (mode === 'inventory') f.state.inventory.known = false
    if (mode === 'health') f.state.health = 8.9
    if (mode === 'persistent') target.properties.persistent_bit = 1
    if (mode === 'unknown') f.blocks.set('0,72,1', { known: false })
    if (mode === 'water') f.blocks.set('0,71,1', { known: true, name: 'minecraft:water', properties: { liquid_depth: 0 }, extra: [] })
    if (mode === 'player') f.state.entities.push({ kind: 'player', runtimeId: '2000', positionKnown: true, dimension: 'overworld', position: { x: 0.5, y: 73, z: 1.5 } })
    assert.equal(planEmergencyLeaf(f).ready, false, mode)
  }
})

test('a creeper at the last observed distance permits only a predicted leaf escape', () => {
  const f = fixture()
  const creeper = f.state.entities.find(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - f.state.position.x, a.position.z - f.state.position.z) < 10)
  // Coordinates translated into the existing anonymized terrain fixture.
  creeper.position = { x: -1.46529769897461, y: 70, z: -2.554996490478516 }
  const plan = planEmergencyLeaf(f)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.equal(plan.predictionOnly, true)
  assert.equal(plan.serverConfirmed, false)
  creeper.position = { x: -1.2, y: 70, z: -2.2 }
  assert.equal(planEmergencyLeaf(f).reason, 'creeper_too_close_or_primed')
})
