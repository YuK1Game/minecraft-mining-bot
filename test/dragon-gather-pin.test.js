'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { pinned, PIN_MS } = require('../src/modes/dragon-gather-pin')
const { home } = require('../src/modes/dragon-supply-kit')

test('a remembered kit item is kept only while the current kit could ask for it', () => {
  const now = 1000000
  assert.equal(pinned({ name: 'food', count: 16, since: now - 1000 }, home, now), true)
  assert.equal(pinned({ name: 'iron_pickaxe', count: 2, since: now }, home, now), true)
  // Saved by the old kit (32 food, held twice): the live record of 2026-11-19 16:34 JST.
  assert.equal(pinned({ name: 'food', count: 64 }, home, now), false)
  assert.equal(pinned({ name: 'food', count: 64, since: now }, home, now), false)
  assert.equal(pinned({ name: 'arrow', count: 1, since: now }, home, now), false)
  // No time on the record (saved before this rule), or too old: the chest is read again.
  assert.equal(pinned({ name: 'food', count: 8 }, home, now), false)
  assert.equal(pinned({ name: 'food', count: 8, since: now - PIN_MS }, home, now), false)
  assert.equal(pinned({ name: 'food', count: 8, since: now + 5000 }, home, now), false)
  assert.equal(pinned(null, home, now), false)
})
