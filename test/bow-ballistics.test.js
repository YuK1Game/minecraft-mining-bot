'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { solveBowAim, trajectoryPoints, simulateArrow } = require('../src/bow-ballistics')
const { createEntities } = require('../src/entities')

const eye = { x: 0.5, y: 101.62, z: 0.5 }

test('full-draw solution compensates arrow drop so the simulated arrow crosses the body point', () => {
  for (const d of [5, 8, 12, 16, 22]) {
    const point = { x: 0.5 + d, y: 100.9, z: 0.5 }
    const aim = solveBowAim({ eye, point })
    assert.ok(aim, `solution at ${d}`)
    const lineOfSight = -Math.atan2(point.y - eye.y, d) * 180 / Math.PI
    assert.ok(aim.pitch < lineOfSight, `aims above the straight line at ${d}`)
    const end = trajectoryPoints({ origin: aim.origin, yaw: aim.yaw, pitch: aim.pitch, horizontal: d }).at(-1)
    assert.ok(Math.abs(end.y - point.y) < 1e-3 && Math.abs(end.x - point.x) < 1e-3 && Math.abs(end.z - point.z) < 1e-3, `crosses body at ${d}`)
    // lookAt from the eye toward lookPoint must reproduce the launch pitch.
    const lookPitch = -Math.atan2(aim.lookPoint.y - eye.y, Math.hypot(aim.lookPoint.x - eye.x, aim.lookPoint.z - eye.z)) * 180 / Math.PI
    assert.ok(Math.abs(lookPitch - aim.pitch) < 1e-6)
  }
})

test('a walking target is led by release latency plus flight time', () => {
  const point = { x: 12.5, y: 100.9, z: 0.5 }
  const still = solveBowAim({ eye, point, velocity: { x: 0, y: 0, z: 0 } })
  const moving = solveBowAim({ eye, point, velocity: { x: 0, y: 0.4, z: 0.2 } })
  assert.equal(still.intercept.z, point.z)
  assert.ok(Math.abs(moving.intercept.z - (point.z + 0.2 * moving.leadTicks)) < 0.02)
  assert.equal(moving.intercept.y, point.y, 'vertical motion is not led')
  // Where the target will be when the simulated arrow arrives.
  const arrival = simulateArrow({ origin: moving.origin, yaw: moving.yaw, pitch: moving.pitch, speed: 3, gravity: 0.05, drag: 0.01, maxTicks: 60, horizontal: Math.hypot(moving.intercept.x - moving.origin.x, moving.intercept.z - moving.origin.z) })
  assert.ok(arrival.reached && Math.abs(arrival.point.z - moving.intercept.z) < 1e-3)
  const fast = solveBowAim({ eye, point, velocity: { x: 0, y: 0, z: 5 } })
  assert.ok(fast.intercept.z - point.z <= 0.6 * fast.leadTicks + 1e-9, 'implausible speeds are clamped')
})

test('targets beyond any low-arc full-draw trajectory have no solution', () => {
  assert.equal(solveBowAim({ eye, point: { x: 500, y: 100, z: 0 } }), null)
  assert.throws(() => solveBowAim({ eye, point: { x: NaN, y: 0, z: 0 } }))
})

test('entity motion estimates blocks per tick from received positions and treats quiet actors as stationary', () => {
  let t = 0
  const entities = createEntities({ now: () => t })
  entities.applyPacket('start_game', { runtime_entity_id: 1n, entity_id: 1n, dimension: 0 })
  entities.applyPacket('add_entity', { runtime_id: 5n, unique_id: -5n, entity_type: 'minecraft:zombie', position: { x: 0, y: 64, z: 0 } })
  assert.equal(entities.motion('5').stationary, true)
  for (let i = 1; i <= 6; i++) { t += 50; entities.applyPacket('move_entity_delta', { runtime_entity_id: 5n, x: 0.2 * i, z: -0.1 * i }) }
  const m = entities.motion('5')
  assert.equal(m.stationary, false)
  assert.ok(Math.abs(m.velocity.x - 0.2) < 1e-9 && Math.abs(m.velocity.z + 0.1) < 1e-9)
  t += 400
  assert.deepEqual(entities.motion('5').velocity, { x: 0, y: 0, z: 0 })
  t += 50; entities.applyPacket('move_entity', { runtime_entity_id: 5n, position: { x: 80, y: 64, z: 0 } })
  t += 50; entities.applyPacket('move_entity', { runtime_entity_id: 5n, position: { x: 80.1, y: 64, z: 0 } })
  assert.equal(entities.motion('5').discarded, 'teleport')
  assert.ok(!('motion' in entities.snapshot({ kind: 'all' })[0]), 'snapshot records stay unchanged')
  entities.applyPacket('remove_entity', { entity_id_self: -5n })
  assert.equal(entities.motion('5'), null)
})
