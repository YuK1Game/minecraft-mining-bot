'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { useCurrentAccess } = require('../src/action-access')
test('a natural tree approach advances to mining when the current visible face is actually accessible', () => {
  const target = { x: -45, y: 70, z: 54 }
  const decision = { type: 'move_to', resource: 'logs', block: 'minecraft:oak_log', resourceTarget: target, target: { x: -47.5, y: 69, z: 56.5 }, treeEvidence: { detection: 'connected_logs' } }
  const preview = { ready: true, targets: [{ name: 'minecraft:oak_log', position: target }] }
  assert.equal(useCurrentAccess(decision, preview).type, 'gather_logs')
  assert.deepEqual(useCurrentAccess(decision, preview).target, target)
  assert.equal(decision.type, 'move_to')
  assert.equal(useCurrentAccess(decision, { ...preview, ready: false }), decision)
  assert.equal(useCurrentAccess({ ...decision, treeEvidence: null }, preview).type, 'move_to')
  assert.equal(useCurrentAccess(decision, { ready: true, targets: [{ name: 'minecraft:birch_log', position: target }] }), decision)
})

test('a plant preview cannot promote a tree preparation into wood access', () => {
  const tree = { x: 3, y: 65, z: 0 }
  const plant = { x: 2, y: 65, z: 0 }
  const decision = { type: 'move_to', resource: 'logs', resourceTarget: tree, block: 'minecraft:oak_log', treeEvidence: { detection: 'connected_logs' }, accessPreparation: { kind: 'clear_tree_access', target: plant, block: 'minecraft:vine' } }
  assert.equal(useCurrentAccess(decision, { ready: true, targets: [{ position: plant, name: 'minecraft:vine' }] }), decision)
  assert.equal(useCurrentAccess(decision, { ready: false, targets: [{ position: tree, name: 'minecraft:oak_log' }] }), decision)
  assert.equal(useCurrentAccess(decision, { ready: true, targets: [{ position: tree, name: 'minecraft:oak_log' }] }).type, 'gather_logs')
})
