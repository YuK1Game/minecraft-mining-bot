'use strict'
// Live 2026-11-18 16:44-17:03 JST: the Bot stood on the bottom of a lake two
// blocks deep, 1.7 m from a sand shore, and the ledge search said
// 「5マス以内に上がれる岸が見つかりません」 160 times: it looked at the level of
// the feet (61, 62) and the shore was a standing cell at 63.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { surface, ledges } = require('../src/movement/water-ledges')
const { createPhysics } = require('../src/movement/physics')
const { planWaterExit } = require('../src/movement/water-exit')
const lake = require('./helpers/sunken-lake')

test('the surface is the top water block of the column, from the bottom and from afloat', () => {
  assert.equal(surface(lake.getBlock, lake.FEET), 62)
  assert.equal(surface(lake.getBlock, { ...lake.FEET, y: 61.86 }), 62)
  assert.equal(surface(lake.getBlock, { ...lake.FEET, y: 62.9 }), 62, 'bobbing above the top water block')
  assert.equal(surface(lake.getBlock, { x: -4902.5, y: 63, z: -4861.5 }), null, 'on the shore')
})

test('a body on the bottom finds the shore at the level of the surface', () => {
  const found = ledges(lake.getBlock, lake.FEET)
  assert.deepEqual(found[0], { x: -4902.5, y: 63, z: -4861.5 })
  assert.ok(found.every(ledge => ledge.y === 63 || ledge.y === 62))
  // The same shore as from afloat: sinking changes nothing.
  assert.deepEqual(ledges(lake.getBlock, { ...lake.FEET, y: 62.3 })[0], found[0])
})

test('no ledge from water deeper than the bound, in the open lake, or beside cells that were not received', () => {
  const deep = (x, y, z) => (z >= 3 ? { known: true, name: y <= 79 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 79 ? 'block' : 'empty' } : { known: true, name: y <= 79 ? 'minecraft:water' : 'minecraft:air', boundingBox: 'empty' })
  assert.equal(surface(deep, { x: 0.5, y: 60, z: 0.5 }), null)
  assert.deepEqual(ledges(deep, { x: 0.5, y: 60, z: 0.5 }), [])
  assert.equal(ledges(deep, { x: 0.5, y: 75, z: 0.5 })[0].y, 80, 'five below the surface is within the bound')
  assert.deepEqual(ledges(lake.getBlock, { x: -4902.5, y: 61, z: -4870.5 }), [], 'the shore is farther than five blocks')
  const hidden = (x, y, z) => (z >= -4862 ? { known: false, name: 'minecraft:air', boundingBox: 'empty' } : lake.getBlock(x, y, z))
  assert.deepEqual(ledges(hidden, lake.FEET), [], 'an unknown shore is not a ledge')
})

test('the real physics swims a sunken body up and onto the shore', () => {
  const physics = createPhysics({ world: { getBlock: lake.getBlock }, allowWater: true })
  for (const y of [61, 61.3, 61.86, 62.3]) {
    const feet = { ...lake.FEET, y }
    const initial = physics.fromServer({ position: { x: feet.x, y: y + 1.62, z: feet.z }, gameMode: 'survival' })
    Object.assign(initial, { isInWater: true, onGround: y === 61, velocity: { x: 0, y: 0, z: 0 } })
    const route = planWaterExit({ physics, initial, target: ledges(lake.getBlock, feet)[0] })
    assert.equal(route.ready, true, `${y}: ${route.reason}`)
    assert.equal(route.exitFrames.at(-1).state.position.y, 63)
  }
})

test('a ledge more than one block above the surface is still refused', () => {
  const physics = createPhysics({ world: { getBlock: lake.getBlock }, allowWater: true })
  const feet = { x: -4903.5, y: 61, z: -4857.5 }
  const initial = physics.fromServer({ position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, gameMode: 'survival' })
  Object.assign(initial, { isInWater: true, onGround: true, velocity: { x: 0, y: 0, z: 0 } })
  const out = planWaterExit({ physics, initial, target: { x: -4901.5, y: 64, z: -4857.5 } })
  assert.equal(out.ready, false)
  assert.match(out.reason, /at most one block up/)
})
