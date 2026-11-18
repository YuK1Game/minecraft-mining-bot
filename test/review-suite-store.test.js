'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { parseShard, shardOf, testFiles, shardFiles, expandTestFiles, settingsOf, settingsKey, readStored, writeStored, prune } = require('../scripts/lib/suite-store')
const { reviewNames, playerNames, strictFiles } = require('../scripts/lib/test-lanes')
const { runSuite, nodeOptions } = require('../scripts/compare-tests')

const root = path.resolve(__dirname, '..')
const sha = letter => letter.repeat(40)
const report = (extra = {}) => ({ counts: { tests: 3, pass: 2, fail: 1 }, failures: [{ name: 'a', file: 'test/a.test.js', failureType: 'testCodeFailure', code: 'ERR_ASSERTION', key: 'k' }], unreported: [], reported: ['a', 'b', 'c'], ...extra })
function scratch (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function tree (t, files) {
  const directory = scratch(t)
  for (const name of files) { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), '') }
  return directory
}

test('review: a shard is "k/n"; nothing means the whole suite; anything else is refused', () => {
  assert.deepEqual(parseShard(undefined), { index: 1, count: 1 })
  assert.deepEqual(parseShard(''), { index: 1, count: 1 })
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 })
  for (const bad of ['0/3', '4/3', '1/0', '1/17', '1-3', 'x', '1/3/5']) assert.throws(() => parseShard(bad), /SUITE_SHARD/, bad)
})

