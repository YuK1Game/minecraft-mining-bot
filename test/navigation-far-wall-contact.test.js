'use strict'

// Live 2026-11-15 19:08-20:00 JST: the Bot stood in a corner at
// (4952.2998046875, 74, 5007.2998046875). That is 4952.3 as float32, which
// overlaps both walls by 0.0002, more than the micron skin, so no move could
// be planned ("The current footprint has no known safe support").
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')
const { createPhysics } = require('../src/movement/physics')
const capture = require('./fixtures/navigation-origin203.json')

function scene (cornerX, cornerZ) {
  const solid = (x, y, z) => y <= 63 || (x < cornerX || z < cornerZ) && y <= 67
  const world = { getBlock: (x, y, z) => { const full = solid(x, y, z); return { known: true, position: { x, y, z }, name: full ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: full ? 'block' : 'empty', hardness: full ? 1.5 : -1, diggable: full, extra: [] } } }
  const physics = createPhysics({ world }).withWorld(world)
  const navigator = createNavigator({ world, physics })
  const at = (x, z) => {
    const state = structuredClone(capture.state), position = { x, y: 65.62, z }
    Object.assign(state, { position, rawServerPosition: position, positionSource: 'server' }); delete state.predicted
    return physics.fromServer(state)
  }
  return { navigator, at }
}

test('far from the world origin, a float32 wall contact is still a place to start from', () => {
  const s = scene(4952, 5007), x = Math.fround(4952.3), z = Math.fround(5007.3)
  assert.ok(4952.3 - x > 1e-4)
  const origin = s.at(x, z), route = s.navigator.plan(origin, { x: 4955.5, y: 64, z: 5009.5 }, {})
  assert.equal(route.ready, true, route.reason)
  const stepper = s.navigator.createStepper(route, origin, { maxTicks: 300, sprint: false })
  let frame, ticks = 0
  do { frame = stepper.next(); ticks++ } while (frame.phase === 'moving' && ticks < 300)
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.ok(Math.hypot(frame.predictedState.position.x - 4955.5, frame.predictedState.position.z - 5009.5) < 0.3)
})

test('a body inside the wall by more than one float32 step is still refused, far and near', () => {
  const far = scene(4952, 5007)
  assert.equal(far.navigator.plan(far.at(4952.29, 5007.5), { x: 4955.5, y: 64, z: 5009.5 }, {}).ready, false)
  const near = scene(10, 10)
  assert.equal(near.navigator.plan(near.at(10.2998, 10.5), { x: 13.5, y: 64, z: 12.5 }, {}).ready, false)
  assert.equal(near.navigator.plan(near.at(10.3, 10.3), { x: 13.5, y: 64, z: 12.5 }, {}).ready, true)
})
