'use strict'

const { performance } = require('node:perf_hooks')

// Bounded walk-route evidence for hostiles. A hostile inside the engage radius
// counts as engageable only while a walkable route from the bot to the
// hostile is computable over received blocks. A hostile with known "no route"
// evidence (e.g. the bot is in a hole the hostile cannot walk into) is neither
// a combat/escape trigger nor a movement-avoidance circle; normal work and
// exploration continue instead.
// Evidence is one recent flood fill of the bot's walkable region. It stays
// valid while the bot remains inside that region, so walking around does not
// flip a hostile back to a threat; leaving the region, a truncated fill, or
// stale evidence means "unknown" and the normal threat policy applies.
// This is a cheap block-grid fill (no physics), never a movement plan: actual
// approach still uses the native navigator and its own checks.
const POLICY = 'grid_walk_reachability_v3'
const ENGAGE_RADIUS = 32
const MELEE_REACH = 2.8
const TTL_MS = 3000
const REFRESH_MS = 500
const MAX_NODES = 12000
const BUDGET_MS = 30
const FILL_TIME_LIMIT_MS = 15
const SEEK_TARGETS = 3
const SEEK_MAX_NODES = 4000
const SEEK_TIME_LIMIT_MS = 10
const CELL_CACHE_LIMIT = 300000
const SEEK_REUSE_DISTANCE = 3
const MAX_DROP = 3
const AXES = ['x', 'y', 'z']
const HAZARD = /(?:lava|fire|magma|cactus|sweet_berry|powder_snow|wither_rose|campfire)/
const finite = p => p && AXES.every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 30000000)
const idOf = e => e?.runtimeId ?? e?.runtimeEntityId ?? e?.entityId ?? e?.id ?? null
let fill = null
let verdicts = []
let nextRefreshAt = -Infinity

function distance (a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }

function nearSeen (seen, p) {
  const tx = Math.floor(p.x), ty = Math.floor(p.y), tz = Math.floor(p.z)
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) if (seen.has(`${tx + dx},${ty + dy},${tz + dz}`)) return true
  return false
}

// true = route, false = known no route, null = unknown.
function verdict (state, entity, now = Date.now()) {
  if (!fill || !finite(state?.position) || !finite(entity?.position) || idOf(entity) == null) return null
  if (now - fill.createdAt > TTL_MS || now < fill.createdAt - 50 || fill.dimension !== (state.dimension ?? null)) return null
  if (entity.dimension != null && entity.dimension !== state.dimension) return null
  const feet = { ...state.position, y: state.position.y - 1.62 }
  if (!nearSeen(fill.seen, feet)) return null
  if (Math.hypot(entity.position.x - fill.origin.x, entity.position.z - fill.origin.z) > ENGAGE_RADIUS) return null
  if (nearSeen(fill.seen, entity.position)) return true
  const sought = fill.targets?.get(String(idOf(entity)))
  if (sought && Math.hypot(entity.position.x - sought.position.x, entity.position.y - sought.position.y, entity.position.z - sought.position.z) <= SEEK_REUSE_DISTANCE && sought.result !== null) return sought.result
  return fill.truncated || fill.unknown ? null : false
}

// True only with fresh evidence that no route exists.
function knownUnreachable (state, entity, now = Date.now()) { return verdict(state, entity, now) === false }
// True only with fresh evidence that a route exists.
function knownReachable (state, entity, now = Date.now()) { return verdict(state, entity, now) === true }
// Combat decisions need an answer now: without fresh evidence for this pose,
// run one bounded fill immediately (still under the fill time budget).
// Forced fills are rate limited: selection asks per candidate every tick, and
// while the bot moves every answer can be stale; never block the loop on it.
let lastForcedAt = -Infinity
const FORCE_INTERVAL_MS = 250
function reachableNow (state, entity, { world, entities = [entity], now = Date.now() } = {}) {
  if (verdict(state, entity, now) === null && typeof world?.getBlock === 'function' && (now - lastForcedAt >= FORCE_INTERVAL_MS || now < lastForcedAt)) {
    lastForcedAt = now
    refresh(state, entities, { world, now, force: true })
  }
  return verdict(state, entity, now) === true
}

