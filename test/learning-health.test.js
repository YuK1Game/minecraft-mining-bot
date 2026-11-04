'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resourceMinHealth } = require('../src/learning-health')

test('online learning resource threshold is explicit, alive, spawned and positive with legacy fallback unchanged', () => {
  const alive = { phase: 'spawned', threatPolicy: 'online_learning', health: 1 }
  assert.equal(resourceMinHealth(alive), 0)
  assert.equal(resourceMinHealth({ ...alive, health: 2.9843637943267822 }), 0)
  for (const change of [{ threatPolicy: 'balanced_mining' }, { threatPolicy: undefined }, { threatPolicy: 'conservative' }, { phase: 'connecting' }, { health: 0 }, { health: -1 }, { health: NaN }, { health: Infinity }, { health: null }, { dead: true }, { isDead: true }, { lifecycle: { dead: true } }, { spawnPending: true }]) {
    assert.equal(resourceMinHealth({ ...alive, ...change }), 6)
    assert.equal(resourceMinHealth({ ...alive, ...change }, 10), 10)
  }
  assert.equal(resourceMinHealth(null), 6)
})
