'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateThreats } = require('../src/combat/threats')

const state = { position: { x: 0, y: 64, z: 0 }, health: 20, dimension: 'overworld' }
const creeper = updatedAt => ({ runtimeId: '7', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 5, y: 64, z: 0 }, ...(updatedAt === undefined ? {} : { updatedAt }) })
const ago = ms => new Date(Date.now() - ms).toISOString()

test('a hostile record with nothing received for more than five minutes is a leftover, not a threat', () => {
  const stale = evaluateThreats(state, [creeper(ago(6 * 60 * 1000))])
  assert.equal(stale.threats.length, 0)
  assert.equal(stale.unknownPositions.length, 0)
  assert.equal(stale.ignored.find(entry => entry.runtimeId === '7')?.reason, 'stale')
})

test('a recently heard hostile, and one without a receive time, stay threats', () => {
  assert.equal(evaluateThreats(state, [creeper(ago(4 * 60 * 1000))]).threats.length, 1)
  assert.equal(evaluateThreats(state, [creeper()]).threats.length, 1)
  assert.equal(evaluateThreats(state, [creeper('not a time')]).threats.length, 1)
})
