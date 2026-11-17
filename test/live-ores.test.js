'use strict'
// Live 2026-11-17 12:43-12:55 JST: remembered ores of a chunk that left kept the
// planner tunnelling toward them (RESOURCE_UNKNOWN every 2 s).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { liveOres } = require('../src/survival/live-ores')

test('remembered ores outside the received world are dropped', () => {
  const known = new Set(['1,10,1'])
  const get = (x, y, z) => ({ known: known.has(`${x},${y},${z}`), name: 'minecraft:iron_ore' })
  const out = liveOres({ iron: [{ position: { x: 1, y: 10, z: 1 } }, { position: { x: 400, y: 10, z: 1 } }], coal: [], other: null }, get)
  assert.deepEqual(out.iron, [{ position: { x: 1, y: 10, z: 1 } }])
  assert.deepEqual(out.coal, [])
  assert.equal(out.other, null)
})
