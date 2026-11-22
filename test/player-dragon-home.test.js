'use strict'
// The expedition's way back into the home (src/modes/dragon-early-home.js).
// Live 2026-11-18 20:42-20:52 JST: the trip home "arrived" 11 m from the house on
// the map, on the overhang west of it at y 89 (the house floor is at y 76). The
// home step then tried the door and a walk every two seconds, silently, for ten
// minutes; nothing led down.
const test = require('node:test')
const assert = require('node:assert/strict')
const { approachHome } = require('../src/modes/dragon-early-home')
const { chestOf } = require('../src/modes/house/house-spawn')
const { createOverhangWorld, PILLAR, HOUSE } = require('./helpers/overhang-world')

const origin = { x: HOUSE.x, y: HOUSE.y, z: HOUSE.z }
const inHouse = cell => cell.x >= HOUSE.x && cell.x <= HOUSE.x + 6 && cell.z >= HOUSE.z && cell.z <= HOUSE.z + 6 && cell.y >= HOUSE.y

// The layer round the Bot as received at 20:55 JST (GET /blocks, every cell received): [top y, thickness],
// 'L' leaves at y 92 only, null nothing at y 84..92. Columns x -4910..-4902 per row z.
// Since the height map of 12:45 the floor between the Bot and its pillar is gone.
const L = 'L'
const READ = {
  [-4996]: [[89, 3], [89, 2], [89, 6], [86, 2, 'stone'], L, 'pillar', [88, 1], null, null],
  [-4995]: [[89, 8], [89, 6], [89, 5], L, L, L, null, null, null],
  [-4994]: [[89, 6], [89, 5], L, L, [88, 1], L, L, null, null],
  [-4993]: [[88, 3], [88, 3], [88, 3], L, L, L, null, null, null],
  [-4992]: [[88, 3], [87, 1], [88, 2], [88, 1], L, null, null, null, null],
  [-4991]: [[88, 1], [88, 1], [88, 1], [88, 1], null, null, null, null, null],
  [-4990]: [null, [88, 1], [88, 1], null, null, null, null, null, null],
  [-4989]: Array(9).fill(null),
  [-4988]: Array(9).fill(null)
}
function asRead (world) {
  for (const [row, columns] of Object.entries(READ)) {
    columns.forEach((column, index) => {
      const x = -4910 + index, z = Number(row)
      if (column === 'pillar') return
      for (let y = 78; y <= 93; y++) world.setBlock(x, y, z, 'air')
      if (column === L) world.setBlock(x, 92, z, 'oak_leaves')
      else if (column) for (let y = column[0]; y > column[0] - column[1]; y--) world.setBlock(x, y, z, column[2] ?? (y === column[0] ? 'grass_block' : 'dirt'))
    })
  }
  return world
}

