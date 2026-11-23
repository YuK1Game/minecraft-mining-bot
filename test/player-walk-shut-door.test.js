'use strict'

// A walk whose way passes a closed door clicks it open first (src/modes/door-on-way.js, the hands' `walk` in
// player-scaffold-ports.js).
// Real Realm 2026-11-24 01:34:04-01:49:27 JST, house (9877,64,10138), door (9880, 65..66, 10144): the repair put
// the door back at 01:34 (received: wooden_door, open_bit 0). From the entry step, feet (9880.499, 65.000, 10145.300),
//   採掘場の資材を準備しています（WALK_SHORT:Server correction replayed through sent input; replan from the corrected present predictio）
// the mine's supply walk to (9881.5, 65, 10143.5) was planned through the door cell (waypoints (9880.5,65,10144.5) →
// (9880.5,65,10143.5) → (9881.5,65,10143.5)); the predicted feet went 0.25-0.83 north and the server put them back to
// z 10145.300 every time. No line of a door click; the goal early.home_reserve#4 warned at 5, 10 and 15 minutes.
// Blocks: test/fixtures/house-moat.json (the PC, 2026-11-23 16:20 JST), the door closed as received at 01:49.
// Real: the hands, the navigation and its physics (the door passed by its received shape), the door reading.
// Stand-in: the server (test/helpers/dig-world.js: no body enters a closed door, a click within reach opens it).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDigWorld } = require('./helpers/dig-world')
const { shutDoorOnWay } = require('../src/modes/door-on-way')
const received = require('./fixtures/house-moat.json')

const DOOR = { x: 9880, y: 65, z: 10144 }, STEP = { x: 9880.499, y: 65, z: 10145.3 }, INSIDE = { x: 9881.5, y: 65, z: 10143.5 }
const key = cell => `${cell.x},${cell.y},${cell.z}`

function scene ({ door = 0, click = true } = {}) {
  const states = { ...received.states, [key(DOOR)]: { ...received.states[key(DOOR)], open_bit: door, upper_block_bit: 0 } }
  const w = createDigWorld({ ...received, states, feet: STEP }, { outside: () => null, items: [{ slot: 0, name: 'minecraft:wooden_door', count: 2 }] })
  if (!click) delete w.ctx.operations.interactions.useDoor
  return w
}

test('01:49 JST: without the click the walk from the entry step ends short at the closed door, the feet where they were', async () => {
  const w = scene({ click: false })
  assert.equal(await w.ctx.hands.walk(INSIDE), false)
  assert.match(w.ctx.hands.why(), /^WALK_SHORT:Server correction replayed/)
  assert.deepEqual(w.cell(), { x: 9880, y: 65, z: 10145 })
  assert.ok(w.corrections >= 1)
})

test('the closed door on the way is clicked open, then the walk goes in', async () => {
  const w = scene()
  assert.deepEqual(shutDoorOnWay(w.getBlock, STEP, INSIDE), DOOR)
  assert.equal(await w.ctx.hands.walk(INSIDE), true, w.ctx.hands.why())
  assert.deepEqual(w.clicks, [DOOR])
  assert.equal(w.corrections, 0, 'no walk is sent into the closed door')
  assert.deepEqual(w.cell(), { x: 9881, y: 65, z: 10143 })
  assert.equal(w.lines.filter(line => /歩く道の閉じたドア \(9880, 65, 10144\) を開けました/.test(line)).length, 1)
})

test('an open door, a door behind the walk and a door off the way are left alone', async () => {
  const open = scene({ door: 1 })
  assert.equal(shutDoorOnWay(open.getBlock, STEP, INSIDE), null)
  assert.equal(await open.ctx.hands.walk(INSIDE), true)
  assert.deepEqual(open.clicks, [])
  const shut = scene()
  assert.equal(shutDoorOnWay(shut.getBlock, STEP, { x: 9880.5, y: 65, z: 10147.5 }), null, 'walking away from the door')
  assert.equal(shutDoorOnWay(shut.getBlock, STEP, { x: 9879.5, y: 65, z: 10145.5 }), null, 'along the step, beside the door')
  assert.equal(shutDoorOnWay(shut.getBlock, { x: 9880.5, y: 65, z: 10149.5 }, INSIDE), null, 'farther than two cells')
  assert.equal(shutDoorOnWay(shut.getBlock, null, INSIDE), null)
})
