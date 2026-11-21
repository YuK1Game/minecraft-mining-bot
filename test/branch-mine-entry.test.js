'use strict'

// The real expedition owner, supplies and mining entry. Only the server's terrain request is a stand-in:
// unknown ground stays unknown. The former entry left the house for an arbitrary ore-search heading instead.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorld, PICK } = require('./helpers/dragon-goal-world')

test('the expedition asks the planned mine to observe unknown terrain before acquiring iron', async t => {
  const observed = [], trips = [], digs = []
  const unknown = () => ({ known: false })
  const w = await createWorld(t, {
    items: [PICK], getBlock: unknown,
    step: ctx => ctx.supplies.acquire('raw_iron', 4),
    ports: () => ({ getBlock: unknown,
      travelTo: async input => { trips.push(input); return false },
      hands: { block: unknown, canMine: () => false, mine: async at => { digs.push(at); return false } },
      minePorts: { observe: async cells => { observed.push(cells); return { status: 'blocked', code: 'TERRAIN_UNKNOWN' } } }
    })
  })
  w.raw.runtimeEntityId = '1'
  await w.pass(2000, { tickMs: 2000 })
  assert.equal(trips.length, 0, 'an ore shortage does not start the old arbitrary search trip')
  assert.equal(digs.length, 0, 'unknown terrain is not excavated')
  assert.ok(observed.length > 0, 'the actual mining controller requested the missing terrain')
  assert.equal(w.raw.inventory.items.some(row => row.name === 'minecraft:raw_iron'), false)
})
