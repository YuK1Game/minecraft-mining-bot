'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { skyWay, walkToSky } = require('../src/modes/player-sky-walk')
const { climbOut } = require('../src/modes/player-climb')
const heights = require('./fixtures/overhang-heights.json')

const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }

// The received terrain around the starter house (real Realm 2026-11-18 12:45
// JST): ground at y 64-69 under an overhang whose top is at y 86-93, the open
// slope to the house east of it. Cells written to `cells` replace the terrain.
function overhang () {
  const cells = new Map()
  const block = (x, y, z) => {
    const set = cells.get(`${x},${y},${z}`)
    if (set) return set
    const top = heights.top[z - heights.z0]?.[x - heights.x0], under = heights.under[z - heights.z0]?.[x - heights.x0]
    if (top === undefined || y < 62) return { known: false }
    if (top === null) return air
    if (under == null) return y <= top ? stone : air
    return y <= under || y === top ? stone : air
  }
  return { block, cells }
}

test('real terrain: from the ground under the overhang a walk leads to the open sky', () => {
  const { block } = overhang()
  // The column the Bot stood over at 12:40 JST: grass at y 88, open air from 87 down to 70, ground at 69.
  const near = skyWay({ block, feet: { x: -4905.5, y: 70, z: -4991.5 } })
  assert.equal(near.ready, true)
  assert.deepEqual(near.path, [{ x: -4906, y: 70, z: -4992 }, { x: -4905, y: 70, z: -4992 }])
  // Thirteen cells in, under the middle of it.
  const deep = skyWay({ block, feet: { x: -4911.5, y: 67, z: -4999.5 } })
  assert.equal(deep.ready, true)
  assert.equal(deep.path.length - 1, 13)
  assert.deepEqual(deep.path.at(-1), { x: -4901, y: 67, z: -4998 })
  for (let i = 1; i < deep.path.length; i++) {
    const a = deep.path[i - 1], b = deep.path[i]
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.z - b.z), 1)
    assert.ok(Math.abs(a.y - b.y) <= 1)
  }
  // On top of the overhang the Bot is under the sky already.
  assert.equal(skyWay({ block, feet: { x: -4905.5, y: 89, z: -4991.5 } }).path.length, 1)
})

test('no way: a closed cave, unreceived cells above, a drop of two, no ground under the feet', () => {
  // A room 5 x 5 in rock.
  const room = (x, y, z) => Math.abs(x) <= 2 && Math.abs(z) <= 2 && (y === 10 || y === 11) ? air : stone
  const closed = skyWay({ block: room, feet: { x: 0.5, y: 10, z: 0.5 } })
  assert.equal(closed.ready, false)
  assert.equal(closed.reason, 'NO_SKY_ON_FOOT')
  assert.equal(closed.cells, 25)
  // Open cells above that were never received are not the sky.
  const unreceived = (x, y, z) => y <= 9 ? stone : y <= 11 ? air : { known: false }
  assert.equal(skyWay({ block: unreceived, feet: { x: 0.5, y: 10, z: 0.5 }, range: 2 }).reason, 'NO_SKY_ON_FOOT')
  // A roofed ledge two blocks above the open ground: the walk does not drop.
  const ledge = (x, y, z) => x <= 0 ? (y <= 9 || y >= 12 ? stone : air) : y <= 7 ? stone : air
  assert.equal(skyWay({ block: ledge, feet: { x: 0.5, y: 10, z: 0.5 }, range: 3 }).reason, 'NO_SKY_ON_FOOT')
  // One block down is a step.
  const step = (x, y, z) => x <= 0 ? (y <= 9 || y >= 12 ? stone : air) : y <= 8 ? stone : air
  assert.deepEqual(skyWay({ block: step, feet: { x: 0.5, y: 10, z: 0.5 }, range: 3 }).path.at(-1), { x: 1, y: 9, z: 0 })
  assert.equal(skyWay({ block: () => air, feet: { x: 0.5, y: 10, z: 0.5 } }).reason, 'NO_STAND')
  assert.equal(skyWay({ block: room, feet: null }).reason, 'NO_POSITION')
})

