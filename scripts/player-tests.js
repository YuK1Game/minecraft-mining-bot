'use strict'

// The player-mode lane: `npm run test:player`.
// It passes only when every test in it ran and passed. A failure, a timeout,
// a cancelled, skipped or todo test, or a lane with no tests at all fails it.
// The files are the player-mode modules and what the return to the base
// stands on (docs/player-return.md). A file with a failure older than the
// lane is named below with its reason and printed on every run, so it is
// neither hidden nor counted as passing.
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { playerNames } = require('./lib/test-lanes')
const root = path.resolve(__dirname, '..')
const lane = playerNames(root)
const EXCLUDED = lane.excluded
const files = lane.files.map(name => path.join('test', name))
if (!files.length) { console.error('test:player: no test files found'); process.exit(1) }
const required = ['player-return.test.js', 'player-return-live.test.js', 'player-return-units.test.js', 'player-base.test.js', 'player-storage.test.js']
const missing = required.filter(name => !files.includes(path.join('test', name)))
if (missing.length) { console.error(`test:player: required files are missing: ${missing.join(', ')}`); process.exit(1) }

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=2', '--test-timeout=120000', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
if (run.error) throw run.error
const out = run.stdout ?? ''
const count = name => { const found = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(out); return found ? Number(found[1]) : null }
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)]))
// Only what failed is printed in full; the passing lines stay out of the way.
const failed = out.split('\n# Subtest: ').slice(1).filter(block => /^not ok /m.test(block))
for (const block of failed) console.log(`# Subtest: ${block.trimEnd()}`)
if (run.stderr) process.stderr.write(run.stderr)
console.log(`test:player: ${files.length} files, ${totals.tests} tests: pass ${totals.pass}, fail ${totals.fail}, cancelled ${totals.cancelled}, skipped ${totals.skipped}, todo ${totals.todo}`)
for (const [name, why] of Object.entries(EXCLUDED)) console.log(`test:player: not in the lane: ${name} (${why})`)

const problems = []
if (run.status !== 0) problems.push(`the test runner ended with status ${run.status}${run.signal ? ` (${run.signal})` : ''}`)
if (Object.values(totals).some(value => value === null)) problems.push('the totals could not be read')
if (!(totals.tests > 0)) problems.push('no test ran')
if (totals.pass !== totals.tests) problems.push('not every test passed')
for (const name of ['fail', 'cancelled', 'skipped', 'todo']) if (totals[name] > 0) problems.push(`${totals[name]} ${name}`)
if (problems.length) { console.error(`test:player: FAILED: ${problems.join('; ')}`); process.exit(1) }
console.log('test:player: passed')
