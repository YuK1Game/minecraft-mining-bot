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

// Live 2026-11-19 15:03 JST (GET /blocks): feet (-4928.77, 61.05, -4967.30) on dirt; water west (x-4930, y61) and
// north (z-4969, y60..62). Shifted here to x 0..5 = -4931..-4926, z 0..5 = -4970..-4965.
test('a body on a dry cell that reaches into the water beside it is in water, and its own cell is a ledge', () => {
  const { wetColumn, ledges, surface } = require('../src/movement/water-ledges')
  const rows = {
    60: ['dirt ~ sand gravel gravel stone', '~ ~ ~ sand stone stone', 'dirt ~ dirt sand stone stone', 'stone stone stone stone stone stone', 'vine . . . stone stone', 'stone stone stone . stone stone'],
    61: ['~ ~ ~ gravel gravel stone', '~ ~ ~ ~ sand stone', '~ ~ . dirt stone stone', '. vine stone stone stone stone', 'vine . stone stone stone stone', 'stone stone stone stone stone stone'],
    62: ['~ ~ ~ ~ gravel stone', '~ ~ ~ ~ sand stone', '. . . . stone .', '. vine stone stone stone stone', 'vine stone stone stone stone stone', 'stone stone stone stone stone stone'],
    63: ['. . . . . gravel', '. . . . . stone', '. . . . dirt .', '. vine . stone stone stone', 'dirt stone stone stone stone stone', 'stone stone stone stone stone stone'],
    64: ['. . . . . .', '. . . . . dirt', '. . . . dirt .', '. vine . . stone stone', 'vine stone stone stone stone stone', 'stone stone stone stone stone stone']
  }
  const getBlock = (x, y, z) => {
    const name = rows[y]?.[z]?.split(' ')[x]
    if (!name) return y < 60 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: false }
    if (name === '.') return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    if (name === '~') return { known: true, name: 'minecraft:water', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:' + name, boundingBox: name === 'vine' ? 'empty' : 'block' }
  }
  const feet = { x: 2.23, y: 61.05, z: 2.70 }
  assert.deepEqual(wetColumn(getBlock, feet), { x: 1, y: 61, z: 2, own: false })
  assert.equal(surface(getBlock, feet), 61)
  const found = ledges(getBlock, feet)
  assert.deepEqual(found[0], { x: 2.5, y: 61, z: 2.5 }, 'the own dry cell first')
  assert.ok(found.some(l => l.x === 3.5 && l.y === 62 && l.z === 2.5), 'the dirt beside it')
  assert.equal(wetColumn(getBlock, { x: 2.5, y: 61, z: 2.5 }), null, 'on the centre of the cell the body is out of the water')
  assert.equal(wetColumn(getBlock, { x: 3.3, y: 62, z: 2.5 }), null, 'a bank above the water is dry')
})
