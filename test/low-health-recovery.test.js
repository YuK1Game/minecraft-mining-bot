'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { madeObservedProgress } = require('../.local/root-low-health-recovery')

test('a further recovery batch needs fresh server movement without damage', () => {
  const before = { connectionId: 'one', health: 10, rawServerPosition: { x: 0, y: 65, z: 0 }, rawServerPositionUpdatedAt: 1000 }
  const after = { ...before, rawServerPosition: { x: 0.4, y: 65, z: 0 }, rawServerPositionUpdatedAt: 2000 }
  const result = { correctionRetries: 3, phase: 'predicted' }
  assert.equal(madeObservedProgress(before, after, result), true)
  for (const changed of [{ connectionId: 'other' }, { health: 9 }, { health: null }, { rawServerPositionUpdatedAt: 1000 }, { rawServerPosition: { x: 0.1, y: 65, z: 0 } }]) {
    assert.equal(madeObservedProgress(before, { ...after, ...changed }, result), false)
  }
  assert.equal(madeObservedProgress(before, after, { correctionRetries: 0, phase: 'predicted' }), false)
  assert.equal(madeObservedProgress(before, after, { correctionRetries: 2, phase: 'observed' }), false)
})
