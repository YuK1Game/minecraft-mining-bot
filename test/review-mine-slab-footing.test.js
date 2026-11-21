'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMining } = require('../src/actions/mining')
const { createNavigator } = require('../src/movement/navigation')

function fixture () {
  const block = (name, properties = {}) => ({ known: true, name: 'minecraft:' + name, properties, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: 1, extra: [] })
  const slab = () => block('cobblestone_slab', { 'minecraft:vertical_half': 'bottom' })
  const blocks = new Map(), world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? (y === 64 ? slab() : block(y < 64 ? 'stone' : 'air')) }
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.12, z: 0.5 }, rotation: { pitch: 0, yaw: -90 }, health: 20, inventory: { known: true, items: [] }, selectedSlot: null, heldItem: null }
  const target = { x: 1, y: 65, z: 0 }
  blocks.set('1,65,0', block('dirt'))
  let running = false
  const input = { lookAt () {}, start: () => { running = true }, stop: () => { running = false }, sendAction () {}, stats: () => ({ running }) }
  const mining = createMining({ getState: () => state, world, getInput: () => input })
  return { block, slab, blocks, world, state, target, mining }
}

test('ordinary mining on a received lower slab starts and completes only on received AIR', async t => {
  const f = fixture(); t.after(() => f.mining.stop())
  const preview = f.mining.preview([f.target])
  assert.equal(preview.ready, true, JSON.stringify(preview))
  f.mining.start([f.target])
  assert.equal(f.mining.snapshot().phase, 'mining')
  f.blocks.set('1,65,0', f.block('air'))
  f.mining.applyPacket('update_block', { position: f.target })
  await Promise.resolve()
  assert.equal(f.mining.snapshot().phase, 'completed')
  assert.equal(f.mining.snapshot().completed.length, 1)
})

test('unknown/top/wet/partial-footprint slabs and airborne prediction never become solid footing', () => {
  for (const change of [
    f => f.blocks.set('0,64,0', { known: false }),
    f => f.blocks.set('0,64,0', f.block('cobblestone_slab', { 'minecraft:vertical_half': 'top' })),
    f => f.blocks.set('0,64,0', { ...f.slab(), extra: [f.block('water', { liquid_depth: 0 })] }),
    f => { f.state.position.x = 0.9; f.blocks.set('1,64,0', { known: false }) },
    f => { f.state.position.y += 0.2 },
    f => { f.state.predicted = { physicsState: { onGround: false, velocity: { x: 0, y: -0.0784, z: 0 } } } },
    f => { f.blocks.set('0,64,0', f.block('ladder', { facing_direction: 2 })) }
  ]) {
    const f = fixture(); change(f)
    assert.equal(f.mining.preview([f.target]).ready, false)
  }
  const f = fixture()
  assert.equal(f.mining.preview([{ x: 0, y: 64, z: 0 }]).ready, false, 'the slab under the player stays protected')
})

test('actual Navigator walks between half-height lower slabs with its existing support-shape checks', () => {
  const f = fixture(); f.blocks.delete('1,65,0')
  const nav = createNavigator({ world: f.world }), initial = nav.physics.fromServer(f.state)
  const route = nav.plan(initial, { x: 2.5, y: 64.5, z: 0.5 }, { maxDistance: 4 })
  assert.equal(route.ready, true, JSON.stringify(route))
  const stepper = nav.createStepper(route, initial)
  let frame
  for (let i = 0; i < 120; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.equal(frame.predictedState.onGround, true)
  assert.ok(Math.abs(frame.predictedState.position.y - 64.5) < 0.0001)
})
