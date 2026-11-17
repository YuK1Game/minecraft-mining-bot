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

test('underground with no base: climbs out, makes the base chest there and banks', async () => {
  const { api, shared, calls, writes } = rig({ cover: true })
  assert.equal(await api.tick(), true)
  assert.deepEqual(calls.slice(0, 4), ['stop', 'climb', 'chest', ['store', { x: 1, y: 64, z: 1 }, 11]])
  assert.deepEqual(shared.playerBase, { x: 1, y: 64, z: 1 })
  assert.deepEqual(writes[0].chest, { x: 1, y: 64, z: 1 })
  assert.equal(calls.at(-1), 'start')
})

test('a far base: long walk there, a walk beside the chest, then the deposit', async () => {
  const { api, calls } = rig({ base: { x: 5, y: 64, z: 0 }, position: { x: 300, y: 65.62, z: 0 } })
  assert.equal(await api.tick(), true)
  assert.deepEqual(calls[1], ['travel', { x: 5, z: 0 }])
  assert.equal(calls[2][0], 'walk')
  assert.deepEqual(calls[3], ['store', { x: 5, y: 64, z: 0 }, 11])
})

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

test('no base and no wood underground: climbs out only, no chest', async () => {
  const calls = []
  const shared = { playerWanted: true, playerBase: null }
  let covered = true
  const getBlock = (x, y, z) => covered && y === 70 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const api = createPlayerBase({
    getMode: () => 'player', shared, getBlock, getPosition: () => ({ x: 0, y: 65.62, z: 0 }), getFeet: () => ({ x: 0, y: 64, z: 0 }), getInventory: () => inv([[0, 'diamond', 64]]), canBuild: () => false,
    agent: { objective: {}, start: async () => calls.push('start'), stop: () => calls.push('stop'), settled: () => true },
    climb: async () => { calls.push('climb'); covered = false; return { ok: true } },
    chest: async () => { calls.push('chest'); return null },
    travel: { status: () => ({ busy: false }) }, log: () => {}, sleep: async () => {}
  })
  assert.equal(await api.tick(), false)
  assert.deepEqual(calls, ['stop', 'climb', 'start'])
})

const { bankableAll, diamondsNeeded } = require('../src/modes/player-base-kit')
test('everything but the kit is banked (user 11:09 JST: 必要最低限のアイテム以外はチェストに格納)', () => {
  const items = inv([[0, 'diamond_pickaxe', 1], [1, 'iron_pickaxe', 1], [2, 'stone_pickaxe', 1], [3, 'diamond_sword', 1], [4, 'stone_sword', 1], [5, 'cooked_beef', 10], [6, 'torch', 30], [7, 'coal', 40], [8, 'iron_ingot', 20], [9, 'emerald', 2], [10, 'string', 5], [11, 'cobblestone', 100], [12, 'oak_log', 30], [13, 'diamond', 12], [14, 'bone', 3]])
  const worn = { known: true, worn: ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ piece, name: `minecraft:diamond_${piece}` })) }
  const out = Object.fromEntries(bankableAll(items, { worn }).map(stack => [stack.name.replace('minecraft:', ''), stack.count]))
  assert.deepEqual(out, { coal: 24, iron_ingot: 12, cobblestone: 28, oak_log: 20, diamond: 12, stone_pickaxe: 1, stone_sword: 1, emerald: 2, string: 5, bone: 3 })
  assert.equal(diamondsNeeded([], null), 29)
  assert.equal(diamondsNeeded(items.items, worn), 0)
  assert.deepEqual(bankableAll({ known: true, uncertain: true, items: [] }), [])
})
