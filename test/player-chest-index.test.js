'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { attachChestIndex, indexFile, roomFirst } = require('../src/modes/player-chest-index')
const { createContainerPorts } = require('../src/modes/return/container-ports')

const slots = (n, filled = {}) => Array.from({ length: n }, (_, slot) => filled[slot] ? { known: true, slot, ...filled[slot] } : { known: true, slot, name: null, count: 0 })
const chestAt = cells => (x, y, z) => ({ known: true, name: cells.some(p => p.x === x && p.y === y && p.z === z) ? 'minecraft:chest' : 'minecraft:air', properties: { 'minecraft:cardinal_direction': 'south' } })

function tmp (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chest-index-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('a received chest is written to the file of its server and read back into a new memory after a restart', async t => {
  const root = tmp(t)
  let state = { realm: { id: 'realm-A' }, dimension: 'overworld' }
  const memory = { seen: new Map() }
  const index = attachChestIndex({ memory, root, state: () => state, now: () => 1000 })
  await index.record({ x: 1, y: 64, z: 2 }, slots(27, { 0: { name: 'minecraft:raw_iron', count: 12 } }), 1000)
  state = { realm: { id: 'realm-B' }, dimension: 'overworld' }
  await attachChestIndex({ memory: { seen: new Map() }, root, state: () => state }).record({ x: 9, y: 9, z: 9 }, slots(27), 2000)

  const a = JSON.parse(fs.readFileSync(indexFile(root, 'realm-A'), 'utf8'))
  assert.deepEqual(Object.keys(a.chests), ['overworld:1,64,2'])
  assert.deepEqual(a.chests['overworld:1,64,2'].items, { 'minecraft:raw_iron': 12 })
  assert.equal(a.chests['overworld:1,64,2'].empty, 26)
  assert.ok(fs.existsSync(indexFile(root, 'realm-B')))
  assert.equal(JSON.parse(fs.readFileSync(indexFile(root, 'realm-B'), 'utf8')).chests['overworld:1,64,2'], undefined)

  state = { realm: { id: 'realm-A' }, dimension: 'overworld' }
  const restored = { seen: new Map() }
  attachChestIndex({ memory: restored, root, state: () => state })
  assert.equal(restored.seen.get('1,64,2').find(s => s.slot === 0).count, 12)
  assert.equal(restored.at.get('1,64,2'), 1000)
  // Another dimension of the same server does not read the overworld's chests.
  const nether = { seen: new Map() }
  attachChestIndex({ memory: nether, root, state: () => ({ realm: { id: 'realm-A' }, dimension: 'nether' }) })
  assert.equal(nether.seen.size, 0)
})

test('opening a chest through the container port updates the server file, and a large chest is kept once', async t => {
  const root = tmp(t)
  const halves = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]
  const getBlock = chestAt(halves)
  const memory = { seen: new Map() }
  const index = attachChestIndex({ memory, root, state: () => ({ realm: { id: 'r' }, dimension: 'overworld' }), getBlock })
  let view = {}, epoch = 0
  const operations = { interactions: {}, crafting: { closeContainer: () => { view = {} } }, chest: {
    snapshot: () => view,
    open: async position => { view = { window: { id: 1, epoch: ++epoch, scope: 's', position, slotCount: 54 }, contentsKnown: true, slots: slots(54, { 3: { name: 'minecraft:coal', count: 5 } }) }; return { windowId: 1 } }
  } }
  const box = createContainerPorts({ operations, getBlock, getFeet: () => ({ x: 0.5, y: 64, z: 1.5 }), getInventory: () => ({ known: true, items: [] }), memory })
  assert.equal((await box.inspect(halves[0])).status, 'completed')
  await index.flush()
  assert.equal((await box.inspect(halves[1])).status, 'completed')
  await index.flush()
  const data = JSON.parse(fs.readFileSync(indexFile(root, 'r'), 'utf8'))
  assert.deepEqual(Object.keys(data.chests), ['overworld:1,64,0'])
  assert.equal(data.chests['overworld:1,64,0'].large, true)
  assert.deepEqual(data.chests['overworld:1,64,0'].items, { 'minecraft:coal': 5 })
})

test('chests are visited room first, unread next and recorded full last', () => {
  const at = x => ({ x, y: 0, z: 0 })
  const known = { 1: slots(27, Object.fromEntries(Array.from({ length: 27 }, (_, i) => [i, { name: 'minecraft:stone', count: 64 }]))), 3: slots(27) }
  const order = roomFirst([at(1), at(2), at(3)], p => known[p.x] ?? null).map(p => p.x)
  assert.deepEqual(order, [3, 2, 1])
})
