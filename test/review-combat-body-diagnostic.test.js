'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { diagnoseStrikeBody } = require('../src/combat-body-diagnostic')
const state = { position: { x: -3.5, y: 66.62, z: 16.5 }, physicsState: { onGround: true } }
const air = () => ({ name: 'air', shapes: [] })
const check = overrides => diagnoseStrikeBody({ state, observed: state, scopeMatches: true, blockAt: air, ...overrides })
test('review: supported flag alone cannot hide a collision or unknown body cell', () => {
  assert.equal(check().ready, true)
  const collision = check({ blockAt: () => ({ name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }) })
  assert.equal(collision.cause, 'BODY_COLLISION'); assert.deepEqual(collision.position, { x: -4, y: 65, z: 16 })
  const unknown = check({ blockAt: () => { throw Error('unreceived') } })
  assert.equal(unknown.ready, false); assert.equal(unknown.cause, 'BODY_TERRAIN_UNCONFIRMED')
})
for (const liquid of ['Water', 'Lava']) test(`review: actual ${liquid.toLowerCase()} remains unsafe rather than bypassing body check`, () => {
  assert.equal(check({ state: { ...state, physicsState: { [`isIn${liquid}`]: true } } }).cause, `BODY_IN_${liquid.toUpperCase()}`)
})
test('review: pose drift, changed scope and cancellation cannot become body confirmation', () => {
  assert.equal(check({ observed: { position: { ...state.position, x: -3 } } }).cause, 'BODY_POSE_CHANGED')
  assert.equal(check({ scopeMatches: false }).ready, false)
  assert.equal(check({ signal: { aborted: true } }).cause, 'BODY_CHECK_ABORTED')
})
test('review: harmless collisionless plants are not body obstructions, hazards still are', () => {
  assert.equal(check({ blockAt: () => ({ name: 'short_grass', shapes: [] }) }).ready, true)
  assert.equal(check({ blockAt: () => ({ name: 'sweet_berry_bush', shapes: [] }) }).cause, 'BODY_HAZARD')
})
for (const shapes of [[[0, 0, 0]], [[0, 0, 0, NaN, 1, 1]], [[1, 0, 0, 0, 1, 1]], [null]]) test(`review: malformed physics shapes fail closed (${JSON.stringify(shapes)})`, () => {
  assert.equal(check({ blockAt: () => ({ name: 'stone', shapes }) }).cause, 'BODY_TERRAIN_UNCONFIRMED')
})
