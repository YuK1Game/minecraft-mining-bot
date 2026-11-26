'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('all regression tests use tracked source/fixtures and player modes stay decoupled from legacy survival requires', () => {
  const root = path.resolve(__dirname, '..')
  const run = spawnSync(process.execPath, ['scripts/audit-tests.js', '--json', '--strict'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const report = JSON.parse(run.stdout)
  assert.deepEqual(report.localCjsDependentFiles, [])
  assert.deepEqual(report.modesDirectSurvivalRefs, [])
  assert.equal(typeof report.compareOnlyBreakdown?.legacySurvival, 'number')
})
