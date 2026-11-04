'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const filename = path.resolve(__dirname, 'runtime-survival.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const hook = "isSupportedFood: name => ['minecraft:bread', 'minecraft:beef'].includes(name)"
assert.equal(source.split(hook).length, 2)
source = source.replace(hook, "isSupportedFood: require('../src/food').isSupportedFood")
loaded._compile(source + '\nmodule.exports = { fixture };', filename)
const { fixture } = loaded.exports

test('Runtime admits learning chicken to the normal food dispatch and fresh policy revocation restores legacy admission', async t => {
  const f = fixture(t); f.host.shared.autoWanted = true; f.raw.health = 3; f.daylight(); f.setItems([['chicken', 2]])
  f.host.shared.vitals = { hunger: { value: 16, source: 'server_attribute' } }
  const decision = f.safety()
  assert.equal(decision.type, 'eat'); assert.equal(decision.slot, 0)
  assert.equal(decision.allowEmergencyRotten, undefined)
  await f.autonomous[0].actions.eat(decision, { signal: new AbortController().signal })
  assert.equal(f.events.filter(event => event === 'eat:0').length, 1)
  f.host.shared.autoWanted = false
  assert.notEqual(f.safety()?.type, 'eat')
  assert.equal(f.safety()?.code, 'health_recovery')
  f.setItems([['cooked_chicken', 1]])
  assert.equal(f.safety().type, 'eat', 'normal cooked chicken remains admitted in balanced mode')
})
