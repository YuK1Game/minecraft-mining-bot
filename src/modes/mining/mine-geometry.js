'use strict'

const { createHash } = require('node:crypto')
// ladderMove permits at most 192 vertical blocks. A lower bottom-slab stand
// is half a block below its layer Y, leaving 191 whole blocks for the shaft.
const MAX_SHAFT_DEPTH = 191
const DIRECTIONS = Object.freeze({ east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 } })
const key = p => `${p.x},${p.y},${p.z}`
const faceOf = p => p.x === 1 ? 5 : p.x === -1 ? 4 : p.z === 1 ? 3 : 2
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const copy = value => structuredClone(value)
const lightingByPlan = new WeakMap()

function point (plan, u, y, v) {
  const f = DIRECTIONS[plan.site.direction], r = { x: -f.z, z: f.x }
  return { x: plan.site.anchor.x + f.x * u + r.x * v, y, z: plan.site.anchor.z + f.z * u + r.z * v }
}
function local (plan, p) {
  const f = DIRECTIONS[plan.site.direction], dx = p.x - plan.site.anchor.x, dz = p.z - plan.site.anchor.z
  return { u: dx * f.x + dz * f.z, v: -dx * f.z + dz * f.x, y: p.y }
}
function lineLength (segment) { return Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.z - segment.from.z) + 1 }
function along (segment) {
  return { x: Math.sign(segment.to.x - segment.from.x), z: Math.sign(segment.to.z - segment.from.z) }
}
function segmentPoint (segment, index, across = 0, dy = 0) {
  const f = segment.forward ?? along(segment), r = segment.right ?? { x: -f.z, z: f.x }
  return { x: segment.from.x + f.x * index + r.x * across, y: segment.from.y + dy, z: segment.from.z + f.z * index + r.z * across }
}
function inSegment (segment, p) {
  const f = segment.forward, r = segment.right, dx = p.x - segment.from.x, dz = p.z - segment.from.z
  const u = dx * f.x + dz * f.z, v = dx * r.x + dz * r.z
  return u >= 0 && u < lineLength(segment) && v >= 0 && v < segment.width && Number.isInteger(u) && Number.isInteger(v)
}

