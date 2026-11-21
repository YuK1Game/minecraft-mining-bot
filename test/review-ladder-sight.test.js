'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMining } = require('../src/actions/mining')
const { createInteractions } = require('../src/actions/interactions')
const { ladderRayClear, bottomSlabRayClear } = require('../src/common/ladder-shape')

function fixture () {
  const block = (name, properties = {}) => ({ known: true, name: 'minecraft:' + name, properties, runtimeId: 1, extra: [], boundingBox: name === 'air' ? 'empty' : 'block' })
  const blocks = new Map()
  for (const y of [65, 66]) blocks.set(`0,${y},0`, block('ladder', { facing_direction: 2 }))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? block(y < 65 ? 'dirt' : z === 1 ? 'stone' : 'air') }
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', runtimeEntityId: '1', health: 20, position: { x: 0.5, y: 66.62, z: -0.5 }, inventory: { known: true, items: [] } }
  let running = false, transaction
  const input = { lookAt () {}, start: () => { running = true }, stop: () => { running = false }, sendAction () {}, stats: () => ({ running, target: null }), sendTransaction: (value, callbacks) => { transaction = { value, callbacks } } }
  const mining = createMining({ getState: () => state, world, getInput: () => input })
  const raw = { network_id: 1, count: 8, metadata: 0, has_stack_id: true, stack_id: 8 }
  const crafting = { rawItem: () => ({ ...raw }), applyPacket () {}, snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [{ slot: 0, name: 'minecraft:ladder', count: raw.count, stackId: 8 }] }) }
  const interactions = createInteractions({ client: { queue () {} }, getState: () => state, world, crafting, getInput: () => input })
  return { block, blocks, world, state, mining, interactions, raw, sent: () => transaction.callbacks.onSent() }
}

test('actual mining can clear the next shaft floor in front of received rung plates, then requires AIR', async t => {
  const f = fixture(), target = { x: 0, y: 64, z: 0 }; t.after(() => f.mining.stop())
  const preview = f.mining.preview([target])
  assert.equal(preview.ready, true, JSON.stringify(preview))
  f.mining.start([target])
  assert.equal(f.mining.snapshot().phase, 'mining')
  f.blocks.set('0,64,0', f.block('air')); f.mining.applyPacket('update_block', { position: target })
  await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'completed')
})

test('actual mining from solid footing within a rung can clear the neighbouring work floor', () => {
  const f = fixture(); f.state.position.z = 0.5
  const preview = f.mining.preview([{ x: 1, y: 64, z: 0 }])
  assert.equal(preview.ready, true, JSON.stringify(preview))
  f.blocks.set('0,66,1', { known: false })
  assert.equal(f.mining.preview([{ x: 1, y: 64, z: 0 }]).ready, false, 'unknown backing does not authorize a transparent origin cell')
})

test('actual next-rung placement uses the front work platform; the side platform remains occluded', async () => {
  const f = fixture(), target = { x: 0, y: 64, z: 0 }
  f.blocks.set('0,64,0', f.block('air'))
  const options = { position: target, clicked: { x: 0, y: 64, z: 1 }, face: 2, slot: 0, clickY: 0.5 }
  assert.equal(f.interactions.previewHouseBlock(options).ready, true)
  f.state.position = { x: 1.5, y: 66.62, z: 0.5 }
  assert.equal(f.interactions.previewHouseBlock(options).ready, false, 'the real plate or the own floor blocks this view')
  f.state.position = { x: 0.5, y: 66.62, z: -0.5 }
  const pending = f.interactions.placeHouseBlock(options)
  f.sent(); f.blocks.set('0,64,0', f.block('ladder', { facing_direction: 2 })); f.raw.count--
  f.interactions.applyPacket('update_block', { position: target })
  const result = await pending
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
})

test('a plate hit, missing direction, unknown backing and fluid secondary layer keep ladder rays blocked', () => {
  const f = fixture(), point = { x: 0, y: 65, z: 0 }, rung = f.world.getBlock(0, 65, 0), read = p => f.world.getBlock(p.x, p.y, p.z)
  const clear = b => ladderRayClear(b, point, { x: -0.5, y: 65.5, z: 0.5 }, { x: 1.5, y: 65.5, z: 0.5 }, read)
  assert.equal(clear(rung), true)
  assert.equal(ladderRayClear(rung, point, { x: 0.5, y: 65.5, z: -0.5 }, { x: 0.5, y: 65.5, z: 1.5 }, read), false)
  assert.equal(clear({ ...rung, properties: {} }), false)
  assert.equal(clear({ ...rung, properties: { facing_direction: '2' } }), false)
  assert.equal(clear({ ...rung, extra: [f.block('water', { liquid_depth: 0 })] }), false)
  f.blocks.set('0,65,1', { known: false })
  assert.equal(clear(rung), false)
})

test('the permanent half slab landing can dig and place one-and-a-half and two-and-a-half blocks below it', () => {
  for (const y of [63, 62]) {
    const f = fixture(), target = { x: 0, y, z: 0 }
    f.blocks.set('0,64,-1', f.block('cobblestone_slab', { 'minecraft:vertical_half': 'bottom' }))
    f.state.position = { x: 0.5, y: 66.12, z: -0.5 }
    for (let rung = y + 1; rung <= 66; rung++) f.blocks.set(`0,${rung},0`, f.block('ladder', { facing_direction: 2 }))
    const dig = f.mining.preview([target])
    assert.equal(dig.ready, true, JSON.stringify({ y, dig }))
    f.blocks.set(`0,${y},0`, f.block('air'))
    const place = f.interactions.previewHouseBlock({ position: target, clicked: { x: 0, y, z: 1 }, face: 2, slot: 0, clickY: 0.5 })
    assert.equal(place.ready, true, JSON.stringify({ y, place }))
  }
})

test('half slab sight crosses only its received empty upper half', () => {
  const f = fixture(), block = f.block('cobblestone_slab', { 'minecraft:vertical_half': 'bottom' }), at = { x: 0, y: 64, z: 0 }
  const clear = (b, y) => bottomSlabRayClear(b, at, { x: -0.5, y, z: 0.5 }, { x: 1.5, y, z: 0.5 })
  assert.equal(clear(block, 64.75), true)
  assert.equal(clear(block, 64.25), false)
  assert.equal(clear(block, 64.5), false, 'a ray touching the real top remains blocked')
  assert.equal(clear({ ...block, properties: {} }, 64.75), false)
  assert.equal(clear({ ...block, properties: { 'minecraft:vertical_half': 'top' } }, 64.75), false)
  assert.equal(clear({ ...block, known: false }, 64.75), false)
})
