'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pruneTunnelFloors, prunedFloors } = require('../src/modes/player-floor-prune')

const state = { profile: 'p', realm: { id: 7 }, dimension: 'overworld' }
const scope = JSON.stringify(['p', '7', 'overworld'])

test('a nearly full floor record drops far floors first, then the farthest near ones', () => {
  const near = Array.from({ length: 900 }, (_, i) => ({ x: i % 30, y: 60 - Math.floor(i / 30), z: 0 }))
  const far = Array.from({ length: 121 }, (_, i) => ({ x: 500 + i, y: 10, z: 0 }))
  const shared = { tunnelFloors: { version: 1, scopes: { [scope]: { floors: [...far, ...near] } } } }
  const gone = pruneTunnelFloors(shared, state, { x: 0.5, y: 65.6, z: 0.5 })
  const kept = shared.tunnelFloors.scopes[scope].floors
  assert.equal(gone, 1021 - 768)
  assert.equal(kept.length, 768)
  assert.ok(kept.every(point => point.x < 30))
  assert.ok(kept.some(point => point.x === 0 && point.y === 60), 'the floor under the Bot stays')
})

test('a small record and a missing position are left alone', () => {
  assert.equal(prunedFloors([{ x: 1000, y: 0, z: 0 }], { x: 0, y: 0, z: 0 }), null)
  assert.equal(prunedFloors(Array.from({ length: 600 }, () => ({ x: 1000, y: 0, z: 0 })), null), null)
  const shared = { tunnelFloors: { version: 1, scopes: {} } }
  assert.equal(pruneTunnelFloors(shared, state, { x: 0, y: 0, z: 0 }), 0)
})
