'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { constrainedSecondaryFloor, selectConstrainedPrimary, outsideSkeletonFloor, unarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned } = require('../src/escape-policy')

test('single-creeper shallow retreat requires explicit opt-in and observed safe identity', () => {
  const creeper = { runtimeId: '1', name: 'minecraft:creeper', dangerRadius: 8, distance: 5.3, position: { x: 5.3, y: 0, z: 0 } }
  const entity = { runtimeId: '1', uniqueId: '1', primed: false, charged: false }
  const state = { health: 20, position: { x: 0, y: 0, z: 0 }, rawServerSelectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, entities: [entity] }
  const opts = { creeperMinimum: 5, allowSingle: true }
  assert.equal(unarmedCreeperZombie(state, [creeper], opts), true)
  assert.equal(unarmedCreeperZombie(state, [creeper], { creeperMinimum: 5 }), false)
  assert.equal(unarmedCreeperZombie({ ...state, health: 19 }, [creeper], opts), false)
  assert.equal(unarmedCreeperZombie({ ...state, entities: [{ ...entity, primed: true }] }, [creeper], opts), false)
  assert.equal(unarmedCreeperZombie({ ...state, entities: [{ ...entity, charged: true }] }, [creeper], opts), false)
  assert.equal(unarmedCreeperZombie({ ...state, entities: [{ ...entity, uniqueId: null }] }, [creeper], opts), false)
  assert.equal(unarmedCreeperZombie(state, [{ ...creeper, distance: 4.9, position: { x: 4.9, y: 0, z: 0 } }], opts), false)
  assert.equal(unarmedCreeperZombie(state, [{ ...creeper, distance: 4.9, position: { x: 4.9, y: 0, z: 0 } }], { creeperMinimum: 4.5, allowSingle: true }), true)
  assert.equal(unarmedCreeperZombie(state, [{ ...creeper, distance: 4.49, position: { x: 4.49, y: 0, z: 0 } }], { creeperMinimum: 4.5, allowSingle: true }), false)
  assert.equal(unarmedCreeperZombie(state, [{ ...creeper, distance: 4.2, position: { x: 4.2, y: 0, z: 0 } }], { creeperMinimum: 4, allowSingle: true }), true)
  assert.equal(unarmedCreeperZombie(state, [{ ...creeper, distance: 3.99, position: { x: 3.99, y: 0, z: 0 } }], { creeperMinimum: 4, allowSingle: true }), false)
  assert.equal(unarmedCreeperZombie(state, [creeper, { runtimeId: '2', name: 'minecraft:spider', dangerRadius: 12, distance: 11.5 }], { creeperMinimum: 4.5, allowSingle: true }), false)
  assert.equal(unarmedCreeperZombie(state, [creeper, { runtimeId: '2', name: 'minecraft:skeleton', distance: 12 }], opts), false)
})

test('close zombie water policy requires the exact pair and preserves distance floors', () => {
  const creeper = { runtimeId: '1', name: 'minecraft:creeper', dangerRadius: 8, distance: 6, position: { x: -6, y: 0, z: 0 } }
  const zombie = { runtimeId: '2', name: 'minecraft:zombie', dangerRadius: 12, distance: 9.2, position: { x: -9.2, y: 0, z: 0 } }
  const state = { health: 20, position: { x: 0, y: 0, z: 0 }, rawServerSelectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, entities: [{ runtimeId: '1', uniqueId: '1', primed: false, charged: false }, { runtimeId: '2', uniqueId: '2' }] }
  const opts = { creeperMinimum: 4, zombieMinimum: 9, allowCloseZombie: true }
  assert.equal(unarmedCreeperZombie(state, [creeper, zombie], opts), true)
  assert.equal(unarmedCreeperZombie(state, [creeper, { ...zombie, distance: 8.99 }], opts), false)
  assert.equal(unarmedCreeperZombie(state, [creeper, { ...zombie, position: { x: -7.4, y: 6, z: 0 } }], opts), false)
  assert.equal(unarmedCreeperZombie(state, [creeper, zombie], { ...opts, zombieMinimum: 8.99 }), false)
  assert.equal(unarmedCreeperZombie({ ...state, entities: [state.entities[0], { ...state.entities[1], uniqueId: null }] }, [creeper, zombie], opts), false)
  assert.equal(unarmedCreeperZombie(state, [creeper, zombie, { runtimeId: '3', name: 'minecraft:spider', distance: 12 }], opts), false)
  assert.equal(unarmedCreeperZombie({ ...state, entities: [{ ...state.entities[0], primed: true }, state.entities[1]] }, [creeper, zombie], opts), false)
})

