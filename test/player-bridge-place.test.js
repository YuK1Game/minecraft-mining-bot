'use strict'
// The floor block over a gap (player-scaffold-ports.js `bridge`), through the real
// placement of the interactions module: against the side of the block under the
// feet, counted by the received block only.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/actions/interactions')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')

const key = (x, y, z) => `${x},${y},${z}`
// Ground up to y 63; the column x = 1 is a gap down to y 40.
function scene ({ answer = true } = {}) {
  const changed = new Map()
  const getBlock = (x, y, z) => {
    const name = changed.get(key(x, y, z)) ?? (y <= 63 && !(x === 1 && y >= 40) ? 'minecraft:stone' : 'minecraft:air')
    return { known: true, name, runtimeId: name === 'minecraft:air' ? 0 : 20, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] }
  }
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra }
  const stone = { network_id: 4, count: 12, metadata: 0, has_stack_id: true, stack_id: 7, block_runtime_id: 21, extra }
  const items = [{ slot: 0, name: 'minecraft:cobblestone', count: 12, stackId: 7 }]
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, position: { x: 0.5, y: 65.62, z: 0.5 }, selectedSlot: 0, inventory: { known: true, items } }
  const crafting = { rawItem: slot => structuredClone(slot === 0 ? stone : empty), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: items }), applyPacket () {}, closeContainer () {} }
  const transactions = []
  let running = false
  const input = { stats: () => ({ running, target: null }), lookAt () {}, start () { running = true }, stop () { running = false },
    sendTransaction: (transaction, options = {}) => { transactions.push(transaction); options.onSent?.() } }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world: { getBlock }, crafting, getInput: () => input, onInventory () {}, onUncertain () {}, timeoutMs: 400 })
  // As runtime-operations.js wires them.
  const operations = {
    inventory: { equip: async () => ({ phase: 'unchanged' }) }, movement: {}, mining: {},
    interactions: {
      previewPlaceAgainst: data => interactions.previewQuarryPlace(data),
      placeAgainst: data => {
        const plan = interactions.previewQuarryPlace(data)
        if (!plan.ready) throw new Error((plan.errors ?? []).join(' / '))
        const run = interactions.placeQuarryBlock(data)
        // The server's answer: the block appears in the received world.
        if (answer) changed.set(key(data.position.x, data.position.y, data.position.z), 'minecraft:cobblestone')
        return run
      }
    }
  }
  let clock = 0
  const ports = createScaffoldPorts({ operations, getBlock, getFeet: () => ({ x: 0.5, y: 64, z: 0.5 }), getInventory: () => ({ known: true, items }), getMotion: () => ({ phase: 'idle' }), pillarStep: async () => ({}), sleep: async ms => { clock += ms }, now: () => clock })
  return { ports, transactions, interactions, getBlock }
}

test('the floor block is placed against the side of the block under the feet', async t => {
  const f = scene()
  t.after(() => f.interactions.cancel())
  assert.equal(await f.ports.bridge({ x: 1, y: 63, z: 0 }, { x: 0, y: 64, z: 0 }), true)
  assert.equal(f.transactions.length, 1)
  const sent = JSON.stringify(f.transactions[0], (_, value) => typeof value === 'bigint' ? String(value) : value)
  assert.match(sent, /"face":5/, 'the east face of the block under the feet')
  assert.match(sent, /"x":0,"y":63,"z":0/)
  assert.equal(f.getBlock(1, 63, 0).name, 'minecraft:cobblestone')
})

test('a placement the server does not answer is not counted and not sent a second time', async t => {
  const f = scene({ answer: false })
  t.after(() => f.interactions.cancel())
  assert.equal(await f.ports.bridge({ x: 1, y: 63, z: 0 }, { x: 0, y: 64, z: 0 }), false)
  assert.equal(f.transactions.length, 1)
})

test('a cell out of reach is refused by the placement check and nothing is sent', async t => {
  const f = scene()
  t.after(() => f.interactions.cancel())
  assert.equal(await f.ports.bridge({ x: 1, y: 50, z: 0 }, { x: 0, y: 64, z: 0 }), false)
  assert.equal(f.transactions.length, 0)
  assert.ok(f.ports.why(), 'the reason is kept for the log')
})
