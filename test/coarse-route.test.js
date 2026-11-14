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

test('a cliff is climbed by a stair cut into its face, never by a tunnel', () => {
  const rows = flat(30, 5), get = world(rows)
  for (let z = 0; z < 5; z++) { rows[z][15] = 70; rows[z][16] = 70; rows[z][17] = 70 }
  const r = planCoarseRoute({ getBlock: get, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 }, allowDig: true, faceStairs: true })
  assert.equal(r.reached, true)
  for (let i = 1; i < r.path.length; i++) {
    const p = r.path[i]; if (!p.dig) continue
    const q = r.path[i - 1], x = Math.floor(p.x), z = Math.floor(p.z), dx = x - Math.floor(q.x), dz = z - Math.floor(q.z)
    const faces = [[dz, dx], [-dz, -dx], [-dx, -dz]].some(([ox, oz]) => [p.y, p.y + 1].some(y => get(x + ox, y, z + oz).boundingBox === 'empty'))
    const above = get(x, p.y + 2, z).boundingBox === 'empty' || p.dig.some(d => d.y === p.y + 2)
    assert.ok(faces || above, `step ${i} at ${x},${p.y},${z} would be a tunnel`)
  }
})

test('drops are bounded by maxDrop (the local planner refuses three-block drops)', () => {
  const rows = flat(20, 3)
  for (let x = 6; x < 20; x++) for (let z = 0; z < 3; z++) rows[z][x] = 59 // a three-block step down
  const deep = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 1.5 }, goal: { x: 18, z: 1 } })
  assert.equal(deep.reached, true)
  const shallow = planCoarseRoute({ getBlock: world(rows), start: { x: 2.5, y: 63, z: 1.5 }, goal: { x: 18, z: 1 }, maxDrop: 1 })
  assert.equal(shallow.reached, false)
})

// Live 2026-11-14 13:47: the route crossed a tree canopy on its leaves and the
// bot was stranded at y80. Leaves are no floor; from a canopy the way down may
// drop up to four.
test('leaves are never a floor; a bot on a canopy is routed down to the ground', () => {
  const base = world(flat(30, 5))
  const canopy = (x, y, z) => (x >= 8 && x <= 14 && y === 66) ? { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' } : base(x, y, z)
  const r = planCoarseRoute({ getBlock: canopy, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 } })
  assert.equal(r.reached, true)
  assert.ok(r.path.every(p => p.y === 63), 'the route stays on the ground under the canopy')
  const top = planCoarseRoute({ getBlock: canopy, start: { x: 11.5, y: 67, z: 2.5 }, goal: { x: 27, z: 2 }, maxDrop: 1 })
  assert.equal(top.reached, true)
  assert.equal(top.path[top.path.length - 1].y, 63, 'from the canopy the route gets down')
  const down = top.path.findIndex(p => p.y === 63)
  assert.ok(down > 0 && top.path.slice(down).every(p => p.y === 63), 'once down it stays on the ground')
})

