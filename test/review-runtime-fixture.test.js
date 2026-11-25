'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { replaceOnce } = require('./helpers/runtime-fixture')

const fixtureFile = path.resolve(__dirname, 'runtime-user-behaviors.test.js')
const fixture = new Module(fixtureFile, module)
fixture.filename = fixtureFile
fixture.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
fixture._compile(fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { scene }', fixtureFile)
const runtimeFile = path.resolve(__dirname, '../src/runtime.js')
const runtimeDirectory = path.resolve(__dirname, '../src/runtime') + path.sep
const nativeRead = fs.readFileSync

test('real factories use declared port groups, preserve live state and only write owned bindings', async t => {
  const real = require('../src/runtime/runtime-ports'), seen = new Map()
  const f = fixture.exports.scene(t, { runtimeOverrides: {
    './runtime/runtime-ports': { ...real, bindRuntimePorts (bindings, name) {
      const alias = real.bindRuntimePorts(bindings, name)
      seen.set(name, { alias, ports: real.runtimePortGroups(alias) })
      return alias
    } }
  } })
  assert.deepEqual([...seen.keys()].sort(), ['operations', 'safety', 'travel', 'userControl'])
  for (const { alias, ports } of seen.values()) {
    assert.ok(Object.isFrozen(alias)); assert.ok(Object.isFrozen(ports))
    assert.equal(Reflect.set(alias, 'host', {}), false, 'a factory cannot replace the shared host')
    assert.equal(Reflect.set(alias, 'raw', () => ({ health: 20 })), false, 'a factory cannot replace received state with a fabricated reading')
    assert.equal(Reflect.set(alias, 'undeclared', true), false)
  }
  const user = seen.get('userControl')
  f.raw.health = 17
  assert.equal(user.ports.observation.working().health, 17, 'ports read the current closure rather than a creation-time copy')
  assert.equal(Reflect.set(user.alias, 'disposed', true), false)
  const context = { kind: 'combat', claimId: 'ports-real-lease', scope: f.scope() }
  const token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  assert.equal(user.ports.protection.userBehaviorLease.claimId, context.claimId)
  await f.facadeOptions.resumeControl({ ...context, token })
  assert.equal(user.ports.protection.userBehaviorLease, null)
  assert.deepEqual(f.wire, [], 'port and lease checks do not create an attack receipt or queue a game action')
})

for (const rootCrlf of [true, false]) test(`real Runtime and divided control modules execute with ${rootCrlf ? 'root and child' : 'child-only'} CRLF sources`, async t => {
  const crlfReads = new Set(), transformed = new Set()
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    const source = nativeRead.call(fs, filename, ...args)
    if (typeof filename !== 'string' || typeof source !== 'string') return source
    const resolved = path.resolve(filename)
    if (resolved !== runtimeFile && !resolved.startsWith(runtimeDirectory)) return source
    if (!rootCrlf && resolved === runtimeFile) return source.replace(/\r\n/g, '\n')
    crlfReads.add(resolved)
    return source.replace(/\r?\n/g, '\r\n')
  })
  const f = fixture.exports.scene(t, { runtimeHooks: { transforms: {
    'runtime/user-control-runtime.js': source => {
      transformed.add('control')
      const marker = '    async function acquireUserControl (context) {\n      rt.requireGeneration()'
      // This observes the real divided function; the original ownership,
      // cancellation and input logic below the marker still executes.
      return replaceOnce(source, marker, marker + '\n      rt.host.shared.fixtureAcquisitions = (rt.host.shared.fixtureAcquisitions ?? 0) + 1')
    },
    'runtime/runtime-operations.js': source => {
      transformed.add('operations')
      assert.ok(source.includes('function createRuntimeOperations (rt) {\n'))
      assert.equal(source.includes('\r'), false, 'module transforms receive normalized source')
      return source
    }
  } } })
  assert.equal(crlfReads.has(runtimeFile), rootCrlf)
  assert.ok(crlfReads.has(path.join(runtimeDirectory, 'user-control-runtime.js')))
  assert.ok(crlfReads.has(path.join(runtimeDirectory, 'runtime-operations.js')))
  assert.deepEqual([...transformed].sort(), ['control', 'operations'])
  assert.ok(f.inspection.runtime.runner)
  assert.deepEqual(f.inspection.safety.owners, { inventory: null, combat: null, hut: null, escape: null })
  assert.equal(typeof f.runtime.operations.agent.yieldWork, 'function')
  assert.equal(typeof f.runtime.operations.mode.status, 'function', 'the actual split operations module keeps its Dragon Runtime port import')
  assert.deepEqual(f.wire, [], 'constructing and inspecting Runtime sends no packets')
  const context = { kind: 'combat', claimId: 'fixture-crlf', scope: f.scope() }
  const token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  assert.equal(f.shared.fixtureAcquisitions, 1)
  assert.deepEqual(f.wire, [], 'an inspection hook cannot fabricate a game action')
  await f.facadeOptions.resumeControl({ ...context, token })
})