// The ordinary hands over the block world: a short walk, the mining, the pillar descent.
function bot (world, feet, { walkable = true, fill = 0 } = {}) {
  const body = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, did = [], trips = [], logs = [], placed = []
  const open = (x, y, z) => world.getBlock(x, y, z).boundingBox !== 'block'
  const firm = (x, y, z) => world.getBlock(x, y, z).boundingBox === 'block'
  const stand = (x, y, z) => firm(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)
  const hands = {
    feet: () => ({ ...body }), block: world.getBlock, fill: () => fill, why: () => null, reason: () => 'refused by the mining check',
    async walk (to) {
      const x = Math.floor(to.x), z = Math.floor(to.z), cx = Math.floor(body.x), cz = Math.floor(body.z)
      if (!walkable || !stand(x, to.y, z) || Math.abs(x - cx) + Math.abs(z - cz) > 4 || Math.abs(to.y - body.y) > Math.abs(x - cx) + Math.abs(z - cz)) return false
      Object.assign(body, { x: to.x, y: to.y, z: to.z }); did.push('walk')
      return true
    },
    canMine: cell => firm(cell.x, cell.y, cell.z),
    async mine (cell) { world.setBlock(cell.x, cell.y, cell.z, 'air'); did.push('mine'); return true },
    async descend (cell) {
      if (cell.x !== Math.floor(body.x) || cell.z !== Math.floor(body.z) || cell.y !== body.y - 1 || !firm(cell.x, cell.y - 1, cell.z)) return false
      world.setBlock(cell.x, cell.y, cell.z, 'air'); body.y -= 1; did.push('descend')
      return true
    },
    async pillar (column, feetY) {
      if (fill < 1 || !open(column.x, feetY + 2, column.z)) return { ok: false, reason: 'BLOCKED' }
      fill--; world.setBlock(column.x, feetY, column.z, 'cobblestone'); body.y = feetY + 1; did.push('pillar')
      return { ok: true }
    },
    // A floor block into the gap beside the feet, from the blocks carried.
    async bridge (cell) {
      if (fill < 1 || !open(cell.x, cell.y, cell.z)) return false
      fill--; world.setBlock(cell.x, cell.y, cell.z, 'cobblestone'); did.push('bridge'); placed.push(cell)
      return true
    },
    // The last walk to the chest: only from near its own level (the door and the floor are not in this world).
    async approach (target) {
      did.push('approach')
      if (Math.abs(body.y - target.y) > 3 || Math.hypot(target.x + 0.5 - body.x, target.z + 0.5 - body.z) > 12) return false
      Object.assign(body, { x: target.x + 0.5, y: target.y, z: target.z + 2.5 })
      return true
    }
  }
  let clock = 0
  const ctx = { shared: { playerHouse: { origin, done: true } }, hands, getBlock: world.getBlock, getFeet: () => ({ ...body }), where: () => ({ x: body.x, y: body.y + 1.62, z: body.z }),
    cancelled: () => false, log: line => logs.push(line), now: () => clock,
    operations: { quarry: { travelStatus: () => ({ busy: false }) }, interactions: { useDoor: async () => {} } },
    travelTo: async input => { trips.push(input.destination) } }
  return { ctx, body, did, trips, logs, placed, tick: ms => { clock += ms } }
}

test('the real overhang: from where the trip "arrived", down by the way that digs, and in to the chest', async () => {
  const world = createOverhangWorld()
  const f = bot(world, { x: -4907, y: 89, z: -4992 })
  const chest = chestOf(origin)
  assert.equal(await approachHome(f.ctx, chest), true, f.logs.join('\n'))
  assert.deepEqual(f.trips, [], 'no trip is started again from inside its arrival distance')
  assert.ok(f.did.filter(step => step === 'descend').length >= 10, 'down through the blocks it stands on')
  assert.ok(Math.abs(f.body.y - chest.y) <= 3)
  assert.ok([...world.changed.keys()].every(k => { const [x, y, z] = k.split(',').map(Number); return !inHouse({ x, y, z }) }), 'no house block was changed')
  assert.ok(f.logs.some(line => /掘る・積む道で着きました/.test(line)), f.logs.join('\n'))
})

test('the overhang as received at 20:55 JST: round by the row north of the read, down its own pillar, and in', async () => {
  // The row z -4997 was not read at 20:55; it is as the height map of 12:45 has it (a floor at y 88-89).
  const f = bot(asRead(createOverhangWorld()), { x: -4907, y: 89, z: -4992 })
  const chest = chestOf(origin)
  assert.equal(await approachHome(f.ctx, chest), true, f.logs.join('\n'))
  assert.deepEqual([f.trips.length, f.placed.length], [0, 0])
  assert.ok(f.did.filter(step => step === 'descend').length >= 18, 'down the pillar it stacked')
  assert.ok(Math.abs(f.body.y - chest.y) <= 3)
})

