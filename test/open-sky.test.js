'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openSky } = require('../src/travel/open-sky')

const world = blocks => (x, y, z) => blocks[`${x},${y},${z}`] ?? (y < 128 ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : null)
const solid = name => ({ known: true, name, boundingBox: 'block' })

test('a house roof is not cover for the long trip arrival (live 2026-11-17 23:20 JST)', () => {
  const feet = { x: 0.5, y: 77, z: 0.5 }
  assert.equal(openSky(world({}), feet), true)
  assert.equal(openSky(world({ '0,81,0': solid('minecraft:oak_slab') }), feet), true)
  assert.equal(openSky(world({ '0,80,0': solid('minecraft:oak_leaves') }), feet), true)
  assert.equal(openSky(world({ '0,81,0': solid('minecraft:stone') }), feet), false)
  // Planks under rock (a mineshaft) are still under cover: the rock counts.
  assert.equal(openSky(world({ '0,80,0': solid('minecraft:oak_planks'), '0,84,0': solid('minecraft:stone') }), feet), false)
  // Unreceived below y 128 is not sky.
  assert.equal(openSky((x, y, z) => y === 90 ? { known: false } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }, feet), false)
})
