'use strict'
// Coarse wide-area route over received terrain (2026-11-14). Live check: from
// spawn (1.5,62,23.5) to (-40,55) the received terrain gave a 52-node route in
// 46 ms; the local 16-48 m searches had failed there.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planCoarseRoute } = require('../src/coarse-route')

// heights[z][x] = top solid y; 'W' = water surface at y 62; null = unreceived.
function world (rows) {
  return (x, y, z) => {
    const row = rows[z], top = row?.[x]
    if (top === undefined || top === null) return { known: false }
    if (top === 'W') return y <= 61 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : y === 62 ? { known: true, name: 'minecraft:water', boundingBox: 'empty' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    return y <= top ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}
const flat = (w, h, top = 62) => Array.from({ length: h }, () => Array(w).fill(top))

test('a route is found over walkable ground to a far goal', () => {
  const r = planCoarseRoute({ getBlock: world(flat(80, 10)), start: { x: 1.5, y: 63, z: 5.5 }, goal: { x: 75, z: 5 } })
  assert.equal(r.reached, true); assert.ok(r.path.length > 60)
})

test('a two-block wall is walked around through a gap; never climbed', () => {
  const rows = flat(30, 15)
  for (let z = 0; z < 15; z++) if (z !== 12) rows[z][15] = 64 // wall two above the ground, gap at z=12
  const r = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 } })
  assert.equal(r.reached, true)
  assert.ok(r.path.some(p => Math.floor(p.z) === 12 && Math.floor(p.x) === 15))
  for (let i = 1; i < r.path.length; i++) assert.ok(r.path[i].y - r.path[i - 1].y <= 1)
})

test('unreceived terrain is never crossed; the partial route reports the frontier', () => {
  const rows = flat(40, 6)
  for (let z = 0; z < 6; z++) rows[z][20] = null
  const r = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 38, z: 2 } })
  assert.equal(r.reached, false)
  assert.ok(r.path.every(p => p.x < 20))
  assert.ok(r.frontier.some(f => f.x === 20))
})

test('shallow water is crossed at a higher cost than land', () => {
  const rows = flat(20, 3)
  for (let x = 8; x < 12; x++) rows[1][x] = 'W'
  const r = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 1.5 }, goal: { x: 18, z: 1 } })
  assert.equal(r.reached, true)
  assert.ok(r.path.some(p => Math.floor(p.z) !== 1), 'land around the water is preferred while it exists')
})

test('with digging allowed, a wall with no gap gets carved steps; never a tunnel', () => {
  const rows = flat(30, 5)
  for (let z = 0; z < 5; z++) { rows[z][15] = 64; rows[z][16] = 64; rows[z][17] = 64 }
  const without = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 } })
  assert.equal(without.reached, false)
  const r = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 }, allowDig: true })
  assert.equal(r.reached, true)
  const dug = r.path.filter(p => p.dig)
  assert.ok(dug.length >= 1)
  for (const p of dug) for (const c of p.dig) assert.ok(c.y <= p.y + 1, 'only the step cells are carved')
})

test('digging never opens a cell under a covered ceiling (no tunnels)', () => {
  const rows = flat(30, 5), get = world(rows)
  for (let z = 0; z < 5; z++) rows[z][15] = 70 // a tall cliff: the cell above a carved step is not open
  const r = planCoarseRoute({ getBlock: get, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 }, allowDig: true })
  assert.equal(r.reached, false)
})

test('drops are bounded by maxDrop (the local planner refuses three-block drops)', () => {
  const rows = flat(20, 3)
  for (let x = 6; x < 20; x++) for (let z = 0; z < 3; z++) rows[z][x] = 59 // a three-block step down
  const deep = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 1.5 }, goal: { x: 18, z: 1 } })
  assert.equal(deep.reached, true)
  const shallow = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 1.5 }, goal: { x: 18, z: 1 }, maxDrop: 1 })
  assert.equal(shallow.reached, false)
})