// Y is the lowest excavated cell; the bottom slab occupies Y-1 and supports
// feet at Y-0.5. The saved plan contains lines, never a whole terrain snapshot.
function createMineGeometry ({ scope, anchor, direction = 'east', width = 24, length = 24, surfaceY, upperY = 16, lowerY, expectedDrops = {}, cargoSlots = 43 } = {}) {
  if (!scope?.profile || !scope.realmId || scope.dimension !== 'overworld' || !anchor || !Number.isSafeInteger(anchor.x) || !Number.isSafeInteger(anchor.z) || !DIRECTIONS[direction] || ![width, length].every(n => Number.isInteger(n) && n >= 12 && n <= 32) || ![surfaceY, upperY, lowerY].every(Number.isInteger) || surfaceY < upperY + 3 || upperY < lowerY + 6 || lowerY < -60 || surfaceY > 316 || !Number.isInteger(cargoSlots) || cargoSlots < 1 || cargoSlots > 54) throw Error('MINE_GEOMETRY_INVALID')
  if (surfaceY - lowerY > MAX_SHAFT_DEPTH) throw Error('MINE_SHAFT_DEPTH_EXCEEDED')
  const plan = { version: 1, scope: copy(scope), site: { anchor: { ...anchor }, direction, width, length, surfaceY }, layers: [{ id: 'upper', y: upperY }, { id: 'lower', y: lowerY }], segments: [], storage: [], finish: { floor: 'bottom_slab', torchSpacing: 6, storageTorchSpacing: 4, lightTarget: 8 }, vein: { radius: 3, maxBlocks: 32 } }
  const mid = Math.floor((width - 2) / 2), f = DIRECTIONS[direction], r = { x: -f.z, z: f.x }
  const add = (layer, kind, id, u0, v0, u1, v1, w, h, walkOffset = 0) => {
    const from = point(plan, u0, layer.y, v0), to = point(plan, u1, layer.y, v1)
    const forward = u0 === u1 && v0 !== v1 ? { x: r.x * Math.sign(v1 - v0), z: r.z * Math.sign(v1 - v0) } : f
    plan.segments.push({ id: `${layer.id}:${id}`, layer: layer.id, kind, from, to, width: w, height: h, forward, right: { x: -forward.z, z: forward.x }, walkOffset })
  }
  for (const layer of plan.layers) {
    // Design allowance: excavated rock plus bounded vein drops. 43 usable
    // slots per 54-slot pair leave room for item types and uneven stack sizes.
    const estimate = expectedDrops[layer.id] ?? Math.ceil(length * (6 + 2 * width / 3) + 180)
    if (!Number.isSafeInteger(estimate) || estimate < 0) throw Error('MINE_DROP_ESTIMATE_INVALID')
    const estimatedDropStacks = Math.ceil(estimate / 64), cargo = Math.max(1, Math.ceil(estimatedDropStacks / cargoSlots)), pairCount = cargo + 1
    if (pairCount > 8) throw Error('MINE_STORAGE_CAPACITY_EXCEEDED')
    const roomLength = Math.max(4, (Math.ceil(pairCount / 2) - 1) * 3 + 2), roomEnd = 1 + roomLength
    if (roomEnd + 4 >= length) throw Error('MINE_STORAGE_ROOM_TOO_LARGE')
    add(layer, 'storage', 'lobby', 2, mid - 3, roomEnd, mid - 3, 8, 3, 3)
    add(layer, 'main', 'main', roomEnd + 1, mid, length - 1, mid, 2, 3)
    const pairs = []
    for (let i = 0; i < pairCount; i++) {
      const side = i % 2, u = 2 + Math.floor(i / 2) * 3, v = side ? mid + 3 : mid - 2
      pairs.push({ id: `${layer.id}:${i === cargo ? 'supply' : `cargo-${i}`}`, purpose: i === cargo ? 'supply' : 'cargo', positions: [point(plan, u, layer.y, v), point(plan, u + 1, layer.y, v)], facing: side ? { x: -r.x, z: -r.z } : { ...r } })
    }
    plan.storage.push({ layer: layer.id, pairs, estimatedDrops: estimate, estimatedDropStacks, cargoSlots, access: { from: point(plan, 2, layer.y, mid), to: point(plan, roomEnd, layer.y, mid) } })
    for (let u = roomEnd + 2; u < length - 1; u += 3) {
      add(layer, 'branch', `branch-${u}-left`, u, mid - 1, u, 0, 1, 2)
      add(layer, 'branch', `branch-${u}-right`, u, mid + 2, u, width - 1, 1, 2)
    }
  }
  const columns = [[0, mid], [1, mid], [0, mid + 1], [1, mid + 1]].map(([u, v]) => { const p = point(plan, u, 0, v); return { x: p.x, z: p.z } })
  const ladder = columns[0], back = point(plan, -1, 0, mid), backing = { x: back.x, z: back.z }
  const topLanding = point(plan, 0, surfaceY, mid - 1), entryTorch = point(plan, 1, surfaceY, mid - 1)
  plan.shaft = { topY: surfaceY, bottomY: lowerY, columns, ladder: { ...ladder, face: faceOf(f), support: backing }, fillColumns: columns.slice(1),
    approach: { ...point(plan, 2, surfaceY, mid), x: point(plan, 2, surfaceY, mid).x + 0.5, z: point(plan, 2, surfaceY, mid).z + 0.5 },
    topLanding: { ...topLanding, x: topLanding.x + 0.5, z: topLanding.z + 0.5 },
    entryTorch: { position: entryTorch, support: { ...entryTorch, y: surfaceY - 1 }, face: 1, name: 'minecraft:torch' },
    landings: plan.layers.map(layer => ({ layer: layer.id, y: layer.y, clear: [point(plan, 1, layer.y, mid), point(plan, 1, layer.y + 1, mid)], floor: [{ position: point(plan, 1, layer.y - 1, mid), half: 'bottom' }], stand: { ...point(plan, 1, layer.y - 0.5, mid), x: point(plan, 1, layer.y, mid).x + 0.5, z: point(plan, 1, layer.y, mid).z + 0.5 } })) }
  plan.id = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 20)
  return plan
}

function mineSteps (plan, { layer = null } = {}) {
  if (plan?.version !== 1 || !Array.isArray(plan.segments) || layer != null && !plan.layers.some(item => item.id === layer)) throw Error('MINE_PLAN_INVALID')
  const result = []
  for (const segment of plan.segments) if (layer == null || segment.layer === layer) {
    for (let offset = 0; offset < lineLength(segment); offset += 3) result.push({ id: `${segment.id}:${offset}`, segmentId: segment.id, layer: segment.layer, kind: segment.kind, offset, count: Math.min(3, lineLength(segment) - offset) })
  }
  return result
}

