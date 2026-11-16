'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { placements, remaining, counts, matches } = require('../src/modes/house/house-blueprint')
const { houseNeeds } = require('../src/modes/house/house-needs')
const { withHouseSupply, houseLogInput } = require('../src/modes/house/house-supply')

const inv = items => ({ known: true, items: items.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })

test('the blueprint: 184 steps, and its raw materials are 44 logs, 68 cobblestone, 6 sand, 3 wool, 2 coal', () => {
  const steps = placements({ x: 100, y: 64, z: -50 })
  assert.equal(steps.length, 184)
  assert.deepEqual(steps[0].position, { x: 100, y: 64, z: -50 })
  assert.equal(steps.find(step => step.item === 'white_bed').cells.length, 2)
  assert.deepEqual(houseNeeds(inv([]), counts(steps)).need, { logs: 44, cobblestone: 68, sand: 6, wool: 3, coal: 2 })
  assert.equal(matches('oak_planks', { known: true, name: 'minecraft:birch_planks' }), true)
  assert.equal(matches('oak_slab', { known: true, name: 'minecraft:birch_slab' }), true)
  assert.equal(matches('furnace', { known: false, name: 'minecraft:furnace' }), false)
})

test('held crafted things count first: chests, planks, logs, furnaces, glass', () => {
  const left = counts(placements())
  const needs = houseNeeds(inv([['birch_log', 10], ['birch_planks', 20], ['chest', 2], ['cobblestone', 30], ['furnace', 1], ['glass', 2], ['white_wool', 3], ['coal', 5]]), left)
  // planks: 52 walls + 27 slabs + 6 door + 3 bed + 16 chests + 4 table + 2 sticks = 110; 90 to make = 23 logs; +12 pillars = 35; 10 held.
  assert.deepEqual(needs.need, { logs: 25, cobblestone: 30, sand: 4, wool: 0, coal: 0 })
  assert.equal(houseNeeds({ known: false }, left), null)
})

test('placed blocks drop out of what is still needed', () => {
  const origin = { x: 0, y: 64, z: 0 }
  const floor = new Set(placements(origin).filter(step => step.item === 'cobblestone').map(step => `${step.position.x},${step.position.y},${step.position.z}`))
  const getBlock = (x, y, z) => floor.has(`${x},${y},${z}`) ? { known: true, name: 'minecraft:cobblestone' } : { known: true, name: 'minecraft:air' }
  const left = counts(remaining(getBlock, origin))
  assert.equal(left.cobblestone ?? 0, 0)
  assert.equal(houseNeeds(inv([]), left).need.cobblestone, 16) // the two furnaces
})

test('with a pickaxe and no house: logs first, then cobblestone; a waiting plan keeps the decision', () => {
  const base = { type: 'tunnel', reason: 'ダイヤ' }
  const shared = {}
  const state = { inventory: inv([['wooden_pickaxe', 1], ['birch_log', 4]]) }
  const asked = []
  const out = withHouseSupply({ mode: 'player', playing: true, shared, state, decision: base, planLogs: count => { asked.push(['logs', count]); return { type: 'gather_logs', reason: '木' } }, planStone: count => { asked.push(['stone', count]); return { type: 'mine_stone' } } })
  assert.equal(out.type, 'gather_logs')
  assert.deepEqual(asked, [['logs', 40]])
  assert.match(out.reason, /拠点の材料/)
  const stone = withHouseSupply({ mode: 'player', playing: true, shared, state: { inventory: inv([['wooden_pickaxe', 1], ['birch_log', 44], ['cobblestone', 8]]) }, decision: base, planLogs: () => null, planStone: count => ({ type: 'mine_stone', count }) })
  assert.deepEqual([stone.type, stone.count], ['mine_stone', 60])
  const waiting = withHouseSupply({ mode: 'player', playing: true, shared, state, decision: base, planLogs: () => ({ type: 'wait' }), planStone: () => null })
  assert.equal(waiting, base)
})

test('no pickaxe, quarry mode, not playing, or the house done: the decision stays', () => {
  const base = { type: 'tunnel' }
  const plan = () => ({ type: 'gather_logs' })
  assert.equal(withHouseSupply({ mode: 'player', playing: true, shared: {}, state: { inventory: inv([]) }, decision: base, planLogs: plan, planStone: plan }), base)
  assert.equal(withHouseSupply({ mode: 'quarry', playing: true, shared: {}, state: { inventory: inv([['stone_pickaxe', 1]]) }, decision: base, planLogs: plan, planStone: plan }), base)
  assert.equal(withHouseSupply({ mode: 'player', playing: false, shared: {}, state: { inventory: inv([['stone_pickaxe', 1]]) }, decision: base, planLogs: plan, planStone: plan }), base)
  assert.equal(withHouseSupply({ mode: 'player', playing: true, shared: { playerHouse: { done: true } }, state: { inventory: inv([['stone_pickaxe', 1]]) }, decision: base, planLogs: plan, planStone: plan }), base)
})

test('the house log plan input hides wood and pickaxes so the plan asks for more logs', () => {
  const input = houseLogInput({ inventory: inv([['diamond_pickaxe', 1], ['birch_log', 3], ['birch_planks', 8], ['crafting_table', 1], ['diamond', 5]]) }, {}, 40)
  assert.deepEqual(input.state.inventory.items.map(item => item.name), ['minecraft:diamond'])
  assert.equal(input.options.logCount, 40)
})
