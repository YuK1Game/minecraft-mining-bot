'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerBase, bankable, standBeside, loadBaseSync } = require('../src/modes/player-base')

const inv = items => ({ known: true, items: items.map(([slot, name, count]) => ({ slot, name: `minecraft:${name}`, count })) })

test('bankable keeps 8 diamonds in the largest stack and takes valuables and rubble', () => {
  const stacks = bankable(inv([[0, 'diamond', 64], [1, 'diamond', 50], [2, 'emerald', 3], [3, 'iron_ingot', 9], [4, 'tuff', 20], [5, 'coal', 12]]))
  assert.deepEqual(stacks.find(s => s.slot === 0), { slot: 0, name: 'minecraft:diamond', count: 56 })
  assert.deepEqual(stacks.find(s => s.slot === 1), { slot: 1, name: 'minecraft:diamond', count: 50 })
  assert.ok(stacks.some(s => s.name === 'minecraft:emerald'))
  assert.ok(stacks.some(s => s.name === 'minecraft:tuff'))
  assert.ok(!stacks.some(s => /iron_ingot|coal/.test(s.name)))
  assert.deepEqual(bankable({ known: true, uncertain: true, items: [] }), [])
})

// A flat world: stone below y=64, air above; a chest at (5,64,0).
function world (extra = {}) {
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (extra[key]) return { known: true, name: extra[key], boundingBox: 'block' }
    return y < 64 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}

test('standBeside picks an open cell on solid ground next to the chest', () => {
  const at = standBeside(world({ '5,64,0': 'minecraft:chest' }), { x: 5, y: 64, z: 0 })
  assert.deepEqual(at, { x: 6.5, y: 64, z: 0.5 })
})

function rig ({ base = null, position = { x: 0, y: 65.62, z: 0 }, items = [[0, 'diamond', 40]], cover = false } = {}) {
  const shared = { playerWanted: true, playerBase: base }
  const calls = []
  let inventory = inv(items), pos = { ...position }
  const blocks = world({ '5,64,0': 'minecraft:chest' })
  let covered = cover
  const getBlock = (x, y, z) => (covered && x === 0 && z === 0 && y === 70) ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : blocks(x, y, z) ?? null
  const writes = []
  const api = createPlayerBase({
    getMode: () => 'player', shared, getBlock, getPosition: () => pos, getFeet: () => ({ x: pos.x, y: pos.y - 1.62, z: pos.z }), getInventory: () => inventory,
    agent: { objective: {}, start: async () => calls.push('start'), stop: () => calls.push('stop'), settled: () => true },
    hands: {
      store: async (at, stacks) => { calls.push(['store', at, stacks.reduce((s, x) => s + x.count, 0)]); inventory = inv([[0, 'diamond', 8]]); return stacks.reduce((s, x) => s + x.count, 0) },
      room: () => 10
    },
    chest: async () => { calls.push('chest'); return { x: 1, y: 64, z: 1 } },
    climb: async () => { calls.push('climb'); covered = false; return { ok: true } },
    travel: { to: async ({ destination }) => { calls.push(['travel', destination]); pos = { x: destination.x + 3, y: 65.62, z: destination.z } }, status: () => ({ busy: false }), cancel: async () => {} },
    walk: async target => { calls.push(['walk', target]); pos = { x: target.x, y: target.y + 1.62, z: target.z }; return true },
    approach: async () => true,
    file: '/nowhere', write: async (file, data) => writes.push(data),
    log: () => {}, sleep: async () => {}
  })
  return { api, shared, calls, writes }
}

test('few spare diamonds far from the base: no trip', async () => {
  const { api, calls } = rig({ base: { x: 5, y: 64, z: 0 }, position: { x: 300, y: 65.62, z: 0 }, items: [[0, 'diamond', 20]] })
  assert.equal(await api.tick(), null)
  assert.deepEqual(calls, [])
})

test('loadBaseSync reads the saved chest and ignores a broken file', () => {
  assert.deepEqual(loadBaseSync('x', { io: { readFileSync: () => '{"chest":{"x":1,"y":2,"z":3}}' } }), { x: 1, y: 2, z: 3 })
  assert.equal(loadBaseSync('x', { io: { readFileSync: () => '{' } }), null)
})

test('no base and no wood on the surface: no trip (the wood is gathered first)', async () => {
  const calls = []
  const shared = { playerWanted: true, playerBase: null }
  const api = createPlayerBase({ getMode: () => 'player', shared, getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }), getPosition: () => ({ x: 0, y: 65.62, z: 0 }), getFeet: () => ({ x: 0, y: 64, z: 0 }), getInventory: () => inv([[0, 'diamond', 64]]), canBuild: () => false, agent: { stop: () => calls.push('stop') }, travel: { status: () => ({ busy: false }) } })
  assert.equal(await api.tick(), null)
  assert.deepEqual(calls, [])
})