test('single zombie water policy requires full health, identity, and distance', () => {
  const zombie = { runtimeId: '2', name: 'minecraft:zombie', dangerRadius: 12, distance: 9.2, position: { x: -9.2, y: 0, z: 0 } }
  const state = { health: 20, position: { x: 0, y: 0, z: 0 }, rawServerSelectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, entities: [{ runtimeId: '2', uniqueId: '2' }] }
  assert.equal(unarmedWaterZombie(state, [zombie]), true)
  assert.equal(unarmedWaterZombie({ ...state, health: 19 }, [zombie]), false)
  assert.equal(unarmedWaterZombie({ ...state, entities: [{ runtimeId: '2' }] }, [zombie]), false)
  assert.equal(unarmedWaterZombie(state, [{ ...zombie, distance: 8.9 }]), false)
  assert.equal(unarmedWaterZombie(state, [{ ...zombie, position: { x: -7.4, y: 6, z: 0 } }]), false)
  assert.equal(unarmedWaterZombie(state, [zombie, { ...zombie, runtimeId: '3' }]), false)
})

test('creeper and drowned water policy requires observed distant submerged enemies', () => {
  const creeper = { runtimeId: '1', name: 'minecraft:creeper', dangerRadius: 8, distance: 6, position: { x: -6, y: 64, z: 0 } }
  const drowned = { runtimeId: '2', name: 'minecraft:drowned', dangerRadius: 14, distance: 13.5, position: { x: 4, y: 51, z: 0 } }
  const state = { health: 20, position: { x: 0, y: 64, z: 0 }, rawServerSelectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, entities: [{ runtimeId: '1', uniqueId: '1', primed: false, charged: false }, { runtimeId: '2', uniqueId: '2' }] }
  assert.equal(unarmedCreeperDrowned(state, [creeper, drowned]), true)
  assert.equal(unarmedCreeperDrowned(state, [creeper, { ...drowned, distance: 10.74 }]), false)
  assert.equal(unarmedCreeperDrowned(state, [creeper, { ...drowned, position: { ...drowned.position, y: 57 } }]), false)
  assert.equal(unarmedCreeperDrowned({ ...state, entities: [state.entities[0], { runtimeId: '2' }] }, [creeper, drowned]), false)
  assert.equal(unarmedCreeperDrowned({ ...state, health: 19 }, [creeper, drowned]), false)
  assert.equal(unarmedCreeperDrowned({ ...state, entities: [{ ...state.entities[0], primed: true }, state.entities[1]] }, [creeper, drowned]), false)
  assert.equal(unarmedCreeperDrowned(state, [creeper, drowned, { ...drowned, name: 'minecraft:skeleton' }]), false)
  assert.equal(unarmedWaterDrowned(state, [drowned]), true)
  assert.equal(unarmedWaterDrowned(state, [{ ...drowned, distance: 10.74 }]), false)
  assert.equal(unarmedWaterDrowned({ ...state, entities: [state.entities[0], { runtimeId: '2' }] }, [drowned]), false)
  assert.equal(unarmedWaterDrowned(state, [creeper, drowned]), false)
})