test('review: a file keeps its shard when other files are added, and every file is in exactly one shard', t => {
  const before = tree(t, ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/deep/d.test.js', 'test/helpers/sim.js', 'test/notes.md'])
  const after = tree(t, ['test/a.test.js', 'test/aa.test.js', 'test/b.test.js', 'test/c.test.js', 'test/deep/d.test.js', 'test/e.test.mjs'])
  assert.deepEqual(testFiles(before), ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/deep/d.test.js'], 'only test files, sorted, with forward slashes')
  for (const file of testFiles(before)) assert.equal(shardOf(file, 3), shardOf(file.replaceAll('/', path.sep), 3), 'the same shard on every platform')
  const parts = [1, 2, 3].map(index => shardFiles(after, { index, count: 3 }))
  assert.deepEqual(parts.flat().sort(), testFiles(after), 'together the shards are the suite')
  for (const file of testFiles(before)) {
    const was = [1, 2, 3].find(index => shardFiles(before, { index, count: 3 }).includes(file))
    assert.ok(parts[was - 1].includes(file), `${file} stayed in shard ${was}`)
  }
  assert.deepEqual(shardFiles(after, { index: 1, count: 1 }), testFiles(after))
})

test('review: the files of the strict lanes are not run again by the comparison, on the base as on the change', t => {
  const strict = strictFiles(root)
  const compared = new Set(testFiles(root))
  assert.ok(strict.has('test/review-suite-store.test.js') && strict.has('test/player-return.test.js') && strict.has('test/quarry-job.test.js'))
  for (const part of ['test/quarry-job.part2.test.js', 'test/quarry-job.part3.test.js']) assert.ok(strict.has(part), `${part} runs in the review lane with its file`)
  for (const file of strict) assert.equal(compared.has(file), false, `${file} is in a strict lane`)
  // A file kept out of the player lane for an old failure is still compared with the base.
  for (const name of Object.keys(playerNames(root).excluded)) assert.ok(compared.has(`test/${name}`) && !strict.has(`test/${name}`), name)
  assert.equal(compared.size + [...strict].filter(file => fs.existsSync(path.join(root, file))).length, fs.readdirSync(path.join(root, 'test')).filter(name => /\.test\.js$/.test(name)).length, 'every test file runs in exactly one place')
  // The base is another directory with its own files; the same rules choose there.
  const base = tree(t, ['test/player-return.test.js', 'test/old-thing.test.js', 'test/review-x.test.js', 'test/quarry-job.test.js'])
  assert.deepEqual(testFiles(base), ['test/old-thing.test.js'])
  assert.ok(reviewNames(root).includes('quarry-job.test.js') && reviewNames(root).indexOf('review-suite-store.test.js') < reviewNames(root).indexOf('quarry-job.test.js'))
})

test('review: split files share one shard and a rerun includes the parts present on that side', t => {
  const family = ['test/deep/a.test.js', 'test/deep/a.part2.test.js', 'test/deep/a.part3.test.js']
  const before = tree(t, [...family, 'test/deep/another.test.js'])
  const after = tree(t, [...family, 'test/deep/a.part4.test.js', 'test/deep/a.partly.test.js'])
  const shard = { index: shardOf(family[0], 3), count: 3 }
  assert.ok(family.every(file => shardFiles(before, shard).includes(file)))
  assert.deepEqual(expandTestFiles(before, [family[0], family[1], 'test/missing.test.js']), family.slice().sort())
  assert.deepEqual(expandTestFiles(after, [family[1]]), [...family, 'test/deep/a.part4.test.js'].sort())
})

test('review: a kept report is read back only for the same commit, shard and settings', t => {
  const directory = scratch(t)
  const settings = settingsOf({ concurrency: 4, shard: { index: 2, count: 3 } })
  assert.equal(readStored(directory, sha('a'), settings), null, 'nothing kept yet')
  assert.equal(writeStored(directory, sha('a'), settings, report(), new Date('2026-11-18T01:00:00Z')), true)
  assert.deepEqual(readStored(directory, sha('a'), settings), { report: report(), savedAt: '2026-11-18T01:00:00.000Z' })
  assert.equal(readStored(directory, sha('b'), settings), null, 'another commit')
  assert.equal(readStored(directory, sha('a'), settingsOf({ concurrency: 4, shard: { index: 1, count: 3 } })), null, 'another shard')
  assert.equal(readStored(directory, sha('a'), settingsOf({ concurrency: 2, shard: { index: 2, count: 3 } })), null, 'another concurrency')
  assert.equal(readStored(directory, sha('a'), { ...settings, node: '99' }), null, 'another Node version')
  assert.equal(readStored(directory, sha('a'), { ...settings, selection: 'other' }), null, 'another way of choosing the files')
  assert.equal(readStored(null, sha('a'), settings), null, 'keeping turned off')
  assert.equal(writeStored(null, sha('a'), settings, report()), false)
})

test('review: a damaged or incomplete kept report is not a report', t => {
  const directory = scratch(t)
  const settings = settingsOf({ concurrency: 4, shard: { index: 1, count: 1 } })
  assert.equal(writeStored(directory, sha('a'), settings, { counts: { tests: 3 }, failures: [] }), false, 'no totals, nothing kept')
  assert.deepEqual(fs.readdirSync(directory), [])
  writeStored(directory, sha('a'), settings, report())
  const file = path.join(directory, `${sha('a')}.1of1.json`)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, sha: sha('b') }))
  assert.equal(readStored(directory, sha('a'), settings), null, 'the file says another commit')
  fs.writeFileSync(file, JSON.stringify({ ...stored, report: { ...stored.report, reported: undefined } }))
  assert.equal(readStored(directory, sha('a'), settings), null, 'the list of tests that ran is missing')
  fs.writeFileSync(file, '{"sha":')
  assert.equal(readStored(directory, sha('a'), settings), null, 'cut short')
})

test('review: dependency and comparison-code changes invalidate both a kept report and its Actions key', t => {
  const inputs = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'scripts/lib/test-lanes.js', 'scripts/lib/suite-store.js', 'scripts/lib/test-report.js', 'scripts/compare-tests.js', 'scripts/lib/blocking-output.js']
  const directory = tree(t, inputs), stored = scratch(t)
  const options = { directory, concurrency: 4, shard: { index: 1, count: 3 } }
  const settings = settingsOf(options), key = settingsKey(settings)
  assert.equal(settings.node, process.versions.node, 'patch versions can change test behavior too')
  writeStored(stored, sha('a'), settings, report())
  for (const file of inputs) {
    fs.writeFileSync(path.join(directory, file), 'changed\n')
    const changed = settingsOf(options)
    assert.equal(readStored(stored, sha('a'), changed), null, file)
    assert.notEqual(settingsKey(changed), key, `${file} also changes the immutable Actions cache key`)
    fs.writeFileSync(path.join(directory, file), '')
  }
  assert.deepEqual(readStored(stored, sha('a'), settingsOf(options)).report, report(), 'unchanged inputs still reuse the report')
  assert.equal(readStored(stored, sha('a'), { ...settings, node: `${settings.node}.different-build` }), null)
  assert.equal(readStored(stored, sha('a'), { ...settings, arch: 'another-architecture' }), null)
})

