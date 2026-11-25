'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { activeZones, inZone } = require('../src/travel/danger-zones')

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

test('activeZones filters expired skeleton zones and zones covering the destination for coarse route avoidance', () => {
  const now = Date.parse('2026-11-25T02:37:00Z')
  const old = new Date(now - 24 * 3600000).toISOString(), recent = new Date(now - 600000).toISOString()
  const list = [
    { x: 9890, z: 10145, r: 48, kind: 'minecraft:skeleton', at: old },
    { x: 9862, z: 10136, r: 48, kind: 'minecraft:skeleton', at: recent },
    { x: 9500, z: 10500, r: 48, kind: 'minecraft:skeleton', at: recent },
    { x: 9200, z: 10200, r: 120, kind: 'minecraft:pillager', at: old }
  ]
  const active = activeZones(list, { x: 9880, z: 10147 }, now)
  assert.deepEqual(active.map(z => z.x), [9500, 9200])
})
