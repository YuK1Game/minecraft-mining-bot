'use strict'

const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { observedScope } = require('./server-position-verifier')
const { normalizeChunkArea, areaContainsFeet } = require('./chunk-area')
const { plainAir, passableSiteBody, supportIssue } = require('./storage-site-terrain')
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) < 30000000)
const feetOf = state => finite(state?.position) ? { x: state.position.x, y: state.position.y - 1.62, z: state.position.z } : null
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const hazard = /water|lava|fire|magma|cactus|campfire|powder|cobweb|wither_rose|dripstone/
const fail = code => Object.assign(new Error(code), { code })
const reasons = {
  CHUNK_TRAVEL_NO_KNOWN_STAND: '選択範囲に、受信済みの安全な足場が見つかりません（現在地から48m以内）。',
  CHUNK_TRAVEL_NO_ROUTE: '選択範囲までの歩行経路が見つかりません。',
  CHUNK_TRAVEL_NO_SHORT_PREFIX: '経路の最初の区間を決められません。',
  CHUNK_TRAVEL_SHORT_ROUTE_UNCONFIRMED: '次の区間の歩行経路を確認できません。',
  CHUNK_TRAVEL_MOVE_FAILED: '歩行が途中で止まりました。',
  CHUNK_TRAVEL_MOVE_ENDED_SHORT: '区間の目標の手前で止まりました。',
  CHUNK_TRAVEL_LEG_TIMEOUT: '区間の歩行が制限時間内に終わりませんでした。',
  CHUNK_TRAVEL_TIMEOUT: '制限時間内に到着できませんでした。',
  CHUNK_TRAVEL_LEG_LIMIT: '区間数の上限に達しました。',
  CHUNK_TRAVEL_DAMAGED: '被弾したため停止しました。',
  CHUNK_TRAVEL_CONTEXT_CHANGED: '接続・生存回・ジョブのいずれかが変わったため停止しました。',
  CHUNK_TRAVEL_POSITION_UNCONFIRMED: 'サーバーで現在位置を確認できませんでした。',
  CHUNK_TRAVEL_ARRIVAL_UNSAFE: '到着した足場が安全ではありません。',
  CHUNK_TRAVEL_TERRAIN_CHANGED: '歩行の直前に地形が変わりました。',
  CHUNK_TRAVEL_ORIGIN_CHANGED: '経路の確認中にBotの位置が動きました。',
  CHUNK_TRAVEL_BUSY: '他の作業中のため移動を開始できません。',
  CHUNK_TRAVEL_RELEASE_FAILED: '移動後の後片付けに失敗しました。',
  CHUNK_TRAVEL_CANCELLED: '移動を中断しました。'
}
const errorView = (error, hint = null) => {
  const code = /^CHUNK_TRAVEL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CHUNK_TRAVEL_FAILED'
  const hinted = typeof hint === 'string' && hint.trim() ? `（${hint.trim().slice(0, 120)}）` : ''
  return { code, message: `移動を完了できませんでした。${reasons[code] ?? '現在位置と経路を確認してください。'}${hinted}` }
}
const softCorner = new Set(['CHUNK_TRAVEL_NO_ROUTE', 'CHUNK_TRAVEL_NO_SHORT_PREFIX', 'CHUNK_TRAVEL_SHORT_ROUTE_UNCONFIRMED', 'CHUNK_TRAVEL_MOVE_FAILED', 'CHUNK_TRAVEL_MOVE_ENDED_SHORT', 'CHUNK_TRAVEL_LEG_TIMEOUT', 'CHUNK_TRAVEL_LEG_LIMIT'])
const round = p => finite(p) ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : 'unknown'

