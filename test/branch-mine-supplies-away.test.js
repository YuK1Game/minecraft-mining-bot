'use strict'

// Away from the mine, its installed ladder and chests are not asked for again.
// Real Realm 2026-11-23 14:29-14:48 JST, plan 4fdd1ba65ef1daceb473 (shaft x 9806-9807, z 10178-10179, surface
// Y64, upper Y32): the shaft was finished at 14:29:24 (33 rungs installed and received, record `shaft.depth 32`,
// `landings.upper true`) and the storage room's four chests needed 32 planks. With 18 planks the Bot left for
// trees and the home; at 14:39:36-14:39:46 (in the home, about 80 m from the shaft) it made "stick 33",
// "stick 57", "ladder 26", and at 14:46:20-14:46:28 (at a tree, about 70 m away) "stick 17 … 29", "ladder 38".
// The planks went 18/32 -> 6/14 -> 14/14 -> 4/32 and reached 32 only at 14:48:04. At 14:48:48, 50 m from the
// shaft, GET /blocks around (9806,48,10178) and (9806,62,10178) returned all 54 cells `known:false`.
// Real: createMineGeometry, supplyNeeds/builtWork (mine-needs.js), createMineSupplies.ensure (the caller that
// crafted the ladders), constructionSupplies. The inventory, the crafting and the gathering are
// stand-ins that record what is asked.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createMineSupplies } = require('../src/modes/mining/mine-supplies')
const { supplyNeeds, constructionSupplies, builtWork } = require('../src/modes/mining/mine-needs')

const plan = () => createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 9808, z: 10178 }, direction: 'east', width: 24, length: 32, surfaceY: 64, upperY: 32 })
const inventory = stock => ({ known: true, items: Object.entries(stock).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot })) })
const UNRECEIVED = () => ({ known: false })
const sameColumn = (a, b) => a.x === b.x && a.z === b.z

// The Bot stands on grass 70 m east of the mine: the ground around it is received, the mine is not.
function away (stock, branch) {
  const inv = inventory(stock), calls = [], feet = { x: 9878.5, y: 64, z: 10178.5 }
  const block = p => Math.abs(p.x - 9878) > 8 ? { known: false }
    : p.y < 64 ? { known: true, name: 'minecraft:grass_block', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const ctx = { getFeet: () => feet, cancelled: () => false, memory: { early: { mine: { branch } } }, supplies: { acquire: async (name, count) => { calls.push(['acquire', name, count]) } } }
  const actions = { inventory: () => inv, block, done: (code, extra) => ({ status: 'completed', serverConfirmed: true, code, ...extra }), save: async () => true,
    walk: async () => ({ status: 'blocked' }), place: async () => ({ status: 'blocked', code: 'NOT_PLACED' }),
    house: { craft: async (name, times) => { calls.push(['craft', name, times]) }, why: () => null } }
  return { calls, ctx, block, supplies: createMineSupplies(ctx, actions, {}) }
}

test('the finished shaft of 14:29 JST is not asked for again from the home or from a tree', async () => {
  const p = plan(), stock = { torch: 32, cobblestone_slab: 64, cobblestone: 64, oak_planks: 18 }
  assert.equal(p.shaft.topY, 64); assert.equal(p.layers[0].y, 32)
  const branch = { plan: p, shaft: { depth: 32, entry: true, landings: { upper: true } } }
  // Without the record every rung is missing: the reading that crafted 26 and then 12 more ladders.
  assert.equal(supplyNeeds(p, 'upper', { inventory: inventory(stock), getBlock: UNRECEIVED }).ladder, 34)
  const f = away(stock, branch)
  const out = await f.supplies.ensure(p, { layer: 'upper' })
  assert.deepEqual(f.calls, [['acquire', 'planks', 32]], 'the planks are for the four chests of the storage room')
  assert.equal(out.detail, 'planks 18/32')
  const ready = away({ ...stock, oak_planks: 0, chest: 4 }, branch)
  assert.equal((await ready.supplies.ensure(p, { layer: 'upper' })).code, 'MINE_SUPPLIES_READY')
  assert.deepEqual(ready.calls, [])
  const carried = constructionSupplies(p, 'upper', { inventory: inventory(stock), getBlock: f.block, built: builtWork(branch) })
  assert.deepEqual([carried.ladder, carried.stick], [0, 0], 'no ladder and no ladder sticks are budgeted for a finished shaft')
})

test('a cell that is not received is read from the saved record, a received cell as it is', () => {
  const p = plan(), inv = inventory({}), top = p.shaft.topY
  const needs = (getBlock, branch) => supplyNeeds(p, 'upper', { inventory: inv, getBlock, built: builtWork(branch) })
  assert.equal(needs(UNRECEIVED, { shaft: { depth: 32 } }).ladder, 0)
  assert.equal(needs(UNRECEIVED, { shaft: { depth: 48 } }).ladder, 17, 'a shaft under way still needs the rungs below its saved depth and one spare')
  assert.equal(needs(UNRECEIVED, { shaft: { depth: top } }).ladder, 34, 'a shaft at its top has no confirmed rung')
  assert.equal(needs(UNRECEIVED, {}).ladder, 34)
  assert.equal(needs(UNRECEIVED, null).ladder, 34)
  // Back at the mine: a rung that was broken since is received as air and is needed again.
  const broken = q => sameColumn(q, p.shaft.ladder) && q.y >= 32 && q.y <= top && q.y !== 40 ? { known: true, name: 'minecraft:ladder' } : { known: true, name: 'minecraft:air' }
  assert.equal(needs(broken, { shaft: { depth: 32 } }).ladder, 2)
  // Half received (the upper subchunks only): the lower rungs come from the record.
  const upperOnly = q => q.y < 48 ? { known: false } : sameColumn(q, p.shaft.ladder) ? { known: true, name: 'minecraft:ladder' } : { known: true, name: 'minecraft:air' }
  assert.equal(needs(upperOnly, { shaft: { depth: 32 } }).ladder, 0)
  assert.equal(needs(upperOnly, { shaft: { depth: 40 } }).ladder, 9)
})

test('a chest pair whose 54 slots were received is not asked for again; an unregistered pair is', () => {
  const p = plan(), inv = inventory({}), [cargo, supply] = p.storage[0].pairs
  const needs = (getBlock, branch) => supplyNeeds(p, 'upper', { inventory: inv, getBlock, built: builtWork(branch) }).chest
  assert.equal(needs(UNRECEIVED, { storage: { pairs: {} } }), 4)
  assert.equal(needs(UNRECEIVED, { storage: { pairs: { [cargo.id]: { positions: cargo.positions, slots: 54 } } } }), 2)
  assert.equal(needs(UNRECEIVED, { storage: { pairs: { [cargo.id]: { slots: 54 }, [supply.id]: { slots: 54 } } } }), 0)
  // A received cell wins over the record: a registered chest that is received as air is needed again.
  const gone = q => cargo.positions.some(c => c.x === q.x && c.y === q.y && c.z === q.z) ? { known: true, name: 'minecraft:air' } : { known: false }
  assert.equal(needs(gone, { storage: { pairs: { [cargo.id]: { slots: 54 }, [supply.id]: { slots: 54 } } } }), 2)
})
