'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openWayToDrop } = require('../src/modes/player-drop-access')

// The stair of 2026-11-16 05:12 JST (x -4919..-4915, z -4954..-4950, y 59..64).
const rows = {
  64: ['ss.ss', 'ss.ss', 'sssss', 'sssss', 'sssss'],
  63: ['us.ss', 'ss.ss', 'sssss', 'sssss', 'sssss'],
  62: ['ussss', 'ss.ss', 's...s', 'sscss', 'sssss'],
  61: ['sssss', 'sscss', 'c...s', 'cccss', 'lssss'],
  60: ['sssCC', 'ssssC', 'CCCss', 'llsss', 'llsss'],
  59: ['sssss', 'sssss', 'sssss', 'sssss', 'sssss']
}
const names = { s: 'stone', '.': 'air', c: 'coal_ore', C: 'coal_ore', u: 'copper_ore', l: 'lapis_ore' }
const world = floorProtected => (x, y, z) => {
  const row = rows[y]?.[z + 4954], cell = row?.[x + 4919]
  if (!cell) return { known: false }
  const name = `minecraft:${names[cell]}`
  return { known: true, name, boundingBox: cell === '.' ? 'empty' : 'block', position: { x, y, z }, ...(floorProtected && y === 61 && x === -4917 && z === -4953 ? { protected: true, protectionSource: 'tunnel_floor' } : {}) }
}
const state = { position: { x: -4916.5, y: 63.62, z: -4952.55 } }
const drops = [{ entityId: 7, name: 'minecraft:coal', position: { x: -4916.13, y: 61.13, z: -4951.13 } }, { entityId: 8, name: 'minecraft:coal', position: { x: -4917.88, y: 61.13, z: -4951.13 } }]
const live = targets => ({ ready: true, targets: [{ name: 'minecraft:stone', position: { ...targets[0] } }] })
const planned = { type: 'place_crafting_table', stage: 'crafting_table' }

test('the stone above the step down to the dropped coal is mined', () => {
  const shared = {}, lines = []
  const decision = openWayToDrop({ mode: 'player', shared, state, decision: planned, drops, getBlock: world(true), preview: live, log: line => lines.push(line) })
  assert.equal(decision.type, 'mine_stone')
  assert.deepEqual(decision.target, { x: -4917, y: 63, z: -4952 })
  assert.equal(decision.block, 'minecraft:stone')
  assert.equal(lines.length, 1)
})

test('nothing is dug outside player mode, for a final answer, without a wanted item, or after three tries', () => {
  const args = { mode: 'player', shared: {}, state, decision: planned, drops, getBlock: world(false), preview: live }
  assert.equal(openWayToDrop({ ...args, mode: 'quarry' }), null)
  assert.equal(openWayToDrop({ ...args, decision: { type: 'stop' } }), null)
  assert.equal(openWayToDrop({ ...args, drops: [{ entityId: 9, name: 'minecraft:cobblestone', position: drops[0].position }] }), null)
  assert.equal(openWayToDrop({ ...args, preview: () => ({ ready: false }) }), null)
  const shared = {}
  for (let turn = 0; turn < 3; turn++) assert.equal(openWayToDrop({ ...args, shared, drops: [drops[0]] })?.type, 'mine_stone')
  assert.equal(openWayToDrop({ ...args, shared, drops: [drops[0]] }), null)
})

test('an item the Bot can already walk to needs no digging', () => {
  const opened = (x, y, z) => x === -4917 && y === 63 && z === -4952 ? { known: true, name: 'minecraft:air', boundingBox: 'empty', position: { x, y, z } } : world(false)(x, y, z)
  assert.equal(openWayToDrop({ mode: 'player', shared: {}, state, decision: planned, drops, getBlock: opened, preview: live }), null)
})
