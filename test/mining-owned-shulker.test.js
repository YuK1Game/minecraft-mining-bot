'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMining } = require('../src/mining')
const { SHULKER_BLOCKS } = require('../src/container-types')

function fixture (t, { verify = null } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-05T01:30:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, inventory: { known: true, items: [] }, selectedSlot: 0, heldItem: null }
  const target = { x: 1, y: 65, z: 0, accessPreparation: 'owned_shulker', expectedName: 'minecraft:undyed_shulker_box', ownershipKey: 'placed:current:1,65,0', expectedRuntimeId: 921 }
  const key = p => `${p.x},${p.y},${p.z}`, blocks = new Map(), actions = [], ownershipCalls = []
  const set = (p, name, runtimeId = 1) => blocks.set(key(p), { position: { x: p.x, y: p.y, z: p.z }, known: true, name: `minecraft:${name}`, runtimeId, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
  set({ x: 0, y: 64, z: 0 }, 'stone')
  set(target, 'undyed_shulker_box', 921)
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0, extra: [] } }
  let running = false, owned = true
  const input = { lookAt () {}, start () { running = true }, stop () { running = false }, sendAction: (...action) => actions.push(action), stats: () => ({ running }) }
  const verifyOwnedShulker = verify ?? ((s, point, block) => { ownershipCalls.push({ life: s.lifecycle?.deathId, target: structuredClone(point), block: structuredClone(block) }); return owned && point.ownershipKey === target.ownershipKey })
  const mining = createMining({ getState: () => state, world, getInput: () => input, verifyOwnedShulker })
  t.after(() => mining.stop('cleanup'))
  const notify = () => mining.applyPacket('update_block', { position: target, block_runtime_id: 0 })
  return { state, target, blocks, world, set, key, actions, mining, notify, ownershipCalls, revoke: () => { owned = false } }
}

test('only explicitly owned actual shulker blocks gain the retrieval exception; normal containers stay protected', t => {
  const f = fixture(t)
  for (const name of SHULKER_BLOCKS) {
    f.set(f.target, name.slice(10), 921)
    assert.equal(f.mining.preview([{ ...f.target, expectedName: name }]).ready, true, name)
    assert.equal(f.mining.preview([{ x: 1, y: 65, z: 0 }]).ready, false, 'ordinary mining never inherits the ownership exception')
  }
  for (const expectedName of ['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:shulker_box', 'minecraft:custom_shulker_box']) assert.throws(() => f.mining.preview([{ ...f.target, expectedName }]), /Owned-shulker/)
  for (const marker of [{ ownershipKey: '' }, { ownershipKey: 'x'.repeat(201) }, { expectedRuntimeId: -1 }, { expectedRuntimeId: 4294967296 }]) assert.throws(() => f.mining.preview([{ ...f.target, ...marker }]), /Owned-shulker/)
  f.set(f.target, 'undyed_shulker_box', 921)
  f.revoke()
  assert.equal(f.mining.preview([f.target]).ready, false)
  assert.deepEqual(f.actions, [])
})

test('owned shulker retrieval keeps support, reach, unknown terrain, hazard and inventory checks', t => {
  for (const mode of ['unknown', 'wrong_block', 'wrong_runtime', 'unknown_neighbour', 'lava', 'extra_water', 'support', 'foot', 'health', 'full', 'inventory', 'unknown_life']) {
    const f = fixture(t)
    if (mode === 'unknown') f.blocks.set(f.key(f.target), { known: false })
    if (mode === 'wrong_block') f.set(f.target, 'chest', 921)
    if (mode === 'wrong_runtime') f.set(f.target, 'undyed_shulker_box', 922)
    if (mode === 'unknown_neighbour') f.blocks.set('2,65,0', { known: false })
    if (mode === 'lava') f.set({ x: 2, y: 65, z: 0 }, 'lava')
    if (mode === 'extra_water') f.blocks.get(f.key(f.target)).extra = [{ known: true, name: 'minecraft:water' }]
    if (mode === 'support') f.blocks.set('0,64,0', { known: false })
    if (mode === 'foot') f.state.position = { x: 1.5, y: 67.62, z: 0.5 }
    if (mode === 'health') f.state.health = 0
    if (mode === 'full') f.state.inventory.items = Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'minecraft:dirt', count: 64 }))
    if (mode === 'inventory') f.state.inventory.uncertain = true
    if (mode === 'unknown_life') delete f.state.lifecycle
    assert.equal(f.mining.preview([f.target]).ready, false, mode)
    assert.deepEqual(f.actions, [], mode)
  }
})

test('an owned shulker becomes block-cleared only from received air and never becomes a recovered item', async t => {
  const f = fixture(t)
  f.mining.start([f.target])
  f.notify()
  await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.equal(f.mining.snapshot().serverConfirmed, false)
  f.set(f.target, 'air', 0)
  f.notify()
  await Promise.resolve()
  const result = f.mining.snapshot()
  assert.equal(result.phase, 'completed')
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.confirmedBy, 'received_block_air')
  assert.equal(result.blockCleared, true)
  assert.equal(result.collected, false)
  assert.deepEqual(f.state.inventory.items, [])
  assert.equal(f.ownershipCalls.at(-1).block.name, 'minecraft:air')
})

test('scope, life, revoked ownership or unknown inventory stop shulker mining even with simultaneous air', async t => {
  for (const mode of ['life', 'connection', 'profile', 'realm', 'self', 'started', 'death', 'spawn', 'inventory', 'revoked']) {
    const f = fixture(t)
    f.mining.start([f.target])
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'connection') f.state.connectionId = 'new'
    if (mode === 'profile') f.state.profile = 'new'
    if (mode === 'realm') f.state.realm.id = '99'
    if (mode === 'self') f.state.runtimeEntityId = '99'
    if (mode === 'started') f.state.startedAt = '2026-11-05T01:31:00.000Z'
    if (mode === 'death') f.state.health = 0
    if (mode === 'spawn') f.state.spawnPending = true
    if (mode === 'inventory') f.state.inventory.known = false
    if (mode === 'revoked') f.revoke()
    f.set(f.target, 'air', 0)
    f.notify()
    await Promise.resolve()
    assert.equal(f.mining.snapshot().phase, 'failed', mode)
    assert.equal(f.mining.snapshot().serverConfirmed, false, mode)
    assert.deepEqual(f.mining.snapshot().completed, [], mode)
  }
})

test('stopped shulker retrieval ignores delayed terrain observations and cannot confirm a replacement run', async t => {
  const f = fixture(t)
  f.mining.start([f.target])
  f.set(f.target, 'air', 0); f.notify()
  f.mining.stop('reload')
  f.set(f.target, 'undyed_shulker_box', 921)
  f.mining.start([f.target])
  f.set(f.target, 'air', 0)
  await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.equal(f.mining.snapshot().completed.length, 0)
  f.notify(); await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'completed')
})