// 'open' = body can occupy, 'solid' = can stand on, 'water', 'hazard', 'unknown'
function kind (block) {
  if (!block?.known) return 'unknown'
  const name = String(block.name ?? '').replace(/^minecraft:/, '')
  if (HAZARD.test(name) || (block.extra ?? []).some(layer => HAZARD.test(String(layer?.name ?? '')))) return 'hazard'
  if (/water/.test(name) || (block.extra ?? []).some(layer => /water/.test(String(layer?.name ?? '')))) return 'water'
  if (block.boundingBox === 'empty') return 'open'
  if (block.boundingBox === 'block') return 'solid'
  return 'unknown'
}

// Cell kinds shared between fills while the world revision is unchanged (any
// received world packet bumps it). Worlds without a revision get a fresh map.
let shared = { world: null, revision: null, getBlock: null, map: new Map() }
function cellCache (world) {
  const revision = typeof world?.revision === 'function' ? world.revision() : null
  if (revision == null) return new Map()
  if (shared.world !== world || shared.revision !== revision || shared.getBlock !== world.getBlock) shared = { world, revision, getBlock: world.getBlock, map: new Map() }
  return shared.map
}

// Both searches must preserve the same three-way evidence. In particular,
// unreceived support is not a wall and a cache hit is still unknown evidence.
function walkGrid (world) {
  const cache = cellCache(world)
  let unknown = false
  const at = (x, y, z) => {
    const id = `${x},${y},${z}`
    let value = cache.get(id)
    if (value === undefined) {
      value = kind(world.getBlock(x, y, z)); cache.set(id, value)
      if (cache.size > CELL_CACHE_LIMIT) cache.clear()
    }
    if (value === 'unknown') unknown = true
    return value
  }
  const body = (x, y, z) => {
    const lower = at(x, y, z)
    if (lower !== 'open' && lower !== 'water') return false
    const upper = at(x, y + 1, z)
    return upper === 'open' || upper === 'water'
  }
  const stand = (x, y, z) => body(x, y, z) && (at(x, y, z) === 'water' || at(x, y - 1, z) === 'solid')
  const originKnown = ({ x, y, z }) => {
    const lower = at(x, y, z), upper = at(x, y + 1, z)
    if (lower === 'unknown' || upper === 'unknown') return false
    // The existing water route uses water itself as support. Its unseen bed
    // must not invalidate a route entirely through received water cells.
    return lower === 'water' || at(x, y - 1, z) !== 'unknown'
  }
  return { at, body, stand, originKnown, unknown: () => unknown }
}

// Flood fill of standable cells from the bot's feet cell within the radius.
function walkableCells (world, feet, { radius = ENGAGE_RADIUS, maxNodes = MAX_NODES, maxMs = FILL_TIME_LIMIT_MS } = {}) {
  // Hard time budget: a fill that runs out is truncated (unknown evidence),
  // so it can never hold the input/heartbeat loop for long.
  const deadline = performance.now() + maxMs
  const grid = walkGrid(world), { at, body, stand } = grid
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  if (!grid.originKnown(start)) return { seen: new Set(), truncated: false, unknown: true, origin: start }
  const seen = new Set([`${start.x},${start.y},${start.z}`]); const queue = [start]
  let truncated = false
  for (let i = 0; i < queue.length; i++) {
    if (seen.size >= maxNodes || (i & 63) === 0 && performance.now() > deadline) { truncated = true; break }
    const c = queue[i]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, nz = c.z + dz
      if (Math.hypot(nx - start.x, nz - start.z) > radius) continue
      // Step up one (needs headroom above the current cell), level, or drop.
      for (let ny = c.y + 1; ny >= c.y - MAX_DROP; ny--) {
        if (ny === c.y + 1 && !['open', 'water'].includes(at(c.x, c.y + 2, c.z))) continue
        if (ny < c.y && !body(nx, c.y, nz)) break
        if (!stand(nx, ny, nz)) { if (ny <= c.y && ['solid', 'hazard'].includes(at(nx, ny, nz))) break; continue }
        const id = `${nx},${ny},${nz}`
        if (!seen.has(id)) { seen.add(id); queue.push({ x: nx, y: ny, z: nz }) }
        break
      }
    }
  }
  return { seen, truncated, unknown: grid.unknown(), origin: start }
}

