'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { combatRetreatRuntime } = require('./helpers/combat-retreat-runtime')
const { createNavigator } = require('../src/movement/navigation')
const capture = require('./fixtures/navigation-water-float254.json')

function captured () {
  const blocks = new Map(capture.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const state = structuredClone(capture.state)
  const target = { runtimeId: '60', uniqueId: '-600', entityType: 'minecraft:creeper', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: state.position.x - 5.5, y: 63, z: state.position.z } }
  return { state, world, target, blocks }
}

test('combat immediately replaces idle protection and sends a real native shore-to-water retreat over captured terrain', async t => {
  const input = captured(), f = combatRetreatRuntime(t, input)
  const dry = createNavigator({ world: input.world, allowWater: false })
  assert.equal(dry.plan(dry.physics.fromServer(input.state), capture.target, { maxDistance: 2, maxExpanded: 64, exactGoal: true }).ready, false)
  assert.equal(f.navigator.plan(f.navigator.physics.fromServer(input.state), capture.target, { maxDistance: 2, maxExpanded: 64, exactGoal: true }).ready, true)
  const context = await f.acquire(), started = performance.now()
  let planningMs
  f.beforeStart(() => { planningMs = performance.now() - started })
  const result = await f.retreat(context)
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false, 'queued physics is never a server arrival')
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].options.allowWater, true)
  assert.equal(f.previews[0].allowWater, true, 'known shore water is tried before exhausting dry routes')
  assert.ok(f.packets.length > 3)
  assert.ok(f.packets.every(({ packet }) => packet.position.x >= input.state.position.x - 1e-4))
  assert.ok(f.state().position.x > input.state.position.x + 0.15)
  assert.equal(f.errors.length, 0)
  t.diagnostic(`capture planning through first proven start: ${planningMs.toFixed(1)} ms; native frames: ${f.packets.length}`)
})

function pond ({ bank = false } = {}) {
  const state = { phase: 'spawned', profile: 'test', realm: { id: '1' }, connectionId: 'test', startedAt: new Date().toISOString(), runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', health: 20,
    position: { x: 0.5, y: 64.2, z: 0.5 }, positionSource: 'server_move', positionUpdatedAt: Date.now(), rotation: { yaw: -90, pitch: 0 }, physicsState: { velocity: { x: 0, y: 0, z: 0 }, onGround: false, isInWater: true, isInLava: false } }
  const world = { getBlock(x, y, z) {
    if (Math.abs(x) > 9 || Math.abs(z) > 6 || y < 58 || y > 68) return { known: false }
    const solid = y < 60 || bank && x >= 1 && y < 63
    const water = !solid && y < 63
    return { known: true, name: solid ? 'minecraft:stone' : water ? 'minecraft:water' : 'minecraft:air', boundingBox: solid ? 'block' : 'empty', position: { x, y, z }, properties: water ? { liquid_depth: 0 } : {}, extra: [] }
  } }
  const target = { runtimeId: '60', uniqueId: '-600', entityType: 'minecraft:creeper', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: -5, y: 63, z: .5 } }
  return { state, world, target }
}

for (const bank of [false, true]) test(`combat retreat starts in water and reaches a native ${bank ? 'bank' : 'surface'} prediction`, async t => {
  const input = pond({ bank }), f = combatRetreatRuntime(t, input), context = await f.acquire()
  const result = await f.retreat(context)
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].options.allowWater, true)
  assert.ok(f.state().position.x > input.state.position.x + .15)
  if (bank) assert.equal(f.state().predicted.physicsState.onGround, true)
  else assert.equal(f.state().predicted.physicsState.isInWater, true)
})

for (const change of ['unknown', 'actor', 'owner']) test(`a ${change} change after the water plan refuses the first native input`, async t => {
  const input = captured(), f = combatRetreatRuntime(t, input), context = await f.acquire()
  f.beforeStart(() => {
    if (change === 'unknown') input.blocks.clear()
    if (change === 'actor') f.actor.position.x = input.state.position.x + 0.4
    if (change === 'owner') f.rt.userBehaviorLease = { kind: 'combat', claimId: 'replacement', token: {}, generation: f.rt.generationStream, ready: true }
  })
  await assert.rejects(f.retreat(context))
  assert.equal(f.packets.length, 0)
})
