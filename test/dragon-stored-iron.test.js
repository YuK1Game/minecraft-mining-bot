'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { storedIron, nextStoredIron, markStoredIron } = require('../src/modes/dragon-stored-iron')

const origin = { x: 9876, y: 65, z: 10136 }
const memory = () => ({ seen: new Map([
  ['9882,65,10141', [{ slot: 0, name: 'minecraft:raw_iron', count: 8 }, { slot: 1, name: 'minecraft:iron_ingot', count: 3 }]],
  ['9976,16,10047', [{ slot: 0, name: 'minecraft:raw_iron', count: 40 }]]
]) })

test('live 2026-11-28 23:23 JST: the house chest raw iron and ingots are found, the far mine room is not', () => {
  const found = storedIron({ playerChestMemory: memory() }, origin)
  assert.deepEqual(found.map(entry => [entry.name, entry.count]), [['minecraft:iron_ingot', 3], ['minecraft:raw_iron', 8]])
})

test('a chest that gave nothing rests, one that gave something is taken from again', () => {
  const shared = { playerChestMemory: memory() }
  let bag = 0
  const held = () => bag
  const look = now => { const entry = nextStoredIron(shared, origin, held, now); if (entry) markStoredIron(shared, entry, held, now); return entry }
  // Walking there is no look: the same chest stays next.
  assert.equal(nextStoredIron(shared, origin, held, 500).name, 'minecraft:iron_ingot')
  assert.equal(look(1000).name, 'minecraft:iron_ingot')
  // Nothing came: the ingots rest, the raw iron is next.
  assert.equal(look(2000).name, 'minecraft:raw_iron')
  assert.equal(look(3000), null)
  bag = 3
  assert.equal(look(4000).name, 'minecraft:iron_ingot')
})
