'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')

// Live 2026-11-17 14:48-14:57 JST: the Bot stood on the base chest inside the
// house (feet 77.95) and every walk was refused with
// 「Wait for a supported landing before planning」.
const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
const world = { getBlock: (x, y, z) => y <= 76 ? block('cobblestone') : x === 0 && y === 77 && z === 0 ? block('chest', { 'minecraft:cardinal_direction': 'south' }) : block('air') }

function onChest (navigator) {
  // Let the body come to rest on the chest from just above it.
  let state = navigator.physics.fromServer({ position: { x: 0.5, y: 78.1 + 1.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 20; i++) state = navigator.physics.step(state, {})
  return state
}

test('the body steps off a chest onto the floor beside it', () => {
  const navigator = createNavigator({ world })
  const initial = onChest(navigator)
  assert.equal(initial.onGround, true)
  assert.ok(initial.position.y > 77.5 && initial.position.y < 78, `feet ${initial.position.y}`)
  assert.equal(navigator.plan(initial, { x: -0.5, y: 77, z: 0.5 }).ready, false)
  const route = navigator.plan(initial, { x: -0.5, y: 77, z: 0.5 }, { lowStepDown: true, maxDistance: 2 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial)
  let frame = null
  for (let i = 0; i < 60; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.ok(Math.abs(frame.predictedState.position.y - 77) < 0.05)
})

test('the step-down is refused from whole-block ground and onto unsupported cells', () => {
  const navigator = createNavigator({ world })
  const floor = navigator.physics.fromServer({ position: { x: 2.5, y: 77 + 1.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  assert.equal(navigator.plan(floor, { x: 2.5, y: 77, z: 1.5 }, { lowStepDown: true, maxDistance: 2 }).ready, false)
  const initial = onChest(navigator)
  assert.equal(navigator.plan(initial, { x: -0.5, y: 76, z: 0.5 }, { lowStepDown: true, maxDistance: 2 }).ready, false)
})
