'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { surveyShore } = require('../src/shore-survey')

test('shore survey reports only observed dry floors and remains observation-only', async () => {
  const world = { getBlock: (x, y, z) => {
    if (x === 2 && z === 1 && y === 62) return { known: false }
    if (x === 3 && z === 0 && y === 62) return { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
    if (x === 1 && z === 0 && y === 62) return { known: true, name: 'minecraft:magma', boundingBox: 'block', extra: [] }
    if (y === 62) return { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
  } }
  const result = await surveyShore({ world, position: { x: 0.5, y: 64.62, z: 0.5 }, radius: 4 })
  assert.equal(result.observationOnly, true)
  assert.deepEqual(result.candidates.map(p => [p.x, p.y, p.z]), [[3.5, 63, 0.5]])
  assert.ok(result.unknownSamples > 0)
})

test('shore survey stops when its session changes', async () => {
  const world = { getBlock: () => ({ known: false }) }
  await assert.rejects(surveyShore({ world, position: { x: 0, y: 64, z: 0 }, radius: 10, valid: () => false }), /session changed/)
})

test('a swimmer can observe a raised bank, but unknown headroom remains unusable', async () => {
  const world = { getBlock: (x, y, z) => {
    if (z !== 0 || ![2, 3].includes(x)) return { known: false }
    if (y === 67) return { known: true, name: 'minecraft:grass_block', boundingBox: 'block', extra: [] }
    if (y === 68 || y === 69 && x === 2) return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
    return { known: false }
  } }
  const result = await surveyShore({ world, position: { x: 0.5, y: 63.94, z: 0.5 }, radius: 4 })
  assert.deepEqual(result.candidates.map(p => [p.x, p.y, p.z]), [[2.5, 68, 0.5]])
  assert.equal(result.observationOnly, true)
  assert.equal(result.ready, undefined)
  assert.equal(result.serverConfirmed, undefined)
})
