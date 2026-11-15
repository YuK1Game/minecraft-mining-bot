'use strict'
// 2026-11-15: idle eating falls back to rotten flesh below hunger 18 when nothing
// else is edible; the combat approach log is thinned to every 3 s per target.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('idle eating takes rotten flesh only as the last resort below 18', () => {
  const src = require('./helpers/runtime-source').runtimeSource()
  assert.match(src, /if \(!hasFood && !\(hasRotten && hunger < 18\)\) \{ idleEat\.toFull = false; return \}/)
  assert.match(src, /operations\.food\.eat\(hasFood \? \{\} : \{ allowEmergencyRotten: true \}\)/)
})

test('the approach log is written at most every 3 s per target unless its code changes', () => {
  const src = fs.readFileSync(require.resolve('../src/combat/combat-coordinator'), 'utf8')
  assert.match(src, /if \(approachCode !== lease\.approachLogCode \|\| Date\.now\(\) - \(lease\.approachLogAt \?\? 0\) >= 3000\)/)
})
