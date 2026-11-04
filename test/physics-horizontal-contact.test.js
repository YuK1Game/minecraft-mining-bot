'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const observed = require('./fixtures/exploration-contact-stall.json')
const copy = value => structuredClone(value)
function captured (override = () => null) {
  const blocks = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  return createPhysics({ world: { getBlock: (x, y, z) => override(x, y, z) ?? blocks.get(`${x},${y},${z}`) ?? { known: false } } })
}
const block = name => ({ known: true, name: `minecraft:${name}`, properties: {}, extra: [] })
function wall (axis, sign) {
  const coordinate = sign > 0 ? -1 : 1
  const world = { getBlock: (x, y, z) => block(y < 65 || (axis === 'x' ? x : z) === coordinate && y < 67 ? 'stone' : 'air') }
  const physics = createPhysics({ world })
  const target = sign > 0 ? 0.3 : 0.7
  const position = { x: 0.5, y: 65, z: 0.5 }
  position[axis] = target - sign * 5e-7
  const raw = physics.fromServer({ position: { ...position, y: 66.62 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } }, { onGround: true })
  const model = copy(raw)
  model.position[axis] = target - sign * 0.02
  const tangent = axis === 'x' ? 'z' : 'x'
  model.position[tangent] = 0.7
  model.velocity = { x: 0, y: -0.0784, z: 0 }
  model.velocity[axis] = -sign * 0.08
  model.velocity[tangent] = 0.123
  return { physics, raw, model, axis, sign, target, tangent }
}

test('the exact captured raw contact and forward input cannot reproduce the millimetre wall penetration', () => {
  const physics = captured()
  const raw = copy(observed.rawPhysicsState)
  const before = copy(raw)
  const next = physics.step(raw, { forward: true })
  assert.deepEqual(raw, before)
  assert.equal(next.position.x, -22.7)
  // The recorded absolute z used the older ground-speed fit. Contact repair
  // must preserve the tangential result of the SAME calibrated step.
  const exactContact = copy(raw); exactContact.position.x = -22.7
  const withoutNormalRepair = physics.step(exactContact, { forward: true })
  assert.equal(next.position.z, withoutNormalRepair.position.z, 'normal repair leaves calibrated tangential movement unchanged')
  assert.equal(next.velocity.z, withoutNormalRepair.velocity.z)
  assert.equal(next.velocity.x, 0)
  assert.equal(next.isCollidedHorizontally, true)
  assert.equal(next.onGround, true)
  assert.ok(next.horizontalContactAdjustment.delta.x > 0 && next.horizontalContactAdjustment.delta.x <= 1e-4)
  assert.equal(next.horizontalContactAdjustment.delta.z, 0)
  assert.equal(next.horizontalContactAdjustment.source, 'known_horizontal_shape_contact')
})

test('captured model repair projects the matching normal while retaining all later tangential progress', () => {
  const physics = captured()
  const model = copy(observed.modelPhysicsState); const raw = copy(observed.rawPhysicsState)
  const before = copy({ model, raw })
  const result = physics.repairHorizontalContact(model, raw)
  assert.ok(result)
  assert.deepEqual({ model, raw }, before)
  assert.equal(result.physicsState.position.x, -22.7)
  assert.equal(result.physicsState.position.y, model.position.y)
  assert.equal(result.physicsState.position.z, model.position.z)
  assert.notEqual(result.physicsState.position.z, raw.position.z)
  assert.deepEqual(result.physicsState.velocity, model.velocity)
  assert.equal(result.adjustment.axis, 'x')
  assert.deepEqual(result.adjustment.wall.position, { x: -24, y: 69, z: 69 })
  assert.ok(result.adjustment.delta.x > 0.0028 && result.adjustment.delta.x < 0.0029)
  assert.equal(result.adjustment.delta.y, 0)
  assert.equal(result.adjustment.delta.z, 0)
})

test('both wall axes and sides repair only the inward normal velocity after known collision proof', () => {
  for (const axis of ['x', 'z']) for (const sign of [-1, 1]) {
    const f = wall(axis, sign)
    const before = copy(f.model)
    const result = f.physics.repairHorizontalContact(f.model, f.raw)
    assert.ok(result, `${axis}/${sign}`)
    assert.equal(result.physicsState.position[axis], f.target)
    assert.equal(result.physicsState.position[f.tangent], before.position[f.tangent])
    assert.equal(result.physicsState.position.y, before.position.y)
    assert.equal(result.physicsState.velocity[axis], 0)
    assert.equal(result.physicsState.velocity[f.tangent], before.velocity[f.tangent])
    assert.equal(result.physicsState.velocity.y, before.velocity.y)
    f.model.velocity[axis] = sign * 0.04
    assert.equal(f.physics.repairHorizontalContact(f.model, f.raw).physicsState.velocity[axis], sign * 0.04, 'outward velocity is not zeroed')
    const seeded = f.physics.step(f.raw, {})
    assert.equal(seeded.position[axis], f.target)
    assert.ok(Math.hypot(seeded.horizontalContactAdjustment.delta.x, seeded.horizontalContactAdjustment.delta.z) <= 1e-4)
  }
})

test('raw overlap, non-contact raw poses, large or incoherent model errors and unknown geometry never authorize repair', () => {
  const physics = captured()
  for (const mode of ['raw_overlap', 'raw_not_face', 'large', 'distant', 'invalid_bound']) {
    const model = copy(observed.modelPhysicsState); const raw = copy(observed.rawPhysicsState)
    if (mode === 'raw_overlap') raw.position.x = -22.7002
    if (mode === 'raw_not_face') raw.position.x = -22.69
    if (mode === 'large') model.position.x = -22.76
    if (mode === 'distant') model.position.z = raw.position.z + 0.8
    assert.equal(physics.repairHorizontalContact(model, raw, mode === 'invalid_bound' ? { maxNormalAdjustment: 0.1 } : {}), null, mode)
  }
  for (const unknown of [{ x: -24, y: 69, z: 69 }, { x: -23, y: 70, z: 69 }]) {
    const unavailable = captured((x, y, z) => x === unknown.x && y === unknown.y && z === unknown.z ? { known: false } : null)
    assert.equal(unavailable.repairHorizontalContact(observed.modelPhysicsState, observed.rawPhysicsState), null)
  }
  const f = wall('x', 1)
  f.raw.position.z = 0.6; f.model.position.z = 1.31
  assert.equal(f.physics.repairHorizontalContact(f.model, f.raw), null, 'a different cell on the same plane is not the same observed wall face')
})

test('the private contact skin does not excuse a real overlap or unknown body cell', () => {
  const f = wall('x', 1)
  const deeper = copy(f.raw)
  deeper.position.x = f.target - 0.001
  assert.equal(f.physics.step(deeper, {}).horizontalContactAdjustment, null)
  const unavailable = captured((x, y, z) => x === -24 && y === 69 && z === 69 ? { known: false } : null)
  assert.throws(() => unavailable.step(observed.rawPhysicsState, { forward: true }), /Unknown terrain/)
})
