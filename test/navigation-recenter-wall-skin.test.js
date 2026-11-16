'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')

// Live 2026-11-16 17:25-18:24 JST: at the rim of a hole, pressed against a wall.
// The received float32 x (-5040.7001953125) reads 0.0002 inside the wall cell,
// and the walk to the middle of the own block was refused with
// 「Partial recenter lacks bounded known support」 for an hour.
const block = name => ({ known: true, name: `minecraft:${name}`, properties: name === 'deepslate' ? { pillar_axis: 'y' } : {}, extra: [] })
const D = 'deepslate', A = 'air'
// Each row is x = -5042 / -5041 / -5040.
const cells = {
  '-5': { '-5049': [A, A, A], '-5048': [A, A, A], '-5047': [D, A, A] },
  '-6': { '-5049': [D, A, A], '-5048': [D, A, A], '-5047': [D, D, A] },
  '-7': { '-5049': [D, A, A], '-5048': [A, A, A], '-5047': [D, D, A] },
  '-8': { '-5049': [D, A, A], '-5048': [D, D, A], '-5047': [D, D, A] }
}
const world = { getBlock: (x, y, z) => { const row = cells[y]?.[z]; return block(row && x >= -5042 && x <= -5040 ? row[x + 5042] : y > -5 ? A : D) } }

test('a body 0.0002 inside a wall cell at the rim of a hole can walk to the middle of its block', () => {
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer({ position: { x: -5040.7001953125, y: -5.38, z: -5047.788169945292 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  const route = navigator.plan(initial, { x: -5040.5, y: -7, z: -5047.5 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial)
  let frame = null
  for (let i = 0; i < 60; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.ok(Math.hypot(frame.predictedState.position.x + 5040.5, frame.predictedState.position.z + 5047.5) < 0.12)
})

test('a body really inside the wall is still refused', () => {
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer({ position: { x: -5040.72, y: -5.38, z: -5047.788169945292 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  assert.equal(navigator.plan(initial, { x: -5040.5, y: -7, z: -5047.5 }).ready, false)
})
