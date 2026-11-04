'use strict'

// Quarry job manager (spec v1.2 §4, §8-§11, §14-§16, §18): one job, explicit
// states, a single owner of quarry inputs, journal/checkpoints and the combat
// interruption cycle. Every world action goes through the injected adapter,
// whose results are re-observed before they count.

const { buildRegions, permits, chunkBounds } = require('./quarry-region')
const { createQuarryPlanner } = require('./quarry-planner')
const { blockRule, nameOf, selectTool, AIR } = require('./quarry-rules')
const { keepPlan, canAccept, totals, diff, createLedger, freeSlots, isFood } = require('./quarry-inventory')
const { createQuarryCombatBridge } = require('./quarry-combat-bridge')

const copy = value => value === undefined ? undefined : structuredClone(value)
const FEET = 1.62
const ACTIVE = new Set(['PREFLIGHT', 'SURVEY', 'PLAN', 'MOVE', 'MINE', 'COLLECT', 'RETURN', 'DEPOSIT', 'RESTOCK', 'HAZARD', 'RECOVER', 'SUSPEND_FOR_COMBAT', 'COMBAT', 'COMBAT_SETTLE', 'RECOVER_AFTER_COMBAT', 'RECONCILE', 'FINAL_CHECK', 'DISCONNECTED'])
const RESULT = new Set(['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'PAUSED', 'CANCELLED', 'FAILED'])
// Deferrals that are planned exclusions, not exceptions (§16.3).
const PLANNED_EXCLUSIONS = new Set(['UNBREAKABLE'])

class QuarryInterrupt extends Error { constructor (code, message) { super(message ?? code); this.code = code } }

function defaults (config = {}) {
  const c = structuredClone(config)
  return {
    schemaVersion: 2,
    jobId: c.jobId ?? `quarry_${Date.now().toString(36)}`,
    dimension: c.dimension ?? 'overworld',
    target: c.target,
    yTop: c.yTop ?? 'auto',
    yBottom: c.yBottom ?? 'world_min',
    worldMinY: c.worldMinY ?? -64,
    worldMaxY: c.worldMaxY ?? 319,
    allowExceptions: c.allowExceptions === true,
    permissions: { infrastructureRegion: [], protectedRegion: [], travelRegion: null, ...(c.permissions ?? {}) },
    boundarySeal: { enabled: true, horizontalMargin: 1, ...(c.boundarySeal ?? {}) },
    strategy: { maxBlocksPerBatch: 8, collectWithinSeconds: 30, maxStepDown: 1, largeFluidCells: 12, ...(c.strategy ?? {}) },
    tools: { reserveMinUses: 8, reserveFraction: 0.10, returnUses: 0, reservedTools: [], ...(c.tools ?? {}) },
    collection: { orePolicy: 'maximize_yield', buildingBlockPolicy: 'preserve_if_possible', ...(c.collection ?? {}) },
    inventory: { minFreeSlots: 6, keepSealBlocks: 32, storage: [], ...(c.inventory ?? {}) },
    safety: { retreatHealthRatio: 0.70, emergencyHealthRatio: 0.40, resumeHealthRatio: 0.90, eatFoodLevel: 16, recoverTimeoutMs: 180000, ...(c.safety ?? {}) },
    quarryCombat: { enabled: true, ...(c.quarryCombat ?? {}) },
    persistence: { checkpointAfterBatch: true, ...(c.persistence ?? {}) }
  }
}

function createQuarryJob ({ adapter, storage = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, bridge = null, pollMs = 50 } = {}) {
  const required = ['getState', 'getBlock', 'entities', 'mine', 'moveTo', 'equip', 'stopAll', 'combatActive']
  if (!adapter || required.some(k => typeof adapter[k] !== 'function')) throw new Error(`Quarry adapter needs ${required.join(', ')}`)
  const combatBridge = bridge ?? createQuarryCombatBridge({ now })
  let job = null // persistent document
  let planner = null; let regions = null; let ledger = createLedger()
  let worker = null; let epoch = 0; let abort = null
  let lastInventory = null; let pendingDrops = []; let batchCount = 0
  const events = []

  const note = (type, details = {}) => { const e = { at: new Date(now()).toISOString(), type, ...copy(details) }; events.push(e); if (events.length > 200) events.shift(); try { log(`[quarry] ${type} ${JSON.stringify(details).slice(0, 300)}`) } catch {} }
  const feetCell = s => ({ x: Math.floor(s.position.x), y: Math.floor(s.position.y - FEET + 1e-3), z: Math.floor(s.position.z) })
  const healthRatio = s => s.health / (Number.isFinite(s.maxHealth) && s.maxHealth > 0 ? s.maxHealth : 20)
  const foodOf = s => s.food ?? s.hunger ?? null
  const items = s => s?.inventory?.known === true && !s.inventory.uncertain && Array.isArray(s.inventory.items) ? s.inventory.items : null
  const scopeOf = s => JSON.stringify([s?.profile ?? null, s?.realm?.id ?? s?.realmId ?? null, s?.dimension ?? null, s?.connectionId ?? null, s?.startedAt ?? null])
  const lifeOf = s => s?.lifecycle?.deathId ?? s?.deathId ?? 0

  function setState (state, extra = {}) {
    if (!job) return
    if (job.state !== state) note('state', { from: job.state, to: state, ...extra })
    job.state = state
    Object.assign(job, extra)
  }
  async function save (why) {
    if (!job || !storage) return true
    job.records = planner?.exportRecords() ?? job.records
    job.ledger = ledger.export()
    job.savedAt = new Date(now()).toISOString()
    try { await storage.save(job.config.jobId, copy({ ...job, events: events.slice(-50) })); return true } catch (error) {
      note('persistence_failed', { why, error: String(error.message ?? error) })
      throw new QuarryInterrupt('PERSISTENCE_FAILED', 'Checkpoint could not be saved; new breaking stops (§15.2)')
    }
  }

  // ---- planning (no world changes, §4.1 plan) ---------------------------
  function buildTravel (config, regs, state) {
    if (Array.isArray(config.permissions.travelRegion)) return config.permissions.travelRegion
    // Default: the job's columns grown by 2, plus the storage and the bot's
    // current place, from the job bottom to a few blocks above its top.
    const xs = []; const zs = []; const ys = []
    for (const chunk of regs.chunks) { const b = chunkBounds(chunk); xs.push(b.xMin - 2, b.xMax + 2); zs.push(b.zMin - 2, b.zMax + 2) }
    for (const s of config.inventory.storage ?? []) if (s?.position) { xs.push(s.position.x - 3, s.position.x + 3); zs.push(s.position.z - 3, s.position.z + 3); ys.push(s.position.y + 4, s.position.y - 2) }
    if (state?.position) { const f = feetCell(state); xs.push(f.x - 2, f.x + 2); zs.push(f.z - 2, f.z + 2); ys.push(f.y + 4, f.y - 2) }
    const top = Math.min(regs.worldMaxY, Math.max(...ys, (regs.yTop ?? regs.worldMaxY - 4) + 4))
    return [{ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: regs.yBottom, yMax: top, zMin: Math.min(...zs), zMax: Math.max(...zs) }]
  }
  function makeRegions (config, yTop, state) {
    const base = { target: config.target, yTop, yBottom: config.yBottom, worldMinY: config.worldMinY, worldMaxY: config.worldMaxY, boundarySeal: config.boundarySeal, infrastructureRegion: config.permissions.infrastructureRegion, protectedRegion: config.permissions.protectedRegion }
    const first = buildRegions({ ...base, travelRegion: [] })
    return buildRegions({ ...base, travelRegion: buildTravel(config, { ...first, yTop }, state) })
  }

  function plan (input) {
    if (job && ACTIVE.has(job.state)) throw new Error('A quarry job is running; pause or cancel it first')
    const config = defaults(input)
    const state = adapter.getState()
    const issues = []; const warnings = []
    if (state?.phase !== 'spawned' || state.dead) issues.push('NOT_SPAWNED')
    if (state?.gameMode !== 'survival' && state?.gameMode !== 0) issues.push('NOT_SURVIVAL')
    if (state?.dimension && state.dimension !== config.dimension.replace(/^minecraft:/, '')) issues.push('WRONG_DIMENSION')
    let regs = makeRegions(config, Number.isSafeInteger(config.yTop) ? config.yTop : null, state)
    const p = createQuarryPlanner({ regions: regs, getBlock: adapter.getBlock, config: config.strategy })
    let yTop = Number.isSafeInteger(config.yTop) ? config.yTop : null
    let unknownAbove = 0
    if (yTop === null) { const s = p.surveyTop(); yTop = s.yTop; unknownAbove = s.unknownAbove }
    if (yTop === null) issues.push('Y_TOP_UNKNOWN')
    if (unknownAbove) warnings.push({ code: 'Y_TOP_PROVISIONAL', unknownCells: unknownAbove })
    if (yTop !== null) regs = makeRegions(config, yTop, state)
    const inv = items(state)
    if (!inv) issues.push('INVENTORY_UNKNOWN')
    const storageList = config.inventory.storage ?? []
    if (!storageList.length && config.inventory.carryOnly !== true) issues.push('NO_STORAGE_REGISTERED')
    for (const s of storageList) {
      const b = s?.position ? adapter.getBlock(s.position.x, s.position.y, s.position.z) : null
      if (!b?.known || !/chest|barrel/.test(nameOf(b))) issues.push(`STORAGE_NOT_OBSERVED:${JSON.stringify(s?.position ?? null)}`)
      else if (permits(regs, 'break', s.position).allowed) issues.push('STORAGE_INSIDE_EXCAVATION')
    }
    if (inv) {
      const picks = inv.filter(i => /_pickaxe$/.test(nameOf(i)))
      if (!picks.length) warnings.push({ code: 'NO_PICKAXE', note: 'Stone and ores will wait for a tool' })
      if (!inv.some(i => isFood(i.name))) warnings.push({ code: 'NO_FOOD' })
      if (!inv.some(i => /cobblestone|cobbled_deepslate|^dirt$|^stone$/.test(nameOf(i)))) warnings.push({ code: 'NO_SEAL_MATERIAL', note: 'Water/lava and stair repairs will pause' })
    }
    const pl = createQuarryPlanner({ regions: regs, getBlock: adapter.getBlock, config: config.strategy })
    let stair = null; let counts = null; let survey = null
    if (yTop !== null) {
      const entry = storageList[0]?.position ?? (state?.position ? feetCell(state) : null)
      stair = pl.planStair({ entry, yTop })
      if (!stair) issues.push('STAIR_START_UNKNOWN')
      counts = pl.counts(yTop)
      survey = { fluidCells: 0, protected: [], containers: [] }
      for (let y = yTop; y >= regs.yBottom && survey.protected.length < 64; y--) {
        const s = pl.layerSummary(y, {})
        survey.fluidCells += s.fluid.length
        for (const b of s.blocked) if (survey.protected.length < 64) survey.protected.push({ position: b.position, name: b.name, reason: b.reason })
      }
      if (survey.fluidCells > config.strategy.largeFluidCells) warnings.push({ code: 'LARGE_FLUID_IN_TARGET', cells: survey.fluidCells })
    }
    const sealCells = regs.seal.ready ? regs.seal.columns.size * (regs.seal.yMax - regs.seal.yMin + 1) : 0
    const summary = { ready: issues.length === 0, issues, warnings, jobId: config.jobId, chunks: regs.chunks, yTop, yTopProvisional: unknownAbove > 0, yBottom: regs.yBottom, columns: regs.columns.size, counts, survey, stair, boundarySeal: { enabled: regs.seal.enabled, ready: regs.seal.ready, columns: regs.seal.columns.size, yMin: regs.seal.yMin, yMax: regs.seal.yMax, cells: sealCells, placementOnly: true }, travelRegion: regs.travel, storage: storageList }
    job = { config, state: 'IDLE', planned: summary, yTop, cursorY: yTop, records: { stair }, ledger: {}, userRunIntent: 'idle', result: null, pauseReason: null, interruption: null, checkpoint: null, actions: [], deaths: [], startedAt: null, scope: null, life: null }
    regions = regs; planner = pl; ledger = createLedger()
    return copy(summary)
  }

  // ---- adapter helpers ---------------------------------------------------
  function guard (myEpoch) {
    if (myEpoch !== epoch) throw new QuarryInterrupt('EPOCH_CHANGED')
    if (job.userRunIntent !== 'running') throw new QuarryInterrupt('STOP_REQUESTED')
    if (abort?.signal.aborted) throw new QuarryInterrupt(abort.signal.reason?.code ?? 'ABORTED')
    const s = adapter.getState()
    if (s?.dead || s?.phase !== 'spawned') throw new QuarryInterrupt(s?.dead ? 'DEAD' : 'DISCONNECTED')
    if (job.scope && scopeOf(s) !== job.scope) throw new QuarryInterrupt(lifeOf(s) !== job.life ? 'DEAD' : 'DISCONNECTED')
    if (job.life != null && lifeOf(s) !== job.life) throw new QuarryInterrupt('DEAD')
    if (job.config.quarryCombat.enabled && adapter.combatActive()) throw new QuarryInterrupt('COMBAT')
    return s
  }
  // Runs one adapter call while watching for combat/stop every pollMs.
  async function call (myEpoch, label, fn) {
    guard(myEpoch)
    const local = new AbortController()
    let watcher
    const watch = new Promise((resolve, reject) => {
      watcher = setInterval(() => { try { guard(myEpoch) } catch (error) { local.abort(error); reject(error) } }, pollMs)
    })
    try { return await Promise.race([Promise.resolve().then(() => fn(local.signal)), watch]) } finally { clearInterval(watcher) }
  }
  function recordAction (action) {
    const rec = { id: `${job.config.jobId}:${epoch}:${job.actions.length + 1}`, epoch, at: new Date(now()).toISOString(), status: 'intent', ...copy(action) }
    job.actions.push(rec); if (job.actions.length > 100) job.actions.shift()
    return rec
  }

  // Inventory ledger: positive deltas are attributed by the current phase.
  function observeInventory (phase) {
    const s = adapter.getState(); const inv = items(s)
    if (!inv) return
    const t = totals(inv)
    if (lastInventory) for (const d of diff(lastInventory, t)) {
      if (d.delta > 0) ledger.add(['COMBAT', 'COMBAT_SETTLE', 'RECOVER_AFTER_COMBAT', 'SUSPEND_FOR_COMBAT'].includes(phase) ? 'loot' : 'picked', d.name, d.delta)
    }
    lastInventory = t
  }

  // ---- main loop (§18) ---------------------------------------------------
  async function loop () {
    while (job && ACTIVE.has(job.state) && job.userRunIntent === 'running') {
      const myEpoch = epoch
      try {
        await step(myEpoch)
      } catch (error) {
        if (!(error instanceof QuarryInterrupt)) { note('error', { message: String(error.message ?? error), stack: String(error.stack ?? '').split('\n').slice(0, 3).join(' | ') }); job.errors = (job.errors ?? 0) + 1 }
        await handleInterrupt(error)
      }
      await sleep(0)
    }
  }

  async function handleInterrupt (error) {
    const code = error.code ?? 'ERROR'
    try { await adapter.stopAll(`quarry:${code}`) } catch {}
    if (code === 'STOP_REQUESTED' || code === 'EPOCH_CHANGED') return
    if (code === 'COMBAT') return suspendForCombat()
    if (code === 'DEAD') { const s = adapter.getState(); job.deaths.push({ at: new Date(now()).toISOString(), position: copy(s?.position ?? job.checkpoint?.position ?? null), cause: s?.deathCause ?? null, unrecovered: copy(pendingDrops) }); return finish('PAUSED', 'DEATH') }
    if (code === 'DISCONNECTED') { setState('DISCONNECTED'); return }
    if (['PERSISTENCE_FAILED', 'STORAGE_UNREACHABLE', 'NO_STORAGE'].includes(code)) return finish('PAUSED', code)
    if (['HAZARD', 'LOW_HEALTH'].includes(code)) return
    // Unknown errors: retry bounded, then pause with the reason (§15.1 max 3).
    job.retry = (job.retry ?? 0) + 1
    if (job.retry > 3) return finish('PAUSED', `ACTION_FAILED:${String(error.message ?? code).slice(0, 160)}`)
    setState('SURVEY')
    await sleep(500)
  }

  function suspendForCombat () {
    if (job.state === 'COMBAT' || job.state === 'COMBAT_SETTLE') { setState('COMBAT'); return }
    const s = adapter.getState()
    const resumeTo = ['RETURN', 'DEPOSIT', 'RESTOCK', 'FINAL_CHECK'].includes(job.state) ? job.state : 'SURVEY'
    epoch++
    job.interruption = job.interruption ?? { at: new Date(now()).toISOString(), phase: job.state, resumeTo, epoch, layer: job.cursorY, pendingDrops: copy(pendingDrops), lastAction: copy(job.actions.at(-1) ?? null) }
    combatBridge.interrupt(s, { reason: 'combat_claim', phase: job.state })
    setState('SUSPEND_FOR_COMBAT')
    void save('combat_interruption').catch(() => {})
    setState('COMBAT')
  }

  async function step (myEpoch) {
    const s = adapter.getState()
    switch (job.state) {
      case 'DISCONNECTED': {
        if (s?.phase === 'spawned' && !s.dead) { job.scope = scopeOf(s); job.life = lifeOf(s); setState('RECONCILE') } else await sleep(500)
        return
      }
      case 'COMBAT': {
        observeInventory('COMBAT')
        combatBridge.observeMovement(s)
        if (s?.dead) throw new QuarryInterrupt('DEAD')
        if (!adapter.combatActive()) setState('COMBAT_SETTLE')
        else await sleep(100)
        return
      }
      case 'COMBAT_SETTLE': {
        if (adapter.combatActive()) { setState('COMBAT'); return }
        const r = combatBridge.settle(s, adapter.entities(), { evidenceFor: e => adapter.threatEvidence?.(e) ?? {}, recentDamageAt: adapter.recentDamageAt?.() ?? null, hazard: hazardNow(s) !== null })
        job.settle = r
        if (r.settled) setState('RECOVER_AFTER_COMBAT')
        else await sleep(100)
        return
      }
      case 'RECOVER_AFTER_COMBAT': return recoverAfterCombat(myEpoch, s)
      case 'RECONCILE': return reconcile(myEpoch)
      case 'PREFLIGHT': return preflight(myEpoch)
      case 'RECOVER': return recoverHealth(myEpoch)
      case 'RETURN': case 'DEPOSIT': return returnAndDeposit(myEpoch, job.depositReason ?? 'capacity')
      case 'FINAL_CHECK': return finalCheck(myEpoch)
      default: return work(myEpoch)
    }
  }

  function hazardNow (s) {
    if (!s?.position) return 'NO_POSITION'
    const f = feetCell(s)
    for (const p of [f, { ...f, y: f.y + 1 }]) {
      const b = adapter.getBlock(p.x, p.y, p.z)
      if (b?.known && /lava|fire/.test(nameOf(b))) return 'IN_LAVA_OR_FIRE'
      if (b?.known && p.y === f.y + 1 && /water/.test(nameOf(b))) return 'HEAD_IN_WATER'
    }
    if (s.onFire === true) return 'ON_FIRE'
    if (Number.isFinite(s.air) && s.air < 150) return 'LOW_AIR'
    return null
  }

  async function preflight (myEpoch) {
    const s = guard(myEpoch)
    if (!items(s)) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    job.scope = scopeOf(s); job.life = lifeOf(s)
    lastInventory = totals(items(s))
    if (!Object.keys(ledger.export().startInventory).length) for (const [n, c] of lastInventory) ledger.add('startInventory', n, c)
    combatBridge.activate({ jobId: job.config.jobId, epoch, travel: p => permits(regions, 'travel', p).allowed })
    await save('start')
    setState('SURVEY')
  }

  async function reconcile (myEpoch) {
    const s = guard(myEpoch)
    // Re-observe instead of trusting saved cells (§15.3): unreachable and
    // tool deferrals are retried; protected/unbreakable stay.
    planner.clearDeferred(['UNREACHABLE', 'WAITING_FOR_TOOL', 'TOOL_DURABILITY_RESERVE', 'TOOL_DURABILITY_UNKNOWN', 'TOOL_NOT_IN_HOTBAR'])
    if (!items(s)) { await sleep(500); return }
    lastInventory = totals(items(s))
    job.cursorY = job.yTop
    job.retry = 0
    combatBridge.activate({ jobId: job.config.jobId, epoch, travel: p => permits(regions, 'travel', p).allowed })
    setState('SURVEY')
  }

  async function recoverAfterCombat (myEpoch, s) {
    if (adapter.combatActive()) { setState('COMBAT'); return }
    observeInventory('RECOVER_AFTER_COMBAT')
    if (!items(s)) { await sleep(200); return }
    const gate = combatBridge.resumeGate(s, { harmfulEffect: adapter.harmfulEffect?.() === true })
    job.recovery = gate
    if (!gate.ready) {
      if (gate.missing.includes('FOOD') || gate.missing.includes('HEALTH')) {
        if (await tryEat(myEpoch, true)) return
      }
      job.recoverWaitSince ??= now()
      if (now() - job.recoverWaitSince > job.config.safety.recoverTimeoutMs) { job.recoverWaitSince = null; return finish('PAUSED', `RECOVERY_NOT_PROGRESSING:${gate.missing.join(',')}`) }
      await sleep(500)
      return
    }
    job.recoverWaitSince = null
    if (job.userRunIntent !== 'running') return
    // Replan from the current state, never replay old inputs (§9.7).
    const back = job.interruption?.resumeTo ?? 'SURVEY'
    planner.clearDeferred(['UNREACHABLE'])
    combatBridge.resumed()
    job.interruption = null
    epoch++
    note('combat_resume', { to: back })
    setState(back === 'FINAL_CHECK' ? 'FINAL_CHECK' : back === 'RETURN' || back === 'DEPOSIT' ? 'RETURN' : 'SURVEY')
  }

  async function tryEat (myEpoch, recovering = false) {
    const s = adapter.getState(); const inv = items(s)
    if (!inv || typeof adapter.eat !== 'function') return false
    const food = foodOf(s)
    if (!(Number.isFinite(food) && (food <= job.config.safety.eatFoodLevel || recovering && food < 20))) return false
    if (!inv.some(i => isFood(i.name))) return false
    try { await call(myEpoch, 'eat', signal => adapter.eat({ signal })); note('ate', { food }); return true } catch (error) { if (error instanceof QuarryInterrupt) throw error; note('eat_failed', { error: error.message }); return false }
  }

  async function recoverHealth (myEpoch) {
    const s = guard(myEpoch)
    const r = healthRatio(s)
    if (r <= job.config.safety.emergencyHealthRatio && !job.emergencyReturned && job.config.inventory.storage?.length) {
      job.emergencyReturned = true
      note('emergency_return', { health: s.health })
      await goToStorage(myEpoch)
      return
    }
    if (r >= job.config.safety.resumeHealthRatio && (foodOf(s) ?? 20) >= 18) { job.recoverWaitSince = null; job.emergencyReturned = false; setState('SURVEY'); return }
    if (await tryEat(myEpoch, true)) return
    job.recoverWaitSince ??= now()
    if (now() - job.recoverWaitSince > job.config.safety.recoverTimeoutMs) { job.recoverWaitSince = null; return finish('PAUSED', 'HEALTH_NOT_RECOVERING') }
    await sleep(500)
  }

  // ---- normal work -------------------------------------------------------
  async function work (myEpoch) {
    const s = guard(myEpoch)
    const hz = hazardNow(s)
    if (hz) return escapeHazard(myEpoch, hz)
    if (healthRatio(s) <= job.config.safety.retreatHealthRatio) { note('low_health', { health: s.health }); setState('RECOVER'); return }
    await tryEat(myEpoch)
    const inv = items(s)
    if (!inv) { await sleep(300); return }
    observeInventory(job.state)
    // Capacity: collect then return before the bag is full (§10.3, §11.1).
    if (freeSlots(inv) < job.config.inventory.minFreeSlots) { await collect(myEpoch, 'capacity'); job.depositReason = 'capacity'; setState('RETURN'); return }
    // Oldest drop deadline / batch size (§10.1).
    const open = pendingDrops.filter(d => !d.unreachable)
    const oldest = open.length ? Math.min(...open.map(d => d.firstSeen)) : null
    if (batchCount >= job.config.strategy.maxBlocksPerBatch || oldest !== null && now() - oldest >= job.config.strategy.collectWithinSeconds * 1000) { await collect(myEpoch, batchCount >= job.config.strategy.maxBlocksPerBatch ? 'batch' : 'deadline'); return }
    setState('PLAN')
    const decision = planner.next({ feet: feetCell(s), yTop: job.cursorY ?? job.yTop, tools: inv, policy: { ...job.config.tools, ...job.config.collection }, inventoryItems: inv, maxBatch: job.config.strategy.maxBlocksPerBatch - batchCount })
    job.lastDecision = { action: decision.action, reason: decision.reason ?? null, details: decision.details ?? null, y: decision.targets?.[0]?.position?.y ?? decision.y ?? null }
    if (decision.action === 'finished') { await collect(myEpoch, 'final'); setState('FINAL_CHECK'); return }
    if (decision.action === 'deferred') { note('deferred', { reason: decision.reason, count: decision.count, y: decision.y }); return }
    if (decision.action === 'pause') { await collect(myEpoch, 'before_pause'); return finish('PAUSED', decision.reason, { pauseDetails: decision.details ?? null }) }
    if (decision.action === 'seal' || decision.action === 'stair_place') return place(myEpoch, decision)
    if (decision.action === 'mine') return mine(myEpoch, decision)
    throw new Error(`Unknown planner action ${decision.action}`)
  }

  async function moveToStance (myEpoch, stance) {
    const s = guard(myEpoch); const f = feetCell(s)
    if (f.x === stance.x && f.y === stance.y && f.z === stance.z) return
    setState('MOVE', { moveTarget: stance })
    const p = recordAction({ type: 'move', target: stance })
    // The whole route is checked against travel permission and step limits;
    // the adapter walks it in short verified segments (§5.2, §6.1).
    const path = planner.pathTo(f, stance)
    if (!path) throw new Error(`No permitted walking route to ${JSON.stringify(stance)}`)
    await call(myEpoch, 'move', signal => adapter.moveTo(stance, { signal, path, maxStepDown: job.config.strategy.maxStepDown, travel: c => permits(regions, 'travel', c).allowed }))
    const after = feetCell(guard(myEpoch))
    p.status = after.x === stance.x && after.y === stance.y && after.z === stance.z ? 'confirmed' : 'mismatch'
    if (p.status !== 'confirmed') throw new Error(`Arrived at ${JSON.stringify(after)} instead of ${JSON.stringify(stance)}`)
  }

  async function equipTool (myEpoch, tool) {
    const s = guard(myEpoch)
    if (tool.kind === 'hand') {
      const held = s.heldItem
      if (!held?.name || !/_(pickaxe|shovel|axe|hoe|sword)$|^minecraft:shears$/.test(held.name)) return
      const inv = items(s)
      const isTool = i => /_(pickaxe|shovel|axe|hoe|sword)$|shears$/.test(i?.name ?? '')
      const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(slot => !inv.some(i => i.slot === slot && isTool(i)))
      if (free == null) return
      await call(myEpoch, 'equip_hand', signal => adapter.equip(free, { signal, hand: true }))
      return
    }
    if (s.heldItem?.name === tool.name && (s.selectedSlot === tool.slot || s.heldItem?.slot === tool.slot)) return
    await call(myEpoch, 'equip', signal => adapter.equip(tool.slot, { signal }))
    const after = guard(myEpoch)
    if (after.heldItem?.name !== tool.name) throw new Error(`Equip of ${tool.name} is unconfirmed`)
  }

  async function mine (myEpoch, decision) {
    // Capacity check against worst-case drops of the whole batch (T06).
    const inv = items(guard(myEpoch))
    const drops = decision.targets.flatMap(t => (blockRule(t.name).drops ?? []).slice(0, 2).map(name => ({ name, count: blockRule(t.name).maxDrop ?? 1 })))
    if (!canAccept(inv, drops)) { note('capacity_before_mine', { drops: drops.length }); await collect(myEpoch, 'capacity'); job.depositReason = 'capacity'; setState('RETURN'); return }
    await moveToStance(myEpoch, decision.stance)
    await equipTool(myEpoch, decision.tool)
    // Re-plan from the actual stance; the world may have changed while moving.
    setState('MINE')
    const targets = decision.targets.map(t => ({ x: t.position.x, y: t.position.y, z: t.position.z, expectedName: t.name, expectedRuntimeId: t.runtimeId ?? null, requiredTool: blockRule(t.name).needs ? { kind: blockRule(t.name).needs, tier: blockRule(t.name).tier } : null }))
    const rec = recordAction({ type: 'mine', stance: decision.stance, targets: targets.map(t => ({ x: t.x, y: t.y, z: t.z, name: t.expectedName })), tool: decision.tool?.name ?? 'hand' })
    if (job.config.persistence.checkpointAfterBatch) await save('mine_intent')
    let failure = null
    try { await call(myEpoch, 'mine', signal => adapter.mine(targets, { signal })) } catch (error) { if (error instanceof QuarryInterrupt) { rec.status = 'interrupted'; confirmMined(rec, targets); throw error } failure = error }
    const confirmed = confirmMined(rec, targets)
    if (failure && !confirmed) { rec.status = 'failed'; rec.error = String(failure.message ?? failure); job.retry = (job.retry ?? 0) + 1; if (job.retry > 3) { for (const t of targets) planner.defer(t, 'MINING_FAILED', { error: rec.error }); job.retry = 0 } ; note('mine_failed', { error: rec.error }); return }
    job.retry = 0
    rec.status = failure ? 'partial' : 'confirmed'
    batchCount += confirmed
    // Track fresh drops near the targets for the 30s collection rule.
    await sleep(150)
    trackDrops(targets)
    if (decision.targets.some(t => blockRule(t.name).ore)) await collect(myEpoch, 'valuable')
    if (job.config.persistence.checkpointAfterBatch) { job.checkpoint = { at: new Date(now()).toISOString(), layer: job.cursorY, position: copy(adapter.getState().position), batchCount }; await save('batch') }
  }

  // Each target is re-read: air counts as removed; a different block (sand
  // fell in, water flowed) stays for re-planning (§15.1, T09).
  function confirmMined (rec, targets) {
    let n = 0
    rec.results = []
    for (const t of targets) {
      const b = adapter.getBlock(t.x, t.y, t.z)
      const k = `${t.x},${t.y},${t.z}`
      if (b?.known && AIR.has(nameOf(b)) && !(b.extra ?? []).length) {
        n++
        const temp = planner.temporaryList().find(e => e.position === k)
        if (temp) ledger.add('reminedTemporary', t.expectedName)
        else ledger.add('minedBlocks', t.expectedName)
        rec.results.push({ position: k, result: 'removed' })
      } else rec.results.push({ position: k, result: b?.known ? `present:${nameOf(b)}` : 'unknown' })
    }
    return n
  }

  function trackDrops (targets) {
    const ents = adapter.entities().filter(e => e.kind === 'item' && e.position)
    for (const e of ents) {
      if (pendingDrops.some(d => d.runtimeId === e.runtimeId)) continue
      if (targets.some(t => Math.hypot(e.position.x - (t.x + 0.5), e.position.y - t.y, e.position.z - (t.z + 0.5)) <= 3)) pendingDrops.push({ runtimeId: e.runtimeId, name: e.name, count: e.count, position: copy(e.position), firstSeen: now() })
    }
  }

  // Collect drops (§10.2): walk next to each, then confirm by inventory gain.
  async function collect (myEpoch, why) {
    setState('COLLECT', { collectReason: why })
    const s = guard(myEpoch)
    const ents = new Map(adapter.entities().filter(e => e.kind === 'item' && e.position).map(e => [e.runtimeId, e]))
    // Refresh tracked drops; vanished ones are unknown unless the bag grew.
    const before = totals(items(s) ?? [])
    const remaining = []
    for (const d of pendingDrops) { const e = ents.get(d.runtimeId); if (e) remaining.push({ ...d, position: copy(e.position), count: e.count }) }
    // Nearby items inside travel permission are collected too (mixed items are
    // counted as "picked" only when they enter the bag).
    for (const e of ents.values()) if (!remaining.some(d => d.runtimeId === e.runtimeId) && permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed && s.position && Math.hypot(e.position.x - s.position.x, e.position.z - s.position.z) <= 12) remaining.push({ runtimeId: e.runtimeId, name: e.name, count: e.count, position: copy(e.position), firstSeen: now(), mixed: true })
    remaining.sort((a, b) => a.firstSeen - b.firstSeen || Math.hypot(a.position.x - s.position.x, a.position.z - s.position.z) - Math.hypot(b.position.x - s.position.x, b.position.z - s.position.z))
    const unreachable = []
    for (const d of remaining.slice(0, 24)) {
      const inv = items(guard(myEpoch))
      if (!canAccept(inv, [{ name: d.name ?? 'unknown', count: d.count ?? 1 }])) { unreachable.push({ ...d, reason: 'NO_CAPACITY' }); continue }
      const cell = { x: Math.floor(d.position.x), y: Math.floor(d.position.y + 0.01), z: Math.floor(d.position.z) }
      const target = [cell, { ...cell, y: cell.y + 1 }, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y, z: cell.z + dz }))].find(c => planner.standable(c) && permits(regions, 'travel', c).allowed && planner.reachableFrom(feetCell(guard(myEpoch))).has(`${c.x},${c.y},${c.z}`))
      if (!target) { unreachable.push({ ...d, reason: 'UNREACHABLE' }); continue }
      try { await moveToStance(myEpoch, target) } catch (error) { if (error instanceof QuarryInterrupt) throw error; unreachable.push({ ...d, reason: 'MOVE_FAILED' }); continue }
      const until = now() + 1500
      while (now() < until && adapter.entities().some(e => e.runtimeId === d.runtimeId)) await sleep(100)
    }
    const after = totals(items(guard(myEpoch)) ?? [])
    for (const x of diff(before, after)) if (x.delta > 0) note('collected', x)
    observeInventory('COLLECT')
    // Items still on the ground stay tracked: capacity misses are retried after
    // a deposit, unreachable ones are only written off at the end (§10.2).
    const still = new Set(adapter.entities().filter(e => e.kind === 'item').map(e => e.runtimeId))
    pendingDrops = unreachable.filter(d => still.has(d.runtimeId)).map(d => ({ ...d, unreachable: d.reason !== 'NO_CAPACITY' }))
    job.unreachableItems = pendingDrops.filter(d => d.unreachable).map(d => ({ name: d.name, count: d.count, position: d.position, reason: d.reason }))
    batchCount = 0
    setState('PLAN')
  }

  async function place (myEpoch, decision) {
    await moveToStance(myEpoch, decision.stance)
    setState(decision.action === 'seal' ? 'HAZARD' : 'MINE', { placing: decision.purpose })
    const rec = recordAction({ type: 'place', purpose: decision.purpose, position: decision.position, material: decision.material })
    if (typeof adapter.place !== 'function') return finish('PAUSED', 'PLACEMENT_UNAVAILABLE')
    await save('place_intent')
    try {
      await call(myEpoch, 'place', signal => adapter.place({ position: decision.position, slot: decision.slot, clicked: decision.clicked, face: decision.face, point: decision.point, expectedBlock: `minecraft:${nameOf(decision.material)}` }, { signal }))
    } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      job.placeFailures = (job.placeFailures ?? 0) + 1
      if (job.placeFailures >= 3) { job.placeFailures = 0; return finish('PAUSED', 'SEAL_PLACEMENT_FAILED', { pauseDetails: { position: decision.position, error: rec.error } }) }
      return
    }
    const b = adapter.getBlock(decision.position.x, decision.position.y, decision.position.z)
    if (!(b?.known && nameOf(b) === nameOf(decision.material))) { rec.status = 'unconfirmed'; return }
    rec.status = 'confirmed'; job.placeFailures = 0
    planner.recordPlacement(decision.position, decision.purpose, decision.material)
    ledger.add(decision.purpose === 'seal' ? 'placedSeal' : 'placedTemporary', decision.material)
    // Fluids keep moving after a seal: observe several times before work
    // continues; a still-changing flow pauses instead of guessing (§12.1).
    const until = now() + 6000; let calm = 0
    let last = null
    while (now() < until && calm < 3) {
      await sleep(500)
      const snap = JSON.stringify(planner.fluidNeighbours(decision.position).map(f => f.position))
      calm = snap === last ? calm + 1 : 0; last = snap
    }
    if (calm < 3) return finish('PAUSED', 'FLUID_STILL_CHANGING', { pauseDetails: { position: decision.position } })
    await save('placed')
  }

  async function escapeHazard (myEpoch, why) {
    setState('HAZARD', { hazard: why })
    note('hazard', { why })
    try { await adapter.stopAll(`quarry_hazard:${why}`) } catch {}
    const s = guard(myEpoch); const f = feetCell(s)
    const reach = planner.reachableFrom(f)
    let best = null
    for (const [k, d] of reach) { const [x, y, z] = k.split(',').map(Number); const c = { x, y, z }; const h = adapter.getBlock(x, y + 1, z); if (h?.known && AIR.has(nameOf(h)) && (!best || d < best.d)) best = { c, d } }
    if (best && best.d > 0 && typeof adapter.escape === 'function') {
      try { await call(myEpoch, 'escape', signal => adapter.escape(best.c, { signal })) } catch (error) { if (error instanceof QuarryInterrupt) throw error }
    }
    await sleep(500)
    if (hazardNow(adapter.getState())) { job.hazardCount = (job.hazardCount ?? 0) + 1; if (job.hazardCount > 5) return finish('PAUSED', `HAZARD_UNRESOLVED:${why}`) } else job.hazardCount = 0
    setState('SURVEY')
  }

  async function goToStorage (myEpoch) {
    const st = job.config.inventory.storage?.[0]
    if (!st) throw new QuarryInterrupt('NO_STORAGE', 'No registered storage')
    setState('RETURN')
    const from = feetCell(guard(myEpoch))
    const stands = (st.stand ? [st.stand] : [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: st.position.x + dx, y: st.position.y, z: st.position.z + dz }))).filter(c => planner.standable(c))
    let path = null; let stand = null
    for (const c of stands) { const p = planner.pathTo(from, c); if (p && (!path || p.length < path.length)) { path = p; stand = c } }
    if (!path) throw new QuarryInterrupt('STORAGE_UNREACHABLE', 'No permitted walking route to the registered storage')
    await call(myEpoch, 'return', signal => adapter.goToStorage({ ...st, stand }, { signal, path, travel: c => permits(regions, 'travel', c).allowed }))
  }

  async function returnAndDeposit (myEpoch, why) {
    if (!job.config.inventory.storage?.length) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'carry-only job is full' } })
    await goToStorage(myEpoch)
    setState('DEPOSIT')
    const s = guard(myEpoch)
    const inv = items(s)
    if (!inv) { await sleep(300); return }
    const { deposits } = keepPlan(inv, job.config.inventory)
    const rec = recordAction({ type: 'deposit', why, items: deposits })
    await save('deposit_intent')
    let result
    try { result = await call(myEpoch, 'deposit', signal => adapter.deposit(job.config.inventory.storage, deposits, { signal })) } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      job.depositFailures = (job.depositFailures ?? 0) + 1
      if (job.depositFailures >= 3) return finish('PAUSED', 'DEPOSIT_FAILED', { pauseDetails: { error: rec.error } })
      return
    }
    job.depositFailures = 0
    // Only confirmed moves count (§11.2, T07, T17).
    for (const d of result?.deposited ?? []) ledger.add('deposited', d.name, d.count)
    rec.status = result?.full ? 'partial' : 'confirmed'; rec.result = copy(result)
    lastInventory = totals(items(adapter.getState()) ?? [])
    await save('deposited')
    if (result?.full) {
      const free = freeSlots(items(adapter.getState()) ?? [])
      if (free < job.config.inventory.minFreeSlots) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { freeSlots: free, needFreeSlots: job.config.inventory.minFreeSlots } })
    }
    if (why === 'final') { setState('FINAL_CHECK', { finalDeposited: true }); return }
    setState('SURVEY')
  }

  async function finalCheck (myEpoch) {
    guard(myEpoch)
    // Re-scan the whole range (§16.3): unknown never completes.
    const counts = planner.counts(job.yTop)
    job.finalCounts = counts
    if (counts.remaining > 0) { job.cursorY = job.yTop; setState('SURVEY'); return }
    if (counts.unknown > 0) return finish('PAUSED', 'UNOBSERVED_CELLS', { pauseDetails: counts })
    if (!job.finalDeposited && job.config.inventory.storage?.length) { await collect(myEpoch, 'final'); job.depositReason = 'final'; await returnAndDeposit(myEpoch, 'final'); return }
    const exceptions = exceptionsList()
    if (exceptions.length && !job.acceptedExceptions) return finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { exceptions: exceptions.slice(0, 50), count: exceptions.length } })
    return finish(exceptions.length ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', null)
  }
  function exceptionsList () {
    const list = []
    for (const d of planner.deferredList()) if (!PLANNED_EXCLUSIONS.has(d.reason)) list.push({ kind: 'deferred', ...d })
    for (const t of planner.temporaryList()) { const [x, y, z] = t.position.split(',').map(Number); const b = adapter.getBlock(x, y, z); if (b?.known && !AIR.has(nameOf(b))) list.push({ kind: 'temporary', ...t }) }
    if (job.records?.stair || planner.exportRecords().stair) {
      const st = planner.exportRecords().stair
      for (let y = Math.min(st.startY, job.yTop); y >= regions.yBottom; y--) { const step = planner.stairStepAt(y); const b = step && adapter.getBlock(step.x, step.y, step.z); if (b?.known && !AIR.has(nameOf(b))) { list.push({ kind: 'stair', steps: Math.min(st.startY, job.yTop) - regions.yBottom + 1, note: 'egress stair left as a reserved structure (§6.2)' }); break } }
    }
    return list
  }

  async function finish (result, reason, extra = {}) {
    if (!job) return
    const paused = result === 'PAUSED'
    if (!paused) {
      const still = new Set(adapter.entities().filter(e => e.kind === 'item').map(e => e.runtimeId))
      for (const d of pendingDrops) ledger.add(still.has(d.runtimeId) ? 'lost' : 'unaccounted', d.name ?? 'unknown', d.count ?? 1)
      pendingDrops = []
    }
    job.result = { type: result, reason, at: new Date(now()).toISOString(), ...copy(extra) }
    job.pauseReason = paused ? reason : null
    if (!paused) job.userRunIntent = 'finished'
    if (!paused) combatBridge.deactivate()
    setState(paused ? 'PAUSED' : 'FINISHED', { pauseDetails: extra.pauseDetails ?? null })
    try { await adapter.stopAll(`quarry:${result}`) } catch {}
    try { await save(`finish:${result}`) } catch {}
    try { adapter.onFinished?.(status()) } catch {}
  }

  // ---- operations (§4.1) -------------------------------------------------
  function start () {
    if (!job) throw new Error('Run plan first')
    if (!job.planned?.ready) throw new Error(`Plan is not ready: ${job.planned.issues.join(', ')}`)
    if (ACTIVE.has(job.state)) return status()
    if (job.state === 'FINISHED') throw new Error('This job has finished; plan a new one')
    job.userRunIntent = 'running'; job.startedAt ??= new Date(now()).toISOString(); epoch++
    abort = new AbortController()
    setState('PREFLIGHT')
    adapter.onStarted?.(status())
    worker = loop().finally(() => { worker = null })
    return status()
  }
  function resume () {
    if (!job) throw new Error('No quarry job')
    if (ACTIVE.has(job.state)) return status()
    if (!['PAUSED', 'IDLE', 'DISCONNECTED'].includes(job.state)) throw new Error(`Cannot resume from ${job.state}`)
    job.userRunIntent = 'running'; epoch++
    job.retry = 0
    abort = new AbortController()
    setState(job.scope ? 'RECONCILE' : 'PREFLIGHT', { pauseReason: null, result: null })
    adapter.onStarted?.(status())
    worker = loop().finally(() => { worker = null })
    return status()
  }
  async function pause (reason = 'MANUAL_PAUSE') {
    if (!job || !ACTIVE.has(job.state)) return status()
    job.userRunIntent = 'paused'; epoch++
    abort?.abort(new QuarryInterrupt('STOP_REQUESTED'))
    try { await adapter.stopAll('quarry_pause') } catch {}
    await worker?.catch(() => {})
    await finish('PAUSED', reason)
    return status()
  }
  async function emergencyStop () {
    if (!job) return null
    job.userRunIntent = 'stopped'; epoch++
    abort?.abort(new QuarryInterrupt('STOP_REQUESTED'))
    try { await adapter.stopAll('quarry_emergency_stop') } catch {}
    await finish('PAUSED', 'EMERGENCY_STOP')
    return status()
  }
  async function cancel () {
    if (!job) return null
    job.userRunIntent = 'cancelled'; epoch++
    abort?.abort(new QuarryInterrupt('STOP_REQUESTED'))
    try { await adapter.stopAll('quarry_cancel') } catch {}
    await worker?.catch(() => {})
    await finish('CANCELLED', 'MANUAL_CANCEL')
    return status()
  }
  function acceptExceptions () {
    if (!job || job.state !== 'PAUSED' || job.pauseReason !== 'UNRESOLVED_EXCEPTIONS') throw new Error('No exceptions are waiting for acceptance')
    job.acceptedExceptions = true
    return resume()
  }
  // Restores a saved job document without running it (§15.2, §15.3).
  function load (doc) {
    if (!doc?.config || doc.config.schemaVersion !== 2) throw new Error('Unsupported quarry job document')
    if (job && ACTIVE.has(job.state)) throw new Error('A quarry job is running')
    job = copy(doc)
    regions = makeRegions(job.config, job.yTop, adapter.getState())
    planner = createQuarryPlanner({ regions, getBlock: adapter.getBlock, config: job.config.strategy, records: job.records ?? {} })
    ledger = createLedger(job.ledger ?? {})
    if (ACTIVE.has(job.state)) { job.state = 'PAUSED'; job.pauseReason = 'PROCESS_RESTARTED'; job.userRunIntent = 'paused' }
    return status()
  }

  function status () {
    if (!job) return { state: 'IDLE', job: null }
    const s = adapter.getState()
    const inv = items(s)
    const counts = (() => { try { return job.yTop != null && planner ? planner.counts(job.yTop) : null } catch { return null } })()
    return copy({
      jobId: job.config.jobId, state: job.state, userRunIntent: job.userRunIntent, result: job.result, pauseReason: job.pauseReason, pauseDetails: job.pauseDetails ?? null,
      chunks: regions?.chunks ?? null, yTop: job.yTop, yBottom: regions?.yBottom ?? null, currentY: job.lastDecision?.y ?? job.cursorY,
      counts, deferred: planner?.deferredList().slice(0, 30) ?? [], deferredCount: planner?.deferredList().length ?? 0, temporary: planner?.temporaryList() ?? [], seals: planner?.sealList() ?? [],
      freeSlots: inv ? freeSlots(inv) : null, health: s?.health ?? null, food: foodOf(s), held: s?.heldItem?.name ?? null,
      ledger: ledger.summary(), ledgerDetail: ledger.export(), pendingDrops: pendingDrops.length, unreachableItems: job.unreachableItems ?? [],
      combat: { ...combatBridge.snapshot(), settle: job.settle ?? null, recovery: job.recovery ?? null, interruption: job.interruption },
      lastDecision: job.lastDecision ?? null, lastAction: job.actions.at(-1) ?? null, deaths: job.deaths, planned: job.planned, events: events.slice(-15)
    })
  }

  function holdsWork () { return !!job && ACTIVE.has(job.state) }
  function document () { return job ? copy({ ...job, records: planner?.exportRecords(), ledger: ledger.export() }) : null }
  return { plan, start, pause, emergencyStop, resume, cancel, acceptExceptions, status, load, document, holdsWork, bridge: combatBridge, drain: () => worker ?? Promise.resolve() }
}

module.exports = { createQuarryJob, QuarryInterrupt, defaults }
