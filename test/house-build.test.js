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

test('site: ground up to two lower in some columns still fits; the floor goes one above the highest ground', () => {
  const w = world()
  // Bumpy ground: every odd x column is one lower (air at 63).
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) if (x % 2) w.cells.set(`${x},63,${z}`, air)
  assert.equal(findSite(w.getBlock, { x: 0.5, y: 64, z: 0.5 }, { radius: 6 }).y, 64)
  // Two lower still fits; three is too uneven.
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) if (x % 2) w.cells.set(`${x},62,${z}`, air)
  assert.equal(findSite(w.getBlock, { x: 0.5, y: 64, z: 0.5 }, { radius: 6 }).y, 64)
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) if (x % 2) w.cells.set(`${x},61,${z}`, air)
  assert.equal(findSite(w.getBlock, { x: 0.5, y: 64, z: 0.5 }, { radius: 6 }), null)
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

test('without sand or wool: builds the rest and leaves the glass and the bed', async () => {
  const w = world()
  const feet = { x: 0.5, y: 64, z: 0.5 }
  const inventory = { known: true, items: [] }
  const give = (name, count) => { const item = inventory.items.find(stack => stack.name === name); if (item) item.count += count; else inventory.items.push({ name, count, slot: inventory.items.length }) }
  const take = (name, count) => { const item = inventory.items.find(stack => stack.name === name); item.count -= count; if (item.count <= 0) inventory.items.splice(inventory.items.indexOf(item), 1) }
  for (const [name, count] of [['wooden_pickaxe', 1], ['birch_log', 44], ['cobblestone', 68], ['coal', 2]]) give(`minecraft:${name}`, count)
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
  const lines = [], done = []
  let starts = 0
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: text => lines.push(text), sleep: async () => {},
    agent: { objective: {}, start: async () => { starts++ }, stop: () => {}, settled: () => true },
    ports, hands: { walk: async stand => { Object.assign(feet, stand); return true }, approach: async () => true },
    climb: async () => ({ ok: true }), travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock: w.getBlock, getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getFeet: () => ({ ...feet }), getInventory: () => inventory, onDone: async origin => { done.push(origin) }
  })
  assert.equal(await build.tick(), true, lines.join('\n'))
  const left = remaining(w.getBlock, shared.playerHouse.origin)
  assert.deepEqual([...new Set(left.map(step => step.item))].sort(), ['glass', 'white_bed'], lines.join('\n'))
  assert.notEqual(shared.playerHouse.done, true)
  assert.equal(done.length, 1)
  // Only the glass and the bed are left and nothing to make them: the agent goes on.
  assert.equal(starts, 1)
})

test('no site nearby: walks about 80 m on and looks again there', async () => {
  const w = world()
  const feet = { x: 0.5, y: 64, z: 0.5 }
  // Only ground received around x 80 (a flat patch there); unknown elsewhere.
  const getBlock = (x, y, z) => x >= 70 && x <= 100 && z >= -20 && z <= 20 ? w.getBlock(x, y, z) : { known: false }
  const inventory = { known: true, items: [['wooden_pickaxe', 1], ['oak_log', 44], ['cobblestone', 68]].map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const shared = { playerWanted: true }
  const trips = [], lines = [], walks = []
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: text => lines.push(text), sleep: async () => {},
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true },
    ports: { craft: async () => false, smelt: async () => 0, place: async () => false, mine: async () => true, why: () => null },
    hands: { walk: async stand => { walks.push(stand); return false }, approach: async () => false, why: () => 'test' },
    climb: async () => ({ ok: true }),
    travel: { to: async ({ destination }) => { trips.push(destination); Object.assign(feet, { x: destination.x - 14.5, z: destination.z + 0.5 }) }, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock, getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getFeet: () => ({ ...feet }), getInventory: () => inventory
  })
  await build.tick()
  assert.deepEqual(trips[0], { x: 81, z: 1 }, lines.join('\n'))
  assert.ok(shared.playerHouse?.origin, lines.join('\n'))
  assert.ok(shared.playerHouse.origin.x >= 70)
  // Long travel stops short: walks on to the porch first.
  const porch = { x: shared.playerHouse.origin.x + 3.5, z: shared.playerHouse.origin.z + 8.5 }
  assert.ok(walks.length && Math.hypot(walks[0].x - porch.x, walks[0].z - porch.z) <= 4, JSON.stringify(walks[0]))
})

test('far from the porch: hops about 9 m at a time over received ground, then builds', async () => {
  const w = world()
  const feet = { x: 30.5, y: 64, z: 8.5 }
  const inventory = { known: true, items: [['wooden_pickaxe', 1], ['oak_log', 44], ['cobblestone', 68]].map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const shared = { playerWanted: true, playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: false } }
  const walks = [], lines = []
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: text => lines.push(text), sleep: async () => {},
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true },
    ports: { craft: async () => false, smelt: async () => 0, place: async () => false, mine: async () => true, why: () => null },
    hands: { walk: async stand => { walks.push(stand); if (Math.hypot(stand.x - feet.x, stand.z - feet.z) > 16) return false; Object.assign(feet, stand); return true }, approach: async () => true, why: () => 'test' },
    climb: async () => ({ ok: true }), travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock: w.getBlock, getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getFeet: () => ({ ...feet }), getInventory: () => inventory
  })
  await build.tick()
  assert.ok(walks.length >= 3, JSON.stringify(walks))
  assert.ok(Math.hypot(walks[0].x - 30.5, walks[0].z - 8.5) <= 11, JSON.stringify(walks[0]))
  assert.ok(Math.hypot(feet.x - 3.5, feet.z - 8.5) <= 5, JSON.stringify(feet))
})

test('out on a hilltop 23 above the house, close on the map: walks down toward it, height counted (live 2026-11-17 05:14 JST)', async () => {
  const w = world()
  // A hill: ground at 86 east of x=6 (feet 87), the house's ground at 63 to the west.
  for (let x = 6; x <= 40; x++) for (let z = -20; z <= 30; z++) for (let y = 64; y <= 86; y++) w.cells.set(`${x},${y},${z}`, { known: true, name: 'minecraft:stone', boundingBox: 'block' })
  const feet = { x: 10.5, y: 87, z: 8.5 }
  const inventory = { known: true, items: [['wooden_pickaxe', 1], ['oak_log', 44], ['cobblestone', 68]].map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const shared = { playerWanted: true, playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: false } }
  const walks = [], lines = [], places = []
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: text => lines.push(text), sleep: async () => {},
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true },
    ports: { craft: async () => false, smelt: async () => 0, place: async () => { places.push(1); return false }, mine: async () => true, why: () => null },
    // A walk cannot drop more than 8 blocks at once.
    hands: { walk: async stand => { walks.push(stand); if (feet.y - stand.y > 8) return false; Object.assign(feet, stand); return true }, approach: async () => true, why: () => 'test' },
    climb: async () => ({ ok: true }), travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock: w.getBlock, getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getFeet: () => ({ ...feet }), getInventory: () => inventory
  })
  await build.tick()
  // The hill is a cliff: no walk reaches the house's height, so nothing is tried from the top.
  assert.equal(places.length, 0)
  assert.match(lines.join('\n'), /拠点の家の前まで歩けません/)
})
