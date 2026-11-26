'use strict'

// "An enemy is near" (src/modes/work-danger.js) with the house build it gates (src/modes/house/house-build.js): the real
// danger check, the real sight evidence (combat-exposure.js) and the real build over the starter house standing on stone.
//
// Real Realm 2026-11-20 22:15-22:44 JST: six runs of the house repair ended 「敵が近いため中断しました」 with nothing
// placed; no fight, hit or flee line was within 5 s of any. At 23:40 sixteen hostiles stood in the caves 9-32 blocks
// under the house, a skeleton 13 below among them, positions received within seconds.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorkDanger, HURT_MS } = require('../src/modes/work-danger')
const { createHouseBuild } = require('../src/modes/house/house-build')
const { createHouseWorld, ORIGIN } = require('./helpers/house-world')

const WALL = 'p_060' // one plank of a wall
const stack = (name, count, slot) => ({ name: 'minecraft:' + name, count, slot })
const mob = (type, position, extra = {}) => ({ runtimeId: '70', uniqueId: '-70', kind: 'mob', entityType: 'minecraft:' + type, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position, ...extra })
// In a cave 13 below the floor, 12.7 m off level: 20 m from the eye of a Bot in the room.
const CAVE = { x: ORIGIN.x + 12.5, y: ORIGIN.y - 13, z: ORIGIN.z + 13.5 }
// On the grass south of the house, at the Bot's height: 18 m away, nothing between.
const LAWN = { x: ORIGIN.x + 3.5, y: ORIGIN.y + 1, z: ORIGIN.z + 24.5 }

function scene ({ unreceived = () => false } = {}) {
  const w = createHouseWorld()
  w.take(WALL)
  const f = { w, clock: 1e6, feet: { x: ORIGIN.x + 3.5, y: ORIGIN.y + 1, z: ORIGIN.z + 4.5 }, health: 20, actors: [], onStop: null, unreachable: false, logs: [], placed: [] }
  const held = [stack('iron_pickaxe', 1, 0), stack('oak_planks', 4, 1)]
  // Stone under the house, the cave's two cells of air, and (when asked) cells that were never received.
  const getBlock = (x, y, z) => {
    if (unreceived(x, y, z)) return { known: false }
    if (x === Math.floor(CAVE.x) && z === Math.floor(CAVE.z) && (y === CAVE.y || y === CAVE.y + 1)) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return y < ORIGIN.y ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : w.getBlock(x, y, z)
  }
  const eye = () => ({ ...f.feet, y: f.feet.y + 1.62 })
  f.danger = createWorkDanger({ health: () => f.health, where: eye, hostiles: () => f.actors, world: () => ({ getBlock }), unreachable: () => f.unreachable, now: () => f.clock })
  f.shared = { playerWanted: true, playerHouse: { origin: ORIGIN, done: false, spawn: true, built: true, repair: { state: 'running', since: 1e6 } } }
  const ports = {
    craft: async () => false, why: () => null, reset () {}, mine: async () => false,
    inspectChest: async () => ({ status: 'completed', evidence: { slotCount: 54 } }),
    place: async (name, plan) => {
      const step = w.steps.find(one => one.position.x === plan.position.x && one.position.y === plan.position.y && one.position.z === plan.position.z)
      const pile = held.find(item => item.name === name && item.count > 0)
      assert.ok(pile, name); pile.count--; f.placed.push(step.id); w.mend(step.id)
      return true
    }
  }
  f.build = createHouseBuild({
    getMode: () => 'player', shared: f.shared, ports, log: line => f.logs.push(line),
    hands: { walk: async stand => { Object.assign(f.feet, stand); return true }, approach: async () => true },
    getBlock, getFeet: () => ({ ...f.feet }), getPosition: eye, getInventory: () => ({ known: true, items: held }),
    agent: { objective: {}, stop () { f.onStop?.() }, start: async () => {}, settled: () => true }, climb: async () => ({ ok: true }),
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} }, now: () => f.clock, sleep: async ms => { f.clock += ms },
    hostile: () => f.danger.near(), hostileWhy: () => f.danger.text()
  })
  f.tick = async (ms = 0) => { f.clock += ms; return f.build.tick() }
  f.fresh = () => new Date(f.clock - 1000).toISOString()
  f.said = pattern => f.logs.filter(line => pattern.test(line))
  return f
}

test('a skeleton in a cave under the house, every line to it ending in received stone, does not stop the repair', async () => {
  const f = scene()
  f.actors = [mob('skeleton', CAVE, { positionUpdatedAt: f.fresh() })]
  assert.equal(f.danger.why(), null)
  await f.tick()
  assert.deepEqual(f.placed, [WALL])
  assert.equal(f.shared.playerHouse.done, true)
  assert.deepEqual(f.said(/敵が近い/), [])
})

test('a skeleton beyond cells that were never received counts: unreceived is not cover', async () => {
  // South of the door, a band of the open ground was never received.
  const f = scene({ unreceived: (x, y, z) => y > ORIGIN.y && z >= ORIGIN.z + 14 && z <= ORIGIN.z + 16 })
  f.actors = [mob('skeleton', LAWN, { positionUpdatedAt: f.fresh() })]
  assert.equal(f.danger.why().code, 'ARCHER')
  assert.equal(await f.tick(), null)
  assert.deepEqual(f.placed, [])
})

