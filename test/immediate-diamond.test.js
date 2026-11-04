'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { immediateDiamond } = require('../src/immediate-diamond')

test('prioritizes only a live-previewed reachable diamond with no nearby or unknown hostile', () => {
  const state = { health: 20, phase: 'spawned', position: { x: 0.5, y: 66.62, z: 0.5 }, dimension: 'overworld', inventory: { known: true, items: [] }, entities: [], entityStats: { unknownPositions: 0 } }
  const decision = { type: 'mine_ore', resource: 'diamond', target: { x: 1, y: 65, z: 0 } }
  const ready = () => ({ ready: true, targets: [{ name: 'minecraft:diamond_ore', position: decision.target }] })
  assert.equal(immediateDiamond(state, decision, ready), true)
  assert.equal(immediateDiamond(state, decision, () => ({ ready: false })), false)
  assert.equal(immediateDiamond(state, { ...decision, type: 'tunnel' }, ready), true)
  assert.equal(immediateDiamond(state, decision, () => ({ ready: true, targets: [{ name: 'minecraft:stone', position: decision.target }] })), false)
  assert.equal(immediateDiamond({ ...state, health: 19 }, decision, ready), false)
  assert.equal(immediateDiamond({ ...state, entities: [{ runtimeId: '2', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, position: { x: 5, y: 65, z: 0 }, dimension: 'overworld' }] }, decision, ready), false)
  assert.equal(immediateDiamond({ ...state, entityStats: { unknownPositions: 1 } }, decision, ready), false)
})