test('a gap all round and blocks carried: floor blocks over the gap to the pillar; with nothing to place, the reason', async () => {
  // The layer cut off on every side but the gap to the pillar (the row north of the read and the hillside west of it gone).
  const island = () => {
    const world = asRead(createOverhangWorld())
    for (let x = -4925; x <= -4902; x++) for (let z = -5010; z <= -4985; z++) {
      if (x >= -4910 && z >= -4996 && z <= -4990) continue
      if (x === PILLAR.x && z === PILLAR.z) continue
      for (let y = 75; y <= 93; y++) world.setBlock(x, y, z, 'air')
    }
    return world
  }
  const chest = chestOf(origin)
  const empty = bot(island(), { x: -4907, y: 89, z: -4992 })
  assert.equal(await approachHome(empty.ctx, chest), false)
  assert.ok(empty.logs.some(line => /本拠点の入口へ、掘る・積む道でも行けませんでした/.test(line)), empty.logs.join('\n'))
  // As on the Realm: 130 cobblestone and 17 dirt carried.
  const f = bot(island(), { x: -4907, y: 89, z: -4992 }, { fill: 147 })
  assert.equal(await approachHome(f.ctx, chest), true, f.logs.join('\n'))
  assert.deepEqual(f.trips, [])
  assert.ok(f.placed.length >= 1 && f.placed.length <= 12, `floor blocks placed: ${f.placed.length}`)
  assert.ok(f.did.filter(step => step === 'descend').length >= 10, 'down the pillar it stacked')
  assert.ok(Math.abs(f.body.y - chest.y) <= 3)
  assert.ok(f.logs.some(line => /足場を置く \d+ 個/.test(line)), f.logs.join('\n'))
})

test('no way down: one attempt, its reason in the log, and the next only a minute later', async () => {
  const world = createOverhangWorld()
  // Nothing under the feet may be dug (the pillar and the layer are refused): no route.
  const f = bot(world, { x: -4907, y: 89, z: -4992 })
  f.ctx.hands.canMine = () => false
  f.ctx.hands.descend = async () => false
  const chest = chestOf(origin)
  assert.equal(await approachHome(f.ctx, chest), false)
  assert.equal(f.logs.filter(line => /本拠点の入口へ、掘る・積む道でも行けませんでした/.test(line)).length, 1, f.logs.join('\n'))
  const before = f.logs.length
  for (let i = 0; i < 5; i++) { f.tick(2000); assert.equal(await approachHome(f.ctx, chest), false) }
  assert.equal(f.logs.length, before, 'nothing is planned or logged again within the minute')
  assert.deepEqual(f.trips, [])
  f.tick(60000)
  assert.equal(await approachHome(f.ctx, chest), false)
  assert.ok(f.logs.length > before, 'tried again after the rest')
})

test('far from the house on the map the trip is started; beside the house on its level nothing is dug', async () => {
  const world = createOverhangWorld()
  const far = bot(world, { x: -4907, y: 89, z: -4992 })
  far.body.x -= 40
  assert.equal(await approachHome(far.ctx, chestOf(origin)), false)
  assert.deepEqual(far.trips, [{ x: origin.x + 3, z: origin.z + 9 }])
  const near = bot(world, { x: -4897, y: 76, z: -4981 })
  assert.equal(await approachHome(near.ctx, chestOf(origin)), true)
  assert.deepEqual(near.did, ['approach'])
})

test('a long trip hands off to the local home route near the porch at its level', async () => {
  const f = bot(createOverhangWorld(), { x: origin.x + 60, y: origin.y, z: origin.z + 9 })
  let trips = 0
  f.ctx.travelTo = async ({ destination }, { until }) => {
    trips++
    assert.equal(until(), false)
    Object.assign(f.body, { x: destination.x + 17, y: origin.y + 8, z: destination.z })
    assert.equal(until(), false)
    f.body.y = origin.y
    assert.equal(until(), true)
  }
  assert.equal(await approachHome(f.ctx, chestOf(origin)), false)
  assert.equal(trips, 1)
})

test('a bot the trip already counts as arrived at the porch does not start the trip again', async () => {
  // Live 2026-11-18 22:55 JST: about 20 m from the porch (-4898, -4984), which the trip calls arrived, and farther than that from the chest inside.
  const f = bot(createOverhangWorld(), { x: -4885, y: 77, z: -4970 })
  for (let i = 0; i < 3; i++) await approachHome(f.ctx, chestOf(origin))
  assert.deepEqual(f.trips, [])
  const farther = bot(createOverhangWorld(), { x: -4883, y: 77, z: -4969 })
  await approachHome(farther.ctx, chestOf(origin))
  assert.equal(farther.trips.length, 1)
})

