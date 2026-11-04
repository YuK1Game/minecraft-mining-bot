'use strict'

// Full-cube block targeting. Bedrock face IDs: down/up/north/south/west/east.
// Rays stop at unknown/opaque cells; only a known empty-box torch is an explicit
// non-air exception. Target blocks still require their own full-cube face.
const AXES = ['x', 'y', 'z']
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FACES = [
  { axis: 'y', normal: -1, axes: ['x', 'z'] }, { axis: 'y', normal: 1, axes: ['x', 'z'] },
  { axis: 'z', normal: -1, axes: ['x', 'y'] }, { axis: 'z', normal: 1, axes: ['x', 'y'] },
  { axis: 'x', normal: -1, axes: ['y', 'z'] }, { axis: 'x', normal: 1, axes: ['y', 'z'] }
]
const INSET = 0.001
const EDGE_MARGIN = 0.02
const EPSILON = 1e-10
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const key = point => `${point.x},${point.y},${point.z}`
const finite = point => point && AXES.every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000001)
const clamp = value => Math.max(EDGE_MARGIN, Math.min(1 - EDGE_MARGIN, value))
const air = block => block?.known === true && AIR.has(nameOf(block)) && !(block.extra ?? []).some(layer => !AIR.has(nameOf(layer)))
const emptyTorch = block => block?.known === true && nameOf(block) === 'torch' && block.boundingBox === 'empty' && !block.extra?.length

function argumentsFor ({ eye, target, world, maxReach = 4.5, removed = new Set() }) {
  if (!finite(eye) || !finite(target) || !AXES.every(axis => Number.isSafeInteger(target[axis])) || typeof world?.getBlock !== 'function' || !Number.isFinite(maxReach) || maxReach <= 0 || maxReach > 6 || !(removed instanceof Set)) throw new Error('照準には既知地形、有限の目線、整数の対象と適切な射程が必要です。')
  return { eye, target, maxReach, removed, read: point => world.getBlock(point.x, point.y, point.z) }
}

function trace (settings, point) {
  const { eye, target, read, removed, maxReach } = settings
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
  const clear = point => removed.has(key(point)) || air(read(point)) || emptyTorch(read(point))
  let entry = 0
  let face = null
  for (let count = 0; count < 128; count++) {
    if (key(cell) === key(target)) {
      if (face === null || entry < 0 || entry > 1 || length * entry > maxReach + EPSILON) return null
      return { point: { ...point }, hit: Object.fromEntries(AXES.map(axis => [axis, eye[axis] + delta[axis] * entry])), face, distance: length * entry }
    }
    if (!clear(cell)) return null
    const crossing = Math.min(next.x, next.y, next.z)
    if (!Number.isFinite(crossing) || crossing > 1 || crossing * length > maxReach + EPSILON) return null
    const crossed = AXES.filter(axis => Math.abs(next[axis] - crossing) <= EPSILON)
    // A ray exactly on an edge must not clip through an unexamined solid or
    // unknown side cell. Edge hits have no unique attack face, so reject them.
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

function traceBlockFace (options) {
  const settings = argumentsFor(options)
  return trace(settings, options.point)
}

function selectVisibleBlockFace (options) {
  const settings = argumentsFor(options)
  const cache = new Map()
  const read = settings.read
  settings.read = point => { const id = key(point); if (!cache.has(id)) cache.set(id, read(point)); return cache.get(id) }
  const { eye, target } = settings
  const candidates = []
  for (let face = 0; face < FACES.length; face++) {
    const definition = FACES[face]
    const plane = target[definition.axis] + Number(definition.normal > 0)
    if ((eye[definition.axis] - plane) * definition.normal <= EPSILON) continue
    const projected = definition.axes.map(axis => clamp(eye[axis] - target[axis]))
    const samples = [projected, [0.5, 0.5]]
    for (const u of [EDGE_MARGIN, 0.2, 0.5, 0.8, 1 - EDGE_MARGIN]) for (const v of [EDGE_MARGIN, 0.2, 0.5, 0.8, 1 - EDGE_MARGIN]) samples.push([u, v])
    const seen = new Set()
    for (const [u, v] of samples) {
      const id = `${u},${v}`
      if (seen.has(id)) continue
      seen.add(id)
      const point = { ...target, [definition.axis]: plane - definition.normal * INSET }
      point[definition.axes[0]] += u
      point[definition.axes[1]] += v
      const aimed = trace(settings, point)
      if (aimed?.face === face) candidates.push(aimed)
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.face - b.face)
  return candidates[0] ?? null
}

module.exports = { selectVisibleBlockFace, traceBlockFace }
