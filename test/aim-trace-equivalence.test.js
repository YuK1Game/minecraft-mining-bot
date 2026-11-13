'use strict'
// Pins the scalar ray walk in src/aim.js to the original object-based version:
// identical faces, hit points and distances on random worlds, including rays
// that run exactly along block edges.
const test = require('node:test')
const assert = require('node:assert/strict')
const { selectVisibleBlockFace, traceBlockFace } = require('../src/aim')

const AXES = ['x', 'y', 'z']
const AIR = new Set(['air', 'cave_air', 'void_air'])
const EPSILON = 1e-10
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const key = point => `${point.x},${point.y},${point.z}`
const finite = point => point && AXES.every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000001)
const air = block => block?.known === true && AIR.has(nameOf(block)) && !(block.extra ?? []).some(layer => !AIR.has(nameOf(layer)))
const emptyTorch = block => block?.known === true && nameOf(block) === 'torch' && block.boundingBox === 'empty' && !block.extra?.length
function referenceTrace ({ eye, target, world, maxReach = 4.5, removed = new Set() }, point) {
  const read = p => world.getBlock(p.x, p.y, p.z)
  if (!finite(point) || !AXES.every(axis => point[axis] > target[axis] && point[axis] < target[axis] + 1)) return null
  const targetBlock = read(target)
  if (!targetBlock?.known || AIR.has(nameOf(targetBlock)) || emptyTorch(targetBlock) || (targetBlock.extra ?? []).some(layer => !AIR.has(nameOf(layer)))) return null
  const delta = Object.fromEntries(AXES.map(axis => [axis, point[axis] - eye[axis]]))
  const length = Math.hypot(delta.x, delta.y, delta.z)
  if (!length) return null
  const cell = Object.fromEntries(AXES.map(axis => [axis, Math.floor(eye[axis])]))
  if (key(cell) === key(target)) return null
  const direction = Object.fromEntries(AXES.map(axis => [axis, Math.sign(delta[axis])]))
  const next = Object.fromEntries(AXES.map(axis => [axis, direction[axis] ? (cell[axis] + Number(direction[axis] > 0) - eye[axis]) / delta[axis] : Infinity]))
  const step = Object.fromEntries(AXES.map(axis => [axis, direction[axis] ? 1 / Math.abs(delta[axis]) : Infinity]))
  const clear = p => removed.has(key(p)) || air(read(p)) || emptyTorch(read(p))
  let entry = 0; let face = null
  for (let count = 0; count < 128; count++) {
    if (key(cell) === key(target)) {
      if (face === null || entry < 0 || entry > 1 || length * entry > maxReach + EPSILON) return null
      return { point: { ...point }, hit: Object.fromEntries(AXES.map(axis => [axis, eye[axis] + delta[axis] * entry])), face, distance: length * entry }
    }
    if (!clear(cell)) return null
    const crossing = Math.min(next.x, next.y, next.z)
    if (!Number.isFinite(crossing) || crossing > 1 || crossing * length > maxReach + EPSILON) return null
    const crossed = AXES.filter(axis => Math.abs(next[axis] - crossing) <= EPSILON)
    if (crossed.length > 1) {
      for (let mask = 1; mask < 1 << crossed.length; mask++) {
        const touched = { ...cell }
        crossed.forEach((axis, index) => { if (mask & 1 << index) touched[axis] += direction[axis] })
        if (key(touched) === key(target) || !clear(touched)) return null
      }
    }
    for (const axis of crossed) { cell[axis] += direction[axis]; next[axis] += step[axis] }
    const axis = crossed[0]
    face = axis === 'y' ? (direction.y > 0 ? 0 : 1) : axis === 'z' ? (direction.z > 0 ? 2 : 3) : (direction.x > 0 ? 4 : 5)
    entry = crossing
  }
  return null
}

function rng (seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff } }
function randomWorld (random) {
  const blocks = new Map()
  for (let x = -5; x <= 5; x++) for (let y = -5; y <= 5; y++) for (let z = -5; z <= 5; z++) {
    const r = random()
    blocks.set(key({ x, y, z }), r < 0.62 ? { known: true, name: 'minecraft:air' } : r < 0.66 ? { known: true, name: 'minecraft:torch', boundingBox: 'empty' } : r < 0.70 ? { known: false } : { known: true, name: 'minecraft:stone', boundingBox: 'block' })
  }
  return { getBlock: (x, y, z) => blocks.get(key({ x, y, z })) ?? { known: false } }
}

test('scalar ray walk matches the reference on random worlds and edge rays', () => {
  const random = rng(7)
  let hits = 0, compared = 0
  for (let w = 0; w < 60; w++) {
    const world = randomWorld(random)
    for (let i = 0; i < 40; i++) {
      // Some eyes on exact grid lines to force edge and corner crossings.
      const coord = () => random() < 0.25 ? Math.round(random() * 6 - 3) : random() * 6 - 3
      const eye = { x: coord(), y: coord() + 0.62, z: coord() }
      const target = { x: Math.floor(random() * 8 - 4), y: Math.floor(random() * 8 - 4), z: Math.floor(random() * 8 - 4) }
      const removed = random() < 0.3 ? new Set([key({ x: Math.floor(eye.x), y: Math.floor(eye.y) + 1, z: Math.floor(eye.z) })]) : new Set()
      const options = { eye, target, world, maxReach: 5, removed }
      const point = random() < 0.3 ? { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 } : { x: target.x + random(), y: target.y + random(), z: target.z + random() }
      if (!AXES.every(a => point[a] > target[a] && point[a] < target[a] + 1)) continue
      assert.deepEqual(traceBlockFace({ ...options, point }), referenceTrace(options, point))
      const expected = (() => {
        // Reference face selection, same sampling as src/aim.js.
        const FACES = [{ axis: 'y', normal: -1, axes: ['x', 'z'] }, { axis: 'y', normal: 1, axes: ['x', 'z'] }, { axis: 'z', normal: -1, axes: ['x', 'y'] }, { axis: 'z', normal: 1, axes: ['x', 'y'] }, { axis: 'x', normal: -1, axes: ['y', 'z'] }, { axis: 'x', normal: 1, axes: ['y', 'z'] }]
        const clamp = v => Math.max(0.02, Math.min(0.98, v)); const out = []
        for (let face = 0; face < 6; face++) {
          const d = FACES[face], plane = target[d.axis] + Number(d.normal > 0)
          if ((eye[d.axis] - plane) * d.normal <= EPSILON) continue
          const samples = [d.axes.map(a => clamp(eye[a] - target[a])), [0.5, 0.5]]
          for (const u of [0.02, 0.2, 0.5, 0.8, 0.98]) for (const v of [0.02, 0.2, 0.5, 0.8, 0.98]) samples.push([u, v])
          const seen = new Set()
          for (const [u, v] of samples) {
            if (seen.has(`${u},${v}`)) continue; seen.add(`${u},${v}`)
            const p = { ...target, [d.axis]: plane - d.normal * 0.001 }; p[d.axes[0]] += u; p[d.axes[1]] += v
            const aimed = referenceTrace(options, p); if (aimed?.face === face) out.push(aimed)
          }
        }
        out.sort((a, b) => a.distance - b.distance || a.face - b.face); return out[0] ?? null
      })()
      const actual = selectVisibleBlockFace(options)
      assert.deepEqual(actual, expected)
      compared++; if (actual) hits++
    }
  }
  assert.ok(compared > 1000 && hits > 100, `compared=${compared} hits=${hits}`)
})
