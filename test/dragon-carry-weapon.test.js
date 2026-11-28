'use strict'

// The expedition carries a weapon: with none in the bag a stone sword is made of what is carried before other work
// (src/modes/carry-weapon.js; dragon-supplies.js `weapon`, `arm`; the step's order in dragon-runtime.js).
// Real Realm 2026-11-20 JST (house at (9877,64,10138), goal early.home_reserve): the stone sword had 37 uses at
// 20:32 and struck its last blow at 21:10:23. Until 21:39 the bag held no weapon, with more than 160 cobblestone,
// sticks and a crafting table in it; no plan made another. 21:34:57 「武器がないため敵から離れます（体力 19.8、
// creeper 7.5m）」, 21:35:00 the blast, 21:35:06 dead.
// The ground is the forest floor received the same day (test/fixtures/tree-top-stuck.json).
// Real here: the expedition's runtime (dragon-runtime.js: the step's order, the goal's ledger, the saved record),
// the supplies (`acquire`: the sticks, the table put down, the sword), the gathering and the tree (`collect`,
// dragon-tree.js), station-room.js, player-storage-ports.js, the scaffold's hands, the navigation's planner and
// physics. Stand-ins: the early step (it only says it does its next work), the server (helpers/dig-world.js), the
// crafting window and the placement's answer (helpers/dig-bench.js). Their success is not the game's.
// Before (main b87268a, the first scene): the next work begins at the first look and goes on for the whole minute
// with no weapon in the bag; nothing is made.
const test = require('node:test')
const assert = require('node:assert/strict')
const { weaponWanted } = require('../src/modes/carry-weapon')
const { count } = require('../src/modes/dragon-supply-kit')
const { createDigWorld } = require('./helpers/dig-world')
const { attachBench } = require('./helpers/dig-bench')
const { createWorld } = require('./helpers/dragon-goal-world')
const forest = require('./fixtures/tree-top-stuck.json')

