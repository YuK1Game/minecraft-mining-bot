'use strict'

// The gathering does not take the ground the house stands in (src/safety/house-protection.js `inYard`; read by
// dragon-supply-gather.js `unavailableAt`, which the candidates, the "in view" count and the uncovering all use).
// Real Realm 2026-11-23, starter house (origin 9877,64,10138), cobblestone for the mine's supplies:
//   11:50:25 「採掘場の資材を準備しています（cobblestone 0/88）」 … 12:02:59 「cobblestone 63/64」, with 97 lines
//   「stone (x, 53..60, z) を掘れなかったため…」 at x 9873..9893, z 10127..10158;
//   16:15:18 「cobblestone 26/88」 … 16:18:03 「cobblestone 87/88」, with 81 such lines at x 9876..9891, z 10123..10134.
// The gathering takes the nearest stone with an open side. Its own protection was the blueprint's box (x -1..+10,
// z -1..+10, y -1..+5 of the origin): the stone under the house and beside its walls was outside it. At 16:20 the
// house stood on an island: pits to y 57 north of the wall (x 9879..9884, z 10132..10138), and south and south-east;
// the return to the base chest found no way in (16:14 RETURN_ATTEMPTS_EXHAUSTED) and the Bot was without its kit.
// Blocks: test/fixtures/house-moat.json, as the PC received them at 16:20-16:23 JST (y 55..68). Outside that box the
// test puts plain ground (stone below y 63, air above): a stand-in, not a reading.
// Real: `collect` and its candidates, the stone stand's walk, the scaffold's hands, the navigation and its physics.
// Stand-in: the server (test/helpers/dig-world.js). Its success is not the game's.
// Before (main b992a84): from the pit north of the wall 222 of the 410 stones in view are within eight cells of
// the walls; the first block taken is the ground two cells from the wall (9880, 61, 10136), and the refusals
// name the cells of the live log (「stone (9881, 59, 10134) を掘れなかったため…」).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { collect, inView } = require('../src/modes/dragon-supply-gather')
const { inYard, YARD } = require('../src/safety/house-protection')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/house-moat.json')

const origin = received.house.origin
const PIT = { x: 9879.5, y: 63, z: 10136.5 }
const fromWalls = cell => Math.max(origin.x - cell.x, cell.x - (origin.x + 6), origin.z - cell.z, cell.z - (origin.z + 6), 0)

function scene (feet = PIT) {
  const w = createDigWorld({ ...received, feet }, { outside: (x, y) => y < 63 ? 'stone' : 'air', items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 120 }] })
  w.ctx.shared.playerHouse = { origin, done: true }
  w.taken = []
  const mine = w.ctx.hands.mine
  w.ctx.hands.mine = async target => { const done = await mine(target); if (done) w.taken.push({ x: target.x, y: target.y, z: target.z }); return done }
  return w
}

test('the yard is the ground within eight cells of the walls, from twelve below the floor up; trees and what is above are not in it', () => {
  assert.equal(YARD.around, 8)
  const stone = { name: 'minecraft:stone' }, log = { name: 'minecraft:oak_log' }
  assert.equal(inYard(origin, { x: 9881, y: 58, z: 10133 }, stone), true, 'the pit north of the wall')
  assert.equal(inYard(origin, { x: 9880, y: 62, z: 10141 }, stone), true, 'under the floor')
  assert.equal(inYard(origin, { x: origin.x - 8, y: 60, z: origin.z + 14 }, stone), true, 'the corner of the yard')
  assert.equal(inYard(origin, { x: origin.x - 9, y: 60, z: origin.z }, stone), false)
  assert.equal(inYard(origin, { x: origin.x + 15, y: 60, z: origin.z }, stone), false)
  assert.equal(inYard(origin, { x: 9881, y: origin.y - 13, z: 10133 }, stone), false, 'deep under it the rock is the mine\'s')
  assert.equal(inYard(origin, { x: 9879, y: 64, z: 10133 }, log), false, 'a tree beside the house is cut whole, as before')
  assert.equal(inYard(null, { x: 9881, y: 58, z: 10133 }, stone), false, 'no house, no yard')
})

test('from the pit beside the wall no stone of the yard is in view, and none is taken: the stone comes from outside it', async () => {
  const w = scene()
  assert.equal(inView(w.ctx, 'cobblestone').filter(cell => fromWalls(cell) <= 8 && cell.y >= origin.y - 12).length, 0)
  for (let look = 0; look < 40 && w.count('cobblestone') < 12; look++) await collect(w.ctx, 'cobblestone')
  const log = w.lines.join('\n')
  assert.ok(w.taken.length > 0 || w.trips.length > 0, `stone was taken, or the search went on to another place\n${log}`)
  assert.deepEqual(w.taken.filter(cell => fromWalls(cell) <= 8), [], `nothing within eight cells of the walls\n${log}`)
  // The house itself and the ground under it are as received.
  for (let x = origin.x - 1; x <= origin.x + 7; x++) for (let z = origin.z - 1; z <= origin.z + 7; z++) for (let y = origin.y - 6; y <= origin.y + 4; y++) {
    const c = received.rows[y]?.[z - received.z0]?.[x - received.x0]
    if (c) assert.equal(w.getBlock(x, y, z).name, 'minecraft:' + received.legend[c], `${x},${y},${z}`)
  }
})

test('with no house there the nearest ground is taken, as before: the soil over the stone two cells from where the wall stood', async () => {
  const w = scene()
  delete w.ctx.shared.playerHouse
  await collect(w.ctx, 'cobblestone')
  assert.deepEqual(w.taken, [{ x: 9880, y: 61, z: 10136 }], w.lines.join('\n'))
  assert.equal(fromWalls(w.taken[0]), 2)
})