test('a trip that ends where it began, near the house, is followed by the way that digs and stacks', async () => {
  // Live 2026-11-19 03:04-03:22 JST: 31 m east of the porch on the house's level; every trip ended at the same
  // feet (LONG_TRAVEL_BLOCKED) and the next began ten seconds later.
  const world = createOverhangWorld()
  const porch = { x: origin.x + 3, y: origin.y, z: origin.z + 9 }
  for (let x = porch.x - 2; x <= porch.x + 34; x++) for (let z = porch.z - 2; z <= porch.z + 2; z++) {
    world.setBlock(x, porch.y - 1, z, 'grass_block')
    for (let y = porch.y; y <= porch.y + 3; y++) world.setBlock(x, y, z, 'air')
  }
  // A wall across the way: nothing walks through, the route digs.
  for (let z = porch.z - 2; z <= porch.z + 2; z++) for (let y = porch.y; y <= porch.y + 1; y++) world.setBlock(porch.x + 15, y, z, 'stone')
  const f = bot(world, { x: porch.x + 30, y: porch.y, z: porch.z })
  assert.equal(await approachHome(f.ctx, chestOf(origin)), false)
  assert.equal(f.trips.length, 1)
  assert.ok(f.logs.some(line => /長距離移動が進まなかったため、掘る・積む道で入口へ行きます/.test(line)), f.logs.join('\n'))
  assert.ok(f.did.includes('mine') && f.did.includes('walk'), f.did.join(','))
  assert.ok(Math.hypot(f.body.x - (porch.x + 0.5), f.body.z - (porch.z + 0.5)) <= 4, JSON.stringify(f.body))
  assert.equal(await approachHome(f.ctx, chestOf(origin)), true, f.logs.join('\n'))
  assert.equal(f.trips.length, 1, 'no second trip')
})

test('a trip that moved is not followed by a dug way', async () => {
  const world = createOverhangWorld()
  const f = bot(world, { x: origin.x + 3 + 30, y: origin.y, z: origin.z + 9 })
  f.ctx.travelTo = async () => { f.body.x -= 6 }
  assert.equal(await approachHome(f.ctx, chestOf(origin)), false)
  assert.deepEqual(f.did, [])
  assert.equal(f.logs.length, 0)
})

test('under the opened floor at the door: the way that digs and stacks goes to the thing inside, not back to the porch', async () => {
  // Live 2026-11-19 04:42-05:01 JST: the creeper of 01:34 took the door and the floor behind it. The walk to the
  // furnace ended in the hole (feet y 73-75), the way to the porch led out again, 61 times in twenty minutes.
  const world = createOverhangWorld()
  for (let x = origin.x + 1; x <= origin.x + 5; x++) for (let z = origin.z + 1; z <= origin.z + 5; z++) for (let y = origin.y + 1; y <= origin.y + 3; y++) world.setBlock(x, y, z, 'air')
  for (let y = origin.y + 1; y <= origin.y + 2; y++) world.setBlock(origin.x + 3, y, origin.z + 6, 'air')
  for (let x = origin.x + 2; x <= origin.x + 4; x++) for (let z = origin.z + 5; z <= origin.z + 8; z++) {
    world.setBlock(x, origin.y - 3, z, 'stone')
    for (let y = origin.y - 2; y <= origin.y + 2; y++) world.setBlock(x, y, z, 'air')
  }
  const f = bot(world, { x: origin.x + 3, y: origin.y - 2, z: origin.z + 7 }, { fill: 20 })
  f.ctx.hands.approach = async () => { f.did.push('approach'); return false }
  const chest = chestOf(origin)
  assert.equal(await approachHome(f.ctx, chest), true, f.logs.join('\n'))
  assert.deepEqual(f.trips, [])
  assert.ok(Math.hypot(f.body.x - (chest.x + 0.5), f.body.z - (chest.z + 0.5)) <= 3 && Math.abs(f.body.y - chest.y) <= 1, JSON.stringify(f.body))
  assert.ok(!f.logs.some(line => /入口へ/.test(line)), f.logs.join('\n'))

  // No step can be taken: the reason once, and the next attempt a minute later.
  const stuck = bot(world, { x: origin.x + 3, y: origin.y - 2, z: origin.z + 7 }, { walkable: false })
  stuck.ctx.hands.approach = async () => false
  stuck.ctx.hands.canMine = () => false
  assert.equal(await approachHome(stuck.ctx, chest), false)
  assert.equal(stuck.logs.filter(line => /本拠点の中の .* へ、掘る・積む道でも行けませんでした/.test(line)).length, 1, stuck.logs.join('\n'))
  const before = stuck.logs.length
  stuck.tick(2000)
  assert.equal(await approachHome(stuck.ctx, chest), false)
  assert.equal(stuck.logs.length, before)
})

