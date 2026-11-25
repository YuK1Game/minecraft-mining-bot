'use strict'

const { performance } = require('node:perf_hooks')
const { createTerrainCache } = require('../common/terrain-cache')
const { combatSearchBudgetFor } = require('./combat-search-budget')

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
  if (fill.scope !== scope(state) || fill.reader !== fill.world.getBlock || (fill.observer ? !fill.observer.current() : fill.revision !== fill.world.revision?.())) return null
  if (now - fill.createdAt > TTL_MS || now < fill.createdAt - 50 || fill.dimension !== (state.dimension ?? null)) return null
  if (entity.dimension != null && entity.dimension !== state.dimension) return null
  const feet = { ...state.position, y: state.position.y - 1.62 }
  if (!nearSeen(fill.seen, feet)) return null
  if (Math.hypot(entity.position.x - fill.origin.x, entity.position.z - fill.origin.z) > ENGAGE_RADIUS) return null
  const sought = fill.targets?.get(String(idOf(entity)))
  if (sought?.shutIn === true && Math.hypot(entity.position.x - sought.position.x, entity.position.y - sought.position.y, entity.position.z - sought.position.z) <= SEEK_REUSE_DISTANCE) return false
  if (nearSeen(fill.seen, entity.position)) return true
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

// Derived cell kinds survive unrelated packets; receipt/eviction of a section
// they actually read still invalidates them, including previously unknown cells.
let caches = new WeakMap()
function cellCache (world) {
  if (!caches.has(world)) caches.set(world, createTerrainCache(world, { maxEntries: CELL_CACHE_LIMIT }))
  const cache = caches.get(world)
  cache.begin()
  return cache
}

