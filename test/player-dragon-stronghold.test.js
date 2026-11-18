'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDragonStronghold } = require('../src/modes/dragon-stronghold')
const { active, frames, intersection, portalFromFrame, miningTarget } = require('../src/modes/dragon-stronghold-navigation')
const { dragonItemPlan } = require('../src/actions/dragon-item-use')
const { createMining } = require('../src/actions/mining')

const AIR = { name: 'minecraft:air', known: true, boundingBox: 'empty', runtimeId: 0, extra: [] }
const block = (name, id, properties = {}) => ({ name: 'minecraft:' + name, runtimeId: id, known: true, boundingBox: 'block', properties, extra: [] })
function world () {
  const map = new Map()
  const set = (p, b) => map.set([p.x, p.y, p.z].join(','), b)
  const get = (x, y, z) => map.get([x, y, z].join(',')) ?? AIR
  return { set, get }
}

test('stronghold triangulation requires forward, separated measurements and a usable baseline', () => {
  const first = { x: 0, z: 0, dx: 1, dz: 0 }
  assert.deepEqual(intersection(first, { x: 40, z: 60, dx: 0.8, dz: -0.6 }), { x: 120, z: 0 })
  assert.equal(intersection(first, { x: 40, z: 60, dx: -0.8, dz: 0.6 }), null)
  assert.equal(intersection(first, { x: 0, z: 50, dx: 1, dz: 0 }), null)
  assert.equal(intersection(first, { x: 1, z: 2, dx: 0, dz: -1 }), null)
})

test('a complete ring is distinct from nine received active portal cells', () => {
  const { set, get } = world(), c = { x: -44, y: -32, z: 53 }, ring = frames(c)
  for (const p of ring.slice(1)) set(p, block('end_portal_frame', 20))
  assert.equal(portalFromFrame(get, ring[1]), null)
  set(ring[0], block('end_portal_frame', 20))
  for (const p of ring) assert.deepEqual(portalFromFrame(get, p), c)
  assert.equal(active(get, c), false)
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) set({ x: c.x + dx, y: c.y, z: c.z + dz }, block('end_portal', 21))
  assert.equal(active(get, c), true)
  set(c, { known: false, name: 'minecraft:end_portal' })
  assert.equal(active(get, c), false)
})

test('the item action distinguishes casting from inserting an eye in an empty frame', () => {
  const p = { x: 1, y: 0, z: 0 }, { set, get } = world(), item = 'minecraft:ender_eye', raw = { count: 4, stack_id: 10 }
  const env = { world: { getBlock: get }, state: { dimension: 'overworld', position: { x: 0.5, y: 1.62, z: 0.5 }, inventory: { known: true } }, inventory: { inventoryKnown: true, inventory: [{ name: item, slot: 3, count: 4, stackId: 10 }] }, raw, lineOfSight: () => {} }
  assert.equal(dragonItemPlan({ item, slot: 3 }, env).airUse, true)
  set(p, block('end_portal_frame', 20, { end_portal_eye_bit: 0 }))
  const plan = dragonItemPlan({ item, slot: 3, position: p }, env)
  assert.equal(plan.blockRuntimeId, 20)
  assert.equal(plan.clickPos.y, 13 / 16)
  set(p, block('end_portal_frame', 21, { end_portal_eye_bit: 1 }))
  assert.throws(() => dragonItemPlan({ item, slot: 3, position: p }, env))
  env.state.dimension = 'nether'
  assert.throws(() => dragonItemPlan({ item, slot: 3 }, env))
})

