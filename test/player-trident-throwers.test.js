'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { throwers, mark } = require('../src/combat/trident-throwers')

const drowned = (id, x, z) => ({ runtimeId: id, entityType: 'minecraft:drowned', hostile: true, position: { x, y: 60, z } })

test('a drowned with a received thrown trident near it is a thrower; the others are not', () => {
  // Real Realm 2026-11-19 07:44:18 JST: thrown_trident 4.2 m, drowned 5.9 m and 6.5 m.
  const near = drowned(1, -4812, -5006), far = drowned(2, -4700, -5006), zombie = { runtimeId: 3, entityType: 'minecraft:zombie', hostile: true, position: { x: -4810, y: 63, z: -5004 } }
  const trident = { runtimeId: 9, entityType: 'minecraft:thrown_trident', position: { x: -4809, y: 61, z: -5005 } }
  const found = throwers([near, far, zombie, trident])
  assert.deepEqual([...found].map(actor => actor.runtimeId), [1])
  const marked = mark([near, far, zombie, trident])
  assert.equal(marked[0].tridentThrower, true)
  assert.equal(marked[1].tridentThrower, undefined)
  assert.equal(marked[2].tridentThrower, undefined)
})

test('no received trident: no drowned is marked and the list is returned as it is', () => {
  const list = [drowned(1, 0, 0), drowned(2, 5, 5)]
  assert.equal(throwers(list).size, 0)
  assert.equal(mark(list), list)
  assert.deepEqual(mark(null), [])
})
