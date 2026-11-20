'use strict'

// An item that does not stack to 64 goes into an empty slot of the base chest, not onto the same item.
// Real Realm 2026-11-20 18:18 JST and 2026-11-21 00:06-00:07 JST, house (9877, 64, 10138): the long trip makes an
// oak boat and the return banks it. With an oak boat already in a chest, the chest module chose that slot
// ("the same item, 64 or fewer afterwards"), the server refused, and the return answered
// 「収納に失敗: TRANSFER_REJECTED サーバーがチェストへの移動を拒否しました。」 three times a chest: at chest A
// 18:18 (chest B took it), at A and B 00:06-00:07, then 「使えるチェストがなく、新しいチェストを作る木がありません」
// and the hold, the boat still in hand. (That each chest held a boat is inferred from that order and from the
// log's 「ボートを作ります」 lines; see src/inventory/stack-limit.js.)
// The whole trip runs here: player-base.js (what is due), return/* (goal, stages), container-ports.js and
// actions/chest.js over the simulated server (helpers/player-return-sim.js), which refuses, as the real one does,
// a transfer that would put more into a slot than the item's stack size.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { stackLimit } = require('../src/inventory/stack-limit')

const feet = { x: 6.5, y: GROUND, z: 1.5 }
const AIR = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
const stack = (sim, name, count) => { sim.give(35, name, count); const made = structuredClone(sim.bag[35]); sim.bag[35] = structuredClone(AIR); sim.resync(); return made }

// By the base chest after the way home: what was dug, the boat of the trip, eggs picked up on the way.
const KIT = [[0, 'stone_sword', 1, 58], [1, 'stone_pickaxe', 1, 40]]
function scene ({ lying = [], fill = 0, cargo = [[2, 'tuff', 30], [3, 'oak_boat', 1], [4, 'egg', 5], [5, 'bone', 20]] } = {}) {
  const sim = createReturnSim({ feet, items: [...KIT, ...cargo] })
  const chest = sim.placeChest(5, GROUND, 0, { fill })
  sim.shared.playerBase = chest
  lying.forEach(([slot, name, count]) => { sim.storeOf(chest)[slot] = stack(sim, name, count) })
  sim.worn = { known: true, worn: [] }
  sim.agent.running = true
  return { sim, chest }
}

test('the stack size of an item: a boat and a tool 1, eggs 16, stone 64, a shulker box 1, an item the table lacks unknown', () => {
  assert.deepEqual(['oak_boat', 'minecraft:iron_pickaxe', 'egg', 'bucket', 'cobblestone', 'minecraft:undyed_shulker_box', 'shulker_box', 'minecraft:blue_shulker_box', 'no_such_item'].map(stackLimit), [1, 1, 16, 16, 64, 1, 1, 1, null])
})

test('a boat is banked into a chest that already holds a boat: an empty slot, nothing refused, the trip ends', async () => {
  const { sim, chest } = scene({ lying: [[0, 'oak_boat', 1], [1, 'egg', 14], [2, 'tuff', 60]] })
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('oak_boat') === 0 && sim.held('tuff') === 0 && !sim.shared.playerReturn, ms: 300000 })
  const log = sim.log.join('\n')
  assert.equal(sim.server.refused ?? 0, 0, `the server refused nothing\n${log}`)
  assert.equal(sim.shared.playerReturn ?? null, null, `the trip ended\n${log}`)
  assert.equal(sim.held('oak_boat') + sim.held('egg') + sim.held('tuff') + sim.held('bone'), 0, `the cargo went in\n${log}`)
  assert.equal(sim.stored(chest, 'oak_boat'), 2)
  assert.equal(sim.stored(chest, 'egg'), 19)
  assert.equal(sim.stored(chest, 'tuff'), 90)
  // Each boat in a slot of its own; the eggs 16 and 3, or 14 and 5: never more than a slot holds.
  const store = sim.storeOf(chest)
  assert.equal(store.filter(item => item.network_id === store[0].network_id).every(item => item.count === 1), true, 'one boat a slot')
  assert.equal(store.filter(item => item.network_id === store[1].network_id).every(item => item.count <= 16), true, 'no more than 16 eggs a slot')
  assert.equal(sim.log.filter(line => /TRANSFER_REJECTED|NO_CHEST_MATERIAL|保留|あきらめます/.test(line)).length, 0, log)
})

test('a chest with no empty slot and only a boat of the same kind is full for the boat, and is not asked', async () => {
  const { sim, chest } = scene({ fill: 27, lying: [[0, 'oak_boat', 1]], cargo: [[3, 'oak_boat', 1]] })
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => !sim.shared.playerReturn || /保留/.test(sim.log.join('\n')), ms: 300000 })
  const log = sim.log.join('\n')
  assert.equal(sim.server.refused ?? 0, 0, `nothing was sent that the server refuses\n${log}`)
  assert.equal(sim.stored(chest, 'oak_boat'), 1, 'the chest is as it was')
  assert.equal(sim.held('oak_boat'), 1, 'the boat is still in hand')
  assert.equal(sim.server.requests.length, 0, `no transfer was asked of a chest with no slot for it\n${log}`)
  assert.equal(sim.log.filter(line => /TRANSFER_REJECTED/.test(line)).length, 0, log)
})
