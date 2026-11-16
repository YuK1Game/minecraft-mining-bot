'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { chestOf, bedOf, setSpawn } = require('../src/modes/house/house-spawn')
const { loadHouseSync } = require('../src/modes/house/house-build')

test('chest A and the bed of the blueprint', () => {
  assert.deepEqual(chestOf({ x: 10, y: 64, z: -5 }), { x: 13, y: 65, z: -4 })
  const bed = bedOf({ x: 0, y: 0, z: 0 })
  assert.ok(bed && bed.x >= 0 && bed.x <= 6 && bed.z >= 0 && bed.z <= 7)
})

test('the respawn point counts only from the server notice near the bed', async () => {
  let t = 1000
  const origin = { x: 0, y: 70, z: 0 }, bed = bedOf(origin), shared = {}
  const logs = []
  const ok = await setSpawn({ origin, shared, now: () => t, sleep: async ms => { t += ms }, log: text => logs.push(text), getFeet: () => ({ x: bed.x + 0.5, y: bed.y, z: bed.z + 1.5 }), walk: async () => true, wakeBed: async () => {}, useBed: async () => { shared.lastSpawnSet = { at: t + 1, position: { x: bed.x, y: bed.y, z: bed.z } } } })
  assert.equal(ok, true)
  const none = await setSpawn({ origin, shared: {}, now: () => t, sleep: async ms => { t += ms }, getFeet: () => null, walk: async () => true, wakeBed: async () => {}, useBed: async () => {} })
  assert.equal(none, false)
})

test('the house record is read back', () => {
  const io = { readFileSync: () => JSON.stringify({ version: 1, origin: { x: 1, y: 2, z: 3 }, done: true }) }
  assert.deepEqual(loadHouseSync('x', { io }), { origin: { x: 1, y: 2, z: 3 }, done: true })
  assert.equal(loadHouseSync('x', { io: { readFileSync: () => { throw Error('none') } } }), null)
})
