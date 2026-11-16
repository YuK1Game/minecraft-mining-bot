'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/actions/interactions')

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })

function fixture (item) {
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, inventory: { known: true } }
  const raw = new Map(Array.from({ length: 36 }, (_, index) => [index, emptyItem()]))
  const names = new Map([[900, item]])
  raw.set(0, { network_id: 900, count: 10, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra })
  const blocks = new Map()
  const set = (x, y, z, name, box = 'block') => blocks.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, runtimeId: 20, boundingBox: box, extra: [] })
  for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) set(x, 64, z, 'stone')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] } }
  const crafting = { applyPacket () {}, rawItem: slot => structuredClone(raw.get(slot)), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [...raw].filter(([, value]) => value.count).map(([slot, value]) => ({ slot, name: names.get(value.network_id) ?? null, count: value.count, stackId: value.stack_id })) }) }
  const input = { stats: () => ({ running: false, target: null }), lookAt () {}, start () {}, stop () {}, sendTransaction () {} }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world, crafting, getInput: () => input, onInventory () {}, onUncertain () {}, timeoutMs: 1000 })
  return { interactions, set }
}

test('a roof slab is placed against the side of the slab beside it, low on the face', () => {
  const f = fixture('minecraft:birch_slab')
  f.set(2, 67, 0, 'birch_slab', 'partial')
  const plan = f.interactions.previewHouseBlock({ position: { x: 1, y: 67, z: 0 }, slot: 0, clicked: { x: 2, y: 67, z: 0 }, face: 4, clickY: 0.25 })
  assert.equal(plan.ready, true, plan.errors?.join())
  assert.deepEqual(plan.point, { x: 2, y: 67.25, z: 0.5 })
})

test('a torch on a wall face; out of reach, onto a non-air cell, or a non-house item is refused', () => {
  const torch = fixture('minecraft:torch')
  torch.set(2, 65, 0, 'birch_planks')
  assert.equal(torch.interactions.previewHouseBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0, clicked: { x: 2, y: 65, z: 0 }, face: 4, clickY: 0.5 }).ready, true)
  assert.equal(torch.interactions.previewHouseBlock({ position: { x: 4, y: 65, z: 3 }, slot: 0, clicked: { x: 4, y: 64, z: 3 }, face: 1 }).ready, false)
  assert.equal(torch.interactions.previewHouseBlock({ position: { x: 2, y: 65, z: 0 }, slot: 0, clicked: { x: 2, y: 64, z: 0 }, face: 1 }).ready, false)
  const dirt = fixture('minecraft:diamond')
  assert.equal(dirt.interactions.previewHouseBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0, clicked: { x: 1, y: 64, z: 0 }, face: 1 }).ready, false)
})
