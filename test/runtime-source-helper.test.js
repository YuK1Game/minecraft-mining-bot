'use strict'

// test/helpers/runtime-source.js puts the parts moved out of runtime.js back
// into one text for the tests that read, slice or instrument the source. If a
// moved part stopped matching (a hand-edited accessor block, a new layout), a
// test would silently read a text with a piece missing; this pins the helper.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const { runtimeSource, flattenedSource } = require('./helpers/runtime-source')
const src = path.resolve(__dirname, '..', 'src')
const read = name => fs.readFileSync(path.join(src, name), 'utf8').replace(/\r\n/g, '\n')
const runtime = read('runtime.js')
const wiringOf = text => [...text.matchAll(/^[ \t]*const (\w+) = require\('\.\/([\w-]+)'\)\.(\w+)\(\{\n[ \t]+get /gm)].map(match => ({ instance: match[1], module: match[2], factory: match[3] }))
const wiring = wiringOf(runtime)

test('every part moved out of runtime.js is put back, and the result is one valid source', () => {
  assert.ok(wiring.length >= 4, 'runtime.js creates its moved parts with accessor blocks')
  const text = runtimeSource()
  for (const part of wiring) {
    assert.equal(text.includes(`require('./${part.module}')`), false, `${part.module} is inlined`)
    assert.equal(new RegExp(`\\b${part.instance}\\.`).test(text), false, `no ${part.instance}.<name> is left`)
    const moved = fs.readFileSync(path.join(src, `${part.module}.js`), 'utf8').replace(/\r\n/g, '\n')
    const body = moved.slice(moved.indexOf(`function ${part.factory} (rt) {\n`), moved.lastIndexOf('\n  return {\n')).split('\n').slice(1)
    // A long line of the moved code, with its prefixes removed, is in the text.
    const sample = body.filter(line => line.length > 80 && !line.includes('rt.')).slice(0, 3)
    assert.ok(sample.length > 0)
    for (const line of sample) assert.ok(text.includes(line), `a line of ${part.module} is present`)
  }
  assert.equal(/\brt\./.test(text), false, 'no rt.<name> is left')
  assert.doesNotThrow(() => new vm.Script(Module.wrap(text), { filename: 'runtime-flattened.js' }))
  assert.ok(text.length > runtime.length)
})

test('the parts moved out of quarry-job.js are put back the same way', () => {
  const parts = wiringOf(read('quarry-job.js'))
  assert.ok(parts.length >= 4, 'quarry-job.js creates its moved parts with accessor blocks')
  const text = flattenedSource('quarry-job.js')
  for (const part of parts) {
    assert.equal(text.includes(`require('./${part.module}')`), false, `${part.module} is inlined`)
    assert.equal(new RegExp(`\\b${part.instance}\\.`).test(text), false, `no ${part.instance}.<name> is left`)
    const moved = read(`${part.module}.js`)
    assert.ok(moved.includes(`function ${part.factory} (rt) {\n`) && moved.trimEnd().endsWith(`module.exports = { ${part.factory} }`), part.module)
  }
  assert.equal(/\brt\./.test(text), false, 'no rt.<name> is left')
  assert.doesNotThrow(() => new vm.Script(Module.wrap(text), { filename: 'quarry-job-flattened.js' }))
  for (const name of ['async function storeCarried (', 'async function egress (', 'async function restock (', 'async function reconcileObservedStoragePlacement (']) assert.ok(text.includes(name), name)
})

test('the moved modules keep the layout the helper and the extraction tool rely on', () => {
  for (const part of wiring) {
    const moved = fs.readFileSync(path.join(src, `${part.module}.js`), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(moved.includes(`function ${part.factory} (rt) {\n`), part.module)
    assert.ok(moved.trimEnd().endsWith(`module.exports = { ${part.factory} }`), part.module)
    assert.equal(/^const .* = require\(/m.test(moved), false, `${part.module} loads modules through rt.require so test overrides and hot reload apply`)
  }
})
