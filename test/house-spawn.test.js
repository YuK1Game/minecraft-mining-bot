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
  assert.deepEqual(loadHouseSync('x', { io }), { origin: { x: 1, y: 2, z: 3 }, done: true, spawn: false })
  assert.equal(loadHouseSync('x', { io: { readFileSync: () => { throw Error('none') } } }), null)
})

test('the counts left are saved and read back', async () => {
  const io = { readFileSync: () => JSON.stringify({ version: 1, origin: { x: 1, y: 2, z: 3 }, done: false, left: { glass: 6, cobblestone: 1 } }) }
  assert.deepEqual(loadHouseSync('x', { io }).left, { glass: 6, cobblestone: 1 })
  const { createHouseBuild } = require('../src/modes/house/house-build')
  const writes = []
  const shared = { playerHouse: { origin: { x: 1, y: 2, z: 3 }, done: false } }
  const house = createHouseBuild({ getMode: () => 'quarry', shared, file: 'f', write: async (file, value) => { writes.push(value) }, getFeet: () => null, getPosition: () => null, getBlock: () => null, getInventory: () => null, agent: {}, ports: {}, hands: {}, climb: async () => ({ ok: false }), travel: { status: () => ({}) } })
  await house.tick()
  assert.equal(writes.length, 0)
  shared.playerHouse.left = { glass: 6 }
  await house.tick()
  await house.tick()
  assert.deepEqual(writes.map(value => value.left), [{ glass: 6 }])
})

test('the bed is used from a stand around it when it cannot be used from here', async () => {
  let t = 1000
  const origin = { x: 0, y: 70, z: 0 }, bed = bedOf(origin), shared = {}
  // The cell south of the foot holds a table (solid).
  const getBlock = (x, y, z) => y < bed.y || x === bed.x && y === bed.y && z === bed.z + 1 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const near = () => Math.hypot(feet.x - bed.x - 0.5, feet.z - bed.z - 0.5) < 2
  let feet = { x: bed.x + 10, y: bed.y, z: bed.z }
  const walks = []
  const ok = await setSpawn({ origin, shared, getBlock, previewUse: () => ({ ready: near() }), now: () => t, sleep: async ms => { t += ms }, getFeet: () => feet, walk: async target => { walks.push(target); if (getBlock(Math.floor(target.x), target.y, Math.floor(target.z)).boundingBox === 'block') return false; feet = target; return true }, wakeBed: async () => {}, useBed: async () => { if (!near()) throw new Error('no visible face'); shared.lastSpawnSet = { at: t + 1, position: { x: bed.x, y: bed.y, z: bed.z } } } })
  assert.equal(ok, true)
  assert.equal(walks.length, 1)
})
