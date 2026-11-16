'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerStorage, storable, chestsNear, chestCells } = require('../src/modes/player-storage')

const mc = name => `minecraft:${name}`
const inv = rows => ({ known: true, items: rows.map(([name, count, slot, extra = {}]) => ({ name: mc(name), count, slot, ...extra })) })

test('rubble, the stone over the reserve and worn pickaxes are stored; valuables stay', () => {
  const list = storable(inv([
    ['cobblestone', 64, 0], ['cobblestone', 28, 1], ['dirt', 20, 2], ['cobbled_deepslate', 64, 3], ['diorite', 20, 4], ['leaf_litter', 8, 5],
    ['diamond', 18, 6], ['raw_iron', 1, 7], ['oak_log', 5, 8],
    ['iron_pickaxe', 1, 9, { maxDurability: 250, durabilityUsed: 4 }], ['stone_pickaxe', 1, 10, { maxDurability: 131, durabilityUsed: 129 }]
  ]))
  const by = Object.fromEntries(list.map(item => [item.slot, item.count]))
  assert.deepEqual(by, { 1: 28, 3: 64, 4: 20, 5: 8, 10: 1 })
  // The last working pickaxe is never stored, even worn.
  assert.deepEqual(storable(inv([['stone_pickaxe', 1, 0, { maxDurability: 131, durabilityUsed: 129 }]])), [])
  assert.deepEqual(storable({ known: false, items: [] }), [])
})

// Flat stone floor at y=63; feet at y=64.
function world (chests = []) {
  const set = new Map(chests.map(p => [`${p.x},${p.y},${p.z}`, mc('chest')]))
  return (x, y, z) => set.has(`${x},${y},${z}`) ? { known: true, name: set.get(`${x},${y},${z}`), boundingBox: 'block' } : y <= 63 ? { known: true, name: mc('stone'), boundingBox: 'block' } : { known: true, name: mc('air'), boundingBox: 'empty' }
}
const feet = { x: 0.5, y: 64, z: 0.5 }

test('a new large chest takes two cells side by side; a single chest gets a neighbour', () => {
  const pair = chestCells(world(), feet)
  assert.equal(pair.length, 2)
  assert.equal(Math.abs(pair[0].x - pair[1].x) + Math.abs(pair[0].z - pair[1].z), 1)
  assert.ok(pair.every(cell => cell.y === 64 && !(cell.x === 0 && cell.z === 0)))
  const single = { x: 2, y: 64, z: 0 }
  const found = chestsNear(world([single]), feet)
  assert.equal(found.length, 1)
  assert.equal(found[0].pair, null)
  const next = chestCells(world([single]), feet, single)
  assert.equal(next.length, 1)
  assert.equal(Math.abs(next[0].x - single.x) + Math.abs(next[0].z - single.z), 1)
  const double = chestsNear(world([single, { x: 2, y: 64, z: 1 }]), feet)
  assert.ok(double[0].pair)
})

function job ({ chests = [], inventory, makes = true }) {
  const lines = [], calls = []
  let items = inventory
  const hands = {
    tableNear: () => ({ x: -1, y: 64, z: 0 }),
    craftPlanks: async (log, times) => {
      calls.push(['planks', log, times])
      items = { ...items, items: [...items.items.map(item => item.name === log ? { ...item, count: item.count - times } : item).filter(item => item.count > 0), { name: mc('oak_planks'), count: times * 4, slot: 35 }] }
      return true
    },
    craftSmall: async () => true,
    placeTable: async () => null,
    craftAtTable: async (table, output, times) => { calls.push(['craft', output, times]); if (makes) items = { ...items, items: [...items.items, { name: output, count: times, slot: 30 }] }; return makes },
    place: async (cell, name) => {
      calls.push(['place', cell, name])
      if (name !== mc('chest')) items = { ...items, items: items.items.map(item => item.name === name ? { ...item, count: item.count - 1 } : item).filter(item => item.count > 0) }
      return true
    },
    room: () => null,
    store: async (position, stacks) => { calls.push(['store', position, stacks.length]); return stacks.reduce((sum, stack) => sum + stack.count, 0) }
  }
  const storage = createPlayerStorage({ getMode: () => 'player', shared: { playerWanted: true }, agent: { objective: {}, start: async () => {}, stop: () => {} }, hands, getBlock: world(chests), getFeet: () => feet, getInventory: () => items, log: text => lines.push(text), sleep: async () => {} })
  return { storage, lines, calls }
}
const full = () => inv([...Array.from({ length: 30 }, (_, slot) => ['diamond', 1, slot]), ['oak_planks', 20, 30], ['diorite', 20, 31], ['granite', 16, 32], ['andesite', 13, 33], ['dirt', 20, 34], ['leaf_litter', 8, 35]])

test('a full inventory places a large chest and stores the rubble', async () => {
  const f = job({ inventory: full() })
  assert.equal(await f.storage.tick(), true)
  assert.deepEqual(f.calls.filter(call => call[0] === 'craft').map(call => call.slice(1)), [['minecraft:chest', 2]])
  // The smallest stone stack (13 andesite) is set down first so a craft has an empty slot.
  const placed = f.calls.filter(call => call[0] === 'place')
  assert.equal(placed.filter(call => call[2] === mc('andesite')).length, 13)
  const chests = placed.filter(call => call[2] === mc('chest')).map(call => `${call[1].x},${call[1].y},${call[1].z}`)
  assert.equal(chests.length, 2)
  assert.ok(placed.filter(call => call[2] === mc('andesite')).every(call => !chests.includes(`${call[1].x},${call[1].y},${call[1].z}`) && !chests.includes(`${call[1].x},${call[1].y - 1},${call[1].z}`)))
  assert.match(f.lines.join('\n'), /andesite 13 個を足元の横に置きました/)
  assert.equal(f.calls.find(call => call[0] === 'store')[2], 3)
  assert.match(f.lines.join('\n'), /ラージチェストを置きました/)
})

