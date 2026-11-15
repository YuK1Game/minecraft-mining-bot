'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { reachableOre } = require('../src/modes/player-ore')

// The vein of 2026-11-16: the planned ore is enclosed, two others lie open.
const ore = (x, y, z) => ({ known: true, name: 'minecraft:deepslate_diamond_ore', position: { x, y, z } })
const blocks = [ore(-4927, 3, -4964), ore(-4927, 3, -4965), ore(-4928, 3, -4965), ore(-4928, 3, -4964), ore(-4927, 2, -4964), { known: true, name: 'minecraft:stone', position: { x: -4927, y: 4, z: -4964 } }]
const state = { position: { x: -4927.5, y: 5.62, z: -4965.58 } }
const tunnel = { type: 'tunnel', stage: 'diamond', resource: 'diamond', target: { x: -4927, y: 3, z: -4964 }, resourceTarget: { x: -4927, y: 3, z: -4964 }, targetOre: { name: 'minecraft:deepslate_diamond_ore', position: { x: -4927, y: 3, z: -4964 } }, requiredToolTier: 3, rejectUnknown: true }
const open = new Set(['-4927,3,-4965', '-4928,3,-4965'])
const preview = asked => targets => { const p = targets[0]; asked.push(`${p.x},${p.y},${p.z}`); return open.has(`${p.x},${p.y},${p.z}`) ? { ready: true, targets: [{ name: 'minecraft:deepslate_diamond_ore', position: { ...p } }] } : { ready: false, targets: [] } }

test('an ore the pickaxe reaches now is mined instead of tunnelling to the enclosed one', () => {
  const asked = []
  const decision = reachableOre({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: preview(asked) })
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
  assert.equal(reachableOre({ mode: 'quarry', state, decision: tunnel, observations: { blocks }, preview: preview(asked) }), null)
  assert.equal(reachableOre({ mode: 'player', state, decision: { ...tunnel, resource: 'iron' }, observations: { blocks }, preview: preview(asked) }), null, 'only ores of the planned resource')
  assert.equal(reachableOre({ mode: 'player', state, decision: { ...tunnel, resource: 'crafting_table' }, observations: { blocks }, preview: preview(asked) }), null)
  assert.equal(reachableOre({ mode: 'player', state, decision: { ...tunnel, type: 'mine_ore' }, observations: { blocks }, preview: preview(asked) }), null)
  assert.deepEqual(asked, [])
  assert.equal(reachableOre({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: () => ({ ready: false }) }), null)
  assert.equal(reachableOre({ mode: 'player', state, decision: tunnel, observations: { blocks }, preview: () => { throw new Error('busy') } }), null)
  assert.equal(reachableOre({ mode: 'player', state: { position: { x: 0, y: 70, z: 0 } }, decision: tunnel, observations: { blocks }, preview: preview(asked) }), null)
})

// The stair of 2026-11-16 04:53 JST: coal below the feet, the planned ores excluded.
test('coal below the feet is mined when the plan tunnels or explores for coal', () => {
  const coal = (x, y, z) => ({ known: true, name: 'minecraft:coal_ore', position: { x, y, z } })
  const vein = [coal(-4918, 62, -4952), coal(-4917, 62, -4952), coal(-4916, 62, -4952), coal(-4917, 62, -4951), coal(-4917, 61, -4953), ore(-4917, 62, -4953)]
  const at = { position: { x: -4916.5, y: 64.62, z: -4953.55 } }
  const live = targets => { const p = targets[0]; return p.y === 61 ? { ready: true, targets: [{ name: 'minecraft:coal_ore', position: { ...p } }] } : { ready: false } }
  for (const planned of [{ type: 'tunnel', stage: 'coal', resource: 'coal', target: { x: -4917, y: 62, z: -4951 }, requiredToolTier: 2 }, { type: 'explore', stage: 'coal', resource: 'coal', count: 1, requiredToolTier: 2, attempt: 3, requiresKnownTerrain: true }]) {
    const decision = reachableOre({ mode: 'player', state: at, decision: planned, observations: { blocks: vein }, preview: live })
    assert.equal(decision.type, 'mine_ore')
    assert.equal(decision.stage, 'coal')
    assert.deepEqual(decision.target, { x: -4917, y: 61, z: -4953 })
    assert.equal(decision.block, 'minecraft:coal_ore')
    assert.equal(decision.attempt, undefined)
  }
})

test('an ore the mining entry keeps (the floor of the walked tunnel) is left out', () => {
  const coal = (x, y, z) => ({ known: true, name: 'minecraft:coal_ore', position: { x, y, z } })
  const vein = [coal(-4917, 61, -4953), coal(-4917, 61, -4952)]
  const at = { position: { x: -4916.5, y: 64.62, z: -4953.55 } }
  const live = targets => ({ ready: true, targets: [{ name: 'minecraft:coal_ore', position: { ...targets[0] } }] })
  const planned = { type: 'tunnel', stage: 'coal', resource: 'coal', target: { x: -4917, y: 62, z: -4951 } }
  const floor = point => point.z === -4953
  assert.deepEqual(reachableOre({ mode: 'player', state: at, decision: planned, observations: { blocks: vein }, preview: live, guarded: floor }).target, { x: -4917, y: 61, z: -4952 })
  assert.equal(reachableOre({ mode: 'player', state: at, decision: planned, observations: { blocks: vein }, preview: live, guarded: () => true }), null)
  assert.equal(reachableOre({ mode: 'player', state: at, decision: planned, observations: { blocks: vein }, preview: live, guarded: () => { throw new Error('unknown scope') } }), null)
})
