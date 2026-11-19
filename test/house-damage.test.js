'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHouseDamage, GIVE_UP_MS, AGAIN_MS } = require('../src/modes/house/house-damage')
const { placements } = require('../src/modes/house/house-blueprint')

const ORIGIN = { x: -4901, y: 76, z: -4993 }
const NAME = { oak_log: 'oak_log', oak_planks: 'oak_planks', oak_slab: 'oak_slab', oak_door: 'wooden_door', white_bed: 'bed' }
function setup () {
  const blocks = new Map()
  for (const step of placements(ORIGIN)) for (const cell of step.cells) blocks.set(`${cell.x},${cell.y},${cell.z}`, 'minecraft:' + (NAME[step.item] ?? step.item))
  const state = { clock: 0, feet: { x: ORIGIN.x + 3.5, y: 77, z: ORIGIN.z + 9.5 }, logs: [], unknown: false }
  const shared = { playerHouse: { origin: ORIGIN, done: true, spawn: true } }
  const getBlock = (x, y, z) => state.unknown ? { known: false } : { known: true, name: blocks.get(`${x},${y},${z}`) ?? 'minecraft:air' }
  const damage = createHouseDamage({ shared, getBlock, getFeet: () => state.feet, now: () => state.clock, log: text => state.logs.push(text) })
  // The blast of 2026-11-19 01:34 JST: the door and the floor behind it.
  const blast = () => { const door = placements(ORIGIN).find(step => step.item === 'oak_door'); for (const cell of door.cells) blocks.delete(`${cell.x},${cell.y},${cell.z}`); blocks.delete(`${ORIGIN.x + 3},${ORIGIN.y},${ORIGIN.z + 5}`) }
  const mend = () => { for (const step of placements(ORIGIN)) for (const cell of step.cells) blocks.set(`${cell.x},${cell.y},${cell.z}`, 'minecraft:' + (NAME[step.item] ?? step.item)) }
  return { state, shared, damage, blast, mend }
}

test('a whole house is left alone', () => {
  const { state, shared, damage } = setup()
  for (const t of [0, 5000, 10000]) { state.clock = t; assert.equal(damage.tick(), null) }
  assert.equal(shared.playerHouse.done, true)
})

test('blocks missing twice, near the house and all received, reopen the build; the finished repair is noted', () => {
  const { state, shared, damage, blast, mend } = setup()
  blast()
  assert.equal(damage.tick(), null, 'seen once')
  state.clock = 5000
  assert.equal(damage.tick(), 'reopened')
  assert.equal(shared.playerHouse.done, false)
  assert.equal(shared.playerHouse.spawn, true)
  assert.match(state.logs[0], /家が壊れています（\d+ 手/)
  mend(); shared.playerHouse = { ...shared.playerHouse, done: true }
  state.clock = 60000
  assert.equal(damage.tick(), 'repaired')
})

test('unreceived cells and a house out of range are never damage', () => {
  const { state, shared, damage, blast } = setup()
  blast()
  state.unknown = true
  for (const t of [0, 5000, 10000]) { state.clock = t; assert.equal(damage.tick(), null) }
  state.unknown = false
  state.feet = { x: ORIGIN.x + 60, y: 77, z: ORIGIN.z }
  for (const t of [15000, 20000]) { state.clock = t; assert.equal(damage.tick(), null) }
  assert.equal(shared.playerHouse.done, true)
})

test('a repair that does not finish in twenty minutes is closed and looked at again after an hour', () => {
  const { state, shared, damage, blast } = setup()
  blast()
  damage.tick(); state.clock = 5000; damage.tick()
  state.clock = 5000 + GIVE_UP_MS
  assert.equal(damage.tick(), 'gave_up')
  assert.equal(shared.playerHouse.done, true)
  state.clock += 10000; assert.equal(damage.tick(), null)
  state.clock += 10000; assert.equal(damage.tick(), null)
  assert.equal(shared.playerHouse.done, true)
  state.clock += AGAIN_MS; damage.tick(); state.clock += 5000
  assert.equal(damage.tick(), 'reopened')
})
