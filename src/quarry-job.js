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
const SETTLE_MAX_WAIT_MS = 45000 // longest post-combat settle wait for threats that do not come
const AUTO_RESUME_WINDOW_MS = 600000 // the ACTION_FAILED auto-resume budget resets after this quiet time
const STORAGE_AREA_RADIUS = 24 // m around the chests checked before leaving the pit
const STORAGE_WAIT_MS = 20000 // longest wait for the chest area to clear (a long idle wait looks like a stall)
const SETTLE_EAT_CLEARANCE = 8 // m: no eating in the settle wait with a hostile this close
const PICKUP_XZ = 1.3 // half player width 0.3 + 1 block reach for item pickup
const ACTIVE = new Set(['PREFLIGHT', 'SURVEY', 'PLAN', 'MOVE', 'MINE', 'COLLECT', 'RETURN', 'DEPOSIT', 'RESTOCK', 'HAZARD', 'RECOVER', 'SUSPEND_FOR_COMBAT', 'COMBAT', 'COMBAT_SETTLE', 'RECOVER_AFTER_COMBAT', 'RECONCILE', 'FINAL_CHECK', 'DISCONNECTED'])
const RESULT = new Set(['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'PAUSED', 'CANCELLED', 'FAILED'])
// Deferrals that are planned exclusions, not exceptions (§16.3).
const PLANNED_EXCLUSIONS = new Set(['UNBREAKABLE'])
const TOOL_WAIT = new Set(['WAITING_FOR_TOOL', 'TOOL_DURABILITY_RESERVE', 'TOOL_DURABILITY_UNKNOWN', 'TOOL_NOT_IN_HOTBAR'])

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
    strategy: { maxBlocksPerBatch: 8, collectWithinSeconds: 30, collectAfterSeconds: 20, collectPendingDrops: 24, stuckItemMs: 60000, maxStepDown: 1, largeFluidCells: 12, ...(c.strategy ?? {}) },
    tools: { reserveMinUses: 8, reserveFraction: 0.10, returnUses: 0, reservedTools: [], ...(c.tools ?? {}) },
    collection: { orePolicy: 'maximize_yield', buildingBlockPolicy: 'preserve_if_possible', ...(c.collection ?? {}) },
    inventory: { minFreeSlots: 6, keepSealBlocks: 32, storage: [], ...(c.inventory ?? {}) },
    safety: { retreatHealthRatio: 0.70, emergencyHealthRatio: 0.40, resumeHealthRatio: 0.90, eatFoodLevel: 16, recoverTimeoutMs: 180000, ...(c.safety ?? {}) },
    quarryCombat: { enabled: true, ...(c.quarryCombat ?? {}) },
    persistence: { checkpointAfterBatch: true, ...(c.persistence ?? {}) }
  }
}

