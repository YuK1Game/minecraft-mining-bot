'use strict'

// Quarry (露天掘り) region math, spec v1.2 §3. Pure functions: no world access.
// All ranges are inclusive integer world coordinates.

const CHUNK = 16
const safeInt = value => Number.isSafeInteger(value) && Math.abs(value) <= 30000000
const key = (x, y, z) => `${x},${y},${z}`
const columnKey = (x, z) => `${x},${z}`

// floor, never truncation toward zero: -1 -> -1, -16 -> -1, -17 -> -2.
function chunkOf (blockX, blockZ) {
  if (!safeInt(blockX) || !safeInt(blockZ)) throw new TypeError('Block coordinates must be safe integers')
  return { x: Math.floor(blockX / CHUNK), z: Math.floor(blockZ / CHUNK) }
}

function chunkBounds (chunk) {
  if (!safeInt(chunk?.x) || !safeInt(chunk?.z)) throw new TypeError('Chunk coordinates must be safe integers')
  const xMin = chunk.x * CHUNK
  const zMin = chunk.z * CHUNK
  return { xMin, xMax: xMin + CHUNK - 1, zMin, zMax: zMin + CHUNK - 1 }
}

function normalizeChunks (target) {
  const list = []
  if (Array.isArray(target?.chunks)) list.push(...target.chunks)
  if (target?.rect) {
    const { x1, z1, x2, z2 } = target.rect
    if (![x1, z1, x2, z2].every(safeInt)) throw new TypeError('Chunk rectangle needs integer x1/z1/x2/z2')
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) list.push({ x, z })
  }
  if (!list.length) throw new Error('Quarry target needs at least one chunk')
  const seen = new Map()
  for (const chunk of list) {
    chunkBounds(chunk)
    seen.set(columnKey(chunk.x, chunk.z), { x: chunk.x, z: chunk.z })
  }
  if (seen.size > 64) throw new Error('Quarry target is limited to 64 chunks')
  return [...seen.values()]
}

function normalizeBox (box) {
  const values = ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'].map(name => box?.[name])
  if (!values.every(safeInt)) throw new TypeError('Region boxes need integer xMin/xMax/yMin/yMax/zMin/zMax')
  return {
    xMin: Math.min(box.xMin, box.xMax), xMax: Math.max(box.xMin, box.xMax),
    yMin: Math.min(box.yMin, box.yMax), yMax: Math.max(box.yMin, box.yMax),
    zMin: Math.min(box.zMin, box.zMax), zMax: Math.max(box.zMin, box.zMax)
  }
}
const inBox = (box, p) => p.x >= box.xMin && p.x <= box.xMax && p.y >= box.yMin && p.y <= box.yMax && p.z >= box.zMin && p.z <= box.zMax

// Builds the fixed region set for a job. yTop may be null while unobserved;
// then the seal region is not fixed yet (spec §3.3) and sealReady is false.
function buildRegions ({ target, yTop = null, yBottom, worldMinY = -64, worldMaxY = 319, boundarySeal = { enabled: true, horizontalMargin: 1 }, infrastructureRegion = [], protectedRegion = [], travelRegion = [] }) {
  if (!safeInt(worldMinY) || !safeInt(worldMaxY) || worldMinY > worldMaxY) throw new Error('Invalid world height range')
  const bottom = yBottom == null || yBottom === 'world_min' ? worldMinY : yBottom
  if (!safeInt(bottom) || bottom < worldMinY || bottom > worldMaxY) throw new Error('yBottom is outside the world height range')
  if (yTop != null && (!safeInt(yTop) || yTop < bottom || yTop > worldMaxY)) throw new Error('yTop must be between yBottom and the world top')
  const chunks = normalizeChunks(target)
  const columns = new Set()
  for (const chunk of chunks) {
    const b = chunkBounds(chunk)
    for (let x = b.xMin; x <= b.xMax; x++) for (let z = b.zMin; z <= b.zMax; z++) columns.add(columnKey(x, z))
  }
  const margin = boundarySeal?.horizontalMargin ?? 1
  if (!Number.isSafeInteger(margin) || margin < 0 || margin > 4) throw new Error('horizontalMargin must be 0..4')
  const sealColumns = new Set()
  const sealEnabled = boundarySeal?.enabled !== false && margin > 0
  if (sealEnabled) {
    // Union of each chunk grown by margin, minus the whole excavation set:
    // neighbouring target chunks share no internal seal (spec §3.3, T27).
    for (const chunk of chunks) {
      const b = chunkBounds(chunk)
      for (let x = b.xMin - margin; x <= b.xMax + margin; x++) {
        for (let z = b.zMin - margin; z <= b.zMax + margin; z++) {
          const k = columnKey(x, z)
          if (!columns.has(k)) sealColumns.add(k)
        }
      }
    }
  }
  const sealReady = sealEnabled && yTop != null
  return {
    chunks,
    yTop,
    yTopProvisional: yTop == null,
    yBottom: bottom,
    worldMinY,
    worldMaxY,
    columns,
    seal: { enabled: sealEnabled, ready: sealReady, columns: sealColumns, yMin: bottom, yMax: sealReady ? Math.min(yTop + 1, worldMaxY) : null },
    infrastructure: infrastructureRegion.map(normalizeBox),
    protected: protectedRegion.map(normalizeBox),
    travel: travelRegion.map(normalizeBox)
  }
}

