'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { GEAR } = require('../src/survival/diamond-gear')
const { earlyObjective, runDragonEarly } = require('../src/modes/dragon-early')
const { farmSites, provisionFood } = require('../src/modes/dragon-early-food')
const { chestOf } = require('../src/modes/house/house-spawn')
const house = { done: true, spawn: true, origin: { x: 0, y: 65, z: 0 } }
const kit = GEAR.map(piece => ({ name: 'minecraft:' + piece.output, count: 1 }))
const observed = (items = kit) => ({ known: true, items })
const worn = names => ({ known: true, worn: names.map(name => ({ name })) })

test('reuse the house and survival jobs until actual equipment exists', () => {
  assert.equal(earlyObjective({ inventory: observed([]), house }).id, 'wood')
  assert.equal(earlyObjective({ inventory: observed(), house: null }).id, 'base')
  const inv = tier => observed([{ name: 'minecraft:' + tier + '_pickaxe', count: 1 }])
  assert.equal(earlyObjective({ inventory: inv('wooden'), house }).id, 'stone')
  for (const pick of ['stone', 'iron']) {
    const inventory = inv(pick)
    const memory = { early: {} }
    assert.equal(earlyObjective({ inventory, house, memory }).id, 'home_spawn')
    memory.early.spawnReady = true
    assert.equal(earlyObjective({ inventory, house, memory }).id, 'home_reserve')
    memory.early.reserveReady = true
    const next = earlyObjective({ inventory, house, memory })
    assert.equal(next.id, 'diamond')
    assert.equal(next.legacy, false)
  }
  assert.equal(earlyObjective({ inventory: observed(kit.slice(0, 2)), worn: worn(kit.slice(2).map(piece => piece.name)), house }).id, 'home_spawn')
  assert.equal(earlyObjective({ inventory: { ...observed(), uncertain: true }, house }).id, 'observe')
})

function context (state, supplies, boots = false) {
  const here = chestOf(house.origin)
  // The house's large chest A stands (since 2026-11-19 the reserve step reads the chest's received blocks before it
  // uses it; before, an all-air world was enough because only the record's `done` was read).
  const chest = require('../src/modes/house/house-large-chests').chestPairs(house.origin)[0].flatMap(step => step.cells)
  return {
    signal: new AbortController().signal, cancelled: () => false,
    getFeet: () => here, getBlock: (x, y, z) => ({ known: true, name: chest.some(cell => cell.x === x && cell.y === y && cell.z === z) ? 'minecraft:chest' : 'minecraft:air' }),
    hands: {}, runtime: { armor: () => worn(boots ? ['minecraft:golden_boots'] : []), inventory: () => observed() },
    shared: { playerHouse: house }, memory: { early: state }, supplies,
    operations: { interactions: {}, armor: { equipBest: async () => {} } }
  }
}

test('acquires missing reserve item away from the chest without re-inspecting on every tick', async () => {
  const state = { spawnReady: true }
  let visits = 0, acquisitions = 0
  const ctx = context(state, {
    reserve: async () => ++visits > 1 ? { done: true, reason: 'stocked' } : { done: false, missing: { name: 'iron_sword', count: 1 }, reason: 'missing' },
    acquire: async (name, count) => { assert.equal(name, 'iron_sword'); assert.equal(count, 1); return { done: ++acquisitions === 2, reason: 'craft' } }
  })
  ctx.runtime.inventory = () => observed([{ name: 'minecraft:stone_pickaxe', count: 1 }])
  for (let tick = 0; tick < 3; tick++) assert.equal((await runDragonEarly(ctx)).done, false)
  assert.equal(visits, 1)
  assert.equal(state.reserveReady, undefined)
  assert.equal((await runDragonEarly(ctx)).done, false)
  assert.equal(state.reserveReady, true)
  assert.equal(earlyObjective({ inventory: ctx.runtime.inventory(), house, memory: ctx.memory }).legacy, false)
})

test('Nether handover waits for the worn gold slot and supplies; the reserve stays banked', async () => {
  const state = { spawnReady: true, reserveReady: true }
  const ctx = context(state, { prepare: async () => ({ done: true }) })
  assert.equal((await runDragonEarly(ctx)).done, false)
  assert.equal(ctx.shared.dragonGoldBoots, true)
  ctx.runtime.armor = () => worn(['minecraft:diamond_chestplate', 'minecraft:diamond_leggings', 'minecraft:diamond_helmet', 'minecraft:golden_boots'])
  assert.equal((await runDragonEarly(ctx)).done, true)
  assert.equal(state.outfitted, true)
})

