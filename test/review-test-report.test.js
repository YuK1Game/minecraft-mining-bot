'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTap, compareReports } = require('../scripts/lib/test-report')
const report = (root, code = 'ERR_ASSERTION') => `TAP version 13\nnot ok 1 - example\n  ---\n  location: '${root}/test/demo.test.js:40:1'\n  failureType: 'testCodeFailure'\n  code: '${code}'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n`
test('review: regression comparison normalizes checkout roots but not changed failure types', () => {
  const roots = [['/tmp/base', '/tmp/head'], ['C:\\work\\base', 'D:\\work\\head'], ['//server/share/base', '//server/share/head']]
  for (const [base, head] of roots) {
    const before = parseTap(report(base), { root: base })
    const after = parseTap(report(head), { root: head })
    assert.equal(before.failures[0].file, 'test/demo.test.js')
    assert.equal(compareReports(before, after).introduced.length, 0)
    assert.equal(compareReports(before, parseTap(report(head, 'ENOENT'), { root: head })).introduced.length, 1)
  }
  const before = parseTap(report('C:\\work\\base'), { root: 'C:\\work\\base' })
  const escaped = report('d:\\work\\head').replaceAll('\\', '\\\\')
  assert.equal(compareReports(before, parseTap(escaped, { root: 'D:\\work\\head' })).introduced.length, 0)
})
test('review: truncated or missing test reports never pass a baseline gate', () => {
  assert.throws(() => parseTap('TAP version 13\nok 1 - example\n'), /incomplete/)
})
test('review: duplicate failures are compared as a multiset, not silently collapsed', () => {
  const parsed = parseTap(report('/tmp/base'), { root: '/tmp/base' })
  assert.equal(compareReports(parsed, { ...parsed, failures: [...parsed.failures, ...parsed.failures] }).introduced.length, 1)
})
// CI 2026-11-14: a baseline test file ended after its twelfth test. The later
// tests, failing for days, had no baseline result and were counted as new.
test('review: a failure the baseline has no result for sends its file to a baseline rerun, and the rerun settles it', () => {
  const { baselineGaps, withRerun } = require('../scripts/lib/test-report')
  const fail = (n, name, file) => `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  location: '/r/${file}:${n}:1'\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  ...\n`
  const pass = (n, name) => `# Subtest: ${name}\nok ${n} - ${name}\n  ---\n  duration_ms: 1\n  ...\n`
  const tail = n => `1..${n}\n# tests ${n}\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`
  const parse = text => parseTap('TAP version 13\n' + text, { root: '/r' })
  // Baseline: the file stopped inside "second"; "third" never started.
  const baseline = parse(fail(1, 'first', 'test/cut.test.js') + '# Subtest: second\n' + pass(2, 'elsewhere') + tail(2))
  const current = parse(fail(1, 'first', 'test/cut.test.js') + fail(2, 'second', 'test/cut.test.js') + fail(3, 'third', 'test/cut.test.js') + pass(4, 'elsewhere') + fail(5, 'really new', 'test/other.test.js') + tail(5))
  assert.deepEqual(baseline.unreported, ['second'])
  assert.deepEqual(current.unreported, [])
  const introduced = compareReports(baseline, current).introduced
  assert.deepEqual(introduced.map(item => item.name), ['second', 'third', 'really new'])
  assert.deepEqual(baselineGaps(baseline, introduced), ['test/cut.test.js', 'test/other.test.js'])
  // The rerun of the cut file shows its tests failed before as well.
  const rerun = parse(fail(1, 'first', 'test/cut.test.js') + fail(2, 'second', 'test/cut.test.js') + fail(3, 'third', 'test/cut.test.js') + tail(3))
  const settled = compareReports(withRerun(baseline, rerun, ['test/cut.test.js']), current)
  assert.deepEqual(settled.introduced.map(item => item.name), ['really new'], 'a test that fails only now is still new')
  // A test that passed in the baseline and fails now is never sent to a rerun.
  const passed = parse(pass(1, 'first') + tail(1)), broken = parse(fail(1, 'first', 'test/cut.test.js') + tail(1))
  assert.deepEqual(baselineGaps(passed, compareReports(passed, broken).introduced), [])
  assert.equal(compareReports(passed, broken).introduced.length, 1)
})
// CI 2026-11-15: one timing-sensitive test failed under load in the current
// run only. A new failure is confirmed by a second run of its file.
test('review: a new failure that passes when its file is run again is not counted; one that fails again or has no result is', () => {
  const { confirmedByRerun } = require('../scripts/lib/test-report')
  const fail = (n, name, file) => `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  location: '/r/${file}:${n}:1'\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  ...\n`
  const pass = (n, name) => `# Subtest: ${name}\nok ${n} - ${name}\n  ---\n  duration_ms: 1\n  ...\n`
  const tail = n => `1..${n}\n# tests ${n}\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`
  const parse = text => parseTap('TAP version 13\n' + text, { root: '/r' })
  const baseline = parse(pass(1, 'slow') + pass(2, 'broken') + pass(3, 'vanished') + tail(3))
  const current = parse(fail(1, 'slow', 'test/a.test.js') + fail(2, 'broken', 'test/a.test.js') + fail(3, 'vanished', 'test/b.test.js') + tail(3))
  const introduced = compareReports(baseline, current).introduced
  assert.equal(introduced.length, 3)
  // Second run: "slow" passes, "broken" fails again, b.test.js reports nothing for "vanished".
  const rerun = parse(pass(1, 'slow') + fail(2, 'broken', 'test/a.test.js') + tail(2))
  const settled = confirmedByRerun(introduced, rerun)
  assert.deepEqual(settled.passed.map(item => item.name), ['slow'])
  assert.deepEqual(settled.confirmed.map(item => item.name), ['broken', 'vanished'])
  // The same name passing in another file does not clear a failure.
  const other = parse(fail(1, 'slow', 'test/a.test.js') + tail(1))
  assert.deepEqual(confirmedByRerun(introduced.slice(0, 1), other).confirmed.map(item => item.name), ['slow'])
})
