'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateThreats } = require('../src/threats')
const { captureWorkActors, resolveWorkActors, workMargin } = require('../src/work-clearance')
const scene = policy => ({ profile: 'bot', realm: { id: '21225335' }, connectionId: 'online', startedAt: '2026-10-31T22:47:16.776Z', runtimeEntityId: '1', dimension: 'overworld', threatPolicy: policy, health: 20, position: { x: 0, y: 64, z: 0 }, entities: [{ runtimeId: '9', uniqueId: '90', entityType: 'minecraft:drowned', positionKnown: true, dimension: 'overworld', position: { x: 9, y: 64, z: 0 } }] })

test('learning keeps current danger but releases work once the actual alert radius clears', () => {
  const s = scene('online_learning')
  let value = evaluateThreats(s, s.entities)
  assert.equal(value.threats.length, 1)
  const records = captureWorkActors(s, value)
  assert.equal(records.length, 1)
  s.entities[0].position.x = 11
  value = evaluateThreats(s, s.entities)
  assert.equal(value.threats.length, 0)
  const resolved = resolveWorkActors(s, value, records)
  assert.equal(resolved.actors.length, 0)
  assert.equal(resolved.released[0].reason, 'clearance')
  assert.equal(workMargin(s), 0)
})

test('manual balanced mode retains its original eight-block pause margin', () => {
  const s = scene('balanced_mining')
  const records = captureWorkActors(s, evaluateThreats(s, s.entities))
  s.entities[0].position.x = 15
  assert.equal(resolveWorkActors(s, evaluateThreats(s, s.entities), records).actors.length, 1)
  assert.equal(workMargin(s), 8)
})

test('learning does not accept reused identities or invent unknown-position clearance', () => {
  const s = scene('online_learning')
  const records = captureWorkActors(s, evaluateThreats(s, s.entities))
  s.entities[0].uniqueId = '91'
  assert.deepEqual(resolveWorkActors(s, evaluateThreats(s, s.entities), records).invalid, ['9'])
  s.entities[0].positionKnown = false
  const value = evaluateThreats(s, s.entities)
  assert.equal(value.requiresObservation, true)
  assert.deepEqual(captureWorkActors(s, value), [])
})
