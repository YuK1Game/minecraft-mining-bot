'use strict'

// Some tests assert on the runtime's source text. Parts of runtime.js now live
// in modules of their own (scripts/extract-runtime-block.js), where each use of
// a runtime binding is written rt.<name> and the runtime reads their values
// back as <instance>.<name>. This returns all of it as one text with those
// prefixes removed, so the assertions read the code as it was written.
const fs = require('node:fs')
const MOVED = [['long-travel-runtime', 'travelRuntime'], ['quarry-runtime', 'quarryRuntime']]

function runtimeSource () {
  const instances = new RegExp(`\\b(?:${MOVED.map(([, instance]) => instance).join('|')})\\.(?=[A-Za-z_$])`, 'g')
  const strip = text => text.replace(/\brt\./g, '').replace(instances, '')
  return [strip(fs.readFileSync(require.resolve('../../src/runtime'), 'utf8')), ...MOVED.map(([name]) => strip(fs.readFileSync(require.resolve(`../../src/${name}`), 'utf8')))].join('\n')
}

module.exports = { runtimeSource }
