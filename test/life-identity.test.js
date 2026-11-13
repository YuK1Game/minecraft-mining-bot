'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { currentLifeId } = require('../src/life-identity')

test('the Host counter of the current connection is the life', () => {
  assert.equal(currentLifeId({ hostLife: { connectionId: 'c2', deathId: 0 }, connectionId: 'c2', respawnRecord: { deathId: 3 } }), 0)
  assert.equal(currentLifeId({ hostLife: { connectionId: 'c2', deathId: 2 }, connectionId: 'c2', respawnRecord: null }), 2)
})
test('a counter from another connection or an older Host falls back to the respawn record', () => {
  assert.equal(currentLifeId({ hostLife: { connectionId: 'c1', deathId: 5 }, connectionId: 'c2', respawnRecord: { deathId: 3 } }), 3)
  assert.equal(currentLifeId({ hostLife: null, connectionId: 'c2', respawnRecord: { deathId: 3 } }), 3)
  assert.equal(currentLifeId({ hostLife: null, connectionId: 'c2', respawnRecord: null }), 0)
  assert.equal(currentLifeId({ hostLife: { connectionId: 'c2', deathId: -1 }, connectionId: 'c2' }), 0)
})
