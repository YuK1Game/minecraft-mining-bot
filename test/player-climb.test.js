'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { climbOut } = require('../src/modes/player-climb')

// A column of stone from the floor up to `surface`, air above; the Bot stands at feet y `feetY` in a two-high gap.
function world ({ feetY, surface, extra = {} }) {
  const cells = new Map(Object.entries(extra))
  const at = { x: 0.5, y: feetY, z: 0.5 }
  let dirt = 10
  const calls = []
  const block = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cells.has(key)) return cells.get(key)
    if (x !== 0 || z !== 0) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    if (y > surface || y === feetY || y === feetY + 1) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  }
  const ports = {
    feet: () => ({ ...at }), block, dirt: () => dirt, walk: async () => true, why: () => null,
    canMine: cell => !/gravel|water/.test(block(cell.x, cell.y, cell.z).name),
    mine: async cell => { calls.push(`mine ${cell.y}`); cells.set(`${cell.x},${cell.y},${cell.z}`, { known: true, name: 'minecraft:air', boundingBox: 'empty' }); return true },
    pillar: async (column, y) => { calls.push(`pillar ${y}`); cells.set(`0,${y},0`, { known: true, name: 'minecraft:dirt', boundingBox: 'block' }); cells.set(`0,${y + 1},0`, { known: true, name: 'minecraft:air', boundingBox: 'empty' }); cells.set(`0,${y + 2},0`, { known: true, name: 'minecraft:air', boundingBox: 'empty' }); at.y = y + 1; dirt--; return { ok: true } }
  }
  return { ports, calls, at, dirt: () => dirt }
}

test('mines the blocks above the head and pillars up until the feet are level with the ground', async () => {
  const sim = world({ feetY: 62, surface: 66 })
  const result = await climbOut({ ports: sim.ports, sleep: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(sim.at.y, 67) // on top of the dirt at y 66, level with the ground around
  assert.equal(result.steps, 5)
  assert.equal(sim.dirt(), 5)
  assert.deepEqual(sim.calls.slice(0, 4), ['mine 64', 'mine 65', 'pillar 62', 'mine 66'])
})

test('stops below gravel, leaves and unreceived terrain, and without dirt', async () => {
  const gravel = world({ feetY: 62, surface: 66, extra: { '0,65,0': { known: true, name: 'minecraft:gravel', boundingBox: 'block' } } })
  assert.equal((await climbOut({ ports: gravel.ports, sleep: async () => {} })).reason, 'CANNOT_MINE')
  assert.equal(gravel.at.y, 62)
  const unknown = world({ feetY: 62, surface: 66, extra: { '0,65,0': { known: false } } })
  assert.equal((await climbOut({ ports: unknown.ports, sleep: async () => {} })).ok, false)
  const leaves = world({ feetY: 62, surface: 63, extra: { '0,65,0': { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' }, '0,64,0': { known: true, name: 'minecraft:stone', boundingBox: 'block' } } })
  const out = await climbOut({ ports: leaves.ports, sleep: async () => {} })
  assert.equal(out.reason, 'LEAVES_ABOVE')
  assert.ok(!leaves.calls.some(call => call === 'mine 65'))
  const poor = world({ feetY: 62, surface: 66 })
  poor.ports.dirt = () => 0
  assert.equal((await climbOut({ ports: poor.ports, sleep: async () => {} })).reason, 'NO_DIRT')
})

test('does nothing under the open sky', async () => {
  const sim = world({ feetY: 70, surface: 69 })
  const result = await climbOut({ ports: sim.ports, sleep: async () => {} })
  assert.equal(result.reason, 'NOT_UNDER_COVER')
  assert.deepEqual(sim.calls, [])
})

test('takes the pickaxe into the hand when the preview refuses with another item held', async () => {
  const sim = world({ feetY: 62, surface: 64 })
  let held = 'sword', picked = 0
  const can = sim.ports.canMine, pillar = sim.ports.pillar
  sim.ports.canMine = cell => held === 'pickaxe' && can(cell)
  sim.ports.pick = async () => { picked++; held = 'pickaxe'; return true }
  sim.ports.pillar = async (...args) => { held = 'dirt'; return pillar(...args) } // the step leaves dirt in the hand
  const result = await climbOut({ ports: sim.ports, sleep: async () => {} })
  assert.equal(result.ok, true)
  assert.equal(sim.at.y, 65)
  assert.equal(picked, 1) // only the first round has blocks to mine: 64 and nothing above
})
