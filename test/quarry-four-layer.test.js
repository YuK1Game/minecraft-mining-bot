'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { completedFourLayerFloor, needsFourLayerCollection } = require('../src/quarry-four-layer')

test('Y75 starts with a four-layer sweep after 75..72, then every four levels', () => {
  assert.equal(completedFourLayerFloor(75, 75), null)
  assert.equal(completedFourLayerFloor(75, 72), null)
  assert.equal(completedFourLayerFloor(75, 71), 72)
  assert.equal(completedFourLayerFloor(75, 70), 72)
  assert.equal(completedFourLayerFloor(75, 67), 68)
  assert.equal(completedFourLayerFloor(75, -59), -56)
  assert.equal(needsFourLayerCollection(75, 71, null), 72)
  assert.equal(needsFourLayerCollection(75, 70, 72), null)
  assert.equal(needsFourLayerCollection(75, 67, 72), 68)
  assert.equal(needsFourLayerCollection(75, -59, -56), null)
})

test('custom start Y uses the same relative four-layer grouping', () => {
  assert.equal(completedFourLayerFloor(62, 58), 59)
  assert.equal(completedFourLayerFloor(62, 57), 59)
  assert.equal(completedFourLayerFloor(62, 54), 55)
  assert.equal(completedFourLayerFloor(62, 63), null)
  assert.equal(completedFourLayerFloor(62.5, 58), null)
  assert.equal(needsFourLayerCollection(62, 54, 59), 55)
})
