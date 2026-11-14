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

test('review: forced test exit preserves complete output and the final real failure under backpressure', { timeout: 10000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
  const { createRequire } = require('node:module'), childProcess = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-tap-output-'))
  const fixture = path.join(directory, 'output.test.cjs'), output = path.join(directory, 'result.tap')
  const children = new Set()
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL') })))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  fs.writeFileSync(fixture, `
    const test = require('node:test'), assert = require('node:assert/strict')
    test('received output before failure', t => {
      for (let i = 0; i < 32; i++) t.diagnostic('received-output-' + i + ':' + 'x'.repeat(16384))
      console.error('received stderr sentinel')
      setInterval(() => {}, 60000)
    })
    test('final real failure sentinel', () => assert.equal(1, 2))
  `)
  const filename = path.resolve(__dirname, '../scripts/compare-tests.js')
  const nativeRequire = createRequire(filename), loaded = { exports: {} }
  let completion
  // Delay acknowledgements of real file writes to create deterministic pipe
  // backpressure. The child, filesystem, TAP parser and failure remain real.
  const delayedFileSystem = {
    ...fs,
    write: (fd, buffer, offset, length, position, callback) => fs.write(fd, buffer, offset, length, position, (...args) => setTimeout(() => callback(...args), 20)),
    writev: (fd, buffers, position, callback) => fs.writev(fd, buffers, position, (...args) => setTimeout(() => callback(...args), 20))
  }
  const load = name => name === 'node:fs'
    ? { ...fs, createWriteStream: (file, options) => fs.createWriteStream(file, { ...options, highWaterMark: 1024, fs: delayedFileSystem }) }
    : name === 'node:child_process'
      ? { ...childProcess, spawn: (command, args, options) => {
          const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
          // Execute one real node:test fixture directly, preserving force-exit
          // and TAP. This isolates runSuite's outer output from Node's separate
          // file-child serializer, whose force-exit limitation is not fixed here.
          const child = childProcess.spawn(command, [...args.filter(arg => arg !== '--test'), fixture], { ...options, env })
          children.add(child)
          child.once('close', (code, signal) => { completion = { code, signal }; children.delete(child) })
          return child
        } }
      : nativeRequire(name)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: load, module: loaded, exports: loaded.exports, __dirname: path.dirname(filename), process, setTimeout, clearTimeout, console }, { filename })
  const result = await loaded.exports.runSuite(directory, output)
  assert.equal(result.counts.tests, 2)
  assert.equal(result.counts.pass, 1)
  assert.equal(result.counts.fail, 1)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].name, 'final real failure sentinel')
  assert.equal(result.failures[0].code, 'ERR_ASSERTION')
  assert.deepEqual(completion, { code: 1, signal: null })
  const text = fs.readFileSync(output, 'utf8')
  assert.equal((text.match(/^# received-output-\d+:/gm) ?? []).length, 32)
  assert.match(text, /received stderr sentinel/)
  assert.match(text, /^1\.\.2$/m)
})
