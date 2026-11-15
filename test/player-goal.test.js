'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { diamondGoal, nextObjective } = require('../src/modes/player-goal')

const inv = count => ({ known: true, items: count ? [{ name: 'minecraft:diamond', count, slot: 3 }] : [] })

test('the diamond goal is the next step above what is held', () => {
  assert.deepEqual([0, 1, 2, 3, 5, 12, 13, 29, 40].map(count => diamondGoal(inv(count))), [1, 3, 3, 5, 13, 13, 29, 37, 48])
  assert.equal(diamondGoal({ known: false, items: [{ name: 'minecraft:diamond', count: 9 }] }), 1, 'an unreceived inventory is not counted')
  assert.equal(diamondGoal(null), 1)
})

test('only the diamond objective is changed', () => {
  assert.deepEqual(nextObjective({ objective: 'diamond', diamondCount: 1, freshExploration: true }, inv(1)), { objective: 'diamond', diamondCount: 3, freshExploration: true })
  const travel = { objective: 'long_travel_prep', logCount: 10 }
  assert.equal(nextObjective(travel, inv(1)), travel)
})
