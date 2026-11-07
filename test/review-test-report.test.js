'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTap, compareReports } = require('../scripts/lib/test-report')
const report = (root, code = 'ERR_ASSERTION') => `TAP version 13\nnot ok 1 - example\n  ---\n  location: '${root}/test/demo.test.js:40:1'\n  failureType: 'testCodeFailure'\n  code: '${code}'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n`
test('review: regression comparison normalizes checkout roots but not changed failure types', () => {
  const before = parseTap(report('/tmp/base'), { root: '/tmp/base' })
  const after = parseTap(report('/tmp/head'), { root: '/tmp/head' })
  assert.equal(compareReports(before, after).introduced.length, 0)
  assert.equal(compareReports(before, parseTap(report('/tmp/head', 'ENOENT'), { root: '/tmp/head' })).introduced.length, 1)
})
test('review: truncated or missing test reports never pass a baseline gate', () => {
  assert.throws(() => parseTap('TAP version 13\nok 1 - example\n'), /incomplete/)
})
test('review: duplicate failures are compared as a multiset, not silently collapsed', () => {
  const parsed = parseTap(report('/tmp/base'), { root: '/tmp/base' })
  assert.equal(compareReports(parsed, { ...parsed, failures: [...parsed.failures, ...parsed.failures] }).introduced.length, 1)
})
