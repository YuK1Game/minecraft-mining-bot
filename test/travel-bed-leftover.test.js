'use strict'
// Live 2026-11-17 12:04-12:08 JST: long travel left its own bed inside the
// player's house (respawn moved off the house bed, recovery refused).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { houseOwnsSpawn, recoverLeftover } = require('../src/travel/travel-bed-leftover')

const world = beds => (x, y, z) => ({ known: true, name: beds.has(`${x},${y},${z}`) ? 'minecraft:bed' : 'minecraft:air' })

test('the player house owns the respawn point', () => {
  assert.equal(houseOwnsSpawn({ playerHouse: { origin: { x: 0, y: 0, z: 0 } } }), true)
  assert.equal(houseOwnsSpawn({}), false)
})

test('a standing trip bed is mined again, then the house bed sets the spawn again', async () => {
  const beds = new Set(['5,77,5', '6,77,5'])
  const shared = { travelBed: { key: 'k', foot: { x: 5, y: 77, z: 5 }, head: { x: 6, y: 77, z: 5 } }, playerHouse: { origin: { x: 0, y: 76, z: 0 }, spawn: true } }
  const mined = []
  const ok = await recoverLeftover({ shared, getBlock: world(beds), mine: async (foot, key) => { mined.push([foot, key]); beds.clear() }, now: () => 1e6 })
  assert.equal(ok, true)
  assert.deepEqual(mined, [[{ x: 5, y: 77, z: 5 }, 'k']])
  assert.equal(shared.travelBed, null)
  assert.equal(shared.playerHouse.spawn, false)
})

test('a refused recovery is retried no sooner than 30 s, at most 5 times', async () => {
  const beds = new Set(['5,77,5'])
  const shared = { travelBed: { key: 'k', foot: { x: 5, y: 77, z: 5 } } }
  let t = 1e6, tries = 0
  const args = { shared, getBlock: world(beds), mine: async () => { tries++; throw new Error('refused') }, now: () => t }
  assert.equal(await recoverLeftover(args), false)
  assert.equal(await recoverLeftover(args), false)
  assert.equal(tries, 1)
  for (let i = 0; i < 6; i++) { t += 31000; await recoverLeftover(args) }
  assert.equal(tries, 5)
  assert.ok(shared.travelBed)
})

test('a record whose bed is gone is forgotten', async () => {
  const shared = { travelBed: { key: 'k', foot: { x: 5, y: 77, z: 5 }, head: { x: 6, y: 77, z: 5 } } }
  assert.equal(await recoverLeftover({ shared, getBlock: world(new Set()), mine: async () => assert.fail() }), false)
  assert.equal(shared.travelBed, null)
})
