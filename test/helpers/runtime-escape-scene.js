'use strict'

// Reuse the existing controlled terrain/Guard fixture, but load Runtime and
// every escape stage in their original module scopes. Only fixture setup is
// extracted; no production source is flattened or evaluated as a fragment.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { replaceOnce } = require('./runtime-fixture')

function createEscapeScene (runtimeHooks = {}) {
  const filename = path.resolve(__dirname, '../runtime-idle-escape.test.js')
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const compiled = '  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))'
  const loaded = "  Object.assign(target.exports, require('./helpers/runtime-fixture').loadRuntime({ overrides, source: runtimeSource, ...runtimeHooks }))"
  source = replaceOnce(source, 'const moduleTarget = { exports: {} }', `replace(${JSON.stringify(compiled)}, ${JSON.stringify(loaded)})\nconst moduleTarget = { exports: {} }`)
  source = replaceOnce(source, '__dirname,runtimeSource){', '__dirname,runtimeSource,runtimeHooks){')
  source = replaceOnce(source, 'path.dirname(fixtureFile), runtimeSource)', 'path.dirname(fixtureFile), runtimeSource, runtimeHooks)')
  const loadedFixture = { exports: {} }
  const initialize = new vm.Script('(function(require,module,__filename,__dirname,runtimeHooks){' + source + ';module.exports={prepare,context};})', { filename }).runInThisContext()
  initialize(Module.createRequire(filename), loadedFixture, filename, path.dirname(filename), runtimeHooks)
  return loadedFixture.exports
}

module.exports = { createEscapeScene }
