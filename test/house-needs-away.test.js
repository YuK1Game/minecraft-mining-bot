'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { needsNow } = require('../src/modes/house/house-supply')
const { placements } = require('../src/modes/house/house-blueprint')

const inv = { known: true, items: [{ name: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] }

test('away from the house, the counts last read with the house received are used', () => {
  const origin = { x: 0, y: 64, z: 0 }
  // Every step placed except the last one.
  const steps = placements(origin), last = steps[steps.length - 1]
  const placed = new Map()
  for (const step of steps.slice(0, -1)) for (const cell of step.cells) placed.set(`${cell.x},${cell.y},${cell.z}`, step.item)
  const near = (x, y, z) => {
    const item = placed.get(`${x},${y},${z}`)
    return item ? { known: true, name: `minecraft:${item}`, boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
  const shared = { playerHouse: { origin } }
  const here = needsNow({ shared, state: { inventory: inv }, getBlock: near })
  assert.ok(here.total.cobblestone <= 9, `near: ${JSON.stringify(here.total)}`)
  const away = needsNow({ shared, state: { inventory: inv }, getBlock: () => ({ known: false }) })
  assert.deepEqual(away.total, here.total)
  assert.ok(last)
})