test('a single chest nearby is made large and used; a large chest is used as it is', async () => {
  const single = job({ inventory: full(), chests: [{ x: 2, y: 64, z: 0 }] })
  assert.equal(await single.storage.tick(), true)
  assert.deepEqual(single.calls.filter(call => call[0] === 'craft').map(call => call[2]), [1])
  assert.equal(single.calls.filter(call => call[0] === 'place' && call[2] === mc('chest')).length, 1)
  assert.deepEqual(single.calls.find(call => call[0] === 'store')[1], { x: 2, y: 64, z: 0 })
  const double = job({ inventory: full(), chests: [{ x: 2, y: 64, z: 0 }, { x: 2, y: 64, z: 1 }] })
  assert.equal(await double.storage.tick(), true)
  assert.equal(double.calls.filter(call => call[0] !== 'store').length, 0)
})

test('nothing happens below 34 slots or with nothing to store', async () => {
  const few = job({ inventory: inv([['diorite', 20, 0]]) })
  assert.equal(await few.storage.tick(), null)
  const valuables = job({ inventory: inv(Array.from({ length: 36 }, (_, slot) => ['diamond', 1, slot])) })
  assert.equal(await valuables.storage.tick(), null)
})

test('with one empty slot the whole log stack is cut into planks', async () => {
  const f = job({ inventory: inv([...Array.from({ length: 32 }, (_, slot) => ['diamond', 1, slot]), ['diorite', 40, 32], ['oak_log', 5, 33], ['oak_planks', 6, 34]]) })
  assert.equal(await f.storage.tick(), true)
  assert.deepEqual(f.calls.find(call => call[0] === 'planks'), ['planks', mc('oak_log'), 5])
})

test('no empty slot and no small stone stack: the job says why and stops', async () => {
  const f = job({ inventory: inv([...Array.from({ length: 35 }, (_, slot) => ['diamond', 1, slot]), ['diorite', 40, 35]]) })
  assert.equal(await f.storage.tick(), false)
  assert.match(f.lines.join('\n'), /持ち物に空きを作れません/)
  assert.equal(f.calls.filter(call => call[0] === 'craft').length, 0)
})

test('a refused chest cell is skipped and another pair is tried', async () => {
  const calls = []
  let refused = 0
  const items = { known: true, items: [...inv([...Array.from({ length: 33 }, (_, slot) => ['diamond', 1, slot]), ['oak_planks', 20, 33], ['diorite', 20, 34]]).items, { name: mc('chest'), count: 2, slot: 35 }] }
  const hands = {
    tableNear: () => ({ x: -1, y: 64, z: 0 }), craftPlanks: async () => true, craftSmall: async () => true, placeTable: async () => null,
    craftAtTable: async () => true, room: () => null, refusal: () => '設置できません',
    place: async (cell, name) => { calls.push([cell, name]); if (name === mc('chest') && refused === 0) { refused++; return false } return true },
    store: async () => 5
  }
  const storage = createPlayerStorage({ getMode: () => 'player', shared: { playerWanted: true }, agent: { objective: {}, start: async () => {}, stop: () => {} }, hands, getBlock: world(), getFeet: () => feet, getInventory: () => items, log: () => {}, sleep: async () => {} })
  assert.equal(await storage.tick(), true)
  const chests = calls.filter(call => call[1] === mc('chest')).map(([cell]) => `${cell.x},${cell.y},${cell.z}`)
  assert.equal(chests.length, 3)
  assert.ok(!chests.slice(1).includes(chests[0]))
})

test('one chest in hand and no wood for a second: the single chest is placed and used', async () => {
  const calls = []
  const items = { known: true, items: [...inv([...Array.from({ length: 33 }, (_, slot) => ['diamond', 1, slot]), ['oak_planks', 4, 33], ['diorite', 20, 34]]).items, { name: mc('chest'), count: 1, slot: 35 }] }
  const hands = {
    tableNear: () => ({ x: -1, y: 64, z: 0 }), craftPlanks: async () => false, craftSmall: async () => false, placeTable: async () => null,
    craftAtTable: async () => false, room: () => null, refusal: () => null,
    place: async (cell, name) => { calls.push(['place', cell, name]); return true },
    store: async (position, stacks) => { calls.push(['store', position]); return 20 }
  }
  const lines = []
  const storage = createPlayerStorage({ getMode: () => 'player', shared: { playerWanted: true }, agent: { objective: {}, start: async () => {}, stop: () => {} }, hands, getBlock: world(), getFeet: () => feet, getInventory: () => items, log: text => lines.push(text), sleep: async () => {} })
  assert.equal(await storage.tick(), true)
  assert.equal(calls.filter(call => call[0] === 'place').length, 1)
  assert.deepEqual(calls.find(call => call[0] === 'store')[1], calls[0][1])
  assert.match(lines.join('\n'), /チェストを1つ置きました/)
})
