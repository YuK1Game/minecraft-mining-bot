'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFailureMemory } = require('../src/modes/return/return-failures')

test('a forgotten failure starts its count again while other failures keep theirs', () => {
  const memory = createFailureMemory({ now: () => 1000 })
  const oven = { stage: 'reserve', target: '1,2,3', code: 'IRON_FURNACE_UNREAD' }
  const other = { stage: 'reserve', target: '4,5,6', code: 'IRON_FURNACE_UNREAD' }
  for (let i = 0; i < 3; i++) { memory.note(oven); memory.note(other) }
  assert.equal(memory.count(oven), 3)
  memory.forget(oven)
  assert.equal(memory.count(oven), 0)
  assert.equal(memory.count(other), 3)
})
