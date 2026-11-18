'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { playerArmedAndWell, tripKeepsCombatOffWitch } = require('../src/travel/travel-shooters')

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

test('on a trip, a witch is combat\'s once the player is armed in play (live 2026-11-18 11:47 JST)', () => {
  const witch = { entityType: 'minecraft:witch' }
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: true, target: witch, armedInPlay: true }), false, 'armed in play: combat takes it')
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: true, target: witch, armedInPlay: false }), true, 'no weapon, or not playing: the trip walks round it')
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: true, target: witch }), true, 'unknown counts as unarmed')
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: false, target: witch, armedInPlay: false }), false, 'no trip')
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: true, target: { entityType: 'minecraft:skeleton' }, armedInPlay: false }), false, 'only witches')
  assert.equal(tripKeepsCombatOffWitch({ travelBusy: true, target: { name: 'minecraft:witch' }, armedInPlay: false }), true)
})

test('the combat work guard asks that rule with the armed-in-play reading of the received inventory', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'quarry-runtime.js'), 'utf8')
  assert.match(source, /tripKeepsCombatOffWitch\(\{ travelBusy: rt\.travelRuntime\.longTravel\?\.status\?\.\(\)\.busy === true, target, armedInPlay: playerArmed\(state\) \}\)\) return \{ allowed: false, reason: 'TRAVEL_AVOID_WITCH' \}/)
  assert.doesNotMatch(source, /busy && \/witch\//, 'the unconditional rule is gone')
})
