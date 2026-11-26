'use strict'
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { reviewNames } = require('./lib/test-lanes')

const root = path.resolve(__dirname, '..')
const allNames = reviewNames(root)
if (!allNames.some(name => /review-/.test(name))) throw new Error('No review regression tests found')

// Real-clock 50ms event-loop heartbeat fairness checks measure wall-clock scheduling
// jitter (`maxGap < 200ms`) and must not contend with 5 parallel VM-compiling workers.
const ISOLATED_TIMING = new Set(['runtime-eventloop-fairness.test.js'])
const parallelFiles = allNames.filter(name => !ISOLATED_TIMING.has(name)).map(name => path.join('test', name))
const isolatedFiles = allNames.filter(name => ISOLATED_TIMING.has(name)).map(name => path.join('test', name))

const envConcurrency = Number(process.env.TEST_CONCURRENCY)
const concurrency = Number.isInteger(envConcurrency) && envConcurrency >= 1
  ? envConcurrency
  : Math.max(2, Math.min(6, os.availableParallelism()))

const startedAt = Date.now()
let status = 0

if (isolatedFiles.length) {
  const iso = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=60000', ...isolatedFiles], { cwd: root, stdio: 'inherit' })
  if (iso.error) throw iso.error
  if ((iso.status ?? 1) !== 0) status = iso.status ?? 1
}

if (parallelFiles.length) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, '--test-timeout=60000', ...parallelFiles], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) status = result.status ?? 1
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`test:review: ${allNames.length} files finished in ${elapsedSec}s (concurrency=${concurrency}, isolated=${isolatedFiles.length})`)
process.exitCode = status
