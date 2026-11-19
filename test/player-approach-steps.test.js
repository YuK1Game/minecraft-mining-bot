'use strict'

// The points a melee approach steps to, and the mover's bound on one move (src/combat/approach-steps.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { towards, around, inStep, stepLength, STEP_M } = require('../src/combat/approach-steps')

const EYE = 1.62
const at = (x, feetY, z) => ({ position: { x, y: feetY + EYE, z } })
const hostile = (x, y, z) => ({ position: { x, y, z } })
const offset = (state, point) => ({ along: Math.hypot(point.x - state.position.x, point.z - state.position.z), dy: point.y - Math.round(state.position.y - EYE) })

test('live 2026-11-20 02:10 JST: a skeleton 6.8 m away and 3.8 lower; the first point three blocks down is one the mover takes', () => {
  // Feet (-4899.5, 72, -4984.5); the skeleton 5.64 m off on the map and 3.8 below: 6.8 m.
  const state = at(-4899.5, 72, -4984.5), target = hostile(-4899.5 + 5.64, 68.2, -4984.5)
  // What was tried first on the way down before: 5.5 m on the map and three blocks down is 6.26 m from the feet,
  // which the mover refuses by throwing (the approach ended there, three times in eight seconds).
  const before = { x: state.position.x + 5.5, y: 69, z: state.position.z }
  assert.ok(stepLength(state, before) > STEP_M)
  assert.equal(inStep(state, before), false)
  const points = towards(state, target)
  assert.ok(points.length > 0)
  for (const point of points) assert.ok(inStep(state, point), JSON.stringify(point) + ' ' + stepLength(state, point))
  // The way down is still offered, at the next shorter step.
  const down = points.filter(point => offset(state, point).dy === -3)
  assert.ok(down.length > 0, 'three blocks down stays reachable')
  assert.equal(Math.round(offset(state, down[0]).along * 10) / 10, 4)
  // Longest step first: the level step of 5.5 m is still the first point.
  assert.deepEqual({ along: Math.round(offset(state, points[0]).along * 10) / 10, dy: offset(state, points[0]).dy }, { along: 5.5, dy: 0 })
  // Every point ends closer to the hostile than the Bot is now.
  const range = point => Math.hypot(point.x - target.position.x, point.y + EYE - (target.position.y + 0.9), point.z - target.position.z)
  for (const point of points) assert.ok(range(point) < range({ x: state.position.x, y: 72, z: state.position.z }) - 0.25)
})

test('a body a few tenths off the block grid: two blocks down at 5.5 m is over the bound too, and is left out', () => {
  // Feet at 72.4 (on a low block): the point's height is counted from 72, the move from 72.4.
  const state = at(10.5, 72.4, 10.5), target = hostile(10.5, 69.5, 10.5 - 6.5)
  const far = { x: 10.5, y: 70, z: 10.5 - 5.5 }
  assert.ok(stepLength(state, far) > STEP_M && stepLength(state, far) < STEP_M + 0.01)
  for (const point of towards(state, target)) assert.ok(inStep(state, point))
  assert.equal(towards(state, target).some(point => point.y === 70 && Math.abs(point.z - 5) < 1e-9), false)
})

test('no point is ever longer than one move, uphill, downhill or level, near or far', () => {
  for (const feetY of [64, 64.5, 70.0625, 71.9]) for (const range of [3.2, 4.5, 6, 8, 12, 20]) for (const height of [-6, -3.8, -2, 0, 1, 3, 5]) for (const angle of [0, 0.7, 2.1, 3.9, 5.5]) {
    const state = at(100.3, feetY, -200.7)
    const target = hostile(100.3 + Math.cos(angle) * range, feetY + height, -200.7 + Math.sin(angle) * range)
    for (const point of [...towards(state, target), ...around(state, target)]) assert.ok(inStep(state, point), JSON.stringify({ feetY, range, height, angle, point }))
    assert.ok(around(state, target).length <= 24)
  }
  assert.deepEqual(towards(at(1, 64, 1), hostile(1, 64, 1)), [], 'no direction: no points')
  assert.equal(inStep(at(1, 64, 1), null), false)
  assert.equal(inStep(at(1, 64, 1), { x: 1, y: NaN, z: 1 }), false)
})

test('the cells around the body are given closest to the hostile first, never the hostile\'s own cell', () => {
  const state = at(0.5, 64, 0.5), target = hostile(3.5, 65, 0.5)
  const cells = around(state, target)
  const range = point => Math.hypot(point.x - target.position.x, point.y + EYE - (target.position.y + 0.9), point.z - target.position.z)
  for (let i = 1; i < cells.length; i++) assert.ok(range(cells[i - 1]) <= range(cells[i]))
  assert.equal(cells.some(point => Math.hypot(point.x - 3.5, point.z - 0.5) < 0.9), false)
  assert.ok(cells.every(point => Math.abs(point.x % 1) === 0.5 && Math.abs(point.z % 1) === 0.5))
})

test('the approach takes its points from this module and the mover measures a move with the same function', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'user-control-runtime.js'), 'utf8')
  assert.match(source, /require\('\.\/combat\/approach-steps'\)\.inStep\(initial, target\)\) throw new Error\('User movement exceeds its known six-block step'\)/)
  assert.match(source, /for \(const point of \[\.\.\.steps\.towards\(state, target\), \.\.\.steps\.around\(state, target\)\]\)/)
  // No second list of step lengths is left in the runtime.
  assert.doesNotMatch(source, /for \(const step of \[5\.5, 4, 2, 1\]\)/)
})