test('one or two submerged drowned preserve the same unarmed planning requirements', () => {
  const actors = [
    { runtimeId: '1', name: 'minecraft:drowned', dangerRadius: 14, distance: 11.5, position: { x: 2.3, y: 53.6, z: 4 } },
    { runtimeId: '2', name: 'minecraft:drowned', dangerRadius: 14, distance: 13.8, position: { x: -5.3, y: 51.5, z: 0 } }
  ]
  const state = { health: 20, position: { x: 0, y: 64.1, z: 0 }, rawServerSelectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, entities: [{ runtimeId: '1', uniqueId: 'one' }, { runtimeId: '2', uniqueId: 'two' }] }
  assert.equal(unarmedWaterDrowned(state, [actors[0]]), true)
  assert.equal(unarmedWaterDrowned(state, actors), true)
  for (const index of [0, 1]) {
    const near = structuredClone(actors); near[index].distance = 10.74
    assert.equal(unarmedWaterDrowned(state, near), false)
    const shallow = structuredClone(actors); shallow[index].position.y = state.position.y - 7.99
    assert.equal(unarmedWaterDrowned(state, shallow), false)
    const unknown = structuredClone(state); unknown.entities[index].uniqueId = null
    assert.equal(unarmedWaterDrowned(unknown, actors), false)
  }
  assert.equal(unarmedWaterDrowned(state, []), false)
  assert.equal(unarmedWaterDrowned(state, [...actors, { ...actors[1], runtimeId: '3' }]), false)
  assert.equal(unarmedWaterDrowned({ ...state, health: 19 }, actors), false)
  assert.equal(unarmedWaterDrowned({ ...state, inventory: { ...state.inventory, uncertain: true } }, actors), false)
  assert.equal(unarmedWaterDrowned(state, [actors[0], { ...actors[1], name: 'minecraft:zombie' }]), false)
})

test('close spider concession is limited to a healthy-enough player and one ordinary creeper', () => {
  const creeper = { name: 'minecraft:creeper', dangerRadius: 8, distance: 5.9 }
  const spider = { name: 'minecraft:spider', distance: 6 }
  assert.equal(constrainedSecondaryFloor(spider, creeper, [creeper, spider], 12), 5.6)
  assert.equal(constrainedSecondaryFloor(spider, creeper, [creeper, spider], 10), null)
  assert.equal(constrainedSecondaryFloor({ ...spider, distance: 5.24 }, creeper, [creeper, spider], 12), null)
  assert.equal(constrainedSecondaryFloor(spider, { ...creeper, dangerRadius: 12 }, [creeper, spider], 12), null)
  assert.equal(constrainedSecondaryFloor(spider, creeper, [creeper, spider, {}], 12), null)
  assert.equal(constrainedSecondaryFloor({ ...spider, name: 'minecraft:cave_spider' }, creeper, [creeper, spider], 12), null)
})

test('prioritize the ordinary creeper only for the bounded two-enemy concession', () => {
  const creeper = { name: 'minecraft:creeper', dangerRadius: 8, distance: 6.5 }
  const spider = { name: 'minecraft:spider', distance: 5.6 }
  assert.equal(selectConstrainedPrimary([creeper, spider], 12), creeper)
  assert.equal(selectConstrainedPrimary([creeper, spider], 10), spider)
  assert.equal(selectConstrainedPrimary([{ ...creeper, dangerRadius: 12 }, spider], 12), spider)
  assert.equal(selectConstrainedPrimary([{ ...creeper, distance: 5.4 }, spider], 12).name, 'minecraft:creeper')
})

test('witch retreat keeps an 18-block minimum and bounded 1.5-block approach', () => {
  const zombie = { name: 'minecraft:zombie', distance: 4 }
  const witch = { name: 'minecraft:witch', distance: 19.9 }
  assert.equal(constrainedSecondaryFloor(witch, zombie, [zombie, witch], 12), 18.4)
  assert.equal(constrainedSecondaryFloor({ ...witch, distance: 18.2 }, zombie, [zombie, witch], 12), null)
  assert.equal(constrainedSecondaryFloor({ ...witch, distance: 18.3 }, zombie, [zombie, witch], 12), 18)
})

test('only a known outside skeleton near the boundary receives a strict floor', () => {
  assert.equal(outsideSkeletonFloor({ name: 'minecraft:skeleton', distance: 24.3 }), 23.55)
  assert.equal(outsideSkeletonFloor({ name: 'minecraft:skeleton', distance: 24.24 }), null)
  assert.equal(outsideSkeletonFloor({ name: 'minecraft:skeleton', distance: 25.01 }), null)
  assert.equal(outsideSkeletonFloor({ name: 'minecraft:witch', distance: 24.3 }), null)
})

