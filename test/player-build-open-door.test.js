'use strict'

// The route that digs and stacks walks through a door that stands open (src/movement/build-route.js, door-cell.js).
// Real Realm 2026-11-23 16:14:03-16:14:32 JST, the return to the base chest (9880, 65, 10139) in the starter house
// (origin 9877,64,10138): the ground round the house was dug away on every side (the door step, three cobblestones
// at y 64, stands over pits two to nine deep). From the pit two cells north of the wall
//   掘る・積む道もありません（BUILD_ROUTE_SEARCH_LIMIT・調べたマス 24000） six times,
//   チェストへ接近に失敗: CHEST_UNREACHED CONTAINER_NOT_VISIBLE / CONTAINER_NOT_IN_REACH three times each,
//   帰還[rmwswb7fg] を保留します: 試行または時間の予算を使い切りました（RETURN_ATTEMPTS_EXHAUSTED…）
// The door (9880, 65..66, 10144) stood open (lower half open_bit 1); the search read it as a wall.
// Blocks: test/fixtures/house-moat.json, as the PC received them at 16:20-16:23 JST (y 55..68, every cell known).
// Real: the route search, the walk that carries it out (player-build-walk.js with the house protection), the
// scaffold's hands, the navigation and its physics (the door passed by its received shape), the open click's own
// check of where the chest opens from (actions/open-face.js).
// Stand-in: the server (test/helpers/dig-world.js: it agrees with every predicted step, answers the placement and
// the pillar step). Its success is not the game's.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDigWorld } = require('./helpers/dig-world')
const { createBuildWalk, createMemo } = require('../src/modes/player-build-walk')
const { planBuildRoute } = require('../src/movement/build-route')
const { openDoorCell } = require('../src/movement/door-cell')
const { openAccess } = require('../src/actions/open-face')
const received = require('./fixtures/house-moat.json')

const CHEST = { x: 9880, y: 65, z: 10139 }, DOOR = { x: 9880, y: 65, z: 10144 }
const PIT = { x: 9879.5, y: 63, z: 10136.5 } // the cell of the hold (9879, 64, 10136) at eye height
const origin = received.house.origin
const inHouse = cell => cell.x >= origin.x && cell.x <= origin.x + 6 && cell.z >= origin.z && cell.z <= origin.z + 6 && cell.y >= origin.y && cell.y <= origin.y + 4

function scene ({ door = 1 } = {}) {
  const states = { ...received.states, [`${DOOR.x},${DOOR.y},${DOOR.z}`]: { ...received.states[`${DOOR.x},${DOOR.y},${DOOR.z}`], open_bit: door } }
  const w = createDigWorld({ ...received, states, feet: PIT }, { outside: () => null, items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 40 }, { slot: 1, name: 'minecraft:dirt', count: 7 }, { slot: 2, name: 'minecraft:cobblestone', count: 28 }] })
  const read = pos => w.getBlock(pos.x, pos.y, pos.z)
  // As the return's approach asks (return-steps.js `beside`): a cell the open click reaches the chest from.
  w.opens = cell => !openAccess(read, { x: cell.x + 0.5, y: cell.y + 1.62, z: cell.z + 0.5 }, CHEST)
  w.log = []
  w.build = createBuildWalk({ hands: w.ctx.hands, getHouse: () => ({ origin, done: true }), log: line => w.log.push(line), memo: createMemo() })
  return w
}

