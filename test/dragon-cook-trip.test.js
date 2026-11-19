'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { cookNow, BATCH } = require('../src/modes/cook-trip')
const { provisionFood } = require('../src/modes/dragon-early-food')

test('raw meat goes home with a full batch, with nothing left to hunt, or when already at home', () => {
  assert.equal(cookNow({ raw: 0, here: true, huntReady: false }), false)
  assert.equal(cookNow({ raw: 1, here: false, huntReady: true }), false, 'one piece and an animal in view: keep hunting')
  assert.equal(cookNow({ raw: BATCH, here: false, huntReady: true }), true)
  assert.equal(cookNow({ raw: 1, here: false, huntReady: false }), true)
  assert.equal(cookNow({ raw: 1, here: true, huntReady: true }), true)
})

test('away from home with one raw piece and an animal in view, the food step hunts instead of walking home', async () => {
  const origin = { x: 0, y: 64, z: 0 }
  const calls = []
  let ready = true
  // Fuel in hand: without it the fuel is fetched before the walk home (dragon-food-cook.test.js).
  const items = [{ name: 'minecraft:mutton', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const ctx = {
    shared: { playerHouse: { origin, done: true } }, memory: {}, cancelled: () => false, log: () => {}, now: () => 0, signal: new AbortController().signal,
    getFeet: () => ({ x: 80.5, y: 64, z: 80.5 }), getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
    hands: { walk: async () => { calls.push('walk'); return false }, approach: async () => false },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    travelTo: async () => { calls.push('travel') },
    operations: {
      perception: { entities: () => [] }, interactions: { useDoor: async () => {} },
      quarry: { travelStatus: () => ({ busy: false }), cancelTravel: async () => {} },
      foraging: {
        preview: () => ready ? { ready: true, target: { runtimeId: 7, name: 'minecraft:sheep' }, distance: 5 } : { ready: false, code: 'NO_KNOWN_FOOD_SOURCE' },
        stop: () => {},
        execute: async () => { calls.push('hunt'); return { target: { runtimeId: 7, name: 'minecraft:sheep' }, hits: 1, gained: 1, moved: 1 } }
      }
    }
  }
  const hunting = await provisionFood(ctx)
  assert.deepEqual(calls, ['hunt'])
  assert.match(hunting.reason, /狩り/)
  ready = false
  calls.length = 0
  const home = await provisionFood(ctx)
  assert.ok(!calls.includes('hunt'))
  assert.match(home.reason, /本拠点で調理/)
})