// Live 2026-11-14 13:55: on a leaf edge over a deep hole no ground was within
// four; the route walks along the canopy until it can get down.
test('from a canopy over a deep hole the route walks the leaves to where it can get down', () => {
  const rows = flat(30, 5)
  for (let x = 4; x <= 12; x++) for (let z = 0; z < 5; z++) rows[z][x] = 50 // a deep hole
  const base = world(rows)
  const canopy = (x, y, z) => (x >= 6 && x <= 16 && y === 66) ? { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' } : base(x, y, z)
  const r = planCoarseRoute({ getBlock: canopy, start: { x: 7.5, y: 67, z: 2.5 }, goal: { x: 27, z: 2 }, maxDrop: 1 })
  assert.equal(r.reached, true)
  assert.equal(r.path[r.path.length - 1].y, 63)
  const firstGround = r.path.findIndex(p => p.y === 63)
  assert.ok(r.path.slice(0, firstGround).every(p => p.y === 67), 'on the leaves until the drop to the ground')
  assert.ok(r.path.slice(firstGround).every(p => p.y === 63), 'never back onto the leaves')
})

// 2026-11-14: a steep ravine (floor 12 below) between the bot and the goal.
// Without digging there is no way; with digging the route carves a trench down
// (never a tunnel) and steps back up the far wall.
test('a ravine is crossed by carved steps down and up, each open to the sky', () => {
  const rows = flat(40, 5)
  for (let x = 15; x <= 18; x++) for (let z = 0; z < 5; z++) rows[z][x] = 50
  const get = world(rows)
  assert.equal(planCoarseRoute({ getBlock: get, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 36, z: 2 }, maxDrop: 1, surfaceOnly: true }).reached, false)
  const r = planCoarseRoute({ getBlock: get, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 36, z: 2 }, maxDrop: 1, surfaceOnly: true, allowDig: true, faceStairs: true, maxNodes: 200000 })
  assert.equal(r.reached, true)
  assert.ok(r.path.some(p => p.y < 63), 'it goes down into the ravine')
  for (let i = 1; i < r.path.length; i++) assert.ok(Math.abs(r.path[i].y - r.path[i - 1].y) <= 1, 'one block per step')
  // Every carved step is a trench or cut into the ravine face: the cell beside
  // its head (across the move) is open air, or nothing solid is above it.
  for (let i = 1; i < r.path.length; i++) {
    const p = r.path[i]; if (!p.dig) continue
    const q = r.path[i - 1], x = Math.floor(p.x), z = Math.floor(p.z), dx = x - Math.floor(q.x), dz = z - Math.floor(q.z), head = p.y + 1
    const up = p.y > q.y, headY = up ? p.y + 1 : p.y + 1
    const side = [[dz, dx], [-dz, -dx], [-dx, -dz]].some(([ox, oz]) => get(x + ox, headY, z + oz).boundingBox === 'empty' || get(x + ox, head + (up ? 0 : -1), z + oz).boundingBox === 'empty')
    let open = true; for (let y = p.y + 2; y <= 70; y++) if (get(x, y, z).boundingBox !== 'empty' && !p.dig.some(d => d.y === y)) open = false
    assert.ok(side || open, `step ${i} at ${x},${p.y},${z} is neither open above nor cut into a face`)
  }
})

test('no step is carved next to water', () => {
  const rows = flat(30, 5)
  for (let x = 12; x <= 14; x++) for (let z = 0; z < 5; z++) rows[z][x] = 50
  const base = world(rows)
  const wet = (x, y, z) => (y >= 55 && y <= 63 && x === 11 && z !== 2) ? { known: true, name: 'minecraft:water', boundingBox: 'empty' } : base(x, y, z)
  const r = planCoarseRoute({ getBlock: wet, start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 27, z: 2 }, maxDrop: 1, surfaceOnly: true, allowDig: true, faceStairs: true, maxNodes: 200000 })
  for (const p of r.path.filter(q => q.dig)) for (const c of p.dig) for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.doesNotMatch(wet(c.x + ox, c.y, c.z + oz).name ?? '', /water/)
})

// Live 2026-11-14 14:42: an 18.6 s search stalled the event loop and the server
// closed the connection. The search honours its time budget.
test('the search stops at its time budget and returns the best partial route', () => {
  let t = 0
  const r = planCoarseRoute({ getBlock: world(flat(400, 400)), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 390, z: 390 }, maxMs: 5, now: () => (t += 1) })
  assert.equal(r.timedOut, true)
  assert.equal(r.reached, false)
  assert.ok(r.path.length >= 1)
  const big = planCoarseRoute({ getBlock: world(flat(200, 200)), start: { x: 2.5, y: 63, z: 2.5 }, goal: { x: 190, z: 190 }, maxNodes: 200000 })
  assert.equal(big.reached, true, 'a large open search still completes')
})