test('16:14 JST: from the pit north of the wall the route goes round the house, in through the open door and ends where the chest opens', async () => {
  const w = scene()
  assert.deepEqual(w.cell(), { x: 9879, y: 63, z: 10136 })
  assert.equal(w.opens(w.cell()), false, 'the chest does not open from the pit')
  const out = await w.build(CHEST, { done: w.opens })
  assert.equal(out.ok, true, `${JSON.stringify(out)} ${w.log.join(' / ')}`)
  const at = w.cell()
  assert.ok(inHouse(at) && at.y === 65, `inside the house on its floor: ${JSON.stringify(at)}`)
  assert.equal(w.opens(at), true, 'the open click reaches the chest from the last cell')
  assert.equal(w.getBlock(DOOR.x, DOOR.y, DOOR.z).name, 'minecraft:wooden_door', 'the door stands')
  assert.equal(w.minedNames.some(name => /door|planks|log|slab|glass|cobblestone|chest|bed|furnace|crafting/.test(name)), false, `nothing of the house is mined: ${w.minedNames.join(',')}`)
  assert.equal(w.placed.some(inHouse), false, 'nothing is placed in the house')
  assert.equal(w.log.some(line => /掘る・積む道もありません/.test(line)), false, w.log.join(' / '))
})

test('the same route with the door closed: no way in, the answer at once, nothing dug and nothing placed', async () => {
  const w = scene({ door: 0 })
  const out = await w.build(CHEST, { done: w.opens })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_BUILD_ROUTE')
  assert.deepEqual(w.cell(), { x: 9879, y: 63, z: 10136 })
  assert.deepEqual(w.minedNames, [])
  assert.deepEqual(w.placed, [])
})

test('the plan passes the door cell on foot and never mines a door, a wall or the floor of the house', () => {
  const w = scene()
  const overlay = require('../src/safety/house-protection').createHouseProtection(() => ({ origin, done: true }))
  const getBlock = (x, y, z) => overlay(w.getBlock(x, y, z), x, y, z)
  const route = planBuildRoute({ getBlock, start: { x: 9879, y: 63, z: 10136 }, target: CHEST, done: w.opens, blocks: 35, allowBridge: true, allowDrop: true })
  assert.equal(route.ok, true, route.code)
  const through = route.steps.find(step => step.to.x === DOOR.x && step.to.y === DOOR.y && step.to.z === DOOR.z)
  assert.ok(through, 'a step stands in the door cell')
  assert.equal(through.kind, 'walk')
  assert.deepEqual(through.dig, [])
  assert.equal(route.steps.some(step => step.dig.some(inHouse)), false, 'no block of the house is in a step')
  assert.equal(route.steps.some(step => step.to.x === DOOR.x && step.to.z === DOOR.z && step.to.y > DOOR.y), false, 'no step stands on the door')
})

test('a door stands open by the received open_bit of its lower half; trapdoors, iron doors and unreceived halves do not', () => {
  const world = cells => (x, y, z) => cells[`${x},${y},${z}`] ?? { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const door = (properties, name = 'minecraft:wooden_door') => ({ known: true, name, boundingBox: 'block', properties })
  // As received at the house: the lower half open, the upper half's own bit still 0.
  const open = world({ '0,1,0': door({ open_bit: 1, upper_block_bit: 0 }), '0,2,0': door({ open_bit: 0, upper_block_bit: 1 }) })
  assert.equal(openDoorCell(open, 0, 1, 0), true)
  assert.equal(openDoorCell(open, 0, 2, 0), true, 'the upper half follows the lower one')
  const closed = world({ '0,1,0': door({ open_bit: 0, upper_block_bit: 0 }), '0,2,0': door({ open_bit: 1, upper_block_bit: 1 }) })
  assert.equal(openDoorCell(closed, 0, 1, 0), false)
  assert.equal(openDoorCell(closed, 0, 2, 0), false, 'the upper half\'s own bit says nothing')
  const half = world({ '0,1,0': { known: false }, '0,2,0': door({ open_bit: 1, upper_block_bit: 1 }) })
  assert.equal(openDoorCell(half, 0, 2, 0), false, 'an unreceived lower half is not an open door')
  assert.equal(openDoorCell(world({ '0,1,0': door({ open_bit: 1 }, 'minecraft:oak_trapdoor') }), 0, 1, 0), false)
  assert.equal(openDoorCell(world({ '0,1,0': door({ open_bit: 1, upper_block_bit: 0 }, 'minecraft:iron_door') }), 0, 1, 0), false)
  assert.equal(openDoorCell(open, 5, 1, 5), false, 'air is not a door')
})
