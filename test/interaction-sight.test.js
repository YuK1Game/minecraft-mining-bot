'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { canSeePlacementFloor, interactionSightError } = require('../src/interaction-sight')

const air = { known: true, name: 'minecraft:air', extra: [], boundingBox: 'empty' }
const dirt = { known: true, name: 'minecraft:dirt', extra: [], boundingBox: 'block' }
const unknown = { known: false }
const key = p => [p.x, p.y, p.z].join(',')
const eyeAt = stand => ({ x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 })

test('storage:27 rejects the intermediate dirt and finds a clear floor from the next proposed stand', () => {
  // Received layout, chunk (-3,-13), layer 92. The planned eye and the
  // observed off-centre eye both send the first ray through (-45,92,-207).
  const first = { stand: { x: -44, y: 92, z: -207 }, target: { x: -46, y: 92, z: -207 } }
  const next = { stand: { x: -44, y: 92, z: -208 }, target: { x: -44, y: 92, z: -206 } }
  const cells = new Map([
    ['-44,93,-207', air], ['-45,93,-207', air], ['-45,92,-207', dirt], ['-46,92,-207', air], ['-46,91,-207', dirt],
    ['-44,93,-208', air], ['-44,92,-207', air], ['-44,92,-206', air], ['-44,91,-206', dirt]
  ])
  const read = p => cells.get(key(p)) ?? unknown
  const selected = [first, next].find(c => canSeePlacementFloor(read, eyeAt(c.stand), c.target))
  assert.equal(selected, next)
  assert.equal(canSeePlacementFloor(read, { x: -43.48893774568334, y: 93.62, z: -206.51927900752264 }, first.target), false)
  cells.delete('-44,92,-207')
  assert.equal(canSeePlacementFloor(read, eyeAt(next.stand), next.target), false)
})

test('candidate visibility follows exact interaction range, torch and extra-layer rules', () => {
  const eye = { x: 0.5, y: 93.62, z: 0.5 }, p = { x: 2, y: 92, z: 0 }
  const visibleWith = mid => canSeePlacementFloor(cell => cell.x === 1 ? mid : air, eye, p)
  const torch = { ...air, name: 'minecraft:torch' }
  assert.equal(visibleWith(torch), true)
  assert.equal(visibleWith({ ...torch, boundingBox: 'block' }), false)
  assert.equal(visibleWith({ ...air, extra: [{ name: 'minecraft:water' }] }), false)
  assert.equal(visibleWith({ ...air, name: 'minecraft:short_grass' }), false)
  assert.equal(canSeePlacementFloor(() => air, eye, { ...p, x: 5 }), false)
  const clicked = { x: 2, y: 91, z: 0 }
  const read = cell => key(cell) === key(clicked) ? dirt : air
  assert.equal(interactionSightError(read, eye, { x: 2.5, y: 91.5, z: 0.5 }, clicked), null)
})
