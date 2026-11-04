'use strict'

// Reuse the offline Runtime/Guard integration fixture without loading its large
// suite. The test-only seam makes the observation boundary transition exact.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixtureFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const gate = '              const waterObserved = safetyState()'
const seam = 'const runtimeSource = originalRuntime'
assert.equal(fixtureSource.split(seam).length, 2)
fixtureSource = fixtureSource.replace(seam, `const runtimeSource = originalRuntime.replace(${JSON.stringify(gate)}, ${JSON.stringify('              host.shared.waterBoundaryProbe?.()\n' + gate)})`)
const target = { exports: {} }
const load = new vm.Script('(function(require,module,__filename,__dirname){' + fixtureSource + ';module.exports={prepare,context};})', { filename: fixtureFile }).runInThisContext()
load(Module.createRequire(fixtureFile), target, fixtureFile, path.dirname(fixtureFile))
const { prepare, context } = target.exports

for (const mode of ['unchanged', 'departed_known', 'primary_departed_known', 'missing', 'replaced', 'primary_missing', 'primary_replaced', 'new_actor', 'increased_radius']) test(`water gate preserves actor proof across a danger boundary: ${mode}`, async t => {
  const observed = require('./fixtures/creeper-spider-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const spider = f.actors.find(actor => actor.uniqueId === '-244813135865')
  const creeper = f.actors.find(actor => actor.uniqueId === '-261993005034')
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const initial = context(f)
  assert.equal(initial.threats.length, 2)
  let changed = false
  f.shared.waterBoundaryProbe = () => {
    if (changed) return
    changed = true
    if (['departed_known', 'replaced'].includes(mode)) spider.position.z += 2
    if (['primary_departed_known', 'primary_replaced'].includes(mode)) creeper.position.z -= 4
    if (mode === 'missing') f.actors.splice(f.actors.indexOf(spider), 1)
    if (mode === 'primary_missing') f.actors.splice(f.actors.indexOf(creeper), 1)
    if (mode === 'replaced') spider.uniqueId = 'replacement'
    if (mode === 'primary_replaced') creeper.uniqueId = 'replacement'
    if (mode === 'new_actor') f.actors.push({ ...f.enemy(), runtimeId: '777', uniqueId: '777', entityType: 'minecraft:skeleton', position: { x: observed.position.x + 3, y: observed.position.y, z: observed.position.z } })
    if (mode === 'increased_radius') creeper.charged = true
  }
  if (['new_actor', 'increased_radius'].includes(mode)) {
    try {
      const result = await f.safeties[0].options.escape(initial)
      assert.equal(result.supported, false, JSON.stringify(result))
    } catch (error) {
      assert.match(error.message, /Idle escape danger changed/)
    }
    assert.equal(f.movements[0].starts.length, 0)
  } else {
    const result = await f.safeties[0].options.escape(initial)
    const allowed = ['unchanged', 'departed_known', 'primary_departed_known'].includes(mode)
    assert.equal(result.supported, allowed, JSON.stringify(result))
    assert.equal(f.movements[0].starts.length > 0, allowed)
  }
  assert.equal(changed, true)
})
