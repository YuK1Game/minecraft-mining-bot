'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createCombatSearchBudget } = require('../src/combat-search-budget')
test('review: many enemies share one route-search budget and exhaustion stays unknown', () => {
  let now = 0
  const budget = createCombatSearchBudget({ clock: () => now })
  let searches = 0, deferred = 0
  for (let i = 0; i < 40; i++) {
    const result = budget.search(allowance => { searches++; now += allowance; return false })
    if (!result.executed) { deferred++; assert.equal(result.value, null) }
  }
  assert.equal(searches, 2)
  assert.equal(deferred, 38)
  assert.equal(budget.snapshot().normalUsed, 8)
  assert.equal(budget.search(allowance => { now += allowance; return true }, { urgent: true }).value, true)
  assert.equal(budget.snapshot().maxWindowMs, 12)
  now = 50
  assert.equal(budget.search(() => true).executed, true)
})
test('review: thrown route queries still consume measured budget', () => {
  let now = 0
  const budget = createCombatSearchBudget({ clock: () => now })
  assert.throws(() => budget.search(() => { now += 9; throw new Error('world read failed') }))
  assert.equal(budget.search(() => true).executed, false)
  assert.equal(budget.snapshot().overruns, 1)
})

test('review: extracted threat evaluation preserves known visible, blocked and unknown ranged sight', () => {
  const { createCombatExposure } = require('../src/combat-exposure')
  let terrain = 'air', motionReads = 0
  const world = { getBlock: () => terrain === 'unknown' ? { known: false } : { known: true, name: `minecraft:${terrain}`, boundingBox: terrain === 'air' ? 'empty' : 'block' }, revision: () => 1 }
  const exposure = createCombatExposure({ world, entities: { motion: () => { motionReads++; return null } }, scopeOf: () => 'same-life' })
  const state = { position: { x: 0.5, y: 65.62, z: 0.5 }, health: 20, phase: 'spawned', dimension: 'overworld' }
  const target = { runtimeId: '2', uniqueId: '2', kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, position: { x: 8.5, y: 64, z: 0.5 }, dimension: 'overworld' }
  assert.equal(exposure.evaluate(target, state).intercept, true)
  assert.equal(exposure.evaluate(target, state).evidence.sight, true)
  terrain = 'stone'
  assert.equal(exposure.evaluate(target, state).reason, 'PROJECTILE_SIGHT_BLOCKED')
  terrain = 'unknown'
  assert.equal(exposure.evaluate(target, state).unknown, true)
  assert.equal(motionReads, 4, 'motion observations survive the module extraction')
})