// Both searches must preserve the same three-way evidence. In particular,
// unreceived support is not a wall and a cache hit is still unknown evidence.
function walkGrid (world) {
  const cache = cellCache(world)
  let unknown = false
  const at = (x, y, z) => {
    const value = cache.read(x, y, z, () => kind(world.getBlock(x, y, z)))
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
function * walkableCellSteps (world, feet, { radius = ENGAGE_RADIUS, maxNodes = MAX_NODES } = {}) {
  const grid = walkGrid(world), { at, body, stand } = grid
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  if (!grid.originKnown(start)) return { seen: new Set(), truncated: false, unknown: true, origin: start }
  const seen = new Set([`${start.x},${start.y},${start.z}`]); const queue = [start]
  let truncated = false
  for (let i = 0; i < queue.length; i++) {
    if (seen.size >= maxNodes) { truncated = true; break }
    yield { seen, truncated: true, unknown: grid.unknown(), origin: start }
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
function * seekCellSteps (world, feet, goal, { radius = ENGAGE_RADIUS, maxNodes = SEEK_MAX_NODES } = {}) {
  const grid = walkGrid(world), { at, body, stand } = grid
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  if (!grid.originKnown(start)) return null
  const g = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) }
  const h = c => Math.hypot(c.x - g.x, c.z - g.z) + Math.abs(c.y - g.y) * 0.5
  const heap = [], push = c => { c.f = h(c); heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top }
  const seen = new Set([`${start.x},${start.y},${start.z}`]); push(start)
  while (heap.length) {
    if (seen.size >= maxNodes) return null
    yield null
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

// CPU accounting excludes the time a continuation spends waiting for its next
// event-loop slice. Budget exhaustion preserves partial/unknown evidence.
function * boundedSteps (iterator, maxMs, progress = null) {
  let used = 0
  try {
    for (;;) {
      const started = performance.now(), next = iterator.next()
      used += performance.now() - started
      progress?.(next.value)
      if (next.done || used >= maxMs) return next.value
      yield next.value
    }
  } finally { iterator.return() }
}
function drain (iterator) { let next; do { next = iterator.next() } while (!next.done); return next.value }
function drainTimed (iterator, maxMs) {
  const deadline = performance.now() + maxMs
  let next
  try {
    do { next = iterator.next() } while (!next.done && performance.now() < deadline)
    return next.value
  } finally { iterator.return() }
}
function walkableCells (world, feet, options = {}) { return drainTimed(walkableCellSteps(world, feet, options), options.maxMs ?? FILL_TIME_LIMIT_MS) }
function seekCells (world, feet, goal, options = {}) { return drainTimed(seekCellSteps(world, feet, goal, options), options.maxMs ?? SEEK_TIME_LIMIT_MS) }

// The other direction, for a hostile the fills above could not answer (an
// unreceived block anywhere in the 32 m disk makes them "unknown"): a small
// fill from the hostile's own cell. When every cell it can walk to is received,
// the region ends well inside the search radius and the bot is not in it, the
// hostile is shut in and cannot come (real Realm 2026-11-16 12:20-12:50 JST: a
// drowned at the bottom of a six-deep dry shaft 6.8 m away held idle
// protection, the flee and all work for half an hour at health 2).
// Only pits deeper than three blocks below the bot count.
// true = shut in, null = no such evidence.
const PIT_RADIUS = 8
const PIT_MAX_NODES = 300
const PIT_TIME_LIMIT_MS = 6
const CAVE_WALKER_RADIUS = 10
const CAVE_WALKER_MAX_NODES = 350
const CAVE_WALKER = /(?:^|:)(?:zombie|husk|drowned|zombie_villager|zombified_piglin|piglin|vindicator|silverfish)$/
function shutIn (world, position, botFeet, { maxMs = PIT_TIME_LIMIT_MS } = {}) {
  // A quarter block up: a mob standing at y = 63.9999 is in the cell above.
  const feet = { x: position.x, y: position.y + 0.25, z: position.z }
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  const probe = walkGrid(world)
  if (!probe.body(start.x, start.y, start.z) || probe.unknown()) return null
  const region = walkableCells(world, feet, { radius: PIT_RADIUS, maxNodes: PIT_MAX_NODES, maxMs })
  if (region.truncated || region.unknown || nearSeen(region.seen, botFeet)) return null
  for (const id of region.seen) {
    const [x, y, z] = id.split(',').map(Number)
    if (Math.hypot(x - start.x, z - start.z) >= PIT_RADIUS - 1.5) return null
    // Only a pit deeper than the bot's own drop limit: the fill from the bot
    // would agree, and a shallow hole leaves an archer's head in the open.
    if (y > Math.floor(botFeet.y) - MAX_DROP - 1) return null
  }
  return true
}

// Single-pass pit/cave check from the hostile's cell:
// - For any hostile: enclosed within PIT_RADIUS and deeper than MAX_DROP.
// - For a non-climbing melee walker (zombie/husk/drowned/etc.): even in a long
//   cave tunnel past PIT_RADIUS, if every received cell within CAVE_WALKER_RADIUS
//   stays at least MAX_DROP + 1 below botFeet (with no unknown blocks), it cannot
//   climb to the bot without walking > 10 m away (invalidating the 3 m reuse window).
function * checkTrappedSteps (world, position, botFeet, { walker = false, maxMs = PIT_TIME_LIMIT_MS } = {}) {
  const feet = { x: position.x, y: position.y + 0.25, z: position.z }
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }
  const ceilingY = Math.floor(botFeet.y) - MAX_DROP - 1
  if (start.y > ceilingY) return { trapped: null, why: 'shallow_start' }
  const probe = walkGrid(world)
  if (!probe.body(start.x, start.y, start.z) || probe.unknown()) return { trapped: null, why: probe.unknown() ? 'start_unknown' : 'start_blocked' }
  const radius = walker ? CAVE_WALKER_RADIUS : PIT_RADIUS
  const maxNodes = walker ? CAVE_WALKER_MAX_NODES : PIT_MAX_NODES
  const region = yield * boundedSteps(walkableCellSteps(world, feet, { radius, maxNodes }), maxMs)
  if (region.truncated) return { trapped: null, why: `truncated:${region.seen.size}` }
  if (region.unknown) return { trapped: null, why: `unknown:${region.seen.size}` }
  if (nearSeen(region.seen, botFeet)) return { trapped: null, why: 'reached_bot' }
  let maxY = -Infinity, maxDist = 0
  for (const id of region.seen) {
    const [x, y, z] = id.split(',').map(Number)
    if (y > maxY) maxY = y
    if (y > ceilingY) return { trapped: null, why: `rose_y=${y}>${ceilingY}` }
    const d = Math.hypot(x - start.x, z - start.z)
    if (d > maxDist) maxDist = d
  }
  if (!walker && maxDist >= PIT_RADIUS - 1.5) return { trapped: null, why: `open_r=${maxDist.toFixed(1)}` }
  return { trapped: true, why: 'trapped' }
}

function undergroundWalker (world, position, botFeet, { maxMs = PIT_TIME_LIMIT_MS } = {}) {
  return drain(checkTrappedSteps(world, position, botFeet, { walker: true, maxMs })).trapped
}

// Refresh is a resumable search, charged to the same normal allowance as
// attack-access searches. Each node is an interruption point; contact keeps
// its separate urgent allowance. No timer or state read drains the whole job.
let pending = null
const scope = state => JSON.stringify([state.profile, state.realm?.id, state.connectionId, state.startedAt, state.runtimeEntityId, state.dimension, state.lifecycle?.deathId])
function * refreshSteps (job) {
  const { state, due, world, fillMs, pitMs, evidence } = job
  const feet = { ...state.position, y: state.position.y - 1.62 }
  const nearest = due.slice().sort((a, b) => a.d - b.d).slice(0, SEEK_TARGETS)
  // Deep one-way drops need the reverse proof before a forward fill can be
  // interpreted as attack access. These small probes also finish promptly
  // when a distant unknown section makes the larger disk inconclusive.
  for (const { e } of nearest) {
    if (Math.floor(e.position.y + 0.25) > Math.floor(feet.y) - MAX_DROP - 1) continue
    let result = { trapped: null, why: 'error' }
    try { result = yield * checkTrappedSteps(world, e.position, feet, { walker: CAVE_WALKER.test(String(e.entityType ?? '')), maxMs: pitMs }) } catch {}
    job.pitReasons.set(String(idOf(e)), result.why)
    if (result.trapped === true) evidence.targets.set(String(idOf(e)), { position: { ...e.position }, result: false, shutIn: true })
  }
  let grid
  try { grid = yield * boundedSteps(walkableCellSteps(world, feet), fillMs, part => { Object.assign(evidence, part, { cells: part.seen.size }) }) } catch { return }
  Object.assign(evidence, grid, { cells: grid.seen.size })
  if (grid.truncated) for (const { e } of nearest) {
    if (nearSeen(grid.seen, e.position) || evidence.targets.get(String(idOf(e)))?.shutIn) continue
    let result = null
    try { result = yield * boundedSteps(seekCellSteps(world, feet, e.position), SEEK_TIME_LIMIT_MS) } catch {}
    evidence.targets.set(String(idOf(e)), { position: { ...e.position }, result })
  }
}
function refresh (state, entities, { world, isHostile = e => e?.hostile === true && e?.alive !== false, now = Date.now(), force = false, fillMs = FILL_TIME_LIMIT_MS, pitMs = PIT_TIME_LIMIT_MS, budget = null } = {}) {
  if (typeof world?.getBlock !== 'function' || !finite(state?.position) || !Array.isArray(entities)) return
  const valid = job => job.world === world && job.reader === world.getBlock && job.scope === scope(state) && distance(state.position, job.state.position) <= SEEK_REUSE_DISTANCE && (job.observer ? job.observer.current() : job.revision === world.revision?.())
  if (pending && !valid(pending)) { pending.iterator.return(); pending = null }
  if (!pending) {
    if (!force && now < nextRefreshAt) return
    nextRefreshAt = now + REFRESH_MS
    const due = entities.filter(e => isHostile(e) && e.positionKnown !== false && finite(e.position) && idOf(e) != null && (e.dimension == null || e.dimension === state.dimension))
      .map(e => ({ e: { ...e, position: { ...e.position } }, d: distance(state.position, e.position) })).filter(({ d }) => d > MELEE_REACH && d <= ENGAGE_RADIUS)
    if (!due.length) return
    const origin = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
    const observer = world.observeTerrain?.() ?? null
    const evidence = { policy: POLICY, createdAt: now, dimension: state.dimension ?? null, scope: scope(state), observer, world, reader: world.getBlock, revision: world.revision?.(), seen: new Set([`${origin.x},${origin.y},${origin.z}`]), origin, truncated: true, unknown: false, cells: 1, elapsedMs: 0, targets: new Map(), pending: true }
    pending = { state: { ...state, position: { ...state.position } }, due, world, reader: world.getBlock, revision: world.revision?.(), scope: scope(state), observer, evidence, fillMs, pitMs, cpuMs: 0, pitReasons: new Map() }
    pending.iterator = refreshSteps(pending)
    fill = evidence
  }
  const job = pending, sharedBudget = budget ?? combatSearchBudgetFor(world)
  let complete = false
  const result = sharedBudget.search(maxMs => {
    const started = performance.now(), deadline = started + maxMs
    try {
      do {
        const next = job.observer ? job.observer.run(() => job.iterator.next()) : job.iterator.next()
        if (next.done) { complete = true; break }
      } while (performance.now() < deadline)
    } finally { job.cpuMs += performance.now() - started }
  }, { maxMs: 8 })
  if (!result.executed) return
  fill.elapsedMs = Math.round(job.cpuMs * 10) / 10
  verdicts = job.due.map(({ e, d }) => ({ runtimeId: String(idOf(e)), entityType: e.entityType ?? null, distance: d, reachable: verdict(state, e, now), pitWhy: job.pitReasons.get(String(idOf(e))) ?? null }))
  if (complete) {
    fill.pending = false; pending = null
    nextRefreshAt = now + (job.cpuMs > BUDGET_MS ? Math.min(4000, job.cpuMs * 20) : REFRESH_MS)
  }
}

function snapshot () { return fill ? { policy: fill.policy, createdAt: fill.createdAt, cells: fill.cells, truncated: fill.truncated, pending: fill.pending, unknownTouched: fill.unknown, elapsedMs: fill.elapsedMs, origin: fill.origin, hostiles: verdicts } : null }
function clear () { pending?.iterator.return(); pending = null; fill = null; verdicts = []; nextRefreshAt = -Infinity; lastForcedAt = -Infinity; caches = new WeakMap() }

module.exports = { ENGAGE_RADIUS, MELEE_REACH, refresh: require('../common/work-spans').wrap('reachability.refresh', refresh), verdict, knownReachable, knownUnreachable, reachableNow, walkableCells, seekCells, shutIn, undergroundWalker, snapshot, clear }
