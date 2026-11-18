'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runSuite } = require('../scripts/compare-tests')
const { shardOf, shardFiles, expandTestFiles, settingsOf, readStored, writeStored } = require('../scripts/lib/suite-store')
const { compareReports, baselineGaps, withRerun, confirmedByRerun } = require('../scripts/lib/test-report')

function scratch (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-comparison-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  // The real comparison starts its own test runner, not a nested node:test
  // process that sends binary results to the parent instead of writing TAP.
  const context = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context })
  return directory
}
function put (directory, file, text) {
  const full = path.join(directory, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text + '\n')
}
function splitFixture (directory, prepend = false) {
  const tests = ["test('one',()=>{})", "test('two',()=>{})", "test('known legacy failure',()=>assert.equal(1,2))", "test('four',()=>{})"]
  if (prepend) tests.unshift("test('new passing test',()=>{})")
  put(directory, 'test/runtime-idle-escape.test.js', [
    "const {test:register}=require('node:test'); const assert=require('node:assert/strict')",
    'const PARTS=4,PART=Number(globalThis.testFilePart??0); let ordinal=0',
    'const test=(...args)=>(ordinal++%PARTS===PART?register(...args):undefined)',
    ...tests
  ].join('\n'))
  for (let part = 2; part <= 4; part++) put(directory, `test/runtime-idle-escape.part${part}.test.js`, `globalThis.testFilePart=${part - 1}; require('./runtime-idle-escape.test.js')`)
}

test('review: adding a passing test before an old failure does not introduce a regression in a split suite', async t => {
  const directory = scratch(t), base = path.join(directory, 'base'), current = path.join(directory, 'current')
  splitFixture(base); splitFixture(current, true)
  const shard = { index: shardOf('test/runtime-idle-escape.test.js', 3), count: 3 }
  const before = await runSuite(base, path.join(directory, 'baseline.tap'), shardFiles(base, shard))
  const after = await runSuite(current, path.join(directory, 'current.tap'), shardFiles(current, shard))
  assert.equal(before.counts.tests, 4)
  assert.equal(after.counts.tests, 5)
  assert.equal(before.counts.fail, 1)
  assert.equal(after.counts.fail, 1)
  assert.deepEqual(compareReports(before, after).introduced, [])
})

test('review: a missing result reruns every part on each side, including the part that owns the failure', async t => {
  const directory = scratch(t), base = path.join(directory, 'base'), current = path.join(directory, 'current')
  splitFixture(base); splitFixture(current, true)
  // The baseline has only the first part's result. The unchanged failing
  // test is now in part 4, but its TAP location still names the original file.
  const before = await runSuite(base, path.join(directory, 'baseline.tap'), ['test/runtime-idle-escape.test.js'])
  const after = await runSuite(current, path.join(directory, 'current.tap'), ['test/runtime-idle-escape.part4.test.js'])
  const introduced = compareReports(before, after).introduced
  assert.equal(introduced.length, 1)
  const baseFiles = expandTestFiles(base, baselineGaps(before, introduced))
  const baseAgain = await runSuite(base, path.join(directory, 'baseline-rerun.tap'), baseFiles)
  assert.deepEqual(compareReports(withRerun(before, baseAgain, baseFiles), after).introduced, [])
  const currentFiles = expandTestFiles(current, introduced.map(item => item.file))
  const currentAgain = await runSuite(current, path.join(directory, 'current-rerun.tap'), currentFiles)
  assert.ok(currentAgain.reported.includes('known legacy failure'), 'the suspect test actually ran again')
  assert.equal(currentAgain.counts.tests, 5)
  assert.deepEqual(confirmedByRerun(introduced, currentAgain).confirmed, introduced)
})

test('review: an old dependency failure cannot hide a current regression behind a kept baseline', async t => {
  const directory = scratch(t), base = path.join(directory, 'base'), current = path.join(directory, 'current'), stored = path.join(directory, 'stored')
  const files = ['test/dependency-case.test.js'], sha = 'a'.repeat(40)
  for (const folder of [base, current]) {
    put(folder, files[0], "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('keeps value',()=>assert.equal(require('../value')(),2))")
    put(folder, 'package.json', JSON.stringify({ name: 'comparison-fixture', private: true }))
  }
  const install = value => {
    for (const folder of [base, current]) {
      put(folder, 'node_modules/local-dependency/index.js', `exports.value=${value}`)
      put(folder, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/local-dependency': { version: `${value}.0.0` } } }))
    }
  }
  put(base, 'value.js', "module.exports=()=>require('local-dependency').value")
  put(current, 'value.js', 'module.exports=()=>1') // The actual regression.
  const options = { directory: current, concurrency: 2, shard: { index: 1, count: 1 } }
  install(1)
  const oldBaseline = await runSuite(base, path.join(directory, 'old-baseline.tap'), files)
  assert.equal(oldBaseline.counts.fail, 1)
  writeStored(stored, sha, settingsOf(options), oldBaseline)

  // A fresh baseline uses the current dependencies, just like compare-tests.
  install(2)
  const kept = readStored(stored, sha, settingsOf(options))
  assert.equal(kept, null, 'the old result must not replace a run with current dependencies')
  const baseline = kept?.report ?? await runSuite(base, path.join(directory, 'fresh-baseline.tap'), files)
  const changed = await runSuite(current, path.join(directory, 'current.tap'), files)
  assert.equal(baseline.counts.pass, 1)
  assert.equal(changed.counts.fail, 1)
  assert.deepEqual(compareReports(baseline, changed).introduced.map(item => item.name), ['keeps value'])
})
