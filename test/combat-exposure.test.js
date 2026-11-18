'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCombatExposure } = require('../src/combat/combat-exposure')

const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
function scene (solid) {
  const world = { getBlock: (x, y, z) => solid(x, y, z) ? stone : air, revision: () => 1 }
  const exposure = createCombatExposure({ world, entities: { motion: () => null }, scopeOf: () => 'scope' })
  const state = { phase: 'spawned', health: 20, dimension: 'overworld', runtimeEntityId: 1, position: { x: 0.5, y: 65.62, z: 0.5 } }
  const skeleton = { kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', runtimeId: 7, uniqueId: -7, position: { x: 9.5, y: 64, z: 0.5 } }
  return { exposure, state, skeleton }
}

test('an archer shooting over a one-block rise in front of it has attack sight', () => {
  // The block at the archer's feet level right in front of it hides its body
  // centre from the bot's eye, but not its eye.
  const { exposure, state, skeleton } = scene((x, y, z) => y < 64 || x === 8 && y === 64 && z === 0)
  const result = exposure.evaluate(skeleton, state)
  assert.equal(result.evidence.sight, true)
  assert.equal(result.intercept, true)
})

test('an archer behind a full wall has no attack sight', () => {
  const { exposure, state, skeleton } = scene((x, y, z) => y < 64 || x === 5 && y < 70)
  const result = exposure.evaluate(skeleton, state)
  assert.equal(result.evidence.sight, false)
  assert.equal(result.intercept, false)
})

test('one sight ray reads each sampled cell once and observes changes on its next call', () => {
  const blocks = new Map(), reads = []
  const world = { getBlock: (x, y, z) => { const key = `${x},${y},${z}`; reads.push(key); return blocks.get(key) ?? air } }
  const exposure = createCombatExposure({ world, entities: {}, scopeOf: () => 'scope' })
  const from = { x: 0.5, y: 65.62, z: 0.5 }, to = { x: 8.5, y: 65.62, z: 0.5 }
  assert.equal(exposure.sight(from, to), true)
  assert.ok(reads.length <= 9, `Eight-block ray did ${reads.length} terrain reads`)
  assert.equal(reads.length, new Set(reads).size)
  // A cache must not outlive this synchronous ray, even without a world revision.
  blocks.set('4,65,0', { known: false })
  assert.equal(exposure.sight(from, to), null)
  blocks.set('2,65,0', stone)
  assert.equal(exposure.sight(from, to), false)
  blocks.clear()
  assert.equal(exposure.sight(from, to), true)
})
