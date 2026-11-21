'use strict'

// Load the real Runtime module graph. A moved factory/stage keeps its own
// filename, lexical scope and relative requires; nothing is flattened.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const src = path.resolve(__dirname, '../../src')
const runtimeFile = path.join(src, 'runtime.js')

function replaceOnce (source, before, after) {
  assert.equal(source.split(before).length, 2, `Runtime fixture seam must occur once: ${before}`)
  return source.replace(before, () => after)
}

function installRuntimeFixture (root, overrides = {}, { transforms = {}, capture = {}, inspect = true } = {}) {
  const cache = new Map([[runtimeFile, root]])
  const resolve = name => Module._resolveFilename(name, root)
  const replacements = new Map()
  const edits = new Map(Object.entries(transforms).map(([name, edit]) => [path.resolve(src, name), edit]))
  const captureBinding = (key, value) => { capture[key] = value }
  const instrument = (source, filename) => {
    source = edits.get(filename)?.(source) ?? source
    if (!inspect) return source
    if (filename === runtimeFile) {
      const marker = '  return {\n    operations: runtimeOperations.operations,'
      source = replaceOnce(source, marker, `  require('runtime-fixture:capture')('runtime', {
    get runner () { return runner },
    get portableMovementLease () { return portableMovementLease },
    set portableMovementLease (value) { portableMovementLease = value },
    get shelter () { return shelter }, get hut () { return hut },
    activeBase, readyNightSoilShelter, dispatchDepotIntent
  })
${marker}`)
    }
    if (filename === path.join(src, 'runtime/idle-safety-runtime.js')) {
      const marker = '    const owners = { inventory: null, combat: null, hut: null, escape: null }'
      source = replaceOnce(source, marker, marker + "\n    require('runtime-fixture:capture')('safety', { owners })")
    }
    return source
  }
  function attach (loaded) {
    const compile = loaded._compile.bind(loaded)
    loaded._compile = (source, filename) => {
      // Older fixture consumers configure services immediately before compile.
      // Resolve their final dependency names here, and keep values live.
      if (filename === runtimeFile) {
        replacements.clear()
        for (const name of Object.keys(overrides)) replacements.set(resolve(name), name)
      }
      return compile(instrument(source, filename), filename)
    }
    loaded.require = name => {
      if (name === 'runtime-fixture:capture') return captureBinding
      const resolved = Module._resolveFilename(name, loaded)
      const override = replacements.get(resolved)
      if (override && Object.hasOwn(overrides, override)) return overrides[override]
      // Only Runtime's divided modules need an isolated evaluation. Regular
      // production dependencies retain Node's normal cache and real behavior.
      if (resolved.startsWith(path.join(src, 'runtime') + path.sep) || edits.has(resolved)) {
        if (cache.has(resolved)) return cache.get(resolved).exports
        const child = new Module(resolved, loaded)
        child.filename = resolved
        child.paths = Module._nodeModulePaths(path.dirname(resolved))
        cache.set(resolved, child)
        attach(child)
        child._compile(fs.readFileSync(resolved, 'utf8'), resolved)
        child.loaded = true
        return child.exports
      }
      return Module.prototype.require.call(loaded, name)
    }
  }
  attach(root)
  return capture
}

function loadRuntime ({ overrides = {}, source, ...options } = {}) {
  const loaded = new Module(runtimeFile, module)
  loaded.filename = runtimeFile
  loaded.paths = Module._nodeModulePaths(path.dirname(runtimeFile))
  const inspection = installRuntimeFixture(loaded, overrides, options)
  loaded._compile(source ?? fs.readFileSync(runtimeFile, 'utf8'), runtimeFile)
  return { ...loaded.exports, inspection }
}

module.exports = { installRuntimeFixture, loadRuntime, replaceOnce }
