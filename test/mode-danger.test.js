'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// The side jobs of player mode share one danger check (mode-runtime.js).
test('player side jobs are held by an archer within 24 m or recent damage, not only a hostile within 12 m', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/modes/mode-runtime.js'), 'utf8')
  assert.equal((source.match(/runtime\.nearestHostile\(\) < 12/g) ?? []).length, 1, 'only inside danger()')
  assert.match(source, /const danger = \(\) => \{/)
  assert.ok((source.match(/danger\(\)/g) ?? []).length >= 8)
  assert.match(source, /< 24\)/)
  assert.match(source, /hurtAt < 10000/)
  assert.match(source, /positionUpdatedAt \?\? ''\) > 60000/, 'an archer unmoved for a minute is not aiming')
})
