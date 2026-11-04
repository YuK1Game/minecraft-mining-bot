'use strict'

const { equipmentReady } = require('./equipment-readiness')
const { resourceMinHealth } = require('./learning-health')

const { setTimeout: sleep } = require('node:timers/promises')
const { confirmedBatchMovementProgress } = require('./batch-movement-progress')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const SOIL = new Set(['dirt', 'grass_block'])
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|sand$|gravel$|concrete_powder$|anvil$|scaffolding|pointed_dripstone)/
const copy = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item))
const nameOf = block => String(typeof block === 'string' ? block : block?.name ?? '').replace(/^minecraft:/, '')
const key = point => `${point.x},${point.y},${point.z}`
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const safeLayers = block => !block.extra?.some(layer => !AIR.has(nameOf(layer)))
const clear = block => block?.known === true && AIR.has(nameOf(block)) && safeLayers(block)
const solid = block => block?.known === true && block.boundingBox === 'block' && !HAZARD.test(nameOf(block)) && safeLayers(block)
const dirtCount = state => (state.inventory?.items ?? []).reduce((sum, item) => sum + (nameOf(item) === 'dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

class ShelterError extends Error {
  constructor (message, code) { super(message); this.code = code }
}

function createShelter ({ getState, world, planner, mining, getMining, movement, getMovement, inventory, interactions, onProgress = () => {}, memo: initialMemo = null, maxActions = 12, maxTotalActions = 64, timeoutMs = 20000, batchTimeoutMs = 120000, pickupTimeoutMs = 3000, pollMs = 100, minHealth = 6, clock = Date.now, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }) }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || !(typeof planner === 'function' || typeof planner?.preview === 'function') || ['preview', 'start', 'stop'].some(method => typeof mining?.[method] !== 'function' || typeof movement?.[method] !== 'function') || typeof getMining !== 'function' || typeof getMovement !== 'function' || typeof inventory?.equip !== 'function' || typeof interactions?.previewPlace !== 'function' || typeof interactions?.placeBlock !== 'function') throw new Error('Shelter requires received world, planner and owned mining/movement/inventory/placement controllers')
  if (![maxActions, maxTotalActions].every(value => Number.isSafeInteger(value) && value > 0) || maxActions > 64 || maxTotalActions > 512 || ![timeoutMs, batchTimeoutMs, pickupTimeoutMs, pollMs].every(value => Number.isFinite(value) && value > 0) || timeoutMs > 120000 || batchTimeoutMs > 300000 || pickupTimeoutMs > 10000 || pollMs > 1000 || !Number.isFinite(minHealth) || minHealth < 0) throw new Error('Invalid shelter action limits')
  let memory = initialMemo == null ? null : copy(initialMemo)
  let active = null
  let status = { phase: 'idle', busy: false, stage: null, actions: 0, reason: null, code: null, cleanupErrors: [], trace: [] }

  function readBlock (point) {
    const block = world.getBlock(point.x, point.y, point.z)
    if (block?.known !== true || typeof block.name !== 'string') throw new ShelterError(`Unknown terrain at ${key(point)}`, 'UNKNOWN_TERRAIN')
    return block
  }
  function requireScope (value) {
    if (memory?.scope && (memory.scope.dimension !== value?.dimension || memory.scope.realmId != null && memory.scope.realmId !== String(value?.realm?.id))) throw new ShelterError('The saved shelter belongs to another or unconfirmed world', 'SITE_SCOPE_CHANGED')
  }
  function state (baseline) {
    const value = getState()
    if (value?.phase !== 'spawned' || value.dead || value.isDead || value.lifecycle?.dead || !finite(value.position)) throw new ShelterError('Shelter work requires a living spawned player and a known position', 'NOT_READY')
    if (value.gameMode !== 'survival' && value.gameMode !== 0) throw new ShelterError('Shelter construction is survival-only', 'UNSUPPORTED_MODE')
    if (!Number.isFinite(value.health) || value.health <= resourceMinHealth(value, minHealth)) throw new ShelterError('Health is too low or unknown for construction', 'LOW_HEALTH')
    if (value.inventory?.known !== true || value.inventory.uncertain) throw new ShelterError('A current confirmed inventory is required', 'INVENTORY_UNKNOWN')
    if (baseline) {
      if (value.dimension !== baseline.dimension || value.startedAt !== baseline.startedAt || baseline.connectionId != null && value.connectionId !== baseline.connectionId) throw new ShelterError('The shelter session changed', 'SESSION_CHANGED')
      if (value.health < baseline.health) throw new ShelterError('The player took damage while constructing shelter', 'TOOK_DAMAGE')
    }
    requireScope(value)
    return value
  }
  function validatePlan (plan) {
    if (!plan?.ready || !integer(plan.outsideFootCell) || !integer(plan.entry) || !integer(plan.inner) || !finite(plan.outsideStandpoint) || !finite(plan.innerStandpoint) || !plan.forward || Math.abs(plan.forward.x) + Math.abs(plan.forward.z) !== 1 || !Number.isInteger(plan.forward.x) || !Number.isInteger(plan.forward.z)) throw new ShelterError('A received, validated cardinal shelter site is required', 'INVALID_PLAN')
    const o = plan.outsideFootCell; const d = plan.forward
    for (const [point, depth] of [[plan.entry, 1], [plan.inner, 2]]) if (point.x !== o.x + d.x * depth || point.z !== o.z + d.z * depth || point.y !== o.y) throw new ShelterError('Shelter excavation must stay in the two adjacent planned cells', 'INVALID_PLAN')
    if (!Array.isArray(plan.initialSteps) || plan.initialSteps.length !== 2 || !Array.isArray(plan.doorCells) || plan.doorCells.length !== 2) throw new ShelterError('Shelter needs two access steps and two doorway cells', 'INVALID_PLAN')
    for (let index = 0; index < 2; index++) {
      const foot = index ? plan.inner : plan.entry
      const step = plan.initialSteps[index]
      if (!finite(step.target) || step.target.x !== foot.x + 0.5 || step.target.y !== foot.y || step.target.z !== foot.z + 0.5 || !Array.isArray(step.clearance) || step.clearance.length !== 2) throw new ShelterError('Invalid shelter access step', 'INVALID_PLAN')
      step.clearance.forEach((block, order) => { if (!integer(block.position) || key(block.position) !== key({ ...foot, y: foot.y + 1 - order })) throw new ShelterError('Only the access head and foot blocks may be excavated', 'INVALID_PLAN') })
      if (!integer(plan.doorCells[index].position) || key(plan.doorCells[index].position) !== key({ ...plan.entry, y: plan.entry.y + index })) throw new ShelterError('The own doorway must close lower before upper', 'INVALID_PLAN')
    }
    if (plan.minimumInterior) {
      const minimum = plan.minimumInterior
      const body = new Set([key(plan.inner), key({ ...plan.inner, y: plan.inner.y + 1 })])
      if (!Array.isArray(minimum.footCells) || minimum.footCells.length !== 1 || !integer(minimum.footCells[0]) || key(minimum.footCells[0]) !== key(plan.inner) || !Array.isArray(minimum.bodyCells) || minimum.bodyCells.length !== 2 || new Set(minimum.bodyCells.map(item => key(item.position ?? {}))).size !== 2 || !minimum.bodyCells.every(item => integer(item.position) && body.has(key(item.position)))) throw new ShelterError('Only the verified inner cell is the initial refuge interior', 'INVALID_PLAN')
    }
    return plan
  }
  function minimumGeometry (site) {
    const side = { x: -site.forward.z, z: site.forward.x }
    const walls = [site.entry, site.inner].flatMap(foot => [-1, 1].flatMap(sign => [0, 1].map(height => ({ x: foot.x + side.x * sign, y: foot.y + height, z: foot.z + side.z * sign }))))
    walls.push(...[0, 1].map(height => ({ x: site.inner.x + site.forward.x, y: site.inner.y + height, z: site.inner.z + site.forward.z })))
    return {
      footCells: site.minimumInterior?.footCells ?? [site.inner],
      bodyCells: site.minimumInterior?.bodyCells ?? site.initialSteps[1].clearance,
      boundary: [...[site.entry, site.inner].flatMap(foot => [{ ...foot, y: foot.y - 1 }, { ...foot, y: foot.y + 2 }]), ...walls]
    }
  }
  function sameSite (a, b) { return a?.forward && b?.forward && integer(a.entry) && integer(b.entry) && key(a.entry) === key(b.entry) && a.forward.x === b.forward.x && a.forward.z === b.forward.z }
  function placementAt (point) {
    if (memory?.pendingPlacement?.requiresReconciliation === true && key(memory.pendingPlacement.position ?? {}) === key(point)) return undefined
    return memory?.placements?.find(item => key(item.position) === key(point) && item.serverConfirmed === true && item.item === 'minecraft:dirt' && item.count === 1)
  }
  function grounded (value) {
    const feet = value.position.y - 1.62
    const y = Math.round(feet)
    const physical = value.predicted?.physicsState ?? value.physicsState
    if (Math.abs(feet - y) > 1e-4 || physical?.onGround === false || physical?.isInWater === true) return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const x = Math.floor(value.position.x + dx); const z = Math.floor(value.position.z + dz)
      if (!solid(readBlock({ x, y: y - 1, z })) || !clear(readBlock({ x, y, z })) || !clear(readBlock({ x, y: y + 1, z }))) return false
    }
    return true
  }
  function inside (value, site) {
    const cell = { x: Math.floor(value.position.x), y: Math.round(value.position.y - 1.62), z: Math.floor(value.position.z) }
    const allowed = minimumGeometry(site).footCells
    if (!allowed.some(point => key(point) === key(cell)) || !grounded(value)) return false
    return site.doorCells.every(({ position: p }) => !(value.position.x + 0.3 > p.x && value.position.x - 0.3 < p.x + 1 && value.position.z + 0.3 > p.z && value.position.z - 0.3 < p.z + 1))
  }
  function inspect (site, value = getState()) {
    if (!site) return { established: false, structureIntact: false, geometryVerified: false, entranceClosed: false, inside: false, usable: false, serverConfirmed: false, positionServerConfirmed: false }
    validatePlan(site)
    requireScope(value)
    const minimum = minimumGeometry(site)
    // Legacy memos may describe a planned 3x2 room. Only the received shell of
    // the two-cell access/inner refuge is relevant until expansion is executed.
    for (const position of minimum.boundary) if (!solid(readBlock(position))) throw new ShelterError('The preserved minimum shelter boundary changed', 'STRUCTURE_CHANGED')
    for (const item of minimum.bodyCells) {
      const block = readBlock(item.position)
      if (HAZARD.test(nameOf(block)) || !safeLayers(block)) throw new ShelterError('Unsafe material appeared inside the planned shelter room', 'INTERIOR_UNSAFE')
    }
    for (const item of site.initialSteps[1].clearance) if (!clear(readBlock(item.position))) throw new ShelterError('The interior access cell is not clear', 'INTERIOR_NOT_CLEAR')
    const doors = site.doorCells.map(item => readBlock(item.position))
    if (doors.some(block => !clear(block) && nameOf(block) !== 'dirt')) throw new ShelterError('The doorway no longer matches the own soil doorway', 'DOOR_CHANGED')
    const closed = doors.every(block => solid(block) && nameOf(block) === 'dirt')
    const owned = site.doorCells.every(item => placementAt(item.position))
    const inRoom = inside(value, site)
    const established = memory?.established === true && owned && memory?.pendingPlacement?.requiresReconciliation !== true
    return { established, structureIntact: true, geometryVerified: true, entranceClosed: closed, closed, inside: inRoom, usable: established && closed, serverConfirmed: established, confirmedBy: established ? 'received_structure_and_own_placement_inventory' : null, positionServerConfirmed: value.positionSource !== 'client_prediction' && value.positionServerConfirmed !== false, positionSource: value.positionSource ?? 'unknown', roomReady: false }
  }
  function preview (options = {}) {
    try {
      const current = state()
      const saved = options.memo ?? memory
      if (saved?.pendingPlacement?.requiresReconciliation === true) return { ready: false, code: 'PLACEMENT_RECONCILIATION_REQUIRED', reason: 'A placement restored from another connection needs explicit server reconciliation before its ownership can be accepted.', requiresReconciliation: true, resumeReady: false, canResume: false }
      const site = options.site ?? saved?.site
      const plan = typeof planner === 'function' ? planner(current, { getBlock: (x, y, z) => world.getBlock(x, y, z), memo: saved, observedAt: clock() }, { ...options, ...(site ? { site } : {}) }) : planner.preview({ ...options, memo: saved, ...(site ? { site } : {}) })
      if (!plan?.ready) return { ...plan, resumeReady: false, canResume: false }
      validatePlan(plan)
      let physical = {}
      try { physical = inspect(plan, current) } catch { /* An unfinished passage is still a valid construction plan. */ }
      return { ...copy(plan), ...physical, closureMaterials: closureMaterials(plan, current, physical), ready: true, resumeReady: !!site, canResume: !!site, memo: saved ? copy(saved) : null }
    } catch (error) { return { ready: false, code: error.code ?? 'PLAN_FAILED', reason: error.message, resumeReady: false, canResume: false } }
  }
  function closureMaterials (site, current, physical) {
    if (!site || !current || current.inventory?.known !== true || current.inventory.uncertain || memory?.established !== true || physical?.structureIntact !== true || memory.pendingPlacement) return null
    const requiredDirt = site.doorCells.filter(item => clear(readBlock(item.position))).length
    const availableDirt = dirtCount(current)
    return { item: 'minecraft:dirt', requiredDirt, availableDirt, missingDirt: Math.max(0, requiredDirt - availableDirt), requiresServerInventory: true }
  }
  function snapshot () {
    let physical = { established: false, structureIntact: false, geometryVerified: false, inside: false, entranceClosed: false, usable: false, serverConfirmed: false }
    let materials = null
    try { const current = getState(); physical = inspect(memory?.site, current); materials = closureMaterials(memory?.site, current, physical) } catch { /* Cached receipts never prove current geometry. */ }
    const canResume = !active && !!memory?.site && preview({ site: memory.site }).ready
    return copy({ ...status, ...physical, closureMaterials: materials, canResume, memo: memory })
  }
  function publish (phase, details = {}) {
    status.phase = phase; status.stage = phase
    if (memory) memory.stage = phase
    status.trace.push({ phase, ...copy(details) })
    if (status.trace.length > 40) status.trace.shift()
    try { Promise.resolve(onProgress({ type: 'shelter', phase, ...copy(details), memo: memory ? copy(memory) : null })).catch(() => {}) } catch { /* Persistence callbacks do not change wire results. */ }
  }
  function check (run) {
    if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new ShelterError('Shelter action cancelled', 'ABORTED')
    if (clock() >= run.deadline) throw new ShelterError('Shelter batch reached its deadline', 'TIMEOUT')
    return state(run.baseline)
  }
  async function call (run, label, fn, limit = timeoutMs) {
    check(run)
    let timer; let abort
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new ShelterError(`${label} aborted`, 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new ShelterError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(limit, run.deadline - clock())))
    })
    try { return await Promise.race([Promise.resolve().then(() => { check(run); return fn() }), cancelled]) } finally { clearTimeout(timer); run.signal.removeEventListener('abort', abort) }
  }
  async function poll (run, label, predicate, limit = timeoutMs) {
    const end = Math.min(run.deadline, clock() + limit)
    while (clock() < end) {
      const current = check(run)
      const found = await predicate(current)
      if (found) return { state: current, value: found }
      await call(run, `${label} wait`, () => delay(pollMs, run.signal), pollMs + 1000)
    }
    throw new ShelterError(`${label} was not received before timeout`, 'TIMEOUT')
  }
  function budget (run) {
    if (memory.totalActions >= maxTotalActions) throw new ShelterError('The shelter lifetime action budget is exhausted', 'ACTION_LIMIT')
    if (run.actions >= run.limit) throw new ShelterError('This short shelter batch is complete', 'BATCH_COMPLETE')
    run.actions++; memory.totalActions++; status.actions = run.actions
  }
  function soil (point, owned = false) {
    const block = readBlock(point)
    if (clear(block)) return block
    if (!SOIL.has(nameOf(block)) || !solid(block) || block.protected || block.natural === false && !owned || block.diggable === false) throw new ShelterError('Only the planned, unprotected barehand soil may be dug', 'UNSAFE_DIG')
    const current = state()
    if (Math.floor(current.position.x) === point.x && Math.floor(current.position.z) === point.z && point.y <= current.position.y - 1.62 + 1e-4) throw new ShelterError('The own supporting column cannot be dug', 'SELF_COLUMN')
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const neighbour = readBlock({ x: point.x + x, y: point.y + y, z: point.z + z })
      if (HAZARD.test(nameOf(neighbour)) || !safeLayers(neighbour)) throw new ShelterError('Unsafe or layered soil neighbour', 'UNSAFE_NEIGHBOUR')
    }
    return block
  }
  async function dig (run, descriptor, owned = false) {
    check(run)
    const point = descriptor.position
    const block = soil(point, owned)
    if (clear(block)) return
    const live = await call(run, 'Soil mining preview', () => mining.preview([copy(point)]))
    if (!live?.ready) throw new ShelterError(live?.errors?.join('\n') ?? 'Soil mining preview rejected', 'MINING_PREVIEW_REJECTED')
    soil(point, owned)
    budget(run); run.owned.mining = true
    publish('digging', { position: point })
    await call(run, 'Soil mining start', () => mining.start([copy(point)]))
    await poll(run, 'Received soil destruction', async () => {
      const result = await call(run, 'Mining status', () => getMining())
      if (['failed', 'stopped'].includes(result?.phase)) throw new ShelterError(result.reason ?? 'Soil mining stopped', 'MINING_FAILED')
      return clear(readBlock(point)) && ['completed', 'idle'].includes(result?.phase)
    })
    run.owned.mining = false
    if (!memory.cleared.some(item => key(item.position) === key(point))) memory.cleared.push({ position: copy(point), originalName: block.name, confirmedBy: 'received_air' })
    publish('dug', { position: point })
  }
  async function moveTo (run, target, force = false) {
    const before = check(run)
    if (!force && horizontal(before.position, target) <= 0.2 && Math.abs(before.position.y - 1.62 - target.y) < 1e-4 && grounded(before)) return
    const preview = await call(run, 'Shelter movement preview', () => movement.preview(copy(target), { allowWater: false }))
    if (!preview?.ready) throw new ShelterError(preview?.reason ?? 'No safe land route inside shelter', 'NO_SAFE_ROUTE')
    budget(run); run.owned.movement = true
    publish('moving', { target })
    await call(run, 'Shelter movement start', () => movement.start(copy(target), { allowWater: false }))
    await poll(run, 'Fresh grounded shelter arrival', async () => {
      const motion = await call(run, 'Movement status', () => getMovement())
      const current = check(run)
      if (['failed', 'stopped'].includes(motion?.phase)) throw new ShelterError(motion.reason ?? 'Shelter movement stopped', 'MOVEMENT_FAILED')
      const terminal = ['awaiting_server_confirmation', 'replan_required', 'completed', 'idle'].includes(motion?.phase)
      const arrived = horizontal(current.position, target) <= 0.35 && Math.abs(current.position.y - 1.62 - target.y) < 1e-4 && current.positionUpdatedAt != null && current.positionUpdatedAt !== before.positionUpdatedAt && grounded(current) && terminal
      if (terminal && !arrived && confirmedBatchMovementProgress(before, current, target)) {
        run.progressCandidate = { before, target: copy(target) }
        throw new ShelterError('Received movement progress requires a fresh shelter batch', 'REPLAN_REQUIRED')
      }
      return arrived
    })
    run.owned.movement = false
    publish('arrived', { positionSource: check(run).positionSource ?? 'unknown' })
  }
  async function ensureInside (run) {
    for (let attempt = 0; attempt < 2 && !inside(check(run), memory.site); attempt++) await moveTo(run, memory.site.innerStandpoint, true)
    if (!inside(check(run), memory.site)) throw new ShelterError('The grounded player must be wholly inside before closing the doorway', 'INSIDE_NOT_CONFIRMED')
  }
  async function collectSoil (run, needed = 2) {
    if (dirtCount(check(run)) >= needed) return
    publish('collecting_soil')
    try { await poll(run, 'Actual dirt inventory', current => dirtCount(current) >= needed, Math.min(1000, pickupTimeoutMs)); return } catch (error) { if (error.code !== 'TIMEOUT') throw error }
    for (const target of [memory.site.initialSteps[0].target, memory.site.innerStandpoint]) {
      await moveTo(run, target)
      try { await poll(run, 'Actual dirt pickup', current => dirtCount(current) >= needed, pickupTimeoutMs); return } catch (error) { if (error.code !== 'TIMEOUT') throw error }
    }
    throw new ShelterError('Received air did not produce two actual inventory dirt items', 'PICKUP_NOT_CONFIRMED')
  }
  function addReceipt (point) {
    memory.placements = memory.placements.filter(item => key(item.position) !== key(point))
    memory.placements.push({ position: copy(point), item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease' })
    memory.pendingPlacement = null
  }
  async function place (run, point) {
    await ensureInside(run)
    let current = check(run)
    const block = readBlock(point)
    if (nameOf(block) === 'dirt' && placementAt(point)) return
    if (!clear(block)) throw new ShelterError('A nonempty unconfirmed doorway cannot be overwritten', 'DOOR_CHANGED')
    const item = current.inventory.items.find(item => nameOf(item) === 'dirt' && item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
    if (!item) throw new ShelterError('Actual dirt is required before closing shelter', 'MATERIAL_MISSING')
    const selected = current.rawServerSelectedSlot ?? current.rawSelectedSlot
    if (selected !== item.slot || current.equipmentServerConfirmed === false) {
      budget(run); run.owned.inventory = true
      const expectedDirt = copy(item)
      const equipped = await call(run, 'Confirmed dirt slot swap', () => inventory.equip(item.slot))
      current = check(run)
      const slot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
      if (equipped?.phase !== 'completed' || !equipmentReady(equipped, current, { sourceSlot: expectedDirt.slot, expectedItem: expectedDirt }) || !current.inventory.items.some(value => value.slot === slot && nameOf(value) === 'dirt' && value.count > 0)) throw new ShelterError('Dirt was not confirmed in the server-selected slot', 'EQUIPMENT_NOT_CONFIRMED')
      run.owned.inventory = false
    }
    const slot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new ShelterError('The raw server-selected slot is unknown', 'EQUIPMENT_NOT_CONFIRMED')
    const data = { position: copy(point), slot }
    const preview = await call(run, 'Door placement preview', () => interactions.previewPlace(data))
    if (!preview?.ready || nameOf(preview.expectedBlock) !== 'dirt') throw new ShelterError(preview?.errors?.join('\n') ?? 'Door placement preview rejected', 'PLACEMENT_PREVIEW_REJECTED')
    await ensureInside(run)
    const beforeCount = dirtCount(check(run))
    budget(run); run.owned.interactions = true
    memory.pendingPlacement = { position: copy(point), beforeDirt: beforeCount, item: 'minecraft:dirt' }
    publish('closing_entrance', { position: point })
    const result = await call(run, 'Door placement', () => interactions.placeBlock(data))
    if (result?.phase !== 'completed') throw new ShelterError('Door placement did not complete', 'PLACEMENT_NOT_CONFIRMED')
    await poll(run, 'Received dirt placement and spend', current => solid(readBlock(point)) && nameOf(readBlock(point)) === 'dirt' && dirtCount(current) === beforeCount - 1)
    run.owned.interactions = false
    addReceipt(point)
    publish('door_confirmed', { position: point })
  }
  function restorePending (run) {
    const pending = memory.pendingPlacement
    if (!pending) return
    if (pending.requiresReconciliation === true) throw new ShelterError('A restored pending spend cannot be confirmed from an old inventory count difference', 'PLACEMENT_RECONCILIATION_REQUIRED')
    if (!integer(pending.position) || !memory.site.doorCells.some(item => key(item.position) === key(pending.position))) throw new ShelterError('Unknown saved placement operation', 'PLACEMENT_UNCERTAIN')
    const block = readBlock(pending.position)
    if (solid(block) && nameOf(block) === 'dirt' && dirtCount(check(run)) === pending.beforeDirt - 1) { addReceipt(pending.position); return }
    throw new ShelterError('The interrupted doorway spend must be resolved from received inventory and blocks', 'PLACEMENT_UNCERTAIN')
  }
  async function cleanup (run, reason) {
    if (run.cleanup) return run.cleanup
    const stops = []
    if (run.owned.mining) stops.push(() => mining.stop(reason))
    if (run.owned.movement) stops.push(() => movement.stop(reason))
    if (run.owned.inventory && typeof inventory.cancel === 'function') stops.push(() => inventory.cancel(reason))
    if (run.owned.interactions && typeof interactions.cancel === 'function') stops.push(() => interactions.cancel(reason))
    run.cleanup = Promise.allSettled(stops.map(fn => {
      let timer
      return Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned controller stop timed out')), 1000) })]).finally(() => clearTimeout(timer))
    })).then(results => { status.cleanupErrors = results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message ?? result.reason)) })
    return run.cleanup
  }
  async function perform (operation, options = {}, { signal } = {}) {
    if (active) throw new ShelterError('Another shelter batch is active', 'BUSY')
    if (signal?.aborted) throw signal.reason ?? new ShelterError('Shelter cancelled', 'ABORTED')
    if (options.memo != null) memory = copy(options.memo)
    const baseline = state()
    const busyMining = getMining(); const busyMovement = getMovement()
    if (busyMining?.then || busyMovement?.then) throw new ShelterError('Controller snapshots must be synchronous', 'INVALID_CONTROLLER_STATE')
    if (['mining', 'running'].includes(busyMining?.phase) || ['moving', 'settling', 'walking'].includes(busyMovement?.phase) || busyMovement?.running || inventory.snapshot?.().busy || interactions.snapshot?.().pendingOperation) throw new ShelterError('Existing controller work must finish before shelter construction', 'BUSY')
    const controller = new AbortController()
    const run = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, baseline, deadline: clock() + batchTimeoutMs, actions: 0, limit: Number.isSafeInteger(options.maxActions) && options.maxActions > 0 && options.maxActions <= maxActions ? options.maxActions : maxActions, owned: {}, cleanup: null }
    active = run
    status = { phase: 'planning', busy: true, stage: 'planning', actions: 0, reason: null, code: null, cleanupErrors: [], trace: [] }
    try {
      const plan = preview(options)
      if (!plan.ready) throw new ShelterError(plan.reason ?? plan.errors?.join('\n') ?? 'A shelter approach or safe soil site is required', plan.code ?? 'PLAN_REJECTED')
      if (memory?.site && !sameSite(memory.site, plan)) throw new ShelterError('A partial shelter cannot silently switch to another site', 'SITE_CHANGED')
      memory = { version: 1, scope: { dimension: baseline.dimension, realmId: baseline.realm?.id == null ? null : String(baseline.realm.id) }, site: copy(plan), cleared: memory?.cleared ?? [], placements: memory?.placements ?? [], established: memory?.established === true, totalActions: amount(memory?.totalActions), pendingPlacement: memory?.pendingPlacement ?? null, stage: operation }
      delete memory.site.memo
      restorePending(run)
      if (operation === 'leave') {
        if (!memory.established || !memory.site.doorCells.every(item => placementAt(item.position))) throw new ShelterError('Only the two server-confirmed own doorway placements may be reopened', 'OWN_ENTRANCE_UNCONFIRMED')
        for (const item of [...memory.site.doorCells].reverse()) {
          const block = readBlock(item.position)
          if (!clear(block) && nameOf(block) !== 'dirt') throw new ShelterError('The own doorway was replaced by another block', 'DOOR_CHANGED')
          await dig(run, item, true)
        }
        await moveTo(run, memory.site.outsideStandpoint)
        if (!memory.site.doorCells.every(item => clear(readBlock(item.position)))) throw new ShelterError('The doorway did not become received air', 'DOOR_NOT_OPEN')
        publish('left_shelter')
      } else {
        const currentInside = inside(check(run), memory.site)
        const alreadyClosed = memory.site.doorCells.every(item => solid(readBlock(item.position)) && nameOf(readBlock(item.position)) === 'dirt' && placementAt(item.position))
        if (!(currentInside && alreadyClosed)) {
          if (!currentInside) for (const step of memory.site.initialSteps) {
            const current = check(run)
            const index = Math.floor(current.position.x) === memory.site.inner.x && Math.floor(current.position.z) === memory.site.inner.z ? 2 : Math.floor(current.position.x) === memory.site.entry.x && Math.floor(current.position.z) === memory.site.entry.z ? 1 : 0
            if (step.index < index) continue
            for (const item of step.clearance) await dig(run, item)
            await moveTo(run, step.target)
          }
          const remainingDoors = memory.site.doorCells.filter(item => !(nameOf(readBlock(item.position)) === 'dirt' && placementAt(item.position))).length
          await collectSoil(run, remainingDoors)
          await ensureInside(run)
          for (const item of memory.site.doorCells) await place(run, item.position)
        }
        memory.established = memory.site.doorCells.every(item => placementAt(item.position))
        const actual = inspect(memory.site, check(run))
        if (!actual.usable || !actual.inside) throw new ShelterError('The enclosed refuge is not verified safe inside', 'REFUGE_NOT_CONFIRMED')
        publish('closed_refuge')
      }
      status.phase = 'completed'; status.stage = operation === 'leave' ? 'outside' : 'closed_refuge'
      return { ok: true, ...snapshot(), busy: false, goalComplete: operation !== 'leave', partial: false }
    } catch (error) {
      status.reason = error.message; status.code = error.code ?? 'SHELTER_FAILED'
      if (error.code === 'BATCH_COMPLETE') { publish('partial', { reason: error.message }); return { ok: true, ...snapshot(), busy: false, partial: true, goalComplete: false } }
      if (error.code === 'REPLAN_REQUIRED' && run.progressCandidate && !memory?.pendingPlacement) {
        let progress = null
        try {
          await cleanup(run, error.message)
          const current = check(run)
          progress = confirmedBatchMovementProgress(run.progressCandidate.before, current, run.progressCandidate.target)
        } catch (failure) { error = failure }
        if (progress && !status.cleanupErrors.length) {
          status.phase = 'progress'; status.reason = error.message; status.code = 'CONFIRMED_MOVEMENT_PROGRESS'
          publish('movement_progress', { progress })
          return { ok: true, ...snapshot(), busy: false, partial: true, goalComplete: false, arrived: false, collected: false, serverConfirmed: false, progressConfirmed: true, progress, requiresObservation: true }
        }
      }
      controller.abort(error)
      status.phase = run.signal.aborted && signal?.aborted ? 'stopped' : 'failed'
      publish(status.phase, { reason: error.message, code: status.code })
      await cleanup(run, error.message)
      throw error
    } finally { status.busy = false; active = null }
  }
  async function stop (reason = 'Shelter work stopped') {
    if (!active) return snapshot()
    const run = active
    run.controller.abort(new ShelterError(String(reason), 'ABORTED'))
    await cleanup(run, String(reason))
    return snapshot()
  }
  function restoreMemo (saved) {
    if (active) throw new ShelterError('Saved shelter history cannot replace an active batch', 'BUSY')
    if (memory != null) return { restored: false, code: 'MEMORY_ALREADY_PRESENT', requiresWorldValidation: true }
    if (saved == null) return { restored: false, code: 'NO_SAVED_MEMO', requiresWorldValidation: true }
    if (saved.version !== 1 || !saved.scope || !['overworld', 'nether', 'end'].includes(saved.scope.dimension) || saved.scope.realmId == null || !Array.isArray(saved.placements) || saved.placements.length > 2 || !Array.isArray(saved.cleared) || saved.cleared.length > 14 || !Number.isSafeInteger(saved.totalActions) || saved.totalActions < 0) throw new ShelterError('Saved shelter history has an invalid structure', 'INVALID_MEMO')
    const restored = copy(saved)
    validatePlan(restored.site)
    // No status, receipt or readiness is added here. snapshot/preview must read
    // the current scope and world, including after an asynchronous disk load.
    memory = restored
    return { restored: true, requiresWorldValidation: true, pendingReconciliation: restored.pendingPlacement?.requiresReconciliation === true }
  }
  return { preview, execute: (options, context) => perform('build', options, context), leave: (options, context) => perform('leave', options, context), stop, snapshot, restoreMemo, memo: () => memory ? copy(memory) : null }
}

module.exports = { createShelter, ShelterError }
