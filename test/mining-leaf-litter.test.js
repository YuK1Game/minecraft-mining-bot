'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { setImmediate: afterPacket } = require('node:timers/promises')
const boxEvidence = require('./fixtures/leaf-litter-bds-1.26.60-box-receipts.json')

// Load only the shared primitive setup. Importing the suite would register
// its unrelated tests here and execute them a second time.
const fixtureFile = require.resolve('./mining.test')
const fixtureModule = new Module(fixtureFile, module)
fixtureModule.filename = fixtureFile
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
const prefix = fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0]
fixtureModule._compile(prefix + '\nmodule.exports = fixture\n', fixtureFile)

function setup (t) {
  const f = fixtureModule.exports()
  t.after(() => f.mining.stop())
  const run = boxEvidence.runs.find(run => run.growth === 2 && run.direction === 'north' && run.serverConfirmed)
  const observed = run.blocks.find(b => b.name === 'leaf_litter')
  const props = Object.fromEntries(Object.entries(observed.properties).map(([key, typed]) => [key, typed.value]))
  f.set(f.target, observed.name, observed.id)
  const block = f.blocks.get(f.id(f.target))
  Object.assign(block, { properties: props, boundingBox: 'empty', hardness: 0, diggable: true })
  const held = structuredClone(run.before[0])
  f.state.selectedSlot = held.slot
  f.state.heldItem = held
  f.state.inventory.items = [held]
  const request = { ...f.target, accessPreparation: 'quarry', expectedName: block.name, expectedRuntimeId: observed.id, requiredTool: null, expectedProperties: structuredClone(props) }
  const notify = () => { f.mining.applyPacket('update_block', { position: f.target }); return afterPacket() }
  return { ...f, block, request, notify }
}

test('quarry leaf-litter requests reject unknown growth, direction, runtime or tool before sending input', t => {
  const f = setup(t)
  for (const mutate of [
    p => { delete p.expectedProperties },
    p => { delete p.expectedProperties.growth },
    p => { p.expectedProperties.growth = -1 },
    p => { p.expectedProperties.growth = 4 },
    p => { p.expectedProperties.growth = '2' },
    p => { p.expectedProperties['minecraft:cardinal_direction'] = 'up' },
    p => { p.expectedProperties.extra = 1 },
    p => { delete p.expectedRuntimeId },
    p => { p.expectedRuntimeId = 2 ** 32 },
    p => { p.requiredTool = { kind: 'shovel', tier: 4 } }
  ]) {
    const p = structuredClone(f.request)
    mutate(p)
    assert.throws(() => f.mining.preview([p]), /Leaf-litter/)
    assert.throws(() => f.mining.start([p]), /Leaf-litter/)
  }
  assert.deepEqual(f.actions, [])
})

test('a measured leaf-litter state and held shulker pass, changed facts and protected cells do not', t => {
  const f = setup(t)
  assert.equal(f.mining.preview([f.request]).ready, true)
  const original = structuredClone(f.block)
  for (const delta of [
    { properties: { ...original.properties, growth: 1 } },
    { properties: { ...original.properties, 'minecraft:cardinal_direction': 'west' } },
    { properties: undefined }, { known: false }, { protected: true }, { protectionSource: 'bot_base' }
  ]) {
    f.blocks.set(f.id(f.target), { ...original, ...delta })
    assert.equal(f.mining.preview([f.request]).ready, false)
    assert.throws(() => f.mining.start([f.request]))
  }
  f.blocks.set(f.id(f.target), original)
  for (const name of ['diamond_pickaxe', 'diamond_shovel', 'diamond_sword', 'shears']) {
    f.state.heldItem = { ...f.state.heldItem, name: 'minecraft:' + name }
    assert.equal(f.mining.preview([f.request]).ready, false)
    assert.throws(() => f.mining.start([f.request]))
  }
  assert.deepEqual(f.actions, [])
})

test('a live property change at the same name and runtime stops an active break', async t => {
  const f = setup(t)
  f.mining.start([f.request])
  f.block.properties.growth = 1
  await f.notify()
  const status = f.mining.snapshot()
  assert.equal(status.phase, 'failed')
  assert.match(status.reason, /Leaf-litter received properties/)
  assert.equal(status.completed.length, 0)
  assert.deepEqual(f.actions.map(action => action[0]), ['start_break'])
})

test('the active break owns a copy of properties and completes only once the block is received as air', async t => {
  const f = setup(t)
  const original = structuredClone(f.request.expectedProperties)
  f.mining.start([f.request])
  f.request.expectedProperties.growth = 3
  f.request.expectedProperties['minecraft:cardinal_direction'] = 'south'
  await f.notify()
  const waiting = f.mining.snapshot()
  assert.equal(waiting.phase, 'mining')
  assert.deepEqual(waiting.activeTarget.expectedProperties, original)
  assert.deepEqual(waiting.completed, [])
  const air = boxEvidence.runs[0].blocks.find(b => b.name === 'air')
  f.set(f.target, air.name, air.id)
  await f.notify()
  const result = f.mining.snapshot()
  assert.equal(result.phase, 'completed')
  assert.equal(result.completed.length, 1)
  assert.deepEqual(result.completed[0].expectedProperties, original)
  assert.deepEqual(f.actions.map(action => action[0]), ['start_break'])
})