function createChunkTravel ({ getState, getBlock, getMovement, planRoute, previewMove, startMove, stopMove, confirmPosition,
  acquire, release, generation, jobIdentity, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  uuid = randomUUID, maxDistance = 48, maxTravelDistance = 128, maxLegs = 32, timeoutMs = 180000, legTimeoutMs = 20000, pollMs = 50 } = {}) {
  if ([getState, getBlock, getMovement, planRoute, previewMove, startMove, stopMove, confirmPosition, acquire, release, generation, jobIdentity, now, sleep, uuid].some(fn => typeof fn !== 'function')) throw TypeError('Chunk travel requires owned ordinary movement and actual position witnesses')
  if (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 48 || !Number.isFinite(maxTravelDistance) || maxTravelDistance <= 0 || maxTravelDistance > 128 || !Number.isInteger(maxLegs) || maxLegs < 1 || maxLegs > 32 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || !Number.isFinite(legTimeoutMs) || legTimeoutMs < 1 || legTimeoutMs > timeoutMs || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 1000) throw TypeError('Chunk travel bounds must be finite')
  let task = null, owner = null, active = null
  const read = p => getBlock(p.x, p.y, p.z)
  const pathBody = block => passableSiteBody(block) || block?.known === true && block.name === 'minecraft:wildflowers' && block.boundingBox === 'empty' && !block.extra?.length
  function dryStand (p, bodyAllowed = plainAir) {
    if (!finite(p) || p.y < -63 || p.y > 317 || Math.abs(p.y - Math.round(p.y)) > 0.02) return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const cell = { x: Math.floor(p.x + dx), y: Math.round(p.y), z: Math.floor(p.z + dz) }
      const body = read(cell), head = read({ ...cell, y: cell.y + 1 }), floor = read({ ...cell, y: cell.y - 1 })
      if (![body, head, floor].every(block => block?.known === true && !block.protected && !block.protectionSource) || !bodyAllowed(body) || !bodyAllowed(head) || supportIssue(read, cell)) return false
    }
    return true
  }
  function knownRoutePoint (p, medium) {
    if (!finite(p) || p.y < -63 || p.y > 317) return false
    if (medium === 'land') return dryStand(p, pathBody)
    if (medium !== 'water') return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const x = Math.floor(p.x + dx), z = Math.floor(p.z + dz)
      for (let y = Math.floor(p.y + 1e-6); y <= Math.floor(p.y + 1.8 - 1e-6); y++) {
        const block = read({ x, y, z }), water = /^minecraft:(?:flowing_)?water$/.test(block?.name ?? '')
        if (block?.known !== true || block.extra?.length || !water && (!passableSiteBody(block) || hazard.test(block.name ?? ''))) return false
      }
      let supported = false
      for (let y = Math.floor(p.y - 1e-6); y >= Math.floor(p.y - 1e-6) - 1; y--) {
        const block = read({ x, y, z })
        if (block?.known !== true || block.extra?.length) return false
        if (block.boundingBox === 'block') { supported = p.y - y - 1 >= -0.02 && p.y - y - 1 <= 1.05 && supportIssue(read, { x, y: y + 1, z }) === null; break }
        if (!plainAir(block) && !/^minecraft:(?:flowing_)?water$/.test(block.name ?? '')) return false
      }
      if (!supported) return false
    }
    return true
  }
  function guard (run) {
    if (owner !== run || run.controller.signal.aborted) throw run.controller.signal.reason ?? fail('CHUNK_TRAVEL_CANCELLED')
    const state = getState(), feet = feetOf(state)
    if (observedScope(state) !== run.scope || generation() !== run.generation || !isDeepStrictEqual(jobIdentity(), run.job)) throw fail('CHUNK_TRAVEL_CONTEXT_CHANGED')
    if (!feet || state.health < run.health) throw fail('CHUNK_TRAVEL_DAMAGED')
    run.health = state.health
    if (now() >= run.deadline) throw fail('CHUNK_TRAVEL_TIMEOUT')
    return { state, feet }
  }
  async function call (run, fn) {
    guard(run)
    const signal = run.controller.signal
    let aborted
    const interrupted = new Promise((resolve, reject) => { aborted = () => reject(signal.reason ?? fail('CHUNK_TRAVEL_CANCELLED')); signal.addEventListener('abort', aborted, { once: true }) })
    try { const result = await Promise.race([Promise.resolve().then(() => { guard(run); return fn() }), interrupted]); guard(run); return result } finally { signal.removeEventListener('abort', aborted) }
  }
  function status () {
    return active ? { available: true, busy: !!task, phase: active.phase, operationId: active.id, area: copy(active.area), target: copy(active.target), legs: active.legs,
      serverConfirmed: active.phase === 'arrived' && active.serverConfirmed === true, positionProof: copy(active.positionProof), error: copy(active.error), movementFailure: copy(active.movementFailure), shortRouteFailure: copy(active.shortRouteFailure) }
      : { available: true, busy: false, phase: 'idle', operationId: null, area: null, target: null, legs: 0, serverConfirmed: false, positionProof: null, error: null, movementFailure: null, shortRouteFailure: null }
  }
  async function stopOwned (run, reason) {
    if (!run.moving) return run.stopping
    run.moving = false
    run.stopping = Promise.resolve().then(() => stopMove(run.id, reason))
    return run.stopping
  }
  async function candidates (run) {
    const origin = guard(run).feet, area = run.area, columns = []
    const center = { x: (area.x1 + area.x2 + 1) * 8, z: (area.z1 + area.z2 + 1) * 8 }
    for (let x = area.x1 * 16; x < (area.x2 + 1) * 16; x++) for (let z = area.z1 * 16; z < (area.z2 + 1) * 16; z++) columns.push({ x, z })
    columns.sort((a, b) => Math.hypot(a.x + 0.5 - center.x, a.z + 0.5 - center.z) - Math.hypot(b.x + 0.5 - center.x, b.z + 0.5 - center.z) || a.x - b.x || a.z - b.z)
    const heights = [0]; for (let dy = 1; dy <= 16; dy++) heights.push(dy, -dy)
    const found = []
    for (let i = 0; i < columns.length && found.length < 32; i++) {
      if (i % 16 === 0) { await sleep(0); guard(run) }
      for (const dy of heights) {
        const target = { x: columns[i].x + 0.5, y: Math.floor(origin.y + 0.001) + dy, z: columns[i].z + 0.5 }
        if (distance(origin, target) <= maxDistance && areaContainsFeet(area, target, 0.2) && dryStand(target)) { found.push(target); break }
      }
    }
    return found
  }
  // Stands beside the corner of the area nearest the Bot, two cells in from
  // both edges, so a debug chest placed from there sits in that corner (user
  // request 2026-11-13). Empty when no known dry stand exists there.
  async function cornerStands (run) {
    const origin = guard(run).feet, area = run.area
    const xs = [area.x1 * 16 + 2.5, (area.x2 + 1) * 16 - 2.5], zs = [area.z1 * 16 + 2.5, (area.z2 + 1) * 16 - 2.5]
    const anchors = xs.flatMap(x => zs.map(z => ({ x, z }))).sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z))
    const anchor = anchors[0], columns = [], found = []
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) columns.push({ x: anchor.x + dx, z: anchor.z + dz })
    columns.sort((a, b) => Math.hypot(a.x - anchor.x, a.z - anchor.z) - Math.hypot(b.x - anchor.x, b.z - anchor.z) || a.x - b.x || a.z - b.z)
    const heights = [0]; for (let dy = 1; dy <= 16; dy++) heights.push(dy, -dy)
    await sleep(0); guard(run)
    for (const column of columns) {
      if (found.length >= 8) break
      for (const dy of heights) {
        const target = { x: column.x, y: Math.floor(origin.y + 0.001) + dy, z: column.z }
        if (distance(origin, target) <= maxDistance && areaContainsFeet(area, target, 0.2) && dryStand(target)) { found.push(target); break }
      }
    }
    return { anchor, stands: found }
  }
  function routePoints (route, origin, goal, short = false) {
    if (route?.ready !== true || short && route.planningOnly || route.boundedJump || route.controlledDrop || route.partialDrop || !Array.isArray(route.waypoints) || !route.waypoints.length || route.waypoints.length > 256) return null
    if (route.origin && (!finite(route.origin) || distance(route.origin, origin) > 0.1)) return null
    const points = [{ position: copy(origin), medium: 'land' }, ...route.waypoints]
    if (distance(points.at(-1)?.position ?? {}, goal) > 0.4 || points.slice(1).some(point => !['walk', 'jump', 'swim'].includes(point?.action) || !knownRoutePoint(point.position, point.medium))) return null
    let length = 0
    for (let i = 1; i < points.length; i++) { if (!finite(points[i].position)) return null; length += distance(points[i - 1].position, points[i].position) }
    return length <= (short ? 4.5 : maxTravelDistance) + 1e-6 ? { points, length } : null
  }
  function rejectedPreview (preview, origin, target) {
    let pathLength = null
    if (Array.isArray(preview?.waypoints) && preview.waypoints.length <= 256 && preview.waypoints.every(point => finite(point?.position))) {
      pathLength = 0; let previous = origin
      for (const point of preview.waypoints) { pathLength += distance(previous, point.position); previous = point.position }
    }
    return { target: copy(target), ready: preview?.ready === true, reason: typeof preview?.reason === 'string' ? preview.reason.slice(0, 240) : null,
      waypointCount: Array.isArray(preview?.waypoints) ? preview.waypoints.length : null, pathLength }
  }
  // inPlace: the Bot already stands inside the area, so only its position is
  // confirmed. Nothing walks, so the footing is not judged here.
  async function witness (run, final, inPlace = false) {
    const feet = guard(run).feet, radius = 0.2, began = now()
    const stand = p => inPlace || dryStand(p)
    if (final && (!stand(feet) || !areaContainsFeet(run.area, feet, radius))) throw fail('CHUNK_TRAVEL_ARRIVAL_UNSAFE')
    active.phase = 'verifying'
    const receipt = await call(run, () => confirmPosition(copy(feet), { signal: run.controller.signal, radius, operationId: run.id }))
    const after = guard(run).feet
    if (receipt?.serverConfirmed !== true || receipt.kind !== 'server_position_volume' || receipt.scope !== run.scope || receipt.radius !== radius || !finite(receipt.feet) || distance(receipt.feet, feet) > 0.015 || distance(after, feet) > 0.03 || !Number.isFinite(receipt.receivedAt) || receipt.receivedAt < began || receipt.receivedAt > now() || final && (!stand(after) || !areaContainsFeet(run.area, receipt.feet, radius))) throw fail('CHUNK_TRAVEL_POSITION_UNCONFIRMED')
    active.positionProof = { confirmed: true, feet: copy(receipt.feet), radius, scope: run.scope, generation: run.generation, observedAt: receipt.receivedAt, source: 'server_position_volume' }
  }
  async function leg (run, target, preview) {
    const origin = guard(run).feet, checked = routePoints(preview, origin, target, true)
    if (!checked || checked.length <= 0.05 || distance(origin, target) > 6 || run.usedDistance + checked.length > maxTravelDistance) throw fail('CHUNK_TRAVEL_SHORT_ROUTE_UNCONFIRMED')
    const beforeInput = () => { guard(run); if (!routePoints(preview, origin, target, true)) throw fail('CHUNK_TRAVEL_TERRAIN_CHANGED'); return true }
    active.phase = 'moving'; active.positionProof = null; run.moving = true
    await call(run, () => startMove(copy(target), { allowWater: true, maxDistance: 6, maxExpanded: 1500, maxTicks: 240, beforeInput, operationId: run.id }))
    const until = Math.min(run.deadline, now() + legTimeoutMs)
    for (;;) {
      const { feet } = guard(run), movement = getMovement()
      if (['failed', 'stopped', 'replan_required'].includes(movement?.phase)) {
        active.movementFailure = { phase: movement.phase, reason: typeof movement.reason === 'string' ? movement.reason.slice(0, 240) : null,
          target: finite(movement.target) ? { x: movement.target.x, y: movement.target.y, z: movement.target.z } : null,
          waypointIndex: Number.isSafeInteger(movement.waypointIndex) && movement.waypointIndex >= 0 ? movement.waypointIndex : null,
          sent: Number.isSafeInteger(movement.sent) && movement.sent >= 0 ? movement.sent : null }
        throw fail('CHUNK_TRAVEL_MOVE_FAILED')
      }
      if (['completed', 'idle', 'awaiting_server_confirmation'].includes(movement?.phase) && movement.running !== true) {
        if (distance(feet, target) > 0.4) throw fail('CHUNK_TRAVEL_MOVE_ENDED_SHORT')
        await stopOwned(run, 'CHUNK_TRAVEL_VERIFY_POSITION'); guard(run)
        active.legs++; run.usedDistance += checked.length
        await witness(run, areaContainsFeet(run.area, guard(run).feet, 0.2) && dryStand(guard(run).feet))
        return
      }
      if (now() >= until) throw fail('CHUNK_TRAVEL_LEG_TIMEOUT')
      await sleep(pollMs)
    }
  }
  async function execute (run) {
    let watcher
    try {
      watcher = setInterval(() => { try { guard(run) } catch (error) { run.controller.abort(error); void stopOwned(run, error.code).catch(() => {}) } }, pollMs)
      guard(run)
      run.acquiring = Promise.resolve().then(() => { guard(run); run.acquireStarted = true; return acquire(run.id, { scope: run.scope, signal: run.controller.signal, area: copy(run.area) }) })
      const acquired = await call(run, () => run.acquiring)
      if (acquired === false || acquired?.acquired === false) throw fail('CHUNK_TRAVEL_BUSY')
      guard(run)
      const startedInside = areaContainsFeet(run.area, guard(run).feet, 0.2)
      const corner = await cornerStands(run), flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
      const inPlace = async note => {
        await witness(run, true, active.legs === 0); active.phase = 'arrived'; active.serverConfirmed = true
        try { log(`チャンク移動: ${note} feet=${round(guard(run).feet)}`) } catch {}
      }
      if (startedInside && (!corner.stands.length || flat(guard(run).feet, corner.anchor) <= 3)) return await inPlace('範囲内のため歩かずに位置を確認')
      // The corner is a preference only: when it cannot be reached the Bot
      // settles where it is inside the area, or walks to the old centre goals.
      let goals = corner.stands, cornering = goals.length > 0
      const giveUpCorner = async error => {
        if (!cornering || run.controller.signal.aborted || !softCorner.has(error?.code)) throw error
        guard(run)
        // Outside the area only a missing route is worth a second search;
        // other failures keep their own diagnostics.
        if (!areaContainsFeet(run.area, guard(run).feet, 0.2)) { if (error.code !== 'CHUNK_TRAVEL_NO_ROUTE') throw error; cornering = false; return false }
        await stopOwned(run, 'CHUNK_TRAVEL_CORNER_UNREACHED'); guard(run)
        cornering = false; active.movementFailure = null; active.shortRouteFailure = null
        await inPlace(`角へ進めないため現在位置で確認（${reasons[error.code] ?? error.code}）`); return true
      }
      if (!cornering) { goals = await candidates(run); if (!goals.length) throw fail('CHUNK_TRAVEL_NO_KNOWN_STAND') }
      let goal = null
      for (let attempt = 0; attempt < maxLegs; attempt++) {
       try {
        active.phase = 'planning'; const origin = guard(run).feet
        let full = null
        for (const candidate of goal ? [goal] : goals) {
          // Let cancellation and combat run between bounded candidate searches
          // as well as within the cooperative trusted planner.
          await sleep(0); guard(run)
          const proposal = await call(run, () => planRoute(copy(candidate), { allowWater: true, maxDistance, maxExpanded: 5000, signal: run.controller.signal, check: () => guard(run) }))
          const checked = routePoints(proposal, origin, candidate)
          if (checked && run.usedDistance + checked.length <= maxTravelDistance + 1e-6) { goal = candidate; full = checked; break }
        }
        if (!full) throw fail('CHUNK_TRAVEL_NO_ROUTE')
        active.target = copy(goal)
        const targets = []; let length = 0
        for (let i = 1; i < full.points.length; i++) {
          length += distance(full.points[i - 1].position, full.points[i].position)
          if (length > 4.5 || distance(origin, full.points[i].position) > 6) break
          if (distance(origin, full.points[i].position) > 0.05) targets.push(full.points[i].position)
        }
        if (!targets.length) throw fail('CHUNK_TRAVEL_NO_SHORT_PREFIX')
        let selected = null, lastRejected = null
        for (const target of targets.reverse().slice(0, 4)) {
          if (lastRejected) {
            await sleep(0); guard(run)
            if (distance(guard(run).feet, origin) > 0.03) throw fail('CHUNK_TRAVEL_ORIGIN_CHANGED')
          }
          const short = await call(run, () => previewMove(copy(target), { allowWater: true, maxDistance: 6, maxExpanded: 1500, maxTicks: 240 }))
          const actualOrigin = guard(run).feet
          if (distance(actualOrigin, origin) > 0.03) throw fail('CHUNK_TRAVEL_ORIGIN_CHANGED')
          const checked = routePoints(short, actualOrigin, target, true)
          if (checked && checked.length > 0.05 && distance(actualOrigin, target) <= 6 && run.usedDistance + checked.length <= maxTravelDistance) { selected = { target, short }; break }
          lastRejected = rejectedPreview(short, actualOrigin, target)
        }
        if (!selected) { active.shortRouteFailure = lastRejected; throw fail('CHUNK_TRAVEL_SHORT_ROUTE_UNCONFIRMED') }
        active.shortRouteFailure = null
        await leg(run, selected.target, selected.short)
        const feet = guard(run).feet
        if (areaContainsFeet(run.area, feet, 0.2) && dryStand(feet) && (!cornering || flat(feet, goal) <= 0.6)) { active.phase = 'arrived'; active.serverConfirmed = true; try { log(`チャンク移動が完了: feet=${round(feet)} legs=${active.legs} walked=${run.usedDistance.toFixed(1)}m`) } catch {} return }
       } catch (error) {
        if (await giveUpCorner(error)) return
        goal = null; goals = await candidates(run)
        if (!goals.length) throw fail('CHUNK_TRAVEL_NO_KNOWN_STAND')
       }
      }
      if (await giveUpCorner(fail('CHUNK_TRAVEL_LEG_LIMIT'))) return
      throw fail('CHUNK_TRAVEL_LEG_LIMIT')
    } catch (error) {
      active.phase = run.controller.signal.aborted && run.controller.signal.reason?.code === 'CHUNK_TRAVEL_CANCELLED' ? 'cancelled' : 'failed'
      const cause = run.controller.signal.reason ?? error
      active.serverConfirmed = false; active.positionProof = null
      active.error = errorView(cause, active.movementFailure?.reason ?? active.shortRouteFailure?.reason ?? (/^CHUNK_TRAVEL_[A-Z_]+$/.test(cause?.code ?? '') ? null : cause?.message))
      report(run, cause)
    } finally {
      clearInterval(watcher)
      try { await stopOwned(run, 'CHUNK_TRAVEL_FINISHED') } catch {}
      try { await run.acquiring } catch {}
      try { if (run.acquireStarted) await release(run.id) } catch { active.phase = 'failed'; active.serverConfirmed = false; active.positionProof = null; active.error = errorView(fail('CHUNK_TRAVEL_RELEASE_FAILED')) }
    }
  }
  // The reason goes to the Bot log so a failed move can be diagnosed afterwards.
  function report (run, cause) {
    try {
      const a = active, feet = feetOf(getState()), failure = a.movementFailure, short = a.shortRouteFailure
      const detail = typeof cause?.message === 'string' && cause.message !== cause.code ? cause.message.replace(/\s+/g, ' ').slice(0, 160) : ''
      const original = cause?.code && cause.code !== a.error.code ? ` cause=${String(cause.code).slice(0, 60)}${detail ? ':' + detail : ''}` : detail ? ` cause=${detail}` : ''
      log(`チャンク移動${a.phase === 'cancelled' ? 'を中断' : 'に失敗'}: ${a.error.code} ${a.error.message}${original} area=${a.area.x1},${a.area.z1}..${a.area.x2},${a.area.z2} feet=${round(feet)} target=${round(a.target)} legs=${a.legs} walked=${run.usedDistance.toFixed(1)}m` +
        (failure ? ` movement=${failure.phase}:${failure.reason ?? 'none'} waypoint=${failure.waypointIndex ?? 'unknown'}` : '') +
        (short ? ` shortRoute=ready:${short.ready} reason=${short.reason ?? 'none'} to=${round(short.target)}` : ''))
    } catch {}
  }
  function start ({ area } = {}) {
    if (task) throw fail('CHUNK_TRAVEL_BUSY')
    const selected = normalizeChunkArea(area), state = getState(), scope = observedScope(state), feet = feetOf(state), currentGeneration = generation()
    if (!scope || state.dimension !== 'overworld' || !feet || !Number.isSafeInteger(currentGeneration) || currentGeneration < 0) throw fail('CHUNK_TRAVEL_NOT_READY')
    const run = { id: uuid(), area: selected, scope, generation: currentGeneration, job: copy(jobIdentity()), health: state.health, controller: new AbortController(), deadline: now() + timeoutMs, usedDistance: 0, moving: false }
    active = { id: run.id, area: copy(selected), target: null, legs: 0, phase: 'planning', serverConfirmed: false, positionProof: null, error: null, movementFailure: null, shortRouteFailure: null }; owner = run
    const promise = Promise.resolve().then(() => execute(run)), tracked = promise.finally(() => { if (task === tracked) task = null; if (owner === run) owner = null })
    task = tracked
    return status()
  }
  function cancel () {
    if (owner && task) { owner.controller.abort(fail('CHUNK_TRAVEL_CANCELLED')); void stopOwned(owner, 'CHUNK_TRAVEL_CANCELLED').catch(() => {}) }
    return status()
  }
  return { start, status, cancel, drain: () => task ?? Promise.resolve(), isBusy: () => !!task }
}

module.exports = { createChunkTravel }
