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
