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

test('after logs and cobblestone: sand from the plan, and with no sand received the decision goes on', () => {
  const { houseSandInput } = require('../src/modes/house/house-supply')
  const base = { type: 'tunnel' }
  const state = { inventory: inv([['wooden_pickaxe', 1], ['birch_log', 44], ['cobblestone', 68], ['red_sand', 2]]) }
  const asked = []
  const sand = withHouseSupply({ mode: 'player', playing: true, shared: {}, state, decision: base, planLogs: () => null, planStone: () => null, planSand: count => { asked.push(count); return { type: 'mine_stone', material: true } } })
  assert.equal(sand.type, 'mine_stone')
  assert.deepEqual(asked, [4])
  assert.equal(houseSandInput(state, {}, 4).options.material.count, 6)
  const none = withHouseSupply({ mode: 'player', playing: true, shared: {}, state, decision: base, planLogs: () => null, planStone: () => null, planSand: () => ({ type: 'scan_blocks' }) })
  assert.equal(none, base)
})

test('the plan mines received sand with nothing falling on it, counting sand held', () => {
  const { nextBootstrapAction } = require('../src/survival/planner')
  const blocks = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    blocks.push({ known: true, name: 'minecraft:stone', position: { x, y: 62, z }, boundingBox: 'block' })
    blocks.push({ known: true, name: x === 2 && z === 0 ? 'minecraft:sand' : 'minecraft:grass_block', position: { x, y: 63, z }, boundingBox: 'block' })
    for (const y of [64, 65, 66]) blocks.push({ known: true, name: 'minecraft:air', position: { x, y, z }, boundingBox: 'empty' })
  }
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', position: { x: 0.5, y: 65.62, z: 0.5 }, heldItem: { name: 'minecraft:stone_pickaxe', slot: 0 }, inventory: { known: true, items: [{ name: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] } }
  const out = nextBootstrapAction(state, { blocks, canScan: true, capabilities: { break_block: true, move: true, scan_blocks: true, equip: true, collect_drops: true } }, { stoneCount: 2304, material: { blocks: ['sand', 'red_sand'], items: ['sand', 'red_sand'], count: 6 } })
  assert.equal(out.type, 'mine_stone')
  assert.deepEqual(out.target, { x: 2, y: 63, z: 0 })
  assert.equal(out.material, true)
  const done = nextBootstrapAction({ ...state, inventory: { known: true, items: [...state.inventory.items, { name: 'minecraft:sand', count: 6, slot: 1 }] } }, { blocks, canScan: true }, { stoneCount: 2304, material: { blocks: ['sand'], items: ['sand'], count: 6 } })
  assert.equal(done.type, 'complete')
})

// Live 2026-11-17 13:15-13:21 JST: on a beach every sand block had sand beside
// or below it, and the plan never chose one.
test('the plan mines beach sand with sand beside and below it, not sand under sand', () => {
  const { nextBootstrapAction } = require('../src/survival/planner')
  const blocks = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    blocks.push({ known: true, name: 'minecraft:stone', position: { x, y: 61, z }, boundingBox: 'block' })
    blocks.push({ known: true, name: x >= 2 ? 'minecraft:sand' : 'minecraft:stone', position: { x, y: 62, z }, boundingBox: 'block' })
    blocks.push({ known: true, name: x >= 2 ? 'minecraft:sand' : 'minecraft:grass_block', position: { x, y: 63, z }, boundingBox: 'block' })
    for (const y of [64, 65, 66]) blocks.push({ known: true, name: 'minecraft:air', position: { x, y, z }, boundingBox: 'empty' })
  }
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', position: { x: 0.5, y: 65.62, z: 0.5 }, heldItem: { name: 'minecraft:stone_pickaxe', slot: 0 }, inventory: { known: true, items: [{ name: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] } }
  const material = { blocks: ['sand', 'red_sand'], items: ['sand', 'red_sand'], count: 6 }
  const out = nextBootstrapAction(state, { blocks, canScan: true, capabilities: { break_block: true, move: true, scan_blocks: true, equip: true, collect_drops: true } }, { stoneCount: 2304, material })
  assert.equal(out.type, 'mine_stone', JSON.stringify(out))
  assert.equal(out.target.y, 63)
  assert.equal(out.material, true)
})

test('when all house materials are held during repair, mineral actions wait on house completion instead of coal mining', () => {
  const shared = { playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: false, built: true, left: { cobblestone: 4, torch: 2 }, repair: { state: 'running', since: 1 } } }
  const state = { inventory: inv([['stone_pickaxe', 1], ['cobblestone', 20], ['oak_log', 4]]) }
  const out = withHouseSupply({ mode: 'player', playing: true, shared, state, getBlock: () => ({ known: false }), decision: { type: 'mine_ore', resource: 'iron' }, planLogs: () => null, planStone: () => null })
  assert.equal(out.type, 'wait')
  assert.equal(out.code, 'HOUSE_BUILD_PENDING')
})

test('after logs, cobblestone and sand: nearby coal ore is mined for the house, and missing coal falls back cleanly', () => {
  const { houseCoalInput } = require('../src/modes/house/house-supply')
  const base = { type: 'tunnel' }
  const state = { inventory: inv([['stone_pickaxe', 1], ['birch_log', 44], ['cobblestone', 68], ['sand', 6]]) }
  const asked = []
  const coal = withHouseSupply({ mode: 'player', playing: true, shared: {}, state, decision: base, planLogs: () => null, planStone: () => null, planSand: () => null, planCoal: count => { asked.push(count); return { type: 'mine_stone', material: true } } })
  assert.equal(coal.type, 'mine_stone')
  assert.deepEqual(asked, [2])
  assert.equal(houseCoalInput(state, {}, 2).options.material.count, 2)
  assert.deepEqual(houseCoalInput(state, {}, 2).options.material.blocks, ['coal_ore', 'deepslate_coal_ore'])
  const fallback = withHouseSupply({ mode: 'player', playing: true, shared: {}, state, decision: base, planLogs: () => null, planStone: () => null, planSand: () => null, planCoal: () => ({ type: 'scan_blocks' }) })
  assert.equal(fallback, base)
})
