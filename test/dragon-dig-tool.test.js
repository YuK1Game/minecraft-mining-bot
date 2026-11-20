'use strict'

// Rock on the way to ore is dug with the cheapest pickaxe that mines it, and the expedition makes a stone one for
// that from what it carries (src/modes/dig-tool.js; player-scaffold-ports.js `pick`, `mine`; dragon-supply-gather.js
// `collect`; dragon-supplies.js `acquire`).
// Real Realm 2026-11-20 15:00:27-15:10:54 JST (main 8c21768): the only pickaxe was iron. The walks to coal near the
// surface (y 61-69: stone 484, dirt 437, grass 200 in the received area) dug every block with it:
// 177 uses left at 15:00:27, 53 at 15:10:38, for four iron ingots. In the bag: 140 cobblestone, 3 sticks, a crafting
// table. A stone pickaxe is three cobblestone and two sticks.
// The blocks are a tunnel received earlier the same day (test/fixtures/mine-tunnel-ore-in-view.json, 14:28:34 JST).
// Real here: the supplies (`acquire`: the pickaxe made, the table put down, `collect`), the route to the ore, the
// dig-and-stack walk, the scaffold's hands, station-room.js, player-storage-ports.js (the craft, the placement),
// the navigation's planner and physics, the goal's ledger. Stand-ins: the server (helpers/dig-world.js: the hand, a
// use a block), the crafting window and the placement's answer. Its success is not the game's.
const test = require('node:test')
const assert = require('node:assert/strict')
const { digTool, diggerWanted } = require('../src/modes/dig-tool')
const { collect } = require('../src/modes/dragon-supply-gather')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')
const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
const { count } = require('../src/modes/dragon-supply-kit')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/mine-tunnel-ore-in-view.json')

