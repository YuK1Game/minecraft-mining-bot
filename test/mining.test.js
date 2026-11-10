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

test('quarry tools may make the final safe use at remaining two but never start with the last one', () => {
  const f = fixture()
  f.set(f.target, 'stone')
  f.state.selectedSlot = 0
  f.state.heldItem = { name: 'minecraft:diamond_pickaxe', durabilityKnown: true, durabilityRemaining: 2 }
  const target = { ...f.target, accessPreparation: 'quarry', expectedName: 'minecraft:stone', requiredTool: { kind: 'pickaxe', tier: 1, reserve: 1 } }
  assert.equal(f.mining.preview([target]).ready, true)
  f.state.heldItem.durabilityRemaining = 1
  assert.equal(f.mining.preview([target]).ready, false)
  f.state.heldItem.durabilityRemaining = 2
  f.state.heldItem.durabilityKnown = false
  assert.equal(f.mining.preview([target]).ready, false)
  assert.equal(f.actions.length, 0)
})

test('a late received last-durability update stops an active quarry break before another use', async () => {
  const f = fixture()
  f.set(f.target, 'stone')
  f.state.selectedSlot = 0
  f.state.heldItem = { name: 'minecraft:diamond_pickaxe', durabilityKnown: true, durabilityRemaining: 2 }
  const target = { ...f.target, accessPreparation: 'quarry', expectedName: 'minecraft:stone', requiredTool: { kind: 'pickaxe', tier: 1, reserve: 1 } }
  f.mining.start([target])
  f.state.heldItem.durabilityRemaining = 1
  await setTimeout(150)
  assert.equal(f.mining.snapshot().phase, 'failed')
  assert.equal(f.mining.snapshot().reason, 'TOOL_DURABILITY_RESERVE')
  assert.equal(f.actions.filter(action => action[0] === 'start_break').length, 1)
  assert.equal(f.actions.filter(action => action[0] === 'finish_break').length, 0)
})

function fluidRoofFixture () {
  const f = fixture(), roof = { x: 1, y: 64, z: 0 }, source = { x: 1, y: 63, z: 0 }
  f.blocks.delete(f.id(f.target))
  f.set(roof, 'deepslate', 143)
  Object.assign(f.blocks.get(f.id(roof)), { boundingBox: 'block', diggable: true, properties: {} })
  Object.assign(f.blocks.get('0,64,0'), { boundingBox: 'block', diggable: true })
  f.set(source, 'lava', 222)
  Object.assign(f.blocks.get(f.id(source)), { boundingBox: 'empty', diggable: false, properties: { liquid_depth: 0 } })
  Object.assign(f.state, { profile: 'test', realm: { id: 'realm' }, connectionId: 'connection', startedAt: '2026-11-05T00:00:00.000Z', runtimeEntityId: '1', lifecycle: { deathId: 1 }, maxHealth: 20, selectedSlot: 0, heldItem: { name: 'minecraft:diamond_pickaxe', durabilityKnown: true, durabilityRemaining: 10 } })
  const request = { ...roof, accessPreparation: 'quarry_fluid_roof', expectedName: 'minecraft:deepslate', expectedRuntimeId: 143, requiredTool: { kind: 'pickaxe', tier: 1, reserve: 1 }, fluidSource: { position: source, expectedName: 'minecraft:lava', expectedRuntimeId: 222 } }
  return { ...f, roof, source, request }
}

test('the single fluid-roof primitive permits only its exact below-source exception; ordinary quarry still refuses it', () => {
  const f = fluidRoofFixture()
  assert.equal(f.mining.preview([f.request]).ready, true)
  assert.equal(f.mining.preview([{ ...f.request, accessPreparation: 'quarry' }]).ready, false)
  assert.equal(f.mining.preview([f.roof]).ready, false)
  assert.equal(f.actions.length, 0)
})

test('fluid-roof payload cannot batch, mine gravity caps, omit reserve or point at a different fluid/source', () => {
  const f = fluidRoofFixture()
  for (const change of [
    r => { r.fluidSource.position.y-- }, r => { r.fluidSource.position.x++ },
    r => { r.fluidSource.expectedName = 'minecraft:bubble_column' },
    r => { r.fluidSource.expectedRuntimeId = -1 }, r => { r.fluidSource.expectedRuntimeId = 4294967296 },
    r => { r.expectedName = 'minecraft:gravel' }, r => { r.expectedName = 'minecraft:chest' },
    r => { r.requiredTool.reserve = 0 }, r => { delete r.requiredTool.reserve },
    r => { r.requiredTool.kind = 'axe' }, r => { r.requiredTool.tier = 0 }
  ]) {
    const request = structuredClone(f.request); change(request)
    assert.throws(() => f.mining.preview([request]))
  }
  assert.throws(() => f.mining.start([f.request, { x: 2, y: 65, z: 0 }]), /one non-gravity roof/)
  assert.equal(f.actions.length, 0)
})

test('water roofs use the same exact-source dry-neighbour and tool-reserve gates as lava', () => {
  const f = fluidRoofFixture()
  f.blocks.get(f.id(f.source)).name = 'minecraft:water'
  f.request.fluidSource.expectedName = 'minecraft:water'
  assert.equal(f.mining.preview([f.request]).ready, true)
  f.blocks.get(f.id(f.source)).properties.liquid_depth = 1
  assert.equal(f.mining.preview([f.request]).ready, false)
  assert.equal(f.actions.length, 0)
})

