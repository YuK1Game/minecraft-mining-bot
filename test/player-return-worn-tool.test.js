'use strict'

// What goes into the base chest and what comes back out of it are read from the same facts of an item.
// Real Realm 2026-11-20 02:45-02:49 JST (main d0e390f): the only pickaxe was a stone one with 0 of 131 uses left.
// The banking rule sent it to the chest (a pickaxe that cannot dig); the rule for the kit, which read a chest slot
// by the item's name alone, took "a better pickaxe than none" back out; the banking rule sent it in again. Eight
// rounds at one chest in four minutes (「収納 → 収納の確認（CARGO_STORED）」, then TRANSFER_UNCONFIRMED and
// CARGO_REMAINS), the trip given up after 20 attempts, and the ordinary work held up until then.
// The whole trip runs here: player-base.js (what is due), return/* (goal, stages), container-ports.js and
// actions/chest.js over the simulated server (helpers/player-return-sim.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { bankableAll, restockable } = require('../src/modes/player-base-kit')

const feet = { x: 6.5, y: GROUND, z: 1.5 }
const AIR = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
// A raw stack as the server holds it: made in the bag, then moved over.
const stack = (sim, name, count, damage = 0) => { sim.give(35, name, count, damage); const made = structuredClone(sim.bag[35]); sim.bag[35] = structuredClone(AIR); sim.resync(); return made }
const pickaxeRows = sim => sim.inventory().items.filter(item => /_pickaxe$/.test(item.name))

// By the base chest on the surface, after the way home: a worn-out pickaxe, a sword and what was dug.
function scene ({ chestPickaxe = null } = {}) {
  const sim = createReturnSim({ feet, items: [[0, 'stone_sword', 1, 58], [1, 'stone_pickaxe', 1, 131], [2, 'cobblestone', 47], [3, 'dirt', 27], [4, 'tuff', 30], [5, 'bone', 20], [6, 'string', 3], [7, 'emerald', 2], [8, 'stick', 4], [9, 'oak_planks', 5]] })
  const chest = sim.placeChest(5, GROUND, 0)
  sim.shared.playerBase = chest
  if (chestPickaxe) sim.storeOf(chest)[20] = stack(sim, chestPickaxe.name, 1, chestPickaxe.damage)
  sim.worn = { known: true, worn: [] }
  sim.agent.running = true
  return { sim, chest }
}

test('a worn-out pickaxe goes into the base chest once and stays there: the trip ends', async () => {
  const { sim, chest } = scene()
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('tuff') === 0 && !sim.shared.playerReturn, ms: 300000 })
  const log = sim.log.join('\n')
  assert.equal(sim.shared.playerReturn ?? null, null, `the trip ended\n${log}`)
  assert.equal(sim.held('tuff') + sim.held('bone') + sim.held('emerald'), 0, 'the cargo went in')
  assert.equal(sim.stored(chest, 'stone_pickaxe'), 1, `the pickaxe that cannot dig lies in the chest\n${log}`)
  assert.equal(sim.held('stone_pickaxe'), 0)
  const moved = sim.server.requests.length
  assert.ok(moved <= 6, `${moved} transfers for five stacks and one pickaxe\n${log}`)
  assert.equal(sim.log.filter(line => /CARGO_REMAINS|あきらめます|保留/.test(line)).length, 0, log)
  // And no second trip for it: the chest's received slots show a pickaxe that cannot dig.
  const opened = sim.events.filter(event => event.kind === 'open').length
  await sim.run(runtime, { ms: 180000 })
  assert.equal(sim.events.filter(event => event.kind === 'open').length, opened, `no trip for a pickaxe that cannot dig\n${sim.log.join('\n')}`)
  assert.equal(sim.server.requests.length, moved)
})

test('a pickaxe that can dig comes out of the chest, the worn-out one goes in: one transfer each', async () => {
  const { sim, chest } = scene({ chestPickaxe: { name: 'stone_pickaxe', damage: 40 } })
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('tuff') === 0 && !sim.shared.playerReturn, ms: 300000 })
  const log = sim.log.join('\n')
  assert.equal(sim.shared.playerReturn ?? null, null, log)
  assert.deepEqual(pickaxeRows(sim).map(item => item.durabilityRemaining), [91], `the pickaxe in hand is the one with 91 uses left\n${log}`)
  assert.equal(sim.stored(chest, 'stone_pickaxe'), 1, 'the worn-out one lies in the chest')
  assert.ok(sim.server.requests.length <= 7, `${sim.server.requests.length} transfers\n${log}`)
})