const { bankableAll, diamondsNeeded } = require('../src/modes/player-base-kit')
test('everything but the kit is banked (user 11:09 JST: 必要最低限のアイテム以外はチェストに格納)', () => {
  const items = inv([[0, 'diamond_pickaxe', 1], [1, 'iron_pickaxe', 1], [2, 'stone_pickaxe', 1], [3, 'diamond_sword', 1], [4, 'stone_sword', 1], [5, 'cooked_beef', 10], [6, 'torch', 30], [7, 'coal', 40], [8, 'iron_ingot', 20], [9, 'emerald', 2], [10, 'string', 5], [11, 'cobblestone', 100], [12, 'oak_log', 30], [13, 'diamond', 12], [14, 'bone', 3]])
  const worn = { known: true, worn: ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ piece, name: `minecraft:diamond_${piece}` })) }
  const out = Object.fromEntries(bankableAll(items, { worn }).map(stack => [stack.name.replace('minecraft:', ''), stack.count]))
  assert.deepEqual(out, { coal: 24, iron_ingot: 12, cobblestone: 28, oak_log: 20, diamond: 9, stone_pickaxe: 1, stone_sword: 1, emerald: 2, string: 5, bone: 3 })
  assert.equal(diamondsNeeded([], null), 29)
  assert.equal(diamondsNeeded(items.items, worn), 3)
  assert.deepEqual(bankableAll({ known: true, uncertain: true, items: [] }), [])
})

test('the diamonds of the next pickaxe stay in hand while only one diamond pickaxe is good (live 2026-11-17 18:13 JST)', () => {
  const pick = (slot, used) => ({ slot, name: 'minecraft:diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: used })
  const worn = { known: true, worn: ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ piece, name: `minecraft:diamond_${piece}` })) }
  const sword = { slot: 9, name: 'minecraft:diamond_sword', count: 1 }
  assert.equal(diamondsNeeded([pick(0, 1016), sword], worn), 3)
  assert.equal(diamondsNeeded([pick(0, 1016), pick(1, 0), sword], worn), 0)
  assert.equal(diamondsNeeded([pick(0, 1400), sword], worn), 3)
  assert.equal(diamondsNeeded([pick(0, 1400), pick(1, 1000), sword], worn), 3)
})

test('standBeside never picks the cell on top of the other half of a large chest', () => {
  const at = standBeside(world({ '5,64,0': 'minecraft:chest', '6,64,0': 'minecraft:chest' }), { x: 5, y: 64, z: 0 })
  assert.deepEqual(at, { x: 4.5, y: 64, z: 0.5 })
})

test('after a death near the base: the banked diamonds come back out for the gear (live 2026-11-17 19:09 JST)', async () => {
  const { restockable } = require('../src/modes/player-base-kit')
  const slots = [{ slot: 0, known: true, name: 'minecraft:diamond', count: 64 }, { slot: 1, known: true, name: 'minecraft:coal', count: 40 }, { slot: 2, known: true, name: 'minecraft:tuff', count: 64 }]
  const bare = inv([[0, 'wooden_pickaxe', 1]])
  assert.deepEqual(restockable(bare, { known: true, worn: [] }, slots), [{ chestSlot: 0, name: 'minecraft:diamond', count: 29 }, { chestSlot: 1, name: 'minecraft:coal', count: 16 }])
  const calls = [], shared = { playerWanted: true, playerBase: { x: 5, y: 64, z: 0 } }
  let inventory = bare, seen = null
  const pos = { x: 6.5, y: 65.62, z: 0.5 }
  const api = createPlayerBase({
    getMode: () => 'player', shared, getBlock: world({ '5,64,0': 'minecraft:chest' }), getPosition: () => pos, getFeet: () => ({ x: pos.x, y: pos.y - 1.62, z: pos.z }), getInventory: () => inventory, getWorn: () => ({ known: true, worn: [] }),
    agent: { objective: {}, start: async () => calls.push('start'), stop: () => calls.push('stop'), settled: () => true },
    hands: {
      store: async () => 0, room: () => 10, contents: () => seen,
      take: async (at, pick) => { seen = slots; const picks = pick(slots); calls.push(['take', picks.map(p => p.count)]); inventory = inv([[0, 'wooden_pickaxe', 1], [1, 'diamond', 29], [2, 'coal', 16]]); seen = [{ ...slots[0], count: 35 }, { ...slots[1], count: 24 }, slots[2]]; return 45 }
    },
    chest: async () => null, climb: async () => ({ ok: true }), travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    walk: async () => true, approach: async () => true, log: () => {}, sleep: async () => {}
  })
  assert.equal(await api.tick(), true)
  assert.deepEqual(calls.filter(Array.isArray), [['take', [29, 16]]])
  assert.equal(await api.tick(), null, 'nothing more to take: no second trip')
})

