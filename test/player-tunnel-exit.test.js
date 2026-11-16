'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { walkOut, wayUp, recordedFloors } = require('../src/modes/player-tunnel-exit')

// A stair dug down to the east: floor n is at (n, 60 - n, 0), two clear cells over each.
function stair (length, { blocked = null } = {}) {
  const floors = []
  for (let n = 0; n < length; n++) floors.push({ x: n, y: 60 - n, z: 0 })
  const block = (x, y, z) => {
    if (blocked && blocked.x === x && blocked.y === y && blocked.z === z) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    const floor = floors.find(point => point.x === x && point.z === z)
    if (floor && (y === floor.y + 1 || y === floor.y + 2)) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  }
  return { floors, block }
}

test('the way goes from the floor under the feet to the highest connected floor', () => {
  const { floors, block } = stair(10)
  const plan = wayUp({ floors, block, feet: { x: 9.5, y: 52, z: 0.5 } })
  assert.equal(plan.ready, true)
  assert.equal(plan.rise, 9)
  assert.deepEqual(plan.path[0], { x: 9, y: 52, z: 0 })
  assert.deepEqual(plan.path.at(-1), { x: 0, y: 61, z: 0 })
  assert.equal(plan.path.length, 10)
})

test('no way is planned off the recorded floors, past a blocked floor, or without floors', () => {
  const { floors, block } = stair(10)
  assert.equal(wayUp({ floors, block, feet: { x: 30.5, y: 40, z: 5.5 } }).reason, 'NOT_ON_A_RECORDED_FLOOR')
  assert.equal(wayUp({ floors: [], block, feet: { x: 9.5, y: 52, z: 0.5 } }).reason, 'NO_FLOORS')
  // The stair is filled three floors up: only a rise of two is left.
  const filled = stair(10, { blocked: { x: 6, y: 55, z: 0 } })
  const plan = wayUp({ floors: filled.floors, block: filled.block, feet: { x: 9.5, y: 52, z: 0.5 } })
  assert.equal(plan.ready, false)
  assert.equal(plan.reason, 'NO_WAY_UP_RECORDED')
  assert.equal(plan.rise, 2)
  // Unreceived cells are not a way.
  assert.equal(wayUp({ floors, block: () => ({ known: false }), feet: { x: 9.5, y: 52, z: 0.5 } }).reason, 'NOT_ON_A_RECORDED_FLOOR')
})

test('the tunnel is walked a few floors at a time and reports the climb', async () => {
  const { floors, block } = stair(12)
  let feet = { x: 11.5, y: 50, z: 0.5 }
  const walks = [], lines = []
  const ports = { feet: () => feet, block, walk: async target => { walks.push(target); feet = { ...target }; return true } }
  const result = await walkOut({ ports, floors, log: text => lines.push(text) })
  assert.deepEqual(result, { ok: true, walked: 11, rose: 11 })
  assert.equal(walks.length, 3)
  assert.deepEqual(walks.at(-1), { x: 0.5, y: 61, z: 0.5 })
  assert.match(lines[0], /掘った坑道を歩いて戻ります（11マス、上へ11段）/)
  assert.match(lines.at(-1), /坑道を11マス戻りました/)
})

test('a failed stretch is retried one floor at a time, and a dead stretch says where', async () => {
  const { floors, block } = stair(12)
  let feet = { x: 11.5, y: 50, z: 0.5 }
  const lines = []
  // Only single floors can be walked, and nothing past x = 8.
  const ports = {
    feet: () => feet, block, why: () => 'NO_ROUTE',
    walk: async target => { if (Math.abs(target.x - feet.x) <= 1 && target.x >= 8) feet = { ...target }; return true }
  }
  const result = await walkOut({ ports, floors, log: text => lines.push(text) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'WALK_FAILED')
  assert.equal(result.walked, 3)
  assert.equal(result.rose, 3)
  assert.match(lines.at(-1), /坑道を戻る途中で歩けなくなりました（3\/11マス、次の床 7,53,0、NO_ROUTE）/)
})

test('it stops under the open sky, stops when interrupted, and logs why there is no way', async () => {
  const { floors, block } = stair(12)
  let feet = { x: 11.5, y: 50, z: 0.5 }
  const ports = { feet: () => feet, block, walk: async target => { feet = { ...target }; return true } }
  const open = await walkOut({ ports, floors, open: () => feet.y >= 55 })
  assert.equal(open.ok, true)
  assert.equal(open.walked, 5)
  feet = { x: 11.5, y: 50, z: 0.5 }
  assert.equal((await walkOut({ ports, floors, aborted: () => true })).reason, 'INTERRUPTED')
  const lines = []
  feet = { x: 40.5, y: 50, z: 0.5 }
  assert.equal((await walkOut({ ports, floors, log: text => lines.push(text) })).reason, 'NOT_ON_A_RECORDED_FLOOR')
  assert.match(lines[0], /掘った坑道を歩いて戻る道がありません（NOT_ON_A_RECORDED_FLOOR、記録した床 12・使える床 12/)
})

test('the recorded floors are read for the current world only', () => {
  const state = { profile: 'bot', realm: { id: 7 }, dimension: 'overworld' }
  const shared = { tunnelFloors: { version: 1, scopes: { [JSON.stringify(['bot', '7', 'overworld'])]: { floors: [{ x: 1, y: 2, z: 3 }, { x: 1.5, y: 2, z: 3 }, null] }, [JSON.stringify(['bot', '7', 'nether'])]: { floors: [{ x: 9, y: 9, z: 9 }] } } } }
  assert.deepEqual(recordedFloors(shared, state), [{ x: 1, y: 2, z: 3 }])
  assert.deepEqual(recordedFloors({}, state), [])
  assert.deepEqual(recordedFloors(shared, { ...state, dimension: 'end' }), [])
})