test('farm sites have water, received open cells and do not occupy the starter house', () => {
  const water = 'minecraft:water', dirt = 'minecraft:dirt', air = 'minecraft:air'
  const get = (x, y, z) => ({ known: true, name: y !== 65 ? air : x === 0 && z === 2 ? water : dirt })
  const sites = farmSites(get, house.origin)
  assert.ok(sites.length > 0)
  assert.ok(sites.every(at => at.x < -1 || at.x > 7 || at.z < -1 || at.z > 10))
  assert.deepEqual(farmSites(() => ({ known: false }), house.origin), [])
})

test('food stock is credited from received usable food only', async () => {
  const ctx = { cancelled: () => false, runtime: { raw: () => ({ dimension: 'nether' }), inventory: () => observed([{ name: 'minecraft:chicken', count: 64 }]) } }
  assert.equal((await provisionFood(ctx, 32)).done, false)
  ctx.runtime.inventory = () => observed([{ name: 'minecraft:bread', count: 18 }, { name: 'minecraft:cooked_beef', count: 14 }])
  assert.equal((await provisionFood(ctx, 32)).done, true)
})

test('cooled obsidian requires dry high ground and a verified bucket exchange before the source is removed', async () => {
  const { coolLava } = require('../src/modes/dragon-early-quarry')
  const id = (x, y, z) => [x, y, z].join(',')
  const world = new Map(), block = (name, box, more) => ({ known: true, name: 'minecraft:' + name, boundingBox: box, properties: more, extra: [] })
  const getBlock = (x, y, z) => world.get(id(x, y, z)) ?? block('air', 'empty')
  const lava = { x: 25, y: 64, z: 0 }
  world.set('25,64,0', block('lava', 'empty', { liquid_depth: 0 }))
  world.set('26,64,0', block('stone', 'block'))
  const inventory = [{ name: 'minecraft:water_bucket', slot: 0, count: 1 }]
  const ctx = {
    memory: { early: {} }, cancelled: () => false, shared: {},
    runtime: { inventory: () => observed(inventory) }, getBlock, getFeet: () => ({ x: 27.5, y: 66, z: 0.5 }),
    supplies: { waterAt: async () => {
      world.set('26,65,0', block('water', 'empty', { liquid_depth: 0 }))
      return { done: true }
    } },
    operations: { inventory: { equip: async () => ({ slot: 0 }) }, interactions: { useDragonItem: async cmd => {
      assert.deepEqual(cmd.position, { x: 26, y: 65, z: 0 })
      world.delete('26,65,0')
      inventory[0].name = 'minecraft:water_bucket'
    } } }
  }
  assert.equal(await coolLava(ctx, [lava]), false)
  world.set('27,65,0', block('stone', 'block'))
  assert.equal(await coolLava(ctx, [lava]), true)
  assert.notEqual(ctx.memory.early.mine.pond.placed, true, 'block observation alone does not prove it was our bucket')
  inventory[0].name = 'minecraft:bucket'
  world.set('25,64,0', block('obsidian', 'block'))
  assert.equal(await coolLava(ctx, []), true)
  assert.equal(ctx.memory.early.mine.pond, undefined)
  assert.equal(inventory[0].name, 'minecraft:water_bucket')
})

test('when no ore is exposed the mineral search returns to the recorded stairs of the same Realm', async () => {
  const { searchMine } = require('../src/modes/dragon-early-quarry')
  const scope = { profile: 'test', realm: { id: '42' }, dimension: 'overworld' }
  const floor = { x: 12, y: 53, z: 8 }
  let walked = null
  const ctx = {
    memory: { early: {} }, runtime: { raw: () => scope }, shared: { tunnelFloors: { scopes: {
      [JSON.stringify(['test', '42', 'overworld'])]: { floors: [floor] }
    } } }, cancelled: () => false, getFeet: () => ({ x: 12.5, y: 59, z: 8.5 }),
    getBlock: (x, y, z) => ({ known: true, name: y === floor.y ? 'minecraft:stone' : 'minecraft:air', boundingBox: y === floor.y ? 'block' : 'empty', extra: [] }),
    hands: { walk: async at => { walked = at; return true } }
  }
  assert.equal(await searchMine(ctx, 'raw_gold'), true)
  assert.deepEqual(walked, { x: 12.5, y: 54, z: 8.5 })
})

