'use strict'

// Live Realm 2026-11-24 21:58-22:18 JST (incident 20261124-221803-expedition-NO_PROGRESS.json):
// Standing at (9847.495, 68.0, 10301.706), the south rim of the 0.6-wide body
// (z = 10302.006) overhung (9847, 67, 10302) containing `minecraft:wildflowers`
// (collision shape: empty). `knownUnitSupportOrAir` only allowed 5 empty names
// and rejected `wildflowers`, causing `verifyOrigin(..., { stablePartialOrigin: true })`
// and `partialRecenter` to fail and locking the Bot in place for 20 minutes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')

function makeWorld (overrides = {}) {
  return {
    getBlock (x, y, z) {
      const k = `${x},${y},${z}`
      if (k in overrides) return overrides[k]
      if (y <= 66) return { known: true, name: 'minecraft:dirt', boundingBox: 'block', properties: {}, extra: [] }
      if (y === 67 && z <= 10301) return { known: true, name: 'minecraft:grass_block', boundingBox: 'block', properties: {}, extra: [] }
      return { known: true, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] }
    }
  }
}

function makeOriginState (nav) {
  return nav.physics.fromServer({
    position: { x: 9847.495, y: 69.62, z: 10301.706 },
    rotation: { yaw: 0, pitch: 0 },
    gameMode: 'survival'
  })
}

test('navigation: accepts dry empty-shape wildflowers in partial-ledge overhang for verifyOrigin and partialRecenter', () => {
  const world = makeWorld({
    '9847,68,10301': { known: true, name: 'minecraft:wildflowers', boundingBox: 'empty', properties: { growth: 0, 'minecraft:cardinal_direction': 'north' }, extra: [] },
    '9847,67,10302': { known: true, name: 'minecraft:wildflowers', boundingBox: 'empty', properties: { growth: 0, 'minecraft:cardinal_direction': 'north' }, extra: [] }
  })
  const nav = createNavigator({ world })
  const initial = makeOriginState(nav)
  assert.equal(nav.verifyOrigin(initial, { stablePartialOrigin: true }), true)

  const recenterTarget = { x: 9847.5, y: 68, z: 10301.5 }
  const recenter = nav.plan(initial, recenterTarget, { partialRecenter: true, maxDistance: 2, maxExpanded: 64 })
  assert.equal(recenter.ready, true, JSON.stringify(recenter))

  const stepper = nav.createStepper(recenter, initial, { maxTicks: 40, sprint: false })
  let last
  for (let i = 0; i < 40; i++) {
    last = stepper.next()
    if (last.phase !== 'moving') break
  }
  assert.equal(last.phase, 'awaiting_server_confirmation', last.reason)
  assert.ok(Math.hypot(last.predictedState.position.x - recenterTarget.x, last.predictedState.position.z - recenterTarget.z) <= 0.35)
})

test('navigation: still rejects hazardous or unknown blocks in the partial-ledge overhang margin', () => {
  for (const [block, pattern] of [
    [{ known: false }, /Unknown terrain/],
    [{ known: true, name: 'minecraft:lava', boundingBox: 'empty', properties: { liquid_depth: 0 }, extra: [] }, /Lava/]
  ]) {
    const nav = createNavigator({ world: makeWorld({ '9847,67,10302': block }) })
    assert.throws(() => makeOriginState(nav), pattern)
  }

  for (const block of [
    { known: true, name: 'minecraft:sweet_berry_bush', boundingBox: 'empty', properties: { growth: 0 }, extra: [] },
    { known: true, name: 'minecraft:wither_rose', boundingBox: 'empty', properties: {}, extra: [] },
    { known: true, name: 'minecraft:web', boundingBox: 'empty', properties: {}, extra: [] }
  ]) {
    const nav = createNavigator({ world: makeWorld({ '9847,67,10302': block }) })
    const initial = makeOriginState(nav)
    assert.equal(nav.verifyOrigin(initial, { stablePartialOrigin: true }), false, `expected verifyOrigin reject for ${block.name}`)
    const recenter = nav.plan(initial, { x: 9847.5, y: 68, z: 10301.5 }, { partialRecenter: true, maxDistance: 2, maxExpanded: 64 })
    assert.equal(recenter.ready, false, `expected partialRecenter reject for ${block.name}`)
  }
})
