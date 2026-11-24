'use strict'
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { reviewNames } = require('./lib/test-lanes')
const root = path.resolve(__dirname, '..')
const files = reviewNames(root).map(name => path.join('test', name))
if (!files.some(name => /review-/.test(name))) throw new Error('No review regression tests found')
const envConcurrency = Number(process.env.TEST_CONCURRENCY)
const concurrency = Number.isInteger(envConcurrency) && envConcurrency >= 1
  ? envConcurrency
  : Math.max(2, Math.min(6, os.availableParallelism()))
const startedAt = Date.now()
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, '--test-timeout=60000', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`test:review: ${files.length} files finished in ${elapsedSec}s (concurrency=${concurrency})`)
process.exitCode = result.status ?? 1
