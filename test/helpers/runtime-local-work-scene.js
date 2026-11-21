'use strict'

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { replaceOnce } = require('./runtime-fixture')

function prefix (name, exports, edit = source => source) {
  const filename = path.resolve(__dirname, `../${name}.test.js`)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(edit(fs.readFileSync(filename, 'utf8').split('\ntest(')[0]) + `\nmodule.exports={${exports}}`, filename)
  return loaded.exports
}

const { fixture } = prefix('runtime-survival', 'fixture', source => {
  source = replaceOnce(source, 'function loadRuntime (overrides) {', 'function loadRuntime (overrides, runtimeHooks) {')
  source = replaceOnce(source, '  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))', "  Object.assign(target.exports, require('./helpers/runtime-fixture').loadRuntime({ overrides, source: fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), ...runtimeHooks }))")
  source = replaceOnce(source, 'function fixture (t) {', 'function fixture (t, runtimeHooks = {}) {')
  return replaceOnce(source, 'loadRuntime(overrides)(host)', 'loadRuntime(overrides, runtimeHooks)(host)')
})
module.exports.fixture = fixture
const { prepare } = prefix('runtime-local-work-priority', 'prepare', source => {
  source = replaceOnce(source, "fixtureFrom('runtime-survival')", "require('./helpers/runtime-local-work-scene').fixture")
  source = replaceOnce(source, "source = 'prey' }", "source = 'prey', runtimeHooks = {} }")
  return replaceOnce(source, 'runtimeScene(t)', 'runtimeScene(t, runtimeHooks)')
})

module.exports = { fixture, prepare }
