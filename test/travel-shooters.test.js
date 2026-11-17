'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { playerArmedAndWell } = require('../src/travel/travel-shooters')

const sword = [{ name: 'minecraft:diamond_sword' }]

test('in play, armed, healthy and unhit: shooters are left to combat (live 2026-11-17 21:02 JST)', () => {
  assert.equal(playerArmedAndWell({ shared: { playerWanted: true }, health: 19.3, items: sword, hurt: false }), true)
})

test('a hit, low health, no weapon or quarry mode keeps the retreat', () => {
  assert.equal(playerArmedAndWell({ shared: { playerWanted: true }, health: 19.3, items: sword, hurt: true }), false)
  assert.equal(playerArmedAndWell({ shared: { playerWanted: true }, health: 12, items: sword, hurt: false }), false)
  assert.equal(playerArmedAndWell({ shared: { playerWanted: true }, health: 20, items: [{ name: 'minecraft:bow' }], hurt: false }), false)
  assert.equal(playerArmedAndWell({ shared: {}, health: 20, items: sword, hurt: false }), false)
  assert.equal(playerArmedAndWell({ shared: { playerWanted: true }, health: undefined, items: sword, hurt: false }), false)
})