test('a skeleton in the open cuts the repair short, and the line says who it was', async () => {
  const f = scene()
  // It comes into view as the run begins, the Bot before the door.
  f.feet = f.w.porch()
  f.onStop = () => { f.actors = [mob('skeleton', LAWN, { positionUpdatedAt: f.fresh() })] }
  await f.tick()
  assert.deepEqual(f.placed, [])
  assert.deepEqual(f.said(/敵が近い/), ['プレイヤーモード: 拠点の家: 敵が近いため中断しました（2分後に続けます）。相手: skeleton 15m'])
  // Gone: the repair goes on two minutes later.
  f.actors = []; f.onStop = null
  await f.tick(125000)
  assert.deepEqual(f.placed, [WALL])
})

test('a walker within 12 m counts unless there is fresh evidence of no route or it is levels away behind solid rock; an archer that has not moved for a minute does not', async () => {
  const f = scene()
  const under = { x: f.feet.x + 3, y: ORIGIN.y - 8, z: f.feet.z }
  // Nine below inside solid stone on every line: not near for the work (live 2026-11-26, a zombie under the house).
  f.actors = [mob('zombie', under)]
  assert.equal(f.danger.near(), false, 'a walker levels below behind solid rock does not cut the work short')
  const beside = { x: f.feet.x + 6, y: f.feet.y, z: f.feet.z }
  f.actors = [mob('zombie', beside)]
  assert.equal(f.danger.why()?.code, 'NEAR')
  f.unreachable = true
  assert.equal(f.danger.near(), false)
  f.actors = [mob('creeper', under)]
  assert.equal(f.danger.near(), true, 'a creeper always counts')
  f.actors = [mob('skeleton', LAWN, { positionUpdatedAt: new Date(f.clock - 61000).toISOString() })]
  assert.equal(f.danger.near(), false)
  f.actors = [mob('skeleton', LAWN)]
  assert.equal(f.danger.near(), true, 'no time of the position: counted')
})

test('an enemy abort mid-put or mid-yard-fill does not lock out those steps in failedAt for 10 minutes', async () => {
  const f = scene()
  // Place a hostile mid-walk during put(WALL), then remove it before the 2-minute retry.
  const origWalk = f.build
  assert.ok(origWalk)
  const w = createHouseWorld()
  w.take(WALL)
  const feet = { x: ORIGIN.x + 3.5, y: ORIGIN.y + 1, z: ORIGIN.z + 4.5 }
  const held = [stack('iron_pickaxe', 1, 0), stack('oak_planks', 4, 1)]
  const getBlock = (x, y, z) => y < ORIGIN.y ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : w.getBlock(x, y, z)
  const eye = () => ({ ...feet, y: feet.y + 1.62 })
  let clock = 1e6, actors = [], placeCalls = 0
  const logs = [], placed = []
  const danger = createWorkDanger({ health: () => 20, where: eye, hostiles: () => actors, world: () => ({ getBlock }), now: () => clock })
  const shared = { playerWanted: true, playerHouse: { origin: ORIGIN, done: false, spawn: true, built: true, repair: { state: 'running', since: 1e6 } } }
  const build = createHouseBuild({
    getMode: () => 'player', shared, log: line => logs.push(line),
    ports: {
      craft: async () => false, why: () => null, reset () {}, mine: async () => false,
      inspectChest: async () => ({ status: 'completed', evidence: { slotCount: 54 } }),
      place: async (name, plan) => {
        placeCalls++
        if (placeCalls === 1) {
          actors = [mob('skeleton', LAWN, { positionUpdatedAt: new Date(clock - 1000).toISOString() })]
          return false
        }
        const step = w.steps.find(one => one.position.x === plan.position.x && one.position.y === plan.position.y && one.position.z === plan.position.z)
        const pile = held.find(item => item.name === name && item.count > 0)
        assert.ok(pile, name); pile.count--; placed.push(step.id); w.mend(step.id)
        return true
      }
    },
    hands: { walk: async stand => { Object.assign(feet, stand); return true }, approach: async () => true },
    getBlock, getFeet: () => ({ ...feet }), getPosition: eye, getInventory: () => ({ known: true, items: held }),
    agent: { objective: {}, stop () {}, start: async () => {}, settled: () => true }, climb: async () => ({ ok: true }),
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} }, now: () => clock, sleep: async ms => { clock += ms },
    hostile: () => danger.near(), hostileWhy: () => danger.text()
  })
  await build.tick()
  assert.deepEqual(placed, [])
  assert.ok(logs.some(line => /敵が近いため中断しました（2分後に続けます）/.test(line)))
  assert.equal(logs.some(line => /置けなかった理由/.test(line)), false, 'aborted step is not logged as a placement failure')
  // Two minutes later (far short of the 10-minute AGAIN_MS lockout): the retry actually runs and places WALL.
  actors = []
  clock += 125000
  await build.tick()
  assert.deepEqual(placed, [WALL])
  assert.equal(shared.playerHouse.done, true)
})

test('health lost counts for ten seconds, with no enemy in sight', () => {
  const f = scene()
  assert.equal(f.danger.near(), false)
  f.health = 17
  assert.equal(f.danger.text(), '10秒以内に被弾')
  f.clock += HURT_MS - 1
  assert.equal(f.danger.near(), true)
  f.clock += 1
  assert.equal(f.danger.near(), false)
  f.health = 19 // healed: not a hit
  assert.equal(f.danger.near(), false)
})
