'use strict'
// Raw meat kept for the furnace (src/modes/raw-meat-keep.js).
// Live 2026-11-19 03:35-03:55 JST: every piece of raw meat the expedition hunted was eaten by the idle meal at
// hunger 15-17 before it reached the home furnace; cooked food stayed 0.
const test = require('node:test')
const assert = require('node:assert/strict')
const { snackItems, keeping } = require('../src/modes/raw-meat-keep')

const play = { playerWanted: true, botMode: 'player', playerHouse: { origin: { x: 0, y: 64, z: 0 } } }
const bag = [{ slot: 3, name: 'minecraft:beef', count: 1 }, { slot: 5, name: 'minecraft:carrot', count: 1 }, { slot: 6, name: 'minecraft:cooked_beef', count: 2 }]
const names = items => items.map(item => item.name)

test('as hunted at 03:51 JST (hunger 15, health 16.1): the raw beef is not a snack, other food is', () => {
  assert.deepEqual(names(snackItems(play, { hunger: 15, health: 16.1 }, bag)), ['minecraft:carrot', 'minecraft:cooked_beef'])
  assert.deepEqual(snackItems(play, { hunger: 15, health: 16.1 }, [bag[0]]), [])
})

test('hungry or hurt: the raw meat is eaten as before', () => {
  assert.equal(snackItems(play, { hunger: 9, health: 18 }, bag).length, 3)
  assert.equal(snackItems(play, { hunger: 15, health: 12 }, bag).length, 3)
  assert.equal(snackItems(play, { hunger: null, health: 18 }, bag).length, 3)
  assert.equal(snackItems(play, { hunger: 15, health: undefined }, bag).length, 3)
})

test('no house (no furnace to cook at), not playing, or the quarry mode: as before', () => {
  assert.equal(keeping({ ...play, playerHouse: null }, { hunger: 15, health: 18 }), false)
  assert.equal(keeping({ ...play, playerWanted: false }, { hunger: 15, health: 18 }), false)
  assert.equal(keeping({ ...play, botMode: 'quarry' }, { hunger: 15, health: 18 }), false)
  assert.equal(keeping(undefined, { hunger: 15, health: 18 }), false)
  assert.equal(keeping(play, { hunger: 15, health: 18 }), true)
})

test('the rule is wired into the eat operation; a runtime without the food module has nothing to wire', () => {
  const { wire } = require('../src/modes/raw-meat-keep')
  let rule = null
  assert.equal(wire(() => ({ setKeep: fn => { rule = fn } }), () => play), true)
  assert.equal(rule({ name: 'minecraft:mutton' }, { hunger: 17, health: 17 }), true)
  assert.equal(rule({ name: 'minecraft:cooked_mutton' }, { hunger: 17, health: 17 }), false)
  assert.equal(rule({ name: 'minecraft:mutton' }, { hunger: 17, health: 9.6 }), false)
  assert.equal(wire(() => { throw new ReferenceError('food is not defined') }, () => play), false)
})
