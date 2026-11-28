'use strict'

// Exercise the real food step and house ports. Only terrain, operations and
// received inventory changes are supplied by the test world.
const test = require('node:test')
const assert = require('node:assert/strict')
const { provisionFood } = require('../src/modes/dragon-early-food')
const { createHouseWorld } = require('./helpers/house-world')

test('raw meat beside three wheat uses the table and receives bread before fetching fuel', async () => {
  const world = createHouseWorld({ x: 0, y: 64, z: 0 })
  const table = world.pick('crafting_table')[0]
  const calls = [], items = [{ slot: 0, name: 'minecraft:beef', count: 1 }, { slot: 1, name: 'minecraft:wheat', count: 3 }]
  let clock = 0
  const ctx = {
    shared: { playerHouse: { origin: world.origin, done: true } }, memory: {}, cancelled: () => false,
    getBlock: world.getBlock, getFeet: () => world.beside(table.id), hands: { walk: async () => true, approach: async () => true },
    now: () => clock, sleep: async ms => { clock += ms },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    supplies: { acquire: async name => { calls.push('acquire ' + name); return { reason: name } } },
    operations: {
      interactions: { useDoor: async () => {}, openCraftingTable: async at => { assert.deepEqual(at, table.position); calls.push('table') }, openFurnace: async () => calls.push('furnace') },
      crafting: { closeContainer () {}, craft: async (name, { times }) => { calls.push('craft ' + name); assert.equal(times, 1); items[1].count -= 3; items.push({ slot: 2, name, count: 1 }) } }
    }
  }
  await provisionFood(ctx, 1)
  assert.deepEqual(calls, ['table', 'craft minecraft:bread'])
  assert.equal(items[0].count, 1, 'raw meat was kept for a later cook')
  assert.equal((await provisionFood(ctx, 1)).done, true, 'the received bread satisfies the food goal')
})

test('unreceived furnace contents are not interpreted as a fuel shortage', async () => {
  const world = createHouseWorld({ x: 0, y: 64, z: 0 }), furnace = world.pick('furnace')[0]
  const items = [{ slot: 0, name: 'minecraft:beef', count: 1 }], acquired = []
  let clock = 0
  const ctx = {
    shared: { playerHouse: { origin: world.origin, done: true } }, memory: {}, cancelled: () => false,
    getBlock: world.getBlock, getFeet: () => world.beside(furnace.id), hands: { walk: async () => true, approach: async () => true },
    now: () => clock, sleep: async ms => { clock += ms },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    supplies: { acquire: async name => { acquired.push(name); return { reason: name } } },
    operations: { interactions: { useDoor: async () => {}, openFurnace: async () => {} }, crafting: { closeContainer () {} }, furnace: { snapshot: () => ({ contentsKnown: false }) } }
  }
  const out = await provisionFood(ctx, 1)
  assert.deepEqual(acquired, [])
  assert.equal(out.result.code, 'COOK_NOTHING')
  assert.match(out.reason, /3枠の受信/)
  assert.equal(clock, 4000)
})

test('uncertain inventory after a furnace recovery neither credits food nor starts another hunt', async () => {
  const world = createHouseWorld({ x: 0, y: 64, z: 0 }), furnace = world.pick('furnace')[0]
  let inventory = { known: true, items: [] }, clock = 0, hunts = 0
  const slots = [{ slot: 0, count: 0 }, { slot: 1, count: 0 }, { slot: 2, name: 'minecraft:cooked_beef', count: 1 }]
  const ctx = {
    shared: { playerHouse: { origin: world.origin, done: true } }, memory: {}, cancelled: () => false,
    getBlock: world.getBlock, getFeet: () => world.beside(furnace.id), hands: { walk: async () => true, approach: async () => true },
    now: () => clock, sleep: async ms => { clock += ms }, signal: new AbortController().signal,
    runtime: { inventory: () => inventory, raw: () => ({ dimension: 'overworld' }) },
    operations: {
      interactions: { openFurnace: async () => {} }, crafting: { closeContainer () {} }, perception: { entities: () => [] },
      furnace: { snapshot: () => ({ contentsKnown: true, slots }), takeOutput: async () => { slots[2].count = 0; inventory = { known: false, uncertain: true, items: [{ slot: 0, name: 'minecraft:cooked_beef', count: 1 }] } } },
      foraging: { preview: () => ({ ready: true, target: { runtimeId: 7 } }), execute: async () => { hunts++; return {} }, stop () {} }
    }
  }
  const out = await provisionFood(ctx, 1)
  assert.equal(out.done, false)
  assert.equal(out.result, undefined, 'no FOOD_COOKED progress is reported from unknown rows')
  assert.match(out.reason, /所持数を確認/)
  assert.equal(hunts, 0)
  assert.equal(clock, 3000)
})

