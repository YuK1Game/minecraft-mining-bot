'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim } = require('./helpers/player-return-sim')
const { createHousePorts } = require('../src/modes/house/house-ports')
const { createHouseBuild } = require('../src/modes/house/house-build')
const { placements } = require('../src/modes/house/house-blueprint')
const { verifyHouseChests } = require('../src/modes/house/house-large-chests')

for (const size of [27, 54]) test(`house inspection requires a received 54-slot server window (${size} received)`, async () => {
  const sim = createReturnSim({ feet: { x: 3.5, y: 65, z: 4.5 }, items: [[0, 'wooden_pickaxe', 1]] })
  const origin = { x: 0, y: 64, z: 0 }
  sim.buildHouse(origin)
  const apply = sim.chest.applyPacket
  sim.chest.applyPacket = (name, packet) => apply(name, name === 'inventory_content' && typeof packet.window_id === 'number' ? { ...packet, input: packet.input.slice(0, size) } : packet)
  const ports = createHousePorts({ operations: sim.operations, getBlock: sim.getBlock, getInventory: sim.inventory, now: sim.now, sleep: sim.sleep })
  const confirmed = await verifyHouseChests({ origin, getBlock: sim.getBlock, getFeet: sim.getFeet, ports, hands: sim.mount().hands, aborted: () => false })
  assert.equal(confirmed.length, size === 54 ? 2 : 0)
  assert.ok(sim.events.filter(event => event.kind === 'open').length >= 2)
})

function building ({ missing = [], chests = 0, planks = 0, slots = 54, chestWork } = {}) {
  const origin = { x: 0, y: 64, z: 0 }, feet = { x: 3.5, y: 65, z: 5.5 }
  const world = new Map(), key = at => `${at.x},${at.y},${at.z}`
  const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const steps = placements(origin), todo = new Set(['p_172', ...missing])
  for (const step of steps) if (!todo.has(step.id)) for (const at of step.cells) world.set(key(at), { known: true, name: `minecraft:${step.item}`, boundingBox: 'block' })
  const getBlock = (x, y, z) => world.get(`${x},${y},${z}`) ?? (y < 64 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : air)
  const items = [['wooden_pickaxe', 1], ['wooden_door', 1], ['chest', chests], ['oak_planks', planks]].filter(([, n]) => n > 0).map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot }))
  const shared = { playerWanted: true, playerHouse: { origin, done: false } }, placed = [], done = []
  let clock = 1000, windowSize = slots
  const ports = {
    craft: async () => false, why: () => null, reset () {}, mine: async () => false,
    inspectChest: async () => ({ status: 'completed', evidence: { slotCount: windowSize } }),
    place: async (name, plan) => {
      const step = steps.find(step => key(step.position) === key(plan.position))
      const stack = items.find(item => item.name === name && item.count > 0)
      assert.ok(stack); stack.count--; placed.push(step.id)
      for (const at of step.cells) world.set(key(at), { known: true, name, boundingBox: 'block' })
      return true
    }
  }
  const build = createHouseBuild({
    getMode: () => 'player', shared, ports, chestWork, hands: { walk: async stand => { Object.assign(feet, stand); return true }, approach: async () => true },
    getBlock, getFeet: () => ({ ...feet }), getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getInventory: () => ({ known: true, items }),
    agent: { objective: {}, stop () {}, start: async () => {}, settled: () => true }, climb: async () => ({ ok: true }),
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    now: () => clock, sleep: async ms => { clock += ms }, onDone: async (at, evidence) => done.push(evidence)
  })
  return { build, shared, placed, done, ports, items, getBlock, receiveBlock: id => { const step = steps.find(step => step.id === id); for (const at of step.cells) world.set(key(at), { known: true, name: `minecraft:${step.item}`, boundingBox: 'block' }) }, receive: size => { windowSize = size; clock += 600001 } }
}

test('house completion and base handoff wait for both large windows, then resume without rebuilding boxes', async () => {
  const f = building({ slots: 27 })
  await f.build.tick()
  assert.equal(f.shared.playerHouse.done, false)
  assert.deepEqual(f.placed, [])
  assert.deepEqual(f.done[0].largeChests, [])
  f.receive(54)
  await f.build.tick()
  assert.equal(f.shared.playerHouse.done, true)
  assert.deepEqual(f.placed, ['p_172'])
  assert.equal(f.done.at(-1).largeChests.length, 2)
})

test('house holds both chest items before placing the first half when crafting is refused', async () => {
  const f = building({ missing: ['p_174', 'p_175'], chests: 1, planks: 8 })
  await f.build.tick()
  assert.equal(f.shared.playerHouse.done, false)
  assert.deepEqual(f.placed.filter(id => ['p_174', 'p_175'].includes(id)), [])
})

test('house resumes an existing half with just the missing chest', async () => {
  const f = building({ missing: ['p_175'], chests: 1 })
  await f.build.tick()
  assert.equal(f.shared.playerHouse.done, true)
  assert.deepEqual(f.placed.filter(id => ['p_174', 'p_175'].includes(id)), ['p_175'])
})

test('house does not place a chest before its unfinished-pair reservation is saved', async () => {
  const f = building({ missing: ['p_174', 'p_175'], chests: 2, chestWork: { begin: async () => false, complete: async () => true } })
  await f.build.tick()
  assert.deepEqual(f.placed, [])
  assert.equal(f.shared.playerHouse.done, false)
})

test('house does not hand off a large chest until completion is saved', async () => {
  const f = building({ chestWork: { begin: async () => true, complete: async () => false } })
  await f.build.tick()
  assert.equal(f.shared.playerHouse.done, false)
  assert.deepEqual(f.done[0].largeChests, [])
})

test('house does not repeat an unconfirmed chest placement between passes or runs and resumes after its delayed block', async () => {
  const { createChestPairs } = require('../src/modes/player-chest-pairs')
  let f
  const chestWork = createChestPairs({ shared: {}, worldScope: () => 'world', getBlock: (...args) => f.getBlock(...args) })
  f = building({ missing: ['p_174', 'p_175'], chests: 3, chestWork })
  const place = f.ports.place, requests = []
  f.ports.placementRetrySafe = () => false
  f.ports.place = async (name, plan) => {
    if (name !== 'minecraft:chest') return place(name, plan)
    requests.push({ ...plan.position })
    if (requests.length !== 1) return place(name, plan)
    f.items.find(item => item.name === name).count--
    return false
  }
  await f.build.tick()
  assert.equal(requests.length, 1)
  f.receive(54)
  await f.build.tick()
  assert.equal(requests.length, 1)
  f.receiveBlock('p_174')
  f.receive(54)
  await f.build.tick()
  assert.equal(requests.length, 2)
  assert.notDeepEqual(requests[0], requests[1])
  assert.equal(f.shared.playerHouse.done, true)
})
