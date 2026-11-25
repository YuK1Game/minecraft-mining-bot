'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { homeFurnaceFirst, TRIAL } = require('../src/modes/station-yard')
const { placements } = require('../src/modes/house/house-blueprint')

const origin = { x: 100, y: 64, z: 100 }
const furnace = placements(origin).find(step => step.item === 'furnace').position

function ctx ({ feet = { x: 110.5, y: 64, z: 120.5 }, dimension = 'overworld', standing = true, spent = false } = {}) {
  return {
    shared: { playerHouse: { origin } },
    getFeet: () => feet,
    runtime: { raw: () => ({ dimension }) },
    goal: { spent: trial => spent && trial.code === TRIAL.code },
    getBlock: (x, y, z) => ({ known: true, name: standing && x === furnace.x && y === furnace.y && z === furnace.z ? 'minecraft:furnace' : 'minecraft:air', properties: {} })
  }
}

test('near the house on the overworld a furnace need goes to the house furnace instead of a new one', () => {
  assert.equal(homeFurnaceFirst(ctx()), true)
})

test('far from the house, underground, in another dimension, without a standing furnace or after three misses a furnace is placed as before', () => {
  assert.equal(homeFurnaceFirst(ctx({ feet: { x: 200.5, y: 64, z: 100.5 } })), false)
  assert.equal(homeFurnaceFirst(ctx({ feet: { x: 110.5, y: 20, z: 110.5 } })), false)
  assert.equal(homeFurnaceFirst(ctx({ dimension: 'nether' })), false)
  assert.equal(homeFurnaceFirst(ctx({ standing: false })), false)
  assert.equal(homeFurnaceFirst(ctx({ spent: true })), false)
})
