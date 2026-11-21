'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineSupplies } = require('../src/modes/mining/mine-supplies')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { createHousePorts } = require('../src/modes/house/house-ports')
const { createInteractions } = require('../src/actions/interactions')
const { openAccess } = require('../src/actions/open-face')

function fixture ({ enclosed = false, failWalk = false, cancelWalk = false, raisedFloor = false } = {}) {
  const plan = createMineGeometry({ scope: { profile: 'p', realmId: 'r', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const stock = { stick: 8, oak_log: 8, oak_planks: 8, furnace: 1, torch: 0, ladder: 128, cobblestone: 128, cobblestone_slab: 128, chest: 6 }
  const inventory = { known: true, items: Object.entries(stock).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot })) }
  const block = name => ({ known: true, name: 'minecraft:' + name, extra: [], boundingBox: name === 'air' ? 'empty' : 'block' })
  const furnace = { x: -2, y: 64, z: 0 }, blocks = new Map(), key = p => `${p.x},${p.y},${p.z}`
  blocks.set(key(furnace), block('furnace'))
  blocks.set('-1,64,0', block('stone')); blocks.set('-1,65,0', block('stone'))
  if (enclosed) for (const [x, y, z] of [[-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) blocks.set(key({ x: furnace.x + x, y: furnace.y + y, z: furnace.z + z }), block('stone'))
  const getBlock = (x, y, z) => blocks.get(`${x},${y},${z}`) ??
    block(y < 64 || raisedFloor && y === 64 && (x !== 0 || z !== 0) ? 'stone' : 'air')
  let feet = { x: 0.5, y: 64, z: 0.5 }, cancelled = false, why = null, clock = 0
  const walks = [], placements = [], smelts = []
  const ctx = { getFeet: () => feet, cancelled: () => cancelled, memory: { early: { mine: { branch: { plan } } } }, supplies: { acquire: async () => { throw new Error('fixture already carries the station and charcoal ingredients') } } }
  const done = code => ({ status: 'completed', serverConfirmed: true, code })
  const actions = { inventory: () => inventory, block: p => getBlock(p.x, p.y, p.z), done,
    walk: async to => {
      walks.push(to)
      if (cancelWalk) cancelled = true
      if (failWalk) return { status: 'blocked', code: 'NO_ROUTE' }
      feet = { ...to }
      return done('POSITION_RECEIVED')
    },
    place: async request => {
      placements.push(request)
      blocks.set(key(request.position), block(request.name))
      inventory.items.find(row => row.name === 'minecraft:furnace').count--
      return done('PLACEMENT_RECEIVED')
    },
    house: { smelt: async position => {
      smelts.push(position)
      const failure = openAccess(p => getBlock(p.x, p.y, p.z), { ...feet, y: feet.y + 1.62 }, position)
      why = failure?.message ?? null
      return failure ? 0 : 1
    }, smeltNeed: () => null, why: () => why }
  }
  // The pre-change failure is also checked at the actual low-level click:
  // being a received furnace is not proof that it can be opened from here.
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', runtimeEntityId: '1', health: 20, selectedSlot: 0, inventory, position: { ...feet, y: feet.y + 1.62 } }
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true }), rawItem: () => ({ network_id: 0, count: 0 }), applyPacket () {}, closeContainer () {} }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world: { getBlock }, crafting, getInput: () => ({}) })
  const actualHouse = createHousePorts({ operations: { interactions, crafting, furnace: { snapshot: () => ({ contentsKnown: false }) } }, getBlock, getInventory: () => inventory, now: () => clock, sleep: async ms => { clock += ms } })
  return { plan, furnace, walks, placements, smelts, actualHouse, supplies: createMineSupplies(ctx, actions, {}) }
}

test('an enclosed existing furnace is refused at the actual click and does not hide a held surface furnace', async () => {
  const f = fixture({ enclosed: true })
  assert.equal(await f.actualHouse.smelt(f.furnace, 'minecraft:oak_log', 1, 'minecraft:oak_planks', 1, 'minecraft:charcoal'), 0)
  assert.match(f.actualHouse.why(), /視線/)
  const out = await f.supplies.ensure(f.plan)
  assert.equal(out.code, 'MINE_CHARCOAL_RECEIVED')
  assert.equal(f.placements.length, 1)
  assert.equal(f.walks.length, 0, 'sealed faces do not cause blind walking')
  assert.notDeepEqual(f.smelts[0], f.furnace)
  const placed = f.placements[0].position
  assert.ok(!f.plan.shaft.columns.some(p => p.x === placed.x && p.z === placed.z))
  assert.ok(!(Math.floor(f.plan.shaft.approach.x) === placed.x && Math.floor(f.plan.shaft.approach.z) === placed.z))
})

test('a received stand around the wall allows the existing furnace to be reused', async () => {
  const f = fixture()
  const out = await f.supplies.ensure(f.plan)
  assert.equal(out.code, 'MINE_CHARCOAL_RECEIVED')
  assert.ok(f.walks.length > 0 && f.walks.length <= 4)
  assert.equal(f.placements.length, 0)
  assert.deepEqual(f.smelts, [f.furnace])
})

test('a held station can be placed on a visible ledge above the current feet', async () => {
  const f = fixture({ enclosed: true, raisedFloor: true })
  const out = await f.supplies.ensure(f.plan)
  assert.equal(out.code, 'MINE_CHARCOAL_RECEIVED')
  assert.equal(f.placements.length, 1)
  assert.equal(f.placements[0].position.y, 65)
  assert.equal(f.placements[0].clicked.y, 64)
})

test('unreachable stands exhaust a finite budget then use the held station', async () => {
  const f = fixture({ failWalk: true })
  assert.equal((await f.supplies.ensure(f.plan)).code, 'MINE_CHARCOAL_RECEIVED')
  assert.ok(f.walks.length > 0 && f.walks.length <= 4)
  assert.equal(f.placements.length, 1)
  assert.notDeepEqual(f.smelts[0], f.furnace)
})

test('cancellation after the station approach cannot place or open a station', async () => {
  const f = fixture({ cancelWalk: true })
  assert.equal((await f.supplies.ensure(f.plan)).status, 'interrupted')
  assert.equal(f.walks.length, 1)
  assert.equal(f.placements.length, 0)
  assert.equal(f.smelts.length, 0)
})
