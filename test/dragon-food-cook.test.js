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
