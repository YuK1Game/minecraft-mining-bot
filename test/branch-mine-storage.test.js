'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createMineStorage } = require('../src/modes/mining/mine-storage')

function fixture (t, slots = 54, homeStock = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-storage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plan = createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const inventory = { known: true, items: [{ slot: 0, name: 'minecraft:diamond', count: 10 }] }, chests = plan.storage[0].pairs.flatMap(p => p.positions)
  const home = { x: 2, y: 16, z: 1 }
  const homeSlots = [
    { known: true, slot: 0, name: 'minecraft:ladder', count: 24 },
    { known: true, slot: 1, name: 'minecraft:emerald', count: 8 }
  ]
  if (homeStock) chests.push(home)
  let opens = 0
  let view = {}, transfers = 0, epoch = 0
  const getBlock = (x, y, z) => ({ known: true, name: chests.some(p => p.x === x && p.y === y && p.z === z) ? 'minecraft:chest' : y < 16 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 16 ? 'block' : 'empty', properties: {} })
  const shared = homeStock ? { playerHouse: { origin: { x: 0, y: 16, z: 0 } }, playerBase: home,
    playerChestMemory: { seen: new Map([['2,16,1', [{ known: true, slot: 0, name: 'minecraft:ladder', count: 76 }]]]) } } : {}
  const ctx = { root, shared, hands: { walk: async () => true }, runtime: { raw: () => ({ profile: 'p', realm: { id: 'r' }, dimension: 'overworld' }) }, cancelled: () => false,
    memory: { early: { mine: { branch: { plan } } } }, getBlock, getFeet: () => ({ x: 1.5, y: 16, z: 1.5 }),
    operations: { interactions: {}, crafting: { closeContainer: () => { view = {} } }, chest: {
      snapshot: () => view,
      open: async position => { opens++; view = { window: { id: 1, epoch: ++epoch, scope: 'fixture', position, slotCount: slots }, contentsKnown: true, slots: homeStock ? homeSlots : Array.from({ length: slots }, (_, slot) => ({ known: true, slot, count: 0, name: null })) }; return { windowId: 1 } },
      withdrawItem: async ({ chestSlot, expectedName, count }) => {
        const item = homeSlots.find(slot => slot.slot === chestSlot)
        assert.equal(item.name, expectedName)
        assert.ok(item.count >= count)
        item.count -= count
        inventory.items.push({ slot: inventory.items.length, name: expectedName, count })
        transfers += count
        return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count }
      },
      depositItem: async ({ sourceSlot, count }) => { const item = inventory.items.find(i => i.slot === sourceSlot); item.count -= count; transfers += count; return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count } }
    } }
  }
  const done = (code, evidence) => ({ status: 'completed', code, serverConfirmed: true, evidence })
  const actions = { inventory: () => inventory, block: p => getBlock(p.x, p.y, p.z), walk: async () => done('AT'), confirmPosition: async () => done('AT'), done, save: async () => true }
  return { plan, inventory, storage: createMineStorage(ctx, actions), transfers: () => transfers, opens: () => opens }
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

test('home supply recovery uses the fresh chest contents instead of cached amounts', async t => {
  const f = fixture(t, 54, true)
  const recovered = await f.storage.takeHome({ ladder: 50, stick: 56 })
  assert.equal(recovered.code, 'KIT_TAKEN')
  assert.equal(recovered.progress.confirmedTransferred, 24)
  assert.equal(f.inventory.items[1].name, 'minecraft:ladder')
  assert.equal(f.inventory.items[1].count, 24)
  assert.equal(await f.storage.takeHome({ ladder: 50, stick: 56 }), null)
  assert.equal(f.opens(), 1)
})
