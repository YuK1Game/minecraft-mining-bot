'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { climbDown, wayOff } = require('../src/modes/player-climb-down')
const { sidestep } = require('../src/modes/player-climb-side')

const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }, air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }, water = { known: true, name: 'minecraft:water', boundingBox: 'empty' }
const cobble = { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
// The real Realm 2026-11-16 19:04 JST: a cave (air, y 38-45) under a lake bed (stone y 46, water
// y 47-50 over x >= -2), stone below y 38 and west of x -4. The Bot stands at (0, 43, 0) on its
// own cobblestone pillar (0, 38..42, 0).
function cave () {
  const cells = new Map(), at = { x: 0.5, y: 43, z: 0.5 }, calls = []
  const block = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cells.has(key)) return cells.get(key)
    if (y >= 47 && y <= 50 && x >= -2) return water
    if (y > 60) return air
    if (y >= 38 && y <= 45 && x >= -4 && x <= 6 && Math.abs(z) <= 5) return air
    return stone
  }
  for (let y = 38; y <= 42; y++) cells.set(`0,${y},0`, cobble)
  const open = (x, y, z) => block(x, y, z).boundingBox === 'empty'
  const ports = {
    feet: () => ({ ...at }), block, why: () => null, reason: () => null,
    canMine: () => false, pick: async () => false, canDig: cell => !/water/.test(block(cell.x, cell.y + 1, cell.z).name),
    mine: async () => false,
    dig: async cell => { calls.push(`dig ${cell.x},${cell.y},${cell.z}`); cells.set(`${cell.x},${cell.y},${cell.z}`, air); return true },
    descend: async cell => { calls.push(`down ${cell.y}`); if (block(cell.x, cell.y, cell.z) !== cobble) return false; cells.set(`${cell.x},${cell.y},${cell.z}`, air); at.y = cell.y; return true },
    walk: async target => { const x = Math.floor(target.x), z = Math.floor(target.z); calls.push(`walk ${x},${target.y},${z}`); if (!open(x, target.y - 1, z) && open(x, target.y, z) && open(x, target.y + 1, z) && Math.abs(target.y - at.y) <= 1) { at.x = target.x; at.y = target.y; at.z = target.z } return true }
  }
  return { ports, calls, at, block }
}

test('on a pillar in a cave there is no way off until the cave floor', () => {
  const { block } = cave()
  assert.equal(wayOff(block, 0, 43, 0), null)
  assert.equal(wayOff(block, 0, 40, 0), null)
  assert.deepEqual(wayOff(block, 0, 39, 0), { x: 1, y: 38, z: 0 }) // one step down
})

test('takes its own pillar down from under the feet until it can walk off', async () => {
  const sim = cave(), logs = []
  const down = await climbDown({ ports: sim.ports, log: text => logs.push(text) })
  assert.equal(down.ok, true)
  // One step down counts as a way off: four blocks down, the floor one below beside it.
  assert.equal(down.steps, 4)
  assert.equal(sim.at.y, 39)
  assert.match(logs[0], /積んだ柱を下りて/)
})

test('natural rock under the feet is not taken down', async () => {
  const sim = cave()
  sim.at.x = -9.5 // inside the rock west of the cave: a one-wide shaft
  const cells = [[-10, 43], [-10, 44]]
  const block = sim.ports.block
  sim.ports.block = (x, y, z) => cells.some(([cx, cy]) => cx === x && cy === y && z === 0) ? air : block(x, y, z)
  const down = await climbDown({ ports: sim.ports })
  assert.deepEqual([down.ok, down.reason, down.steps], [false, 'NOT_OWN_PILLAR', 0])
  assert.equal(sim.calls.length, 0)
})

test('the drift first goes down the pillar, then reaches a dry column and stands in it', async () => {
  const sim = cave(), logs = []
  const moved = await sidestep({ ports: sim.ports, log: text => logs.push(text) })
  assert.equal(moved.ok, true, logs.join('\n'))
  assert.ok(sim.at.y <= 39)
  assert.ok(Math.floor(sim.at.x) <= -4, 'west of the lake')
  assert.ok(sim.calls.some(call => call.startsWith('down ')))
})
