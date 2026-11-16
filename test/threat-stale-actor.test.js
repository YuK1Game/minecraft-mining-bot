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

test('a creeper or melee mob that has not moved for five minutes and is out of reach is not a threat; one step makes it one again', () => {
  const still = { ...creeper(ago(1000)), position: { x: 7.78, y: 64, z: 0 }, positionUpdatedAt: ago(51 * 60 * 1000) }
  const result = evaluateThreats(state, [still])
  assert.equal(result.threats.length, 0)
  assert.equal(result.unreachable[0]?.standingStill, true)
  assert.equal(evaluateThreats(state, [{ ...still, positionUpdatedAt: ago(60 * 1000) }]).threats.length, 1, 'moved a minute ago')
  assert.equal(evaluateThreats(state, [{ ...still, position: { x: 4, y: 64, z: 0 } }]).threats.length, 1, 'close enough to start its fuse')
  assert.equal(evaluateThreats(state, [{ ...still, primed: true }]).threats.length, 1, 'primed')
  assert.equal(evaluateThreats(state, [{ ...still, hurtAt: ago(30 * 1000) }]).threats.length, 1, 'just hurt')
  const skeleton = { ...still, runtimeId: '8', entityType: 'minecraft:skeleton' }
  assert.equal(evaluateThreats(state, [skeleton]).threats.length, 1, 'an archer within 8 m shoots without moving')
})

// Live 2026-11-17 02:16-02:31 JST: a skeleton 17.3 m away, unmoved for 15 minutes, held the work still.
test('an archer farther than 8 m that has not moved for ten minutes is not a threat', () => {
  const skeleton = moved => ({ runtimeId: '9', entityType: 'minecraft:skeleton', alive: true, positionKnown: true, position: { x: 17.3, y: 64, z: 0 }, updatedAt: ago(1000), positionUpdatedAt: ago(moved) })
  assert.equal(evaluateThreats(state, [skeleton(15 * 60 * 1000)]).threats.length, 0)
  assert.equal(evaluateThreats(state, [skeleton(15 * 60 * 1000)]).unreachable[0]?.standingStill, true)
  assert.equal(evaluateThreats(state, [skeleton(6 * 60 * 1000)]).threats.length, 1, 'six minutes is not enough for an archer')
})
