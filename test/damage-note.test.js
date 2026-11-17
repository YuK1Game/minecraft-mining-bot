'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { noteDamage } = require('../src/modes/damage-note')

test('a hit logs the body cells and the entities around it once per hit, at most every 5 s', () => {
  const shared = { travelLastDamageAt: 1000 }, lines = []
  const getBlock = (x, y, z) => ({ known: true, name: y === 9 ? 'minecraft:stone' : 'minecraft:air' })
  const actors = [
    { entityType: 'minecraft:skeleton', alive: true, position: { x: 20.5, y: 18, z: 0.5 } },
    { entityType: 'minecraft:arrow', alive: true, position: { x: 1.5, y: 11, z: 0.5 } },
    { entityType: 'minecraft:item', alive: true, position: { x: 0.5, y: 10, z: 0.5 } },
    { entityType: 'minecraft:zombie', alive: true, position: { x: 90, y: 10, z: 0 } }
  ]
  const input = now => ({ shared, health: 9.5, position: { x: 0.5, y: 11.62, z: 0.5 }, actors, getBlock, log: line => lines.push(line), now })
  const text = noteDamage(input(1000))
  assert.match(text, /足 \(0, 10, 0\)/)
  assert.match(text, /下 stone/)
  assert.match(text, /48m 以内 矢 1 本（最も近い 1\.4m）、skeleton 21\.5m\(\+8\.0\)/)
  assert.doesNotMatch(text, /zombie|item/)
  assert.equal(noteDamage(input(2000)), null) // same hit
  shared.travelLastDamageAt = 3000
  assert.equal(noteDamage(input(3000)), null) // within 5 s
  shared.travelLastDamageAt = 7000
  assert.ok(noteDamage(input(7000)))
  assert.equal(lines.length, 2)
  shared.travelLastDamageAt = 20000
  assert.match(noteDamage({ ...input(20000), why: () => '離れる no_threat・射線 bow' }), /、離れる no_threat・射線 bow$/)
})
