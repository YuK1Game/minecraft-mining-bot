'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planBuildRoute, planBuildRouteAsync } = require('../src/movement/build-route')
const { buildWalk } = require('../src/modes/player-build-walk')

// The shortcut spends the only floor block before a second gap. The longer
// U-shaped walk keeps that block for the final gap: both paths meet at (2,1,0).
function scene () {
  const floors = new Set(['0,0', '2,0', '4,0'])
  for (let z = 1; z <= 5; z++) { floors.add(`0,${z}`); floors.add(`2,${z}`) }
  floors.add('1,5')
  const getBlock = (x, y, z) => ({ known: true, name: y === 0 && floors.has(`${x},${z}`) ? 'minecraft:bedrock' : 'minecraft:air', boundingBox: y === 0 && floors.has(`${x},${z}`) ? 'block' : 'empty' })
  const start = { x: 0, y: 1, z: 0 }, target = { x: 4, y: 1, z: 0 }, done = n => n.x === 4 && n.y === 1 && n.z === 0
  const options = { getBlock, start, target, done, blocks: 1, allowBridge: true, pad: 6, rise: 0, maxNodes: 10000 }
  return { floors, getBlock, start, target, done, options }
}

test('the route preserves a dearer label that reaches the same cell with its last floor block intact', async () => {
  const f = scene()
  for (const plan of [planBuildRoute, planBuildRouteAsync]) {
    const route = await plan(f.options)
    assert.equal(route.ok, true, route.code)
    assert.equal(route.steps.length, 14)
    assert.equal(route.cost, 19)
    assert.equal(route.bridge, 1)
    assert.deepEqual(route.steps.filter(s => s.kind === 'bridge').map(s => s.place), [{ x: 3, y: 0, z: 0 }])
    assert.equal(route.stack, 0)
    let previous = f.start
    for (const step of route.steps) {
      assert.equal(Math.abs(step.to.x - previous.x) + Math.abs(step.to.z - previous.z), 1, 'reconstruction keeps the exact predecessor label')
      previous = step.to
    }
  }
  assert.equal(planBuildRoute({ ...f.options, blocks: 0 }).ok, false, 'no route invents the missing floor block')
})

test('the complete walk takes the detour and uses the received last block only at the final gap', async () => {
  const f = scene(), feet = { x: 0.5, y: 1, z: 0.5 }, placed = []
  let blocks = 1
  const ports = {
    feet: () => ({ ...feet }), block: f.getBlock, fill: () => blocks,
    walk: async target => {
      const from = { x: Math.floor(feet.x), z: Math.floor(feet.z) }, to = { x: Math.floor(target.x), z: Math.floor(target.z) }
      if (from.x !== to.x && from.z !== to.z || target.y !== 1) return false
      const distance = Math.abs(to.x - from.x) + Math.abs(to.z - from.z)
      if (distance > 4) return false
      for (let i = 1; i <= distance; i++) if (!f.floors.has(`${from.x + Math.sign(to.x - from.x) * i},${from.z + Math.sign(to.z - from.z) * i}`)) return false
      Object.assign(feet, target); return true
    },
    bridge: async cell => { assert.ok(blocks > 0); blocks--; f.floors.add(`${cell.x},${cell.z}`); placed.push(cell); return true }
  }
  const result = await buildWalk({ ports, target: f.target, done: f.done, limits: { pad: 6, rise: 0 } })
  assert.equal(result.ok, true, result.code)
  assert.deepEqual(placed, [{ x: 3, y: 0, z: 0 }])
  assert.equal(blocks, 0)
  assert.equal(f.done({ x: Math.floor(feet.x), y: feet.y, z: Math.floor(feet.z) }), true)
})

test('a cancelled async build search never reads or plans terrain', async () => {
  const f = scene(), controller = new AbortController(); controller.abort()
  const route = await planBuildRouteAsync({ ...f.options, signal: controller.signal, getBlock: () => { assert.fail('cancelled search read terrain') } })
  assert.equal(route.code, 'BUILD_ROUTE_CANCELLED')
  assert.equal(route.ok, false)
})
