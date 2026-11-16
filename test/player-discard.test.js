'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { throwable, discardJunk, discarded } = require('../src/modes/player-discard')
const { createDiscard } = require('../src/inventory/discard')

const mc = name => `minecraft:${name}`
const inv = items => ({ known: true, items: items.map(([slot, name, count, extra = {}]) => ({ slot, name: mc(name), count, ...extra })) })

test('throws whole rubble stacks and junk, keeps the reserve, valuables and the best tools', () => {
  const inventory = inv([
    [0, 'cobblestone', 64], [1, 'cobblestone', 64], [2, 'cobblestone', 40], [3, 'cobbled_deepslate', 64], [4, 'granite', 37],
    [5, 'dirt', 57], [6, 'diamond', 4], [7, 'raw_iron', 1], [8, 'coal', 3], [9, 'oak_sapling', 1], [10, 'spider_eye', 1],
    [11, 'wooden_sword', 1], [12, 'stone_sword', 1], [13, 'diamond_sword', 1], [14, 'diamond_pickaxe', 1, { maxDurability: 1561, durabilityUsed: 500 }],
    [15, 'stone_pickaxe', 1, { maxDurability: 131, durabilityUsed: 10 }], [16, 'arrow', 2], [17, 'white_wool', 7], [18, 'mutton', 1], [19, 'oak_planks', 4]
  ])
  const slots = throwable(inventory).map(stack => stack.slot).sort((a, b) => a - b)
  // One cobblestone 64 stays; the dirt stack is partly reserve so it is not thrown whole.
  // The stone pickaxe stays as the one working spare.
  assert.deepEqual(slots, [1, 2, 3, 4, 9, 10, 11, 12])
})

test('discardJunk throws, records where, and the drop planning skips those drops', async () => {
  const items = [[0, 'granite', 10], [1, 'diamond', 4]]
  let inventory = inv(items)
  const shared = {}
  const said = []
  const dropped = []
  const drop = async (slot, count) => { dropped.push([slot, count]); inventory = inv(items.filter(item => item[0] !== slot)); return { phase: 'completed' } }
  const thrown = await discardJunk({ drop, getInventory: () => inventory, getFeet: () => ({ x: 0.5, y: 0, z: 0.5 }), shared, say: text => said.push(text), now: () => 1000 })
  assert.equal(thrown, 1)
  assert.deepEqual(dropped, [[0, 10]])
  assert.match(said[0], /granite 10/)
  assert.equal(discarded(shared, { name: mc('granite'), position: { x: 2, y: 0, z: 0 } }, 2000), true)
  assert.equal(discarded(shared, { name: mc('diamond'), position: { x: 2, y: 0, z: 0 } }, 2000), false)
  assert.equal(discarded(shared, { name: mc('granite'), position: { x: 2, y: 0, z: 0 } }, 1000 + 11 * 60 * 1000), false)
})

test('the drop request counts only on the server answer and commits the emptied slot', async () => {
  const sent = [], committed = []
  const raws = { 3: { network_id: 5, count: 10, metadata: 0, has_stack_id: true, stack_id: 77, block_runtime_id: 0 } }
  let open = null
  const crafting = { rawItem: slot => raws[slot] ?? { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }, snapshot: () => ({ openContainer: open, pendingRequestId: null }), openInventory: async () => { open = { id: 1 } }, closeContainer: () => { open = null } }
  const discard = createDiscard({ client: { queue: (name, packet) => sent.push([name, packet]) }, getState: () => ({ phase: 'spawned' }), crafting, allocateRequestId: () => -5, onInventory: packet => committed.push(packet), timeoutMs: 1000 })
  const pending = discard.drop(3)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent[0][0], 'item_stack_request')
  const action = sent[0][1].requests[0].actions[0]
  assert.equal(action.type_id, 'drop')
  assert.equal(action.count, 10)
  assert.equal(action.source.stack_id, 77)
  discard.applyPacket('item_stack_response', { responses: [{ status: 'ok', request_id: -5, containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 3, count: 0 }] }] }] })
  const result = await pending
  assert.equal(result.phase, 'completed')
  assert.equal(committed[0].input[3].count, 0)
  assert.equal(open, null)
})

test('a rejected drop is not counted', async () => {
  const raws = { 0: { network_id: 5, count: 1, metadata: 0, has_stack_id: true, stack_id: 9, block_runtime_id: 0 } }
  const crafting = { rawItem: slot => raws[slot], snapshot: () => ({ openContainer: { id: 1 }, pendingRequestId: null }), openInventory: async () => {}, closeContainer: () => {} }
  const discard = createDiscard({ client: { queue: () => {} }, getState: () => ({ phase: 'spawned' }), crafting, allocateRequestId: () => -7, timeoutMs: 1000 })
  const pending = discard.drop(0)
  await new Promise(resolve => setImmediate(resolve))
  discard.applyPacket('item_stack_response', { responses: [{ status: 'error', request_id: -7 }] })
  assert.equal((await pending).phase, 'rejected')
})

test('throws from a walkable cell 3-6 m away and walks straight back; with no such cell it throws nothing', async () => {
  const items = [[0, 'granite', 10]]
  let inventory = inv(items)
  let feet = { x: 0.5, y: 0, z: 0.5 }
  const walks = [], drops = []
  const walk = async target => { walks.push(target); feet = { ...target }; return true }
  const drop = async slot => { drops.push({ slot, at: { ...feet } }); inventory = inv([]); return { phase: 'completed' } }
  const cells = new Map([[0, { x: 0, y: 0, z: 0 }], [1, { x: 1, y: 0, z: 0 }], [2, { x: 4, y: 0, z: 0 }], [3, { x: 9, y: 0, z: 0 }]])
  const thrown = await discardJunk({ drop, walk, cells: () => cells, getInventory: () => inventory, getFeet: () => feet, shared: {}, now: () => 0 })
  assert.equal(thrown, 1)
  assert.deepEqual(walks.map(target => target.x), [4.5, 0.5])
  assert.equal(drops[0].at.x, 4.5)
  inventory = inv(items)
  const said = []
  assert.equal(await discardJunk({ drop, walk, cells: () => new Map([[0, { x: 0, y: 0, z: 0 }]]), getInventory: () => inventory, getFeet: () => feet, shared: {}, say: text => said.push(text) }), 0)
  assert.match(said[0], /捨てる場所がありません/)
})
