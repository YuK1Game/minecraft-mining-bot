'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHouseBuild, order } = require('../src/modes/house/house-build')
const { placements, remaining } = require('../src/modes/house/house-blueprint')
const { findSite } = require('../src/modes/house/house-site')
const { clicks } = require('../src/modes/house/house-steps')

const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
// Grass at y 63 everywhere; the Bot on it at (0.5, 64, 0.5).
function world () {
  const cells = new Map()
  const getBlock = (x, y, z) => cells.get(`${x},${y},${z}`) ?? (y <= 63 ? { known: true, name: 'minecraft:grass_block', boundingBox: 'block' } : air)
  const set = (cell, name) => cells.set(`${cell.x},${cell.y},${cell.z}`, { known: true, name, boundingBox: /torch|door|bed/.test(name) ? 'partial' : 'block' })
  return { getBlock, set, cells }
}

test('site: the nearest flat 7x8 patch; the floor goes one above the ground', () => {
  const w = world()
  const origin = findSite(w.getBlock, { x: 0.5, y: 64, z: 0.5 })
  assert.equal(origin.y, 64)
  w.set({ x: origin.x + 2, y: 64, z: origin.z + 2 }, 'minecraft:oak_log')
  assert.notDeepEqual(findSite(w.getBlock, { x: 0.5, y: 64, z: 0.5 }), origin)
})

test('order: the floor, then the table and furnaces, then the rest; slabs click the slab beside them', () => {
  const steps = order(placements({ x: 0, y: 64, z: 0 }))
  const floor = steps.filter(step => step.phase === 'foundation').length
  assert.equal(floor, 52)
  assert.ok(steps.slice(0, floor).every(step => step.phase === 'foundation'))
  assert.deepEqual(steps.slice(floor, floor + 3).map(step => step.id), ['p_178', 'p_179', 'p_180'])
  const w = world()
  const slab = placements({ x: 0, y: 64, z: 0 }).find(step => step.item === 'oak_slab' && step.position.x === 2 && step.position.z === 2)
  w.set({ x: 1, y: 68, z: 2 }, 'minecraft:birch_slab')
  assert.deepEqual(clicks(w.getBlock, slab).map(click => [click.face, click.clickY]), [[5, 0.25]])
})

test('with the materials held: builds every step in order and marks the house done', async () => {
  const w = world()
  const feet = { x: 0.5, y: 64, z: 0.5 }
  const inventory = { known: true, items: [] }
  const give = (name, count) => { const item = inventory.items.find(stack => stack.name === name); if (item) item.count += count; else inventory.items.push({ name, count, slot: inventory.items.length }) }
  const take = (name, count) => { const item = inventory.items.find(stack => stack.name === name); item.count -= count; if (item.count <= 0) inventory.items.splice(inventory.items.indexOf(item), 1) }
  for (const [name, count] of [['wooden_pickaxe', 1], ['birch_log', 44], ['cobblestone', 68], ['sand', 6], ['white_wool', 3], ['coal', 2]]) give(`minecraft:${name}`, count)
  const crafted = []
  const recipes = { 'minecraft:birch_planks': [4, [['minecraft:birch_log', 1]]], 'minecraft:crafting_table': [1, [['minecraft:birch_planks', 4]]], 'minecraft:birch_slab': [6, [['minecraft:birch_planks', 3]]], 'minecraft:birch_door': [3, [['minecraft:birch_planks', 6]]], 'minecraft:chest': [1, [['minecraft:birch_planks', 8]]], 'minecraft:bed': [1, [['minecraft:white_wool', 3], ['minecraft:birch_planks', 3]]], 'minecraft:furnace': [1, [['minecraft:cobblestone', 8]]], 'minecraft:stick': [4, [['minecraft:birch_planks', 2]]], 'minecraft:torch': [4, [['minecraft:coal', 1], ['minecraft:stick', 1]]] }
  const ports = {
    craft: async (output, times) => { crafted.push([output, times]); const [yieldCount, parts] = recipes[output]; for (const [name, n] of parts) take(name, n * times); give(output, yieldCount * times); return true },
    smelt: async (at, input, count, fuel, fuelCount, output) => { take(input, count); take(fuel, fuelCount); give(output, count); return count },
    place: async (name, plan) => {
      const step = placements(shared.playerHouse.origin).find(s => s.position.x === plan.position.x && s.position.y === plan.position.y && s.position.z === plan.position.z)
      take(name, 1)
      for (const cell of step.cells) w.set(cell, name)
      return true
    },
    mine: async () => true, why: () => null
  }
  const shared = { playerWanted: true }
  const lines = []
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: text => lines.push(text), sleep: async () => {},
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true },
    ports, hands: { walk: async stand => { Object.assign(feet, stand); return true }, approach: async () => true },
    climb: async () => ({ ok: true }), travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock: w.getBlock, getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getFeet: () => ({ ...feet }), getInventory: () => inventory
  })
  assert.equal(await build.tick(), true, lines.join('\n'))
  assert.equal(remaining(w.getBlock, shared.playerHouse.origin).length, 0, lines.join('\n'))
  assert.equal(shared.playerHouse.done, true)
  assert.match(lines.join('\n'), /拠点の家が完成しました/)
  assert.ok(crafted.some(([output]) => output === 'minecraft:bed'))
})
