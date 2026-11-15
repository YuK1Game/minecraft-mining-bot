'use strict'

// test/helpers/runtime-source.js puts the parts moved out of runtime.js and
// quarry-job.js back into one text for the tests that read, slice or instrument
// the source. If a moved part stopped matching (a hand-edited accessor block, a
// new layout), a test would silently read a text with a piece missing; this
// pins the helper and the layout the extraction tool writes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const { runtimeSource, flattenedSource, sourceFile } = require('./helpers/runtime-source')
const read = name => fs.readFileSync(sourceFile(name), 'utf8').replace(/\r\n/g, '\n')
const wiringOf = text => [...text.matchAll(/^[ \t]*const (\w+) = require\('(\.\.?\/[\w./-]+)'\)\.(\w+)\(\{\n[ \t]+get /gm)].map(match => ({ instance: match[1], spec: match[2], module: path.posix.basename(match[2]), factory: match[3] }))

for (const [owner, least, landmarks] of [
  ['runtime.js', 6, ['  function initialiseMotion () {', '  let longTravel = null', '  const operations = {']],
  ['quarry-job.js', 4, ['async function storeCarried (', 'async function egress (', 'async function restock (', 'async function reconcileObservedStoragePlacement (']]
]) {
  test(`every part moved out of ${owner} is put back, and the result is one valid source`, () => {
    const original = read(owner), parts = wiringOf(original)
    assert.ok(parts.length >= least, `${owner} creates its moved parts with accessor blocks`)
    const text = owner === 'runtime.js' ? runtimeSource() : flattenedSource(owner)
    for (const part of parts) {
      assert.equal(text.includes(`require('${part.spec}')`), false, `${part.module} is inlined`)
      assert.equal(new RegExp(`\\b${part.instance}\\.`).test(text), false, `no ${part.instance}.<name> is left`)
      const moved = read(`${part.module}.js`)
      const body = moved.slice(moved.indexOf(`function ${part.factory} (rt) {\n`), moved.lastIndexOf('\n  return {\n')).split('\n').slice(1)
      // A long line of the moved code that needed no prefix is in the text as it is.
      const sample = body.filter(line => line.length > 80 && !line.includes('rt.')).slice(0, 3)
      assert.ok(sample.length > 0, part.module)
      for (const line of sample) assert.ok(text.includes(line), `a line of ${part.module} is present`)
    }
    assert.equal(/\brt\./.test(text), false, 'no rt.<name> is left')
    assert.doesNotThrow(() => new vm.Script(Module.wrap(text), { filename: `${owner}-flattened.js` }))
    assert.ok(text.length > original.length)
    for (const landmark of landmarks) assert.ok(text.includes(landmark), landmark)
  })
}

test('the moved modules keep the layout the helper and the extraction tool rely on', () => {
  for (const owner of ['runtime.js', 'quarry-job.js']) {
    for (const part of wiringOf(read(owner))) {
      const moved = read(`${part.module}.js`)
      assert.ok(moved.includes(`function ${part.factory} (rt) {\n`), part.module)
      assert.ok(moved.trimEnd().endsWith(`module.exports = { ${part.factory} }`), part.module)
      assert.equal(/^const .* = require\(/m.test(moved), false, `${part.module} loads modules through rt.require so test overrides and hot reload apply`)
      // A part may sit in another directory than its owner; paths it builds go through the owner's __dirname.
      assert.equal(/(?<!rt\.)__dirname/.test(moved), false, `${part.module} uses rt.__dirname`)
    }
  }
})