// Targeted search toward one hostile (greedy best-first over the same
// standable-cell moves). Used when the radius flood fill ran out of budget on
// rough terrain: it answers that hostile without scanning the whole disk.
// true = reached, false = searched out over known terrain, null = unknown/budget.
function seekCells (world, feet, goal, { radius = ENGAGE_RADIUS, maxNodes = SEEK_MAX_NODES, maxMs = SEEK_TIME_LIMIT_MS } = {}) {
  const deadline = performance.now() + maxMs
  const grid = walkGrid(world), { at, body, stand } = grid
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  if (!grid.originKnown(start)) return null
  const g = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) }
  const h = c => Math.hypot(c.x - g.x, c.z - g.z) + Math.abs(c.y - g.y) * 0.5
  const heap = [], push = c => { c.f = h(c); heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top }
  const seen = new Set([`${start.x},${start.y},${start.z}`]); push(start)
  let n = 0
  while (heap.length) {
    if (seen.size >= maxNodes || (++n & 31) === 0 && performance.now() > deadline) return null
    const c = pop()
    if (Math.hypot(c.x - g.x, c.z - g.z) <= 1.5 && Math.abs(c.y - g.y) <= 2) return true
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, nz = c.z + dz
      if (Math.hypot(nx - start.x, nz - start.z) > radius) continue
      for (let ny = c.y + 1; ny >= c.y - MAX_DROP; ny--) {
        if (ny === c.y + 1 && !['open', 'water'].includes(at(c.x, c.y + 2, c.z))) continue
        if (ny < c.y && !body(nx, c.y, nz)) break
        if (!stand(nx, ny, nz)) { if (ny <= c.y && ['solid', 'hazard'].includes(at(nx, ny, nz))) break; continue }
        const id = `${nx},${ny},${nz}`
        if (!seen.has(id)) { seen.add(id); push({ x: nx, y: ny, z: nz }) }
        break
      }
    }
  }
  return grid.unknown() ? null : false
}

// One bounded flood fill per interval. Callers read state many times per tick
// and the fill must never starve the input/packet loop.
function refresh (state, entities, { world, isHostile = e => e?.hostile === true && e?.alive !== false, now = Date.now(), force = false } = {}) {
  if (typeof world?.getBlock !== 'function' || !finite(state?.position) || !Array.isArray(entities)) return
  if (!force && now < nextRefreshAt) return
  nextRefreshAt = now + REFRESH_MS
  const due = entities.filter(e => isHostile(e) && e.positionKnown !== false && finite(e.position) && idOf(e) != null && (e.dimension == null || e.dimension === state.dimension))
    .map(e => ({ e, d: distance(state.position, e.position) })).filter(({ d }) => d > MELEE_REACH && d <= ENGAGE_RADIUS)
  if (!due.length) return
  const started = performance.now()
  let grid
  try { grid = walkableCells(world, { ...state.position, y: state.position.y - 1.62 }) } catch { return }
  const elapsed = performance.now() - started
  fill = { policy: POLICY, createdAt: now, dimension: state.dimension ?? null, ...grid, cells: grid.seen.size, elapsedMs: Math.round(elapsed * 10) / 10, targets: new Map() }
  // A truncated fill leaves far hostiles unknown: answer the nearest few with
  // a targeted search instead (each bounded; the total stays small).
  if (grid.truncated) {
    const feet = { ...state.position, y: state.position.y - 1.62 }
    for (const { e } of due.slice().sort((a, b) => a.d - b.d).slice(0, SEEK_TARGETS)) {
      if (nearSeen(grid.seen, e.position)) continue
      let result = null
      try { result = seekCells(world, feet, e.position) } catch { result = null }
      fill.targets.set(String(idOf(e)), { position: { ...e.position }, result })
    }
    fill.elapsedMs = Math.round((performance.now() - started) * 10) / 10
  }
  verdicts = due.map(({ e, d }) => ({ runtimeId: String(idOf(e)), entityType: e.entityType ?? null, distance: d, reachable: verdict(state, e, now) }))
  // A slow fill backs off so it stays a small share of the event loop.
  if (elapsed > BUDGET_MS) nextRefreshAt = now + Math.min(4000, elapsed * 20)
}

function snapshot () { return fill ? { policy: fill.policy, createdAt: fill.createdAt, cells: fill.cells, truncated: fill.truncated, unknownTouched: fill.unknown, elapsedMs: fill.elapsedMs, origin: fill.origin, hostiles: verdicts } : null }
function clear () { fill = null; verdicts = []; nextRefreshAt = -Infinity; lastForcedAt = -Infinity }

module.exports = { ENGAGE_RADIUS, MELEE_REACH, refresh, verdict, knownReachable, knownUnreachable, reachableNow, walkableCells, seekCells, snapshot, clear }
