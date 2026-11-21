'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createMineStorage } = require('../src/modes/mining/mine-storage')

function fixture (t, slots = 54) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-storage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plan = createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const inventory = { known: true, items: [{ slot: 0, name: 'minecraft:diamond', count: 10 }] }, chests = plan.storage[0].pairs.flatMap(p => p.positions)
  let view = {}, transfers = 0, epoch = 0
  const getBlock = (x, y, z) => ({ known: true, name: chests.some(p => p.x === x && p.y === y && p.z === z) ? 'minecraft:chest' : y < 16 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 16 ? 'block' : 'empty', properties: {} })
  const ctx = { root, shared: {}, runtime: { raw: () => ({ profile: 'p', realm: { id: 'r' }, dimension: 'overworld' }) }, cancelled: () => false,
    memory: { early: { mine: { branch: { plan } } } }, getBlock, getFeet: () => ({ x: 1.5, y: 16, z: 1.5 }),
    operations: { interactions: {}, crafting: { closeContainer: () => { view = {} } }, chest: {
      snapshot: () => view,
      open: async position => { view = { window: { id: 1, epoch: ++epoch, scope: 'fixture', position, slotCount: slots }, contentsKnown: true, slots: Array.from({ length: slots }, (_, slot) => ({ known: true, slot, count: 0, name: null })) }; return { windowId: 1 } },
      depositItem: async ({ sourceSlot, count }) => { const item = inventory.items.find(i => i.slot === sourceSlot); item.count -= count; transfers += count; return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count } }
    } }
  }
  const done = (code, evidence) => ({ status: 'completed', code, serverConfirmed: true, evidence })
  const actions = { inventory: () => inventory, block: p => getBlock(p.x, p.y, p.z), walk: async () => done('AT'), done, save: async () => true }
  return { plan, inventory, storage: createMineStorage(ctx, actions), transfers: () => transfers }
}

test('mine storage traverses real container ports and retains the requested diamond quantity', async t => {
  const f = fixture(t)
  const result = await f.storage.deposit(f.plan, { layer: 'upper', keep: { diamond: 3 } })
  assert.equal(result.code, 'MINE_CARGO_STORED')
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.inventory.items[0].count, 3)
  assert.equal(f.transfers(), 7)
})

test('adjacent chests with a received 27-slot window are never used as a planned double chest', async t => {
  const f = fixture(t, 27)
  const result = await f.storage.deposit(f.plan, { layer: 'upper', keep: { diamond: 3 } })
  assert.equal(result.code, 'MINE_CHEST_NOT_DOUBLE')
  assert.equal(f.transfers(), 0)
  assert.equal(f.inventory.items[0].count, 10)
})
