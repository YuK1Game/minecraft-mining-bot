'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { surfaceShoreRoute } = require('../src/recovery')

const block = (name, boundingBox) => ({ known: true, name: `minecraft:${name}`, boundingBox, extra: [] })
const WATER = block('water', 'empty'), AIR = block('air', 'empty'), GRASS = block('grass_block', 'block'), STONE = block('stone', 'block')
// Sea surface: water at y<=62, so floating feet are at y=63. `land(x, z)` gives
// the solid top height of a land column (62 = flat with the surface, 63 = one
// step up, 64 = a two-block wall) or null for open water.
function world (land) {
  return { getBlock: (x, y, z) => {
    const top = land(x, z)
    if (top == null) return y <= 62 ? WATER : AIR
    if (y < top) return STONE
    return y === top ? GRASS : AIR
  } }
}
const feet = { x: 2.5, y: 63, z: 0.5 }

test('nearest flat landing on the surface plane is found with the swim path to it', () => {
  const r = surfaceShoreRoute(world((x) => x >= 10 ? 62 : null), feet, 63)
  assert.equal(r.found, true)
  assert.deepEqual(r.landing.position, { x: 10.5, y: 63, z: 0.5 }); assert.equal(r.landing.step, 0)
  assert.deepEqual(r.path[0], { x: 2.5, z: 0.5 }); assert.deepEqual(r.path.at(-1), { x: 9.5, z: 0.5 }); assert.equal(r.path.length, 8)
})

test('a one-block climbable step is a landing one block above the surface', () => {
  const r = surfaceShoreRoute(world((x) => x >= 6 ? 63 : null), feet, 63)
  assert.equal(r.found, true); assert.deepEqual(r.landing.position, { x: 6.5, y: 64, z: 0.5 }); assert.equal(r.landing.step, 1)
})

test('a two-block wall is not a landing and the search goes around it to the nearest real shore', () => {
  const r = surfaceShoreRoute(world((x, z) => x === 5 && z >= -3 && z <= 3 ? 64 : x >= 5 && z === 6 ? 62 : null), feet, 63)
  assert.equal(r.found, true); assert.equal(r.landing.position.z, 6.5); assert.equal(r.landing.step, 0)
})

test('no landing inside the radius or unknown water stays not found', () => {
  assert.equal(surfaceShoreRoute(world(() => null), feet, 63, { radius: 8 }).found, false)
  const unknown = { getBlock: (x, y, z) => Math.abs(x - 2) > 3 ? { known: false } : y <= 62 ? WATER : AIR }
  assert.equal(surfaceShoreRoute(unknown, feet, 63).found, false)
})

test('the nearest of two shores by swim distance wins', () => {
  const r = surfaceShoreRoute(world((x) => x >= 12 || x <= -1 ? 62 : null), feet, 63)
  assert.equal(r.found, true); assert.deepEqual(r.landing.position, { x: -0.5, y: 63, z: 0.5 })
})
