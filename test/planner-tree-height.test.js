'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const original = path.resolve(__dirname, '../src/planner.js')
const loaded = new Module(original, module)
loaded.filename = original
loaded.paths = Module._nodeModulePaths(path.dirname(original))
loaded._compile(fs.readFileSync(process.env.PLANNER_TEST_SOURCE ?? original, 'utf8'), original)
const { nextBootstrapAction } = loaded.exports
const { createMining } = require('../src/mining')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')

function fixture ({ otherTree = true, stairs = false } = {}) {
  const blocks = new Map()
  const key = p => `${p.x},${p.y},${p.z}`
  const put = (x, y, z, name, extra = {}) => blocks.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, position: { x, y, z }, boundingBox: name === 'air' ? 'empty' : 'block', extra: [], properties: {}, runtimeId: name === 'air' ? 0 : 1, ...extra })
  for (let x = -4; x <= 15; x++) for (let y = -1; y <= 12; y++) for (let z = -4; z <= 4; z++) put(x, y, z, y <= 0 ? 'stone' : 'air')
  put(1, 2, 0, 'stone') // FeetY3, isolated two-block rise from the actual ground.
  put(2, 7, 0, 'oak_log'); put(2, 8, 0, 'oak_log'); put(2, 9, 0, 'oak_leaves')
  if (otherTree) { put(12, 1, 0, 'birch_log'); put(12, 2, 0, 'birch_log'); put(12, 3, 0, 'birch_leaves') }
  if (stairs) { put(0, 1, 1, 'stone'); put(1, 1, 1, 'stone'); put(1, 2, 1, 'stone') }
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 2.62, z: 0.5 }, positionSource: 'start_game', inventory: { known: true, items: [] }, capabilities: { mining: true, movement: true, scan_blocks: true }, world: { initialized: true, loadedSections: 1 } }
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } } }
  const next = () => nextBootstrapAction(state, { blocks: [...blocks.values()], radius: 14, worldLoaded: true })
  const mining = createMining({ getState: () => state, world, getInput: () => ({}) })
  return { blocks, put, key, state, world, next, mining }
}

test('an unreachable high crown does not lure the bot onto an isolated elevated platform', () => {
  const f = fixture()
  assert.equal(f.mining.preview([{ x: 2, y: 7, z: 0 }]).ready, false, 'the current hand cannot reach that crown')
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.equal(action.block, 'minecraft:birch_log')
  assert.equal(action.resourceTarget.x, 12)
  assert.equal(action.target.y, 1)
})

test('only an unreachable high crown requests another observation instead of pacing below it', () => {
  const action = fixture({ otherTree: false }).next()
  assert.equal(action.type, 'scan_blocks')
  assert.equal(action.resource, 'logs')
})

test('known one-block stairs still allow an elevated tree and the Native route reaches its stance', () => {
  const f = fixture({ otherTree: false, stairs: true })
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.equal(action.resourceTarget.y, 7)
  assert.equal(action.target.y, 3)
  const physics = createPhysics({ world: f.world, version: '1.26.60' })
  const navigator = createNavigator({ world: f.world, physics, version: '1.26.60' })
  const origin = physics.fromServer(f.state)
  const route = navigator.plan(origin, action.target, { maxDistance: 8, maxExpanded: 1000 })
  assert.equal(route.ready, true, JSON.stringify(route))
  const stepper = navigator.createStepper(route, origin, { maxTicks: 160, sprint: false })
  let frame
  for (let i = 0; i <= 160; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', JSON.stringify({ phase: frame.phase, reason: frame.reason }))
  assert.equal(frame.predictedState.position.y, action.target.y)
  assert.equal(frame.serverConfirmed, false)
})

test('unknown stairs and a low jump ceiling never justify the high mining stance', () => {
  for (const mutate of [
    f => f.put(0, 1, 1, 'stone', { known: false }),
    f => { for (const [x, z] of [[-1, 1], [0, 0], [0, 2]]) f.put(x, 3, z, 'stone') },
    f => f.put(0, 3, 1, 'stone')
  ].entries()) {
    const [index, change] = mutate
    const f = fixture({ otherTree: false, stairs: true }); change(f)
    assert.equal(f.next().type, 'scan_blocks', `blocked case ${index}`)
  }
})

test('a higher log within real mining reach remains harvestable from the present ground', () => {
  const f = fixture({ otherTree: false })
  f.put(2, 7, 0, 'air'); f.put(2, 8, 0, 'air'); f.put(2, 9, 0, 'air')
  f.put(2, 4, 0, 'oak_log'); f.put(2, 5, 0, 'oak_log'); f.put(2, 6, 0, 'oak_leaves')
  f.put(1, 2, 0, 'air')
  const action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.target.y, 4)
  assert.equal(f.mining.preview([action.target]).ready, true)
})
