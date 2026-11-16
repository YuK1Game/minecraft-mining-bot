'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')

const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
// Real Realm 2026-11-16 16:58-17:20 JST: a corridor at y -2 whose next cell has
// lava two blocks under the feet, below a tuff floor.
function scene ({ floor = 'tuff' } = {}) {
  const world = {
    getBlock: (x, y, z) => {
      if (z === 0 && x >= 0 && x <= 1 && (y === -2 || y === -1)) return block('air')
      if (x === 1 && y === -4 && z === 0) return block('lava', { liquid_depth: 0 })
      if (x === 1 && y === -3 && z === 0) return floor === 'tuff' ? block('tuff') : block('air')
      return block('stone')
    }
  }
  const navigator = createNavigator({ world })
  const initial = navigator.physics.fromServer({ position: { x: 0.5424, y: -0.38, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
  return { navigator, initial }
}

test('lava sealed under the floor of the next cell does not stop the walk', () => {
  const { navigator, initial } = scene()
  const route = navigator.plan(initial, { x: 1.5, y: -2, z: 0.5 })
  assert.equal(route.ready, true)
  const stepper = navigator.createStepper(route, initial)
  let frame
  for (let i = 0; i < 100; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.ok(Math.abs(frame.predictedState.position.x - 1.5) <= 0.35)
  assert.equal(frame.predictedState.position.y, -2)
})

test('open lava below the next cell is still never walked over', () => {
  const { navigator, initial } = scene({ floor: 'none' })
  let reached = false
  try {
    const route = navigator.plan(initial, { x: 1.5, y: -2, z: 0.5 })
    if (route.ready) {
      const stepper = navigator.createStepper(route, initial)
      let frame
      for (let i = 0; i < 100; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
      reached = frame.phase === 'awaiting_server_confirmation'
    }
  } catch { /* refused */ }
  assert.equal(reached, false)
  assert.throws(() => navigator.physics.step({ ...initial, position: { x: 1.5, y: -2.9, z: 0.5 }, onGround: false }, {}), /[Ll]ava/)
})
