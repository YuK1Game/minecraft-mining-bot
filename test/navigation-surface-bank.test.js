'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })

test('a swimmer reaches level shore before considering the neighbouring bank above the water surface', () => {
  const world = { getBlock (x, y, z) {
    if (x < 0) return block(y <= (z < 1 ? 63 : 62) ? 'stone' : 'air')
    return block(y <= 60 ? 'stone' : y < 63 ? 'water' : 'air', y > 60 && y < 63 ? { liquid_depth: 0 } : {})
  } }
  const nav = createNavigator({ world, allowWater: true })
  const initial = nav.physics.fromServer({ gameMode: 'survival', position: { x: .5, y: 64.12, z: .5 }, rotation: { pitch: 0, yaw: 90 } })
  const route = nav.plan(initial, { x: -.5, y: 63, z: 1.5 }, { maxDistance: 4 })
  assert.equal(route.ready, true)
  assert.ok(route.waypoints.filter(p => p.medium === 'land')[0].position.y <= 63, 'A graph edge cannot substitute an unproved high bank for the level exit')
  const stepper = nav.createStepper(route, initial, { maxTicks: 100, sprint: false })
  let final
  for (let tick = 0; tick < 100; tick++) { final = stepper.next(); if (final.phase !== 'moving') break }
  assert.equal(final.phase, 'awaiting_server_confirmation')
  assert.equal(final.predictedState.onGround, true)
  assert.equal(final.predictedState.isInWater, false)
  assert.equal(final.predictedState.position.y, 63)
  assert.equal(route.serverConfirmed, false)
})

test('a plan rereads changed unknown terrain and the subsequent native executor reads it again', () => {
  let known = false
  const world = { getBlock: (x, y) => x >= 1 && !known ? { known: false } : block(y < 65 ? 'stone' : 'air') }
  const nav = createNavigator({ world })
  const initial = nav.physics.fromServer({ gameMode: 'survival', position: { x: .5, y: 66.62, z: .5 }, rotation: { pitch: 0, yaw: -90 } })
  assert.equal(nav.plan(initial, { x: 2.5, y: 65, z: .5 }, { maxDistance: 3, maxExpanded: 50 }).ready, false)
  known = true
  const route = nav.plan(initial, { x: 2.5, y: 65, z: .5 }, { maxDistance: 3, maxExpanded: 50 })
  assert.equal(route.ready, true)
  known = false
  const stepper = nav.createStepper(route, initial, { maxTicks: 50 })
  let stopped
  for (let tick = 0; tick < 50; tick++) { stopped = stepper.next(); if (stopped.phase !== 'moving') break }
  assert.equal(stopped.phase, 'failed')
  assert.ok(stopped.predictedState.position.x < 1, 'Unknown space cannot retain the prior plan\'s known passage')
})