// The two rules against each other, without the trip: whatever the kit takes out of a chest, the banking rule
// leaves in hand. Hands and chests of tools in every state of wear.
test('nothing the kit takes out of a chest is banked straight back', () => {
  const USES = { wooden: 59, stone: 131, iron: 250, diamond: 1561 }
  const tool = (slot, name, left) => { const max = USES[name.split('_')[0]]; return { slot, name: `minecraft:${name}`, count: 1, known: true, ...(left == null ? {} : { durabilityKnown: true, maxDurability: max, durabilityUsed: max - left, durabilityRemaining: left }) } }
  const states = name => [0, 2, 3, 60, null].map(left => ({ name, left }))
  const picks = [...states('stone_pickaxe'), ...states('iron_pickaxe'), ...states('wooden_pickaxe')]
  const swords = [...states('stone_sword'), ...states('iron_sword')]
  let cases = 0
  for (const heldPick of [null, ...picks]) for (const heldSword of [null, swords[1], swords[3]]) for (const chestPick of picks) for (const chestSword of [null, ...swords]) {
    const hand = [heldPick && tool(0, heldPick.name, heldPick.left), heldSword && tool(1, heldSword.name, heldSword.left), { slot: 2, name: 'minecraft:cobblestone', count: 40 }].filter(Boolean)
    const slots = [tool(0, chestPick.name, chestPick.left), chestSword && tool(1, chestSword.name, chestSword.left), { slot: 2, known: true, name: 'minecraft:stick', count: 20 }, { slot: 3, known: true, name: 'minecraft:coal', count: 40 }].filter(Boolean)
    const inventory = { known: true, items: hand }, worn = { known: true, worn: [] }
    const wants = restockable(inventory, worn, slots)
    // The hand after the take: each wanted stack in a free slot, with what the chest slot said of it.
    const after = [...hand, ...wants.map((want, index) => ({ ...slots.find(slot => slot.slot === want.chestSlot), slot: 10 + index, count: want.count }))]
    const back = bankableAll({ known: true, items: after }, { worn }).filter(stack => stack.slot >= 10)
    assert.deepEqual(back, [], `hand ${JSON.stringify(hand.map(item => [item.name, item.durabilityRemaining]))}, chest ${JSON.stringify(slots.map(slot => [slot.name, slot.durabilityRemaining]))}: taken out and banked again ${JSON.stringify(back)}`)
    cases++
  }
  assert.ok(cases > 500)
})

// The production reader (inventory/durability.js) on a slot as the chest module describes it, with the item
// as the server sends it (the real item id of a stone pickaxe, the damage in its NBT).
test('a chest slot gets the uses of its tool from the received item, and nothing when they cannot be read', () => {
  const { slotTool } = require('../src/modes/return/chest-tools')
  const slot = { slot: 7, known: true, name: 'minecraft:stone_pickaxe', metadata: 0, count: 1, stackId: 4 }
  const raw = { network_id: 316, count: 1, metadata: 0, has_stack_id: true, stack_id: 4, block_runtime_id: 0, extra: { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 131 } } } }, can_place_on: [], can_destroy: [] } }
  const seen = slotTool(slot, () => raw)
  assert.deepEqual([seen.durabilityKnown, seen.maxDurability, seen.durabilityUsed, seen.durabilityRemaining], [true, 131, 131, 0])
  for (const field of Object.keys(slot)) assert.equal(seen[field], slot[field], `the slot keeps what the chest module said of its ${field}`)
  // With these uses the kit leaves it in the chest; with no reading it is taken as before.
  const hand = { known: true, items: [{ slot: 0, name: 'minecraft:cobblestone', count: 8 }] }, worn = { known: true, worn: [] }
  assert.deepEqual(restockable(hand, worn, [seen]), [])
  assert.deepEqual(restockable(hand, worn, [slot]), [{ chestSlot: 7, name: 'minecraft:stone_pickaxe', count: 1 }])
  // Not read: another stack than the slot describes, no item, a slot not received, not a tool.
  assert.equal(slotTool(slot, () => ({ ...raw, stack_id: 9 })), slot)
  assert.equal(slotTool(slot, () => null), slot)
  assert.equal(slotTool(slot, () => { throw new Error('closed') }), slot)
  const unknown = { ...slot, known: false }, stone = { slot: 1, known: true, name: 'minecraft:cobblestone', count: 64, stackId: 5 }
  assert.equal(slotTool(unknown, () => raw), unknown)
  assert.equal(slotTool(stone, () => assert.fail('not asked for a block')), stone)
})