test('physical home reserve keeps a working pick, and can re-equip a bare respawn before diamond mining', async () => {
  const { createDragonSupplies } = require('../src/modes/dragon-supplies')
  const { recoverDragon } = require('../src/modes/dragon-recovery')
  const { home } = require('../src/modes/dragon-supply-kit')
  const position = chestOf(house.origin)
  const window = { id: 3, epoch: 1, scope: 'home', position, slotCount: 54 }
  const slots = Array.from({ length: 54 }, (_, slot) => ({ slot, known: true, count: 0, name: null }))
  const stack = (slot, name, count) => ({ slot, name: 'minecraft:' + name, count, known: true })
  const main = [stack(0, 'iron_pickaxe', 1)]
  const record = { stage: 'early', early: { spawnReady: true }, stronghold: {} }
  const transfers = []
  const ctx = context(record.early, {})
  ctx.memory = record
  ctx.runtime.inventory = () => observed(main)
  ctx.runtime.raw = () => ({ dimension: 'overworld', position, health: 20, inventory: observed(main) })
  ctx.operations.crafting = { closeContainer () {} }
  const confirmed = count => ({ serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count })
  ctx.operations.chest = {
    open: async () => ({ windowId: window.id }),
    snapshot: () => ({ window, slots, contentsKnown: true }),
    depositItem: async ({ sourceSlot, count, expectedName }) => {
      const row = main.find(i => i.slot === sourceSlot && i.name === expectedName)
      assert.ok(row.count >= count)
      row.count -= count
      slots[0] = { ...row, slot: 0, count }
      transfers.push(['in', expectedName])
      return confirmed(count)
    },
    withdrawItem: async ({ chestSlot, count, expectedName }) => {
      const row = slots[chestSlot]
      assert.equal(row.name, expectedName)
      assert.ok(row.count >= count)
      row.count -= count
      main.push({ ...row, slot: main.length, count })
      transfers.push(['out', expectedName])
      return confirmed(count)
    }
  }
  ctx.supplies = createDragonSupplies(ctx)
  const stock = () => ctx.supplies.reserve(position, { mode: 'stock', kit: 'home' })
  assert.deepEqual((await stock()).missing, { name: 'iron_pickaxe', count: 2 })
  assert.deepEqual(transfers, [])
  main.push(stack(1, 'diamond_pickaxe', 1))
  await stock()
  assert.deepEqual(transfers, [['in', 'minecraft:iron_pickaxe']])
  main.length = 0
  assert.deepEqual((await stock()).missing, { name: 'iron_pickaxe', count: 1 }, 'one banked pick cannot prove a usable main kit')

  for (const [slot, [name, count]] of home.entries()) slots[slot] = stack(slot, name === 'food' ? 'bread' : name, count)
  record.early.reserveReady = true
  record.recovery = { dimension: 'overworld', cause: 'lava', at: Date.now() }
  for (let i = 0; i <= home.length; i++) await recoverDragon(ctx, record)
  assert.equal(record.recovery, null)
  assert.ok(main.some(i => i.name === 'minecraft:iron_pickaxe' && i.count === 1))
  assert.ok(main.some(i => i.name === 'minecraft:iron_chestplate' && i.count === 1))
  assert.equal(record.early.reserveReady, false)
  assert.equal(earlyObjective({ inventory: observed(main), house, memory: record }).id, 'home_reserve')
  assert.ok(slots.every(i => i.count === 0))
})

test('bare respawn outside an active mine hands back to starter jobs instead of departing unarmed', () => {
  const memory = { early: { spawnReady: true, mine: { branch: { request: { resource: 'raw_iron', targetHeld: 33, layer: 'upper' } } } } }
  // Bare respawn at home (inMine: false): must craft basic tools/weapon before walking to the mine.
  const outsideBare = earlyObjective({ inventory: observed([]), house, memory, inMine: false })
  assert.equal(outsideBare.id, 'wood')
  assert.equal(outsideBare.legacy, true)
  const outsideWooden = earlyObjective({ inventory: observed([{ name: 'minecraft:wooden_pickaxe', count: 1 }]), house, memory, inMine: false })
  assert.equal(outsideWooden.id, 'stone')
  assert.equal(outsideWooden.legacy, true)
  // Once a working stone+ pickaxe is held outside the mine, expedition resumes home_reserve.
  const outsideStone = earlyObjective({ inventory: observed([{ name: 'minecraft:stone_pickaxe', count: 1 }]), house, memory, inMine: false })
  assert.equal(outsideStone.id, 'home_reserve')
  assert.equal(outsideStone.legacy, false)
  // Inside/at the mine site (inMine: true) or when carrying cobblestone to remake a stone pickaxe,
  // a broken pickaxe stays with home_reserve so the mine uses its own chests/cobblestone.
  const insideBroken = earlyObjective({ inventory: observed([]), house, memory, inMine: true })
  assert.equal(insideBroken.id, 'home_reserve')
  assert.equal(insideBroken.legacy, false)
  const outsideWithCobble = earlyObjective({ inventory: observed([{ name: 'minecraft:cobblestone', count: 3 }]), house, memory, inMine: false })
  assert.equal(outsideWithCobble.id, 'home_reserve')
  assert.equal(outsideWithCobble.legacy, false)
})

