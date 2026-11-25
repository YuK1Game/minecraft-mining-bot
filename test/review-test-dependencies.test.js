'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('all regression tests use tracked source/fixtures instead of local operator helpers or staged fallbacks', () => {
  const root = path.resolve(__dirname, '..')
  const run = spawnSync(process.execPath, ['scripts/audit-tests.js', '--json', '--strict'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.deepEqual(JSON.parse(run.stdout).localCjsDependentFiles, [])
})
