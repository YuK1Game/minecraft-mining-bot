'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { landEdgeRecenterTargets, fullySupported } = require('../src/edge-recenter')

const STONE = { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
const AIR = { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
// Floor at y=62 for x<=-17; air below for x>=-16 (a ledge), like the live capture.
const ledge = { getBlock: (x, y, z) => y <= 62 && x <= -17 ? STONE : AIR }

test('a pose half over a ledge gets the nearest fully supported cell center as its recenter target', () => {
  const feet = { x: -16.02, y: 63, z: 24.5 }
  assert.equal(fullySupported(ledge, feet), false)
  const targets = landEdgeRecenterTargets(ledge, feet)
  assert.deepEqual(targets[0].position, { x: -16.5, y: 63, z: 24.5 })
  assert.ok(targets.every(t => t.distance >= 0.2 && t.distance <= 1.2 && t.position.x <= -16.5))
})

test('a fully supported, airborne or unknown-footing pose gets no recenter target', () => {
  assert.deepEqual(landEdgeRecenterTargets(ledge, { x: -17.5, y: 63, z: 24.5 }), [])
  assert.deepEqual(landEdgeRecenterTargets(ledge, { x: -16.02, y: 63.4, z: 24.5 }), [])
  const unknown = { getBlock: (x, y, z) => x <= -17 ? { known: false } : AIR }
  assert.deepEqual(landEdgeRecenterTargets(unknown, { x: -16.02, y: 63, z: 24.5 }), [])
})
