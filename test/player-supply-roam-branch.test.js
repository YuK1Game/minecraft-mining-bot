'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { branchOnly } = require('../src/modes/supply-roam')

const world = column => (x, y, z) => ({ known: true, name: column[y] ?? 'minecraft:air' })

test('a log hanging over leaves and air is a branch, a log on a trunk or near the ground is not', () => {
  const at = { x: 0, y: 71, z: 0 }
  assert.equal(branchOnly({ shared: {}, getBlock: world({ 70: 'minecraft:oak_leaves', 69: 'minecraft:oak_leaves', 68: 'minecraft:air', 67: 'minecraft:oak_leaves' }) }, at), true)
  assert.equal(branchOnly({ shared: {}, getBlock: world({ 70: 'minecraft:oak_log' }) }, at), false, 'a trunk under it')
  assert.equal(branchOnly({ shared: {}, getBlock: world({ 70: 'minecraft:air', 69: 'minecraft:grass_block' }) }, at), false, 'ground close under it')
  assert.equal(branchOnly({ shared: {}, getBlock: (x, y) => y === 70 ? { known: false } : { known: true, name: 'minecraft:air' } }, at), false, 'unreceived is not called a branch')
  assert.equal(branchOnly({ shared: { playerTree: { logs: [at] } }, getBlock: world({}) }, at), false, 'a log of the tree being felled')
})
