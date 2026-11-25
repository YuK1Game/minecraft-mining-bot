'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { provisionFood } = require('../src/modes/dragon-early-food')
const { placements } = require('../src/modes/house/house-blueprint')

test('a cook at the home furnace that gains nothing says why, once per 20 s', async () => {
  const origin = { x: 0, y: 64, z: 0 }
  const furnace = placements(origin).find(step => step.item === 'furnace').position
  const logs = []
  let clock = 0
  const getBlock = (x, y, z) => x === furnace.x && y === furnace.y && z === furnace.z ? { known: true, name: 'minecraft:furnace', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const ctx = {
    shared: { playerHouse: { origin, done: true } }, memory: {}, cancelled: () => false, log: line => logs.push(line), now: () => clock, sleep: async ms => { clock += ms },
    getFeet: () => ({ x: furnace.x + 1.5, y: furnace.y, z: furnace.z + 0.5 }), getBlock, hands: { walk: async () => true, approach: async () => true },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    operations: {
      interactions: { openFurnace: async () => { throw new Error('操作対象への視線が遮られているか、未取得です。') }, useDoor: async () => {} },
      crafting: { closeContainer () {} }, furnace: {}, quarry: { travelStatus: () => ({ busy: false }) }
    }
  }
  const first = await provisionFood(ctx)
  assert.equal(first.done, false)
  assert.match(first.reason, /かまど: 操作対象への視線が遮られている/)
  assert.equal(logs.filter(line => /かまどで調理できません（操作対象への視線/.test(line)).length, 1)
  await provisionFood(ctx)
  assert.equal(logs.filter(line => /かまどで調理できません/.test(line)).length, 1, 'not repeated within 20 s')
  clock += 60000
  await provisionFood(ctx)
  assert.equal(logs.filter(line => /かまどで調理できません/.test(line)).length, 2)
})

test('without coal the cook burns held wood, and only with neither goes for coal', async () => {
  const { cookFuel } = require('../src/modes/cook-fuel')
  assert.deepEqual(cookFuel([{ name: 'minecraft:oak_planks', count: 6 }, { name: 'minecraft:coal', count: 2 }], 3), { name: 'minecraft:coal', count: 1 })
  assert.deepEqual(cookFuel([{ name: 'minecraft:birch_log', count: 9 }, { name: 'minecraft:oak_planks', count: 2 }], 3), { name: 'minecraft:oak_planks', count: 2 })
  assert.deepEqual(cookFuel([{ name: 'minecraft:birch_log', count: 9 }, { name: 'minecraft:oak_planks', count: 1 }], 3), { name: 'minecraft:birch_log', count: 2 })
  assert.equal(cookFuel([{ name: 'minecraft:oak_planks', count: 1 }, { name: 'minecraft:cobblestone', count: 64 }], 3), null)

  const origin = { x: 0, y: 64, z: 0 }
  const furnace = placements(origin).find(step => step.item === 'furnace').position
  const getBlock = (x, y, z) => x === furnace.x && y === furnace.y && z === furnace.z ? { known: true, name: 'minecraft:furnace', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const asked = []
  let clock = 0
  const make = items => ({
    shared: { playerHouse: { origin, done: true } }, memory: {}, cancelled: () => false, log: () => {}, now: () => clock, sleep: async ms => { clock += ms },
    getFeet: () => ({ x: furnace.x + 1.5, y: furnace.y, z: furnace.z + 0.5 }), getBlock, hands: { walk: async () => true, approach: async () => true },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    supplies: { acquire: async (name, count) => { asked.push([name, count]); return { done: false, reason: 'coal を準備しています（0/1）。' } } },
    operations: {
      interactions: { openFurnace: async () => { throw new Error('操作対象への視線が遮られているか、未取得です。') }, useDoor: async () => {} },
      crafting: { closeContainer () {} }, furnace: {}, quarry: { travelStatus: () => ({ busy: false }) }
    }
  })
  const withWood = await provisionFood(make([{ name: 'minecraft:mutton', count: 2, slot: 0 }, { name: 'minecraft:oak_planks', count: 8, slot: 1 }]))
  assert.equal(asked.length, 0, 'wood in hand: the cook is tried at the furnace instead of leaving for coal')
  assert.match(withWood.reason, /かまど/)
  const bare = await provisionFood(make([{ name: 'minecraft:mutton', count: 2, slot: 0 }]))
  assert.deepEqual(asked, [['coal', 1]])
  assert.match(bare.reason, /coal/)
})

test('with nothing to burn the fuel is fetched before the walk to the furnace: logs when a tree is near, else coal', async () => {
  // Live 2026-11-19 09:46-10:10 JST: the cook walked into the house, the coal step walked out, 13 rounds, nothing cooked.
  const { fuelWanted } = require('../src/modes/cook-fuel')
  const air = () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' })
  const tree = (x, y, z) => (x === 5 && z === 5 && y >= 64 && y <= 67 ? { known: true, name: 'minecraft:oak_log', boundingBox: 'block' } : air())
  const feet = () => ({ x: 0.5, y: 64, z: 0.5 })
  const meat = [{ name: 'minecraft:beef', count: 6, slot: 0 }]
  assert.deepEqual(fuelWanted(meat, 3, { getFeet: feet, getBlock: tree }), { name: 'log', count: 2 })
  assert.deepEqual(fuelWanted(meat, 3, { getFeet: feet, getBlock: air }), { name: 'coal', count: 1 })
  assert.deepEqual(fuelWanted(meat, 3, { getFeet: feet, getBlock: () => ({ known: false, name: 'minecraft:oak_log' }) }), { name: 'coal', count: 1 }, 'a log that was not received is not a tree')
  assert.equal(fuelWanted([...meat, { name: 'minecraft:coal', count: 1, slot: 1 }], 3, { getFeet: feet, getBlock: tree }), null)
  // Mixed or split single-log stacks (total 2 logs, no single stack >= 2): craft held log into
  // 4 same-kind planks instead of requesting `log` 2 and spinning forever (live 2026-11-25).
  const mixedLogs = [...meat, { name: 'minecraft:oak_log', count: 1, slot: 1 }, { name: 'minecraft:birch_log', count: 1, slot: 2 }]
  assert.equal(require('../src/modes/cook-fuel').cookFuel(mixedLogs, 3), null)
  assert.deepEqual(fuelWanted(mixedLogs, 3, { getFeet: feet, getBlock: tree }), { name: 'planks', count: 4 })
  assert.deepEqual(fuelWanted([...mixedLogs, { name: 'minecraft:spruce_planks', count: 1, slot: 3 }], 3, { getFeet: feet, getBlock: air }), { name: 'planks', count: 5 })

  const asked = []
  let walked = 0
  const ctx = {
    shared: { playerHouse: { origin: { x: 100, y: 64, z: 100 }, done: true } }, memory: {}, cancelled: () => false, log: () => {}, now: () => 0,
    getFeet: feet, getBlock: tree, hands: { walk: async () => { walked++; return true }, approach: async () => { walked++; return true } },
    travelTo: async () => { walked++ }, walk: async () => { walked++ },
    runtime: { inventory: () => ({ known: true, items: meat }), raw: () => ({ dimension: 'overworld' }) },
    supplies: { acquire: async (name, count) => { asked.push([name, count]); return { done: false, reason: 'log を準備しています（0/2）。' } } },
    operations: { foraging: { preview: () => ({ ready: false, code: 'NO_KNOWN_FOOD_SOURCE' }) }, quarry: { travelStatus: () => ({ busy: false }) } }
  }
  const out = await provisionFood(ctx)
  assert.deepEqual(asked, [['log', 2]])
  assert.equal(walked, 0, 'no walk home before there is fuel')
  assert.match(out.reason, /log/)
})

// 指示書 B5・§8: the cook is one way of the food goal. The same cook that gains nothing is tried three times,
// then held until the meat or the fuel changes, and every answer carries a result with a code and what is left.
test('B5: the same cook that gains nothing three times is not tried a fourth time; other meat is another state', async () => {
  const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
  const origin = { x: 0, y: 64, z: 0 }
  const furnace = placements(origin).find(step => step.item === 'furnace').position
  const getBlock = (x, y, z) => x === furnace.x && y === furnace.y && z === furnace.z ? { known: true, name: 'minecraft:furnace', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  let clock = 1e9, opens = 0
  const ledger = createGoalLedger({ shared: {}, now: () => clock })
  ledger.open('early.home_reserve'); ledger.look({ value: 0, scope: 'a/0' })
  const items = [{ name: 'minecraft:beef', count: 2, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const logs = []
  const ctx = {
    shared: { playerHouse: { origin, done: true } }, memory: {}, cancelled: () => false, log: line => logs.push(line), now: () => clock, sleep: async ms => { clock += ms },
    getFeet: () => ({ x: furnace.x + 1.5, y: furnace.y, z: furnace.z + 0.5 }), getBlock, hands: { walk: async () => true, approach: async () => true },
    runtime: { inventory: () => ({ known: true, items }), raw: () => ({ dimension: 'overworld' }) },
    goal: { fail: (f, o) => ledger.fail(f, o), spent: f => ledger.spent(f), step: k => ledger.step(k) },
    operations: {
      interactions: { openFurnace: async () => { opens++; throw new Error('操作対象への視線が遮られているか、未取得です。') }, useDoor: async () => {} },
      crafting: { closeContainer () {} }, furnace: {}, quarry: { travelStatus: () => ({ busy: false }) }
    }
  }
  for (let i = 0; i < 3; i++) {
    const answer = await provisionFood(ctx, 8)
    assert.equal(answer.result.status, 'failed')
    assert.equal(answer.result.code, 'COOK_NOTHING')
    assert.deepEqual(answer.result.remaining, { step: 'cook', cooked: 8, raw: 2 })
    clock += 21000
  }
  const tried = opens
  assert.ok(tried >= 3)
  assert.equal(logs.filter(line => /3 回とも焼けなかったため、材料か燃料が変わるまで調理をやめます/.test(line)).length, 1)
  for (let i = 0; i < 5; i++) {
    const answer = await provisionFood(ctx, 8)
    assert.equal(answer.result.status, 'blocked')
    assert.equal(answer.result.code, 'COOK_SPENT')
    assert.equal(answer.result.retry.kind, 'supplies_changed')
    clock += 21000
  }
  assert.equal(opens, tried, 'the furnace is not opened again for the same meat and fuel')
  // One more piece of raw meat: another state, the cook is tried again.
  items[0].count = 3
  assert.equal((await provisionFood(ctx, 8)).result.code, 'COOK_NOTHING')
  assert.ok(opens > tried)
})