function stepCells (plan, step) {
  const segment = plan.segments.find(item => item.id === step?.segmentId)
  if (!segment || !Number.isInteger(step.offset) || step.offset < 0 || step.offset % 3 || step.id !== `${segment.id}:${step.offset}` || step.layer !== segment.layer || step.count !== Math.min(3, lineLength(segment) - step.offset) || step.count < 1) throw Error('MINE_STEP_INVALID')
  const clear = [], floor = [], torch = [], protectedCells = []
  const chestCells = new Set(plan.storage.flatMap(storage => storage.pairs.flatMap(pair => pair.positions)).map(key))
  for (let i = step.offset; i < step.offset + step.count; i++) for (let w = 0; w < segment.width; w++) {
    for (let y = 0; y < segment.height; y++) clear.push(segmentPoint(segment, i, w, y))
    const p = segmentPoint(segment, i, w, -1)
    if (!chestCells.has(key({ ...p, y: p.y + 1 }))) floor.push({ position: p, half: 'bottom' })
    protectedCells.push(p)
  }
  const torchSpacing = segment.kind === 'storage' ? plan.finish.storageTorchSpacing : plan.finish.torchSpacing
  // Put the main's first torch at the end of its first three-block step. A
  // torch at offset zero leaves the far lane of the next step at light seven
  // until the following six-block torch has actually been installed.
  const torchPhase = segment.kind === 'main' ? 2 : 0
  for (let i = step.offset; i < step.offset + step.count; i++) if (i % torchSpacing === torchPhase || i === lineLength(segment) - 1) {
    for (const w of [0, segment.width - 1]) {
      const p = segmentPoint(segment, i, w, 1), sign = w === 0 ? -1 : 1
      const support = { x: p.x + segment.right.x * sign, y: p.y, z: p.z + segment.right.z * sign }
      if (plan.segments.some(other => inSegment(other, support) && support.y >= other.from.y && support.y < other.from.y + other.height)) continue
      torch.push({ position: p, support, face: faceOf({ x: -segment.right.x * sign, z: -segment.right.z * sign }), name: 'minecraft:torch' })
      protectedCells.push(p, support)
      if (segment.kind !== 'storage') break
    }
  }
  const end = segmentPoint(segment, step.offset + step.count - 1, segment.walkOffset), before = segmentPoint(segment, step.offset - 1, segment.walkOffset)
  const feet = p => ({ x: p.x + 0.5, y: p.y - 0.5, z: p.z + 0.5 })
  return { clear, floor, torch, ladder: [], fill: [], stand: feet(end), approach: feet(before), protected: protectedCells }
}

function classifyMineCell (plan, p) {
  if (!integer(p)) return { allowedDig: false, protected: true, role: 'invalid' }
  if (plan.shaft.columns.some(c => c.x === p.x && c.z === p.z) && p.y >= plan.shaft.bottomY - 1 && p.y <= plan.shaft.topY + 2) return { allowedDig: false, protected: true, role: 'shaft' }
  for (const storage of plan.storage) for (const pair of storage.pairs) if (pair.positions.some(c => c.x === p.x && c.z === p.z && Math.abs(c.y - p.y) <= 1)) return { allowedDig: false, protected: true, role: 'storage', layer: storage.layer }
  // A fixed plan never changes its lines after construction begins. Build the
  // compact reservation index lazily so vein scans preserve every torch and
  // backing block, including an ore block used as a wall support.
  if (!lightingByPlan.has(plan)) {
    const reservations = new Map()
    for (const step of mineSteps(plan)) for (const torch of stepCells(plan, step).torch) for (const position of [torch.position, torch.support]) reservations.set(key(position), step.layer)
    if (plan.shaft.entryTorch) for (const position of [plan.shaft.entryTorch.position, plan.shaft.entryTorch.support]) reservations.set(key(position), 'surface')
    lightingByPlan.set(plan, reservations)
  }
  const lightingLayer = lightingByPlan.get(plan).get(key(p))
  if (lightingLayer) return { allowedDig: false, protected: true, role: 'lighting', layer: lightingLayer }
  for (const segment of plan.segments) if (inSegment(segment, p)) {
    if (p.y === segment.from.y - 1) return { allowedDig: false, protected: true, role: 'floor', layer: segment.layer }
    if (p.y >= segment.from.y && p.y < segment.from.y + segment.height) return { allowedDig: true, protected: false, role: segment.kind, layer: segment.layer }
  }
  const at = local(plan, p), within = at.u >= 0 && at.u < plan.site.length && at.v >= 0 && at.v < plan.site.width
  return { allowedDig: false, protected: !within, role: within ? 'vein_candidate' : 'outside' }
}

module.exports = { createMineGeometry, mineSteps, stepCells, classifyMineCell, point, local, lineLength, segmentPoint, DIRECTIONS, MAX_SHAFT_DEPTH, key }
