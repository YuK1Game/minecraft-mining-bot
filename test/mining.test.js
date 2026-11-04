'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout } = require('node:timers/promises')
const { createMining } = require('../src/mining')

function fixture () {
  const state = { phase: 'spawned', dimension: 'overworld', gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, inventory: { known: true, items: [] }, selectedSlot: null, heldItem: null }
  const blocks = new Map()
  const id = p => `${p.x},${p.y},${p.z}`
  const set = (p, name, runtimeId = 1) => blocks.set(id(p), { known: true, name: `minecraft:${name}`, runtimeId, extra: [] })
  const target = { x: 1, y: 65, z: 0 }
  set({ x: 0, y: 64, z: 0 }, 'stone')
  set(target, 'dirt')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, extra: [] } }
  let running = false
  const actions = []
  const input = { lookAt () {}, start () { running = true }, stop () { running = false }, sendAction (...action) { actions.push(action) }, stats: () => ({ running }) }
  const mining = createMining({ getState: () => state, world, getInput: () => input, blockTimeoutMs: 120 })
  return { mining, state, blocks, set, target, actions, id }
}

test('online learning HP1 mining retains real tool, unknown terrain, body and death gates', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.mining.preview([f.target]).ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.mining.preview([f.target]).ready, true)
  f.set(f.target, 'diamond_ore'); assert.equal(f.mining.preview([f.target]).ready, false)
  f.blocks.set(f.id(f.target), { known: false }); assert.equal(f.mining.preview([f.target]).ready, false)
  f.set(f.target, 'dirt'); f.state.position.y += 0.3; assert.equal(f.mining.preview([f.target]).ready, false)
  f.state.position.y -= 0.3; f.state.lifecycle = { dead: true }; assert.equal(f.mining.preview([f.target]).ready, false)
  f.state.lifecycle.dead = false; f.state.health = 0; assert.equal(f.mining.preview([f.target]).ready, false)
  assert.equal(f.actions.length, 0)
})

test('preview never emits input and refuses unknown terrain, hazards, occlusion and foot support removal', () => {
  const { mining, state, blocks, set, target, actions, id } = fixture()
  assert.equal(mining.preview([target]).ready, true)
  assert.equal(actions.length, 0)
  blocks.set(id(target), { known: false })
  assert.equal(mining.preview([target]).ready, false)
  set(target, 'dirt')
  set({ x: 2, y: 65, z: 0 }, 'lava')
  assert.equal(mining.preview([target]).ready, false)
  blocks.delete('2,65,0')
  set({ x: 0, y: 66, z: 0 }, 'stone')
  assert.equal(mining.preview([target]).ready, false)
  blocks.delete('0,66,0')
  assert.equal(mining.preview([{ x: 0, y: 64, z: 0 }]).ready, false)
  state.health = 4
  assert.equal(mining.preview([target]).ready, false)
})

test('tool requirement prevents ore loss until an appropriate selected pickaxe is known', () => {
  const { mining, state, set, target } = fixture()
  set(target, 'diamond_ore')
  assert.equal(mining.preview([target]).ready, false)
  state.selectedSlot = 0
  state.heldItem = { name: 'minecraft:stone_pickaxe' }
  assert.equal(mining.preview([target]).ready, false)
  state.heldItem.name = 'minecraft:iron_pickaxe'
  assert.equal(mining.preview([target]).ready, true)
})

test('bare hands can harvest tree logs while processed wood and unsafe targets remain refused', () => {
  const { mining, set, target, actions } = fixture()
  for (const name of ['oak_log', 'spruce_log', 'pale_oak_log', 'poplar_log']) {
    set(target, name)
    assert.equal(mining.preview([target]).ready, true, `${name} should allow bare-hand harvesting`)
  }
  for (const name of ['oak_planks', 'stripped_oak_log', 'oak_wood', 'diamond_ore']) {
    set(target, name)
    assert.equal(mining.preview([target]).ready, false, `${name} must not inherit tree-log permission`)
  }
  set(target, 'oak_log')
  set({ x: 2, y: 65, z: 0 }, 'lava')
  assert.equal(mining.preview([target]).ready, false)
  assert.equal(actions.length, 0)
})

test('bare hands clear vanilla tree foliage while unknown leaves and wet or unsafe targets remain refused', () => {
  const { mining, state, blocks, set, target, actions, id } = fixture()
  for (const name of ['oak_leaves', 'mangrove_leaves', 'azalea_leaves_flowered', 'yellow_poplar_leaves', 'leaf_litter']) {
    set(target, name)
    assert.equal(mining.preview([target]).ready, true, name)
  }
  set(target, 'custom_leaves')
  assert.equal(mining.preview([target]).ready, false)
  set(target, 'oak_leaves')
  blocks.get(id(target)).extra = [{ known: true, name: 'minecraft:water' }]
  assert.equal(mining.preview([target]).ready, false)
  set(target, 'oak_leaves')
  blocks.set('2,65,0', { known: false })
  assert.equal(mining.preview([target]).ready, false)
  blocks.delete('2,65,0')
  set({ x: 0, y: 64, z: 0 }, 'oak_leaves')
  assert.equal(mining.preview([{ x: 0, y: 64, z: 0 }]).ready, false)
  state.health = 6
  assert.equal(mining.preview([target]).ready, false)
  assert.equal(actions.length, 0)
})

