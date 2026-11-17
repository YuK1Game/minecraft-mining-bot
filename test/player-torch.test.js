'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerTorch, torchNear, torchSpots, torchSupply } = require('../src/modes/player-torch')

// A one-wide tunnel along x at feet y 40 inside stone; `extra` overrides cells.
function tunnel (extra = {}) {
  const cells = new Map(Object.entries(extra))
  return (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cells.has(key)) return cells.get(key)
    if (z === 0 && (y === 40 || y === 41)) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  }
}
const stack = (name, count, slot) => ({ name: `minecraft:${name}`, count, slot })
const feet = { x: 0.5, y: 40, z: 0.5 }

test('a torch within eight blocks counts, a farther one does not', () => {
  assert.equal(torchNear(tunnel({ '6,40,0': { known: true, name: 'minecraft:torch', boundingBox: 'empty' } }), feet), true)
  assert.equal(torchNear(tunnel({ '9,40,0': { known: true, name: 'minecraft:torch', boundingBox: 'empty' } }), feet), false)
  assert.equal(torchNear(tunnel(), feet), false)
})

test('spots are received air on a full block beside the feet', () => {
  assert.deepEqual(torchSpots(tunnel(), feet), [{ x: 1, y: 40, z: 0 }, { x: -1, y: 40, z: 0 }])
  assert.deepEqual(torchSpots(tunnel({ '1,40,0': { known: false }, '-1,39,0': { known: true, name: 'minecraft:gravel', boundingBox: 'block' } }), feet), [])
})

test('coal for smelting and sticks for the next pickaxe are kept', () => {
  const inv = (...items) => ({ known: true, items })
  assert.equal(torchSupply(inv(stack('torch', 3, 4))), 'place')
  assert.equal(torchSupply(inv(stack('coal', 8, 1), stack('stick', 3, 2))), 'craft')
  assert.equal(torchSupply(inv(stack('coal', 2, 1), stack('stick', 8, 2))), null)
  assert.equal(torchSupply(inv(stack('coal', 8, 1), stack('stick', 2, 2), stack('oak_planks', 2, 3))), 'sticks')
  assert.equal(torchSupply(inv(stack('coal', 8, 1), stack('stick', 2, 2), stack('oak_planks', 4, 3))), null)
  assert.equal(torchSupply({ known: false, items: [stack('torch', 3, 4)] }), null)
})

function job ({ items, getBlock = tunnel(), running = true, blocked = false }) {
  const calls = [], cells = new Map(), inventory = { known: true, items }
  const world = (x, y, z) => cells.get(`${x},${y},${z}`) ?? getBlock(x, y, z)
  const count = name => inventory.items.find(item => item.name === `minecraft:${name}`)
  const torch = createPlayerTorch({
    getMode: () => 'player', shared: { playerWanted: true }, getBlock: world, getFeet: () => feet, getInventory: () => inventory,
    agent: { objective: { objective: 'diamond' }, running: () => running, settled: () => true, stop: () => calls.push('stop'), start: async () => calls.push('start') },
    blocked: () => blocked, log: line => calls.push(line), sleep: async () => {}, now: () => 1000000,
    hands: {
      craft: async output => { calls.push(`craft ${output}`); if (output === 'minecraft:torch') { count('coal').count--; count('stick').count--; inventory.items.push(stack('torch', 4, 5)) } else { count('oak_planks').count -= 2; count('stick').count += 4 } return true },
      place: async cell => { calls.push(`place ${cell.x},${cell.y},${cell.z}`); cells.set(`${cell.x},${cell.y},${cell.z}`, { known: true, name: 'minecraft:torch', boundingBox: 'empty' }); count('torch').count--; return true }
    }
  })
  return { torch, calls, world }
}

test('underground with no torch near: crafts from coal and sticks, places one, plays on', async () => {
  const f = job({ items: [stack('coal', 8, 1), stack('stick', 2, 2), stack('oak_planks', 2, 3)] })
  assert.equal(await f.torch.tick(), true)
  assert.deepEqual(f.calls.filter(call => !call.startsWith('プレイヤー')), ['stop', 'craft minecraft:stick', 'craft minecraft:torch', 'place 1,40,0', 'start'])
  assert.equal(f.world(1, 40, 0).name, 'minecraft:torch')
  assert.equal(f.torch.status().placed, 1)
})

test('nothing happens with a torch near, under the open sky, without supplies or while something else works', async () => {
  const lit = job({ items: [stack('torch', 5, 4)], getBlock: tunnel({ '3,40,0': { known: true, name: 'minecraft:torch', boundingBox: 'empty' } }) })
  assert.equal(await lit.torch.tick(), null)
  const sky = job({ items: [stack('torch', 5, 4)], getBlock: (x, y, z) => y < 40 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' } })
  assert.equal(await sky.torch.tick(), null)
  const poor = job({ items: [stack('coal', 1, 1), stack('stick', 9, 2)] })
  assert.equal(await poor.torch.tick(), null)
  const held = job({ items: [stack('torch', 5, 4)], blocked: true })
  assert.equal(await held.torch.tick(), null)
  assert.deepEqual([...lit.calls, ...sky.calls, ...poor.calls, ...held.calls], [])
})

test('spots behind the heading come first: a torch ahead in the tunnel is mined away (live 2026-11-18 02:18 JST)', () => {
  assert.deepEqual(torchSpots(tunnel(), feet, { x: 4, y: 0, z: 0 }), [{ x: -1, y: 40, z: 0 }, { x: 1, y: 40, z: 0 }])
  assert.deepEqual(torchSpots(tunnel(), feet, { x: -4, y: 0, z: 0 }), [{ x: 1, y: 40, z: 0 }, { x: -1, y: 40, z: 0 }])
})

test('a placed torch that is gone again is not placed in that cell a second time', async () => {
  const f = job({ items: [stack('torch', 5, 4)] })
  const cells = new Map()
  const calls = []
  const torch = createPlayerTorch({
    getMode: () => 'player', shared: { playerWanted: true }, getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? tunnel()(x, y, z), getFeet: () => feet, getInventory: () => ({ known: true, items: [stack('torch', 5, 4)] }),
    agent: { objective: {}, running: () => true, settled: () => true, stop: () => {}, start: async () => {} },
    log: line => calls.push(line), sleep: async () => {}, now: (() => { let t = 1000000; return () => (t += 100000) })(),
    // The cell turns back to air right after the placement.
    hands: { craft: async () => false, place: async cell => { calls.push(`place ${cell.x},${cell.y},${cell.z}`); return true } }
  })
  assert.equal(await torch.tick(), false)
  assert.ok(calls.some(line => /置いた松明が残っていません \(1, 40, 0\)/.test(line)), calls.join('|'))
  assert.equal(await torch.tick(), false)
  assert.deepEqual(calls.filter(line => line.startsWith('place')), ['place 1,40,0', 'place -1,40,0'])
  void f
})
