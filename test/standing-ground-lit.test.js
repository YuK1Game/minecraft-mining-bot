'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { STANDING_GROUND, isOreGround } = require('../src/common/standing-ground')

// Live 2026-11-17 01:50 JST: on glowing redstone ore every tunnel plan answered "Settle on known dry land".
test('glowing redstone ore is ground like the unlit ore', () => {
  assert.ok(STANDING_GROUND.includes('lit_deepslate_redstone_ore'))
  assert.ok(STANDING_GROUND.includes('lit_redstone_ore'))
  assert.ok(isOreGround('minecraft:lit_deepslate_redstone_ore'))
})
