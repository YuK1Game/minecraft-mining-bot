'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { plantSaplings, survey } = require('../src/modes/dragon-saplings')

// Flat grass at y 64 around a house at (0, 65, 0); everything above is air.
function flat (extra = {}) {
  return (x, y, z) => {
    const own = extra[`${x},${y},${z}`]
    if (own) return { known: true, name: own }
    return { known: true, name: y <= 64 ? 'minecraft:grass_block' : 'minecraft:air' }
  }
}

test('the survey finds open grass away from the house and counts standing saplings', () => {
  const origin = { x: 0, y: 65, z: 0 }
  const { spots, saplings } = survey(flat({ '13,65,3': 'minecraft:oak_sapling' }), origin)
  assert.equal(saplings.length, 1)
  assert.ok(spots.length > 0)
  assert.ok(spots.every(at => Math.hypot(at.x - 3, at.z - 3) >= 8), 'not next to the house')
  assert.ok(!spots.some(at => Math.abs(at.x - 13) <= 2 && Math.abs(at.z - 3) <= 2), 'two cells from a sapling')
})

test('a held sapling is planted on received grass in reach and counted by the received sapling block', async () => {
  const placed = {}
  const getBlock = (x, y, z) => placed[`${x},${y},${z}`] ? { known: true, name: placed[`${x},${y},${z}`] } : flat()(x, y, z)
  const used = []
  const ctx = {
    shared: { playerHouse: { origin: { x: 0, y: 65, z: 0 } } },
    getFeet: () => ({ x: 14.5, y: 65, z: 3.5 }),
    getBlock,
    cancelled: () => false,
    sleep: async () => {},
    log: () => {},
    hands: { approach: async () => true },
    runtime: { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: [{ slot: 2, name: 'minecraft:oak_sapling', count: 3 }] }) },
    operations: {
      inventory: { equip: async slot => ({ phase: 'already_selected', slot }) },
      interactions: { useDragonItem: async ({ item, position, slot }) => { used.push({ item, position, slot }); placed[`${position.x},${position.y + 1},${position.z}`] = item } }
    }
  }
  const out = await plantSaplings(ctx, { now: () => 1000 })
  assert.equal(out.phase, 'working')
  assert.equal(used.length, 1)
  assert.equal(used[0].item, 'minecraft:oak_sapling')
  assert.equal(ctx.shared.playerSaplings.planted, 1)
})

test('nothing to plant away from the house or with no saplings or bones', async () => {
  const base = { shared: { playerHouse: { origin: { x: 0, y: 65, z: 0 } } }, getBlock: flat(), cancelled: () => false, runtime: { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: [] }) } }
  assert.equal(await plantSaplings({ ...base, getFeet: () => ({ x: 10, y: 65, z: 3 }) }, { now: () => 1 }), null)
  assert.equal(await plantSaplings({ ...base, shared: { playerHouse: { origin: { x: 0, y: 65, z: 0 } } }, getFeet: () => ({ x: 200, y: 65, z: 3 }), runtime: { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:oak_sapling', count: 1 }] }) } }, { now: () => 1 }), null)
})