function createQuarryJob ({ adapter, storage = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, bridge = null, pollMs = 50, autoResumeMs = 30000 } = {}) {
  const required = ['getState', 'getBlock', 'entities', 'mine', 'moveTo', 'equip', 'stopAll', 'combatActive']
  if (!adapter || required.some(k => typeof adapter[k] !== 'function')) throw new Error(`Quarry adapter needs ${required.join(', ')}`)
  const combatBridge = bridge ?? createQuarryCombatBridge({ now })
  let job = null // persistent document
  let planner = null; let regions = null; let ledger = createLedger()
  let worker = null; let epoch = 0; let abort = null
  const badStances = new Map() // stance key -> consecutive move failures
  let countsCache = null // display-only; completion always performs its own full scan
  let countsWork = null; let countsRevision = 0
  let lastInventory = null; let pendingDrops = []; let batchCount = 0
  const stuckItems = new Map() // item runtimeId -> skip until (ms)
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
    if (job.state !== state) {
      note('state', { from: job.state, to: state, ...extra })
      if (state === 'COMBAT_SETTLE' && job.state !== 'COMBAT') job.settleWaitSince = null
      // A recovery wait timer belongs to one stay in a recovery state; a stale
      // one (e.g. from before a combat interruption or death) would pause at once.
      if (state === 'RECOVER' || state === 'RECOVER_AFTER_COMBAT') job.recoverWaitSince = null
    }
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
    const xs = []; const zs = []; const ys = []; const lows = [regs.yBottom]
    for (const chunk of regs.chunks) { const b = chunkBounds(chunk); xs.push(b.xMin - 2, b.xMax + 2); zs.push(b.zMin - 2, b.zMax + 2) }
    for (const s of config.inventory.storage ?? []) if (s?.position) { xs.push(s.position.x - 3, s.position.x + 3); zs.push(s.position.z - 3, s.position.z + 3); ys.push(s.position.y + 4, s.position.y - 2); lows.push(s.position.y - 2) }
    // The bot's own place may lie below the job bottom (lower ground beside
    // the area), so the region reaches down to it as well.
    if (state?.position) { const f = feetCell(state); xs.push(f.x - 2, f.x + 2); zs.push(f.z - 2, f.z + 2); ys.push(f.y + 4, f.y - 2); lows.push(f.y - 2) }
    const top = Math.min(regs.worldMaxY, Math.max(...ys, (regs.yTop ?? regs.worldMaxY - 4) + 4))
    return [{ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.max(regs.worldMinY, Math.min(...lows)), yMax: top, zMin: Math.min(...zs), zMax: Math.max(...zs) }]
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
      // Many protected/unknown blocks usually mean a player build inside the
      // target; they are never broken, but the user should know before start.
      if (survey.protected.length >= 16) warnings.push({ code: 'PROTECTED_BLOCKS_IN_TARGET', cells: survey.protected.length, note: 'Possibly a player structure; these blocks are left in place', names: [...new Set(survey.protected.map(p => p.name))].slice(0, 8) })
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
    // An action broken because combat/safety took control is handled as
    // that interruption and does not use up the retry budget.
    if (job.config.quarryCombat.enabled && adapter.combatActive()) return suspendForCombat()
    // An unroutable stance is already avoided; re-plan without using the retry
    // budget (bounded so a job that can reach nothing still pauses).
    if (error.code === 'NO_ROUTE' && (job.routeSkips = (job.routeSkips ?? 0) + 1) <= 60) { note('stance_unroutable', { message: String(error.message).slice(0, 160), skips: job.routeSkips }); setState('SURVEY'); return }
    // A rejected / unconfirmed tool swap means our inventory view differs from
    // the server's: resync it before the retry (throttled) instead of failing.
    if (/持ち替えを拒否|持ち替え結果を確認できません/.test(String(error.message)) && typeof adapter.resyncInventory === 'function' && now() - (job.equipResyncAt ?? 0) > 15000) {
      job.equipResyncAt = now()
      try { await adapter.resyncInventory({}); note('inventory_resynced', { for: 'equip' }) } catch (e) { note('resync_failed', { error: String(e.message ?? e).slice(0, 160) }) }
      lastInventory = totals(items(adapter.getState()) ?? [])
      setState('SURVEY'); return
    }
    // Unknown errors: retry bounded, then pause with the reason (§15.1 max 3).
    job.retry = (job.retry ?? 0) + 1
    if (job.retry > 3) return finish('PAUSED', `ACTION_FAILED:${String(error.message ?? code).slice(0, 160)}`, { pauseDetails: { lastError: String(error.message ?? code).slice(0, 300), lastMoveError: job.lastMoveError ?? null, lastDecision: job.lastDecision ?? null, avoidedStances: [...badStances.keys()].slice(0, 10) } })
    setState('SURVEY')
    // Back off so a controller that just failed (e.g. a stalled input timer)
    // can settle before the next attempt.
    await sleep(500 * 2 ** (job.retry - 1))
  }

  function suspendForCombat () {
    job.miningEquipmentPending = true
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
        const r = combatBridge.settle(s, adapter.actors?.() ?? adapter.entities(), { evidenceFor: e => adapter.threatEvidence?.(e) ?? {}, recentDamageAt: adapter.recentDamageAt?.() ?? null, hazard: hazardNow(s) !== null })
        job.settle = r
        if (r.settled) { job.settleWaitSince = null; setState('RECOVER_AFTER_COMBAT'); return }
        // Threats that never come (a slime chunk spawning below y40, mobs on the
        // rim) kept the settle open for ~50 minutes. After SETTLE_MAX_WAIT_MS
        // without a recent hit or hazard, go back to work; combat still takes
        // anything that comes close.
        job.settleWaitSince ??= now()
        if (now() - job.settleWaitSince > SETTLE_MAX_WAIT_MS && !r.reasons.includes('RECENT_ATTACKER') && !r.reasons.includes('IMMEDIATE_HAZARD') && !r.reasons.includes('PROJECTILE_NEARBY')) {
          note('settle_timeout', { reasons: r.reasons.slice(0, 4), waitedMs: now() - job.settleWaitSince })
          job.settleWaitSince = null; setState('RECOVER_AFTER_COMBAT'); return
        }
        // A threat the combat layer does not engage can hold the settle open
        // for minutes while it keeps hurting us; eat meanwhile so health can
        // regenerate instead of only waiting (throttled). Never while a hostile
        // is close enough to reach us: eating swaps the weapon out of the hand
        // and is cancelled by the next hit anyway.
        const closeHostile = s?.position && (adapter.actors?.() ?? []).some(e => e.hostile === true && e.alive !== false && e.position && Math.hypot(e.position.x - s.position.x, e.position.y - (s.position.y - FEET), e.position.z - s.position.z) <= SETTLE_EAT_CLEARANCE)
        const hitRecently = Number.isFinite(adapter.recentDamageAt?.()) && now() - adapter.recentDamageAt() < 2000
        if (s && !closeHostile && !hitRecently && (healthRatio(s) < job.config.safety.resumeHealthRatio || (foodOf(s) ?? 20) < (job.config.quarryCombat.minFoodLevel ?? 18)) && now() - (job.settleEatAt ?? 0) > 5000) {
          job.settleEatAt = now()
          if (await tryEat(myEpoch, true)) return
        }
        await sleep(100)
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
    // MINING_FAILED (and the falling-block chains it holds up) were transient
    // refusals in practice (pose not settled, face not visible from one stance):
    // retry them on every reconcile instead of leaving them unmined for good.
    // Work resumes at the deepest layer reached. Finished layers above are not
    // revisited: their remaining cells stay recorded (EARLIER_LAYER_LEFTOVER)
    // and transient deferrals are only retried from the current layer down.
    if (!items(s)) { await sleep(500); return }
    const floorY = workFloorY()
    const above = k => Number(k.split(',')[1]) > floorY
    planner.clearDeferred(['UNREACHABLE', 'WAITING_FOR_TOOL', 'TOOL_DURABILITY_RESERVE', 'TOOL_DURABILITY_UNKNOWN', 'TOOL_NOT_IN_HOTBAR', 'MINING_FAILED', 'SUPPORTS_DEFERRED_FALLING_BLOCK'], above)
    badStances.clear()
    lastInventory = totals(items(s))
    if (floorY < job.yTop) {
      const opts = { tools: items(s), policy: { ...job.config.tools, ...job.config.collection } }
      let kept = 0
      for (let y = job.yTop; y > floorY; y--) for (const c of planner.layerSummary(y, opts).pending) { planner.defer(c.position, 'EARLIER_LAYER_LEFTOVER'); kept++ }
      if (kept) note('earlier_layer_leftovers', { count: kept, above: floorY })
    }
    job.cursorY = floorY
    job.retry = 0
    combatBridge.activate({ jobId: job.config.jobId, epoch, travel: p => permits(regions, 'travel', p).allowed })
    setState('SURVEY')
  }

  // Deepest layer the job has worked (tracked from confirmed mining; for older
  // documents estimated as the lowest layer that is mostly dug out).
  function workFloorY () {
    if (Number.isSafeInteger(job.deepestY)) return Math.max(job.deepestY, job.yBottom ?? -64)
    let floor = job.yTop
    for (let y = job.yTop; y >= (job.yBottom ?? -64); y--) { const l = planner.layerSummary(y, {}); if (l.pending.length + l.deferred + l.reserved < 200) floor = y; else break }
    job.deepestY = floor
    return floor
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
    try { await call(myEpoch, 'eat', signal => adapter.eat({ signal })); note('ate', { food }); return true } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      note('eat_failed', { error: error.message })
      // Eating needs a server-confirmed inventory; after a fight (bow use) it
      // can stay unconfirmed. Ask the server for it instead of retrying blind.
      if (/サーバーで確定した持ち物|inventory/i.test(String(error.message)) && typeof adapter.resyncInventory === 'function' && now() - (job.eatResyncAt ?? 0) > 5000) {
        job.eatResyncAt = now()
        try { await call(myEpoch, 'resync', signal => adapter.resyncInventory({ signal })); note('inventory_resynced', { for: 'eat' }) } catch (e) { if (e instanceof QuarryInterrupt) throw e; note('resync_failed', { error: String(e.message ?? e).slice(0, 200) }) }
      }
      return false
    }
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
    // Oldest drop deadline / pending count (§10.1). Collection is not tied to
    // each 8-block batch: drops are gathered when the oldest reaches
    // collectAfterSeconds (inside the spec's collectWithinSeconds), when many
    // are pending, or before the job leaves the layer / returns / pauses.
    observeDrops()
    const open = openDrops()
    const oldest = open.length ? Math.min(...open.map(d => d.firstSeen)) : null
    const st = job.config.strategy
    if (oldest !== null && now() - oldest >= Math.min(st.collectAfterSeconds, st.collectWithinSeconds) * 1000) { await collect(myEpoch, 'deadline'); return }
    if (open.length >= st.collectPendingDrops) { await collect(myEpoch, 'pending'); return }
    setState('PLAN')
    rebindTravelIfOutside(s)
    const decision = await planner.next({ feet: feetCell(s), yTop: job.cursorY ?? job.yTop, tools: inv, policy: { ...job.config.tools, ...job.config.collection }, inventoryItems: inv, maxBatch: st.maxBlocksPerBatch, selectedSlot: s.selectedSlot, avoid: new Set([...badStances].filter(([, n]) => n >= 2).map(([k]) => k)) })
    job.lastDecision = { action: decision.action, reason: decision.reason ?? null, details: decision.details ?? null, y: decision.targets?.[0]?.position?.y ?? decision.y ?? null }
    // Leaving a layer: gather its drops first, while they are still close.
    const nextY = decision.action === 'mine' ? decision.targets?.[0]?.position?.y : null
    // Before closing a layer, retry its own transient deferrals once so no
    // leftovers are created that would need a return trip later.
    if (Number.isFinite(nextY) && Number.isFinite(job.lastMineY) && nextY < job.lastMineY && job.layerRetried !== job.lastMineY) {
      const ly = job.lastMineY
      job.layerRetried = ly
      const before = planner.deferredList().length
      planner.clearDeferred(['MINING_FAILED', 'SUPPORTS_DEFERRED_FALLING_BLOCK', 'UNREACHABLE'], k => Number(k.split(',')[1]) !== ly)
      if (planner.deferredList().length < before) { badStances.clear(); note('layer_retry', { y: ly, cells: before - planner.deferredList().length }); return }
    }
    if (Number.isFinite(nextY) && Number.isFinite(job.lastMineY) && nextY < job.lastMineY && open.length) { job.lastMineY = nextY; await collect(myEpoch, 'layer'); return }
    if (Number.isFinite(nextY)) job.lastMineY = nextY
    if (decision.action === 'finished') { await collect(myEpoch, 'final'); setState('FINAL_CHECK'); return }
    if (decision.action === 'deferred') { note('deferred', { reason: decision.reason, count: decision.count, y: decision.y }); return }
    if (decision.action === 'pause') { await collect(myEpoch, 'before_pause'); return finish('PAUSED', decision.reason, { pauseDetails: decision.details ?? null }) }
    if (decision.action === 'seal' || decision.action === 'stair_place') return place(myEpoch, decision)
    if (decision.action === 'mine') return mine(myEpoch, decision)
    throw new Error(`Unknown planner action ${decision.action}`)
  }

  // A fight or a safety escape can carry the bot outside the travel region
  // fixed at plan time. Planning from there would find nothing walkable and
  // defer the whole job as UNREACHABLE, so the region is rebuilt to include
  // the current position (and the job columns) and reachability is retried.
  function rebindTravelIfOutside (s) {
    const f = feetCell(s)
    if (!f || permits(regions, 'travel', f).allowed) return false
    const next = makeRegions(job.config, job.yTop, s)
    // Never loop on a rebuild that still leaves the bot outside (that would
    // clear and re-defer the same cells on every tick).
    if (!permits(next, 'travel', f).allowed) { if (!job.travelReboundFailed) { job.travelReboundFailed = true; note('travel_rebound_failed', { feet: f }) } return false }
    job.travelReboundFailed = false
    const records = planner.exportRecords()
    regions = next
    planner = createQuarryPlanner({ regions, getBlock: adapter.getBlock, config: job.config.strategy, records })
    planner.clearDeferred(['UNREACHABLE'])
    note('travel_rebound', { feet: f })
    return true
  }

  async function moveToStance (myEpoch, stance) {
    const s = guard(myEpoch); const f = feetCell(s)
    if (f.x === stance.x && f.y === stance.y && f.z === stance.z) return
    setState('MOVE', { moveTarget: stance })
    const p = recordAction({ type: 'move', target: stance })
    // The whole route is checked against travel permission and step limits;
    // the adapter walks it in short verified segments (§5.2, §6.1).
    const path = planner.pathTo(f, stance)
    // No route: avoid this stance from now on so the planner picks another one
    // (or defers the cells as UNREACHABLE) instead of retrying the same move.
    if (!path) { badStances.set(`${stance.x},${stance.y},${stance.z}`, 2); throw Object.assign(new Error(`No permitted walking route to ${JSON.stringify(stance)}`), { code: 'NO_ROUTE' }) }
    const sk = `${stance.x},${stance.y},${stance.z}`
    try { await call(myEpoch, 'move', signal => adapter.moveTo(stance, { signal, path, maxStepDown: job.config.strategy.maxStepDown, travel: c => permits(regions, 'travel', c).allowed })) } catch (error) {
      // A move broken by a fight or a safety escape is an interruption, not a
      // bad stance (the other controller stopped our movement first).
      if (!(error instanceof QuarryInterrupt) && job.config.quarryCombat.enabled && adapter.combatActive()) throw new QuarryInterrupt('COMBAT')
      // Input-timer stalls are the bot's own scheduling hiccups, not a property
      // of the destination, so they never mark a stance as bad.
      if (!(error instanceof QuarryInterrupt) && !/timer stalled|movement ticks were missed/i.test(String(error.message))) { badStances.set(sk, (badStances.get(sk) ?? 0) + 1); job.lastMoveError = { target: stance, error: String(error.message ?? error).slice(0, 200), at: new Date(now()).toISOString() } }
      throw error
    }
    badStances.delete(sk)
    const after = feetCell(guard(myEpoch))
    p.status = after.x === stance.x && after.y === stance.y && after.z === stance.z ? 'confirmed' : 'mismatch'
    if (p.status !== 'confirmed') throw new Error(`Arrived at ${JSON.stringify(after)} instead of ${JSON.stringify(stance)}`)
  }

  async function equipTool (myEpoch, tool) {
    const s = guard(myEpoch)
    if (tool.kind === 'hand') {
      const held = s.heldItem
      if (!held?.name || !/_(pickaxe|shovel|axe|hoe|sword)$|^minecraft:shears$/.test(held.name)) return
      // Equipping swaps a real item into the hand, so the source must hold a
      // non-tool item (an empty slot is refused). After a deposit the hotbar
      // may be empty: take any non-tool stack from the whole inventory. With
      // none left, keep the held tool rather than fail the job.
      const inv = items(s) ?? []
      const isTool = i => /_(pickaxe|shovel|axe|hoe|sword)$|shears$/.test(i?.name ?? '')
      const usable = inv.filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot <= 35 && i.count > 0 && i.name && !isTool(i) && i.slot !== s.selectedSlot)
      const source = usable.find(i => i.slot <= 8) ?? usable.sort((a, b) => a.slot - b.slot)[0]
      if (!source) { note('hand_unavailable', { held: held.name }); return }
      await call(myEpoch, 'equip_hand', signal => adapter.equip(source.slot, { signal, hand: true }))
      return
    }
    if (s.heldItem?.name === tool.name && (s.selectedSlot === tool.slot || s.heldItem?.slot === tool.slot)) return
    await call(myEpoch, 'equip', signal => adapter.equip(tool.slot, { signal }))
    const after = guard(myEpoch)
    if (after.heldItem?.name !== tool.name) throw new Error(`Equip of ${tool.name} is unconfirmed`)
  }

  async function mine (myEpoch, decision) {
    // Capacity check against worst-case drops of the whole batch (T06).
    const initial = guard(myEpoch)
    const receiptScope = { job, epoch: myEpoch, scope: scopeOf(initial), life: lifeOf(initial) }
    const inv = items(initial)
    const drops = decision.targets.flatMap(t => (blockRule(t.name).drops ?? []).slice(0, 2).map(name => ({ name, count: blockRule(t.name).maxDrop ?? 1 })))
    if (!canAccept(inv, drops)) { note('capacity_before_mine', { drops: drops.length }); await collect(myEpoch, 'capacity'); job.depositReason = 'capacity'; setState('RETURN'); return }
    await moveToStance(myEpoch, decision.stance)
    let tool = decision.tool; let prepared = false
    if (job.miningEquipmentPending && typeof adapter.prepareMining === 'function') {
      const result = await call(myEpoch, 'prepare_mining', signal => adapter.prepareMining(tool, { signal }))
      guard(myEpoch)
      if (result === false) throw new Error('Mining equipment preparation was not confirmed')
      // Preparing a tool in the main bag can swap it into another slot. The
      // old source slot now holds a different item and must never be re-used.
      if (result?.slot != null && tool.kind !== 'hand') {
        if (!Number.isInteger(result.slot) || result.slot < 0 || result.slot > 8) throw new Error('Mining equipment preparation returned an invalid selected slot')
        tool = { ...tool, slot: result.slot }
      }
      prepared = true
    }
    await equipTool(myEpoch, tool)
    guard(myEpoch)
    if (prepared) job.miningEquipmentPending = false
    // Re-plan from the actual stance; the world may have changed while moving.
    setState('MINE')
    const targets = decision.targets.map(t => ({ x: t.position.x, y: t.position.y, z: t.position.z, expectedName: t.name, expectedRuntimeId: t.runtimeId ?? null, requiredTool: blockRule(t.name).needs ? { kind: blockRule(t.name).needs, tier: blockRule(t.name).tier } : null }))
    const rec = recordAction({ type: 'mine', stance: decision.stance, targets: targets.map(t => ({ x: t.x, y: t.y, z: t.z, name: t.expectedName })), tool: decision.tool?.name ?? 'hand' })
    const confirmCurrent = interruption => {
      const state = adapter.getState()
      // A manual stop advances the epoch before draining this same job. Its
      // received partial result still belongs to this life; a replaced job,
      // connection, dimension or respawn must never borrow another world's air.
      const stoppedHere = ['EPOCH_CHANGED', 'STOP_REQUESTED', 'ABORTED'].includes(interruption?.code) && ['paused', 'stopped', 'cancelled'].includes(job?.userRunIntent) && epoch === receiptScope.epoch + 1
      if (job !== receiptScope.job || state?.phase !== 'spawned' || state.dead || scopeOf(state) !== receiptScope.scope || lifeOf(state) !== receiptScope.life || epoch !== receiptScope.epoch && !stoppedHere) {
        rec.results = []; rec.confirmationSkipped = 'STALE_SCOPE'
        return 0
      }
      return confirmMined(rec, targets)
    }
    if (job.config.persistence.checkpointAfterBatch) await save('mine_intent')
    let failure = null
    try {
      await call(myEpoch, 'mine', signal => adapter.mine(targets, { signal }))
      guard(myEpoch)
    } catch (error) {
      // A controller may reject because stopAll ran just before the watcher.
      // Classify that as the current interruption before counting partial air.
      let interruption = error
      if (!(error instanceof QuarryInterrupt)) { try { guard(myEpoch) } catch (current) { interruption = current } }
      if (interruption instanceof QuarryInterrupt) { rec.status = 'interrupted'; confirmCurrent(interruption); throw interruption }
      failure = error
    }
    const confirmed = confirmCurrent()
    // The server broke a block far slower than the held tool allows: its
    // selected slot / held item differs from our view. Resync the inventory
    // from the server and re-plan (equipTool then really re-sends the slot).
    if (failure?.code === 'SLOW_BREAK') {
      rec.status = confirmed ? 'partial' : 'failed'; rec.error = String(failure.message)
      job.slowBreaks = (job.slowBreaks ?? 0) + 1
      note('slow_break', { message: failure.message, held: adapter.getState()?.heldItem?.name ?? null, selectedSlot: adapter.getState()?.selectedSlot ?? null, count: job.slowBreaks })
      if (job.slowBreaks >= 3) return finish('PAUSED', 'SLOW_BREAK_PERSISTS', { pauseDetails: { lastError: rec.error, held: adapter.getState()?.heldItem?.name ?? null } })
      try { await call(myEpoch, 'resync', signal => adapter.resyncInventory?.({ signal })) } catch (error) { if (error instanceof QuarryInterrupt) throw error; note('resync_failed', { error: String(error.message ?? error).slice(0, 200) }) }
      lastInventory = totals(items(adapter.getState()) ?? [])
      return
    }
    if (confirmed) { job.slowBreaks = 0; job.routeSkips = 0; job.autoResumes = 0; for (const r of rec.results ?? []) if (r.result === 'removed') { const y = Number(r.position.split(',')[1]); if (Number.isFinite(y) && Number.isFinite(job.deepestY) && y < job.deepestY) job.deepestY = y } }
    if (failure && !confirmed) {
      rec.status = 'failed'; rec.error = String(failure.message ?? failure)
      // A preview refused for the stance (pose not settled, face not visible
      // from here) says nothing about the cells: avoid this stance and re-plan.
      if (/静止|視線が遮られ|未取得|settled|grounded/.test(rec.error) && decision.stance) {
        badStances.set(`${decision.stance.x},${decision.stance.y},${decision.stance.z}`, 2)
        // The current stance is never avoided by the planner, so count refusals
        // per cell too: after 3 the cells wait for the next reconcile (retried
        // there) instead of looping on the same refusal.
        job.refusedCells ??= {}
        for (const t of targets) { const k = `${t.x},${t.y},${t.z}`; job.refusedCells[k] = (job.refusedCells[k] ?? 0) + 1; if (job.refusedCells[k] >= 3) { planner.defer(t, 'MINING_FAILED', { error: rec.error }); delete job.refusedCells[k] } }
        note('mine_stance_refused', { error: rec.error.slice(0, 160), stance: decision.stance })
        await sleep(200)
        return
      }
      job.retry = (job.retry ?? 0) + 1; if (job.retry > 3) { for (const t of targets) planner.defer(t, 'MINING_FAILED', { error: rec.error }); job.retry = 0 }
      note('mine_failed', { error: rec.error }); return
    }
    job.retry = 0
    rec.status = failure ? 'partial' : 'confirmed'
    batchCount += confirmed
    // Track fresh drops near the targets for the collection deadline. Drop
    // entities can arrive a moment after the air; ones missed here are picked
    // up by observeDrops() on the next work tick, so there is no fixed wait.
    trackDrops(targets)
    if (decision.targets.some(t => blockRule(t.name).ore)) { await sleep(150); trackDrops(targets); await collect(myEpoch, 'valuable') }
    if (job.config.persistence.checkpointAfterBatch) { job.checkpoint = { at: new Date(now()).toISOString(), layer: job.cursorY, position: copy(adapter.getState().position), batchCount }; await save('batch') }
  }

  // Each target is re-read: air counts as removed; a different block (sand
  // fell in, water flowed) stays for re-planning (§15.1, T09).
  function confirmMined (rec, targets) {
    countsRevision++
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

  // Items lying in the travel region that are not tracked yet (late drop
  // entities, loot) start their collection clock when first seen.
  function observeDrops () {
    const live = new Set()
    for (const e of adapter.entities()) {
      if (e.kind !== 'item' || !e.position) continue
      live.add(e.runtimeId)
      if (pendingDrops.some(d => d.runtimeId === e.runtimeId)) continue
      if (!permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed) continue
      pendingDrops.push({ runtimeId: e.runtimeId, name: e.name, count: e.count, position: copy(e.position), firstSeen: now(), mixed: true })
    }
    pendingDrops = pendingDrops.filter(d => live.has(d.runtimeId))
    for (const [id, until] of stuckItems) if (until <= now() || !live.has(id)) stuckItems.delete(id)
  }
  const openDrops = () => pendingDrops.filter(d => !d.unreachable && !stuckItems.has(d.runtimeId))

  // Bedrock picks an item up when it touches the player's box grown by about
  // 1 block sideways and 0.5 block up/down. A stand one block above an item
  // (feet y+1) never reaches it, and a diagonal stand can miss it sideways.
  function inPickupRange (feet, p) {
    return Math.abs(p.x - feet.x) <= PICKUP_XZ && Math.abs(p.z - feet.z) <= PICKUP_XZ && p.y + 0.25 >= feet.y - 0.5 && p.y <= feet.y + 1.8 + 0.5
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
    // Every item lying inside the travel region is collected, not only the
    // job's own drops (mixed items count as "picked" only when they enter the
    // bag).
    for (const e of ents.values()) if (!remaining.some(d => d.runtimeId === e.runtimeId) && permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed) remaining.push({ runtimeId: e.runtimeId, name: e.name, count: e.count, position: copy(e.position), firstSeen: now(), mixed: true })
    // Stuck items (still on the ground after a visit) are skipped for a while,
    // except on the final sweep.
    const skipped = []
    for (let k = remaining.length - 1; k >= 0; k--) if (why !== 'final' && (stuckItems.has(remaining[k].runtimeId) || remaining[k].reason === 'STUCK_REPEATED')) skipped.push(...remaining.splice(k, 1))
    const unreachable = skipped.map(d => ({ ...d, reason: d.reason === 'STUCK_REPEATED' ? d.reason : 'STUCK' }))
    let needRoom = false
    const PASS = 48
    const around = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    const present = id => adapter.entities().some(e => e.runtimeId === id)
    const waitGone = async (id, ms) => { const until = now() + ms; while (now() < until && present(id)) await sleep(50); return !present(id) }
    let visits = 0
    // Rank by actual reachable paths, not distance through a wall or pit.
    // Drops at the collection deadline come first; a nearby stand can still
    // cover several items passively. Recompute after each confirmed move.
    while (remaining.length) {
      const here = guard(myEpoch); const feet = { x: here.position.x, y: here.position.y - FEET, z: here.position.z }
      const live = new Set(adapter.entities().map(e => e.runtimeId))
      for (let i = remaining.length - 1; i >= 0; i--) if (!live.has(remaining[i].runtimeId)) remaining.splice(i, 1)
      if (!remaining.length) break
      if (visits >= PASS || needRoom) { unreachable.push(...remaining.splice(0).map(d => ({ ...d, reason: needRoom ? 'NO_CAPACITY' : 'NEXT_PASS' }))); break }
      const reach = await planner.reachableFromAsync(feetCell(here))
      guard(myEpoch)
      const candidates = new Map()
      for (let i = 0; i < remaining.length; i++) {
        if (i && i % 16 === 0) { await new Promise(resolve => setImmediate(resolve)); guard(myEpoch) }
        const d = remaining[i]
        const cell = { x: Math.floor(d.position.x), y: Math.floor(d.position.y + 0.01), z: Math.floor(d.position.z) }
        const stands = [0, -1, 1].flatMap(dy => around.map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })))
          .filter(c => inPickupRange({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, d.position) && planner.standable(c) && permits(regions, 'travel', c).allowed && reach.has(`${c.x},${c.y},${c.z}`))
        const distance = c => reach.get(`${c.x},${c.y},${c.z}`)
        const nearest = stands.length ? Math.min(...stands.map(distance)) : Infinity
        candidates.set(d, { stands, distance, nearest: inPickupRange(feet, d.position) ? 0 : nearest })
      }
      const dueAt = now() - Math.min(job.config.strategy.collectAfterSeconds, job.config.strategy.collectWithinSeconds) * 1000
      remaining.sort((a, b) => {
        const ca = candidates.get(a); const cb = candidates.get(b)
        const reachable = Number(Number.isFinite(cb.nearest)) - Number(Number.isFinite(ca.nearest))
        if (reachable) return reachable
        const aDue = a.firstSeen <= dueAt; const bDue = b.firstSeen <= dueAt
        return Number(bDue) - Number(aDue) || (aDue && bDue ? a.firstSeen - b.firstSeen : 0) || ca.nearest - cb.nearest || a.firstSeen - b.firstSeen
      })
      const d = remaining.shift()
      if (!present(d.runtimeId)) continue
      const inv = items(guard(myEpoch))
      if (!inv) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
      if (!canAccept(inv, [{ name: d.name ?? 'unknown', count: d.count ?? 1 }])) { needRoom = true; unreachable.push({ ...d, reason: 'NO_CAPACITY' }); continue }
      // Already within pickup range: no walk, just a short wait.
      if (inPickupRange(feet, d.position) && await waitGone(d.runtimeId, 400)) continue
      const candidate = candidates.get(d)
      const stands = candidate.stands.filter(c => candidate.distance(c) <= candidate.nearest + 4)
      const covers = c => remaining.filter(o => inPickupRange({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, o.position)).length
      stands.sort((a, b) => (candidate.distance(a) + 2) / (covers(a) + 1) - (candidate.distance(b) + 2) / (covers(b) + 1) || candidate.distance(a) - candidate.distance(b))
      const target = stands[0]
      if (!target) { unreachable.push({ ...d, reason: 'UNREACHABLE' }); continue }
      visits++
      try { await moveToStance(myEpoch, target) } catch (error) { if (error instanceof QuarryInterrupt) throw error; unreachable.push({ ...d, reason: 'MOVE_FAILED' }); continue }
      if (await waitGone(d.runtimeId, 600)) continue
      // Still on the ground beside us: skip it for a while instead of coming
      // back after every batch; after repeated misses it is written off until
      // the final sweep.
      d.stuckVisits = (d.stuckVisits ?? 0) + 1
      stuckItems.set(d.runtimeId, now() + job.config.strategy.stuckItemMs)
      note('item_stuck', { name: d.name, position: d.position, stand: target, visits: d.stuckVisits })
      unreachable.push({ ...d, reason: d.stuckVisits >= 2 ? 'STUCK_REPEATED' : 'STUCK' })
    }
    const after = totals(items(guard(myEpoch)) ?? [])
    for (const x of diff(before, after)) if (x.delta > 0) note('collected', x)
    observeInventory('COLLECT')
    // Items still on the ground stay tracked: capacity misses are retried after
    // a deposit, unreachable ones are only written off at the end (§10.2).
    const still = new Set(adapter.entities().filter(e => e.kind === 'item').map(e => e.runtimeId))
    pendingDrops = unreachable.filter(d => still.has(d.runtimeId)).map(d => ({ ...d, unreachable: !['NO_CAPACITY', 'NEXT_PASS', 'STUCK'].includes(d.reason) }))
    job.unreachableItems = pendingDrops.filter(d => d.unreachable).map(d => ({ name: d.name, count: d.count, position: d.position, reason: d.reason }))
    batchCount = 0
    // The bag could not take everything: empty it into the chests, then the
    // left-over drops are picked up on the next collection.
    if (needRoom && job.config.inventory.storage?.length) { note('collect_needs_room', { left: pendingDrops.filter(d => !d.unreachable).length }); job.depositReason = 'capacity'; setState('RETURN'); return }
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
    countsRevision++
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

  // Storage is a list of chests filled in order. A chest that reported no room
  // is skipped until the job is resumed (the user may have emptied it).
  const posKey = p => `${p.x},${p.y},${p.z}`
  function currentStorage () {
    const full = new Set(job.fullStorage ?? [])
    return (job.config.inventory.storage ?? []).find(st => st?.position && !full.has(posKey(st.position))) ?? null
  }

  // Cells for one more chest near `near`: standable ground (solid floor, air
  // for the chest and above it), outside the dig columns, not beside another
  // chest (that would merge into a double chest and hide the new one), and not
  // a cell the bot or another chest's stand uses.
  // Returns [{ cell, stand, path }]: the bot walks to `stand` (beside the cell)
  // before placing, so the chest face is in reach and in sight.
  function chestCandidates (near, feet) {
    const chests = (job.config.inventory.storage ?? []).map(st => st.position).filter(Boolean)
    const named = (c, re) => { const b = adapter.getBlock(c.x, c.y, c.z); return b?.known === true && re.test(nameOf(b)) }
    // Any chest block counts, registered or not (two touching chests merge).
    const touchesChest = c => chests.some(p => p.y === c.y && Math.abs(p.x - c.x) + Math.abs(p.z - c.z) <= 1) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => named({ x: c.x + ax, y: c.y, z: c.z + az }, /chest$/))
    // The chest needs a truly empty cell and empty space above it (grass and
    // flowers are passable for walking but block placement).
    const clear = c => [c, { ...c, y: c.y + 1 }].every(p => { const b = adapter.getBlock(p.x, p.y, p.z); return b?.known === true && AIR.has(nameOf(b)) && !(b.extra ?? []).length })
    const out = []
    for (let r = 2; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          for (const dy of [0, -1, 1]) {
            const c = { x: near.x + dx, y: near.y + dy, z: near.z + dz }
            if (!planner.standable(c) || !clear(c) || regions.columns.has(`${c.x},${c.z}`) || touchesChest(c)) continue
            if (feet && c.x === feet.x && c.z === feet.z && Math.abs(c.y - feet.y) <= 1) continue
            let best = null
            for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const stand = { x: c.x + ax, y: c.y, z: c.z + az }
              if (!planner.standable(stand) || regions.columns.has(`${stand.x},${stand.z}`) || named(stand, /chest$|crafting_table/)) continue
              const path = feet ? planner.pathTo(feet, stand) : null
              if (path && (!best || path.length < best.path.length)) best = { cell: c, stand, path }
            }
            if (best) out.push(best)
          }
        }
      }
    }
    return out.sort((a, b) => a.path.length - b.path.length).slice(0, 16)
  }

  // All registered chests are full: put down one more beside the last one
  // (a carried chest, or one crafted from carried wood; never by command).
  async function expandStorage (myEpoch) {
    const list = job.config.inventory.storage ?? []
    const maxChests = job.config.inventory.maxChests ?? 16
    if (list.length >= maxChests) return { ok: false, reason: 'MAX_CHESTS', maxChests }
    if (typeof adapter.addChest !== 'function') return { ok: false, reason: 'ADD_CHEST_UNSUPPORTED' }
    const last = list[list.length - 1]
    // Walking to the last chest is only a starting point; if that stand cannot
    // be reached any more, search for a chest cell from where we are.
    try { await goToStorage(myEpoch, last) } catch (error) { if (error instanceof QuarryInterrupt && error.code !== 'STORAGE_UNREACHABLE') throw error; if (!(error instanceof QuarryInterrupt)) note('add_chest_start_unreachable', { error: String(error.message ?? error).slice(0, 160) }) }
    const s = guard(myEpoch)
    // Around every registered chest (the last one's surroundings fill up with
    // chests, tables and trees), nearest walk first, duplicates removed.
    const seen = new Set()
    const candidates = [last, ...list.slice(0, -1).reverse()].flatMap(st => st?.position ? chestCandidates(st.position, feetCell(s)) : []).filter(c => { const k = `${c.cell.x},${c.cell.y},${c.cell.z}`; if (seen.has(k)) return false; seen.add(k); return true }).sort((a, b) => a.path.length - b.path.length)
    if (!candidates.length) return { ok: false, reason: 'NO_CHEST_CELL' }
    setState('ADD_STORAGE')
    const rec = recordAction({ type: 'add_chest', candidates: candidates.slice(0, 4).map(c => c.cell) })
    await save('add_chest_intent')
    let r = null
    const attempts = []
    for (const c of candidates.slice(0, 8)) {
      // Stand beside the cell first, then place (or craft, then place) there.
      try { await moveToStance(myEpoch, c.stand) } catch (error) { if (error instanceof QuarryInterrupt) throw error; attempts.push({ cell: c.cell, reason: 'MOVE_FAILED' }); continue }
      // Other candidates are spare cells for a crafting table if one is needed.
      const cells = [c.cell, ...candidates.filter(o => o !== c).map(o => o.cell)]
      try { r = await call(myEpoch, 'add_chest', signal => adapter.addChest(cells, { signal })) } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        r = { ok: false, reason: 'ADD_CHEST_FAILED', error: String(error.message ?? error).slice(0, 200) }
      }
      if (r?.ok) break
      attempts.push({ cell: c.cell, reason: r?.reason ?? null, tried: r?.tried?.slice(0, 2) ?? null })
      if (r?.reason === 'NO_CHEST_MATERIAL') break
    }
    if (!r?.ok && r) r = { ...r, attempts }
    rec.status = r?.ok ? 'confirmed' : 'failed'; rec.result = copy(r ?? null)
    if (!r?.ok) { await save('add_chest_failed'); return r ?? { ok: false, reason: 'ADD_CHEST_FAILED' } }
    // Only a chest the server reports at that cell counts (§11.2).
    const b = adapter.getBlock(r.position.x, r.position.y, r.position.z)
    if (!b?.known || nameOf(b) !== 'chest') { rec.status = 'failed'; return { ok: false, reason: 'CHEST_NOT_OBSERVED', position: r.position } }
    const entry = { position: copy(r.position), addedBy: 'quarry', at: new Date(now()).toISOString() }
    job.config.inventory.storage = [...list, entry]
    // The travel region includes every chest; rebuild it for the new one.
    const records = planner.exportRecords()
    regions = makeRegions(job.config, job.yTop, adapter.getState())
    planner = createQuarryPlanner({ regions, getBlock: adapter.getBlock, config: job.config.strategy, records })
    note('storage_added', { position: entry.position, chests: job.config.inventory.storage.length, crafted: r.crafted ?? null })
    await save('storage_added')
    return { ok: true, storage: entry }
  }

  async function goToStorage (myEpoch, target = null) {
    const st = target ?? currentStorage() ?? job.config.inventory.storage?.[0]
    if (!st) throw new QuarryInterrupt('NO_STORAGE', 'No registered storage')
    setState('RETURN')
    const from = feetCell(guard(myEpoch))
    const stands = (st.stand ? [st.stand] : [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: st.position.x + dx, y: st.position.y, z: st.position.z + dz }))).filter(c => planner.standable(c))
    let path = null; let stand = null
    for (const c of stands) { const p = planner.pathTo(from, c); if (p && (!path || p.length < path.length)) { path = p; stand = c } }
    if (!path) throw new QuarryInterrupt('STORAGE_UNREACHABLE', 'No permitted walking route to the registered storage')
    await call(myEpoch, 'return', signal => adapter.goToStorage({ ...st, stand }, { signal, path, travel: c => permits(regions, 'travel', c).allowed }))
  }

  function storageHostiles () {
    const st = currentStorage() ?? job.config.inventory.storage?.[0]
    if (!st?.position) return []
    return (adapter.actors?.() ?? []).filter(e => e.hostile === true && e.alive !== false && e.position && Math.hypot(e.position.x - st.position.x, e.position.z - st.position.z) <= STORAGE_AREA_RADIUS && Math.abs(e.position.y - st.position.y) <= 12)
  }
  async function waitForQuietStorage (myEpoch) {
    const busy = list => list.length >= 3 || list.some(e => /witch|evoker|ravager|vindicator|creeper/.test(e.entityType ?? ''))
    let list = storageHostiles()
    if (!busy(list)) return
    note('storage_area_hostile', { count: list.length, types: [...new Set(list.map(e => e.entityType))].slice(0, 6) })
    const until = now() + STORAGE_WAIT_MS
    while (now() < until && busy(list)) {
      guard(myEpoch)
      if (job.config.quarryCombat.enabled && adapter.combatActive()) throw new QuarryInterrupt('COMBAT')
      await sleep(2000)
      list = storageHostiles()
    }
    note(busy(list) ? 'storage_area_wait_timeout' : 'storage_area_clear', { count: list.length })
  }

  async function returnAndDeposit (myEpoch, why) {
    if (!job.config.inventory.storage?.length) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'carry-only job is full' } })
    // Do not walk out of the pit into a group: with several hostiles (or a
    // witch) around the chests, wait here and let combat take them first.
    await waitForQuietStorage(myEpoch)
    let st = currentStorage()
    if (!st) {
      // Every chest is full: add one more and keep going.
      const added = await expandStorage(myEpoch)
      if (!added.ok) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'all chests full', chests: (job.config.inventory.storage ?? []).length, addChest: added } })
      st = added.storage
    }
    // A chest whose stand cannot be walked to right now is skipped like a full
    // one (retried after the next resume) instead of failing the whole action.
    try { await goToStorage(myEpoch, st) } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      note('storage_unroutable', { position: st.position, error: String(error.message ?? error).slice(0, 160) })
      job.fullStorage = [...new Set([...(job.fullStorage ?? []), posKey(st.position)])]
      return
    }
    setState('DEPOSIT')
    const s = guard(myEpoch)
    const inv = items(s)
    if (!inv) { await sleep(300); return }
    const { deposits } = keepPlan(inv, job.config.inventory)
    if (!deposits.length) {
      if (why === 'final') { setState('FINAL_CHECK', { finalDeposited: true }); return }
      // Nothing to store but the bag is still too full: only kept items
      // (tools, food, seal blocks, chest wood) remain, so wait for the user.
      const free = freeSlots(inv)
      if (free < job.config.inventory.minFreeSlots) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'only kept items left', freeSlots: free, needFreeSlots: job.config.inventory.minFreeSlots } })
      setState('SURVEY'); return
    }
    const rec = recordAction({ type: 'deposit', why, items: deposits, storage: copy(st.position) })
    await save('deposit_intent')
    let result
    try { result = await call(myEpoch, 'deposit', signal => adapter.deposit([st], deposits, { signal })) } catch (error) {
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
      // This chest is full; the rest goes to the next one (added if needed).
      job.fullStorage = [...new Set([...(job.fullStorage ?? []), posKey(st.position)])]
      note('storage_full', { position: st.position, deposited: (result.deposited ?? []).reduce((n, d) => n + d.count, 0) })
      await save('storage_full')
      if (keepPlan(items(adapter.getState()) ?? [], job.config.inventory).deposits.length) { setState('RETURN'); return }
    }
    if (why === 'final') { setState('FINAL_CHECK', { finalDeposited: true }); return }
    await lightStorageArea(myEpoch)
    setState('SURVEY')
  }

  // Light the chest area once (again when a chest was added): mobs that spawned
  // around the chests caused most deaths on the surface. Normal crafting and
  // placement only; every failure is logged and skipped, never a pause.
  async function lightStorageArea (myEpoch) {
    const list = (job.config.inventory.storage ?? []).map(st => st.position).filter(Boolean)
    if (!list.length || typeof adapter.craftTorches !== 'function' || typeof adapter.placeTorch !== 'function') return
    if (job.storageLitFor === list.length || now() - (job.lightAttemptAt ?? 0) < 600000) return
    job.lightAttemptAt = now()
    const nearTorch = (p, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) { const b = adapter.getBlock(p.x + dx, p.y + dy, p.z + dz); if (b?.known && /torch|lantern/.test(nameOf(b))) return true } return false }
    const cells = []
    for (const c of list) {
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, 3], [3, -3], [-3, -3]]) {
        for (const dy of [0, 1, -1]) {
          const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
          const at = adapter.getBlock(p.x, p.y, p.z); const below = adapter.getBlock(p.x, p.y - 1, p.z)
          if (!(at?.known && AIR.has(nameOf(at)) && !(at.extra ?? []).length && below?.known && below.boundingBox === 'block' && !/chest|crafting_table|leaves|torch/.test(nameOf(below)))) continue
          if (regions.columns.has(p.x + ',' + p.z) || cells.some(o => Math.hypot(o.x - p.x, o.z - p.z) < 4) || nearTorch(p, 3)) break
          cells.push(p); break
        }
      }
    }
    if (!cells.length) { job.storageLitFor = list.length; return }
    const crafted = await call(myEpoch, 'craft_torches', signal => adapter.craftTorches({ want: Math.min(8, cells.length), signal })).catch(error => { if (error instanceof QuarryInterrupt) throw error; return { ok: false, error: String(error.message ?? error).slice(0, 160) } })
    note('torches_crafted', crafted ?? {})
    if (!crafted?.torches) return
    let placed = 0
    for (const p of cells.slice(0, Math.min(8, crafted.torches))) {
      const reach = planner.reachableFrom(feetCell(guard(myEpoch)))
      const stand = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) => ({ x: p.x + dx, y: p.y, z: p.z + dz })).find(c => planner.standable(c) && reach.has(c.x + ',' + c.y + ',' + c.z))
      if (!stand) continue
      try { await moveToStance(myEpoch, stand) } catch (error) { if (error instanceof QuarryInterrupt) throw error; continue }
      const r = await call(myEpoch, 'place_torch', signal => adapter.placeTorch({ position: p, signal })).catch(error => { if (error instanceof QuarryInterrupt) throw error; return { ok: false, error: String(error.message ?? error).slice(0, 120) } })
      if (r?.ok) placed++
      else note('torch_failed', { position: p, ...(r ?? {}) })
    }
    note('storage_lit', { placed, cells: cells.length, chests: list.length })
    if (placed) job.storageLitFor = list.length
  }

  async function finalCheck (myEpoch) {
    guard(myEpoch)
    // Re-scan the whole range (§16.3): unknown never completes.
    const counts = planner.counts(job.yTop)
    job.finalCounts = counts
    if (counts.remaining > 0) { job.cursorY = job.yTop; setState('SURVEY'); return }
    if (counts.unknown > 0) return finish('PAUSED', 'UNOBSERVED_CELLS', { pauseDetails: counts })
    if (!job.finalDeposited && job.config.inventory.storage?.length) { await collect(myEpoch, 'final'); job.depositReason = 'final'; await returnAndDeposit(myEpoch, 'final'); return }
    // UNREACHABLE is relative to where the bot stood; re-try from here a few
    // times before treating those cells as exceptions.
    // Same for cells put aside after transient mining refusals.
    if (planner.deferredList().some(d => ['UNREACHABLE', 'MINING_FAILED', 'SUPPORTS_DEFERRED_FALLING_BLOCK'].includes(d.reason)) && (job.unreachableRetries ?? 0) < 3) {
      job.unreachableRetries = (job.unreachableRetries ?? 0) + 1
      planner.clearDeferred(['UNREACHABLE', 'MINING_FAILED', 'SUPPORTS_DEFERRED_FALLING_BLOCK'])
      badStances.clear()
      note('unreachable_retry', { attempt: job.unreachableRetries })
      job.cursorY = job.yTop; setState('SURVEY'); return
    }
    // One last sweep for anything still lying in the area (drops that were
    // unreachable earlier, items that fell later), then store it as well.
    if (!job.finalSweepDone) {
      job.finalSweepDone = true
      const lying = adapter.entities().filter(e => e.kind === 'item' && e.position && permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed).length
      if (lying) {
        note('final_sweep', { items: lying })
        if (job.config.inventory.storage?.length) job.finalDeposited = false
        await collect(myEpoch, 'final_sweep')
        if (job.state === 'PLAN') setState('FINAL_CHECK')
        return
      }
    }
    const exceptions = exceptionsList()
    const byReason = {}
    for (const e of exceptions) { const r = e.reason ?? e.kind; byReason[r] = (byReason[r] ?? 0) + 1 }
    // Cells kept only for want of a usable tool are not exceptions to accept:
    // the job waits for a tool and retries them on resume (§8.1).
    const toolWait = exceptions.filter(e => TOOL_WAIT.has(e.reason))
    if (toolWait.length) {
      const needs = {}
      for (const e of toolWait) { const n = e.needs ? `${e.needs.kind ?? e.needs}${e.needs.tier != null ? `:${e.needs.tier}` : ''}` : 'unknown'; needs[n] = (needs[n] ?? 0) + 1 }
      return finish('PAUSED', 'WAITING_FOR_TOOL', { pauseDetails: { cells: toolWait.length, needs, byReason, examples: toolWait.slice(0, 10) } })
    }
    if (exceptions.length && !job.acceptedExceptions) return finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { count: exceptions.length, byReason, exceptions: exceptions.slice(0, 50) } })
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
    // A failed action often clears up on its own (a mob in the way, a lag
    // spike): resume automatically up to 3 times, 30s apart, before staying
    // paused. Progress (a confirmed mine) resets the count.
    // The budget is per burst: 10 minutes after the last automatic resume it
    // starts again, so a few failures spread over hours never stop the job.
    if (result === 'PAUSED' && /^ACTION_FAILED/.test(String(reason)) && now() - (job.lastAutoResumeAt ?? 0) > AUTO_RESUME_WINDOW_MS) job.autoResumes = 0
    if (result === 'PAUSED' && /^ACTION_FAILED/.test(String(reason)) && (job.autoResumes ?? 0) < 3 && job.userRunIntent === 'running') {
      job.autoResumes = (job.autoResumes ?? 0) + 1
      job.lastAutoResumeAt = now()
      const owner = job; const count = job.autoResumes
      const t = setTimeout(() => { try { if (job === owner && job.state === 'PAUSED' && job.pauseReason === reason && job.userRunIntent === 'running') { note('auto_resume', { reason, count }); resume() } } catch {} }, autoResumeMs)
      t.unref?.()
    }
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
    // The bot may have died or reconnected while the job was paused. Resume
    // binds to the current living session (the death is recorded once) and
    // reconciles from there instead of pausing again with DEATH.
    if (job.scope) {
      const cur = adapter.getState()
      if (cur?.phase === 'spawned' && !cur.dead && (scopeOf(cur) !== job.scope || lifeOf(cur) !== job.life)) {
        if (lifeOf(cur) !== job.life && job.pauseReason !== 'DEATH') job.deaths.push({ at: new Date(now()).toISOString(), position: null, cause: null, unrecovered: [], whilePaused: true })
        job.scope = scopeOf(cur); job.life = lifeOf(cur)
      }
    }
    job.userRunIntent = 'running'; epoch++
    job.retry = 0; job.unreachableRetries = 0
    // Chests may have been emptied and drops re-checked while paused.
    job.fullStorage = []; job.finalSweepDone = false; job.finalDeposited = false
    abort = new AbortController()
    setState(job.scope ? 'RECONCILE' : 'PREFLIGHT', { pauseReason: null, result: null })
    adapter.onStarted?.(status())
    worker = loop().finally(() => { worker = null })
    return status()
  }
  async function pause (reason = 'MANUAL_PAUSE') {
    if (!job) return status()
    if (!ACTIVE.has(job.state)) { if (job.state === 'PAUSED') job.userRunIntent = 'paused'; return status() }
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

  function displayCounts (state) {
    if (job.yTop == null || !planner) return null
    const owner = job; const source = planner; const generation = epoch
    const scope = scopeOf(state); const life = lifeOf(state)
    const localRevision = countsRevision; const records = source.revision()
    const world = adapter.worldRevision?.() ?? null
    const isCurrent = () => job === owner && planner === source && epoch === generation && countsRevision === localRevision && source.revision() === records && (adapter.worldRevision?.() ?? null) === world && scopeOf(adapter.getState()) === scope && lifeOf(adapter.getState()) === life
    const cache = countsCache?.job === owner && countsCache.planner === source && countsCache.scope === scope && countsCache.life === life ? countsCache : null
    if (!countsWork && (!cache || now() - cache.at >= 2000)) {
      // Start outside the status request; even the first display never scans
      // a deep quarry synchronously. An obsolete scan cannot publish a value.
      const work = new Promise(resolve => setImmediate(resolve)).then(() => source.countsAsync(owner.yTop, isCurrent)).then(value => {
        if (value && isCurrent()) countsCache = { job: owner, planner: source, scope, life, at: now(), value }
      }).catch(() => {}).finally(() => { if (countsWork === work) countsWork = null })
      countsWork = work
    }
    return cache?.value ?? null
  }

  function status () {
    if (!job) return { state: 'IDLE', job: null }
    const s = adapter.getState()
    const inv = items(s)
    const counts = displayCounts(s)
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