test('fluid-roof preview refuses changed/unknown sources, extra fluid layers and another wet face', () => {
  for (const change of [
    f => { f.blocks.set(f.id(f.source), { known: false }) },
    f => { f.blocks.get(f.id(f.source)).runtimeId++ },
    f => { f.blocks.get(f.id(f.source)).name = 'minecraft:flowing_lava' },
    f => { f.blocks.get(f.id(f.source)).properties.liquid_depth = 2 },
    f => { f.blocks.get(f.id(f.source)).extra = [{ name: 'minecraft:water' }] },
    f => { f.blocks.get(f.id(f.roof)).extra = [{ name: 'minecraft:water' }] },
    f => { f.set({ ...f.roof, x: f.roof.x + 1 }, 'water') },
    f => { f.set({ ...f.roof, y: f.roof.y + 1 }, 'lava') },
    f => { f.blocks.set(f.id({ ...f.roof, x: f.roof.x + 1 }), { known: false }) }
  ]) {
    const f = fluidRoofFixture(); change(f)
    assert.equal(f.mining.preview([f.request]).ready, false)
    assert.equal(f.actions.length, 0)
  }
})

test('fluid-roof requires 70% health, a separate elevated dry body, full floor and actual reserved tool', () => {
  for (const change of [
    f => { f.state.health = 13.99 }, f => { f.state.maxHealth = 40; f.state.health = 27 },
    f => { f.state.position.x = 1.5 }, f => { f.state.position.y -= 1 },
    f => { f.blocks.set('0,65,0', { known: false }) }, f => { f.set({ x: 0, y: 66, z: 0 }, 'water') },
    f => { f.blocks.get('0,64,0').boundingBox = 'empty' }, f => { f.set({ x: 0, y: 64, z: 0 }, 'magma') },
    f => { f.blocks.get(f.id(f.roof)).protected = true }, f => { f.blocks.get(f.id(f.roof)).diggable = false },
    f => { f.state.inventory.uncertain = true }, f => { f.state.heldItem.name = 'minecraft:diamond_axe' },
    f => { f.state.heldItem.durabilityRemaining = 1 }, f => { f.state.heldItem.durabilityKnown = false },
    f => { delete f.state.lifecycle }
  ]) {
    const f = fluidRoofFixture(); change(f)
    assert.equal(f.mining.preview([f.request]).ready, false)
    assert.equal(f.actions.length, 0)
  }
  const exact = fluidRoofFixture(); exact.state.health = 14
  assert.equal(exact.mining.preview([exact.request]).ready, true)
})

test('fluid-roof completes only from received air while preserving the safe final tool use', async t => {
  const f = fluidRoofFixture(); t.after(() => f.mining.stop())
  f.state.heldItem.durabilityRemaining = 2
  const started = f.mining.start([f.request])
  assert.equal(started.operation, 'quarry_fluid_roof')
  assert.equal(started.serverConfirmed, false)
  f.mining.applyPacket('update_block', { position: f.roof })
  await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.equal(f.mining.snapshot().completed.length, 0)
  f.set(f.roof, 'air', 0)
  f.state.heldItem.durabilityRemaining = 1
  f.mining.applyPacket('update_block', { position: f.roof })
  await Promise.resolve()
  const result = f.mining.snapshot()
  assert.equal(result.phase, 'completed', JSON.stringify(result))
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.confirmedBy, 'received_block_air')
  assert.equal(result.completed.length, 1)
  assert.equal(f.actions.filter(a => a[0] === 'start_break').length, 1)
})

test('a changed source wakes and aborts a fluid-roof break immediately without waiting for the watchdog', async t => {
  const f = fluidRoofFixture(); t.after(() => f.mining.stop())
  f.mining.start([f.request])
  f.blocks.get(f.id(f.source)).properties.liquid_depth = 2
  f.mining.applyPacket('update_block', { position: f.source })
  await Promise.resolve()
  const result = f.mining.snapshot()
  assert.equal(result.phase, 'failed')
  assert.match(result.reason, /source changed/)
  assert.equal(result.completed.length, 0)
})

test('received roof air cannot hide a new wet face, source replacement, protection, life or unsafe health', async () => {
  for (const change of [
    f => { f.blocks.get(f.id(f.source)).runtimeId++ },
    f => { f.set({ ...f.roof, z: 1 }, 'water') },
    f => { f.state.health = 13 }, f => { f.state.lifecycle.deathId++ },
    f => { f.blocks.get(f.id(f.roof)).protected = true }
  ]) {
    const f = fluidRoofFixture()
    f.mining.start([f.request]); f.set(f.roof, 'air', 0); change(f)
    f.mining.applyPacket('update_block', { position: f.roof })
    await Promise.resolve()
    assert.equal(f.mining.snapshot().phase, 'failed')
    assert.equal(f.mining.snapshot().completed.length, 0)
    f.mining.stop()
  }
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

test('a full bag refuses mining unless a plain quarry target allows it (storage exhausted, passive)', () => {
  const f = fixture()
  f.state.inventory.items = Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'minecraft:cobblestone', count: 64 }))
  const quarry = { ...f.target, accessPreparation: 'quarry', expectedName: 'minecraft:dirt', expectedRuntimeId: 1, requiredTool: null }
  assert.equal(f.mining.preview([f.target]).ready, false)
  assert.equal(f.mining.preview([quarry]).ready, false, 'a quarry target still needs room by default')
  assert.equal(f.mining.preview([{ ...quarry, allowFullInventory: true }]).ready, true)
  assert.equal(f.mining.preview([{ ...f.target, allowFullInventory: true }]).ready, false, 'only quarry targets may mine with a full bag')
})
