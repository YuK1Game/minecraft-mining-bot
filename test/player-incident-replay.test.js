'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sampleTerrain, replayTerrain } = require('../src/modes/incident-terrain')
const { createNavigator } = require('../src/movement/navigation')

test('incident palette round-trips air, unknown positions, stair orientation and water layers', () => {
  const feet = { x: 0.5, y: 65, z: 0.5 }
  const getBlock = (x, y, z) => {
    const position = { x, y, z }
    if (x === 1) return { known: false, position, name: null, properties: null, runtimeId: null, reason: 'subchunk_not_received' }
    if (y === 64) return { known: true, position, name: 'minecraft:oak_stairs', runtimeId: 14, properties: { upside_down_bit: false, weirdo_direction: z > 0 ? 1 : 2 }, boundingBox: 'block', hardness: 2, diggable: true, extra: [{ name: 'minecraft:water', runtimeId: 99, properties: { liquid_depth: 0 } }] }
    return { known: true, position, name: y === 65 ? 'minecraft:air' : 'minecraft:cave_air', properties: {}, extra: [] }
  }
  const saved = JSON.parse(JSON.stringify(sampleTerrain(getBlock, feet, 2)))
  const replay = replayTerrain(saved)
  for (let y = 63; y <= 68; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) assert.deepEqual(replay.getBlock(x, y, z), getBlock(x, y, z))
  assert.equal(replay.getBlock(3, 65, 0).known, false)
  const mutated = replay.getBlock(0, 64, 0); mutated.properties.weirdo_direction = 999
  assert.equal(replay.getBlock(0, 64, 0).properties.weirdo_direction, 2)
  const movedUnknown = sampleTerrain((x, y, z) => getBlock(-x, y, z), feet, 2)
  assert.equal(saved.unknownCount, movedUnknown.unknownCount)
  assert.notEqual(saved.cells, movedUnknown.cells, 'equal unknown counts cannot hide where the unknown cells were')
})

test('saved incident replays the real navigator decision and never turns missing terrain into air', () => {
  const feet = { x: 0.5, y: 65, z: 0.5 }, target = { x: 2.5, y: 65, z: 0.5 }
  for (const unknown of [false, true]) {
    const getBlock = (x, y, z) => x === 1 && unknown ? { known: false } : { known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }
    const original = { getBlock }, replay = replayTerrain(JSON.parse(JSON.stringify(sampleTerrain(getBlock, feet, 5))))
    const plan = world => {
      const nav = createNavigator({ world })
      const initial = nav.physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
      return nav.plan(initial, target, { maxDistance: 4, exactGoal: true })
    }
    const before = plan(original), after = plan(replay)
    assert.equal(after.ready, before.ready)
    assert.equal(after.ready, !unknown)
    if (after.ready) assert.deepEqual(after.waypoints, before.waypoints)
  }
})

test('legacy incidents remain visibly incomplete and invalid palettes fail closed', () => {
  const old = replayTerrain({ nonAirKnown: [[0, 64, 0, 'minecraft:stone']], unknownCount: 1 })
  assert.equal(old.getBlock(0, 64, 0).name, 'minecraft:stone')
  assert.equal(old.getBlock(0, 65, 0).known, false)
  const saved = sampleTerrain(() => ({ known: true, name: 'minecraft:air' }), { x: 0, y: 65, z: 0 }, 0)
  assert.throws(() => replayTerrain({ ...saved, cells: saved.cells.slice(4) }), /Invalid incident terrain/)
  assert.throws(() => replayTerrain({ ...saved, radius: 1000 }), /Invalid incident terrain/)
})