const full = name => 'minecraft:' + name
const pick = (slot, kind, left) => ({ slot, name: full(kind + '_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: left })
const sword = slot => ({ slot, name: full('stone_sword'), count: 1, durabilityKnown: true, durabilityRemaining: 89 })
const left = (items, name) => items.find(item => item.name === full(name) && item.count > 0)?.durabilityRemaining

test('the pickaxe for a block is the working one of the lowest tier that mines it', () => {
  const items = [pick(0, 'iron', 53), pick(1, 'stone', 131), sword(2), pick(3, 'stone', 2), pick(4, 'wooden', 40)]
  const of = (name, rows = items) => digTool(rows, name)?.name?.replace('minecraft:', '') ?? null
  assert.equal(of('minecraft:stone'), 'wooden_pickaxe')
  assert.equal(of('minecraft:dirt'), 'wooden_pickaxe', 'a block no tool is needed for keeps the cheap pickaxe in the hand')
  assert.equal(of('minecraft:coal_ore'), 'wooden_pickaxe')
  assert.equal(of('minecraft:iron_ore'), 'stone_pickaxe')
  assert.equal(digTool(items, 'minecraft:iron_ore').slot, 1, 'not the stone pickaxe with two uses left')
  assert.equal(of('minecraft:diamond_ore'), 'iron_pickaxe')
  assert.equal(of('minecraft:obsidian'), null, 'nothing here mines obsidian')
  assert.equal(of('minecraft:mob_spawner'), null, 'a block with no dig rule has no answer: the caller keeps its old choice')
  assert.equal(of(null), 'wooden_pickaxe')
  assert.equal(of('minecraft:stone', [pick(0, 'iron', 53)]), 'iron_pickaxe', 'the only pickaxe is the one used')
  assert.equal(of('minecraft:stone', [sword(0)]), null)
})

test('of two pickaxes alike the one in the hand stays there', () => {
  const items = [pick(0, 'iron', 100), pick(1, 'iron', 240), pick(2, 'stone', 2)]
  assert.equal(digTool(items, 'minecraft:stone').slot, 1, 'with no hand known: the one with more uses left')
  assert.equal(digTool(items, 'minecraft:stone', items[0]).slot, 0, 'the one in the hand is kept')
  assert.equal(digTool(items, 'minecraft:stone', items[2]).slot, 1, 'a worn one in the hand is not')
  assert.equal(digTool([pick(0, 'iron', 100), pick(1, 'stone', 60)], 'minecraft:stone', pick(0, 'iron', 100)).slot, 1, 'a better one in the hand gives way to the cheaper')
  assert.equal(digTool(items, 'minecraft:stone', sword(5)).slot, 1)
})

// A patch of ground: grass on dirt on stone, the Bot standing on it; beside the feet a dirt block and a stone block
// lie open in the top layer (GRASS, DIRT, STONE below).
const ground = () => ({ x0: 0, z0: 0, feet: { x: 2.5, y: 66, z: 2.5 }, legend: { '.': 'air', G: 'grass_block', d: 'dirt', S: 'stone' },
  rows: { 63: Array(5).fill('SSSSS'), 64: Array(5).fill('ddddd'), 65: ['GGGGG', 'GGGGG', 'GGGSG', 'GGdGG', 'GGGGG'], 66: Array(5).fill('.....'), 67: Array(5).fill('.....'), 68: Array(5).fill('.....') } })
const GRASS = { x: 1, y: 65, z: 2 }, DIRT = { x: 2, y: 65, z: 3 }, STONE = { x: 3, y: 65, z: 2 }
const stack = (slot, name, n = 32) => ({ slot, name: full(name), count: n })

test('dirt costs nothing with no tool in the hand, and the hand is left alone', async () => {
  const items = [stack(0, 'cobblestone'), pick(1, 'iron', 53), pick(2, 'stone', 131)]
  const w = createDigWorld(ground(), { items })
  assert.equal(await w.ctx.hands.mine(GRASS), true)
  assert.equal(await w.ctx.hands.mine(DIRT), true)
  assert.deepEqual(w.minedNames, ['grass_block', 'dirt'])
  assert.deepEqual(w.uses, {})
  assert.equal(w.swaps, 0)
})

test('dirt is not dug with the iron pickaxe while a stone one is carried; rock after it needs no second swap', async () => {
  const items = [pick(0, 'iron', 53), pick(1, 'stone', 131)]
  const w = createDigWorld(ground(), { items })
  for (const cell of [GRASS, DIRT, STONE]) assert.equal(await w.ctx.hands.mine(cell), true, w.ctx.hands.why())
  assert.deepEqual(w.minedNames, ['grass_block', 'dirt', 'stone'])
  assert.deepEqual(w.uses, { stone_pickaxe: 3 })
  assert.equal(w.swaps, 1)
  assert.equal(left(items, 'iron_pickaxe'), 53)
})

test('a sword in the hand is not changed for the only, better pickaxe to dig dirt; rock is', async () => {
  const items = [sword(0), pick(1, 'iron', 53)]
  const w = createDigWorld(ground(), { items })
  assert.equal(await w.ctx.hands.mine(GRASS), true)
  assert.equal(await w.ctx.hands.mine(DIRT), true)
  assert.equal(w.swaps, 0)
  assert.equal(left(items, 'iron_pickaxe'), 53)
  // Rock: the callers put the pickaxe in the hand when the mining check refuses the sword (as before).
  assert.equal(w.ctx.hands.canMine(STONE), false)
  assert.equal(await w.ctx.hands.pick(STONE), true)
  assert.equal(await w.ctx.hands.mine(STONE), true)
  assert.equal(w.swaps, 1)
  assert.equal(w.uses.iron_pickaxe, 1)
})

test('a stone pickaxe is wanted for digging when rock would be dug with a better one and the parts are carried', () => {
  const held = rows => name => count(name, rows)
  const parts = [{ slot: 5, name: full('cobblestone'), count: 64 }, { slot: 6, name: full('stick'), count: 3 }]
  const want = rows => diggerWanted(rows, held(rows))
  assert.equal(want([pick(0, 'iron', 53), ...parts]), true)
  assert.equal(want([pick(0, 'iron', 53), pick(1, 'stone', 2), ...parts]), true, 'a stone pickaxe with two uses left is not a digging pickaxe')
  assert.equal(want([pick(0, 'iron', 53), pick(1, 'stone', 60), ...parts]), false)
  assert.equal(want([pick(0, 'stone', 60), ...parts]), false)
  assert.equal(want([pick(0, 'iron', 53), parts[0]]), false, 'no sticks, planks or log: nothing is fetched for it')
  assert.equal(want([pick(0, 'iron', 53), parts[0], { slot: 6, name: full('oak_planks'), count: 2 }]), true)
  assert.equal(want([pick(0, 'iron', 53), { slot: 5, name: full('cobblestone'), count: 2 }, parts[1]]), false)
  assert.equal(want([sword(0), ...parts]), false, 'with no pickaxe at all the first pickaxe is another step')
})

// Before (main 8c21768, the same scenes): 23 blocks, all 23 with the iron pickaxe, the stone one unused.
test('with a stone pickaxe carried, the tunnel to the coal is dug with it; the iron one loses nothing', async () => {
  for (const items of [[pick(0, 'iron', 177), pick(1, 'stone', 131)], [sword(0), pick(1, 'iron', 177), pick(2, 'stone', 131)]]) {
    const w = createDigWorld(received, { items })
    for (let i = 0; i < 6; i++) await collect(w.ctx, 'coal')
    const log = w.lines.join('\n')
    assert.ok(w.count('coal') >= 6, `${w.count('coal')}\n${log}`)
    assert.ok(w.minedNames.length >= 15, String(w.minedNames.length))
    assert.deepEqual(w.uses, { stone_pickaxe: w.minedNames.length }, log)
    assert.equal(left(items, 'iron_pickaxe'), 177)
    // One swap puts it in the hand; no swapping back and forth between the ticks.
    assert.equal(w.swaps, 1)
  }
})

// As at 15:18:38 JST: the iron pickaxe with 53 uses in the hand, a stone sword, cobblestone, three sticks, a table.
function live ({ sticks = 3, craftFails = false } = {}) {
  const items = [pick(0, 'iron', 53), sword(1), { slot: 2, name: full('crafting_table'), count: 1 }, { slot: 3, name: full('cobblestone'), count: 64 }, { slot: 4, name: full('cobblestone'), count: 64 }, { slot: 5, name: full('cobblestone'), count: 12 }, ...(sticks ? [{ slot: 6, name: full('stick'), count: sticks }] : [])]
  const w = createDigWorld(received, { items })
  const take = (name, n) => { for (const row of items) { if (row.name !== full(name) || !row.count) continue; const part = Math.min(n, row.count); row.count -= part; n -= part } if (n) throw new Error('材料が不足しています: ' + name) }
  const free = () => { for (let slot = 0; ; slot++) if (!items.some(item => item.slot === slot && item.count > 0)) return slot }
  w.crafted = []; w.tables = []
  let open = null
  Object.assign(w.ctx.operations, {
    crafting: {
      closeContainer () { open = null },
      openInventory: async () => { open = 'inventory' },
      craft: async output => {
        if (craftFails) throw new Error('サーバーから受信したレシピがありません: ' + output)
        assert.equal(output, full('stone_pickaxe'))
        assert.equal(open, 'table', 'a pickaxe is made at a table')
        take('cobblestone', 3); take('stick', 2)
        items.push({ ...pick(free(), 'stone', 131) })
        w.crafted.push(output)
      }
    },
    interactions: {
      openCraftingTable: async at => {
        const feet = w.ctx.getFeet()
        assert.equal(w.getBlock(at.x, at.y, at.z).name, full('crafting_table'))
        assert.ok(Math.hypot(at.x + 0.5 - feet.x, at.y - feet.y, at.z + 0.5 - feet.z) <= 5)
        open = 'table'
      },
      // An ordinary placement: the block is received and the item leaves the bag.
      placeBlock: async ({ position, slot }) => { const row = items.find(item => item.slot === slot && item.count > 0); row.count--; w.put(position, row.name.replace('minecraft:', '')); w.tables.push(position) }
    }
  })
  const shared = {}
  const ledger = createGoalLedger({ shared, now: () => w.at, world: () => 'w', restore: () => null })
  ledger.open('early.home_reserve')
  ledger.look({ scope: 's' })
  Object.assign(w.ctx, { shared, goal: { ...w.ctx.goal, fail: (failure, options) => { w.failures.push(failure); return ledger.fail(failure, options) }, spent: failure => ledger.spent(failure) } })
  w.items = items
  // One look of the expedition's two-second timer: a new step with the same goal.
  w.look = async (name, target) => { const out = await createDragonSupplies(w.ctx).acquire(name, target); w.at += 2000; return out }
  return w
}
const MADE = /岩を掘るための石のツルハシを作りました/

test('the live bag: a stone pickaxe is made first, and the coal is dug with it', async () => {
  const w = live()
  let out = null, looks = 0
  for (; looks < 30 && !out?.done; looks++) out = await w.look('coal', 4)
  const log = w.lines.join('\n')
  assert.equal(out?.done, true, `${out?.reason}\n${log}`)
  assert.equal(w.count('coal') >= 4, true)
  assert.deepEqual(w.crafted, [full('stone_pickaxe')], log)
  assert.equal(w.lines.filter(line => MADE.test(line)).length, 1, log)
  assert.equal(w.tables.length, 1, 'the carried table was put down once')
  assert.equal(count('stick', w.items), 1)
  // The iron pickaxe: at most the one block of the niche for the table, before the stone one was there.
  assert.ok((w.uses.iron_pickaxe ?? 0) <= 1, JSON.stringify(w.uses))
  assert.ok(left(w.items, 'iron_pickaxe') >= 52)
  assert.ok(w.uses.stone_pickaxe >= 10, JSON.stringify(w.uses))
  assert.equal(w.swaps, 1, 'the new pickaxe goes into the hand once and stays there')
  assert.equal(w.failures.length, 0)
})

test('with no sticks nothing is fetched for it: the coal is dug with the iron pickaxe as before', async () => {
  const w = live({ sticks: 0 })
  let out = null
  for (let looks = 0; looks < 30 && !out?.done; looks++) out = await w.look('coal', 4)
  assert.equal(out?.done, true, `${out?.reason}\n${w.lines.join('\n')}`)
  assert.deepEqual(w.crafted, [])
  assert.equal(w.tables.length, 0)
  assert.equal(w.trips.length, 0)
  assert.ok(w.uses.iron_pickaxe >= 10, JSON.stringify(w.uses))
})

test('a stone pickaxe that cannot be made is left after three tries, and the digging goes on', async () => {
  const w = live({ craftFails: true })
  let out = null, looks = 0
  for (; looks < 60 && !out?.done; looks++) out = await w.look('coal', 4)
  const log = w.lines.join('\n')
  assert.equal(out?.done, true, `${out?.reason}\n${log}`)
  assert.equal(w.failures.filter(failure => failure.stage === 'digger').length >= 3, true, JSON.stringify(w.failures))
  assert.equal(w.lines.filter(line => MADE.test(line)).length, 0)
  assert.ok(w.uses.iron_pickaxe >= 10, JSON.stringify(w.uses))
})