function search () {
  const destinations = [], options = []
  const state = { busy: false, cancelled: false, seen: false }
  const origin = { x: 0, y: 64, z: 0 }
  const ctx = {
    shared: { playerHouse: { origin, done: true } }, memory: {}, cancelled: () => state.cancelled,
    getFeet: () => ({ x: 80, y: 64, z: 80 }),
    runtime: { inventory: () => ({ known: true, items: [] }), raw: () => ({ dimension: 'overworld' }) },
    operations: { quarry: { travelStatus: () => ({ busy: state.busy }) }, foraging: { preview: () => state.seen ? { ready: true, target: { runtimeId: 7 } } : { ready: false, code: 'NO_KNOWN_FOOD_SOURCE' } } },
    travelTo: async ({ destination }, control) => { destinations.push({ x: destination.x + 0, z: destination.z + 0 }); options.push(control) }
  }
  return { ctx, state, destinations, options }
}

test('sixty food-search decisions cover six directions on five rings and keep every third visit home', async () => {
  const { ctx, destinations } = search()
  for (let i = 0; i < 60; i++) await provisionFood(ctx, 8)
  assert.deepEqual(destinations.slice(0, 9), [
    { x: 96, z: 0 }, { x: 48, z: 83 }, { x: 3, z: 9 },
    { x: -48, z: 83 }, { x: -96, z: 0 }, { x: 3, z: 9 },
    { x: -48, z: -83 }, { x: 48, z: -83 }, { x: 3, z: 9 }
  ])
  assert.deepEqual(destinations[9], { x: 192, z: 0 })
  assert.equal(destinations.filter(at => at.x === 3 && at.z === 9).length, 20)
  assert.equal(new Set(destinations.map(at => `${at.x},${at.z}`)).size, 31)
  const farthest = Math.max(...destinations.map(at => Math.hypot(at.x, at.z)))
  assert.ok(farthest >= 479 && farthest <= 481, `${farthest}m (rounded block coordinates)`)
})

test('food-search progress resumes across steps and a cancelled or busy trip does not consume the next direction', async () => {
  const { ctx, state, destinations } = search()
  ctx.memory.early = { foodSearch: 9 }
  state.busy = true
  await provisionFood(ctx)
  assert.equal(destinations.length, 0)
  assert.equal(ctx.memory.early.foodSearch, 9)
  state.busy = false
  const travel = ctx.travelTo
  ctx.travelTo = async (...args) => { await travel(...args); state.cancelled = true }
  await provisionFood(ctx)
  assert.equal(ctx.memory.early.foodSearch, 9)
  state.cancelled = false
  ctx.travelTo = travel
  await provisionFood(ctx)
  assert.deepEqual(destinations, [{ x: 192, z: 0 }, { x: 192, z: 0 }])
  assert.equal(ctx.memory.early.foodSearch, 10)
})

test('an expanded search still stops as soon as an available food source is received', async () => {
  const { ctx, state, options } = search()
  ctx.memory.early = { foodSearch: 18 }
  await provisionFood(ctx)
  assert.equal(options[0].until(), false)
  state.seen = true
  assert.equal(options[0].until(), true)
})

test('INVENTORY_FULL during food provisioning deposits at home first, then falls back to discarding junk (live 2026-11-27 18:29 JST)', async () => {
  const { ctx } = search()
  const calls = []
  ctx.operations.foraging.preview = () => ({ ready: false, code: 'INVENTORY_FULL', errors: ['食料を回収する空きスロットがありません。'] })
  ctx.minePorts = { storage: { depositHome: async opts => { calls.push(['depositHome', opts]); return { status: 'completed', code: 'MINE_CAPACITY_FREED' } } } }
  const first = await provisionFood(ctx, 1)
  assert.equal(first.done, false)
  assert.match(first.reason, /空き枠を確保/)
  assert.deepEqual(calls, [['depositHome', { freeSlots: 2, drain: false }]])

  const dropped = []
  const items = Array.from({ length: 35 }, (_, slot) => ({ slot, name: 'minecraft:iron_pickaxe', count: 1 }))
  items.push({ slot: 35, name: 'minecraft:leaf_litter', count: 10 })
  ctx.runtime.inventory = () => ({ known: true, items })
  ctx.minePorts = { storage: { depositHome: async () => ({ status: 'blocked', code: 'MINE_HOME_STORAGE_FULL_OR_UNKNOWN' }) } }
  ctx.drop = async (slot, count) => { dropped.push({ slot, count }); items.splice(items.findIndex(i => i.slot === slot), 1); return { phase: 'completed' } }
  const second = await provisionFood(ctx, 1)
  assert.equal(second.done, false)
  assert.match(second.reason, /不要品を整理/)
  assert.deepEqual(dropped, [{ slot: 35, count: 10 }])
})