test('review: reports of other commits are removed, those of the base and the change stay', t => {
  const directory = scratch(t)
  for (const letter of ['a', 'b', 'c']) for (const index of [1, 2]) writeStored(directory, sha(letter), settingsOf({ concurrency: 4, shard: { index, count: 2 } }), report())
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'kept')
  assert.deepEqual(prune(directory, [sha('a'), null, sha('c')]).sort(), [`${sha('b')}.1of2.json`, `${sha('b')}.2of2.json`])
  assert.deepEqual(fs.readdirSync(directory).sort(), [`${sha('a')}.1of2.json`, `${sha('a')}.2of2.json`, `${sha('c')}.1of2.json`, `${sha('c')}.2of2.json`, 'notes.txt'])
  assert.deepEqual(prune(path.join(directory, 'missing'), [sha('a')]), [])
})

test('review: the workflow runs the comparison in the parts the script is told about, and pushes are checked on main only', () => {
  // On Windows the checkout has CRLF line endings.
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(workflow, /\n {2}push:\n {4}branches: \[main\]\n/)
  const parts = /part: \[([\d, ]+)\]/.exec(workflow)[1].split(',').map(Number)
  assert.deepEqual(parts, parts.map((_, index) => index + 1))
  assert.ok(workflow.includes(`SUITE_SHARD: \${{ matrix.part }}/${parts.length}`))
  assert.equal(workflow.split(`of${parts.length}-`).length - 1, 3, 'the three cache keys name the same number of parts')
  assert.match(workflow, /id: suite_inputs\n\s+run: node scripts\/compare-tests\.js --cache-key >> "\$GITHUB_OUTPUT"/)
  assert.equal(workflow.split('${{ steps.suite_inputs.outputs.key }}').length - 1, 3, 'restore and both saves use the current suite inputs')
})

test('review: the cache-key command uses the same runtime and settings as a comparison without starting it', () => {
  const shard = { index: 2, count: 3 }, concurrency = Math.max(2, Math.min(8, os.availableParallelism()))
  const expected = settingsKey(settingsOf({ directory: root, concurrency, shard }))
  const output = execFileSync(process.execPath, ['scripts/compare-tests.js', '--cache-key'], { cwd: root, env: { ...process.env, SUITE_SHARD: '2/3', CI_BASE_SHA: 'not-a-commit' }, encoding: 'utf8' })
  assert.equal(output.trim(), `key=${expected}`)
})

test('review: the comparison reports every test of a file that ends in a burst of results, and the totals', async t => {
  // 2026-11-18: with --test-force-exit a test file's last results, and the
  // runner's totals, were dropped when more than a pipe's 64 KB was still
  // unread at the exit (481 small tests reported as 436 to 457, exit code 0).
  const names = Array.from({ length: 6 }, (_, index) => `test/burst${index}.test.js`)
  const directory = tree(t, names)
  const body = "const { test } = require('node:test')\nfor (let i = 0; i < 60; i++) test(`case ${i} ${'x'.repeat(400)}`, () => {})\n"
  for (const name of names) fs.writeFileSync(path.join(directory, name), body)
  assert.match(nodeOptions(), /--require="[^"\\]*scripts\/lib\/blocking-output\.js"$/, 'the path is quoted and has no backslashes')
  // Inside a test process Node marks the environment so that a nested runner
  // reports to its parent; the comparison is never started from a test.
  const context = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context })
  for (let round = 0; round < 3; round++) {
    const report = await runSuite(directory, path.join(directory, 'report.tap'), names)
    assert.deepEqual({ tests: report.counts.tests, pass: report.counts.pass, fail: report.counts.fail, unreported: report.unreported.length }, { tests: 360, pass: 360, fail: 0, unreported: 0 }, `round ${round}`)
  }
})
