'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHouseSand, spiralPoint } = require('../src/modes/house/house-sand')

const inv = items => ({ known: true, items: items.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })
const READY = [['stone_pickaxe', 1], ['oak_log', 64], ['cobblestone', 64], ['cobblestone', 64], ['white_wool', 3], ['coal', 4]]

function job ({ items = READY, sand = null, covered = false } = {}) {
  const calls = [], lines = []
  let busy = false
  const house = createHouseSand({
    getMode: () => 'player', shared: { playerWanted: true, playerHouse: { origin: { x: 100, y: 64, z: 200 } } }, log: text => lines.push(text), sleep: async () => { busy = false },
    getState: () => ({ position: { x: 100, y: 65, z: 180 }, inventory: inv(items) }),
    getBlock: () => covered ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : null,
    scan: async () => sand,
    travel: { to: async input => { calls.push(input); busy = true }, status: () => ({ busy }), cancel: async () => {} },
    agent: { objective: {}, start: async () => { calls.push('start') }, stop: () => calls.push('stop'), settled: () => true }
  })
  return { house, calls, lines }
}

test('no sand received: the autonomy stops and the Bot walks a spiral around the house', async () => {
  const f = job()
  assert.equal(await f.house.tick(), true)
  assert.deepEqual(f.calls, ['stop', { destination: spiralPoint({ x: 100, z: 200 }, 0) }, 'start'])
  assert.deepEqual(spiralPoint({ x: 100, z: 200 }, 0), { x: 196, z: 200 })
  assert.match(f.lines.join('\n'), /砂を探しに \(196, 200\)/)
})

test('received sand far away: walk to it; near sand is left to the house supply', async () => {
  const far = job({ sand: { x: 150, z: 250, distance: 60 } })
  assert.equal(await far.house.tick(), true)
  assert.deepEqual(far.calls[1], { destination: { x: 150, z: 250 } })
  const near = job({ sand: { x: 105, z: 185, distance: 7 } })
  assert.equal(await near.house.tick(), null)
  assert.deepEqual(near.calls, [])
})

test('nothing while logs or cobblestone are short, the sand is held, or under a roof', async () => {
  assert.equal(await job({ items: [['stone_pickaxe', 1]] }).house.tick(), null)
  assert.equal(await job({ items: [...READY, ['sand', 6]] }).house.tick(), null)
  assert.equal(await job({ covered: true }).house.tick(), null)
})

test('sand the trip could not reach is passed over on the next scan', async () => {
  const scans = [], lines = []
  let t = 0, busy = false
  const house = createHouseSand({
    getMode: () => 'player', shared: { playerWanted: true, playerHouse: { origin: { x: 100, y: 64, z: 200 } } }, log: text => lines.push(text), sleep: async () => { busy = false }, now: () => t,
    getState: () => ({ position: { x: 100, y: 65, z: 180 }, inventory: inv(READY) }),
    getBlock: () => null,
    scan: async input => { scans.push(input.avoid.map(p => ({ x: p.x, z: p.z }))); return { x: 150, z: 250, distance: 60 } },
    travel: { to: async () => { busy = true }, status: () => ({ busy }), cancel: async () => {} },
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true }
  })
  assert.equal(await house.tick(), true)
  t = 120000
  await house.tick()
  assert.deepEqual(scans, [[], [{ x: 150, z: 250 }]])
  assert.match(lines.join('\n'), /砂 \(150, 250\) へ行けなかった/)
})

test('sand under water is not a destination; sand under open air is', async () => {
  const calls = []
  let busy = false
  const blocks = { '130,60,180': 'sand', '130,61,180': 'water', '160,60,180': 'sand', '160,61,180': 'air' }
  const house = createHouseSand({
    getMode: () => 'player', shared: { playerWanted: true, playerHouse: { origin: { x: 100, y: 64, z: 200 } } }, sleep: async () => { busy = false },
    getState: () => ({ position: { x: 100, y: 63.62, z: 180 }, inventory: inv(READY) }),
    getBlock: (x, y, z) => { const name = blocks[`${x},${y},${z}`]; return name ? { known: true, name: `minecraft:${name}` } : y > 70 ? { known: true, name: 'minecraft:air' } : null },
    travel: { to: async input => { calls.push(input.destination); busy = true }, status: () => ({ busy }), cancel: async () => {} },
    agent: { objective: {}, start: async () => {}, stop: () => {}, settled: () => true }
  })
  assert.equal(await house.tick(), true)
  assert.deepEqual(calls, [{ x: 160, z: 180 }])
})
