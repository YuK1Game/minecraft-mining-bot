'use strict'
// A seagrass cell is water (src/movement/wet-cell.js): the water exit's readers (water-ledges.js, player-water.js)
// with the real exit planner and the real physics over the pond as it was received.
//
// Real Realm 2026-11-20 23:53 - 2026-11-21 00:01 JST: the Bot stood in the seagrass cell (9876, 62, 10175), one
// block of water over dirt, two blocks from a grass shore. 「水から上がりました」 came ten times in eight minutes and
// the feet stayed in that cell; the trip home found no walkable point 16 times.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { water } = require('../src/movement/wet-cell')
const { wetColumn, surface, ledges } = require('../src/movement/water-ledges')
const { createPlayerWater, wet } = require('../src/modes/player-water')
const { createPhysics } = require('../src/movement/physics')
const { planWaterExit } = require('../src/movement/water-exit')
const { getBlock, SEAGRASS, FEET, SHORE } = require('./helpers/pond-seagrass')

const cellOf = feet => ({ x: Math.floor(feet.x), y: Math.floor(feet.y + 0.2), z: Math.floor(feet.z) })

test('the cell: a plant with water in its second layer holds water; a dry plant and air do not', () => {
  assert.equal(getBlock(SEAGRASS.x, SEAGRASS.y, SEAGRASS.z).name, 'minecraft:seagrass')
  assert.equal(water(getBlock(SEAGRASS.x, SEAGRASS.y, SEAGRASS.z)), true)
  assert.equal(water(getBlock(9876, 62, 10176)), true, 'plain water')
  assert.equal(water(getBlock(9876, 63, 10175)), false, 'air')
  assert.equal(water(getBlock(9875, 63, 10173)), false, 'leaf litter on the shore')
  assert.equal(water({ known: true, name: 'minecraft:kelp', boundingBox: 'empty', extra: [{ name: 'minecraft:flowing_water' }] }), true)
  assert.equal(water(null), false)
})

test('in the seagrass cell the body is in water of its own column, and the ledge is the grass shore, never the cell itself', () => {
  for (const feet of FEET) {
    const at = `feet ${feet.x}, ${feet.y}, ${feet.z}`
    assert.equal(wet(getBlock, feet), true, at)
    assert.equal(wetColumn(getBlock, feet).own, true, at)
    assert.equal(surface(getBlock, feet), 62, at)
    const found = ledges(getBlock, feet)
    assert.deepEqual(found[0], SHORE, at)
    for (const ledge of found) {
      const x = Math.floor(ledge.x), z = Math.floor(ledge.z)
      assert.equal(water(getBlock(x, ledge.y, z)) || water(getBlock(x, ledge.y + 1, z)) || water(getBlock(x, ledge.y - 1, z)), false, `${at}: ledge ${x}, ${ledge.y}, ${z}`)
    }
  }
})

test('the exit, with the real planner and physics: out of the water means on the shore, not at the centre of the seagrass cell', async () => {
  const physics = createPhysics({ world: { getBlock }, allowWater: true })
  for (const from of FEET) {
    let feet = { ...from }, refused = null
    const lines = [], targets = []
    const job = createPlayerWater({
      getMode: () => 'player', shared: { playerWanted: true }, getBlock, getPosition: () => feet, log: line => lines.push(line), sleep: async () => {}, moving: () => false, why: () => refused,
      agent: { objective: {}, start: async () => {}, stop () {}, settled: () => true },
      // The move as the runtime makes it: the planner's tape from the received state; the feet are where the tape ends.
      start: target => {
        targets.push(target)
        const initial = physics.fromServer({ position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, gameMode: 'survival' })
        Object.assign(initial, { isInWater: true, onGround: feet.y === 62, velocity: { x: 0, y: 0, z: 0 } })
        const route = planWaterExit({ physics, initial, target })
        if (!route.ready) { refused = route.reason; throw new Error(route.reason) }
        const end = (route.exitFrames ?? route.frames).at(-1).state.position
        feet = { x: end.x, y: end.y, z: end.z }
      }
    })
    const out = await job.exit()
    const at = `from ${from.x}, ${from.y}, ${from.z}: ${lines.join(' / ')}`
    assert.equal(out.ok, true, at)
    assert.deepEqual(targets[0], SHORE, at)
    const cell = cellOf(feet)
    assert.equal(water(getBlock(cell.x, cell.y, cell.z)), false, at + ` -> ${feet.x}, ${feet.y}, ${feet.z}`)
    assert.equal(getBlock(cell.x, cell.y - 1, cell.z).name, 'minecraft:grass_block', at)
    assert.equal(feet.y, 63, at)
    assert.deepEqual(lines, ['プレイヤーモード: 水から上がりました'])
  }
})
