'use strict'

// Fast local developer feedback lane (`npm run test:fast`).
// Runs pure unit, policy, ledger, tool, and dashboard tests from the strict
// lanes while skipping multi-second physics/world/mine/quarry simulations
// (which still run in `npm run test:player` and `npm run test:review`).
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { playerNames, reviewNames } = require('./lib/test-lanes')

const HEAVY_SIMULATION = [
  /^branch-mine-(?!tools|plan|geometry|needs|sites|state|progress)/,
  /^quarry-/,
  /^review-/,
  /^runtime-/,
  /^loadout-/,
  /^player-(?:return-live|return\.test|house-|base\.test|storage\.test|departure|climb|cover|flee|shelter|tree|wood|workstation)/,
  /^dragon-(?:dig-tool|home-iron|early-home|rest-pit|nether|stronghold|end|food-lap|whole-tree|surface|wood)/,
  /^house-(?:build|repair|placement|spawn|exit)/,
  /^ladder-/
]

const root = path.resolve(__dirname, '..')
const allStrict = [...new Set([...playerNames(root).files, ...reviewNames(root)])].sort()
const fastFiles = allStrict
  .filter(name => !HEAVY_SIMULATION.some(re => re.test(name)))
  .map(name => path.join('test', name))

if (!fastFiles.length) { console.error('test:fast: no test files selected'); process.exit(1) }

const envConcurrency = Number(process.env.TEST_CONCURRENCY)
const concurrency = Number.isInteger(envConcurrency) && envConcurrency >= 1
  ? envConcurrency
  : Math.max(2, Math.min(8, os.availableParallelism()))

const startedAt = Date.now()
const run = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, '--test-timeout=30000', ...fastFiles],
  { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
if (run.error) throw run.error
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
const out = run.stdout ?? ''
const count = name => { const found = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(out); return found ? Number(found[1]) : null }
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)]))
const failed = out.split('\n# Subtest: ').slice(1).filter(block => /^not ok /m.test(block))
for (const block of failed) console.log(`# Subtest: ${block.trimEnd()}`)
if (run.stderr) process.stderr.write(run.stderr)
console.log(`test:fast: ${fastFiles.length}/${allStrict.length} strict files, ${totals.tests} tests: pass ${totals.pass}, fail ${totals.fail}, cancelled ${totals.cancelled}, skipped ${totals.skipped} (${elapsedSec}s, concurrency=${concurrency})`)
if (run.status !== 0 || totals.fail > 0 || totals.cancelled > 0 || totals.skipped > 0 || totals.pass !== totals.tests) process.exit(1)
