'use strict'
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { reviewNames } = require('./lib/test-lanes')
const root = path.resolve(__dirname, '..')
const files = reviewNames(root).map(name => path.join('test', name))
if (!files.some(name => /review-/.test(name))) throw new Error('No review regression tests found')
// Two workers were the rule while one file took minutes alone; the lane now uses the machine (CI: four cores).
const concurrency = Math.max(2, Math.min(4, os.availableParallelism()))
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, '--test-timeout=60000', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