test('a tree crown and a built roof are not ground overhead; water is not walked through', () => {
  const leaves = { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' }, slab = { known: true, name: 'minecraft:birch_slab', boundingBox: 'block' }
  const water = { known: true, name: 'minecraft:water', boundingBox: 'empty' }
  const under = roof => (x, y, z) => y <= 9 ? stone : y === 14 ? roof : air
  assert.equal(skyWay({ block: under(leaves), feet: { x: 0.5, y: 10, z: 0.5 } }).path.length, 1)
  assert.equal(skyWay({ block: under(slab), feet: { x: 0.5, y: 10, z: 0.5 } }).path.length, 1)
  assert.equal(skyWay({ block: under(stone), feet: { x: 0.5, y: 10, z: 0.5 }, range: 2 }).ready, false)
  // Rock overhead west of x = 2, a strip of water at x = 1 between the Bot and the sky.
  const moat = (x, y, z) => y <= 9 ? stone : x === 1 && y === 10 ? water : x < 2 && y >= 12 ? stone : air
  assert.equal(skyWay({ block: moat, feet: { x: 0.5, y: 10, z: 0.5 }, range: 4 }).reason, 'NO_SKY_ON_FOOT')
})

test('the way is walked a few cells at a time, and a walk that fails says how far it came', async () => {
  const { block } = overhang()
  let feet = { x: -4911.5, y: 67, z: -4999.5 }
  const walks = [], lines = []
  const ports = { feet: () => feet, block, walk: async target => { walks.push(target); feet = { ...target }; return true } }
  assert.deepEqual(await walkToSky({ ports, log: text => lines.push(text) }), { ok: true, walked: 13 })
  assert.equal(walks.length, 3)
  assert.deepEqual(feet, { x: -4900.5, y: 67, z: -4997.5 })
  assert.match(lines[0], /空の見える場所へ歩いて出ます（13マス、-4901,67,-4998）/)
  // Already under the sky: nothing is walked and nothing is said.
  assert.deepEqual(await walkToSky({ ports, log: text => lines.push(text) }), { ok: true, walked: 0 })
  assert.equal(walks.length, 3)
  assert.equal(lines.length, 1)
  // No walk moves the Bot.
  feet = { x: -4911.5, y: 67, z: -4999.5 }
  const stuck = { feet: () => feet, block, walk: async () => false, why: () => 'No safe route found' }
  const failed = await walkToSky({ ports: stuck, log: text => lines.push(text) })
  assert.deepEqual(failed, { ok: false, reason: 'WALK_FAILED', walked: 0 })
  assert.match(lines.at(-1), /空の見える場所へ歩く途中で止まりました（0\/13マス、No safe route found）/)
  // In a closed cave there is nothing to walk.
  const room = (x, y, z) => Math.abs(x) <= 2 && Math.abs(z) <= 2 && (y === 10 || y === 11) ? air : stone
  assert.equal((await walkToSky({ ports: { feet: () => ({ x: 0.5, y: 10, z: 0.5 }), block: room, walk: async () => true } })).reason, 'NO_SKY_ON_FOOT')
})

// The climb's hands over that terrain, in the column (-4906, -4993): rock up to y 68, the overhang's grass at y 88.
function climber (feetY) {
  const { block, cells } = overhang()
  const column = { x: -4906, z: -4993 }, at = { x: column.x + 0.5, y: feetY, z: column.z + 0.5 }
  const put = (y, found) => cells.set(`${column.x},${y},${column.z}`, found)
  put(feetY, air); put(feetY + 1, air)
  let dirt = 64
  const ports = {
    feet: () => ({ ...at }), block, dirt: () => dirt, walk: async () => true, why: () => null,
    canMine: () => true,
    mine: async cell => { cells.set(`${cell.x},${cell.y},${cell.z}`, air); return true },
    pillar: async (where, y) => { put(y, { known: true, name: 'minecraft:dirt', boundingBox: 'block' }); put(y + 1, air); put(y + 2, air); at.y = y + 1; dirt--; return { ok: true } }
  }
  return { ports, at, block, used: () => 64 - dirt }
}

test('real terrain: the climb out of the tunnel ends on the ground under the overhang, not on top of it', async () => {
  // As it ran on the Realm: the pillar goes on through 18 blocks of open air and through the overhang.
  const before = climber(63), said = []
  const old = await climbOut({ ports: before.ports, sleep: async () => {}, log: text => said.push(text) })
  assert.equal(old.ok, true)
  assert.equal(before.at.y, 89)
  assert.equal(old.steps, 26)
  assert.match(said.at(-1), /真上へ26段のぼって地上へ出ました/)
  // With the way out: six steps, feet on the ground it dug out of, one cell from the open sky.
  const sim = climber(63), lines = []
  const out = await climbOut({ ports: sim.ports, sleep: async () => {}, log: text => lines.push(text), wayOut: () => skyWay({ block: sim.block, feet: sim.ports.feet() }).ready })
  assert.equal(out.ok, true)
  assert.equal(out.walkable, true)
  assert.equal(sim.at.y, 69)
  assert.equal(out.steps, 6)
  assert.equal(sim.used(), 6)
  assert.match(lines.at(-1), /真上へ6段のぼりました。ここから空の見える場所へ歩いて出られるので、頭上の地面へは登りません/)
  const way = skyWay({ block: sim.block, feet: sim.ports.feet() })
  assert.deepEqual(way.path.at(-1), { x: -4905, y: 70, z: -4993 })
})

test('the climb is not ended inside the rock or in a cave without a way to the sky', async () => {
  // A cave: rock to y 66, open from 67 to 72, rock from 73 to 80, the sky above. Closed all around.
  const cells = new Map(), at = { x: 0.5, y: 62, z: 0.5 }
  const block = (x, y, z) => cells.get(`${x},${y},${z}`) ?? ((y >= 67 && y <= 72 && Math.abs(x) <= 3 && Math.abs(z) <= 3) || y > 80 ? air : stone)
  cells.set('0,62,0', air); cells.set('0,63,0', air)
  let asked = 0
  const ports = {
    feet: () => ({ ...at }), block, dirt: () => 64, walk: async () => true, why: () => null, canMine: () => true,
    mine: async cell => { cells.set(`${cell.x},${cell.y},${cell.z}`, air); return true },
    pillar: async (where, y) => { cells.set(`0,${y},0`, { known: true, name: 'minecraft:dirt', boundingBox: 'block' }); cells.set(`0,${y + 1},0`, air); cells.set(`0,${y + 2},0`, air); at.y = y + 1; return { ok: true } }
  }
  const out = await climbOut({ ports, sleep: async () => {}, wayOut: () => { asked++; return skyWay({ block, feet: ports.feet() }).ready } })
  assert.equal(out.ok, true)
  assert.equal(out.walkable, false)
  assert.equal(at.y, 81)
  // Asked only above the ground it dug through (the cave), never inside the rock.
  assert.ok(asked >= 1 && asked <= 7, `asked ${asked} times`)
})
