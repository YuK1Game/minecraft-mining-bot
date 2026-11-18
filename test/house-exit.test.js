'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { leaveHouse, inside } = require('../src/modes/house/house-exit')
const { doorOf } = require('../src/modes/house/house-door')

const origin = { x: -4901, y: 76, z: -4994 }

// Floor at origin.y, walls around a 7x7 footprint with the blueprint's door gap.
function world () {
  const door = doorOf(origin)
  return (x, y, z) => {
    if (y < origin.y + 1) return { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
    if (door && x === door.x && z === door.z && (y === door.y || y === door.y + 1)) return { known: true, name: 'minecraft:wooden_door', boundingBox: 'block', properties: { open_bit: true } }
    const wall = (x === origin.x || x === origin.x + 6 || z === origin.z || z === origin.z + 6) && x >= origin.x && x <= origin.x + 6 && z >= origin.z && z <= origin.z + 6
    if (wall && y <= origin.y + 3) return { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}

test('inside the house, a long trip first walks out through the door (live 2026-11-17 21:52 JST)', async () => {
  let feet = { x: origin.x + 1.5, y: origin.y + 2, z: origin.z + 4.5 }
  const walks = [], logs = []
  let opened = 0
  const out = await leaveHouse({ house: { origin }, getFeet: () => feet, getBlock: world(), walk: async target => { walks.push(target); feet = { ...target } ; return true }, door: async () => { opened++; return true }, log: line => logs.push(line) })
  assert.equal(out, true)
  assert.equal(opened, 1)
  assert.equal(walks.length, 2)
  assert.equal(inside(origin, walks[0]), true, 'first the stand inside the door')
  assert.equal(inside(origin, walks[1]), false, 'then the stand outside it')
  assert.ok(logs.some(line => /外へ出ました/.test(line)))
})

test('outside the house, or with no house, nothing is walked', async () => {
  const walk = async () => assert.fail('no walk')
  assert.equal(await leaveHouse({ house: { origin }, getFeet: () => ({ x: origin.x + 3.5, y: origin.y + 1, z: origin.z + 12 }), getBlock: world(), walk }), false)
  assert.equal(await leaveHouse({ house: null, getFeet: () => ({ x: 0, y: 0, z: 0 }), getBlock: world(), walk }), false)
})

// Real Realm 2026-11-19 02:36-02:44 JST: a creeper blast had taken the door and the floor under it.
// The walk over the gap was refused twice and the trip from under the roof found no relay for eight minutes.
function blasted () {
  const door = doorOf(origin), base = world()
  return (x, y, z) => {
    if (x === door.x && z === door.z && y >= origin.y && y <= door.y + 1) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return base(x, y, z)
  }
}

test('a door walk that fails hands over to the route that digs, stacks and bridges', async () => {
  const door = doorOf(origin)
  let feet = { x: door.x + 0.5, y: door.y, z: door.z - 0.5 }
  const logs = [], asked = []
  const out = await leaveHouse({
    house: { origin }, getFeet: () => feet, getBlock: blasted(), walk: async () => false, why: () => 'NO_ROUTE', log: line => logs.push(line),
    build: async (target, done) => { asked.push(target); assert.equal(done({ x: door.x, y: door.y, z: door.z - 1 }), false); assert.equal(done({ x: door.x, y: door.y, z: door.z + 1 }), true); assert.equal(done({ x: door.x, y: origin.y - 3, z: door.z + 1 }), false, 'not out through the floor'); feet = { x: door.x + 0.5, y: door.y, z: door.z + 1.5 }; return { ok: true } }
  })
  assert.equal(out, true)
  assert.equal(asked.length, 1)
  assert.equal(inside(origin, asked[0]), false)
})

test('the refusal is in the log when neither way leads out', async () => {
  const door = doorOf(origin), logs = []
  const feet = { x: door.x + 0.5, y: door.y, z: door.z - 0.5 }
  const out = await leaveHouse({ house: { origin }, getFeet: () => feet, getBlock: blasted(), walk: async () => false, why: () => 'NO_ROUTE', build: async () => ({ ok: false, code: 'NO_BUILD_ROUTE' }), log: line => logs.push(line) })
  assert.equal(out, false)
  assert.ok(logs.some(line => /出られませんでした（NO_ROUTE、掘る・積む道 NO_BUILD_ROUTE）/.test(line)), logs.join('|'))
})

test('the real plan bridges the blasted doorway with one carried block', async () => {
  const { planBuildRouteAsync } = require('../src/movement/build-route')
  const door = doorOf(origin), base = blasted()
  // Under the missing floor: a two-deep pit, so no step down and up leads across.
  const getBlock = (x, y, z) => x === door.x && z === door.z && y >= origin.y - 2 && y < origin.y ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : base(x, y, z)
  const start = { x: door.x, y: door.y, z: door.z - 1 }, target = { x: door.x, y: door.y, z: door.z + 2 }
  const done = cell => !inside(origin, cell) && cell.y >= origin.y
  const plain = await planBuildRouteAsync({ getBlock, start, target, done, blocks: 0 })
  const bridged = await planBuildRouteAsync({ getBlock, start, target, done, blocks: 4, allowBridge: true })
  assert.equal(bridged.ok, true, JSON.stringify({ plain: plain.code, bridged: bridged.code }))
})
