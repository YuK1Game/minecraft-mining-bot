'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createArmor, armorInfo } = require('../src/actions/armor')

const NAMES = new Map([[1, 'minecraft:iron_chestplate'], [2, 'minecraft:leather_chestplate'], [3, 'minecraft:iron_sword'], [4, 'minecraft:diamond_helmet'], [5, 'minecraft:golden_boots'], [6, 'minecraft:diamond_boots']])
function fixture ({ inventory = [], respond = 'ok', preferGoldBoots = () => false } = {}) {
  const sent = []; let open = null
  const raws = new Map(inventory.map(i => [i.slot, { network_id: i.id, count: 1, has_stack_id: true, stack_id: 100 + i.slot, metadata: 0 }]))
  const crafting = {
    rawItem: slot => raws.get(slot) ?? { network_id: 0, count: 0 },
    snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: open, inventory: inventory.map(i => ({ slot: i.slot, name: NAMES.get(i.id), count: 1 })) }),
    openInventory: async () => { open = { id: 9, type: 'inventory' }; return open },
    closeContainer: () => { open = null },
    itemNameOf: id => NAMES.get(id) ?? null
  }
  let armor
  const client = { queue: (name, params) => { sent.push({ name, params }); if (name === 'item_stack_request' && respond) { const r = params.requests[0]; queueMicrotask(() => armor.applyPacket('item_stack_response', { responses: [{ request_id: r.request_id, status: respond, containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: r.actions[0].destination.slot, count: 1, item_stack_id: 500 }] }] }] })) } } }
  let rid = -1
  armor = createArmor({ client, crafting, preferGoldBoots, getState: () => ({ phase: 'spawned', health: 20, gameMode: 'survival', inventory: { known: true } }), allocateRequestId: () => (rid -= 2), timeoutMs: 200 })
  return { armor, sent, crafting, isOpen: () => open }
}

test('armor scores: per-slot defence, toughness breaks ties, non-armor is null', () => {
  assert.equal(armorInfo('minecraft:iron_chestplate').slot, 1)
  assert.ok(armorInfo('minecraft:netherite_helmet').score > armorInfo('minecraft:diamond_helmet').score)
  assert.ok(armorInfo('minecraft:iron_chestplate').score > armorInfo('minecraft:leather_chestplate').score)
  assert.equal(armorInfo('minecraft:iron_sword'), null)
})
test('nothing is planned until the server armor window is known', () => {
  const f = fixture({ inventory: [{ slot: 6, id: 1 }] })
  assert.equal(f.armor.preview(), null)
  f.armor.applyPacket('inventory_content', { window_id: 'armor', input: [0, 0, 0, 0].map(() => ({ network_id: 0, count: 0 })) })
  assert.equal(f.armor.preview().armorSlot, 1)
})
test('equips the best pieces with a server-accepted request, then closes the screen it opened', async () => {
  const f = fixture({ inventory: [{ slot: 6, id: 2 }, { slot: 7, id: 1 }, { slot: 8, id: 4 }, { slot: 0, id: 3 }] })
  f.armor.applyPacket('inventory_content', { window_id: 'armor', input: [0, 0, 0, 0].map(() => ({ network_id: 0, count: 0 })) })
  const moved = await f.armor.equipBest()
  const requests = f.sent.filter(s => s.name === 'item_stack_request').map(s => s.params.requests[0].actions[0])
  assert.deepEqual(requests.map(a => [a.source.slot, a.destination.slot_type.container_id, a.destination.slot]), [[7, 'armor', 1], [8, 'armor', 0]], 'iron chest beats leather; helmet next; sword never')
  assert.ok(moved.every(m => m.serverConfirmed)); assert.equal(f.isOpen(), null)
})
test('a rejected request stops further moves and is reported', async () => {
  const f = fixture({ inventory: [{ slot: 7, id: 1 }], respond: 'error' })
  f.armor.applyPacket('inventory_content', { window_id: 'armor', input: [0, 0, 0, 0].map(() => ({ network_id: 0, count: 0 })) })
  const moved = await f.armor.equipBest()
  assert.equal(moved.length, 1); assert.equal(moved[0].phase, 'rejected'); assert.equal(f.isOpen(), null)
})
test('an accepted move commits the emptied source slot to the inventory model', async () => {
  const commits = []
  const f = fixture({ inventory: [{ slot: 7, id: 1 }] })
  // rebuild with an onInventory hook
  const { createArmor } = require('../src/actions/armor')
  let armor; const sent = []
  const client = { queue: (name, params) => { sent.push(name); if (name === 'item_stack_request') { const r = params.requests[0]; queueMicrotask(() => armor.applyPacket('item_stack_response', { responses: [{ request_id: r.request_id, status: 'ok', containers: [] }] })) } } }
  armor = createArmor({ client, crafting: f.crafting, getState: () => ({ phase: 'spawned', health: 20, gameMode: 'survival', inventory: { known: true } }), allocateRequestId: () => -3, onInventory: p => commits.push(p) })
  armor.applyPacket('inventory_content', { window_id: 'armor', input: [0, 0, 0, 0].map(() => ({ network_id: 0, count: 0 })) })
  await armor.equipBest({ maxMoves: 1 })
  assert.equal(commits.length, 1); assert.equal(commits[0].input[7].network_id, 0); assert.equal(commits[0].input.length, 36)
})

test('gold boots on Nether trips are preferred over diamond and kept until the expedition leaves', () => {
  let scout = true
  const f = fixture({ inventory: [{ slot: 8, id: 5 }, { slot: 9, id: 6 }], preferGoldBoots: () => scout })
  const worn = id => f.armor.applyPacket('inventory_content', { window_id: 120, input: [{}, {}, {}, { network_id: id, count: 1, stack_id: 155, has_stack_id: true }] })
  worn(6)
  assert.equal(f.armor.preview().name, 'minecraft:golden_boots')
  worn(5)
  assert.equal(f.armor.preview(), null)
  scout = false
  assert.equal(f.armor.preview().name, 'minecraft:diamond_boots')
})