function inExcavation (regions, p) {
  if (!regions.columns.has(columnKey(p.x, p.z)) || p.y < regions.yBottom) return false
  return regions.yTop == null ? p.y <= regions.worldMaxY : p.y <= regions.yTop
}
const inSeal = (regions, p) => regions.seal.ready && regions.seal.columns.has(columnKey(p.x, p.z)) && p.y >= regions.seal.yMin && p.y <= regions.seal.yMax
const inProtected = (regions, p) => regions.protected.some(box => inBox(box, p))
const inInfrastructure = (regions, p) => regions.infrastructure.some(box => inBox(box, p))

// Per-operation permission (spec §3.3). kind: 'break' | 'place' | 'seal' | 'travel'.
// Protected always wins. The seal region only allows seal placement.
function permits (regions, kind, p) {
  if (![p?.x, p?.y, p?.z].every(safeInt)) return { allowed: false, reason: 'INVALID_POSITION' }
  if (p.y < regions.worldMinY || p.y > regions.worldMaxY) return { allowed: false, reason: 'OUTSIDE_WORLD_HEIGHT' }
  if (inProtected(regions, p)) return { allowed: false, reason: 'PROTECTED' }
  const work = inExcavation(regions, p) || inInfrastructure(regions, p)
  if (kind === 'break' || kind === 'place') return work ? { allowed: true } : { allowed: false, reason: inSeal(regions, p) ? 'SEAL_ONLY' : 'OUTSIDE_PERMITTED_REGION' }
  if (kind === 'seal') return work || inSeal(regions, p) ? { allowed: true } : { allowed: false, reason: regions.seal.enabled && !regions.seal.ready ? 'SEAL_REGION_NOT_FIXED' : 'OUTSIDE_SEAL_REGION' }
  if (kind === 'travel') return work || regions.travel.some(box => inBox(box, p)) ? { allowed: true } : { allowed: false, reason: 'OUTSIDE_TRAVEL_REGION' }
  return { allowed: false, reason: 'UNKNOWN_OPERATION' }
}

// Serpentine (boustrophedon) order of one chunk layer as a candidate list.
// The planner reorders it for footing; this is not an execution script (§5.1).
function serpentineLayer (chunk, y, { startCorner = 'min' } = {}) {
  const b = chunkBounds(chunk)
  const rows = []
  for (let z = b.zMin; z <= b.zMax; z++) {
    const row = []
    for (let x = b.xMin; x <= b.xMax; x++) row.push({ x, y, z })
    rows.push(row)
  }
  if (startCorner === 'max') rows.reverse()
  return rows.flatMap((row, index) => index % 2 ? row.reverse() : row)
}

module.exports = { CHUNK, chunkOf, chunkBounds, normalizeChunks, buildRegions, inExcavation, inSeal, permits, serpentineLayer, key, columnKey }
