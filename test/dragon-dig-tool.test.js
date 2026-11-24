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
const { attachBench } = require('./helpers/dig-bench')
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
  assert.equal(digTool(items, 'minecraft:iron_ore').slot, 3, 'iron-or-below tools are disposable: finish the 2-use stone pickaxe first to free inventory slots')
  assert.equal(digTool([pick(0, 'diamond', 2), pick(1, 'diamond', 50)], 'minecraft:obsidian').slot, 1, 'diamond pickaxes keep their 2-use durability reserve')
  assert.equal(of('minecraft:diamond_ore'), 'iron_pickaxe')
  assert.equal(of('minecraft:obsidian'), null, 'nothing here mines obsidian')
  assert.equal(of('minecraft:mob_spawner'), null, 'a block with no dig rule has no answer: the caller keeps its old choice')
  assert.equal(of(null), 'wooden_pickaxe')
  assert.equal(of('minecraft:stone', [pick(0, 'iron', 53)]), 'iron_pickaxe', 'the only pickaxe is the one used')
  assert.equal(of('minecraft:stone', [sword(0)]), null)
})

test('of two pickaxes alike the one in the hand stays there', () => {
  const items = [pick(0, 'iron', 100), pick(1, 'iron', 240), pick(2, 'diamond', 2)]
  assert.equal(digTool(items, 'minecraft:stone').slot, 0, 'for disposable iron picks, the lower-durability one is finished first')
  assert.equal(digTool(items, 'minecraft:stone', items[1]).slot, 1, 'the one in the hand is kept')
  assert.equal(digTool([pick(0, 'diamond', 100), pick(1, 'diamond', 240), pick(2, 'diamond', 2)], 'minecraft:obsidian', pick(2, 'diamond', 2)).slot, 1, 'a worn diamond pick in the hand is not kept')
  assert.equal(digTool([pick(0, 'iron', 100), pick(1, 'stone', 60)], 'minecraft:stone', pick(0, 'iron', 100)).slot, 1, 'a better one in the hand gives way to the cheaper')
  assert.equal(digTool(items, 'minecraft:stone', sword(5)).slot, 0)
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

test('a stone pickaxe is wanted for digging when rock would be dug with a better one: made from the parts, or wood first', () => {
  const held = rows => name => count(name, rows)
  const parts = [{ slot: 5, name: full('cobblestone'), count: 64 }, { slot: 6, name: full('stick'), count: 3 }]
  const want = rows => diggerWanted(rows, held(rows))
  assert.equal(want([pick(0, 'iron', 53), ...parts]), 'make')
  assert.equal(want([pick(0, 'iron', 53), { slot: 1, name: full('stone_pickaxe'), count: 1, durabilityKnown: false, durabilityRemaining: null }, ...parts]), 'make', 'a stone pickaxe with unknown durability is not a digging pickaxe')
  assert.equal(want([pick(0, 'iron', 53), pick(1, 'stone', 0), ...parts]), false, 'a disposable stone pickaxe at Bedrock last use (0) is still finished before crafting another')
  assert.equal(want([pick(0, 'iron', 53), pick(1, 'stone', 2), ...parts]), false, 'a disposable stone pickaxe with 2 uses left is still used before crafting another')
  assert.equal(want([pick(0, 'iron', 53), pick(1, 'stone', 60), ...parts]), false)
  assert.equal(want([pick(0, 'stone', 60), ...parts]), false)
  assert.equal(want([pick(0, 'iron', 53), parts[0]]), 'wood', 'no sticks, planks or log: the wood is what is missing')
  assert.equal(want([pick(0, 'iron', 53), { slot: 1, name: full('stone_pickaxe'), count: 1, durabilityKnown: false, durabilityRemaining: null }, parts[0]]), 'wood')
  assert.equal(want([pick(0, 'iron', 53), parts[0], { slot: 6, name: full('oak_planks'), count: 2 }]), 'make')
  assert.equal(want([pick(0, 'iron', 53), parts[0], { slot: 6, name: full('oak_log'), count: 1 }]), 'make')
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
// `scene`, `bag`, `world`: another received box, another bag (wood.test below).
function live ({ sticks = 3, craftFails = false, scene = received, bag = null, world = {} } = {}) {
  const items = bag ?? [pick(0, 'iron', 53), sword(1), { slot: 2, name: full('crafting_table'), count: 1 }, { slot: 3, name: full('cobblestone'), count: 64 }, { slot: 4, name: full('cobblestone'), count: 64 }, { slot: 5, name: full('cobblestone'), count: 12 }, ...(sticks ? [{ slot: 6, name: full('stick'), count: sticks }] : [])]
  const w = createDigWorld(scene, { items, ...world })
  attachBench(w, items, { craftFails })
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
const MADE = /岩を掘るための石のツルハシを作りました/, WOOD = /掘り始める前に原木を1本取ります/, NO_WOOD = /木が近くに見つからないため/

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

test('underground with no sticks and no log in view nothing is fetched: the coal is dug with the iron pickaxe as before', async () => {
  const w = live({ sticks: 0 })
  let out = null
  for (let looks = 0; looks < 30 && !out?.done; looks++) out = await w.look('coal', 4)
  assert.equal(out?.done, true, `${out?.reason}\n${w.lines.join('\n')}`)
  assert.deepEqual(w.crafted, [])
  assert.equal(w.tables.length, 0)
  assert.equal(w.trips.length, 0)
  assert.ok(w.uses.iron_pickaxe >= 10, JSON.stringify(w.uses))
  assert.equal(w.failures.length, 0, 'nothing was tried, so nothing failed')
  assert.equal(w.lines.filter(line => WOOD.test(line)).length, 0)
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

// Real Realm 2026-11-20 17:50:41-17:56:30 JST (main fb6ec4c): for the iron of a chestplate the Bot dug stairs from
// y 66 down to y 44 (the dig-and-stack walks: 123 blocks) and a shaft back up (24 levels), all with the iron pickaxe:
// 177 uses at 17:51:03, 28 at 17:56:06; at 18:10 it was gone. No line 「岩を掘るための石のツルハシ」. The bag at
// 17:33: iron pickaxe, a stone pickaxe with two uses, 299 cobblestone, a crafting table, raw iron 3, an iron ingot;
// no stick, plank or log (none at 18:10 either).
// The ground here is the forest floor received the same day 50 m from there (test/fixtures/tree-top-stuck.json:
// oaks and birches, grass, dirt, stone from y 63 down), the Bot on the grass three blocks from an oak.
// Before (main fb6ec4c, this scene): 12 looks dig 63 blocks, all 63 with the iron pickaxe; nothing is made.
// After: one log, planks, sticks, the stone pickaxe (looks 1-4); 32 blocks with it in the next 8 looks, the iron
// pickaxe one use (the log, with it in the hand).
// Only the supplies are looked at here: the tree that log belongs to is finished by the runtime's step before the
// next work (dragon-tree.js, test/dragon-whole-tree.test.js).
const forest = require('./fixtures/tree-top-stuck.json')
const within = (x, z) => x >= forest.x0 && x <= forest.x0 + 14 && z >= forest.z0 && z <= forest.z0 + 14
function surface ({ underground = false } = {}) {
  const bag = [pick(0, 'iron', 177), { slot: 2, name: full('crafting_table'), count: 1 }, { slot: 3, name: full('raw_iron'), count: 3 }, { slot: 4, name: full('iron_ingot'), count: 1 },
    ...[64, 64, 43, 64, 64].map((n, i) => ({ slot: 5 + i, name: full('cobblestone'), count: n }))]
  // underground: the same ground with rock over everything from y 68 up (the trees are cut off at the trunk).
  const scene = underground ? { ...forest, rows: Object.fromEntries(Object.entries(forest.rows).filter(([y]) => Number(y) <= 67).map(([y, rows]) => [y, rows.map(row => row.replace(/[OB]/g, 'S'))])) } : forest
  return live({ scene: { ...scene, feet: { x: 9887.5, y: 65, z: 10158.5 } }, bag, world: { logs: true, outside: (x, y, z) => within(x, z) ? (y < 63 || underground ? 'stone' : 'air') : null } })
}

test('under the open sky with no wood in the bag: a log is taken first, the stone pickaxe made, and the rock dug with it', async () => {
  const w = surface()
  for (let looks = 0; looks < 12; looks++) await w.look('raw_iron', 8)
  const log = w.lines.join('\n')
  assert.equal(w.lines.filter(line => WOOD.test(line)).length, 1, log)
  assert.equal(w.lines.filter(line => MADE.test(line)).length, 1, log)
  assert.deepEqual(w.crafted, [full('oak_planks'), full('stick'), full('stone_pickaxe')], log)
  assert.equal(w.minedNames.filter(name => /_log$/.test(name)).length, 1, 'one log')
  assert.ok(w.minedNames.every(name => !/leaves/.test(name)), w.minedNames.join(' '))
  // The mine goes down after it, with the stone pickaxe.
  const rock = w.minedNames.filter(name => !/_log$/.test(name)).length
  assert.ok(rock >= 8, `${rock}\n${log}`)
  assert.ok(w.cell().y < 65, JSON.stringify(w.cell()))
  // The iron pickaxe: the log at most (it was in the hand), and the block of a niche for the table.
  assert.ok((w.uses.iron_pickaxe ?? 0) <= 2, JSON.stringify(w.uses))
  assert.ok(w.uses.stone_pickaxe >= 8, JSON.stringify(w.uses))
  assert.equal(count('stick', w.items), 2, 'two sticks are left for the next one')
  assert.equal(count('planks', w.items), 2)
  assert.equal(w.failures.filter(failure => failure.stage === 'digger').length, 0)
})

test('under rock with no log in view nothing is fetched, and where no tree is found the search ends after three tries', async () => {
  // Under rock: the look goes straight to the digging.
  const below = surface({ underground: true })
  for (let looks = 0; looks < 6; looks++) await below.look('raw_iron', 8)
  assert.equal(below.lines.filter(line => WOOD.test(line)).length, 0, below.lines.join('\n'))
  assert.equal(below.failures.filter(failure => failure.stage === 'digger').length, 0)
  assert.ok(below.uses.iron_pickaxe >= 4, JSON.stringify(below.uses))
  // Under the open sky with every tree out of what is received: the search for one is three paced tries, then the
  // digging goes on with the iron pickaxe.
  const bare = surface()
  const none = { ...forest, feet: { x: 9887.5, y: 65, z: 10158.5 }, rows: Object.fromEntries(Object.entries(forest.rows).map(([y, rows]) => [y, rows.map(row => row.replace(/[OBob]/g, '.'))])) }
  const w = live({ scene: none, bag: bare.items, world: { logs: true, outside: (x, y, z) => within(x, z) ? (y < 63 ? 'stone' : 'air') : null } })
  for (let looks = 0; looks < 60; looks++) await w.look('raw_iron', 8)
  const log = w.lines.join('\n')
  assert.equal(w.lines.filter(line => WOOD.test(line)).length, 1, log)
  assert.equal(w.lines.filter(line => NO_WOOD.test(line)).length, 1, log)
  // (w.failures: every look that asked; the ledger counts one per twenty seconds, and three end it.)
  const asked = w.failures.filter(failure => failure.stage === 'digger')
  assert.ok(asked.length >= 3 && asked.every(failure => failure.target === 'log' && failure.code === 'NOT_FOUND'), JSON.stringify(asked))
  assert.ok(asked.length <= 30, `the search lasts under a minute of looks: ${asked.length}`)
  assert.deepEqual(w.crafted, [])
  assert.ok(w.uses.iron_pickaxe >= 4, `${JSON.stringify(w.uses)}\n${log}`)
})
