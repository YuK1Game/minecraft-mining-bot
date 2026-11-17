'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerWater, wet, ledges } = require('../src/modes/player-water')

// A pool at y=63 (water at y 63, 64 is the surface) with a dirt shore to the east from x=3.
function world () {
  return (x, y, z) => {
    if (x >= 3) {
      if (y <= 63) return { known: true, name: 'minecraft:dirt', boundingBox: 'block' }
      return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    }
    if (y <= 61) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    if (y <= 63) return { known: true, name: 'minecraft:water', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}

test('ledges beside the water are found nearest first', () => {
  const getBlock = world()
  assert.equal(wet(getBlock, { x: 0.5, y: 63.9, z: 0.5 }), true)
  const found = ledges(getBlock, { x: 0.5, y: 63.9, z: 0.5 })
  assert.deepEqual(found[0], { x: 3.5, y: 64, z: 0.5 })
})

test('afloat and still for 15 s: stops, swims onto the ledge with the water exit, plays on', async () => {
  const getBlock = world()
  let feet = { x: 0.5, y: 63.9, z: 0.5 }, t = 0
  const calls = []
  const water = createPlayerWater({
    getMode: () => 'player', shared: { playerWanted: true }, getBlock, getPosition: () => feet,
    agent: { objective: {}, start: async () => calls.push('start'), stop: () => calls.push('stop'), settled: () => true },
    start: (target, options) => { calls.push(['move', target, options.waterExit]); feet = { x: target.x, y: target.y, z: target.z } },
    moving: () => false, now: () => t, sleep: async () => {}
  })
  assert.equal(await water.tick(), null)
  t = 10000
  assert.equal(await water.tick(), null)
  t = 16000
  assert.equal(await water.tick(), true)
  assert.deepEqual(calls, ['stop', ['move', { x: 3.5, y: 64, z: 0.5 }, true], 'start'])
})

test('on dry land or still moving it does nothing', async () => {
  const getBlock = world()
  let feet = { x: 4.5, y: 64, z: 0.5 }, t = 0
  const water = createPlayerWater({ getMode: () => 'player', shared: { playerWanted: true }, getBlock, getPosition: () => feet, agent: { start: async () => { throw new Error('no') }, stop: () => { throw new Error('no') } }, start: () => { throw new Error('no') }, moving: () => false, now: () => t, sleep: async () => {} })
  t = 20000
  assert.equal(await water.tick(), null)
  feet = { x: 0.5, y: 63.9, z: 0.5 }
  await water.tick(); t = 30000; feet = { x: 2.5, y: 63.9, z: 0.5 }
  assert.equal(await water.tick(), null)
})

test('exit alone swims out without touching the autonomy', async () => {
  const getBlock = world()
  let feet = { x: 0.5, y: 63.9, z: 0.5 }
  const water = createPlayerWater({
    getMode: () => 'player', shared: { playerWanted: true }, getBlock, getPosition: () => feet,
    agent: { start: async () => { throw new Error('no') }, stop: () => { throw new Error('no') } },
    start: target => { feet = { x: target.x, y: target.y, z: target.z } }, moving: () => false, sleep: async () => {}
  })
  assert.equal(water.needed(), true)
  assert.deepEqual(await water.exit(), { ok: true })
  assert.equal(water.needed(), false)
})