test('the real mining preview admits exact stronghold blocks only with an Overworld pickaxe', () => {
  const { get, set } = world(), p = { x: 1, y: 65, z: 0 }
  set({ x: 0, y: 64, z: 0 }, block('stone', 5))
  const state = { phase: 'spawned', dimension: 'overworld', gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, inventory: { known: true, items: [] }, selectedSlot: 0, heldItem: { name: 'minecraft:diamond_pickaxe' } }
  const mining = createMining({ world: { getBlock: get }, getState: () => state, getInput: () => ({}) })
  for (const name of ['mob_spawner', 'stone_bricks', 'cracked_stone_bricks', 'mossy_stone_bricks']) {
    const b = block(name, 4), target = miningTarget(p, b)
    set(p, b)
    assert.equal(mining.preview([p]).ready, false)
    assert.equal(mining.preview([target]).ready, true)
    assert.equal(mining.preview([{ ...target, expectedRuntimeId: 2 }]).ready, false)
    set(p, { ...b, protected: true })
    assert.equal(mining.preview([target]).ready, false)
  }
  const b = block('mob_spawner', 4), t = miningTarget(p, b)
  set(p, b)
  state.heldItem = null
  assert.equal(mining.preview([t]).ready, false)
  state.heldItem = { name: 'minecraft:iron_pickaxe' }
  state.dimension = 'nether'
  assert.equal(mining.preview([t]).ready, false)
})

test('missing solid portal evidence after rejoin cannot trigger portal entry', async () => {
  const portal = { x: 2, y: 40, z: 7 }, { get, set } = world()
  for (const f of frames(portal)) set(f, block('end_portal_frame', 2, { end_portal_eye_bit: 0 }))
  let calls = 0
  const job = createDragonStronghold({
    shared: {}, getFeet: () => ({ x: 5.5, y: 41, z: 7.5 }), hands: {}, getBlock: get, operations: {},
    cancelled: () => false, runtime: { raw: () => ({ dimension: 'overworld' }), enterEndPortal: () => calls++ }
  })
  const result = await job.enter({ stronghold: { prepared: true, portal } })
  assert.equal(result.phase, 'waiting')
  assert.equal(calls, 0)
})

test('confirmed outer stone approach crosses a filled frame beside lava using the actual physics at both elevations', () => {
  const { portalEntry } = require('../src/movement/end-portal-entry')
  for (const floorY of [63, 64]) {
    let valid = true
    const surface = { getBlock (x, y, z) {
      const name = y <= 62 ? 'stone' : y === 63 && x >= 1 ? 'lava' : y <= floorY && x < 0 ? 'stone' :
        y === 64 && x === 0 ? 'end_portal_frame' : y === 64 && x >= 1 ? 'end_portal' : 'air'
      const properties = name === 'end_portal_frame' ? { end_portal_eye_bit: valid ? 1 : 0, 'minecraft:cardinal_direction': 'south' } : name === 'lava' ? { liquid_depth: 0 } : {}
      return { ...block(name, 1, properties), position: { x, y, z }, boundingBox: ['air', 'lava', 'end_portal'].includes(name) ? 'empty' : 'block' }
    } }
    const state = { phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: -0.5, y: floorY + 2.62, z: 0.5 }, positionSource: 'server_post_move', rotation: { yaw: 0, pitch: 0 } }
    const make = () => portalEntry(surface, state, { x: 1, y: 64, z: 0 }, '1.26.60').stepper
    let frame
    const stepper = make()
    do { frame = stepper.next() } while (!frame.settled)
    assert.equal(frame.phase, 'awaiting_server_confirmation')
    const interrupted = make(); valid = false
    assert.throws(() => interrupted.next())
  }
})

test('loss of all blaze material goes back to the Nether while retaining a discovered stronghold', async () => {
  const record = { stage: 'stronghold', stronghold: { surface: { x: 42, y: 63, z: 2 } }, nether: { homeGate: { x: 2, y: 63, z: 2 } } }
  const job = createDragonStronghold({
    shared: {}, getFeet: () => ({ x: 3, y: 63, z: 2 }), hands: {}, getBlock: () => AIR, operations: {},
    cancelled: () => false, runtime: { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: [] }) }
  })
  await job.step(record)
  assert.equal(record.stage, 'nether')
  assert.equal(record.stronghold.resumeSurface, true)
  assert.deepEqual(record.stronghold.surface, { x: 42, y: 63, z: 2 })
})