test('three metres from the furnace through the west wall is not at the furnace: round by the door and in', async () => {
  // Live 2026-11-19 05:47-05:52 JST: the way that digs and stacks ended at (-4902, 76, -4987), outside the
  // south-west corner, two cells from the furnace. The home step counted that as arrived, the open stand found
  // no walk in, and nothing was said or done for five minutes.
  const world = createOverhangWorld()
  for (let x = origin.x + 1; x <= origin.x + 5; x++) for (let z = origin.z + 1; z <= origin.z + 5; z++) for (let y = origin.y + 1; y <= origin.y + 3; y++) world.setBlock(x, y, z, 'air')
  for (let y = origin.y + 1; y <= origin.y + 2; y++) world.setBlock(origin.x + 3, y, origin.z + 6, 'air')
  for (let x = origin.x - 2; x <= origin.x + 5; x++) for (let z = origin.z + 5; z <= origin.z + 9; z++) {
    if (x >= origin.x && z <= origin.z + 6) continue
    world.setBlock(x, origin.y, z, 'stone')
    for (let y = origin.y + 1; y <= origin.y + 4; y++) world.setBlock(x, y, z, 'air')
  }
  const furnace = { x: origin.x + 1, y: origin.y + 1, z: origin.z + 4 }
  world.setBlock(furnace.x, furnace.y, furnace.z, 'furnace')
  const f = bot(world, { x: origin.x - 1, y: origin.y + 1, z: origin.z + 5 })
  f.ctx.hands.approach = async () => { f.did.push('approach'); return false }
  const walk = f.ctx.hands.walk, visited = []
  f.ctx.hands.walk = async target => {
    const arrived = await walk(target)
    if (arrived) visited.push(target)
    return arrived
  }
  assert.ok(Math.hypot(f.body.x - (furnace.x + 0.5), f.body.z - (furnace.z + 0.5)) < 4, 'within four blocks, outside the wall')
  assert.equal(await approachHome(f.ctx, furnace, { open: true }), true, f.logs.join('\n'))
  assert.ok(f.body.x > origin.x + 1 && f.body.x < origin.x + 6 && f.body.z > origin.z + 1 && f.body.z < origin.z + 6, JSON.stringify(f.body))
  assert.ok([...world.changed.keys()].length > 0)
  assert.ok(f.did.includes('walk'))
  const outside = visited.findIndex(p => p.x === origin.x + 3.5 && p.y === origin.y + 1 && p.z === origin.z + 7.5)
  const inside = visited.findIndex(p => p.x === origin.x + 3.5 && p.y === origin.y + 1 && p.z === origin.z + 5.5)
  assert.ok(outside >= 0 && inside > outside, JSON.stringify(visited))

  // Walled in outside with no way: said once, not silently every two seconds.
  const stuck = bot(world, { x: origin.x - 1, y: origin.y + 1, z: origin.z + 5 }, { walkable: false })
  stuck.ctx.hands.approach = async () => false
  stuck.ctx.hands.canMine = () => false
  assert.equal(await approachHome(stuck.ctx, furnace, { open: true }), false)
  assert.equal(stuck.logs.filter(line => /本拠点の中の .* へ、掘る・積む道でも行けませんでした/.test(line)).length, 1, stuck.logs.join('\n'))
})
