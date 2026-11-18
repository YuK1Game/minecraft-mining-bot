'use strict'

// The open click goes to a face of the block that looks towards the eye and
// has a clear line. Live 2026-11-18 20:13-20:20 JST: the expedition's furnace
// stood in the wall niche of its one-wide tunnel (stone on it). From the cell
// beside it the eye is higher (1.12) than it is far (0.99), so every click
// chose the top face and ended with 「操作対象への視線が遮られているか、未取得です。」.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { containerFace, openAccess } = require('../src/actions/open-face')
const { createInteractions } = require('../src/actions/interactions')

const key = (x, y, z) => `${x},${y},${z}`
// Rock everywhere but the listed cells.
function rock (open, other = {}) {
  const cells = new Map(open.map(([x, y, z]) => [key(x, y, z), 'minecraft:air']))
  for (const [where, name] of Object.entries(other)) cells.set(where, name)
  const getBlock = (x, y, z) => { const name = cells.get(key(x, y, z)) ?? 'minecraft:stone'; return { known: true, name, runtimeId: name === 'minecraft:air' ? 0 : 20, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] } }
  return { cells, getBlock, read: pos => getBlock(pos.x, pos.y, pos.z) }
}
// The live case: feet cell (-4890, 40, -4977), the furnace in the niche to the west.
const EYE = { x: -4889.51, y: 41.62, z: -4976.40 }
const FURNACE = { x: -4891, y: 40, z: -4977 }
const live = () => rock([[-4890, 40, -4977], [-4890, 41, -4977], [-4890, 41, -4978]], { [key(-4891, 40, -4977)]: 'minecraft:furnace' })

test('a furnace in a wall niche beside the feet is opened by its side, not by its covered top', () => {
  const w = live()
  assert.equal(containerFace(EYE, FURNACE).face, 1, 'the face most towards the eye is the top')
  const chosen = containerFace(EYE, FURNACE, w.read)
  assert.equal(chosen.face, 5)
  assert.deepEqual(chosen.point, { x: -4890, y: 40.5, z: -4976.5 })
  assert.deepEqual(chosen.clickPos, { x: 1, y: 0.5, z: 0.5 })
  assert.equal(openAccess(w.read, EYE, FURNACE), null)
})

test('an open top is still the first choice, and a face the eye is not in front of is never chosen', () => {
  const w = live()
  w.cells.set(key(-4891, 41, -4977), 'minecraft:air')
  assert.equal(containerFace(EYE, FURNACE, w.read).face, 1)
  // Top and east side both closed: the south face (the eye is 0.1 from the middle, not in front of it) is not tried.
  const shut = rock([[-4890, 41, -4977]], { [key(-4891, 40, -4977)]: 'minecraft:furnace' })
  assert.equal(containerFace(EYE, FURNACE, shut.read).face, 1)
  assert.equal(openAccess(shut.read, EYE, FURNACE).code, 'SIGHT_BLOCKED')
  // An unreceived cell on the line to the side is not a clear line.
  const unknown = pos => pos.x === -4890 && pos.y === 40 ? { known: false } : w.read(pos)
  w.cells.set(key(-4891, 41, -4977), 'minecraft:stone')
  assert.equal(openAccess(unknown, EYE, FURNACE).code, 'SIGHT_BLOCKED')
})

test('the real open click of the live case is sent to the east face of the furnace', async t => {
  const w = live()
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra }
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, position: { ...EYE }, selectedSlot: 0, inventory: { known: true } }
  const crafting = { rawItem: () => structuredClone(empty), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [] }), applyPacket () {} }
  const transactions = []
  let running = false
  const input = { stats: () => ({ running, target: null }), lookAt () {}, start () { running = true }, stop () { running = false }, sendTransaction: (transaction, options = {}) => { transactions.push(transaction); options.onSent?.() } }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world: { getBlock: w.getBlock }, crafting, getInput: () => input, onInventory () {}, onUncertain () {}, timeoutMs: 1000 })
  t.after(() => interactions.cancel())
  const opening = interactions.openFurnace(FURNACE, 0)
  assert.equal(transactions.length, 1)
  const sent = JSON.stringify(transactions[0], (_, value) => typeof value === 'bigint' ? String(value) : value)
  assert.match(sent, /"face":5/)
  interactions.applyPacket('container_open', { window_id: 5, window_type: 'furnace', coordinates: FURNACE })
  assert.equal((await opening).windowId, 5)
})