test('prepareHomeIron keeps gathering fuel outside instead of walking back to the empty furnace on every tick', async () => {
  const { prepareHomeIron } = require('../src/modes/dragon-home-iron')
  const { homeTarget } = require('../src/modes/dragon-home-use')
  const items = [{ name: 'minecraft:iron_ingot', count: 24 }]
  const held = name => items.filter(i => (name === 'planks' ? /_planks$/.test(i.name) : i.name === 'minecraft:' + name)).reduce((s, i) => s + i.count, 0)
  const furnaceAt = homeTarget({ shared: { playerHouse: house }, getBlock: () => ({ known: true, name: 'minecraft:air' }) }, 'furnace').at
  let walksToFurnace = 0, smeltCalls = 0, acquireCalls = 0
  let feet = { x: furnaceAt.x, y: furnaceAt.y, z: furnaceAt.z + 1 }
  const ctx = {
    cancelled: () => false,
    shared: { playerHouse: house },
    memory: { early: {} },
    getFeet: () => feet,
    getBlock: (x, y, z) => ({ known: true, name: x === furnaceAt.x && y === furnaceAt.y && z === furnaceAt.z ? 'minecraft:furnace' : 'minecraft:air', boundingBox: y < house.origin.y ? 'block' : 'empty' }),
    hands: { walk: async () => { walksToFurnace++; feet = { x: furnaceAt.x, y: furnaceAt.y, z: furnaceAt.z + 1 }; return true } },
    operations: { quarry: { travelStatus: () => ({ busy: false }) } },
    travelTo: async () => { walksToFurnace++; feet = { x: furnaceAt.x, y: furnaceAt.y, z: furnaceAt.z + 1 }; return { phase: 'arrived' } },
    runtime: { raw: () => ({ dimension: 'overworld' }), inventory: () => observed(items) }
  }
  const housePorts = {
    reset () {},
    why: () => null,
    smeltNeed: () => (held('planks') > 0 ? null : { input: 0, fuel: true }),
    smelt: async () => {
      smeltCalls++
      if (held('planks') >= 6) {
        items[0].count = 33
        return 9
      }
      return 0
    }
  }
  const batch = { target: 33 }
  const acquire = async (name, count) => {
    assert.equal(name, 'planks')
    assert.equal(count, 6)
    acquireCalls++
    // First two ticks simulate walking out to a distant tree without planks yet.
    if (acquireCalls === 1) {
      feet = { x: furnaceAt.x + 25, y: furnaceAt.y, z: furnaceAt.z + 25 }
      return { done: false, reason: 'planks を準備しています（0/6）。' }
    }
    if (acquireCalls === 2) {
      items.push({ name: 'minecraft:oak_planks', count: 4 })
      return { done: false, reason: 'planks を準備しています（4/6）。' }
    }
    items[1].count = 8
    return { done: true, reason: 'planks を持ち物で確認しました。' }
  }

  // Tick 1: inspects furnace once, sees fuel needed, records fuelTarget=6 and steps outside.
  const t1 = await prepareHomeIron(ctx, batch, { held, house: housePorts, acquire })
  assert.equal(t1.done, false)
  assert.equal(smeltCalls, 1)
  assert.equal(batch.fuelTarget, 6)

  // Tick 2: still outside with 0 planks -> must NOT walk back to the furnace; keeps acquiring planks.
  const t2 = await prepareHomeIron(ctx, batch, { held, house: housePorts, acquire })
  assert.equal(t2.done, false)
  assert.equal(smeltCalls, 1, 'must not re-open furnace while fuel is still short')
  assert.equal(walksToFurnace, 0, 'must not walk back home after first exploration step')
  assert.equal(batch.fuelTarget, 6)

  // Tick 3: acquires remaining planks -> clears fuelTarget.
  const t3 = await prepareHomeIron(ctx, batch, { held, house: housePorts, acquire })
  assert.equal(t3.done, false)
  assert.equal(smeltCalls, 1)
  assert.equal(batch.fuelTarget, undefined)

  // Tick 4: travels back home with 8 planks (approachHome hands off after travelTo).
  const t4 = await prepareHomeIron(ctx, batch, { held, house: housePorts, acquire })
  assert.equal(t4.done, false)
  assert.equal(walksToFurnace, 1)

  // Tick 5: opens the furnace once at home and finishes smelting 33/33 iron.
  const t5 = await prepareHomeIron(ctx, batch, { held, house: housePorts, acquire })
  assert.equal(t5.done, true)
  assert.equal(smeltCalls, 2)
  assert.equal(held('iron_ingot'), 33)
})
