'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const files = fs.readdirSync(path.join(root, 'test')).filter(name => /^(?:review-|dashboard-control|loadout-).*\.test\.js$/.test(name)).sort().map(name => path.join('test', name))
if (!files.length) throw new Error('No review regression tests found')
const compatibility = ['manual-chest-deposit.test.js', 'manual-chest-runtime-adapter.test.js', 'quarry-v22-reset.test.js', 'quarry-v22-reset-complete.test.js', 'quarry-supply-job.test.js', 'quarry-supply-portable.test.js', 'quarry-supplies.test.js', 'inventory-inspection.test.js', 'runtime-combat-priority.test.js', 'initial-life-receipt.test.js', 'combat-coordinator.test.js', 'quarry-job.test.js', 'quarry-runtime-adapter.test.js', 'idle-safety-armed-continuation.test.js', 'quarry-carried-storage.test.js', 'quarry-observed-placement-job.test.js', 'quarry-source-rejection.test.js', 'quarry-storage-reachability.test.js', 'quarry-pillar-exit.test.js', 'quarry-egress-runtime.test.js', 'dashboard-state.test.js', 'dashboard-depot-state.test.js', 'dashboard.test.js', 'host-packets.test.js', 'keep-alive.test.js', 'hotreload.test.js', 'hotreload-content-filter.test.js'].map(name => path.join('test', name))
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=2', '--test-timeout=60000', ...files, ...compatibility, 'test/quarry-debug-site.test.js', 'test/quarry-v22-reset-site.test.js', 'test/quarry-initial-loadout.test.js', 'test/quarry-v22-chest-work.test.js', 'test/chest.test.js', 'test/chest-withdrawal.test.js', 'test/chest-withdrawal-response.test.js'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
