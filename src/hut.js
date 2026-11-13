'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { confirmedBatchMovementProgress } = require('./batch-movement-progress')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const OWN_SOIL = new Set(['dirt', 'grass_block'])
const HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder|anvil|fire|cactus|magma|powder_snow|cobweb|scaffolding|pointed_dripstone)/
const copy = value => structuredClone(value)
const nameOf = value => String(typeof value === 'string' ? value : value?.name ?? '').replace(/^minecraft:/, '')
const { pointKey: key } = require('./vec3')
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000000)
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const layers = block => !(block.extra ?? []).some(layer => !AIR.has(nameOf(layer)))
const clear = block => block?.known === true && AIR.has(nameOf(block)) && layers(block)
const solid = block => block?.known === true && block.boundingBox === 'block' && !HAZARD.test(nameOf(block)) && layers(block)
const dirtCount = state => (state.inventory?.items ?? []).reduce((total, item) => total + (nameOf(item) === 'dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
const positionConfirmed = state => state.positionSource !== 'client_prediction' && state.positionServerConfirmed === true
const faceOffsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

class HutError extends Error {
  constructor (message, code) { super(message); this.code = code }
}

// Executes a fixed, known 3x3 soil-hut timeline. The caller owns actor/stream
// exclusion. No proposed block, pickup or movement is written into live state.
function createHut ({ getState, world, planner, mining, getMining, movement, getMovement, inventory, interactions, onProgress = () => {}, memo: initialMemo = null, maxActions = 12, maxTotalActions = 256, timeoutMs = 15000, batchTimeoutMs = 120000, pickupTimeoutMs = 5000, pollMs = 100, clock = Date.now, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }) }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || !(typeof planner === 'function' || typeof planner?.preview === 'function') || ['preview', 'start', 'stop'].some(method => typeof mining?.[method] !== 'function' || typeof movement?.[method] !== 'function') || typeof getMining !== 'function' || typeof getMovement !== 'function' || typeof inventory?.equip !== 'function' || typeof interactions?.previewPlace !== 'function' || typeof interactions?.placeBlock !== 'function') throw new Error('Hut requires state, world, planner and owned mining/movement/equipment/placement callbacks')
  if (![maxActions, maxTotalActions].every(value => Number.isSafeInteger(value) && value > 0) || maxActions > 64 || maxTotalActions > 512 || ![timeoutMs, batchTimeoutMs, pickupTimeoutMs, pollMs].every(value => Number.isFinite(value) && value > 0) || timeoutMs > 120000 || batchTimeoutMs > 300000 || pickupTimeoutMs > 10000 || pollMs > 1000) throw new Error('Invalid hut operation limits')
  let active = null
  let memory = null
  let replayedPendingPlacement = null
  let status = { phase: 'idle', busy: false, stage: null, actions: 0, reason: null, code: null, cleanupErrors: [] }

  function restoreMemo (memo) {
    if (active) throw new HutError('Stop the active hut batch before restoring a memo', 'BUSY')
    memory = memo == null ? null : copy(memo)
    if (memory?.pendingPlacement) memory.pendingPlacement.requiresReconciliation = true
    replayedPendingPlacement = memory?.pendingPlacement ?? null
    return memory ? copy(memory) : null
  }
  restoreMemo(initialMemo)
  function readBlock (point) {
    const block = world.getBlock(point.x, point.y, point.z)
    if (block?.known !== true || typeof block.name !== 'string') throw new HutError(`Unknown terrain at ${key(point)}`, 'UNKNOWN_TERRAIN')
    if (block.protected === true) throw new HutError(`Protected hut terrain at ${key(point)}`, 'PROTECTED_BLOCK')
    return block
  }
  function state (baseline) {
    const value = getState()
    if (value?.phase !== 'spawned' || value.dead || value.isDead || value.lifecycle?.dead || !finite(value.position)) throw new HutError('Hut work requires a living spawned player and a known position', 'NOT_READY')
    if (value.gameMode !== 'survival' && value.gameMode !== 0) throw new HutError('Hut construction is survival-only', 'UNSUPPORTED_MODE')
    if (!Number.isFinite(value.health) || value.health <= 6) throw new HutError('Health is low or unknown', 'LOW_HEALTH')
    if (value.inventory?.known !== true || value.inventory.uncertain || !Array.isArray(value.inventory.items)) throw new HutError('Confirmed server inventory is required', 'INVENTORY_UNKNOWN')
    if ((value.entities ?? []).some(actor => actor.alive !== false && !actor.dead && actor.kind !== 'item' && (!finite(actor.position) || actor.positionKnown === false))) throw new HutError('Observed actor positions must be known before hut work', 'ACTOR_POSITION_UNKNOWN')
    if (baseline && (value.dimension !== baseline.dimension || value.startedAt !== baseline.startedAt || baseline.connectionId != null && value.connectionId !== baseline.connectionId)) throw new HutError('The hut session changed', 'SESSION_CHANGED')
    if (baseline && value.health < baseline.health) throw new HutError('The player took damage during hut work', 'TOOK_DAMAGE')
    if (memory?.scope && (memory.scope.dimension !== value.dimension || memory.scope.realmId != null && memory.scope.realmId !== String(value.realm?.id))) throw new HutError('The remembered hut belongs to another world', 'SITE_SCOPE_CHANGED')
    return value
  }
  function geometry (site) {
    const c = site?.center
    const forward = site?.forward
    if (site?.type !== 'soil_hut' || !integer(c) || !forward || !Number.isInteger(forward.x) || !Number.isInteger(forward.z) || Math.abs(forward.x) + Math.abs(forward.z) !== 1) throw new HutError('A validated cardinal soil hut site is required', 'INVALID_PLAN')
    const door = { x: c.x - forward.x, y: c.y, z: c.z - forward.z }
    const floor = []; const walls = []
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      floor.push({ x: c.x + dx, y: c.y - 1, z: c.z + dz })
      if ((dx || dz) && (c.x + dx !== door.x || c.z + dz !== door.z)) for (const dy of [0, 1]) walls.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz })
    }
    const temporary = [{ ...c }, { ...c, y: c.y + 1 }]
    const roof = { ...c, y: c.y + 2 }
    const doors = [{ ...door }, { ...door, y: c.y + 1 }]
    return { floor, walls, temporary, roof, doors, permanent: [...walls, roof, ...doors], all: [...walls, roof, ...temporary, ...doors] }
  }
  function validatePlan (site) {
    const shape = geometry(site)
    if (!site.ready || !finite(site.insideStandpoint) || !finite(site.outsideStandpoint) || site.insideStandpoint.x !== site.center.x + 0.5 || site.insideStandpoint.y !== site.center.y || site.insideStandpoint.z !== site.center.z + 0.5 || site.outsideStandpoint.x !== site.center.x - site.forward.x * 2 + 0.5 || site.outsideStandpoint.y !== site.center.y || site.outsideStandpoint.z !== site.center.z - site.forward.z * 2 + 0.5 || !Array.isArray(site.steps) || site.steps.length > 128) throw new HutError('Hut standpoints or timeline are invalid', 'INVALID_PLAN')
    const placements = site.steps.filter(step => step.type === 'place')
    const expected = new Set(shape.all.map(key))
    if (placements.length !== 19 || new Set(placements.map(step => key(step.position ?? {}))).size !== 19 || placements.some(step => !integer(step.position) || !expected.has(key(step.position)) || nameOf(step.item) !== 'dirt' || step.face !== 1 || !integer(step.support) || step.support.x !== step.position.x || step.support.y !== step.position.y - 1 || step.support.z !== step.position.z)) throw new HutError('Only the 19 planned ordinary top-face dirt placements are allowed', 'INVALID_PLAN')
    const mines = site.steps.filter(step => step.type === 'mine')
    if (mines.length !== 2 || key(mines[0].position ?? {}) !== key(shape.temporary[1]) || key(mines[1].position ?? {}) !== key(shape.temporary[0])) throw new HutError('Only the own upper then lower temporary pillar may be mined during construction', 'INVALID_PLAN')
    const barriers = site.steps.filter(step => step.type === 'wait_material')
    const barrierIndex = site.steps.findIndex(step => step.type === 'wait_material')
    const lastMine = site.steps.findLastIndex(step => step.type === 'mine')
    const roofIndex = site.steps.findIndex(step => step.type === 'place' && key(step.position) === key(shape.roof))
    if (barriers.length !== 1 || barrierIndex <= lastMine || roofIndex < 0 || roofIndex >= site.steps.findIndex(step => step.type === 'mine') || site.steps.slice(-2).some((step, index) => step.type !== 'place' || key(step.position ?? {}) !== key(shape.doors[index])) || barrierIndex >= site.steps.length - 2) throw new HutError('Roof, pillar recovery and lower-to-upper closure must keep their verified order', 'INVALID_PLAN')
    for (const step of site.steps) {
      if (!['place', 'mine', 'move', 'wait_material'].includes(step.type)) throw new HutError('Unknown hut construction step', 'INVALID_PLAN')
      const positions = step.type === 'move' ? [step.target] : step.type === 'wait_material' ? [] : step.standpoints
      if (!Array.isArray(positions) || positions.length > 16 || positions.some(point => !finite(point) || !Number.isInteger(point.y) || point.y < site.center.y || point.y > site.center.y + 2 || horizontal(point, site.insideStandpoint) > 5)) throw new HutError('Hut construction standpoints exceed the bounded site', 'INVALID_PLAN')
      if (step.type === 'wait_material' && (nameOf(step.item) !== 'dirt' || step.count !== 2)) throw new HutError('The material barrier must recover two real dirt items', 'INVALID_PLAN')
    }
    return site
  }
  function receipt (point, activeOnly = true) {
    if (memory?.pendingPlacement && key(memory.pendingPlacement.position ?? {}) === key(point)) return undefined
    return memory?.placements?.find(item => key(item.position) === key(point) && item.item === 'minecraft:dirt' && item.count === 1 && item.serverConfirmed === true && (!activeOnly || item.removed !== true))
  }
  function ownedSoil (point) { const block = readBlock(point); return !!receipt(point) && OWN_SOIL.has(nameOf(block)) && solid(block) }
  function grounded (value) {
    const feet = value.position.y - 1.62; const y = Math.round(feet)
    const predicted = value.predicted?.physicsState ?? value.physicsState
    if (Math.abs(feet - y) > 1e-4 || predicted?.onGround === false || predicted?.isInWater === true) return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const x = Math.floor(value.position.x + dx); const z = Math.floor(value.position.z + dz)
      if (!solid(readBlock({ x, y: y - 1, z })) || !clear(readBlock({ x, y, z })) || !clear(readBlock({ x, y: y + 1, z }))) return false
    }
    return true
  }
  function inside (value, site) { return grounded(value) && Math.round(value.position.y - 1.62) === site.center.y && Math.floor(value.position.x - 0.2999) === site.center.x && Math.floor(value.position.x + 0.2999) === site.center.x && Math.floor(value.position.z - 0.2999) === site.center.z && Math.floor(value.position.z + 0.2999) === site.center.z }
  function actorsClear (point, value) {
    for (const actor of value.entities ?? []) {
      if (actor.alive === false || actor.dead || actor.health === 0 || actor.kind === 'item' || String(actor.runtimeId ?? actor.runtimeEntityId) === String(value.runtimeEntityId)) continue
      if (!finite(actor.position) || actor.positionKnown === false) throw new HutError('An actor position is unknown during construction', 'ACTOR_POSITION_UNKNOWN')
      if (actor.dimension != null && actor.dimension !== value.dimension) continue
      const p = actor.position
      const bottom = actor.kind === 'player' ? p.y - 1.62 : p.y - 0.5
      const top = actor.kind === 'player' ? p.y + 0.3 : p.y + 2.5
      if (p.x + 0.8 > point.x && p.x - 0.8 < point.x + 1 && p.z + 0.8 > point.z && p.z - 0.8 < point.z + 1 && top > point.y && bottom < point.y + 1) throw new HutError('A living actor may intersect the placement cell', 'ACTOR_COLLISION')
    }
  }
  function floorIntact (site) { for (const point of geometry(site).floor) if (!solid(readBlock(point))) throw new HutError('A preserved hut floor changed', 'STRUCTURE_CHANGED') }
  function verifyHistoricalReclosure (site, value) {
    const shape = geometry(site)
    if (!memory.previouslyEstablished || memory.stepIndex !== site.steps.length || memory.recoveredTemporaryDirt !== true || shape.permanent.some(point => !receipt(point, false))) throw new HutError('Historical completion, recovered pillar and all original soil receipts are required for a new closure', 'HISTORICAL_CLOSURE_UNCONFIRMED')
    floorIntact(site)
    for (const point of [...shape.walls, shape.roof]) if (!ownedSoil(point)) throw new HutError('A historical own soil wall or roof is missing', 'STRUCTURE_CHANGED')
    if (shape.temporary.some(point => !clear(readBlock(point)))) throw new HutError('The remembered hut interior is not received air', 'INTERIOR_BLOCKED')
    if (shape.doors.some(point => !clear(readBlock(point)))) throw new HutError('Both historical door targets must be received air before a fresh two-block closure', 'DOOR_NOT_OPEN')
    actorsClear(site.center, value)
  }
  function inspect (site, value = getState()) {
    if (memory?.pendingPlacement) throw new HutError('Pending placement ownership must be reconciled before confirming the hut', 'PLACEMENT_UNCERTAIN')
    const shape = geometry(site)
    if (memory?.scope && (memory.scope.dimension !== value.dimension || memory.scope.realmId != null && memory.scope.realmId !== String(value.realm?.id))) throw new HutError('The hut geometry belongs to another world', 'SITE_SCOPE_CHANGED')
    floorIntact(site)
    for (const point of [...shape.walls, shape.roof]) if (!ownedSoil(point)) throw new HutError('A received own soil wall or roof is missing', 'STRUCTURE_CHANGED')
    for (const point of shape.temporary) if (!clear(readBlock(point))) throw new HutError('The temporary pillar is still in the interior', 'INTERIOR_BLOCKED')
    const closed = shape.doors.every(ownedSoil)
    for (const point of shape.doors) if (!clear(readBlock(point)) && !ownedSoil(point)) throw new HutError('The doorway is blocked by an unconfirmed block', 'DOOR_CHANGED')
    actorsClear(site.center, value)
    const established = memory?.established === true
    return { established, structureIntact: true, geometryVerified: true, inside: inside(value, site), entranceClosed: closed, closed, usable: established && closed, serverConfirmed: established, positionServerConfirmed: positionConfirmed(value), positionSource: value.positionSource ?? 'unknown', confirmedBy: established ? 'received_structure_and_inventory_spend' : null }
  }
  function preview (options = {}) {
    try {
      const current = state()
      const saved = options.memo ?? memory
      if (saved?.pendingPlacement?.requiresReconciliation || saved?.pendingPlacement) throw new HutError('An unresolved placement cannot become an ownership receipt after replay', 'PLACEMENT_UNCERTAIN')
      if (saved && (saved.placements != null && (!Array.isArray(saved.placements) || saved.placements.some(item => !integer(item?.position))) || saved.stepIndex != null && (!Number.isSafeInteger(saved.stepIndex) || saved.stepIndex < 0) || saved.totalActions != null && (!Number.isSafeInteger(saved.totalActions) || saved.totalActions < 0))) throw new HutError('The hut memo is invalid', 'INVALID_MEMO')
      const site = options.site ?? options.plan ?? saved?.site
      const plan = typeof planner === 'function' ? planner(current, { getBlock: (x, y, z) => world.getBlock(x, y, z), entities: current.entities ?? [], memo: saved, observedAt: clock() }, { ...options, memo: saved, ...(site ? { site } : {}) }) : planner.preview({ ...options, memo: saved, ...(site ? { site } : {}) })
      if (!plan?.ready) return { ...copy(plan), resumeReady: false, canResume: false }
      validatePlan(plan)
      if (saved?.stepIndex > plan.steps.length) throw new HutError('The saved timeline cursor is invalid', 'INVALID_MEMO')
      if (!saved?.site && dirtCount(current) < 17) return { ...copy(plan), ready: false, code: 'MATERIAL_MISSING', requiredDirt: 17, availableDirt: dirtCount(current) }
      let actual = {}
      try { actual = inspect(plan, current) } catch { /* A valid unfinished timeline remains a proposal. */ }
      return { ...copy(plan), ...actual, closureMaterials: closureMaterials(plan, current, actual), ready: true, resumeReady: !!saved?.site, canResume: !!saved?.site, memo: saved ? copy(saved) : null }
    } catch (error) { return { ready: false, code: error.code ?? 'PLAN_FAILED', reason: error.message, resumeReady: false, canResume: false } }
  }
  function closureMaterials (site, current, actual) {
    if (!site || !current || current.inventory?.known !== true || current.inventory.uncertain || actual?.structureIntact !== true || !(memory?.established || memory?.previouslyEstablished) || memory.stepIndex !== site.steps.length || memory.pendingPlacement) return null
    const requiredDirt = geometry(site).doors.filter(point => clear(readBlock(point))).length
    const availableDirt = dirtCount(current)
    return { item: 'minecraft:dirt', requiredDirt, availableDirt, missingDirt: Math.max(0, requiredDirt - availableDirt), requiresServerInventory: true }
  }
  function snapshot () {
    let actual = { established: false, structureIntact: false, geometryVerified: false, inside: false, entranceClosed: false, closed: false, usable: false, serverConfirmed: false }
    let materials = null
    try { if (memory?.site) { const current = getState(); actual = inspect(memory.site, current); materials = closureMaterials(memory.site, current, actual) } } catch { /* Stored receipts are never a current geometry proof. */ }
    return copy({ ...status, ...actual, closureMaterials: materials, stepIndex: memory?.stepIndex ?? 0, memo: memory, canResume: !status.busy && !!memory?.site && !memory.pendingPlacement && preview({ site: memory.site }).ready })
  }
  function publish (stage, details = {}) { status.stage = stage; try { Promise.resolve(onProgress({ type: 'hut', phase: status.phase, stage, ...copy(details), memo: memory ? copy(memory) : null })).catch(() => {}) } catch { /* Persistence cannot change a wire result. */ } }
  function reconcileEmptyPlacement () {
    if (active || status.busy) throw new HutError('Stop the active hut batch before reconciling a placement', 'BUSY')
    const pending = memory?.pendingPlacement
    if (!pending || pending.requiresReconciliation !== true || replayedPendingPlacement !== pending) throw new HutError('Only a replayed unresolved placement can be explicitly abandoned', 'PLACEMENT_NOT_REPLAYED')
    const current = state()
    const savedScope = memory.scope
    if (!savedScope || savedScope.realmId == null || current.realm?.id == null || String(savedScope.realmId) !== String(current.realm.id) || savedScope.dimension == null || savedScope.dimension !== current.dimension || savedScope.profile != null && savedScope.profile !== current.profile || memory.ownerProfile != null && memory.ownerProfile !== current.profile) throw new HutError('The unresolved placement belongs to another or unknown world/profile', 'SITE_SCOPE_CHANGED')
    const miningState = getMining(); const movementState = getMovement()
    if (!miningState || !movementState || typeof miningState.then === 'function' || typeof movementState.then === 'function' || typeof miningState.phase !== 'string' || typeof movementState.phase !== 'string' || miningState.busy || miningState.running || ['mining', 'running'].includes(miningState.phase) || movementState.busy || movementState.running || ['moving', 'settling', 'walking'].includes(movementState.phase) || inventory.snapshot?.().busy || interactions.snapshot?.().pendingOperation) throw new HutError('Existing actor work must finish before reconciling a placement', 'BUSY')
    if (!integer(pending.position) || nameOf(pending.item) !== 'dirt' || !geometry(memory.site).all.some(point => key(point) === key(pending.position))) throw new HutError('The unresolved dirt placement is outside the remembered hut', 'INVALID_PENDING_PLACEMENT')
    const target = readBlock(pending.position)
    if (!clear(target) || (target.extra?.length ?? 0) !== 0) throw new HutError('Only a currently received empty target without additional layers can abandon an old placement', 'PLACEMENT_TARGET_NOT_EMPTY')
    const abandonedPlacement = copy(pending)
    memory.pendingPlacement = null
    replayedPendingPlacement = null
    publish('abandon_empty_target', { abandonedPlacement })
    return { action: 'abandon_empty_target', abandonedPlacement, memo: copy(memory), placementConfirmed: false, serverConfirmed: false, requiresWorldValidation: true }
  }
  function check (run) { if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new HutError('Hut work cancelled', 'ABORTED'); if (clock() >= run.deadline) throw new HutError('Hut batch timed out', 'TIMEOUT'); const current = state(run.baseline); if (memory?.site) floorIntact(memory.site); return current }
  async function call (run, label, fn, limit = timeoutMs) {
    check(run)
    let timer; let watch; let abort
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new HutError('Hut work cancelled', 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new HutError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(limit, run.deadline - clock())))
      watch = setInterval(() => { try { check(run) } catch (error) { reject(error) } }, pollMs)
    })
    try { return await Promise.race([Promise.resolve().then(() => { check(run); return fn() }), cancelled]) } finally { clearTimeout(timer); clearInterval(watch); run.signal.removeEventListener('abort', abort) }
  }
  async function poll (run, label, predicate, limit = timeoutMs) {
    const deadline = Math.min(run.deadline, clock() + limit)
    while (clock() < deadline) { const current = check(run); if (await predicate(current)) return current; await call(run, `${label} wait`, () => delay(pollMs, run.signal), pollMs + 1000) }
    throw new HutError(`${label} was not observed`, 'TIMEOUT')
  }
  function budget (run) { if (memory.totalActions >= maxTotalActions) throw new HutError('Hut lifetime action limit reached', 'ACTION_LIMIT'); if (run.actions >= run.limit) throw new HutError('The bounded hut batch is complete', 'BATCH_COMPLETE'); run.actions++; memory.totalActions++; status.actions = run.actions }
  async function moveTo (run, target) {
    const before = check(run)
    const insideTarget = memory?.site?.insideStandpoint && horizontal(target, memory.site.insideStandpoint) <= 1e-7 && Math.abs(target.y - memory.site.insideStandpoint.y) <= 1e-7
    if (horizontal(before.position, target) <= 0.2 && Math.abs(before.position.y - 1.62 - target.y) <= 1e-4 && grounded(before) && (!insideTarget || inside(before, memory.site))) return
    const live = await call(run, 'Hut land movement preview', () => movement.preview(copy(target), { allowWater: false, maxDistance: 12 }))
    if (!live?.ready) throw new HutError(live?.reason ?? 'No known safe hut stance route', 'NO_SAFE_ROUTE')
    budget(run); run.owned.movement = true
    publish('moving', { target })
    await call(run, 'Hut movement start', () => movement.start(copy(target), { allowWater: false, maxDistance: 12 }))
    await poll(run, 'Fresh supported hut arrival', async () => {
      const motion = await call(run, 'Movement state', () => getMovement())
      const current = check(run)
      if (['failed', 'stopped'].includes(motion?.phase)) throw new HutError(motion.reason ?? 'Hut movement stopped', 'MOVEMENT_FAILED')
      const terminal = ['awaiting_server_confirmation', 'replan_required', 'completed', 'idle'].includes(motion?.phase)
      const arrived = horizontal(current.position, target) <= 0.2 && Math.abs(current.position.y - 1.62 - target.y) <= 1e-4 && current.positionUpdatedAt != null && current.positionUpdatedAt !== before.positionUpdatedAt && grounded(current) && (!insideTarget || inside(current, memory.site)) && terminal
      if (terminal && !arrived) {
        if (confirmedBatchMovementProgress(before, current, target)) run.progressCandidate = { before, target: copy(target) }
        throw new HutError('Movement correction requires a new hut batch', 'REPLAN_REQUIRED')
      }
      return arrived
    })
    run.owned.movement = false
  }
  async function stance (run, step, previewAction) {
    const current = check(run)
    const points = [null, ...(step.standpoints ?? [])]
    const tried = new Set()
    for (const point of points) {
      const id = point ? key(point) : 'current'
      if (tried.has(id)) continue
      tried.add(id)
      if (point) {
        try { if (!solid(readBlock({ x: Math.floor(point.x), y: point.y - 1, z: Math.floor(point.z) })) || !clear(readBlock({ x: Math.floor(point.x), y: point.y, z: Math.floor(point.z) })) || !clear(readBlock({ x: Math.floor(point.x), y: point.y + 1, z: Math.floor(point.z) }))) continue; await moveTo(run, point) } catch (error) { if (error.code === 'NO_SAFE_ROUTE') continue; throw error }
      } else if (!grounded(current)) continue
      const live = await call(run, 'Live hut action preview', previewAction)
      if (live?.ready) return live
    }
    throw new HutError('No live-previewed known stance can perform this hut step', 'PREVIEW_REJECTED')
  }
  async function selectDirt (run) {
    let current = check(run)
    const item = current.inventory.items.find(item => nameOf(item) === 'dirt' && item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
    if (!item) throw new HutError('Actual inventory dirt is required', 'MATERIAL_MISSING')
    if ((current.rawServerSelectedSlot ?? current.rawSelectedSlot) !== item.slot || current.equipmentServerConfirmed === false) {
      budget(run); run.owned.inventory = true
      const response = await call(run, 'Confirmed dirt equipment', () => inventory.equip(item.slot))
      current = check(run)
      const selected = current.rawServerSelectedSlot ?? current.rawSelectedSlot
      if (response?.phase !== 'completed' || response.serverConfirmed !== true || !current.inventory.items.some(item => item.slot === selected && nameOf(item) === 'dirt' && item.count > 0)) throw new HutError('Dirt was not confirmed in the raw selected slot', 'EQUIPMENT_NOT_CONFIRMED')
      run.owned.inventory = false
    }
    const slot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new HutError('The raw selected slot is unknown', 'EQUIPMENT_NOT_CONFIRMED')
    return slot
  }
  async function place (run, step) {
    const point = step.position
    if (ownedSoil(point)) return
    if (!clear(readBlock(point))) throw new HutError('An unconfirmed nonempty cell cannot be overwritten', 'PLACEMENT_CHANGED')
    const shape = geometry(memory.site)
    if (shape.doors.some(door => key(door) === key(point))) {
      if (!inside(check(run), memory.site) || !memory.recoveredTemporaryDirt || shape.temporary.some(point => !clear(readBlock(point))) || [...shape.walls, shape.roof].some(point => !ownedSoil(point))) throw new HutError('Verified interior, shell and real pillar recovery are required before closing the door', 'INSIDE_NOT_CONFIRMED')
    }
    const slot = await selectDirt(run)
    const live = await stance(run, step, () => check(run).position.y > point.y + 0.01 ? interactions.previewPlace({ position: copy(point), slot }) : { ready: false, errors: ['The real top support face must be visible from above'] })
    if (nameOf(live.expectedBlock) !== 'dirt' || live.position && key(live.position) !== key(point)) throw new HutError('The live placement does not identify the planned dirt cell', 'PLACEMENT_PREVIEW_REJECTED')
    const current = check(run)
    actorsClear(point, current)
    if (current.position.x + 0.3 > point.x && current.position.x - 0.3 < point.x + 1 && current.position.z + 0.3 > point.z && current.position.z - 0.3 < point.z + 1 && current.position.y > point.y && current.position.y - 1.62 < point.y + 1) throw new HutError('The player intersects the placement cell', 'SELF_COLLISION')
    if (!clear(readBlock(point)) || !solid(readBlock(step.support))) throw new HutError('Placement target or its top-face support changed', 'PLACEMENT_CHANGED')
    const before = dirtCount(current)
    budget(run); run.owned.interactions = true
    memory.pendingPlacement = { position: copy(point), beforeDirt: before, item: 'minecraft:dirt', requiresReconciliation: false }
    replayedPendingPlacement = null
    publish(step.stage, { position: point })
    const response = await call(run, 'Dirt placement', () => interactions.placeBlock({ position: copy(point), slot }))
    if (response?.phase !== 'completed') throw new HutError('Dirt placement was not confirmed', 'PLACEMENT_NOT_CONFIRMED')
    await poll(run, 'Received dirt and inventory spend', current => nameOf(readBlock(point)) === 'dirt' && solid(readBlock(point)) && dirtCount(current) === before - 1)
    memory.placements = memory.placements.filter(item => key(item.position) !== key(point))
    memory.placements.push({ position: copy(point), item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease' })
    memory.pendingPlacement = null; run.owned.interactions = false
    publish('placed', { position: point })
  }
  async function dig (run, step, door = false) {
    const point = step.position
    const own = receipt(point, false)
    if (clear(readBlock(point))) { if (!own) throw new HutError('Unowned soil cannot be removed', 'OWNERSHIP_UNKNOWN'); own.removed = true; return }
    const block = readBlock(point)
    if (!own || own.removed || !OWN_SOIL.has(nameOf(block)) || !solid(block) || block.protected || block.diggable === false) throw new HutError('Only the received own temporary pillar or door may be mined', 'OWNERSHIP_UNKNOWN')
    const shape = geometry(memory.site)
    const allowed = door ? shape.doors : shape.temporary
    if (!allowed.some(value => key(value) === key(point))) throw new HutError('This cell is outside the own removable structure', 'INVALID_DIG')
    for (const [x, y, z] of faceOffsets) { const neighbour = readBlock({ x: point.x + x, y: point.y + y, z: point.z + z }); if (HAZARD.test(nameOf(neighbour)) || !layers(neighbour)) throw new HutError('Unsafe hut mining neighbour', 'UNSAFE_NEIGHBOUR') }
    await stance(run, step, () => mining.preview([copy(point)]))
    const current = check(run)
    const fresh = readBlock(point)
    if (!OWN_SOIL.has(nameOf(fresh)) || !solid(fresh) || !receipt(point) || fresh.diggable === false) throw new HutError('The own soil changed while approaching its mining stance', 'OWNERSHIP_UNKNOWN')
    for (const [x, y, z] of faceOffsets) { const neighbour = readBlock({ x: point.x + x, y: point.y + y, z: point.z + z }); if (HAZARD.test(nameOf(neighbour)) || !layers(neighbour)) throw new HutError('The hut mining neighbourhood changed', 'UNSAFE_NEIGHBOUR') }
    if (Math.floor(current.position.x) === point.x && Math.floor(current.position.z) === point.z && point.y <= current.position.y - 1.62 + 1e-4) throw new HutError('The own supporting column cannot be mined', 'SELF_COLUMN')
    if (!door && memory.reclaimBaseline == null) memory.reclaimBaseline = dirtCount(current)
    budget(run); run.owned.mining = true
    publish('digging_own_soil', { position: point })
    await call(run, 'Own dirt mining', () => mining.start([copy(point)]))
    await poll(run, 'Received own dirt destruction', async () => { const miningState = await call(run, 'Mining state', () => getMining()); if (['failed', 'stopped'].includes(miningState?.phase)) throw new HutError(miningState.reason ?? 'Mining stopped', 'MINING_FAILED'); return clear(readBlock(point)) && ['completed', 'idle'].includes(miningState?.phase) })
    own.removed = true; run.owned.mining = false
    publish('own_soil_removed', { position: point })
  }
  async function materialBarrier (run) {
    if (!Number.isSafeInteger(memory.reclaimBaseline)) throw new HutError('Temporary pillar recovery has no actual inventory baseline', 'RECOVERY_BASELINE_UNKNOWN')
    publish('recover_temporary_pillar')
    await poll(run, 'Two real recovered dirt items', current => dirtCount(current) >= memory.reclaimBaseline + 2, pickupTimeoutMs)
    memory.recoveredTemporaryDirt = true
    publish('temporary_dirt_recovered')
  }
  async function cleanup (run, reason) {
    if (run.cleanup) return run.cleanup
    const stops = [run.owned.mining && (() => mining.stop(reason)), run.owned.movement && (() => movement.stop(reason)), run.owned.inventory && inventory.cancel && (() => inventory.cancel(reason)), run.owned.interactions && interactions.cancel && (() => interactions.cancel(reason))].filter(Boolean)
    run.cleanup = Promise.allSettled(stops.map(fn => { let timer; return Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned hut controller did not stop')), 1000) })]).finally(() => clearTimeout(timer)) })).then(results => { status.cleanupErrors = results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message ?? result.reason)) })
    return run.cleanup
  }
  async function perform (operation, options = {}, { signal } = {}) {
    if (active) throw new HutError('Another hut batch is active', 'BUSY')
    if (signal?.aborted) throw signal.reason ?? new HutError('Hut work cancelled', 'ABORTED')
    if (options.memo != null) restoreMemo(options.memo)
    const baseline = state()
    const controller = new AbortController()
    const run = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, baseline, deadline: clock() + batchTimeoutMs, actions: 0, limit: Number.isSafeInteger(options.maxActions) && options.maxActions > 0 && options.maxActions <= maxActions ? options.maxActions : maxActions, owned: {}, cleanup: null }
    active = run
    status = { phase: 'building', busy: true, stage: operation, actions: 0, reason: null, code: null, cleanupErrors: [] }
    let completed = false
    try {
      const miningState = await call(run, 'Initial mining ownership', () => getMining())
      const movementState = await call(run, 'Initial movement ownership', () => getMovement())
      if (['mining', 'running'].includes(miningState?.phase) || ['moving', 'settling', 'walking'].includes(movementState?.phase) || movementState?.running || inventory.snapshot?.().busy || interactions.snapshot?.().pendingOperation) throw new HutError('Existing actor work must finish before hut construction', 'BUSY')
      const plan = preview(options)
      if (!plan.ready) throw new HutError(plan.reason ?? plan.errors?.join('\n') ?? 'A received flat hut site and real dirt are required', plan.code ?? 'PLAN_REJECTED')
      if (memory?.site && memory.site.id !== plan.id) throw new HutError('A partial hut cannot switch sites', 'SITE_CHANGED')
      if (memory?.site && memory.site.steps.map(step => `${step.type}:${key(step.position ?? step.target ?? {})}`).join('|') !== plan.steps.map(step => `${step.type}:${key(step.position ?? step.target ?? {})}`).join('|')) throw new HutError('A resumed hut cannot change its construction timeline', 'PLAN_CHANGED')
      const historicalReclosure = operation === 'build' && memory?.established !== true && memory?.previouslyEstablished === true && memory.stepIndex === plan.steps.length
      if (historicalReclosure) verifyHistoricalReclosure(plan, baseline)
      memory = { version: 1, kind: 'soil_hut', scope: { dimension: baseline.dimension, realmId: baseline.realm?.id == null ? null : String(baseline.realm.id) }, site: copy(plan), stepIndex: memory?.stepIndex ?? 0, placements: memory?.placements ?? [], totalActions: memory?.totalActions ?? 0, established: memory?.established === true, ...(memory?.previouslyEstablished === true ? { previouslyEstablished: true } : {}), reclaimBaseline: memory?.reclaimBaseline ?? null, recoveredTemporaryDirt: memory?.recoveredTemporaryDirt === true, pendingPlacement: null }
      delete memory.site.memo
      if (operation === 'leave') {
        if (!memory.established || !geometry(plan).doors.every(point => receipt(point, false))) throw new HutError('Only the own confirmed door can be reopened', 'OWN_ENTRANCE_UNCONFIRMED')
        for (const point of [...geometry(plan).doors].reverse()) await dig(run, { position: point, standpoints: [plan.insideStandpoint, plan.outsideStandpoint] }, true)
        await moveTo(run, plan.outsideStandpoint)
        if (!geometry(plan).doors.every(point => clear(readBlock(point)))) throw new HutError('The door is not received air', 'DOOR_NOT_OPEN')
      } else if ((memory.established || historicalReclosure) && memory.stepIndex >= plan.steps.length) {
        const shape = geometry(plan)
        if (!inside(check(run), plan) && shape.doors.some(point => !clear(readBlock(point)))) for (const point of [...shape.doors].reverse()) await dig(run, { position: point, standpoints: [plan.outsideStandpoint, plan.insideStandpoint] }, true)
        await moveTo(run, plan.insideStandpoint)
        await poll(run, 'Actual dirt for reclosing the own door', current => dirtCount(current) >= shape.doors.filter(point => !ownedSoil(point)).length, pickupTimeoutMs)
        for (const point of shape.doors) {
          const step = plan.steps.find(step => step.type === 'place' && key(step.position) === key(point))
          await place(run, step)
        }
        const actual = inspect(plan, check(run))
        if (!actual.closed || !actual.inside) throw new HutError('The returned hut was not reclosed', 'HUT_NOT_CONFIRMED')
        if (historicalReclosure) memory.established = true
      } else {
        while (memory.stepIndex < plan.steps.length) {
          check(run)
          const step = plan.steps[memory.stepIndex]
          if (step.type === 'place') await place(run, step)
          else if (step.type === 'mine') await dig(run, step)
          else if (step.type === 'move') await moveTo(run, step.target)
          else if (step.type === 'wait_material') await materialBarrier(run)
          memory.stepIndex++
          publish(step.stage, { stepIndex: memory.stepIndex })
        }
        const actual = inspect(plan, check(run))
        if (!actual.closed || !actual.inside || !memory.recoveredTemporaryDirt) throw new HutError('The closed hut and real pillar recovery are not confirmed', 'HUT_NOT_CONFIRMED')
        memory.established = true
      }
      completed = true; status.phase = 'completed'; status.busy = false
      publish(operation === 'leave' ? 'left' : 'closed')
      return { ok: true, ...snapshot(), collected: false }
    } catch (error) {
      if (error.code === 'BATCH_COMPLETE') { completed = true; status.phase = 'predicted'; status.reason = error.message; status.busy = false; publish('batch_complete'); return { ok: true, ...snapshot(), partial: true, collected: false } }
      if (error.code === 'REPLAN_REQUIRED' && run.progressCandidate && !memory?.pendingPlacement) {
        let progress = null
        try {
          await cleanup(run, error.message)
          const current = check(run)
          progress = confirmedBatchMovementProgress(run.progressCandidate.before, current, run.progressCandidate.target)
        } catch (failure) { error = failure }
        if (progress && !status.cleanupErrors.length) {
          completed = true; status.phase = 'progress'; status.reason = error.message; status.code = 'CONFIRMED_MOVEMENT_PROGRESS'; status.busy = false
          publish('movement_progress', { progress })
          return { ok: true, ...snapshot(), partial: true, goalComplete: false, arrived: false, collected: false, serverConfirmed: false, progressConfirmed: true, progress, requiresObservation: true }
        }
      }
      status.phase = run.signal.aborted ? 'stopped' : 'failed'; status.reason = error.message; status.code = error.code ?? 'EXECUTION_FAILED'
      if (memory?.pendingPlacement) memory.pendingPlacement.requiresReconciliation = true
      if (!run.signal.aborted) controller.abort(error)
      publish('interrupted')
      throw error
    } finally { if (!completed) await cleanup(run, status.reason); status.busy = false; if (active === run) active = null }
  }
  async function stop (reason = 'Hut work stopped') { const run = active; if (!run) return snapshot(); run.controller.abort(new HutError(reason, 'ABORTED')); if (memory?.pendingPlacement) memory.pendingPlacement.requiresReconciliation = true; status.phase = 'stopped'; status.reason = reason; await cleanup(run, reason); return snapshot() }
  return { preview, execute: (options, context) => perform('build', options, context), leave: (options, context) => perform('leave', options, context), stop, snapshot, memo: () => memory ? copy(memory) : null, restoreMemo, reconcileEmptyPlacement }
}

module.exports = { createHut, HutError }
