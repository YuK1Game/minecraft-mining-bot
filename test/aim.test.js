'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { selectVisibleBlockFace, traceBlockFace } = require('../src/aim')
const { createMining } = require('../src/mining')

function fixture () {
  const blocks = new Map()
  const key = point => `${point.x},${point.y},${point.z}`
  const set = (point, name, extra = []) => blocks.set(key(point), { known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : 50, extra })
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, extra: [] } }
  return { blocks, key, set, world }
}

test('visible face selection uses the correct Bedrock attack side in every cardinal direction', () => {
  const f = fixture()
  const target = { x: 0, y: 0, z: 0 }
  f.set(target, 'stone')
  for (const [eye, expectedFace] of [
    [{ x: 0.5, y: -1, z: 0.5 }, 0], [{ x: 0.5, y: 2, z: 0.5 }, 1],
    [{ x: 0.5, y: 0.5, z: -1 }, 2], [{ x: 0.5, y: 0.5, z: 2 }, 3],
    [{ x: -1, y: 0.5, z: 0.5 }, 4], [{ x: 2, y: 0.5, z: 0.5 }, 5]
  ]) {
    const result = selectVisibleBlockFace({ eye, target, world: f.world })
    assert.equal(result.face, expectedFace)
    assert.equal(result.distance, 1)
    assert.equal(traceBlockFace({ eye, target, world: f.world, point: result.point }).face, expectedFace)
    for (const axis of ['x', 'y', 'z']) assert.ok(result.point[axis] > target[axis] && result.point[axis] < target[axis] + 1)
  }
})

test('a staircase lower block has a visible near side even when the block above hides its centre', () => {
  const f = fixture()
  const eye = { x: 0.5, y: 66.62, z: 0.5 }
  const target = { x: 1, y: 65, z: 0 }
  f.set(target, 'stone')
  f.set({ x: 1, y: 66, z: 0 }, 'stone')
  assert.equal(traceBlockFace({ eye, target, world: f.world, point: { x: 1.5, y: 65.5, z: 0.5 } }), null)
  const result = selectVisibleBlockFace({ eye, target, world: f.world })
  assert.ok(result)
  assert.equal(result.face, 4)
  assert.equal(result.hit.x, 1)
  assert.ok(result.hit.y < 66 && result.hit.y > 65)
})

test('reach is measured to the actual face rather than the hidden block centre', () => {
  const f = fixture()
  const target = { x: 5, y: 65, z: 0 }
  f.set(target, 'diamond_ore')
  const eye = { x: 0.5, y: 65.5, z: 0.5 }
  const result = selectVisibleBlockFace({ eye, target, world: f.world })
  assert.equal(result.distance, 4.5)
  assert.equal(result.face, 4)
  assert.equal(selectVisibleBlockFace({ eye: { ...eye, x: 0.499 }, target, world: f.world }), null)
})

test('unknown cells, opaque blockers and secondary liquids cannot be crossed, while planned prior removals are explicit', () => {
  const f = fixture()
  const eye = { x: 0.5, y: 65.5, z: 0.5 }
  const target = { x: 3, y: 65, z: 0 }
  const between = { x: 1, y: 65, z: 0 }
  f.set(target, 'stone')
  f.blocks.set(f.key(between), { known: false })
  assert.equal(selectVisibleBlockFace({ eye, target, world: f.world }), null)
  f.set(between, 'stone')
  assert.equal(selectVisibleBlockFace({ eye, target, world: f.world }), null)
  assert.ok(selectVisibleBlockFace({ eye, target, world: f.world, removed: new Set([f.key(between)]) }))
  f.set(between, 'air', [{ name: 'minecraft:water' }])
  assert.equal(selectVisibleBlockFace({ eye, target, world: f.world }), null)
  f.set(between, 'short_grass')
  assert.equal(selectVisibleBlockFace({ eye, target, world: f.world }), null, 'selection collision remains conservative for non-air plants')
})

test('only a known empty-box torch is transparent to a block ray and does not become an air or full-cube target', () => {
  const f = fixture()
  const eye = { x: 0.5, y: 65.5, z: 0.5 }
  const target = { x: 3, y: 65, z: 0 }
  const between = { x: 1, y: 65, z: 0 }
  f.set(target, 'stone')
  const torch = { known: true, name: 'minecraft:torch', boundingBox: 'empty', properties: { torch_facing_direction: 'top' }, extra: [] }
  f.blocks.set(f.key(between), torch)
  const aimed = selectVisibleBlockFace({ eye, target, world: f.world })
  assert.ok(aimed)
  assert.equal(aimed.face, 4)
  assert.ok(traceBlockFace({ eye, target, world: f.world, point: aimed.point }))
  assert.equal(selectVisibleBlockFace({ eye, target: between, world: f.world }), null, 'a torch is not a full cube with invented block faces')
  assert.equal(f.world.getBlock(1, 65, 0).name, 'minecraft:torch')
  for (const change of [{ known: false }, { boundingBox: 'block' }, { extra: [{ name: 'minecraft:water' }] }, { name: 'minecraft:redstone_torch' }, { name: 'custom:torch' }]) {
    f.blocks.set(f.key(between), { ...torch, ...change })
    assert.equal(selectVisibleBlockFace({ eye, target, world: f.world }), null, JSON.stringify(change))
  }
})

