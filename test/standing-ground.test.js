'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { STANDING_GROUND } = require('../src/common/standing-ground')
const { knownStandpoints } = require('../src/survival/exploration')

// The stair of 2026-11-16 05:00 JST: every floor cell around the Bot was coal ore.
test('a floor of ore is ground to stand on', () => {
  assert.ok(STANDING_GROUND.includes('coal_ore') && STANDING_GROUND.includes('deepslate_diamond_ore') && STANDING_GROUND.includes('stone'))
  const blocks = []
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    blocks.push({ known: true, name: 'minecraft:coal_ore', boundingBox: 'block', position: { x, y: 60, z } })
    for (const y of [61, 62]) blocks.push({ known: true, name: 'minecraft:air', boundingBox: 'empty', position: { x, y, z } })
    blocks.push({ known: true, name: 'minecraft:stone', boundingBox: 'block', position: { x, y: 63, z } })
  }
  const found = knownStandpoints({ position: { x: 0.5, y: 62.62, z: 0.5 } }, { blocks }, { maxDistance: 4 })
  assert.ok(found.length > 0)
})

test('a block may be placed on an ore floor, not on gravel', () => {
  const { placementSupportOk } = require('../src/quarry/storage/storage-site-terrain')
  assert.equal(placementSupportOk({ known: true, name: 'minecraft:coal_ore', boundingBox: 'block' }), true)
  assert.equal(placementSupportOk({ known: true, name: 'minecraft:stone', boundingBox: 'block' }), true)
  assert.equal(placementSupportOk({ known: true, name: 'minecraft:gravel', boundingBox: 'block' }), false)
  assert.equal(placementSupportOk({ known: false, name: 'minecraft:coal_ore', boundingBox: 'block' }), false)
})
