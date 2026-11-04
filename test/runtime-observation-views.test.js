'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createActorReader } = require('../src/runtime-observation-views')
const { createEntities } = require('../src/entities')
const { annotateTerrainThreats } = require('../src/terrain-threats')

test('actor views reuse only a received revision while keeping positions and events independent', () => {
  const tracker = createEntities({ clock: () => 'received' })
  tracker.applyPacket('start_game', { runtime_entity_id: 1n, dimension: 0 })
  tracker.applyPacket('add_entity', { entity_type: 'minecraft:zombie', unique_id: 20n, runtime_id: 2n, position: { x: 1, y: 64, z: 2 } })
  tracker.applyPacket('entity_event', { runtime_entity_id: 2n, event_id: 'hurt_animation', data: 3 })
  let reads = 0
  const read = createActorReader({ version: tracker.version, snapshot: options => { reads++; return tracker.snapshot(options) } })
  const first = read()
  first[0].position.x = 99
  first[0].lastEvent.event = 'invented'
  first[0].hostile = false
  first.push({ runtimeId: 'invented' })
  assert.deepEqual(read(), tracker.snapshot({ kind: 'all' }))
  assert.equal(reads, 1)
  tracker.applyPacket('move_entity_delta', { runtime_entity_id: 2n, x: 4 })
  assert.equal(read()[0].position.x, 4)
  assert.equal(reads, 2)
  tracker.applyPacket('remove_entity', { entity_id_self: 20n })
  assert.deepEqual(read(), [])
  tracker.applyPacket('add_entity', { entity_type: 'minecraft:skeleton', unique_id: 30n, runtime_id: 2n })
  assert.equal(read()[0].uniqueId, '30')
  assert.equal(read()[0].positionKnown, false)
  assert.equal(read()[0].position, null)
  tracker.applyPacket('change_dimension', { dimension: 1 })
  assert.deepEqual(read(), [])
})

test('actor readers without a version never retain observations, including a temporarily unavailable version', () => {
  let version = 1, x = 1, reads = 0
  const tracker = { version: () => version, snapshot: () => { reads++; return [{ runtimeId: '2', positionKnown: true, position: { x, y: 64, z: 0 } }] } }
  const read = createActorReader(tracker)
  assert.equal(read()[0].position.x, 1)
  version = null; x = 2
  assert.equal(read()[0].position.x, 2)
  x = 3
  assert.equal(read()[0].position.x, 3)
  version = 1; x = 4
  assert.equal(read()[0].position.x, 4)
  assert.equal(reads, 4)
  delete tracker.version
  x = 5
  assert.equal(read()[0].position.x, 5)
})

test('owned terrain annotation avoids a second actor copy without changing default isolation or unknown evidence', () => {
  const tracker = createEntities()
  tracker.applyPacket('start_game', { runtime_entity_id: 1n, dimension: 0 })
  tracker.applyPacket('add_entity', { entity_type: 'minecraft:skeleton', unique_id: 20n, runtime_id: 2n, position: { x: 1, y: 64, z: 2 } })
  tracker.applyPacket('add_entity', { entity_type: 'minecraft:zombie', unique_id: 30n, runtime_id: 3n })
  const read = createActorReader(tracker), actors = read()
  const state = { dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }, options = { world: { getBlock: () => ({ known: false }) }, now: () => 1000, maxEntities: 1 }
  const normal = annotateTerrainThreats(state, actors, options)
  const owned = annotateTerrainThreats(state, actors, { ...options, ownedEntities: true })
  assert.deepEqual(owned, normal)
  assert.notEqual(normal[0].position, actors[0].position)
  assert.equal(owned[0].position, actors[0].position)
  assert.equal(owned[1].positionKnown, false)
  assert.equal(owned[1].terrainOcclusion, null)
  owned[0].position.x = 99
  assert.equal(read()[0].position.x, 1)
  assert.equal(Object.hasOwn(read()[0], 'terrainOcclusion'), false)
})
