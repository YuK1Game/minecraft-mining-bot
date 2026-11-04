'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')

function fixture () {
  const recorded = require('./fixtures/partial-creeper-recenter.json')
  const map = new Map(recorded.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, structuredClone(block)]))
  const navigator = createNavigator({ world: { getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false } } })
  const state = navigator.physics.fromServer({ position: recorded.position, health: recorded.health, gameMode: 'survival', predicted: { physicsState: { onGround: true } } })
  const enemy = recorded.enemies.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - recorded.position.x, actor.position.y - recorded.position.y, actor.position.z - recorded.position.z) < 8)
  const distance = Math.hypot(enemy.position.x - recorded.position.x, enemy.position.y - recorded.position.y, enemy.position.z - recorded.position.z)
  return { map, navigator, state, enemy, avoidance: [{ id: enemy.runtimeId, position: enemy.position, minDistance: distance, padding: 0 }], target: { x: 0.5, y: 71, z: 0.65 } }
}

test('partial recenter predicts a supported landing while not approaching the enemy', () => {
  const f = fixture()
  const route = f.navigator.plan(f.state, f.target, { partialRecenter: true, maxDistance: 2, avoidance: f.avoidance })
  assert.equal(route.ready, true, JSON.stringify(route))
  assert.equal(route.partialRecenter, true)
  assert.ok(route.predictedTrace.length > 2)
  assert.equal(route.serverConfirmed, false)
})

test('partial recenter refuses unknown support, an unsafe destination, or airborne origin', () => {
  for (const mode of ['unknown', 'hazard', 'airborne', 'toward']) {
    const f = fixture()
    if (mode === 'unknown') f.map.delete('0,70,0')
    if (mode === 'hazard') f.map.set('0,70,0', { known: true, name: 'minecraft:lava', boundingBox: 'empty', properties: {}, extra: [], position: { x: 0, y: 70, z: 0 } })
    if (mode === 'airborne') f.state.onGround = false
    if (mode === 'toward') f.target = { x: 0.65, y: 71, z: -0.35 }
    const route = f.navigator.plan(f.state, f.target, { partialRecenter: true, maxDistance: 2, avoidance: f.avoidance })
    assert.equal(route.ready, false, mode)
  }
})
