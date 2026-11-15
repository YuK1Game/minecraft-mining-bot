'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { reachableDiamond } = require('../src/modes/player-ore')

// The vein of 2026-11-16: the planned ore is enclosed, two others lie open.
const ore = (x, y, z) => ({ known: true, name: 'minecraft:deepslate_diamond_ore', position: { x, y, z } })
const blocks = [ore(-4927, 3, -4964), ore(-4927, 3, -4965), ore(-4928, 3, -4965), ore(-4928, 3, -4964), ore(-4927, 2, -4964), { known: true, name: 'minecraft:stone', position: { x: -4927, y: 4, z: -4964 } }]
const state = { position: { x: -4927.5, y: 5.62, z: -4965.58 } }
const tunnel = { type: 'tunnel', stage: 'diamond', resource: 'diamond', target: { x: -4927, y: 3, z: -4964 }, resourceTarget: { x: -4927, y: 3, z: -4964 }, targetOre: { name: 'minecraft:deepslate_diamond_ore', position: { x: -4927, y: 3, z: -4964 } }, requiredToolTier: 3, rejectUnknown: true }
const open = new Set(['-4927,3,-4965', '-4928,3,-4965'])
const preview = asked => targets => { const p = targets[0]; asked.push(`${p.x},${p.y},${p.z}`); return open.has(`${p.x},${p.y},${p.z}`) ? { ready: true, targets: [{ name: 'minecraft:deepslate_diamond_ore', position: { ...p } }] } : { ready: false, targets: [] } }

test('an ore the pickaxe reaches now is mined instead of tunnelling to the enclosed one', () => {
  const asked = []
  const decision = reachableDiamond({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: preview(asked) })
  assert.equal(decision.type, 'mine_ore')
  assert.deepEqual(decision.target, { x: -4928, y: 3, z: -4965 })
  assert.deepEqual(decision.resourceTarget, decision.target)
  assert.equal(decision.block, 'minecraft:deepslate_diamond_ore')
  assert.equal(decision.targetOre, undefined)
  assert.equal(decision.requiredToolTier, 3)
  assert.equal(asked[0], '-4928,3,-4965', 'nearest first')
})

test('nothing changes outside player mode, for other resources, or when no ore is in reach', () => {
  const asked = []
  assert.equal(reachableDiamond({ mode: 'quarry', state, decision: tunnel, observations: { blocks }, preview: preview(asked) }), null)
  assert.equal(reachableDiamond({ mode: 'player', state, decision: { ...tunnel, resource: 'iron' }, observations: { blocks }, preview: preview(asked) }), null)
  assert.equal(reachableDiamond({ mode: 'player', state, decision: { ...tunnel, type: 'mine_ore' }, observations: { blocks }, preview: preview(asked) }), null)
  assert.deepEqual(asked, [])
  assert.equal(reachableDiamond({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: () => ({ ready: false }) }), null)
  assert.equal(reachableDiamond({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: () => { throw new Error('busy') } }), null)
  assert.equal(reachableDiamond({ mode: 'player', state: { position: { x: 0, y: 70, z: 0 } }, decision: tunnel, observations: { blocks }, preview: preview(asked) }), null)
})