test('edge rays cannot clip past a solid side cell and an enclosed target has no visible face', () => {
  const f = fixture()
  const target = { x: 2, y: 65, z: 2 }
  f.set(target, 'stone')
  f.set({ x: 1, y: 65, z: 0 }, 'stone')
  assert.equal(traceBlockFace({ eye: { x: 0.5, y: 65.5, z: 0.5 }, target, world: f.world, point: { x: 2.5, y: 65.5, z: 2.5 } }), null)
  const enclosed = fixture()
  const block = { x: 0, y: 65, z: 0 }
  enclosed.set(block, 'stone')
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) enclosed.set({ x, y: block.y + y, z }, 'stone')
  assert.equal(selectVisibleBlockFace({ eye: { x: -2, y: 67.5, z: 0.5 }, target: block, world: enclosed.world }), null)
  assert.throws(() => selectVisibleBlockFace({ eye: { x: NaN, y: 0, z: 0 }, target: block, world: enclosed.world }))
})

function miningFixture () {
  const f = fixture()
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, heldItem: { name: 'minecraft:iron_pickaxe' }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1 }] } }
  f.set({ x: 0, y: 64, z: 0 }, 'stone')
  const actions = []
  const looks = []
  let running = false
  const input = { lookAt: point => looks.push({ ...point }), start: () => { running = true }, stop: () => { running = false }, sendAction: (...args) => actions.push(args), stats: () => ({ running }) }
  const mining = createMining({ getState: () => state, world: f.world, getInput: () => input })
  return { ...f, state, mining, actions, looks }
}

test('mining sends the proven visible face and aim point for a lower stair cell while keeping foot and hazard guards', async t => {
  const f = miningFixture()
  t.after(() => f.mining.stop())
  const target = { x: 1, y: 65, z: 0 }
  f.set(target, 'stone')
  f.set({ x: 1, y: 66, z: 0 }, 'stone')
  const preview = f.mining.preview([target])
  assert.equal(preview.ready, true)
  assert.equal(preview.targets[0].aim.face, 4)
  f.mining.start([target])
  assert.deepEqual(f.looks[0], preview.targets[0].aim.point)
  assert.deepEqual(f.actions[0], ['start_break', target, 4, { hitPoint: preview.targets[0].aim.hit }])
  f.set(target, 'air')
  await delay(125)
  assert.equal(f.mining.snapshot().phase, 'completed')
  assert.equal(f.mining.preview([{ x: 0, y: 64, z: 0 }]).ready, false)
  f.set(target, 'stone')
  f.set({ x: 2, y: 65, z: 0 }, 'lava')
  assert.equal(f.mining.preview([target]).ready, false)
})

test('active mining stops when its exact chosen ray becomes blocked instead of silently using another face', async t => {
  const f = miningFixture()
  t.after(() => f.mining.stop())
  const target = { x: 2, y: 65, z: 0 }
  f.set(target, 'iron_ore')
  assert.equal(f.mining.preview([target]).ready, true)
  f.mining.start([target])
  f.set({ x: 1, y: 66, z: 0 }, 'stone')
  f.set({ x: 1, y: 65, z: 0 }, 'stone')
  await delay(125)
  assert.equal(f.mining.snapshot().phase, 'failed')
  assert.equal(f.mining.snapshot().completed.length, 0)
})

test('one-cell descent retains the player floor and exposes the lower top face only after the cell above is clear', () => {
  const f = miningFixture()
  const lower = { x: 1, y: 64, z: 0 }
  const above = { x: 1, y: 65, z: 0 }
  f.set(lower, 'stone')
  f.set(above, 'stone')
  assert.equal(f.mining.preview([lower]).ready, false, 'the current support and uncleared upper cell cover every ray')
  f.set(above, 'air')
  const after = f.mining.preview([lower])
  assert.equal(after.ready, true)
  assert.equal(after.targets[0].aim.face, 1)
  assert.ok(after.targets[0].aim.hit.x > 1)
  assert.equal(f.mining.preview([{ x: 0, y: 64, z: 0 }]).ready, false)
  f.blocks.set('2,64,0', { known: false })
  assert.equal(f.mining.preview([lower]).ready, false, 'a visible face never bypasses unknown adjacency')
  f.blocks.delete('2,64,0')
  f.state.health = NaN
  assert.equal(f.mining.preview([lower]).ready, false)
})
