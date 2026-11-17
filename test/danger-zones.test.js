'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { inZone } = require('../src/travel/danger-zones')

const zones = [{ x: 0, z: 0, r: 48, kind: 'minecraft:skeleton' }]

test('a zone is avoided, but not when it holds the trip destination (live 2026-11-17 21:27 JST)', () => {
  assert.equal(inZone(zones, 10, 10), true)
  assert.equal(inZone(zones, 10, 10, { x: 200, z: 0 }), true)
  assert.equal(inZone(zones, 10, 10, { x: 20, z: 5 }), false)
  assert.equal(inZone(zones, 100, 0, { x: 20, z: 5 }), false)
  assert.equal(inZone([], 0, 0), false)
})

test('a skeleton zone is forgotten after an hour; a pillager zone stays', () => {
  const now = Date.parse('2026-11-17T12:30:00Z')
  const old = new Date(now - 2 * 3600000).toISOString(), recent = new Date(now - 600000).toISOString()
  assert.equal(inZone([{ x: 0, z: 0, r: 48, kind: 'minecraft:skeleton', at: old }], 10, 0, null, now), false)
  assert.equal(inZone([{ x: 0, z: 0, r: 48, kind: 'minecraft:skeleton', at: recent }], 10, 0, null, now), true)
  assert.equal(inZone([{ x: 0, z: 0, r: 120, kind: 'minecraft:pillager', at: old }], 10, 0, null, now), true)
})
