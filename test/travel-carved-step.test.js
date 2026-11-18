'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { standsBefore } = require('../src/travel/carved-step')

test('the cell beside the Bot is not "before the step" when the step is cut into the Bot\'s own column', () => {
  // Real Realm 2026-11-19 07:21 JST: feet (-4902.6, 77.0, -4969.5), the step dug (-4903, 76, -4970).
  const feet = { x: -4902.6, y: 77, z: -4969.5 }
  const before = { x: -4901.5, y: 77, z: -4969.5 }
  const step = { x: -4902.5, y: 76, z: -4969.5, dig: [{ x: -4903, y: 76, z: -4970 }] }
  assert.equal(standsBefore(feet, before, step), false)
})

test('standing in or right beside the cell before a step in another column counts', () => {
  const feet = { x: 10.5, y: 64, z: 5.5 }
  assert.equal(standsBefore(feet, { x: 10.5, y: 64, z: 5.5 }, { dig: [{ x: 11, y: 65, z: 5 }, { x: 11, y: 66, z: 5 }, { x: 10, y: 66, z: 5 }] }), true)
  assert.equal(standsBefore({ x: 10.9, y: 64, z: 5.5 }, { x: 11.5, y: 64, z: 5.5 }, { dig: [{ x: 12, y: 63, z: 5 }] }), true)
  assert.equal(standsBefore(feet, { x: 13.5, y: 64, z: 5.5 }, { dig: [{ x: 14, y: 63, z: 5 }] }), false)
  assert.equal(standsBefore(feet, { x: 10.5, y: 66, z: 5.5 }, { dig: [] }), false)
})
