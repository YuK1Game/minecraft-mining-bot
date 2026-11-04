'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { createNavigator } = require('./navigation')
const { evaluateThreats } = require('./threats')
const AXES = ['x', 'y', 'z'], CONTACT = 1e-4
const AIR = new Set(['air', 'cave_air', 'void_air'])
const EMPTY = new Set([...AIR, 'torch', 'leaf_litter', 'short_grass', 'fern', 'deadbush'])
const SOLID = new Set(['stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'netherrack', 'bedrock', ...['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'].flatMap(n => [`${n}_ore`, `deepslate_${n}_ore`])])
const COVER_TYPES = new Set(['minecraft:skeleton', 'minecraft:zombie'])
const finite = p => p && AXES.every(a => Number.isFinite(p[a]) && Math.abs(p[a]) <= 30000000)
const key = p => `${p.x},${p.y},${p.z}`
const name = b => String(b?.name ?? '').replace(/^minecraft:/, '')
const copy = v => structuredClone(v)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const fail = (message, code) => Object.assign(new Error(message), { code })
const validId = (v, signed = false) => typeof v === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(v)
function returnScope (s) {
  const life = s?.lifecycle?.deathId ?? s?.deathId
  if (!s?.profile || s.realm?.id == null || !s.connectionId || !s.startedAt || s.dimension !== 'overworld' || !validId(String(s.runtimeEntityId)) || !Number.isSafeInteger(life) || life < 0) throw fail('Current return connection/world/life scope is required', 'SCOPE_UNKNOWN')
  return JSON.stringify([s.profile, String(s.realm.id), s.dimension, s.connectionId, s.startedAt, String(s.runtimeEntityId), life])
}
function geometry (b) {
  if (b?.known !== true) return 'unknown'
  if (b.extra?.length) return 'unsupported'
  if (EMPTY.has(name(b)) && (AIR.has(name(b)) || b.boundingBox === 'empty')) return 'clear'
  return SOLID.has(name(b)) && b.boundingBox === 'block' ? 'solid' : 'unsupported'
}
function bodyRays (eye, target) {
  const starts = [0.15, 0.9, 1.62].map(h => ({ x: eye.x, y: eye.y - 1.62 + h, z: eye.z })), ends = [0.15, 0.95, 1.9].map(h => ({ x: target.x, y: target.y + h, z: target.z }))
  return [...starts.flatMap(from => ends.map(to => ({ from, to, corner: false }))), ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, z]) => ({ from: { x: eye.x + x * 0.29, y: eye.y, z: eye.z + z * 0.29 }, to: { x: target.x - x * 0.35, y: target.y + 1.9, z: target.z - z * 0.35 }, corner: true }))]
}
function traceCover (world, from, to, corner) {
  const read = p => geometry(world.getBlock(p.x, p.y, p.z)), cell = Object.fromEntries(AXES.map(a => [a, Math.floor(from[a])])), end = Object.fromEntries(AXES.map(a => [a, Math.floor(to[a])]))
  if (read(cell) !== 'clear' || !['clear', ...(corner ? ['solid'] : [])].includes(read(end))) return { ready: false, code: 'COVER_ENDPOINT_UNKNOWN' }
  const delta = Object.fromEntries(AXES.map(a => [a, to[a] - from[a]])), step = Object.fromEntries(AXES.map(a => [a, Math.sign(delta[a])])), next = Object.fromEntries(AXES.map(a => [a, delta[a] ? (cell[a] + Number(delta[a] > 0) - from[a]) / delta[a] : Infinity])), inc = Object.fromEntries(AXES.map(a => [a, delta[a] ? 1 / Math.abs(delta[a]) : Infinity]))
  const length = distance(from, to)
  let entry = 0, run = 0, longest = 0, cells = 0, mostCells = 0, runCells = 0
  for (let n = 0; n < 128; n++) {
    const type = read(cell), crossing = Math.min(...AXES.map(a => next[a]), 1)
    if (!['clear', 'solid'].includes(type)) return { ready: false, code: 'COVER_UNKNOWN_OR_UNSUPPORTED', at: { ...cell } }
    if (type === 'solid' && key(cell) !== key(end) && crossing > entry + 1e-10) { run += (crossing - entry) * length; runCells++; cells++; longest = Math.max(longest, run); mostCells = Math.max(mostCells, runCells) } else { run = 0; runCells = 0 }
    if (crossing >= 1) return { ready: longest >= 1 - CONTACT && mostCells >= 1, code: longest >= 1 - CONTACT ? null : 'COVER_OPEN_OR_TOO_THIN', barrierLength: longest, barrierCells: mostCells, checkedSolidCells: cells }
    const axes = AXES.filter(a => Math.abs(next[a] - crossing) < 1e-10)
    for (let mask = 1; mask < 1 << axes.length; mask++) { const p = { ...cell }; axes.forEach((a, i) => { if (mask & 1 << i) p[a] += step[a] }); if (!['clear', 'solid'].includes(read(p))) return { ready: false, code: 'COVER_EDGE_UNKNOWN', at: p } }
    for (const a of axes) { cell[a] += step[a]; next[a] += inc[a] }
    entry = crossing
  }
  return { ready: false, code: 'COVER_RAY_LIMIT' }
}
function proveReturnCover ({ world, eye, actor }) {
  if (!finite(eye) || !COVER_TYPES.has(actor?.entityType) || actor.kind !== 'mob' || actor.hostile !== true || actor.alive !== true || actor.positionKnown !== true || !finite(actor.position) || !validId(String(actor.runtimeId)) || !validId(String(actor.uniqueId), true)) return { ready: false, code: 'COVER_ACTOR_UNSUPPORTED' }
  const rays = bodyRays(eye, actor.position).map(ray => traceCover(world, ray.from, ray.to, ray.corner))
  return { ready: rays.every(r => r.ready), code: rays.find(r => !r.ready)?.code ?? null, rays: 13, minimumBarrierLength: Math.min(...rays.map(r => r.barrierLength ?? 0)), minimumBarrierCells: Math.min(...rays.map(r => r.barrierCells ?? 0)) }
}
function segmentDistance (p, a, b) {
  const v = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, length = v.x * v.x + v.y * v.y + v.z * v.z
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * v.x + (p.y - a.y) * v.y + (p.z - a.z) * v.z) / length)) : 0
  return Math.hypot(p.x - a.x - v.x * t, p.y - a.y - v.y * t, p.z - a.z - v.z * t)
}
function actorsOf (state) {
  if (!Array.isArray(state.entities) || !Number.isSafeInteger(state.entityStats?.unknownPositions) || state.entityStats.unknownPositions < 0) throw fail('Current complete actor observations are required', 'ACTORS_UNKNOWN')
  const e = evaluateThreats(state, state.entities, { observationRadius: 32 })
  if (e.requiresObservation || state.entityStats.unknownPositions > e.unknownPositions.length) throw fail('An actor position is unknown', 'ACTORS_UNKNOWN')
  const byId = new Map(state.entities.map(a => [String(a.runtimeId), a])), all = [...new Map([...e.threats, ...e.outsideDanger, ...e.suppressedByTerrain].map(a => [a.runtimeId, a])).values()]
  if (all.length > 64) throw fail('Return actor limit reached', 'ACTOR_LIMIT')
  return all.map(a => ({ id: String(a.runtimeId), position: { ...a.position }, minDistance: a.dangerRadius, padding: 0, actor: byId.get(String(a.runtimeId)) }))
}
function knownSky (world, feet) {
  for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) for (let y = Math.ceil(feet.y + 1.8); y <= 319; y++) {
    const b = world.getBlock(x, y, z)
    if (b?.known !== true || !AIR.has(name(b)) || b.extra?.length) return false
  }
  return true
}
function frameAllowed ({ world, state, from, to, circles, exceptions }) {
  for (const old of exceptions) { const current = circles.find(c => c.id === old.id)?.actor; if (!current || current.uniqueId !== old.actor.uniqueId || current.entityType !== old.actor.entityType || current.dimension !== old.actor.dimension) return false }
  for (const circle of circles) {
    const old = exceptions.find(e => e.id === circle.id)
    if (old && segmentDistance(circle.position, from, to) < circle.minDistance + circle.padding - CONTACT) {
      const actor = circle.actor
      if (!actor || actor.uniqueId !== old.actor.uniqueId || actor.entityType !== old.actor.entityType || actor.dimension !== old.actor.dimension) return false
      const samples = Math.max(1, Math.ceil(distance(from, to) / 0.1))
      for (let n = 0; n <= samples; n++) { const t = n / samples, eye = Object.fromEntries(AXES.map(a => [a, from[a] + (to[a] - from[a]) * t])); if (!proveReturnCover({ world, eye, actor }).ready) return false }
    } else if (segmentDistance(circle.position, from, to) < circle.minDistance + circle.padding - CONTACT) return false
  }
  return true
}
function * observedGroundReturnSteps ({ state, world, physics, radius = 12, up = 12, down = 1 }) {
  const scope = returnScope(state)
  if (state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.lifecycle?.dead || !(state.health > 0) || !finite(state.position) || !['survival', 0].includes(state.gameMode)) throw fail('A living survival player is required', 'NOT_READY')
  if (![radius, up, down].every(Number.isInteger) || radius < 1 || radius > 12 || up < 1 || up > 12 || down < 0 || down > 2) throw fail('Invalid bounded return graph', 'INVALID_BOUNDS')
  const navigator = createNavigator({ world, physics, version: '1.26.60' }), initial = physics.fromServer(state)
  if (!navigator.verifyOrigin(initial)) return { ready: false, code: 'SETTLE_REQUIRED', scope, surfaceReached: false }
  const canonical = actorsOf(state), eye = state.position, exceptions = canonical.filter(c => proveReturnCover({ world, eye, actor: c.actor }).ready).map(c => ({ id: c.id, actor: copy(c.actor), canonicalRadius: c.minDistance, policy: 'return_known_full_solid_body_corner_rays_v1' }))
  yield
  const searchAvoidance = canonical.filter(c => !exceptions.some(e => e.id === c.id)).map(({ actor, ...circle }) => circle)
  if (knownSky(world, initial.position)) return { ready: true, scope, surfaceReached: true, target: copy(initial.position), waypoints: [], initial, canonical, exceptions, predictionOnly: state.positionSource === 'client_prediction', serverConfirmed: false }
  const origin = { x: Math.floor(initial.position.x), y: Math.round(initial.position.y), z: Math.floor(initial.position.z) }, nodes = new Map()
  let unknown = 0
  for (let x = origin.x - radius; x <= origin.x + radius; x++) {
    for (let z = origin.z - radius; z <= origin.z + radius; z++) for (let y = origin.y - down; y <= Math.min(317, origin.y + up); y++) {
    const floor = world.getBlock(x, y - 1, z), body = world.getBlock(x, y, z), head = world.getBlock(x, y + 1, z)
    if ([floor, body, head].some(b => b?.known !== true)) { unknown++; continue }
    if (geometry(floor) === 'solid' && geometry(body) === 'clear' && geometry(head) === 'clear') nodes.set(key({ x, y, z }), { x, y, z })
    }
    yield
  }
  if (!nodes.has(key(origin))) return { ready: false, code: 'ORIGIN_UNKNOWN', scope, unknown, surfaceReached: false }
  const queue = [origin], parents = new Map([[key(origin), null]])
  for (let index = 0; index < queue.length && index < 1024; index++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [1, 0, -1]) {
    const next = { x: queue[index].x + dx, y: queue[index].y + dy, z: queue[index].z + dz }, id = key(next)
    if (queue.length < 1024 && nodes.has(id) && !parents.has(id)) { parents.set(id, key(queue[index])); queue.push(next) }
  }
  const ranked = []
  for (let index = 0; index < queue.length; index++) {
    const p = queue[index], sky = knownSky(world, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
    if (p.y > origin.y || sky && key(p) !== key(origin)) ranked.push({ ...p, sky, order: index })
    if (index % 16 === 15) yield
  }
  ranked.sort((a, b) => Number(b.sky) - Number(a.sky) || (a.sky ? a.order - b.order : b.y - a.y || Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z)))
  const tried = new Set()
  for (const goal of ranked) {
    const path = []
    for (let id = key(goal); parents.get(id) != null; id = parents.get(id)) { const p = nodes.get(id); path.push({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }) }
    path.reverse(); const waypoints = path.slice(0, 2), target = waypoints.at(-1)
    if (!target || tried.has(key(target))) continue
    tried.add(key(target)); if (tried.size > 4) break
    const route = navigator.plan(initial, target, { maxDistance: 12, maxExpanded: 500, avoidance: searchAvoidance })
    if (!route.ready) continue
    const stepper = navigator.createStepper(route, initial, { maxTicks: 80, sprint: false }), frames = []
    let previous = eye, valid = true
    try { for (let tick = 0; tick < 80; tick++) { const f = stepper.next(), next = f.packetPosition; if (!frameAllowed({ world, state, from: previous, to: next, circles: canonical, exceptions })) { valid = false; break }; frames.push(f); previous = next; if (f.phase !== 'moving') break; if (tick % 2 === 1) yield } } catch { valid = false }
    const last = frames.at(-1)
    if (valid && last?.phase === 'awaiting_server_confirmation' && navigator.verifyOrigin(last.predictedState)) {
      const needed = exceptions.filter(exception => {
        const circle = canonical.find(c => c.id === exception.id)
        let from = eye
        for (const frame of frames) { if (segmentDistance(circle.position, from, frame.packetPosition) < circle.minDistance + circle.padding - CONTACT) return true; from = frame.packetPosition }
        return false
      })
      return { ready: true, scope, surfaceReached: false, target, waypoints, route, frames, initial, canonical, exceptions: needed, unknown, highestKnownY: goal.y, observedGround: nodes.size, predictionOnly: true, serverConfirmed: false }
    }
  }
  return { ready: false, code: unknown ? 'RETURN_NEEDS_OBSERVATION' : 'NO_COVERED_ASCENT', scope, unknown, surfaceReached: false, canonical, exceptions }
}
function planObservedGroundReturn (options) { const iterator = observedGroundReturnSteps(options); let step; do { step = iterator.next() } while (!step.done); return step.value }
function createSurfaceReturn ({ getState, world, movement, getMovement, getQueuedCursor = null, physics, canAct, onProgress = () => {}, clock = Date.now, delay = (ms, signal) => sleep(ms, undefined, { signal }) }) {
  if ([getState, getMovement, canAct, clock, delay].some(f => typeof f !== 'function') || !world?.getBlock || !physics?.fromServer || ['preview', 'start', 'stop'].some(k => typeof movement?.[k] !== 'function')) throw new Error('Surface return needs current scoped state, world, prepared physics and owned normal movement')
  if (getQueuedCursor != null && typeof getQueuedCursor !== 'function') throw new Error('Return queued cursor must be an actual receipt callback')
  let active = null, task = null, sequence = 0, status = { phase: 'idle', busy: false, surfaceReached: false, serverConfirmed: false }
  const snapshot = () => copy(status)
  const emit = () => { try { onProgress(snapshot()) } catch {} }
  function read (run) {
    const s = getState(), scope = returnScope(s)
    if (s.phase !== 'spawned' || s.dead || s.isDead || s.spawnPending || s.lifecycle?.dead || !(s.health > 0)) throw fail('Return requires the current living player', 'NOT_ALIVE')
    if (s.positionSource === 'client_prediction') {
      const p = s.predicted, physical = p?.physicsState, at = typeof p?.updatedAt === 'number' ? p.updatedAt : Date.parse(p?.updatedAt)
      if (!finite(p?.position) || !finite(physical?.position) || !finite(physical?.velocity) || distance(p.position, s.position) > CONTACT || distance({ ...physical.position, y: physical.position.y + 1.62 }, s.position) > CONTACT || p.updatedAt !== s.positionUpdatedAt || !Number.isFinite(at) || clock() - at < 0 || clock() - at > 200) throw fail('Current modeled return pose is stale or inconsistent', 'POSE_UNTRUSTED')
    }
    if (run && (run.scope !== scope || s.threatPolicy !== run.policy || s.health < run.health || !canAct({ operationId: run.id, scope }) || run.controller.signal.aborted || clock() >= run.deadline)) throw fail('Return scope, policy, health or owner changed', 'RETURN_INTERRUPTED')
    return s
  }
  function ownsMove (run) { const m = getMovement(); return run.started && m?.timingDiagnostics?.start?.at === run.moveStamp && m.target && key(m.target) === key(run.target) }
  async function cleanup (run, reason) { if (ownsMove(run) && canAct({ operationId: run.id, scope: run.scope })) { movement.stop(reason); await movement.drain?.() } }
  function preview (options = {}) { try { return planObservedGroundReturn({ state: read(), world, physics, ...options }) } catch (error) { return { ready: false, code: error.code ?? 'PREVIEW_FAILED', reason: error.message, surfaceReached: false } } }
  async function waitNeutralSettled (run) {
    if (!getQueuedCursor) throw fail('Actual neutral input receipts are required between return legs', 'SETTLE_RECEIPT_REQUIRED')
    const first = read(run), scope = returnScope(first), origin = copy(first.position), deadline = Math.min(run?.deadline ?? Infinity, clock() + 1000)
    let previous = null, stable = 0
    if (run) { status = { ...status, phase: 'settling' }; emit() }
    while (clock() < deadline) {
      const s = read(run), cursor = getQueuedCursor(), p = s.predicted, physical = p?.physicsState, stamp = typeof p?.updatedAt === 'number' ? p.updatedAt : Date.parse(p?.updatedAt)
      if (returnScope(s) !== scope || s.health < first.health || distance(s.position, origin) > 0.4 || getMovement()?.running) throw fail('Return settling scope, position or movement changed', 'STALE_POSE')
      let tick = null
      try { if (cursor?.tick != null) tick = BigInt(cursor.tick) } catch {}
      const wireScope = JSON.stringify([s.connectionId, s.startedAt]), controls = physical?.controls
      const neutral = controls && Object.keys(controls).every(k => ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(k) && controls[k] === false)
      const actual = tick != null && tick >= 0n && cursor?.source === 'actual_client_queue_receipt' && cursor.scope === wireScope && Number.isFinite(cursor.queuedAt) && clock() - cursor.queuedAt >= 0 && clock() - cursor.queuedAt <= 200 && Number.isFinite(stamp) && stamp >= cursor.queuedAt && p?.source === 'client_prediction'
      const grounded = physical?.onGround === true && !physical.isInWater && !physical.isInLava && finite(physical.velocity) && Math.hypot(physical.velocity.x, physical.velocity.z) < 0.006 && neutral
      if (actual && grounded && (!previous || tick > previous.tick)) {
        stable = previous && tick === previous.tick + 1n && distance(previous.position, s.position) <= CONTACT ? stable + 1 : 0
        previous = { tick, position: copy(s.position) }
        if (stable >= 3) { if (run) { status = { ...status, settle: { queuedTick: String(tick), queuedAt: cursor.queuedAt, stableFrames: stable, positionUpdatedAt: s.positionUpdatedAt } }; emit() }; return s }
      } else if (!actual || !grounded) { previous = null; stable = 0 }
      await delay(20, run?.controller.signal)
    }
    throw fail('Fresh queued neutral ground did not settle within one second', 'SETTLE_TIMEOUT')
  }
  async function planAsync (s, options, run) {
    const iterator = observedGroundReturnSteps({ state: s, world, physics, ...options })
    while (true) { const step = iterator.next(); if (step.done) return step.value; await delay(0, run?.controller.signal); const fresh = read(run); if (returnScope(fresh) !== returnScope(s) || fresh.health < s.health || distance(fresh.position, s.position) > CONTACT) throw fail('Return origin changed during planning', 'STALE_POSE') }
  }
  async function previewAsync (options = {}) { try { return await planAsync(getQueuedCursor ? await waitNeutralSettled() : read(), options) } catch (error) { return { ready: false, code: error.code ?? 'PREVIEW_FAILED', reason: error.message, surfaceReached: false } } }
  async function execute (options = {}, { signal } = {}) {
    if (active) throw fail('Surface return is already running', 'BUSY')
    const maxLegs = options.maxLegs ?? 4
    if (!Number.isInteger(maxLegs) || maxLegs < 1 || maxLegs > 8) throw fail('Invalid bounded return batch', 'INVALID_BOUNDS')
    const initial = read(), controller = new AbortController(), run = { id: ++sequence, scope: returnScope(initial), policy: initial.threatPolicy, health: initial.health, controller, started: false, deadline: clock() + 30000 }
    if (signal?.aborted) controller.abort(signal.reason)
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true })
    active = run; status = { phase: 'planning', busy: true, scope: run.scope, surfaceReached: false, origin: copy(initial.position), legs: 0, serverConfirmed: false }; emit()
    task = (async () => {
      try {
        for (let leg = 0; leg < maxLegs; leg++) {
          if (clock() >= run.deadline) throw fail('Bounded return deadline reached', 'TIMEOUT')
          if (leg > 0 && !getQueuedCursor) throw fail('Actual neutral receipts are required for another return leg', 'SETTLE_RECEIPT_REQUIRED')
          const s = getQueuedCursor ? await waitNeutralSettled(run) : read(run), plan = await planAsync(s, { radius: options.radius, up: options.up, down: options.down }, run)
          if (!plan.ready) throw fail(plan.code, plan.code)
          if (plan.surfaceReached) { status = { ...status, phase: 'surface_ready', busy: false, surfaceReached: true, feetPosition: copy(plan.initial.position), scope: run.scope, health: s.health, positionUpdatedAt: s.positionUpdatedAt, surfaceProof: { source: 'current_known_full_standing_and_received_air_to319', scope: run.scope, feetPosition: copy(plan.initial.position), positionUpdatedAt: s.positionUpdatedAt, health: s.health, predictionOnly: s.positionSource === 'client_prediction', serverConfirmed: false }, predictionOnly: true, serverConfirmed: false }; emit(); return snapshot() }
          if (getMovement()?.running) throw fail('Another movement is active', 'BUSY')
          const beforeInput = frame => { const fresh = read(run), next = frame.packetPosition, feet = frame.predictedState?.position; if (!finite(next) || !finite(feet) || distance(next, { ...feet, y: feet.y + 1.62 }) > 1e-6) return false; return frameAllowed({ world, state: fresh, from: fresh.position, to: next, circles: actorsOf(fresh), exceptions: plan.exceptions }) }
          const moveOptions = { allowWater: false, sprint: false, maxDistance: 12, maxExpanded: 500, maxTicks: 80, avoidance: plan.canonical.filter(c => !plan.exceptions.some(e => e.id === c.id)).map(({ actor, ...c }) => c), beforeInput }
          await delay(0, controller.signal); read(run)
          if (!movement.preview(plan.target, moveOptions)?.ready) throw fail('Current return prefix changed', 'REPLAN_REQUIRED')
          const receipt = movement.start(plan.target, moveOptions); run.target = plan.target; run.started = true; run.moveStamp = (getMovement()?.timingDiagnostics?.start?.at ?? receipt?.timingDiagnostics?.start?.at)
          status = { ...status, phase: 'ascending', target: copy(plan.target), canonicalCircles: plan.canonical.map(({ actor, ...c }) => c), coverExceptions: plan.exceptions.map(e => ({ id: e.id, uniqueId: e.actor.uniqueId, entityType: e.actor.entityType, canonicalRadius: e.canonicalRadius, policy: e.policy })), legs: leg + 1 }; emit()
          let arrived = false
          for (let ticks = 0; ticks < 100 && clock() < run.deadline; ticks++) { const fresh = read(run), m = getMovement(); if (!ownsMove(run)) throw fail('Return movement ownership changed', 'OWNER_CHANGED'); if (m.phase === 'awaiting_server_confirmation' && m.physicsState?.onGround && distance(m.physicsState.position, plan.target) <= 0.4 && distance(fresh.position, { ...m.physicsState.position, y: m.physicsState.position.y + 1.62 }) <= CONTACT && fresh.positionUpdatedAt !== s.positionUpdatedAt) { arrived = true; break }; if (['failed', 'stopped', 'replan_required'].includes(m.phase)) throw fail(m.reason ?? 'Return prefix interrupted', 'REPLAN_REQUIRED'); await delay(50, controller.signal) }
          if (!arrived) throw fail('No fresh full return-prefix landing was observed', 'TIMEOUT')
          const landing = read(run)
          status = { ...status, position: copy(landing.position), feetPosition: { ...landing.position, y: landing.position.y - 1.62 }, positionUpdatedAt: landing.positionUpdatedAt, health: landing.health }
          await cleanup(run, 'Return prefix complete'); run.started = false
        }
        status = { ...status, phase: 'predicted', busy: false, surfaceReached: false, partial: true, predictionOnly: true, serverConfirmed: false }; emit(); return snapshot()
      } catch (error) { status = { ...status, phase: 'stopped', busy: false, code: error.code ?? 'RETURN_FAILED', reason: error.message, surfaceReached: false, serverConfirmed: false }; emit(); throw error }
      finally { signal?.removeEventListener('abort', abort); await cleanup(run, status.reason ?? 'Return batch ended'); if (active === run) active = null }
    })()
    return task
  }
  function cancel (reason = 'Surface return cancelled') { if (active) active.controller.abort(fail(reason, 'CANCELLED')) }
  async function stop (reason) { cancel(reason); try { await task } catch {}; return snapshot() }
  return { preview, previewAsync, execute, cancel, stop, drain: () => task ?? Promise.resolve(), snapshot }
}
module.exports = { createSurfaceReturn, planObservedGroundReturn, proveReturnCover, returnScope }
