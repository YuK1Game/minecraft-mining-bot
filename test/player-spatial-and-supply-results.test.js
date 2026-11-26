'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readSpatialContext, ensureSpatialPreconditions } = require('../src/modes/spatial-context')
const { createWorkDispatcher } = require('../src/modes/work-dispatcher')
const { createPlayerFood } = require('../src/modes/player-food')
const { createHouseWool } = require('../src/modes/house/house-wool')
const { createPlayerWater } = require('../src/modes/player-water')

test('spatial-context classifies zones and sequences exit preconditions safely', async () => {
  const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  const water = { known: true, name: 'minecraft:water', boundingBox: 'empty' }

  const surface = readSpatialContext({
    dimension: 'overworld',
    feet: { x: 100.5, y: 65, z: 200.5 },
    getBlock: (x, y) => (y < 65 ? stone : air),
    baseChest: { x: 110, y: 65, z: 205 }
  })
  assert.equal(surface.zone, 'base_yard')
  assert.equal(surface.openSurface, true)
  assert.equal(surface.inBaseYard, true)

  const wetCtx = readSpatialContext({
    dimension: 'overworld',
    feet: { x: 10.5, y: 62, z: 10.5 },
    getBlock: (x, y) => (y === 62 ? water : y < 62 ? stone : air)
  })
  assert.equal(wetCtx.zone, 'water')
  assert.equal(wetCtx.inWater, true)

  const mineRes = await ensureSpatialPreconditions(
    { dimension: 'overworld', zone: 'branch_mine', inBranchMine: true },
    { forbidBranchMine: true },
    { leaveBranchMine: async () => ({ ok: true }) }
  )
  assert.equal(mineRes.status, 'partial')
  assert.equal(mineRes.code, 'LEFT_BRANCH_MINE')

  const dimRes = await ensureSpatialPreconditions(
    { dimension: 'nether', zone: 'nether' },
    { requireOverworld: true },
    {}
  )
  assert.equal(dimRes.status, 'blocked')
  assert.equal(dimRes.code, 'WRONG_DIMENSION')
})

test('work-dispatcher suppresses ground-assuming crew tasks while inside branch mine', () => {
  let foodTicked = 0
  let torchTicked = 0
  let zoneState = { dimension: 'overworld', zone: 'branch_mine', inBranchMine: true }
  const dispatcher = createWorkDispatcher([
    { id: 'food', label: '食料', preconditions: { requireOverworld: true, forbidBranchMine: true }, task: { tick: () => { foodTicked++ }, status: () => ({ active: false }) } },
    { id: 'torch', label: '松明', task: { tick: () => { torchTicked++ }, status: () => ({ active: false }) } }
  ], { getSpatial: () => zoneState })

  dispatcher.tickMany(['food', 'torch'])
  assert.equal(foodTicked, 0, 'food climb is suppressed inside branch mine')
  assert.equal(torchTicked, 1, 'torch still ticks')

  zoneState = { dimension: 'overworld', zone: 'open_surface', inBranchMine: false }
  dispatcher.tickMany(['food', 'torch'])
  assert.equal(foodTicked, 1)
  assert.equal(torchTicked, 2)
})

test('supply tasks record structured return-result outcomes and stop repeating after 3 identical failures', async () => {
  let now = 1000
  const shared = { playerWanted: true }
  const food = createPlayerFood({
    getMode: () => 'player',
    shared,
    now: () => now,
    sleep: async () => {},
    scope: () => 'life-1',
    getHunger: () => 12,
    getState: () => ({ health: 20, position: { x: 4.5, y: 20.62, z: 4.5 }, inventory: { known: true, items: [] } }),
    getBlock: (x, y) => (y >= 22 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }),
    climb: async () => ({ ok: false, reason: 'NO_PICKAXE' }),
    agent: { objective: {}, start: async () => {}, stop: () => {} }
  })

  for (let i = 0; i < 3; i++) {
    const out = await food.runStep()
    assert.equal(out.status, 'failed')
    assert.equal(out.code, 'FOOD_CLIMB_FAILED')
    now += 400000
  }
  assert.equal(food.status().lastOutcome.code, 'FOOD_CLIMB_FAILED')
  // 4th attempt in the same cell & life is suppressed by failure memory
  const fourth = await food.runStep()
  assert.equal(fourth, null)

  // Wool and water also expose structured outcomes
  let woolNow = 1000
  const wool = createHouseWool({
    getMode: () => 'player',
    shared,
    now: () => woolNow,
    sleep: async () => {},
    scope: () => 'life-1',
    getState: () => ({ position: { x: 0, y: 65, z: 0 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1 }] } }),
    getBlock: () => null,
    actors: () => [{ entityType: 'minecraft:sheep', position: { x: 5, y: 64, z: 5 } }],
    gather: async () => {},
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true }
  })
  const woolOut = await wool.runStep()
  assert.equal(woolOut.status, 'failed')
  assert.equal(woolOut.code, 'WOOL_NONE_GAINED')
  assert.equal(wool.status().lastOutcome.code, 'WOOL_NONE_GAINED')

  let waterNow = 1000
  const waterTask = createPlayerWater({
    getMode: () => 'player',
    shared,
    now: () => waterNow,
    sleep: async () => {},
    scope: () => 'life-1',
    getPosition: () => ({ x: 0.5, y: 62, z: 0.5 }),
    getBlock: (x, y) => (y === 62 ? { known: true, name: 'minecraft:water', boundingBox: 'empty' } : { known: false }),
    start: () => {},
    moving: () => false,
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true }
  })
  await waterTask.runStep() // sets anchor
  waterNow += 20000
  const waterOut = await waterTask.runStep()
  assert.equal(waterOut.status, 'blocked')
  assert.equal(waterOut.code, 'WATER_NO_SHORE')
})
