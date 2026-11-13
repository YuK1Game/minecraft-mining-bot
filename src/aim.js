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
// Fixed face samples after the projected eye point: centre first, then a 5x5 grid.
const FACE_GRID = [[0.5, 0.5]]
for (const u of [EDGE_MARGIN, 0.2, 0.5, 0.8, 1 - EDGE_MARGIN]) for (const v of [EDGE_MARGIN, 0.2, 0.5, 0.8, 1 - EDGE_MARGIN]) if (u !== 0.5 || v !== 0.5) FACE_GRID.push([u, v])
const SHORT_NAMES = new Map()
const nameOf = block => {
  const full = String(block?.name ?? '')
  let short = SHORT_NAMES.get(full)
  if (short === undefined) { short = full.replace(/^minecraft:/, ''); if (SHORT_NAMES.size < 4096) SHORT_NAMES.set(full, short) }
  return short
}
const { pointKey: key } = require('./vec3')
const finite = point => point && AXES.every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000001)
const clamp = value => Math.max(EDGE_MARGIN, Math.min(1 - EDGE_MARGIN, value))
const air = block => block?.known === true && AIR.has(nameOf(block)) && !(block.extra ?? []).some(layer => !AIR.has(nameOf(layer)))
const emptyTorch = block => block?.known === true && nameOf(block) === 'torch' && block.boundingBox === 'empty' && !block.extra?.length

function argumentsFor ({ eye, target, world, maxReach = 4.5, removed = new Set() }) {
  if (!finite(eye) || !finite(target) || !AXES.every(axis => Number.isSafeInteger(target[axis])) || typeof world?.getBlock !== 'function' || !Number.isFinite(maxReach) || maxReach <= 0 || maxReach > 6 || !(removed instanceof Set)) throw new Error('照準には既知地形、有限の目線、整数の対象と適切な射程が必要です。')
  return { eye, target, maxReach, removed, read: point => world.getBlock(point.x, point.y, point.z) }
}

// Hot path: the quarry planner traces dozens of rays per candidate block, so
// this walk uses scalar locals instead of per-step objects and strings. The
// arithmetic (and therefore every result) is the same as the original
// object-based version; test/aim-trace-equivalence.test.js pins that.
function trace (settings, point) {
  const { eye, target, read, removed, maxReach } = settings
  if (!finite(point) || !AXES.every(axis => point[axis] > target[axis] && point[axis] < target[axis] + 1)) return null
  const targetBlock = read(target)
  if (!targetBlock?.known || AIR.has(nameOf(targetBlock)) || emptyTorch(targetBlock) || (targetBlock.extra ?? []).some(layer => !AIR.has(nameOf(layer)))) return null
  const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z
  const length = Math.hypot(dx, dy, dz)
  if (!length) return null
  const tx = target.x, ty = target.y, tz = target.z
  let cx = Math.floor(eye.x), cy = Math.floor(eye.y), cz = Math.floor(eye.z)
  if (cx === tx && cy === ty && cz === tz) return null
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz)
  let nx = sx ? (cx + Number(sx > 0) - eye.x) / dx : Infinity
  let ny = sy ? (cy + Number(sy > 0) - eye.y) / dy : Infinity
  let nz = sz ? (cz + Number(sz > 0) - eye.z) / dz : Infinity
  const stx = sx ? 1 / Math.abs(dx) : Infinity, sty = sy ? 1 / Math.abs(dy) : Infinity, stz = sz ? 1 / Math.abs(dz) : Infinity
  const checkRemoved = removed.size > 0
  const cell = { x: 0, y: 0, z: 0 }
  const clear = (x, y, z) => {
    cell.x = x; cell.y = y; cell.z = z
    if (checkRemoved && removed.has(`${x},${y},${z}`)) return true
    const block = read(cell)
    return air(block) || emptyTorch(block)
  }
  let entry = 0
  let face = null
  for (let count = 0; count < 128; count++) {
    if (cx === tx && cy === ty && cz === tz) {
      if (face === null || entry < 0 || entry > 1 || length * entry > maxReach + EPSILON) return null
      return { point: { ...point }, hit: { x: eye.x + dx * entry, y: eye.y + dy * entry, z: eye.z + dz * entry }, face, distance: length * entry }
    }
    if (!clear(cx, cy, cz)) return null
    const crossing = Math.min(nx, ny, nz)
    if (!Number.isFinite(crossing) || crossing > 1 || crossing * length > maxReach + EPSILON) return null
    const hitX = Math.abs(nx - crossing) <= EPSILON, hitY = Math.abs(ny - crossing) <= EPSILON, hitZ = Math.abs(nz - crossing) <= EPSILON
    // A ray exactly on an edge must not clip through an unexamined solid or
    // unknown side cell. Edge hits have no unique attack face, so reject them.
    if (hitX + hitY + hitZ > 1) {
      for (let mask = 1; mask < 8; mask++) {
        if ((mask & 1 && !hitX) || (mask & 2 && !hitY) || (mask & 4 && !hitZ)) continue
        const ux = cx + (mask & 1 ? sx : 0), uy = cy + (mask & 2 ? sy : 0), uz = cz + (mask & 4 ? sz : 0)
        if ((ux === tx && uy === ty && uz === tz) || !clear(ux, uy, uz)) return null
      }
    }
    if (hitX) { cx += sx; nx += stx }
    if (hitY) { cy += sy; ny += sty }
    if (hitZ) { cz += sz; nz += stz }
    face = hitX ? (sx > 0 ? 4 : 5) : hitY ? (sy > 0 ? 0 : 1) : (sz > 0 ? 2 : 3)
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
  const { eye, target } = settings
  // Numeric cache keys near the target (rays never leave reach); strings beyond.
  const cacheKey = point => {
    const ox = point.x - target.x + 64, oy = point.y - target.y + 64, oz = point.z - target.z + 64
    return ox >= 0 && ox < 128 && oy >= 0 && oy < 128 && oz >= 0 && oz < 128 ? (ox * 128 + oy) * 128 + oz : key(point)
  }
  settings.read = point => { const id = cacheKey(point); let block = cache.get(id); if (block === undefined && !cache.has(id)) { block = read(point); cache.set(id, block) } return block }
  const candidates = []
  for (let face = 0; face < FACES.length; face++) {
    const definition = FACES[face]
    const plane = target[definition.axis] + Number(definition.normal > 0)
    if ((eye[definition.axis] - plane) * definition.normal <= EPSILON) continue
    const projected = definition.axes.map(axis => clamp(eye[axis] - target[axis]))
    // The projected point first, then the grid without any sample equal to it.
    for (let index = -1; index < FACE_GRID.length; index++) {
      const [u, v] = index < 0 ? projected : FACE_GRID[index]
      if (index >= 0 && u === projected[0] && v === projected[1]) continue
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