test('only a server-observed air block completes mining; sending an action is not success', async t => {
  const { mining, set, target, actions } = fixture()
  t.after(() => mining.stop())
  mining.start([target])
  assert.equal(actions.length, 1)
  assert.equal(mining.snapshot().phase, 'mining')
  assert.equal(mining.snapshot().completed.length, 0)
  set(target, 'air', 0)
  await setTimeout(140)
  assert.equal(mining.snapshot().phase, 'completed')
  assert.equal(mining.snapshot().completed.length, 1)
})

test('received terrain wakes the next block immediately, once, without trusting the packet alone', async t => {
  const { mining, set, target, actions, blocks, id } = fixture()
  const next = { x: 2, y: 65, z: 0 }
  set(next, 'dirt')
  t.after(() => mining.stop())
  mining.start([target, next])
  const update = position => mining.applyPacket('update_block', { position, block_runtime_id: 0 })
  update(target)
  await Promise.resolve()
  assert.equal(actions.length, 1, 'a packet payload without received world air cannot complete mining')
  blocks.set(id(target), { known: false })
  update({ x: 99, y: 65, z: 0 })
  await Promise.resolve()
  assert.equal(mining.snapshot().phase, 'mining', 'unrelated updates do not inspect the target')
  set(target, 'air', 0)
  update(target); update(target)
  await Promise.resolve()
  assert.equal(actions.length, 2)
  assert.deepEqual(mining.snapshot().activeTarget, next)
  assert.equal(mining.snapshot().completed.length, 1)
  set(next, 'air', 0)
  mining.applyPacket('update_subchunk_blocks', { blocks: [{ position: next, runtime_id: 0 }] })
  await Promise.resolve()
  assert.equal(mining.snapshot().phase, 'completed')
  assert.equal(actions.length, 2)
})

test('queued terrain observations cannot continue a stopped or replaced mining run', async t => {
  const { mining, set, target, actions } = fixture()
  t.after(() => mining.stop())
  mining.start([target])
  set(target, 'air', 0)
  mining.applyPacket('update_block', { position: target })
  mining.stop('reload')
  set(target, 'dirt')
  mining.start([target])
  set(target, 'air', 0)
  await Promise.resolve()
  assert.equal(mining.snapshot().phase, 'mining', 'old run must not inspect or advance the replacement')
  assert.equal(actions.length, 2)
  mining.applyPacket('update_block', { position: target })
  await Promise.resolve()
  assert.equal(mining.snapshot().phase, 'completed')
})

test('tree-access mining pins the exact dry vegetation name and refuses replacements or extra layers', () => {
  const { mining, blocks, set, target, id, actions } = fixture()
  for (const name of ['leaf_litter', 'vine']) {
    set(target, name)
    blocks.get(id(target)).boundingBox = 'empty'
    const pinned = { ...target, accessPreparation: 'tree_access', expectedName: `minecraft:${name}` }
    assert.equal(mining.preview([pinned]).ready, true)
    set(target, 'stone')
    assert.equal(mining.preview([pinned]).ready, false)
    assert.throws(() => mining.start([pinned]), /植物が変更/)
    set(target, name)
    blocks.get(id(target)).boundingBox = 'empty'
    blocks.get(id(target)).protected = true
    assert.equal(mining.preview([pinned]).ready, false)
    blocks.get(id(target)).protected = false
    blocks.get(id(target)).extra = [{ name: 'minecraft:water' }]
    assert.equal(mining.preview([pinned]).ready, false)
  }
  assert.throws(() => mining.preview([{ ...target, accessPreparation: 'tree_access', expectedName: 'minecraft:oak_log' }]), /許可された対象名/)
  assert.equal(actions.length, 0)
})

test('empty-collision vines and litter remain opaque to wood aiming until received air replaces them', () => {
  const { mining, blocks, set, id, actions } = fixture()
  const wood = { x: 3, y: 65, z: 0 }
  set(wood, 'oak_log')
  for (const name of ['leaf_litter', 'vine']) {
    for (const y of [65, 66]) {
      const point = { x: 1, y, z: 0 }
      set(point, name)
      blocks.get(id(point)).boundingBox = 'empty'
    }
    assert.equal(mining.preview([wood]).ready, false, name)
    for (const y of [65, 66]) set({ x: 1, y, z: 0 }, 'air', 0)
    assert.equal(mining.preview([wood]).ready, true)
  }
  assert.equal(actions.length, 0)
})

test('timeout and player movement abort instead of continuing or reporting success', async t => {
  const { mining, target } = fixture()
  t.after(() => mining.stop())
  mining.start([target])
  await setTimeout(240)
  assert.equal(mining.snapshot().phase, 'failed')
  assert.equal(mining.snapshot().completed.length, 0)
  const other = fixture()
  t.after(() => other.mining.stop())
  other.mining.start([other.target])
  other.state.position.x += 1
  await setTimeout(140)
  assert.equal(other.mining.snapshot().phase, 'failed')
})