const full = name => 'minecraft:' + name
const within = (x, z) => x >= forest.x0 && x <= forest.x0 + 14 && z >= forest.z0 && z <= forest.z0 + 14
const pick = (slot, kind, left) => ({ slot, name: full(kind + '_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: left })
const stack = (slot, name, n) => ({ slot, name: full(name), count: n })
const MADE = /武器がないため、石の剣を作りました/, WOOD = /石の剣にする木も足りないため、先に原木を1本取ります/, NO_WOOD = /石の剣にする木が近くに見つからないため/
// As at 20:42 JST, without the sword: the two pickaxes, cobblestone, two sticks, a crafting table.
const BAG = () => [pick(0, 'stone', 19), pick(1, 'iron', 12), stack(2, 'crafting_table', 1), stack(3, 'cobblestone', 64), stack(4, 'cobblestone', 64), stack(5, 'cobblestone', 32), stack(6, 'stick', 2)]

// The expedition over the forest floor. Its early step is "the next work": it notes what the bag held when it began.
async function expedition (t, { bag = BAG(), underground = false, craftFails = false } = {}) {
  const scene = underground ? { ...forest, rows: Object.fromEntries(Object.entries(forest.rows).filter(([y]) => Number(y) <= 67).map(([y, rows]) => [y, rows.map(row => row.replace(/[OB]/g, 'S'))])) } : forest
  const dig = createDigWorld({ ...scene, feet: { x: 9887.5, y: 65, z: 10158.5 } }, { items: bag, logs: true, outside: (x, y, z) => within(x, z) ? (y < 63 || underground ? 'stone' : 'air') : null })
  attachBench(dig, bag, { craftFails })
  const swords = () => count('stone_sword', bag)
  const w = await createWorld(t, {
    items: bag, getBlock: dig.getBlock,
    live: () => ({ position: dig.ctx.getFeet(), inventory: dig.ctx.runtime.inventory(), heldItem: dig.ctx.runtime.raw().heldItem }),
    ports: (signal, shared) => ({ ...dig.ctx, shared, cancelled: () => signal.aborted, log: line => w.lines.push(line), goal: undefined }),
    step: async () => { w.next ??= { swords: swords(), at: w.at }; w.looks = (w.looks ?? 0) + 1; return { done: false, reason: '次の作業をしています。' } }
  })
  Object.assign(w, { dig, bag, swords })
  return w
}

test('a stone sword is wanted with no weapon in the bag and the cobblestone for one: made from the parts, or wood first', () => {
  const held = rows => name => count(name, rows)
  const want = (rows, table = true) => weaponWanted(rows, held(rows), { table: () => table })
  const cobble = stack(5, 'cobblestone', 64), sticks = stack(6, 'stick', 2)
  assert.equal(want([pick(0, 'iron', 12), cobble, sticks]), 'make')
  assert.equal(want([pick(0, 'iron', 12), cobble]), 'wood', 'no stick, plank or log')
  assert.equal(want([pick(0, 'iron', 12), cobble, stack(6, 'oak_planks', 2)]), 'make')
  assert.equal(want([pick(0, 'iron', 12), cobble, stack(6, 'oak_log', 1)]), 'make')
  // With no table carried or near, the wood for a table as well.
  assert.equal(want([pick(0, 'iron', 12), cobble, sticks], false), 'wood')
  assert.equal(want([pick(0, 'iron', 12), cobble, sticks, stack(7, 'oak_planks', 4)], false), 'make')
  assert.equal(want([pick(0, 'iron', 12), cobble, stack(7, 'oak_log', 1)], false), 'wood', 'four planks: the stick or the table')
  assert.equal(want([pick(0, 'iron', 12), cobble, stack(7, 'oak_log', 2)], false), 'make')
  // A weapon in the bag (the flight's reading: a sword, an axe, a bow), or no cobblestone for one.
  for (const weapon of ['stone_sword', 'wooden_sword', 'iron_axe', 'bow']) assert.equal(want([stack(0, weapon, 1), cobble, sticks]), false, weapon)
  assert.equal(want([pick(0, 'iron', 12), stack(5, 'cobblestone', 1), sticks]), false)
  assert.equal(weaponWanted(null, () => 0), false)
  // The table is asked of a bag that wants a sword only (a scan of the blocks around the feet).
  assert.equal(weaponWanted([stack(0, 'stone_sword', 1), cobble], held([cobble]), { table: () => assert.fail('asked') }), false)
})

test('the live bag without its sword: a stone sword is made before the next work begins', async t => {
  const w = await expedition(t)
  assert.equal(w.swords(), 0)
  await w.pass(60000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.ok(w.next, `the next work was reached\n${log}`)
  assert.equal(w.next.swords, 1, `swords in the bag when the next work began\n${log}`)
  assert.deepEqual(w.dig.crafted, [full('stone_sword')], log)
  assert.equal(w.dig.tables.length, 1, 'the carried table was put down once')
  assert.equal(w.said(MADE).length, 1, log)
  assert.equal(count('stick', w.bag), 1)
  assert.ok(w.next.at - 1e9 <= 10000, `within a few looks: ${w.next.at - 1e9} ms`)
  assert.ok(w.looks >= 20, 'the work goes on after it')
})

test('with a weapon in the bag nothing is made', async t => {
  for (const weapon of ['stone_sword', 'iron_axe']) {
    const w = await expedition(t, { bag: [...BAG(), { slot: 7, name: full(weapon), count: 1, durabilityKnown: true, durabilityRemaining: 40 }] })
    await w.pass(20000, { tickMs: 2000 })
    assert.deepEqual(w.dig.crafted, [], weapon)
    assert.equal(w.dig.tables.length, 0)
    assert.equal(w.looks, 10, 'every look is the work')
  }
})

test('no stick, plank or log under the open sky: a log is taken, its tree cut down, and the sword made', async t => {
  const w = await expedition(t, { bag: BAG().filter(row => row.name !== full('stick')) })
  await w.pass(120000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.ok(w.next, `the next work was reached\n${log}`)
  assert.equal(w.next.swords, 1, log)
  assert.equal(w.said(WOOD).length, 1, log)
  assert.equal(w.said(MADE).length, 1, log)
  assert.deepEqual(w.dig.crafted.filter(output => !/_planks$/.test(output)), [full('stick'), full('stone_sword')], log)
  assert.ok(w.dig.minedNames.filter(name => !/_log$/.test(name)).every(name => /_leaves$/.test(name)), w.dig.minedNames.join(' '))
  // The tree that log came from is not left half cut (dragon-tree.js).
  assert.equal(w.said(/木を1本伐り終えました/).length, 1, log)
  assert.equal(w.shared.playerTree, undefined)
})

test('underground with no wood and no log in view nothing is fetched: the work goes on, and nothing is counted as failed', async t => {
  const w = await expedition(t, { bag: BAG().filter(row => row.name !== full('stick')), underground: true })
  await w.pass(20000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.equal(w.looks, 10, log)
  assert.deepEqual(w.dig.crafted, [])
  assert.equal(w.dig.minedNames.length, 0, w.dig.minedNames.join(' '))
  assert.equal(w.said(WOOD).length + w.said(NO_WOOD).length, 0, log)
})

test('with an enemy near and the parts carried the sword is still made (an unarmed Bot among zombies does not wait)', async t => {
  const w = await expedition(t)
  w.threatened = true
  await w.pass(20000, { tickMs: 2000 })
  assert.equal(w.swords(), 1, w.lines.join('\n'))
})

test('a sword that cannot be made is left after three counted tries, and the work goes on', async t => {
  const w = await expedition(t, { craftFails: true })
  await w.pass(60000, { tickMs: 2000 })
  // A try a look; the ledger counts one failure in fifteen seconds, and the third leaves the way.
  const asked = w.dig.asked.length
  assert.ok(asked >= 3 && asked <= 24, String(asked))
  assert.ok(w.dig.asked.every(output => output === full('stone_sword')))
  assert.equal(w.dig.tables.length, 1)
  assert.ok(w.next, `the next work was reached\n${w.lines.join('\n')}`)
  const looks = w.looks
  await w.pass(120000, { tickMs: 2000 })
  assert.equal(w.dig.asked.length, asked, 'not tried again')
  assert.equal(w.looks, looks + 60, 'every look is the work')
  assert.equal(w.swords(), 0)
  assert.equal(w.said(MADE).length, 0)
})
