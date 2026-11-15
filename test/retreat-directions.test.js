'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { rankRetreatTargets } = require('../src/survival/exploration')

// A flat grass field with leaf litter on it, the Bot at the origin and a
// creeper eight blocks to the north (real Realm 2026-11-15).
function field () {
  const blocks = []
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) {
    blocks.push({ known: true, name: 'minecraft:grass_block', boundingBox: 'block', position: { x, y: 68, z }, extra: [] })
    blocks.push({ known: true, name: 'minecraft:leaf_litter', boundingBox: 'empty', position: { x, y: 69, z }, extra: [] })
    blocks.push({ known: true, name: 'minecraft:air', boundingBox: 'empty', position: { x, y: 70, z }, extra: [] })
  }
  return { state: { position: { x: 0.5, y: 70.62, z: 0.5 } }, observations: { blocks }, threats: [{ hostile: true, alive: true, position: { x: -1.7, y: 69, z: -7.3 } }] }
}

test('retreat candidates cover the sides as well as straight away, the best direction first', () => {
  const f = field()
  const targets = rankRetreatTargets(f.state, f.observations, f.threats, { limit: 20 })
  assert.equal(targets.length, 20)
  assert.ok(targets[0].position.z > 3, 'the first one is still straight away from the creeper')
  const bearings = new Set(targets.map(target => Math.round(Math.atan2(target.position.z - 0.5, target.position.x - 0.5) / (Math.PI / 6))))
  assert.ok(bearings.size >= 5, `directions tried: ${[...bearings].join(',')}`)
  assert.ok(targets.some(target => target.position.x < -3 && Math.abs(target.position.z - 0.5) < 5), 'west side offered')
  assert.ok(targets.every(target => target.threatDistanceGain >= 0.5))
})
