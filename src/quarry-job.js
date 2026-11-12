'use strict'
const { isDeepStrictEqual } = require('node:util')
const { randomUUID } = require('node:crypto')
const { validateJobId, newJobId, worldIdentity, assertJobWorld, documentInstance } = require('./quarry-job-identity')

// Quarry job manager (spec v1.2 §4, §8-§11, §14-§16, §18): one job, explicit
// states, a single owner of quarry inputs, journal/checkpoints and the combat
// interruption cycle. Every world action goes through the injected adapter,
// whose results are re-observed before they count.

const { buildRegions, permits, chunkBounds } = require('./quarry-region')
const { createQuarryPlanner } = require('./quarry-planner')
const { blockRule, nameOf, selectTool, toolState, AIR, SEAL_MATERIALS } = require('./quarry-rules')
const { keepPlan, canAccept, totals, diff, createLedger, freeSlots, isFood, selectCarriedStorage, isShulkerBox, carriedContainerKey } = require('./quarry-inventory')
const { createQuarryCombatBridge } = require('./quarry-combat-bridge')
const { miningUsesAfterExitReserve } = require('./quarry-exit-reserve')
const { normalizeExit, dirtCount, planQuarryExit } = require('./quarry-exit-plan')
const { supplyNeeds, supplyScope, storageSupplyExclusions } = require('./quarry-supplies')
const { UNSENT_PLACE_REASON } = require('./quarry-portable-storage')
const { supplyPlacementAllowed, planSupplyApproach } = require('./quarry-supply-site')
const { clearableSitePlant, plainAir } = require('./storage-site-terrain')
const { createQuarryCapacityBatch, fullDropBudget, chooseCapacityPrefix } = require('./quarry-capacity-batch')

const copy = value => value === undefined ? undefined : structuredClone(value)
const samePoint = (a, b) => ['x', 'y', 'z'].every(axis => Number.isSafeInteger(a?.[axis]) && a[axis] === b?.[axis])
const FEET = 1.62
const SETTLE_MAX_WAIT_MS = 45000 // longest post-combat settle wait for threats that do not come
const POSE_MOVE_LIMIT = 3, POSE_CONFIRM_RADIUS = 1.5 // pose check after a pause (blocks)
// Tools of one kind carried while all are reserved for the exit (live 2026-11-10:
// three pickaxes at 19 uses each were all reserved, so a 4th is needed; worn
// ones are used down later and returned once unusable).
const TERRAIN_BUDGET_RENEW_MS = 600000 // a terrain request budget older than this is renewed on resume
const EGRESS_NOOP_COMBAT_MS = 3000, EGRESS_NOOP_COMBAT_RETRIES = 6 // no-action combat during the climb (consecutive, reset by progress)
// Momentary refusals during the climb (live 2026-11-11 0:37-0:55: the
// inventory briefly unconfirmed after a placement, the self-position query not
// yet settled, a step left pending). The egress itself reconciles the pending
// step from received evidence; the job only waits and calls it again, a few
// times in a row, reset by a confirmed step. Damage, terrain, dirt or scope
// problems still pause.
// Tree canopy at the top of a new job (live 2026-11-11 10:53: five oak
// leaves at Y79 over a tree) cannot be reached from the ground before the
// layers under it are dug. Such cells do not make the mining origin
// unreachable; they stay deferred and decay once the trunk is mined.
const canopyName = name => /(_leaves|^vine|^cave_vines.*|^azalea.*|^leaf_litter)$/.test(nameOf(name))
const EGRESS_TRANSIENT = new Set(['ASCENT_INVENTORY_UNKNOWN', 'EGRESS_POSITION_UNCONFIRMED', 'ASCENT_POSITION_UNCONFIRMED', 'EGRESS_RESUME_POSITION_CHANGED', 'ASCENT_HEADSPACE_CHANGED', 'ASCENT_UNCERTAIN_STEP', 'ASCENT_PLACEMENT_UNCONFIRMED', 'ASCENT_JUMP_TIMEOUT', 'ASCENT_SERVER_CORRECTION'])
const EGRESS_TRANSIENT_RETRIES = 4, EGRESS_TRANSIENT_WAIT_MS = 2000
const DEFAULT_BOTTOM_Y = -59 // quarry bottom when none is given
const EXHAUSTED_TOOL_CAP = 4
const CAPACITY_RETRIES = 8 // automatic retries of a storage box recovery blocked only by loose drops (~10 min)
const { needsFourLayerCollection } = require('./quarry-four-layer')
const AUTO_RESUME_WINDOW_MS = 600000 // the ACTION_FAILED auto-resume budget resets after this quiet time
const STORAGE_AREA_RADIUS = 24 // m around the chests checked before leaving the pit
const STORAGE_WAIT_MS = 20000 // longest wait for the chest area to clear (a long idle wait looks like a stall)
const SETTLE_EAT_CLEARANCE = 8 // m: no eating in the settle wait with a hostile this close
const TERRAIN_OBSERVATION_WAIT_MS = 2000
const TERRAIN_OBSERVATION_MAX_REQUESTS = 2
// A layer whose terrain is not received is requested again, with growing waits,
// before the job pauses (live 2026-11-10 23:16: the world cache holds 512
// sections and had evicted the next layer's, so Y-33 was unknown on arrival).
const TERRAIN_LAYER_WAITS_MS = [2000, 4000, 8000, 8000, 8000, 8000]
const TERRAIN_PREFETCH_INTERVAL_MS = 15000
const TERRAIN_LOOKAHEAD_LAYERS = 8 // layers under the work layer received before it is planned
// With a full bag a placed supply box can lose its slot to natural pickup; a
// small stack of placeable mined blocks is put back into dug cells of the
// current layer (re-mined later) to free one slot (live 2026-11-10 22:01, 23:27).
const SUPPLY_ROOM_REASONS = new Set(['SUPPLY_CAPACITY_REQUIRED', 'SUPPLY_RECOVERY_SLOT_REQUIRED'])
// Live 2026-11-11 13:27: the smallest placeable stack was 10 diorite, over the
// old limit of 8, and the restock paused. Up to 24 blocks are now put back,
// bounded by the dug cells of the layer that can actually take them.
const SUPPLY_ROOM_MAX_BLOCKS = 24
const SUPPLY_ROOM_MAX_ATTEMPTS = 2
// A supply site refused just before the box is placed (live 2026-11-11 11:42:
// STORAGE_SITE_CHANGED after a predicted-ready approach) leaves nothing placed
// and nothing moved. Such a restock is started over with a newly chosen site,
// a few times, instead of pausing the job.
const SUPPLY_SITE_REASONS = new Set(['STORAGE_SITE_CHANGED', 'STORAGE_STAND_UNCONFIRMED', 'SUPPLY_SITE_CHANGED'])
const SUPPLY_SITE_RETRIES = 3, SUPPLY_SITE_RETRY_WAIT_MS = 3000
const PICKUP_XZ = 1.3 // half player width 0.3 + 1 block reach for item pickup
const ACTIVE = new Set(['PREFLIGHT', 'SURVEY', 'PLAN', 'MOVE', 'MINE', 'COLLECT', 'RETURN', 'DEPOSIT', 'PORTABLE_STORAGE', 'RESTOCK', 'HAZARD', 'RECOVER', 'SUSPEND_FOR_COMBAT', 'COMBAT', 'COMBAT_SETTLE', 'RECOVER_AFTER_COMBAT', 'RECONCILE', 'FINAL_CHECK', 'EGRESS', 'DISCONNECTED'])
const RESULT = new Set(['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'PAUSED', 'CANCELLED', 'FAILED'])
// Deferrals that are planned exclusions, not exceptions (§16.3).
const PLANNED_EXCLUSIONS = new Set(['UNBREAKABLE', 'OWNED_HOME_STATION'])
const TOOL_WAIT = new Set(['WAITING_FOR_TOOL', 'TOOL_DURABILITY_RESERVE', 'TOOL_DURABILITY_UNKNOWN', 'TOOL_NOT_IN_HOTBAR'])
// SUPPORTS_PROTECTED is re-evaluated too: since 2026-11-10 only falling or
// owned protected blocks keep their support, so older holds under ores are released.
const CAVE_RATIO = 0.2, CAVE_RUN = 24, CAVE_UNKNOWN_RATIO = 0.1 // plan-time cave limits
const REOPEN_UNREACHABLE = 64 // UNREACHABLE cells below the work layer that mark a completion as a misjudgment
const TRANSIENT_DEFER = ['UNREACHABLE', 'MINING_FAILED', 'SUPPORTS_DEFERRED_FALLING_BLOCK', 'SUPPORTS_PROTECTED']

class QuarryInterrupt extends Error { constructor (code, message) { super(message ?? code); this.code = code } }

function defaults (config = {}) {
  const c = structuredClone(config)
  const exit = normalizeExit(c.exit)
  return {
    schemaVersion: 2,
    jobId: validateJobId(c.jobId ?? newJobId()),
    dimension: c.dimension ?? 'overworld',
    target: c.target,
    homeChest: c.homeChest ?? null,
    initialLoadout: c.initialLoadout ?? null,
    yTop: c.yTop ?? 'auto',
    // Default bottom (2026-11-10, user request): Y-59, just above the overworld
    // bedrock band; 'world_min' stays available as an explicit choice.
    yBottom: c.yBottom ?? DEFAULT_BOTTOM_Y,
    worldMinY: c.worldMinY ?? -64,
    worldMaxY: c.worldMaxY ?? 319,
    allowExceptions: c.allowExceptions === true,
    allowCaves: c.allowCaves === true,
    exit,
    permissions: { infrastructureRegion: [], protectedRegion: [], travelRegion: null, ...(c.permissions ?? {}) },
    boundarySeal: { enabled: true, horizontalMargin: 1, ...(c.boundarySeal ?? {}) },
    strategy: { maxBlocksPerBatch: 8, collectWithinSeconds: 30, collectAfterSeconds: 20, collectPendingDrops: 24, stuckItemMs: 60000, maxStepDown: 1, largeFluidCells: 12, ...(c.strategy ?? {}) },
    tools: { reserveMinUses: 1, reserveFraction: 0, returnUses: 0, reservedTools: [], ...(c.tools ?? {}) },
    collection: { orePolicy: 'maximize_yield', buildingBlockPolicy: 'preserve_if_possible', ...(c.collection ?? {}) },
    inventory: { minFreeSlots: 6, keepSealBlocks: 32, storage: [], autoSupplies: false, supplyBoxes: [], ...(c.inventory ?? {}), ...(c.boundarySeal?.material === 'dirt' ? { keepSealMaterial: 'dirt' } : {}), keepExitDirt: exit.mode === 'adjacent_pillar' ? Math.max(exit.reservedDirt, c.inventory?.keepExitDirt ?? 0) : c.inventory?.keepExitDirt ?? 0 },
    safety: { retreatHealthRatio: 0.70, emergencyHealthRatio: 0.40, resumeHealthRatio: 0.90, eatFoodLevel: 16, recoverTimeoutMs: 180000, ...(c.safety ?? {}) },
    quarryCombat: { enabled: true, ...(c.quarryCombat ?? {}) },
    persistence: { checkpointAfterBatch: true, ...(c.persistence ?? {}) }
  }
}

function createQuarryJob ({ adapter, storage = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, bridge = null, pollMs = 50, autoResumeMs = 30000, capacityRetryMs = 75000, stopTimeoutMs = 5000, storageMode = 'legacy' } = {}) {
  // The production Runtime pins this to shulker. Legacy primitives remain for
  // read/recovery tests, never as a browser/CLI-selectable policy.
  const shulkerOnly = storageMode === 'shulker'
  const cargoSelection = (inventory, options = {}) => selectCarriedStorage(inventory, { ...options, shulkerOnly })
  function assertStoragePolicy () {
    if (shulkerOnly && job && (job.config.inventory.storage?.length || job.portableStorage && job.portableStorage.selection?.kind !== 'shulker')) throw new QuarryInterrupt('LEGACY_CHEST_STORAGE', '旧チェストジョブは再開できません。未回収容器を確認してキャンセルし、シュルカーで再計画してください。')
  }
  const required = ['getState', 'getBlock', 'entities', 'mine', 'moveTo', 'equip', 'stopAll', 'combatActive']
  if (!adapter || required.some(k => typeof adapter[k] !== 'function')) throw new Error(`Quarry adapter needs ${required.join(', ')}`)
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 60000) throw new Error('Invalid quarry stop timeout')
  const combatBridge = bridge ?? createQuarryCombatBridge({ now })
  let job = null // persistent document
  let planner = null; let regions = null; let ledger = createLedger()
  let worker = null; let loopWorker = null; let epoch = 0; let abort = null
  let stopTask = null; let autoResumeTimer = null; let savesInFlight = 0
  const pendingActions = new Set()
  const busyError = () => Object.assign(new Error('QUARRY_BUSY: previous work or checkpoint is still draining'), { code: 'QUARRY_BUSY' })
  function requireDrained () { if (worker || stopTask || pendingActions.size || savesInFlight) throw busyError() }
  function clearAutoResume () { clearTimeout(autoResumeTimer); autoResumeTimer = null }
  function launchWorker () {
    const owner = job
    const task = loop()
    worker = task; loopWorker = task
    void task.then(() => { if (worker === task) worker = null; if (loopWorker === task) loopWorker = null }, error => {
      if (job === owner) { note('worker_failed', { error: String(error.message ?? error) }); job.userRunIntent = 'paused'; setState('PAUSED', { pauseReason: 'WORKER_FAILED' }) }
      if (worker === task) worker = null
      if (loopWorker === task) loopWorker = null
    })
  }
  let reconcilingSupplyPlacement = false
  let reconcilingCarriedPlacement = false
  const badStances = new Map() // stance key -> consecutive move failures
  let countsCache = null // display-only; completion always performs its own full scan
  let countsWork = null; let countsRevision = 0
  let saveChain = Promise.resolve()
  let lastInventory = null; let pendingDrops = []; let batchCount = 0
  const stuckItems = new Map() // item runtimeId -> skip until (ms)
  const events = []

  const note = (type, details = {}) => { const e = { at: new Date(now()).toISOString(), type, ...copy(details) }; events.push(e); if (events.length > 200) events.shift(); try { log(`[quarry] ${type} ${JSON.stringify(details).slice(0, 300)}`) } catch {} }
  const feetCell = s => ({ x: Math.floor(s.position.x), y: Math.floor(s.position.y - FEET + 1e-3), z: Math.floor(s.position.z) })
  const healthRatio = s => s.health / (Number.isFinite(s.maxHealth) && s.maxHealth > 0 ? s.maxHealth : 20)
  const foodOf = s => s.food ?? s.hunger ?? null
  const items = s => s?.inventory?.known === true && !s.inventory.uncertain && Array.isArray(s.inventory.items) ? s.inventory.items : null
  const inventoryPolicy = () => ({ ...job.config.inventory, toolPolicy: job.config.tools, ...(fourLayerStorage() ? { keepExitDirt: 0, keepSealBlocks: 64 } :
    deferredExitSupplies() ? { keepExitDirt: job.egressPreparation === true ? Math.max(192, job.config.inventory.keepExitDirt ?? 0) : 0, keepSealBlocks: 64 } : {}) })
  const passivePickup = () => job?.config.inventory.pickupMode === 'passive'
  const fullOnlyStorage = () => job?.config.inventory.depositWhen === 'full'
  const fourLayerStorage = () => job?.config.inventory.pickupMode === 'active' && job?.config.inventory.depositWhen === 'four_layers'
  const usesV22Loadout = () => job?.config.initialLoadout === 'v22' || fourLayerStorage()
  const deferredExitSupplies = () => fourLayerStorage() || job?.config.initialLoadout === 'v22' && job.config.strategy.dirtFromSupplyAtExit === true && completedV22Loadout()
  const v22SupplyLayout = config => config?.inventory?.supplyLayout === 'v22' || config?.inventory?.depositWhen === 'four_layers'
  const loadoutPorts = () => ['loadoutWithdraw', 'equipmentView', 'equipmentTransfer', 'discoverSupplies', 'restockSupplies', 'previewSupplySite', 'storeCarried', 'registeredHomeChest'].every(name => typeof adapter[name] === 'function')
  const configuredLoadoutHome = config => {
    const home = config.homeChest
    if (!home || !['position', 'other', 'stand', 'stage'].every(part => home[part] && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(home[part][axis])))) return false
    const registered = adapter.registeredHomeChest?.()
    return registered && ['position', 'other', 'stand', 'stage'].every(part => samePoint(home[part], registered[part])) &&
      [home.position, home.other].every(p => { const block = adapter.getBlock(p.x, p.y, p.z); return block?.known === true && nameOf(block) === 'chest' && !block.extra?.length })
  }
  const emptyLoadoutInventory = state => {
    const view = adapter.equipmentView?.(), empty = row => row?.known === true && row.empty === true && row.count === 0
    return items(state)?.length === 0 && view?.known === true && view.uncertain !== true && view.slots?.length === 36 && view.slots.every(empty) &&
      view.armor?.known === true && view.armor.slots?.length === 4 && view.armor.slots.every(empty) && view.offhand?.known === true && view.offhand.slots?.length === 1 && view.offhand.slots.every(empty)
  }
  const storageSettings = () => ({ pickupMode: job?.config.inventory.pickupMode ?? 'active', depositWhen: job?.config.inventory.depositWhen ?? 'capacity' })
  const validStoragePair = inventory => {
    const pickup = inventory?.pickupMode === undefined ? 'active' : inventory.pickupMode
    const deposit = inventory?.depositWhen === undefined ? 'capacity' : inventory.depositWhen
    return pickup === 'active' && ['capacity', 'four_layers'].includes(deposit) || pickup === 'passive' && deposit === 'full'
  }
  const scopeOf = s => JSON.stringify([s?.profile ?? null, s?.realm?.id ?? s?.realmId ?? null, s?.dimension ?? null, s?.connectionId ?? null, s?.startedAt ?? null])
  const lifeOf = s => s?.lifecycle?.deathId ?? s?.deathId ?? 0

  async function applyStorageConfiguration () {
    const pending = job?.pendingStorageConfiguration
    if (!pending || job.portableStorage || job.supplyRestock) return false
    const prior = storageSettings(), owner = job
    job.config.inventory.pickupMode = pending.pickupMode
    job.config.inventory.depositWhen = pending.depositWhen
    delete job.pendingStorageConfiguration
    try { await save('storage_configuration_applied') } catch (error) {
      if (job === owner) {
        Object.assign(job.config.inventory, prior)
        job.pendingStorageConfiguration ??= pending
      }
      throw error
    }
    note('storage_configuration_applied', { ...storageSettings() })
    return true
  }

  function recordPassivePickup (why) {
    if (!passivePickup()) return
    const ground = pendingDrops.filter(drop => !isShulkerBox(drop.name)).map(drop => ({ runtimeId: String(drop.runtimeId), name: drop.name ?? null, count: drop.count ?? null, position: copy(drop.position) }))
    job.passivePickup = { observedAt: new Date(now()).toISOString(), reason: why, pickupCompleted: ground.length ? false : null, remainingGroundDropCount: ground.length, remainingGroundDrops: ground.slice(0, 100), inventoryOnly: true }
  }

  function recordUnverifiedDrop (drop, reason) {
    if (!fourLayerStorage()) return
    const id=String(drop.runtimeId), missing=job.unverifiedDrops ??= []
    if (missing.some(entry=>entry.runtimeId===id)) return
    const entry={runtimeId:id,name:drop.name??null,count:drop.count??null,position:copy(drop.position??null),reason,at:new Date(now()).toISOString()}
    if(missing.length<200) missing.push(entry)
    note('pickup_unverified',entry)
  }
  const pickedLedger = () => {
    const d=ledger.export(),picked={}
    for(const section of ['picked','loot'])for(const [n,count] of Object.entries(d[section]??{})) picked[n]=(picked[n]??0)+count
    return picked
  }

  function recordFinalStorageSkip (inventory) {
    job.finalStorageSkipped = { reason: 'POLICY_FULL_ONLY', observedAt: new Date(now()).toISOString(), freeSlots: freeSlots(inventory), carriedDeposits: copy(keepPlan(inventory, inventoryPolicy()).deposits) }
    note('final_storage_skipped', { reason: 'POLICY_FULL_ONLY', freeSlots: freeSlots(inventory), stacks: job.finalStorageSkipped.carriedDeposits.length })
  }

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
    const owner = job
    owner.records = planner?.exportRecords() ?? owner.records
    owner.ledger = ledger.export()
    const savedAt = new Date(now()).toISOString()
    const document = copy({ ...owner, savedAt, persistence: { status: 'saved', savedAt }, events: events.slice(-50) })
    savesInFlight++
    const write = saveChain.then(() => storage.save(owner.config.jobId, document))
    saveChain = write.catch(() => {})
    try {
      const receipt = await write
      if (job === owner) { owner.savedAt = savedAt; owner.persistence = { status: 'saved', savedAt, ...(receipt ?? {}) } }
      return true
    } catch (error) {
      if (job === owner) owner.persistence = { status: 'failed', why, error: String(error.message ?? error).slice(0, 300), failedAt: new Date(now()).toISOString(), lastSavedAt: owner.savedAt ?? null }
      note('persistence_failed', { why, error: String(error.message ?? error) })
      throw new QuarryInterrupt('PERSISTENCE_FAILED', 'Checkpoint could not be saved; new breaking stops (§15.2)')
    } finally { savesInFlight-- }
  }
  async function retryPersistence () {
    requireDrained()
    if (!job || job.state !== 'PAUSED') throw new Error('Persistence retry requires a paused job')
    clearAutoResume()
    job.userRunIntent = 'paused'
    job.pauseReason = 'MANUAL_PAUSE'
    job.result = { type: 'PAUSED', reason: 'MANUAL_PAUSE', at: new Date(now()).toISOString() }
    try { await save('manual_persistence_retry') } catch (error) { job.pauseReason = 'PERSISTENCE_FAILED'; job.result.reason = job.pauseReason; throw error }
    return status()
  }

  function planningBlocks (config) {
    const protectedBoxes = config.permissions?.protectedRegion ?? []
    return (x, y, z) => {
      const block = adapter.getBlock(x, y, z)
      if (block?.known !== true || block.protected || block.protectionSource) return block
      const permanent = protectedBoxes.find(b => x >= b.xMin && x <= b.xMax && y >= b.yMin && y <= b.yMax && z >= b.zMin && z <= b.zMax)
      const temporary = job?.portableStorage?.checkpoint?.placed?.some(c => c.position?.x === x && c.position?.z === z && (c.position.y === y || c.position.y - 1 === y))
      return permanent || temporary ? { ...block, protected: true, protectionSource: permanent?.source === 'home_station' ? 'home_station' : 'quarry_storage' } : block
    }
  }

  function rebuildPlanner () {
    const records = planner?.exportRecords() ?? job.records ?? {}
    regions = makeRegions(job.config, job.yTop, adapter.getState())
    planner = createQuarryPlanner({ regions, getBlock: planningBlocks(job.config), config: job.config.strategy, records, exit: job.config.exit })
    countsRevision++
  }

  // ---- planning (no world changes, §4.1 plan) ---------------------------
  function buildTravel (config, regs, state) {
    if (Array.isArray(config.permissions.travelRegion)) return config.permissions.travelRegion
    // Default: the job's columns grown by 2, plus the storage and the bot's
    // current place, from the job bottom to a few blocks above its top.
    const xs = []; const zs = []; const ys = []; const lows = [regs.yBottom]
    for (const chunk of regs.chunks) { const b = chunkBounds(chunk); xs.push(b.xMin - 2, b.xMax + 2); zs.push(b.zMin - 2, b.zMax + 2) }
    for (const s of config.inventory.storage ?? []) if (s?.position) { xs.push(s.position.x - 3, s.position.x + 3); zs.push(s.position.z - 3, s.position.z + 3); ys.push(s.position.y + 4, s.position.y - 2); lows.push(s.position.y - 2) }
    // The final chest is a bounded surface endpoint, not an intermediate
    // quarry storage target. Its floor and interaction stand must stay routed.
    for (const point of [config.homeChest?.position,config.homeChest?.other,config.homeChest?.stand]) if (point) {
      xs.push(point.x - 2,point.x + 2);zs.push(point.z - 2,point.z + 2)
      ys.push(point.y + 3,point.y - 2);lows.push(point.y - 2)
    }
    // The bot's own place may lie below the job bottom (lower ground beside
    // the area), so the region reaches down to it as well.
    if (state?.position) { const f = feetCell(state); xs.push(f.x - 2, f.x + 2); zs.push(f.z - 2, f.z + 2); ys.push(f.y + 4, f.y - 2); lows.push(f.y - 2) }
    const top = Math.min(regs.worldMaxY, Math.max(...ys, (regs.yTop ?? regs.worldMaxY - 4) + 4))
    return [{ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.max(regs.worldMinY, Math.min(...lows)), yMax: top, zMin: Math.min(...zs), zMax: Math.max(...zs) }]
  }
  // Air below the surface inside the target columns. The surface of a column
  // is its highest non-air block at or under yTop; air under it is cave.
  function surveyCaves (regs, yTop, read) {
    let air = 0, known = 0, unknown = 0, longestRun = 0
    for (const col of regs.columns) {
      const [x, z] = col.split(',').map(Number)
      let surface = null, run = 0
      for (let y = yTop; y >= regs.yBottom; y--) {
        const b = read(x, y, z)
        if (b?.known !== true) { unknown++; run = 0; continue }
        const isAir = AIR.has(nameOf(b))
        if (surface === null) { if (!isAir) surface = y; continue }
        known++
        if (isAir) { air++; run++; longestRun = Math.max(longestRun, run) } else run = 0
      }
    }
    const ratio = known ? Math.round(air / known * 1000) / 1000 : 0
    const unknownRatio = known + unknown ? Math.round(unknown / (known + unknown) * 1000) / 1000 : 0
    return { air, known, unknown, ratio, unknownRatio, longestRun, high: ratio > CAVE_RATIO || longestRun >= CAVE_RUN }
  }

  function planExitPreview (config, regs, yTop, state, inv) {
    const read = planningBlocks(config); let unknown = false
    const result = planQuarryExit({ regions: regs, yTop, feet: feetCell(state), getBlock: (x, y, z) => { const b = read(x, y, z); if (b?.known !== true) unknown = true; return b }, inventory: inv, policy: { ...config.tools, ...config.collection }, exit: config.exit, preflight: true })
    const d = result.details ?? {}
    return { ready: result.ok === true, reason: result.ok ? null : result.reason ?? 'EXIT_PREFLIGHT_FAILED', unknown: !result.ok && unknown, predictionOnly: true, side: result.plan?.side ?? null, column: copy(result.plan?.column ?? null), counts: copy(d.counts ?? null), cause: d.cause ?? null }
  }
  // Deepest bottom (8-block steps, at most 24 tries) whose exit plan succeeds on received terrain.
  function suggestExitBottom (config, yTop, state, inv, fromY) {
    for (let y = fromY + 8, tries = 0; y <= yTop - 8 && tries < 24; y += 8, tries++) {
      const trial = { ...config, yBottom: y }
      const r = planExitPreview(trial, makeRegions(trial, yTop, state), yTop, state, inv)
      if (r.ready) return y
    }
    return null
  }

  function makeRegions (config, yTop, state) {
    const base = { target: config.target, yTop, yBottom: config.yBottom, worldMinY: config.worldMinY, worldMaxY: config.worldMaxY, boundarySeal: config.boundarySeal, infrastructureRegion: config.permissions.infrastructureRegion, protectedRegion: config.permissions.protectedRegion }
    const first = buildRegions({ ...base, travelRegion: [] })
    const result = buildRegions({ ...base, travelRegion: buildTravel(config, { ...first, yTop }, state) })
    if (job?.config === config && job.exitReservation?.plan) result.exitReservation = job.exitReservation.plan
    return result
  }

  function plan (input) {
    requireDrained()
    if (job && ACTIVE.has(job.state)) throw new Error('A quarry job is running; pause or cancel it first')
    clearAutoResume()
    const config = defaults(input)
    // Only new production shulker plans adopt v2.2 by default. Persisted
    // legacy jobs keep their explicit policy and require deliberate migration.
    if (shulkerOnly && input.inventory?.pickupMode == null && input.inventory?.depositWhen == null) {
      config.inventory.pickupMode = 'active'
      config.inventory.depositWhen = 'four_layers'
      if (input.inventory?.minFreeSlots == null) config.inventory.minFreeSlots = 3
    }
    if (shulkerOnly && config.inventory.depositWhen === 'four_layers') {
      config.boundarySeal = { ...config.boundarySeal, enabled: true, horizontalMargin: 1, sourceOnly: true, material: 'dirt', closeOpenings: false }
      config.strategy.dirtFromSupplyAtExit = true
    }
    const state = adapter.getState()
    const issues = []; const warnings = []
    if (![null, 'v22'].includes(config.initialLoadout)) issues.push('INVALID_INITIAL_LOADOUT')
    if (config.initialLoadout === 'v22') config.inventory.supplyLayout = 'v22'
    if (config.inventory.supplyLayout != null && config.inventory.supplyLayout !== 'v22') issues.push('INVALID_SUPPLY_LAYOUT')
    const initialLoadout = config.initialLoadout === 'v22'
    if (initialLoadout) {
      config.strategy.dirtFromSupplyAtExit = true
      if (input.inventory?.minFreeSlots == null) config.inventory.minFreeSlots = 3
    }
    const pendingLoadout = initialLoadout && loadoutPorts() && configuredLoadoutHome(config) && emptyLoadoutInventory(state)
    if (initialLoadout) {
      if (!configuredLoadoutHome(config)) issues.push('LOADOUT_CHEST_NOT_CONFIGURED')
      if (!loadoutPorts()) issues.push('V22_RUNTIME_UNAVAILABLE')
      if (!emptyLoadoutInventory(state)) issues.push('LOADOUT_START_INVENTORY_NOT_EMPTY')
      if (pendingLoadout) warnings.push({ code: 'INITIAL_LOADOUT_ON_START' })
    }
    if (!worldIdentity(state)) issues.push('WORLD_IDENTITY_UNKNOWN')
    if (config.inventory.pickupMode !== undefined && !['active', 'passive'].includes(config.inventory.pickupMode)) issues.push('INVALID_PICKUP_MODE')
    if (config.inventory.depositWhen !== undefined && !['capacity', 'full', 'four_layers'].includes(config.inventory.depositWhen)) issues.push('INVALID_DEPOSIT_POLICY')
    if (!validStoragePair(config.inventory)) issues.push('UNSUPPORTED_STORAGE_POLICY')
    if (shulkerOnly && config.inventory.storage?.length) issues.push('SHULKER_ONLY_STORAGE')
    if (config.inventory.depositWhen === 'four_layers' || initialLoadout) {
      const chest = config.homeChest
      if (!initialLoadout && chest?.chunk && Array.isArray(config.target?.chunks) && !config.target.chunks.some(c=>c.x===chest.chunk.x&&c.z===chest.chunk.z)) issues.push('LOADOUT_TARGET_CHUNK_MISMATCH')
      if (!chest || !['position', 'other', 'stand'].every(part=>chest[part] && ['x','y','z'].every(axis=>Number.isSafeInteger(chest[part][axis])))) issues.push('LOADOUT_CHEST_NOT_CONFIGURED')
      if (!initialLoadout && (typeof adapter.loadoutWithdraw !== 'function' || typeof adapter.finalChestDeposit !== 'function' || typeof adapter.equipmentTransfer !== 'function')) issues.push('V22_RUNTIME_UNAVAILABLE')
      if (chest?.position && chest?.other && chest?.stand) {
        // A fixed surface station survives excavation and retains its own
        // interaction floor. Everything else in the chunk remains mineable.
        config.permissions.protectedRegion ??= []
        for (const p of [chest.position, chest.other, {...chest.position,y:chest.position.y-1},
          {...chest.other,y:chest.other.y-1}, {...chest.stand,y:chest.stand.y-1}]) {
          if (!p || !['x','y','z'].every(axis=>Number.isSafeInteger(p[axis])))continue
          const exists=config.permissions.protectedRegion.some(box=>
            box.source==='home_station' && box.xMin===p.x && box.yMin===p.y && box.zMin===p.z)
          if(!exists)config.permissions.protectedRegion.push({xMin:p.x,xMax:p.x,yMin:p.y,yMax:p.y,zMin:p.z,zMax:p.z,source:'home_station'})
        }
      }
    }
    if (shulkerOnly && !config.inventory.supplyBoxes?.length && !(config.inventory.depositWhen === 'four_layers' && config.homeChest) && !pendingLoadout) {
      const discovered = adapter.discoverSupplies?.(v22SupplyLayout(config) ? 'v22' : 'legacy')
      if (discovered?.ok) { config.inventory.supplyBoxes = copy(discovered.bindings); config.inventory.autoSupplies = true }
    }
    if (config.inventory.autoSupplies && !config.inventory.supplyBoxes?.length && !(config.inventory.depositWhen === 'four_layers' && config.homeChest) && !pendingLoadout) {
      const discovered = adapter.discoverSupplies?.(v22SupplyLayout(config) ? 'v22' : 'legacy')
      if (discovered?.ok) config.inventory.supplyBoxes = copy(discovered.bindings)
      else issues.push(discovered?.reason ?? 'SUPPLY_BOXES_UNCONFIRMED')
    }
    if (config.inventory.supplyBoxes?.length && (!validSupplyBindings(config.inventory.supplyBoxes, config.inventory) || typeof adapter.restockSupplies !== 'function')) issues.push('SUPPLY_BINDINGS_INVALID')
    if (state?.phase !== 'spawned' || state.dead) issues.push('NOT_SPAWNED')
    if (state?.gameMode !== 'survival' && state?.gameMode !== 0) issues.push('NOT_SURVIVAL')
    if (state?.dimension && state.dimension !== config.dimension.replace(/^minecraft:/, '')) issues.push('WRONG_DIMENSION')
    let regs = makeRegions(config, Number.isSafeInteger(config.yTop) ? config.yTop : null, state)
    const p = createQuarryPlanner({ regions: regs, getBlock: planningBlocks(config), config: config.strategy, exit: config.exit })
    let yTop = Number.isSafeInteger(config.yTop) ? config.yTop : null
    let unknownAbove = 0
    if (yTop === null) { const s = p.surveyTop(); yTop = s.yTop; unknownAbove = s.unknownAbove }
    if (config.inventory.depositWhen === 'four_layers' || initialLoadout) {
      if (Number.isSafeInteger(yTop)) yTop = Math.min(yTop, 75)
      // The upper bound is clamped; terrain above it is outside the quarry.
    }
    if (yTop === null) issues.push('Y_TOP_UNKNOWN')
    if (unknownAbove) warnings.push({ code: 'Y_TOP_PROVISIONAL', unknownCells: unknownAbove })
    if (yTop !== null) regs = makeRegions(config, yTop, state)
    const inv = items(state)
    if (!inv) issues.push('INVENTORY_UNKNOWN')
    const storageList = config.inventory.storage ?? []
    if ((shulkerOnly || !storageList.length && config.inventory.carryOnly !== true) && !pendingLoadout && !(config.inventory.depositWhen === 'four_layers' && config.homeChest && !inv?.length || typeof adapter.storeCarried === 'function' && cargoSelection(inv, { excludedShulkerKeys: storageSupplyExclusions(config.inventory.supplyBoxes) }))) issues.push(shulkerOnly ? 'NO_CARGO_SHULKER' : 'NO_STORAGE_REGISTERED')
    for (const s of storageList) {
      const b = s?.position ? adapter.getBlock(s.position.x, s.position.y, s.position.z) : null
      if (!b?.known || !/chest|barrel/.test(nameOf(b))) issues.push(`STORAGE_NOT_OBSERVED:${JSON.stringify(s?.position ?? null)}`)
      else if (permits(regs, 'break', s.position).allowed) issues.push('STORAGE_INSIDE_EXCAVATION')
    }
    if (inv && !pendingLoadout && !(config.inventory.depositWhen === 'four_layers' && config.homeChest && !inv.length)) {
      const picks = inv.filter(i => /_pickaxe$/.test(nameOf(i)))
      if (!picks.length) warnings.push({ code: 'NO_PICKAXE', note: 'Stone and ores will wait for a tool' })
      if (!inv.some(i => isFood(i.name))) warnings.push({ code: 'NO_FOOD' })
      if (!inv.some(i => /cobblestone|cobbled_deepslate|^dirt$|^stone$/.test(nameOf(i)))) warnings.push({ code: 'NO_SEAL_MATERIAL', note: 'Water/lava and stair repairs will pause' })
    }
    const pl = createQuarryPlanner({ regions: regs, getBlock: planningBlocks(config), config: config.strategy, exit: config.exit })
    let stair = null; let counts = null; let survey = null
    if (yTop !== null) {
      const entry = storageList[0]?.position ?? (state?.position ? feetCell(state) : null)
      stair = pl.planStair({ entry, yTop })
      if (!stair && config.exit.mode === 'legacy_stair') issues.push('STAIR_START_UNKNOWN')
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
    // Exit check at plan time (prediction only, no world change): the same
    // planner the job runs before excavation. A target whose received terrain
    // leaves no exit column is refused here instead of after start; unknown
    // terrain only warns. A shallower bottom that would work is suggested.
    let exitPreflight = null
    if (yTop !== null && inv && state?.position && config.exit?.mode === 'adjacent_pillar' && typeof adapter.egress === 'function' && config.inventory.depositWhen !== 'four_layers' && !pendingLoadout) {
      exitPreflight = planExitPreview(config, regs, yTop, state, inv)
      if (!exitPreflight.ready) {
        if (exitPreflight.reason === 'EXIT_COLUMN_UNAVAILABLE' && !exitPreflight.unknown) {
          issues.push('PLAN_EXIT_UNAVAILABLE')
          exitPreflight.suggestedBottom = suggestExitBottom(config, yTop, state, inv, regs.yBottom)
        } else warnings.push({ code: exitPreflight.unknown ? 'EXIT_PREFLIGHT_PROVISIONAL' : 'EXIT_PREFLIGHT_' + String(exitPreflight.reason ?? 'FAILED').replace(/^EXIT_/, ''), reason: exitPreflight.reason })
      }
    }
    // Cave check at plan time (received blocks only): open air below the
    // surface inside the box is a cave the layer-by-layer digging cannot cross
    // (live 2026-11-10: chunk (-2,0) was a 40-deep cave from Y21). A large cave
    // refuses the plan unless allowCaves is set; unknown cells only warn.
    let caveSurvey = null
    if (yTop !== null) {
      caveSurvey = surveyCaves(regs, yTop, planningBlocks(config))
      if (caveSurvey.high) {
        if (config.allowCaves) warnings.push({ code: 'CAVE_VOLUME_HIGH', ratio: caveSurvey.ratio, longestRun: caveSurvey.longestRun, overridden: true })
        else issues.push('CAVE_VOLUME_HIGH')
      } else if (caveSurvey.unknownRatio > CAVE_UNKNOWN_RATIO) warnings.push({ code: 'CAVE_VOLUME_PROVISIONAL', unknownRatio: caveSurvey.unknownRatio })
    }
    const sealCells = regs.seal.ready ? regs.seal.columns.size * (regs.seal.yMax - regs.seal.yMin + 1) : 0
    const summary = { ready: issues.length === 0, issues, warnings, jobId: config.jobId, chunks: regs.chunks, yTop, yTopProvisional: unknownAbove > 0, yBottom: regs.yBottom, columns: regs.columns.size, counts, survey, stair, exitPreflight, caveSurvey, boundarySeal: { enabled: regs.seal.enabled, ready: regs.seal.ready, columns: regs.seal.columns.size, yMin: regs.seal.yMin, yMax: regs.seal.yMax, cells: sealCells, placementOnly: true }, travelRegion: regs.travel, storage: storageList,
      ...(pendingLoadout ? { initialLoadout: { mode: 'v22', pending: true, serverConfirmed: false, position: copy(config.homeChest.position) } } : {}) }
    job = { config, instanceId: randomUUID(), world: worldIdentity(state), actionSequence: 0, state: 'IDLE', planned: summary, yTop, cursorY: yTop, deepestY: yTop, records: { stair }, ledger: {}, userRunIntent: 'idle', result: null, pauseReason: null, interruption: null, checkpoint: null, actions: [], deaths: [], startedAt: null, scope: null, life: null }
    regions = regs; planner = pl; ledger = createLedger()
    return copy(summary)
  }

  // ---- adapter helpers ---------------------------------------------------
  function guard (myEpoch, { combat = true } = {}) {
    if (myEpoch !== epoch) throw new QuarryInterrupt('EPOCH_CHANGED')
    assertStoragePolicy()
    if (job.userRunIntent !== 'running') throw new QuarryInterrupt('STOP_REQUESTED')
    if (abort?.signal.aborted) throw new QuarryInterrupt(abort.signal.reason?.code ?? 'ABORTED')
    const s = adapter.getState()
    try { assertJobWorld(job, s) } catch (error) { throw new QuarryInterrupt(error.code ?? 'WORLD_MISMATCH') }
    if (job.persistence?.status === 'failed') throw new QuarryInterrupt('PERSISTENCE_FAILED')
    if (s?.dead || s?.isDead || s?.lifecycle?.dead || s?.health === 0 || s?.phase !== 'spawned') throw new QuarryInterrupt(s?.dead || s?.isDead || s?.lifecycle?.dead || s?.health === 0 ? 'DEAD' : 'DISCONNECTED')
    if (job.scope && scopeOf(s) !== job.scope) throw new QuarryInterrupt(lifeOf(s) !== job.life ? 'DEAD' : 'DISCONNECTED')
    if (job.life != null && lifeOf(s) !== job.life) throw new QuarryInterrupt('DEAD')
    if (combat && job.config.quarryCombat.enabled && adapter.combatActive()) throw new QuarryInterrupt('COMBAT')
    return s
  }
  // Runs one adapter call while watching for combat/stop every pollMs.
  async function call (myEpoch, label, fn, { drain = false } = {}) {
    guard(myEpoch)
    const local = new AbortController()
    let watcher
    const watch = new Promise((resolve, reject) => {
      watcher = setInterval(() => { try { guard(myEpoch) } catch (error) { local.abort(error); reject(error) } }, pollMs)
    })
    const task = Promise.resolve().then(() => { guard(myEpoch); return fn(local.signal) })
    pendingActions.add(task)
    void task.then(() => pendingActions.delete(task), () => pendingActions.delete(task))
    try { return await Promise.race([task, watch]) } catch (error) {
      if (drain) {
        local.abort(error)
        try { error.drainedResult = await task } catch (childError) { if (childError !== error) error.drainedError = childError }
      }
      throw error
    } finally { clearInterval(watcher) }
  }
  function recordAction (action) {
    const sequence = job.actionSequence = (job.actionSequence ?? 0) + 1
    const rec = { id: `${job.config.jobId}:${sequence}:${randomUUID()}`, sequence, epoch, at: new Date(now()).toISOString(), status: 'intent', ...copy(action) }
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
    if (code === 'STOP_REQUESTED' || code === 'EPOCH_CHANGED') return
    // Combat already revoked this work's input. A late stopAll here would
    // cancel the new combat owner's movement instead of the old quarry task.
    if (code === 'COMBAT') return suspendForCombat()
    try { await adapter.stopAll(`quarry:${code}`) } catch {}
    if (code === 'DEAD') { const s = adapter.getState(); job.deaths.push({ at: new Date(now()).toISOString(), position: copy(s?.position ?? job.checkpoint?.position ?? null), cause: s?.deathCause ?? null, unrecovered: copy(pendingDrops) }); return finish('PAUSED', 'DEATH') }
    if (code === 'DISCONNECTED') { setState('DISCONNECTED'); return }
    // An uncertain jump/place must be reconciled from its own saved receipts;
    // it can never use the ordinary ACTION_FAILED retry or return underground.
    if (job.egress?.operationId && !job.surfaceReturnedAt) return finish('PAUSED', /^EXIT_/.test(code) ? code : 'EXIT_UNCONFIRMED', { pauseDetails: { error: String(error.message ?? code).slice(0, 300), operationId: job.egress.operationId } })
    if (['WORLD_MISMATCH', 'WORLD_IDENTITY_UNKNOWN', 'PERSISTENCE_FAILED', 'STORAGE_UNREACHABLE', 'NO_STORAGE'].includes(code)) return finish('PAUSED', code)
    if (code === 'SUPPLY_APPROACH_ORIGIN_CHANGED') return finish('PAUSED', 'SUPPLY_RESTOCK_BLOCKED', { pauseDetails: { reason: code } })
    if (['SEAL_UNSAFE_STANCE', 'SEAL_MATERIAL_MISSING', 'SEAL_CONTEXT_CHANGED', 'FLUID_SOURCE_CHANGED', 'BOUNDARY_CONTEXT_CHANGED'].includes(code)) return finish('PAUSED', code, { pauseDetails: copy(error.details ?? null) })
    if (/^DROP_/.test(code)) return finish('PAUSED', code, { pauseDetails: copy(error.details ?? { reason: code }) })
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

  function suspendForCombat (details = null) {
    job.miningEquipmentPending = true
    if (job.state === 'COMBAT' || job.state === 'COMBAT_SETTLE') { setState('COMBAT'); return }
    const s = adapter.getState()
    const resumeTo = ['RETURN', 'DEPOSIT', 'RESTOCK', 'FINAL_CHECK', 'EGRESS'].includes(job.state) ? job.state : 'SURVEY'
    epoch++
    job.interruption = job.interruption ?? { at: new Date(now()).toISOString(), phase: job.state, resumeTo, epoch, layer: job.cursorY, pendingDrops: copy(pendingDrops), lastAction: copy(job.actions.at(-1) ?? null) }
    if (details) Object.assign(job.interruption, copy(details))
    combatBridge.interrupt(s, { reason: 'combat_claim', phase: job.state })
    setState('SUSPEND_FOR_COMBAT')
    void save('combat_interruption').catch(() => {})
    setState('COMBAT')
  }

  async function step (myEpoch) {
    const s = adapter.getState()
    switch (job.state) {
      case 'DISCONNECTED': {
        if (s?.phase === 'spawned' && !s.dead) { assertJobWorld(job, s); job.scope = scopeOf(s); job.life = lifeOf(s); setState('RECONCILE') } else await sleep(500)
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
      case 'RESTOCK': return restock(myEpoch, job.supplyRestock?.resumeTo ?? 'SURVEY', true)
      case 'PREFLIGHT': return preflight(myEpoch)
      case 'RECOVER': return recoverHealth(myEpoch)
      case 'RETURN': case 'DEPOSIT': return returnAndDeposit(myEpoch, job.depositReason ?? 'capacity')
      case 'FINAL_CHECK': return finalCheck(myEpoch)
      case 'EGRESS': return egress(myEpoch)
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

  async function prepareExit (myEpoch) {
    if (job.config.exit?.mode !== 'adjacent_pillar' || typeof adapter.egress !== 'function' || job.miningCompletedAt || job.surfaceReturnedAt) return true
    const state = guard(myEpoch), read = planningBlocks(job.config)
    let unknown = false
    const result = planQuarryExit({ regions, yTop: job.yTop, feet: feetCell(state), getBlock: (x, y, z) => { const b = read(x, y, z); if (b?.known !== true) unknown = true; return b }, inventory: items(state), policy: { ...job.config.tools, ...job.config.collection }, exit: job.config.exit, preflight: true, reservation: job.exitReservation?.plan ?? null })
    guard(myEpoch)
    job.exitPreflight = { checkedAt: new Date(now()).toISOString(), layer: job.cursorY, ready: result.ok, reason: result.reason ?? null, details: copy(result.details ?? null), predictionOnly: true }
    if (!result.ok) {
      if (result.reason === 'EXIT_COLUMN_UNAVAILABLE' && unknown && await requestTerrainObservation(myEpoch, 'egress')) return false
      if (result.plan && ['EXIT_MATERIAL_MISSING', 'EXIT_TOOL_MISSING'].includes(result.reason) && job.config.inventory.supplyBoxes?.length) {
        job.config.inventory.keepExitDirt = Math.max(job.config.inventory.keepExitDirt ?? 0, result.plan.totalDirt)
        if (await restock(myEpoch, 'PREFLIGHT', true)) return false
      }
      await finish('PAUSED', result.reason ?? 'EXIT_PREFLIGHT_FAILED', { pauseDetails: { ...copy(result.details ?? {}), stage: 'before_excavation' } })
      return false
    }
    if (!job.exitReservation) job.exitReservation = { plan: copy(result.plan), selectedAt: new Date(now()).toISOString() }
    else job.exitReservation.plan = copy(result.plan)
    job.config.inventory.keepExitDirt = Math.max(job.config.inventory.keepExitDirt ?? 0, result.plan.totalDirt)
    regions.exitReservation = job.exitReservation.plan
    await save('exit_preflight')
    return true
  }

  async function preflight (myEpoch) {
    if (usesV22Loadout() && !job.loadoutReady) {
      const home = job.config.homeChest, owner = job
      if (!home?.position || !home.stand) return finish('PAUSED', 'LOADOUT_CHEST_NOT_CONFIGURED')
      if (job.config.initialLoadout === 'v22' && !configuredLoadoutHome(job.config)) return finish('PAUSED', 'LOADOUT_CHEST_CHANGED')
      if (!job.loadout) {
        job.loadout = { operationId: job.config.jobId + ':loadout:1', checkpoint: null }
        await save('loadout_intent')
      }
      // Reach the surface work stand by ordinary movement. The work area
      // includes the registered start/end station, but this does not authorize
      // excavation outside the target chunk.
      const from = feetCell(guard(myEpoch))
      if (!samePoint(from, home.stand)) await moveToStance(myEpoch, home.stand)
      const active = job.loadout
      const response = await call(myEpoch, 'loadout_withdraw', signal => {
        if (job.config.initialLoadout === 'v22' && (!active.checkpoint || active.checkpoint.index === 0 && active.checkpoint.intent == null)) {
          if (!configuredLoadoutHome(job.config)) return { status: 'blocked', reason: 'LOADOUT_CHEST_CHANGED', serverConfirmed: false }
          if (!emptyLoadoutInventory(guard(myEpoch))) return { status: 'blocked', reason: 'LOADOUT_START_INVENTORY_NOT_EMPTY', serverConfirmed: false }
        }
        return adapter.loadoutWithdraw({
        jobId: job.config.jobId, operationId: active.operationId,
        checkpoint: copy(active.checkpoint), position: copy(home.position)
      }, { signal, onCheckpoint: async cp => {
        if (job !== owner || job.loadout !== active || cp.operationId !== active.operationId) throw new Error('LOADOUT_STALE_CHECKPOINT')
        active.checkpoint = copy(cp); await save('loadout_checkpoint')
      }}) }, { drain: true })
      guard(myEpoch)
      if (response?.status !== 'completed' || response.serverConfirmed !== true) {
        return finish('PAUSED', response?.reason ?? 'LOADOUT_WITHDRAW_BLOCKED', { pauseDetails: { details: response?.details ?? null, operationId: active.operationId } })
      }
      const discovered = adapter.discoverSupplies?.('v22')
      if (!discovered?.ok || !validSupplyBindings(discovered.bindings, 'four_layers')) {
        return finish('PAUSED', discovered?.reason ?? 'V22_SUPPLIES_UNKNOWN')
      }
      if (job.config.initialLoadout === 'v22' && !completedV22Loadout(false)) return finish('PAUSED', 'LOADOUT_RECEIPTS_UNCONFIRMED')
      job.config.inventory.supplyBoxes = copy(discovered.bindings)
      job.config.inventory.autoSupplies = true
      job.loadoutReady = true
      await save('loadout_received')
    }
    if (job.config.initialLoadout === 'v22' && !completedV22Loadout()) return finish('PAUSED', 'LOADOUT_RECEIPTS_UNCONFIRMED')
    const s = guard(myEpoch)
    if (!items(s)) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    job.scope = scopeOf(s); job.life = lifeOf(s)
    lastInventory = totals(items(s))
    if (!Object.keys(ledger.export().startInventory).length) for (const [n, c] of lastInventory) ledger.add('startInventory', n, c)
    combatBridge.activate({ jobId: job.config.jobId, epoch, travel: p => permits(regions, 'travel', p).allowed })
    await save('start')
    if (job.config.initialLoadout === 'v22' && job.pendingTotemEquip && await ensureTotem(myEpoch)) return
    // A passive/full job needs actual tools and reserved dirt from its received
    // supply boxes before the ordinary exit preflight can judge readiness.
    if (job.config.initialLoadout === 'v22' && await restock(myEpoch, 'PREFLIGHT', true)) return
    if (job.config.initialLoadout === 'v22') {
      if (!completedV22Loadout()) return finish('PAUSED', 'LOADOUT_RECEIPTS_UNCONFIRMED')
      if (await ensureTotem(myEpoch)) return
      if (!(await verifyExitSupplyStock(myEpoch))) return
    }
    if (!deferredExitSupplies() && !(await prepareExit(myEpoch))) return
    if (fourLayerStorage()) { setState('SURVEY'); return }
    if (job.config.initialLoadout !== 'v22' && await restock(myEpoch, 'SURVEY', true)) return
    setState('SURVEY')
  }

  // After a pause the bot may have been moved (knockback, a fall, a debug
  // teleport) without the server sending its position. When the pose moved
  // more than a few blocks since the pause, ask the server (/testfor around the
  // current pose) before acting; outside the target, walk back in first.
  // The received raw position is never overwritten.
  async function confirmPoseAfterPause (myEpoch) {
    const before = job.pauseFeet; job.pauseFeet = null
    const s = guard(myEpoch); if (!before || !s?.position) return true
    const f = feetCell(s), moved = Math.hypot(f.x - before.x, f.y - before.y, f.z - before.z)
    if (moved <= POSE_MOVE_LIMIT || typeof adapter.confirmPosition !== 'function') return true
    const probe = { x: s.position.x, y: s.position.y - 1.62, z: s.position.z }
    const receipt = await call(myEpoch, 'confirm_position', signal => adapter.confirmPosition(probe, { signal, radius: POSE_CONFIRM_RADIUS, operationId: `${job.config.jobId}:pose` }))
    guard(myEpoch)
    if (receipt?.serverConfirmed !== true) { job.pauseFeet = before; await finish('PAUSED', 'POSITION_UNCONFIRMED', { pauseDetails: { cause: receipt?.reason ?? 'NO_RECEIPT', moved: Math.round(moved * 10) / 10, before, probe } }); return false }
    note('pose_confirmed', { moved: Math.round(moved * 10) / 10, before, feet: f })
    if (!regions.columns.has(`${f.x},${f.z}`)) {
      const entered = await enterQuarryForSupply(myEpoch, f)
      if (!entered.ok) { job.pauseFeet = before; await finish('PAUSED', 'POSITION_UNCONFIRMED', { pauseDetails: { cause: 'OUTSIDE_TARGET_UNREACHABLE', feet: f, ...entered.details } }); return false }
      note('pose_returned', { from: f, to: entered.stand })
    }
    return true
  }

  async function reconcile (myEpoch) {
    const s = guard(myEpoch)
    // The same-scope request budget is kept across a resume, but one spent long
    // ago (e.g. at the job start) is renewed: subchunks far above are dropped
    // as the bot digs down and must be requested again.
    const obs = job.terrainObservation
    if (obs && obs.requests && !obs.waiting && Number.isFinite(obs.requestedAt) && now() - obs.requestedAt > TERRAIN_BUDGET_RENEW_MS) { obs.requests = 0; obs.phase = 'idle' }
    if (!(await confirmPoseAfterPause(myEpoch))) return
    if (job.supplyRestock) { job.supplyRestock.resumeTo = 'RECONCILE'; return restock(myEpoch, 'RECONCILE', true) }
    if (job.config.initialLoadout === 'v22' && job.pendingTotemEquip && await ensureTotem(myEpoch)) return
    // Re-observe instead of trusting saved cells (§15.3): unreachable and
    // tool deferrals are retried; protected/unbreakable stay.
    // MINING_FAILED (and the falling-block chains it holds up) were transient
    // refusals in practice (pose not settled, face not visible from one stance):
    // retry them on every reconcile instead of leaving them unmined for good.
    // Work resumes at the deepest layer reached. Finished layers above are not
    // revisited: their remaining cells stay recorded (EARLIER_LAYER_LEFTOVER)
    // and transient deferrals are only retried from the current layer down.
    if (!items(s)) { await sleep(500); return }
    if (job.surfaceReturnedAt) { setState('FINAL_CHECK'); return }
    // A completion reached only by writing off the lower layers as UNREACHABLE
    // (live 2026-11-10: bot cut off on a pillar above a cave) is reopened while
    // the egress has not started; those cells are retried from the current layer.
    if (job.miningCompletedAt && !job.surfaceReturnedAt && (!job.egress || job.egress.phase === 'blocked' && !job.egress.checkpoint)) {
      const writtenOff = planner.deferredList().filter(d => d.reason === 'UNREACHABLE' && Number(String(d.position).split(',')[1]) < job.cursorY).length
      if (writtenOff >= REOPEN_UNREACHABLE) {
        note('false_completion_reopened', { writtenOff, cursorY: job.cursorY, completedAt: job.miningCompletedAt })
        job.miningCompletedAt = null; job.egress = null; job.finalSweepDone = false; job.finalCounts = null
      }
    }
    if (job.miningCompletedAt && job.config.exit?.mode === 'adjacent_pillar') { setState('EGRESS'); return }
    if (job.config.initialLoadout === 'v22' && !(await verifyExitSupplyStock(myEpoch))) return
    if (!deferredExitSupplies() && !(await prepareExit(myEpoch))) return
    const floorY = workFloorY()
    clearWorkDeferred([...TRANSIENT_DEFER, ...TOOL_WAIT])
    badStances.clear()
    lastInventory = totals(items(s))
    keepEarlierLayers(floorY)
    job.cursorY = floorY
    if (Number.isSafeInteger(job.lastMineY) && job.lastMineY > floorY) job.lastMineY = floorY
    job.retry = 0; job.miningExhaustedTried = false // a resume may try the exhausted-tool restock again
    if (job.supplyRestock) job.supplyRestock.roomAttempts = 0
    combatBridge.activate({ jobId: job.config.jobId, epoch, travel: p => permits(regions, 'travel', p).allowed })
    setState('SURVEY')
  }

  // Deepest layer the job has worked (tracked from confirmed mining; for older
  // documents estimated as the lowest layer that is mostly dug out).
  function workFloorY () {
    const bounded = y => Math.max(regions.yBottom, Math.min(job.yTop, y))
    if (Number.isSafeInteger(job.deepestY)) return (job.deepestY = bounded(job.deepestY))
    // Preserve a legacy document's work cursor, but never infer progress from
    // unknown cells or scan beyond this job's configured lower bound.
    let floor = bounded(Number.isSafeInteger(job.cursorY) ? job.cursorY : job.yTop)
    for (let y = floor; y >= regions.yBottom; y--) {
      const l = planner.layerSummary(y, {})
      if (l.unknown || l.pending.length + l.deferred + l.reserved + l.blocked.length + l.fluid.length >= 200) break
      floor = y
    }
    job.deepestY = floor
    return floor
  }

  // Every retry is limited to the active work floor and the layers below it.
  // The full job region stays intact for storage travel and final verification.
  function clearWorkDeferred (reasons, onlyY = null) {
    const floorY = workFloorY(); const before = planner.deferredList().length
    planner.clearDeferred(reasons, k => { const y = Number(k.split(',')[1]); return y > floorY || onlyY !== null && y !== onlyY })
    return before - planner.deferredList().length
  }

  function keepEarlierLayers (floorY) {
    if (!(floorY < job.yTop)) return
    let kept = 0
    const keep = p => {
      const c = planner.cellStatus(p)
      if (['done', 'reserved', 'unknown'].includes(c.status) || c.reason === 'EARLIER_LAYER_LEFTOVER') return
      // Preserve protection/unbreakable reasons and their existing acceptance
      // policy; only retryable work turns into an earlier-layer exception.
      if (c.status === 'deferred' && !TRANSIENT_DEFER.includes(c.reason) && !TOOL_WAIT.has(c.reason)) return
      if (c.status === 'blocked' && c.reason && !TOOL_WAIT.has(c.reason)) planner.defer(p, c.reason)
      else planner.defer(p, 'EARLIER_LAYER_LEFTOVER', { previousReason: c.reason ?? c.status })
      kept++
    }
    for (const d of planner.deferredList()) {
      const [x, y, z] = d.position.split(',').map(Number)
      if (y > floorY) keep({ x, y, z })
    }
    for (let y = job.yTop; y > floorY; y--) {
      const layer = planner.layerSummary(y, {})
      for (const c of [...layer.pending, ...layer.blocked, ...layer.fluid]) keep(c.position)
    }
    if (kept) note('earlier_layer_leftovers', { count: kept, above: floorY })
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
    clearWorkDeferred(['UNREACHABLE'])
    job.cursorY = workFloorY()
    combatBridge.resumed()
    job.interruption = null
    epoch++
    note('combat_resume', { to: back })
    setState(back === 'EGRESS' || job.miningCompletedAt && !job.surfaceReturnedAt ? 'EGRESS' : back === 'FINAL_CHECK' ? 'FINAL_CHECK' : back === 'RETURN' || back === 'DEPOSIT' ? 'RETURN' : 'SURVEY')
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
      if (fullOnlyStorage()) setState('RECOVER')
      return
    }
    if (r >= job.config.safety.resumeHealthRatio && (foodOf(s) ?? 20) >= 18) { job.recoverWaitSince = null; job.emergencyReturned = false; setState('SURVEY'); return }
    if (await tryEat(myEpoch, true)) return
    job.recoverWaitSince ??= now()
    if (now() - job.recoverWaitSince > job.config.safety.recoverTimeoutMs) { job.recoverWaitSince = null; return finish('PAUSED', 'HEALTH_NOT_RECOVERING') }
    await sleep(500)
  }

  // Four layers are a durable collection barrier. Transfer checkpoints are
  // reconciled by normal portable storage before this barrier can complete.
  async function continueLayerCollection (myEpoch) {
    const op = job.layerCollection
    if (!op || !fourLayerStorage()) return false
    guard(myEpoch)
    if (op.phase === 'collect') {
      observeDrops()
      await collect(myEpoch, 'four_layers')
      if (job.state === 'RETURN' || job.state === 'PAUSED') return true
      const ground = adapter.entities().filter(e => e.kind === 'item' && e.position &&
        regions.columns.has(Math.floor(e.position.x) + ',' + Math.floor(e.position.z)) &&
        e.position.y <= job.yTop + 1 && e.position.y >= regions.yBottom - 2)
      if (job.unverifiedDrops?.length) {
        return finish('PAUSED','FOUR_LAYER_PICKUP_UNVERIFIED',{pauseDetails:{floorY:op.floorY,examples:job.unverifiedDrops.slice(0,20)}})
      }
      if (pendingDrops.length || ground.length) {
        return finish('PAUSED', 'FOUR_LAYER_DROPS_UNRESOLVED', { pauseDetails: {
          floorY: op.floorY, pending: pendingDrops.length, visible: ground.length,
          examples: ground.slice(0, 8).map(e => ({ name: e.name, position: copy(e.position) }))
        } })
      }
      op.phase = 'deposit'
      await save('four_layer_pickup_completed')
      return true
    }
    if (op.phase === 'deposit') {
      const inventory = items(guard(myEpoch))
      if (!inventory) return finish('PAUSED', 'INVENTORY_UNKNOWN')
      const deposits = keepPlan(inventory, inventoryPolicy()).deposits
      if (deposits.length) {
        if (!hasStorageOption()) return finish('PAUSED', 'CARGO_CAPACITY_EXHAUSTED', { pauseDetails: { floorY: op.floorY, remainingStacks: deposits.length } })
        job.depositReason = 'four_layers'
        setState('RETURN')
        return true
      }
      const finished = op.final === true
      job.collectedThroughY = op.floorY
      job.layerCollection = null
      await save('four_layer_completed')
      note('four_layer_completed', { floorY: op.floorY, final: finished })
      setState(finished ? 'FINAL_CHECK' : 'SURVEY')
      return true
    }
    return finish('PAUSED', 'FOUR_LAYER_CHECKPOINT_INVALID', { pauseDetails: { phase: op.phase } })
  }

  async function scheduleLayerCollection (floorY, final = false) {
    if (job.layerCollection) return
    job.layerCollection = { floorY, final, phase: 'collect', at: new Date(now()).toISOString() }
    await save('four_layer_intent')
    note('four_layer_intent', { floorY, final })
  }

  async function ensureTotem (myEpoch) {
    if (!usesV22Loadout()) return false
    const observedHand = () => adapter.equipmentView?.()?.offhand
    const knownHand = () => { const hand = observedHand(); return hand?.known === true && hand.slots?.[0]?.known === true ? hand.slots[0] : null }
    const waitHand = async () => {
      if (knownHand()) return knownHand()
      if (typeof adapter.resyncInventory !== 'function') return null
      try {
        let refreshed
        try { refreshed = await call(myEpoch, 'totem_observe', signal => adapter.resyncInventory({ signal })) } catch (error) {
          if (error.code !== 'RESYNC_RATE_LIMIT') throw error
          const until = now() + 20000
          while (now() < until) { guard(myEpoch); await sleep(100) }
          refreshed = await call(myEpoch, 'totem_observe', signal => adapter.resyncInventory({ signal }))
        }
        if (refreshed !== true) return null
        const until = now() + 5000
        do { guard(myEpoch); if (knownHand()) return knownHand(); await sleep(100) } while (now() < until)
      } catch (error) { if (error instanceof QuarryInterrupt) throw error }
      return null
    }
    let hand = await waitHand()
    const pending = job.pendingTotemEquip
    if (pending) {
      const state = guard(myEpoch)
      if (pending.scope !== scopeOf(state) || pending.life !== lifeOf(state) || pending.self !== String(state.runtimeEntityId)) { await finish('PAUSED', 'TOTEM_EQUIP_SCOPE_CHANGED'); return true }
      if (!hand || hand.empty || hand.name !== 'minecraft:totem_of_undying' || hand.count !== 1) { await finish('PAUSED', 'TOTEM_EQUIP_UNCONFIRMED'); return true }
      delete job.pendingTotemEquip
      job.totemsEquipped = (job.totemsEquipped ?? 0) + 1
      await save('totem_equipped'); return true
    }
    const view = adapter.equipmentView?.()
    if (view?.offhand?.known !== true || view.offhand.slots?.[0]?.known !== true) {
      await finish('PAUSED', 'OFFHAND_OBSERVATION_UNKNOWN'); return true
    }
    hand = view.offhand.slots[0]
    if (!hand.empty) {
      if (hand.name === 'minecraft:totem_of_undying') return false
      await finish('PAUSED', 'OFFHAND_OCCUPIED'); return true
    }
    const inventory = items(guard(myEpoch))
    if (!inventory) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    const totem = inventory.find(row => row.name === 'minecraft:totem_of_undying' && row.count === 1)
    if (!totem) {
      await finish('PAUSED', 'TOTEM_EXHAUSTED'); return true
    }
    if (job.config.initialLoadout === 'v22') {
      const state = guard(myEpoch)
      job.pendingTotemEquip = { scope: scopeOf(state), life: lifeOf(state), self: String(state.runtimeEntityId), fromSlot: totem.slot, stage: 'intent' }
      await save('totem_equip_intent')
    }
    const receipt = await call(myEpoch, 'equip_totem', signal => adapter.equipmentTransfer({
      from:'main',fromSlot:totem.slot,to:'offhand',toSlot:0,
      expectedName:'minecraft:totem_of_undying',signal
    }))
    if (receipt?.serverConfirmed === true && job.pendingTotemEquip) {
      Object.assign(job.pendingTotemEquip, { stage: 'accepted', requestId: receipt.requestId ?? null })
      await save('totem_equip_accepted')
    }
    hand = await waitHand()
    if (receipt?.serverConfirmed !== true || hand?.name !== 'minecraft:totem_of_undying' || hand.count !== 1 || hand.empty) {
      await finish('PAUSED','TOTEM_EQUIP_UNCONFIRMED');return true
    }
    delete job.pendingTotemEquip
    job.totemsEquipped = (job.totemsEquipped ?? 0) + 1
    await save('totem_equipped')
    return true
  }

  // ---- normal work -------------------------------------------------------
  async function work (myEpoch) {
    if (job.config.initialLoadout === 'v22' && job.pendingTotemEquip && await ensureTotem(myEpoch)) return
    if (job.config.initialLoadout === 'v22' && !(await verifyExitSupplyStock(myEpoch))) return
    if (!deferredExitSupplies() && job.exitPreflight?.layer !== job.cursorY && !(await prepareExit(myEpoch))) return
    const s = guard(myEpoch)
    const hz = hazardNow(s)
    if (hz) return escapeHazard(myEpoch, hz)
    if (healthRatio(s) <= job.config.safety.retreatHealthRatio) { note('low_health', { health: s.health }); setState('RECOVER'); return }
    if (job.portableStorage) return returnAndDeposit(myEpoch, job.portableStorage.why ?? 'capacity')
    if (job.supplyRestock) return restock(myEpoch, job.supplyRestock.resumeTo ?? 'SURVEY', true)
    await applyStorageConfiguration()
    guard(myEpoch)
    await tryEat(myEpoch)
    if (job.fluidDrain) return observeFluidDrain(myEpoch)
    const inv = items(guard(myEpoch))
    if (!inv) { await sleep(300); return }
    observeInventory(job.state)
    // Finish existing container operations first, but a newly full bag must be
    // emptied before starting another supply box that needs recovery space.
    if (fullOnlyStorage() && !job.storageExhausted && freeSlots(inv) === 0 && keepPlan(inv, inventoryPolicy()).deposits.length) { await collect(myEpoch, 'capacity'); job.depositReason = 'full'; setState('RETURN'); return }
    if (await restock(myEpoch, 'SURVEY')) return
    if (await ensureTotem(myEpoch)) return
    if (await continueLayerCollection(myEpoch)) return
    // Capacity: collect then return before the bag is full (§10.3, §11.1).
    if (fullOnlyStorage() ? freeSlots(inv) === 0 && !job.storageExhausted : freeSlots(inv) < job.config.inventory.minFreeSlots) { await collect(myEpoch, 'capacity'); job.depositReason = fullOnlyStorage() ? 'full' : 'capacity'; setState('RETURN'); return }
    // Oldest drop deadline / pending count (§10.1). Collection is not tied to
    // each 8-block batch: drops are gathered when the oldest reaches
    // collectAfterSeconds (inside the spec's collectWithinSeconds), when many
    // are pending, or before the job leaves the layer / returns / pauses.
    observeDrops()
    recordPassivePickup('work')
    const open = openDrops()
    const oldest = open.length ? Math.min(...open.map(d => d.firstSeen)) : null
    const st = job.config.strategy
    if (!passivePickup() && oldest !== null && now() - oldest >= Math.min(st.collectAfterSeconds, st.collectWithinSeconds) * 1000) { await collect(myEpoch, 'deadline'); return }
    if (!passivePickup() && open.length >= st.collectPendingDrops) { await collect(myEpoch, 'pending'); return }
    setState('PLAN')
    const planningState = guard(myEpoch)
    rebindTravelIfOutside(planningState)
    const planningFeet = feetCell(planningState), planningHead = { ...planningFeet, y: planningFeet.y + 1 }
    if (!permits(regions, 'travel', planningFeet).allowed || !permits(regions, 'travel', planningHead).allowed) {
      const details = { feet: planningFeet, head: planningHead, explicitTravelRegion: Array.isArray(job.config.permissions.travelRegion) }
      job.lastDecision = { action: 'pause', reason: 'OUTSIDE_TRAVEL_REGION', details, y: null }
      note('travel_outside', details)
      return finish('PAUSED', 'OUTSIDE_TRAVEL_REGION', { pauseDetails: details })
    }
    job.cursorY = workFloorY()
    const proof = ledger.summary()
    const unstartedTop = job.deepestY === job.yTop && proof.minedBlocks + proof.reminedTemporary === 0
    // A new job must first establish a genuinely reachable mining origin.
    // Existing protected exclusions and earned earlier-layer leftovers retain
    // their normal policy; one failed initial origin cannot dismiss a pit.
    if (unstartedTop) {
      const initialUnreachable = planner.deferredList().filter(d => {
        if (d.reason !== 'UNREACHABLE') return false
        const [x, y, z] = d.position.split(',').map(Number); const b = planningBlocks(job.config)(x, y, z)
        return y <= job.cursorY && b?.known === true && b.name === d.name && blockRule(b.name).kind === 'dig' && !b.protected && !b.protectionSource && !canopyName(b.name)
      })
      if (initialUnreachable.length) return finish('PAUSED', 'INITIAL_LAYER_UNREACHABLE', { pauseDetails: { y: Math.max(...initialUnreachable.map(d => Number(d.position.split(',')[1]))), count: initialUnreachable.length, feet: planningFeet } })
    }
    // Receive the layers under the work layer before planning it, so a cave
    // below is known before its roof is dug (never plan over unreceived cells).
    for (let k = 1; k <= TERRAIN_LOOKAHEAD_LAYERS; k++) {
      const ly = job.cursorY - k
      if (ly < regions.yBottom) break
      if (layerUnknown(ly) === 0) continue
      if (await retryLayerTerrain(myEpoch, ly)) return
      return finish('PAUSED', 'UNOBSERVED_CELLS', { pauseDetails: { y: ly, unknown: layerUnknown(ly), lookahead: true } })
    }
    const planningInventory = items(planningState)
    if (!planningInventory) { await sleep(300); return }
    const decision = await planner.next({ feet: planningFeet, yTop: job.cursorY, tools: planningInventory, policy: { ...job.config.tools, ...job.config.collection, allowHandShovel: fourLayerStorage() && job.shovelSupplyExhausted === true }, inventoryItems: planningInventory, maxBatch: st.maxBlocksPerBatch, selectedSlot: planningState.selectedSlot, avoid: new Set([...badStances].filter(([, n]) => n >= 2).map(([k]) => k)) })
    guard(myEpoch)
    job.lastDecision = { action: decision.action, reason: decision.reason ?? null, details: decision.details ?? null, y: decision.targets?.[0]?.position?.y ?? decision.y ?? null }
    // Leaving a layer: gather its drops first, while they are still close.
    const nextY = decision.action === 'mine' ? decision.targets?.[0]?.position?.y : null
    // Before closing a layer, retry its own transient deferrals once so no
    // leftovers are created that would need a return trip later.
    if (Number.isFinite(nextY) && Number.isFinite(job.lastMineY) && job.lastMineY <= job.cursorY && nextY < job.lastMineY && job.layerRetried !== job.lastMineY) {
      const ly = job.lastMineY
      job.layerRetried = ly
      const cleared = clearWorkDeferred(TRANSIENT_DEFER, ly)
      if (cleared) { badStances.clear(); note('layer_retry', { y: ly, cells: cleared }); return }
    }
    if (fourLayerStorage() && Number.isSafeInteger(nextY)) {
      const due = needsFourLayerCollection(job.yTop, nextY, job.collectedThroughY)
      if (due != null) { await scheduleLayerCollection(due); return }
    }
    if (!passivePickup() && Number.isFinite(nextY) && Number.isFinite(job.lastMineY) && nextY < job.lastMineY && open.length) { job.lastMineY = nextY; await collect(myEpoch, 'layer'); return }
    if (Number.isFinite(nextY)) job.lastMineY = nextY
    if (decision.action === 'finished') {
      if (fourLayerStorage() && (job.collectedThroughY == null || job.collectedThroughY > regions.yBottom)) {
        await scheduleLayerCollection(regions.yBottom, true)
        return
      }
      await collect(myEpoch, 'final'); setState('FINAL_CHECK'); return
    }
    if (decision.action === 'deferred') {
      note('deferred', { reason: decision.reason, count: decision.count, y: decision.y })
      const solidUnreachable = planner.deferredList().some(d => d.reason === 'UNREACHABLE' && Number(d.position.split(',')[1]) === decision.y && !canopyName(d.name))
      if (unstartedTop && decision.reason === 'UNREACHABLE' && solidUnreachable) return finish('PAUSED', 'INITIAL_LAYER_UNREACHABLE', { pauseDetails: { y: decision.y, count: decision.count, feet: planningFeet } })
      return
    }
    if (decision.action === 'pause' && decision.reason === 'UNOBSERVED_CELLS' && await retryLayerTerrain(myEpoch, decision.details?.y)) return
    if (decision.action !== 'pause' || decision.reason !== 'UNOBSERVED_CELLS') job.layerTerrain = null
    if (decision.action === 'mine' && Number.isFinite(nextY)) prefetchTerrain(nextY)
    if (decision.action === 'pause') {
      if (decision.reason === 'BOUNDARY_UNOBSERVED' && await requestTerrainObservation(myEpoch, 'boundary', decision.details?.position)) return
      await collect(myEpoch, 'before_pause'); return finish('PAUSED', decision.reason, { pauseDetails: decision.details ?? null })
    }
    const observedBoundary = job.terrainObservation
    if (observedBoundary?.purpose === 'boundary' && observedBoundary.position) {
      const p = observedBoundary.position
      if (adapter.getBlock(p.x, p.y, p.z)?.known === true) terrainObserved('boundary')
    }
    if (decision.action === 'equip_seal') {
      await call(myEpoch, 'equip_seal', signal => adapter.equip(decision.slot, { signal }))
      const after = items(guard(myEpoch))
      if (!after?.some(i => nameOf(i) === nameOf(decision.material) && i.slot >= 0 && i.slot <= 8 && i.count > 0)) return finish('PAUSED', 'SEAL_MATERIAL_NOT_IN_HOTBAR')
      setState('SURVEY'); return
    }
    if (decision.action === 'wait_fluid') {
      const after = guard(myEpoch)
      job.fluidDrain = { source: null, cells: copy(decision.cells), sourceOnly: true, startedAt: now(), deadline: now() + 120000, scope: scopeOf(after), life: lifeOf(after), remaining: decision.cells.length }
      await save('fluid_drain_wait'); setState('SURVEY'); return
    }
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
    const head = f ? { ...f, y: f.y + 1 } : null
    if (!f || permits(regions, 'travel', f).allowed && permits(regions, 'travel', head).allowed) return false
    const next = makeRegions(job.config, job.yTop, s)
    // Never loop on a rebuild that still leaves the bot outside (that would
    // clear and re-defer the same cells on every tick).
    if (!permits(next, 'travel', f).allowed || !permits(next, 'travel', head).allowed) { if (!job.travelReboundFailed) { job.travelReboundFailed = true; note('travel_rebound_failed', { feet: f }) } return false }
    job.travelReboundFailed = false
    const records = planner.exportRecords()
    regions = next
    planner = createQuarryPlanner({ regions, getBlock: planningBlocks(job.config), config: job.config.strategy, records, exit: job.config.exit })
    clearWorkDeferred(['UNREACHABLE'])
    job.cursorY = workFloorY()
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
      // none left, do not spend a worn tool while pretending to use a hand.
      const inv = items(s) ?? []
      const isTool = i => /_(pickaxe|shovel|axe|hoe|sword)$|shears$/.test(i?.name ?? '')
      const usable = inv.filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot <= 35 && i.count > 0 && i.name && !isTool(i) && i.slot !== s.selectedSlot)
      const source = usable.find(i => i.slot <= 8) ?? usable.sort((a, b) => a.slot - b.slot)[0]
      if (!source) { note('hand_unavailable', { held: held.name }); return false }
      await call(myEpoch, 'equip_hand', signal => adapter.equip(source.slot, { signal, hand: true }))
      return
    }
    if (s.heldItem?.name === tool.name && (s.selectedSlot === tool.slot || s.heldItem?.slot === tool.slot)) return
    await call(myEpoch, 'equip', signal => adapter.equip(tool.slot, { signal }))
    const after = guard(myEpoch)
    if (after.heldItem?.name !== tool.name) throw new Error(`Equip of ${tool.name} is unconfirmed`)
  }

  async function mine (myEpoch, decision, { capacityActionId = null } = {}) {
    // Capacity check against worst-case drops of the whole batch (T06).
    const initial = guard(myEpoch)
    const receiptScope = { job, epoch: myEpoch, scope: scopeOf(initial), life: lifeOf(initial) }
    const inv = items(initial)
    if (!inv) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    let drops
    try { drops = fullDropBudget(decision.targets, decision.tool) } catch (error) {
      if (/^DROP_/.test(error.code ?? '')) {
        const p = error.details?.target?.position
        const b = p ? adapter.getBlock(p.x, p.y, p.z) : null
        const held = initial.heldItem
        error.details = { ...(error.details ?? {}), reason: error.code, scope: scopeOf(initial), life: lifeOf(initial), selectedSlot: initial.selectedSlot ?? null, heldItem: held ? { name: held.name ?? null, slot: held.slot ?? null, stackId: held.stackId ?? null, enchantments: copy(held.enchantments ?? null) } : null, observedBlock: b ? { known: b.known === true, name: b.name ?? null, runtimeId: b.runtimeId ?? null, properties: copy(b.properties ?? null), extra: copy(b.extra ?? null), boundingBox: b.boundingBox ?? null } : null }
      }
      throw error
    }
    const requireDropCapacity = !passivePickup() || capacityActionId != null
    if (requireDropCapacity && !capacityActionId && !canAccept(inv, drops)) {
      try { decision = chooseCapacityPrefix(decision, inv); drops = fullDropBudget(decision.targets, decision.tool) } catch (error) { if (!['MINING_CAPACITY_REQUIRED', 'CAPACITY_BATCH_INVALID'].includes(error.code)) throw error }
    }
    if (requireDropCapacity && !canAccept(inv, drops)) {
      if (capacityActionId) throw Object.assign(new Error('Capacity changed before the held-box batch'), { code: 'MINING_CAPACITY_REQUIRED' })
      note('capacity_before_mine', { drops: drops.length }); await collect(myEpoch, 'capacity')
      const current = items(guard(myEpoch))
      if (current && !canAccept(current, drops) && !keepPlan(current, inventoryPolicy()).deposits.length) {
        if (typeof adapter.storeCarried === 'function') {
          await moveToStance(myEpoch, decision.stance)
          if (await storeCarried(myEpoch, 'capacity_batch', null, decision)) return
        }
        return finish('PAUSED', 'MINING_CAPACITY_REQUIRED', { pauseDetails: { freeSlots: freeSlots(current), drops, targets: decision.targets.length } })
      }
      job.depositReason = 'capacity'; setState('RETURN'); return
    }
    await moveToStance(myEpoch, decision.stance)
    let tool = decision.tool; let prepared = false; let plannedTargets = decision.targets
    const terminalTool = tool.kind !== 'hand' && Number.isFinite(tool.remaining) && tool.remaining <= 9
    if ((job.miningEquipmentPending || terminalTool) && typeof adapter.prepareMining === 'function') {
      const result = await call(myEpoch, 'prepare_mining', signal => adapter.prepareMining(tool, { signal }))
      guard(myEpoch)
      if (result === false) throw new Error('Mining equipment preparation was not confirmed')
      // Preparing a tool in the main bag can swap it into another slot. The
      // old source slot now holds a different item and must never be re-used.
      if (result?.slot != null && tool.kind !== 'hand') {
        if (!Number.isInteger(result.slot) || result.slot < 0 || result.slot > 8) throw new Error('Mining equipment preparation returned an invalid selected slot')
        tool = { ...tool, slot: result.slot }
      }
      if (tool.kind !== 'hand' && result != null && Object.hasOwn(result, 'toolObservation')) {
        const observation = result.toolObservation ?? {}
        const current = toolState({ ...observation, count: 1 }, job.config.tools)
        if (!Number.isInteger(observation.slot) || observation.slot < 0 || observation.slot > 8 || observation.name !== tool.name || !current?.usable) {
          job.miningEquipmentPending = true
          note('tool_observation_replan', { name: observation.name ?? null, remaining: observation.durabilityRemaining ?? null, reason: current?.reason ?? 'TOOL_OBSERVATION_CHANGED' })
          setState('SURVEY'); return
        }
        tool = { ...tool, slot: observation.slot, remaining: current.remaining, reserve: current.reserve }
        plannedTargets = plannedTargets.slice(0, Math.max(0, Math.floor(current.remaining - current.reserve)))
        if (!plannedTargets.length) { setState('SURVEY'); return }
      }
      prepared = true
    }
    if (await equipTool(myEpoch, tool) === false) return finish('PAUSED', 'HAND_ITEM_REQUIRED')
    guard(myEpoch)
    const beforeDispatch = items(guard(myEpoch))
    if (!beforeDispatch) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    if (!capacityActionId && passivePickup() && !job.storageExhausted && freeSlots(beforeDispatch) === 0) { job.depositReason = 'full'; setState('RETURN'); return }
    for (const target of plannedTargets.filter(t => nameOf(t.name) === 'leaf_litter')) {
      const p = target.position, b = adapter.getBlock(p.x, p.y, p.z)
      if (b?.known !== true || b.name !== target.name || b.runtimeId !== target.runtimeId || !isDeepStrictEqual(b.properties, target.properties)) {
        const error = new QuarryInterrupt('DROP_TARGET_STATE_CHANGED')
        error.details = { reason: error.code, stage: 'before_mine_dispatch', target: { position: copy(p), name: target.name, runtimeId: target.runtimeId, properties: copy(target.properties ?? null) }, tool: copy(tool), observedBlock: b ? { known: b.known === true, name: b.name, runtimeId: b.runtimeId, properties: copy(b.properties ?? null) } : null }
        throw error
      }
    }
    const exitUses = miningUsesAfterExitReserve(tool, beforeDispatch, job.exitReservation?.plan, job.config.tools)
    if (exitUses < plannedTargets.length) plannedTargets = plannedTargets.slice(0, exitUses)
    if (!plannedTargets.length) {
      // Every remaining use of this tool is kept for the exit: fetch one more of
      // the same kind from its supply box (once), then mine with the fresh one.
      if (job.config.inventory.supplyBoxes?.length && ['pickaxe', 'shovel'].includes(tool.kind) && !job.miningExhaustedTried) {
        // Worn tools of this kind are returned in the same restock; count only the others.
        const carried = supplyNeeds(items(guard(myEpoch)) ?? [], { ...job.config.inventory, tools: job.config.tools, miningExhausted: { [tool.kind]: 0 } }).available[tool.kind] ?? 0
        job.miningExhausted = { [tool.kind]: Math.min(EXHAUSTED_TOOL_CAP, carried + 1) }; job.miningExhaustedTried = true
        if (await restock(myEpoch, 'SURVEY', true)) return
      }
      job.miningExhausted = null
      return finish('PAUSED', 'EXIT_TOOL_RESERVE', { pauseDetails: { tool: tool.name, reservedUses: job.exitReservation?.plan?.toolUses ?? [] } })
    }
    job.miningExhausted = null; job.miningExhaustedTried = false
    if (prepared) job.miningEquipmentPending = false
    // Re-plan from the actual stance; the world may have changed while moving.
    setState('MINE')
    const targets = plannedTargets.map(t => ({ x: t.position.x, y: t.position.y, z: t.position.z, expectedName: t.name, expectedRuntimeId: t.runtimeId ?? null, requiredTool: tool.kind !== 'hand' ? { kind: tool.kind, tier: tool.tier, reserve: tool.reserve } : null, ...(nameOf(t.name) === 'leaf_litter' ? { expectedProperties: copy(t.properties ?? null) } : {}), ...(t.accessPreparation ? { accessPreparation: t.accessPreparation } : {}), ...(t.fluidSource ? { fluidSource: copy(t.fluidSource) } : {}) }))
    const rec = recordAction({ type: 'mine', stance: decision.stance, targets: targets.map(t => ({ x: t.x, y: t.y, z: t.z, name: t.expectedName, ...(t.expectedName === 'minecraft:leaf_litter' ? { runtimeId: t.expectedRuntimeId, properties: copy(t.expectedProperties) } : {}) })), tool: decision.tool?.name ?? 'hand', ...(capacityActionId ? { capacityActionId } : {}) })
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
    if (job.config.persistence.checkpointAfterBatch || capacityActionId) await save('mine_intent')
    let failure = null
    try {
      const dispatched = await call(myEpoch, 'mine', signal => {
        const inventory = items(guard(myEpoch))
        if (!inventory) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
        if (!capacityActionId && passivePickup() && !job.storageExhausted && freeSlots(inventory) === 0) return { notStarted: 'INVENTORY_FULL' }
        return adapter.mine(job.storageExhausted ? targets.map(t => ({ ...t, allowFullInventory: true })) : targets, { signal })
      })
      guard(myEpoch)
      if (dispatched?.notStarted === 'INVENTORY_FULL') { rec.status = 'not_started'; rec.reason = 'INVENTORY_FULL'; job.depositReason = 'full'; setState('RETURN'); return }
    } catch (error) {
      // A controller may reject because stopAll ran just before the watcher.
      // Classify that as the current interruption before counting partial air.
      let interruption = error
      if (!(error instanceof QuarryInterrupt)) { try { guard(myEpoch) } catch (current) { interruption = current } }
      if (interruption instanceof QuarryInterrupt) { rec.status = 'interrupted'; confirmCurrent(interruption); throw interruption }
      failure = error
    }
    const confirmed = confirmCurrent()
    // A fresh server tool update can arrive after the batch was planned.
    // Preserve confirmed air, then select again; rejected use is not a bad cell.
    if (failure?.code === 'TOOL_DURABILITY_RESERVE' || /TOOL_DURABILITY_RESERVE|tool durability.*reserve/i.test(String(failure?.message ?? ''))) {
      rec.status = confirmed ? 'partial' : 'interrupted'; rec.error = String(failure.message ?? failure)
      job.miningEquipmentPending = true
      note('tool_reserve_replan', { confirmed, error: rec.error.slice(0, 200) })
      await save('tool_reserve_replan')
      setState('SURVEY'); return
    }
    // The server broke a block far slower than the held tool allows: its
    // selected slot / held item differs from our view. Resync the inventory
    // from the server and re-plan (equipTool then really re-sends the slot).
    if (failure?.code === 'SLOW_BREAK') {
      rec.status = confirmed ? 'partial' : 'failed'; rec.error = String(failure.message)
      // Count distinct slow cells: one cell that stays slow after a resync is a
      // problem of that cell or stance (it waits for the next reconcile like a
      // refused cell); slow breaks on 3 different cells mean the held tool.
      const t = failure.target, k = t ? `${t.x},${t.y},${t.z}` : null
      job.slowCells ??= []
      if (k && job.slowCells.includes(k)) {
        planner.defer(t, 'MINING_FAILED', { error: rec.error.slice(0, 160), slowBreak: true })
        if (decision.stance) badStances.set(`${decision.stance.x},${decision.stance.y},${decision.stance.z}`, 2)
        note('slow_cell_deferred', { cell: t, stance: decision.stance ?? null })
        return
      }
      if (k) job.slowCells.push(k)
      job.slowBreaks = job.slowCells.length || (job.slowBreaks ?? 0) + 1
      note('slow_break', { message: failure.message, held: adapter.getState()?.heldItem?.name ?? null, selectedSlot: adapter.getState()?.selectedSlot ?? null, count: job.slowBreaks })
      if (job.slowBreaks >= 3) return finish('PAUSED', 'SLOW_BREAK_PERSISTS', { pauseDetails: { lastError: rec.error, held: adapter.getState()?.heldItem?.name ?? null, cells: copy(job.slowCells) } })
      try { await call(myEpoch, 'resync', signal => adapter.resyncInventory?.({ signal })) } catch (error) { if (error instanceof QuarryInterrupt) throw error; note('resync_failed', { error: String(error.message ?? error).slice(0, 200) }) }
      lastInventory = totals(items(adapter.getState()) ?? [])
      return
    }
    // Confirmed progress also renews the terrain request budget: received
    // subchunks far above are dropped as the bot digs down, so the exit column
    // may need a fresh request later (live 2026-11-10 11:35: budget spent at start).
    if (confirmed) { job.slowBreaks = 0; job.slowCells = []; job.routeSkips = 0; job.autoResumes = 0; job.capacityRetries = 0; if (job.terrainObservation?.phase === 'exhausted') { job.terrainObservation.requests = 0; job.terrainObservation.phase = 'idle' } }
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
    if (!passivePickup() && decision.targets.some(t => blockRule(t.name).ore)) { await sleep(150); trackDrops(targets); await collect(myEpoch, 'valuable') }
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
        if (Number.isSafeInteger(t.y) && t.y >= regions.yBottom && t.y <= job.yTop) {
          job.deepestY = Math.min(workFloorY(), t.y)
          job.cursorY = job.deepestY
        }
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
    const previous=job.dropPickupLedgerBaseline??null, current=pickedLedger()
    const live = new Set()
    for (const e of adapter.entities()) {
      if (e.kind !== 'item' || !e.position) continue
      live.add(e.runtimeId)
      if (pendingDrops.some(d => d.runtimeId === e.runtimeId)) continue
      if (!permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed) continue
      pendingDrops.push({ runtimeId: e.runtimeId, name: e.name, count: e.count, position: copy(e.position), firstSeen: now(), mixed: true })
    }
    if (fourLayerStorage()) {
      const delta = new Map(Object.keys(current).map(n=>[n,Math.max(0,(current[n]??0)-(previous?.[n]??0))]))
      for(const drop of pendingDrops.filter(d=>!live.has(d.runtimeId))) {
        const name=nameOf(drop.name),needed=Number.isInteger(drop.count)&&drop.count>0?drop.count:1
        const available=delta.get(name)??0
        if(previous && available>=needed) delta.set(name,available-needed)
        else recordUnverifiedDrop(drop,'ENTITY_GONE_WITHOUT_NEW_INVENTORY')
      }
      job.dropPickupLedgerBaseline=current
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
  async function collect (myEpoch, why, { onObservation = null } = {}) {
    if (passivePickup()) {
      guard(myEpoch); observeInventory(job.state); observeDrops(); recordPassivePickup(why)
      setState('PLAN')
      return
    }
    setState('COLLECT', { collectReason: why })
    const s = guard(myEpoch)
    const ents = new Map(adapter.entities().filter(e => e.kind === 'item' && e.position).map(e => [e.runtimeId, e]))
    if (onObservation) await onObservation([...ents.values()])
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
    const observedOnPass=remaining.map(d=>({...d}))
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
      const actors = adapter.entities()
      if (onObservation) await onObservation(actors.filter(e => e.kind === 'item' && e.position))
      const live = new Set(actors.map(e => e.runtimeId))
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
    if (fourLayerStorage()) {
      const gains=new Map(diff(before,after).filter(d=>d.delta>0).map(d=>[d.name,d.delta]))
      const left=new Set(adapter.entities().filter(e=>e.kind==='item').map(e=>String(e.runtimeId)))
      for(const d of observedOnPass) {
        if(left.has(String(d.runtimeId))) continue
        const n=nameOf(d.name),needed=Number.isInteger(d.count)&&d.count>0?d.count:1,available=gains.get(n)??0
        if(available>=needed)gains.set(n,available-needed)
        else recordUnverifiedDrop(d,'COLLECT_ENTITY_GONE_WITHOUT_MATCHING_PICKUP')
      }
    }
    observeInventory('COLLECT')
    // Items still on the ground stay tracked: capacity misses are retried after
    // a deposit, unreachable ones are only written off at the end (§10.2).
    const still = new Set(adapter.entities().filter(e => e.kind === 'item').map(e => e.runtimeId))
    pendingDrops = unreachable.filter(d => still.has(d.runtimeId)).map(d => ({ ...d, unreachable: !['NO_CAPACITY', 'NEXT_PASS', 'STUCK'].includes(d.reason) }))
    job.unreachableItems = pendingDrops.filter(d => d.unreachable).map(d => ({ name: d.name, count: d.count, position: d.position, reason: d.reason }))
    batchCount = 0
    // The bag could not take everything: empty it into the chests, then the
    // left-over drops are picked up on the next collection.
    if (needRoom && hasStorageOption()) { note('collect_needs_room', { left: pendingDrops.filter(d => !d.unreachable).length }); job.depositReason = 'capacity'; setState('RETURN'); return }
    setState('PLAN')
  }

  async function place (myEpoch, decision) {
    await moveToStance(myEpoch, decision.stance)
    // Reuse exactly these received preconditions after movement and again
    // after checkpoint I/O, immediately before the ordinary placement port.
    const checkSeal = () => {
      const state = guard(myEpoch), stance = feetCell(state), p = decision.position
      const fail = reason => ({ reason, details: { stance, floor: { ...stance, y: stance.y - 1 }, position: p } })
      if (!planner.safeSealStance(stance)) return fail('SEAL_UNSAFE_STANCE')
      const inv = items(state), material = nameOf(decision.material), dirt = totals(inv ?? []).get('dirt') ?? 0
      const reserve = fourLayerStorage() || deferredExitSupplies() && job.egressPreparation !== true ? 0 : Math.max(job.config.inventory.keepExitDirt ?? 0, decision.materialRequired === 'dirt' ? 192 : 0)
      if (!inv || decision.materialRequired && material !== decision.materialRequired || material === 'dirt' && dirt <= reserve || !inv?.some(i => i.slot === decision.slot && nameOf(i) === material && i.count > 0)) return fail('SEAL_MATERIAL_MISSING')
      const b = adapter.getBlock(p.x, p.y, p.z)
      if (!permits(regions, 'seal', p).allowed || !b?.known || b.protected || b.protectionSource || b.extra?.length) return fail('SEAL_CONTEXT_CHANGED')
      if (decision.sourceSeal) {
        const expected = decision.sourceSeal.source
        const raw = b.properties?.liquid_depth ?? b.properties?.['minecraft:liquid_depth']
        const fresh = planner.sealPlan({ position: p })
        if (b.name !== expected.expectedName || b.runtimeId !== expected.expectedRuntimeId || (raw?.value ?? raw) !== 0 || !fresh.ok || !fresh.sourceSeal || !isDeepStrictEqual(fresh.sourceSeal.source, expected)) return fail('FLUID_SOURCE_CHANGED')
      } else if (decision.boundaryOpening) {
        const inner = decision.boundaryOpening.inside; const roof = decision.boundaryOpening.roof
        const inside = adapter.getBlock(inner.x, inner.y, inner.z); const above = adapter.getBlock(roof.x, roof.y, roof.z)
        if (!AIR.has(nameOf(b)) || !inside?.known || !(AIR.has(nameOf(inside)) || blockRule(inside.name).kind === 'fluid') || !above?.known || above.boundingBox !== 'block' || above.extra?.length || blockRule(above.name).kind === 'fluid') return fail('BOUNDARY_CONTEXT_CHANGED')
      }
      return null
    }
    const rejected = checkSeal()
    if (rejected) return finish('PAUSED', rejected.reason, { pauseDetails: rejected.details })
    setState(decision.action === 'seal' ? 'HAZARD' : 'MINE', { placing: decision.purpose })
    const rec = recordAction({ type: 'place', purpose: decision.purpose, position: decision.position, material: decision.material })
    const beforeMaterial = totals(items(guard(myEpoch)) ?? []).get(nameOf(decision.material)) ?? 0
    if (typeof adapter.place !== 'function') return finish('PAUSED', 'PLACEMENT_UNAVAILABLE')
    await save('place_intent')
    let placementReceipt
    try {
      placementReceipt = await call(myEpoch, 'place', signal => {
        const rejected = checkSeal()
        if (rejected) {
          const error = new QuarryInterrupt(rejected.reason)
          error.details = rejected.details
          throw error
        }
        return adapter.place({ position: decision.position, slot: decision.slot, clicked: decision.clicked, face: decision.face, point: decision.point, expectedBlock: `minecraft:${nameOf(decision.material)}` }, { signal })
      })
    } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      job.placeFailures = (job.placeFailures ?? 0) + 1
      if (job.placeFailures >= 5) { job.placeFailures = 0; return finish('PAUSED', 'SEAL_PLACEMENT_FAILED', { pauseDetails: { position: decision.position, error: rec.error } }) }
      // Flowing fluid can change the face planned to be clicked (live
      // 2026-11-11 11:59, three refusals from one stance within 0.1s). The
      // refused stance is avoided and the placement planned again after the
      // fluid has had a moment to settle.
      if (decision.stance) badStances.set(`${decision.stance.x},${decision.stance.y},${decision.stance.z}`, 2)
      note('seal_placement_retry', { position: decision.position, stance: decision.stance ?? null, attempt: job.placeFailures, error: rec.error.slice(0, 120) })
      const until = now() + 1000
      while (now() < until) { await sleep(100); guard(myEpoch) }
      return
    }
    const b = adapter.getBlock(decision.position.x, decision.position.y, decision.position.z)
    if (!(b?.known && nameOf(b) === nameOf(decision.material))) { rec.status = 'unconfirmed'; return }
    if (decision.sourceSeal || decision.materialRequired === 'dirt') {
      const after = guard(myEpoch); const inventory = items(after)
      const spent = inventory && beforeMaterial - (totals(inventory).get(nameOf(decision.material)) ?? 0) === 1
      if (!(placementReceipt?.phase === 'completed' && placementReceipt.confirmedBy === 'server_block_and_inventory') && !spent) { rec.status = 'unconfirmed'; return finish('PAUSED', decision.sourceSeal ? 'SOURCE_PLACEMENT_UNCONFIRMED' : 'SEAL_PLACEMENT_UNCONFIRMED', { pauseDetails: { position: decision.position } }) }
      rec.confirmedBy = 'server_block_and_inventory'; rec.scope = scopeOf(after); rec.life = lifeOf(after)
      if (decision.sourceSeal) job.fluidDrain = { source: copy(decision.sourceSeal.source), cells: copy(decision.sourceSeal.cells), sourceOnly: decision.sourceSeal.sourceOnly === true, expectedBlock: `minecraft:${nameOf(decision.material)}`, startedAt: now(), deadline: now() + (decision.sourceSeal.sourceOnly ? 120000 : 60000), scope: scopeOf(after), life: lifeOf(after), remaining: decision.sourceSeal.cells.length - 1 }
    }
    rec.status = 'confirmed'; job.placeFailures = 0
    planner.recordPlacement(decision.position, decision.purpose, decision.material)
    countsRevision++
    ledger.add(decision.purpose === 'seal' ? 'placedSeal' : 'placedTemporary', decision.material)
    if (decision.sourceSeal) { note('fluid_source_plugged', { position: decision.position, cells: decision.sourceSeal.size }); await save('fluid_source_plugged'); setState('SURVEY'); return }
    if (decision.boundaryOpening) { note('boundary_opening_closed', { position: decision.position }); await save('boundary_opening_closed'); setState('SURVEY'); return }
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

  async function observeFluidDrain (myEpoch) {
    const state = guard(myEpoch); const drain = job.fluidDrain
    if (!drain) return
    if (drain.scope !== scopeOf(state) || drain.life !== lifeOf(state)) return finish('PAUSED', 'FLUID_DRAIN_SCOPE_CHANGED')
    const p = drain.source?.position ?? null
    if (p) {
      const source = adapter.getBlock(p.x, p.y, p.z)
      if (source?.known !== true) return finish('PAUSED', 'FLUID_DRAIN_UNOBSERVED', { pauseDetails: { position: p } })
      if (source.name !== drain.expectedBlock) return finish('PAUSED', 'FLUID_SOURCE_CHANGED', { pauseDetails: { position: p, name: source.name } })
    }
    let remaining = 0; let sources = 0
    for (const c of drain.cells) {
      const b = adapter.getBlock(c.x, c.y, c.z)
      if (b?.known !== true) return finish('PAUSED', 'FLUID_DRAIN_UNOBSERVED', { pauseDetails: { position: c } })
      if (blockRule(b.name).kind === 'fluid' || (b.extra ?? []).some(l => /water|lava/.test(nameOf(l)))) remaining++
      const raw = b.properties?.liquid_depth ?? b.properties?.['minecraft:liquid_depth']
      if (/^(?:flowing_)?(?:water|lava)$/.test(nameOf(b)) && (raw?.value ?? raw) === 0) sources++
    }
    // A second received source (including finite water source regeneration)
    // is work for another strict plan, not a reason to wait for impossible
    // complete drainage while the source is still present.
    if (drain.sourceOnly && sources > 0) { job.lastFluidSourceStep = { source: copy(drain.source), remainingSources: sources, remaining, observedAt: now() }; job.fluidDrain = null; note('fluid_sources_remaining', { sources, remaining }); await save('fluid_sources_remaining'); setState('SURVEY'); return }
    if (remaining !== drain.remaining) { drain.remaining = remaining; note('fluid_drain_progress', { remaining, total: drain.cells.length }); await save('fluid_drain_progress') }
    if (remaining === 0) { job.lastFluidDrain = { source: copy(drain.source), cells: drain.cells.length, completedAt: now() }; job.fluidDrain = null; note('fluid_drain_observed', { cells: drain.cells.length }); await save('fluid_drain_observed'); setState('SURVEY'); return }
    if (now() >= drain.deadline) return finish('PAUSED', 'FLUID_DRAIN_TIMEOUT', { pauseDetails: { source: p, remaining, total: drain.cells.length } })
    await sleep(1000)
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
    if (shulkerOnly) return null
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
    if (shulkerOnly) return { ok: false, reason: 'SHULKER_ONLY_STORAGE' }
    const list = job.config.inventory.storage ?? []
    const maxChests = job.config.inventory.maxChests ?? 16
    if (list.length >= maxChests) return { ok: false, reason: 'MAX_CHESTS', maxChests }
    if (typeof adapter.addChest !== 'function') return { ok: false, reason: 'ADD_CHEST_UNSUPPORTED' }
    const last = list[list.length - 1]
    // Walking to the last chest is only a starting point; if that stand cannot
    // be reached any more, search for a chest cell from where we are.
    try {
      await previewStorageRoute(myEpoch, last)
      await waitForQuietStorage(myEpoch, last)
      await goToStorage(myEpoch, last)
    } catch (error) {
      guard(myEpoch)
      if (storagePreviewBusy(error)) return { ok: false, reason: 'STORAGE_PREVIEW_BUSY', retry: true }
      if (error instanceof QuarryInterrupt && error.code !== 'STORAGE_UNREACHABLE') throw error
      if (!(error instanceof QuarryInterrupt)) note('add_chest_start_unreachable', { error: String(error.message ?? error).slice(0, 160) })
    }
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
      try {
        const target = { position: c.cell, stand: c.stand }
        await previewStorageRoute(myEpoch, target)
        await waitForQuietStorage(myEpoch, target)
        await moveToStance(myEpoch, c.stand)
      } catch (error) {
        guard(myEpoch)
        if (storagePreviewBusy(error)) return { ok: false, reason: 'STORAGE_PREVIEW_BUSY', retry: true }
        if (error instanceof QuarryInterrupt && error.code !== 'STORAGE_UNREACHABLE') throw error
        attempts.push({ cell: c.cell, reason: 'MOVE_FAILED' }); continue
      }
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
    planner = createQuarryPlanner({ regions, getBlock: planningBlocks(job.config), config: job.config.strategy, records, exit: job.config.exit })
    note('storage_added', { position: entry.position, chests: job.config.inventory.storage.length, crafted: r.crafted ?? null })
    await save('storage_added')
    return { ok: true, storage: entry }
  }

  const storagePreviewBusy = error => ['BUSY', 'STORAGE_PREVIEW_BUSY'].includes(error?.code)
  function storageRoute (myEpoch, st) {
    if (!st) throw new QuarryInterrupt('NO_STORAGE', 'No registered storage')
    const from = feetCell(guard(myEpoch))
    const stands = (st.stand ? [st.stand] : [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: st.position.x + dx, y: st.position.y, z: st.position.z + dz }))).filter(c => planner.standable(c))
    let path = null; let stand = null
    for (const c of stands) { const p = planner.pathTo(from, c); if (p && (!path || p.length < path.length)) { path = p; stand = c } }
    if (!path) throw new QuarryInterrupt('STORAGE_UNREACHABLE', 'No permitted walking route to the registered storage')
    return { stand, path }
  }
  async function previewStorageRoute (myEpoch, st) {
    const route = storageRoute(myEpoch, st)
    if (typeof adapter.previewStorage === 'function') {
      let verdict
      try { verdict = await call(myEpoch, 'preview_storage', signal => adapter.previewStorage({ ...st, stand: route.stand }, { signal, path: route.path, travel: c => permits(regions, 'travel', c).allowed })) } catch (error) {
        guard(myEpoch)
        if (storagePreviewBusy(error)) throw new QuarryInterrupt('STORAGE_PREVIEW_BUSY', 'Storage route preview is temporarily busy')
        throw error
      }
      guard(myEpoch)
      if (verdict?.ready !== true) {
        if (['BUSY', 'STORAGE_PREVIEW_BUSY'].includes(verdict?.code ?? verdict?.reasonCode)) throw new QuarryInterrupt('STORAGE_PREVIEW_BUSY', 'Storage route preview is temporarily busy')
        throw new QuarryInterrupt('STORAGE_UNREACHABLE', verdict?.reason ?? 'No ready native walking segment to registered storage')
      }
    }
    return route
  }
  async function goToStorage (myEpoch, target = null) {
    const st = target ?? currentStorage() ?? job.config.inventory.storage?.[0]
    setState('RETURN')
    const { stand, path } = storageRoute(myEpoch, st)
    await call(myEpoch, 'return', signal => adapter.goToStorage({ ...st, stand }, { signal, path, travel: c => permits(regions, 'travel', c).allowed }))
  }

  function storageHostiles (target = null) {
    const st = target ?? currentStorage() ?? job.config.inventory.storage?.[0]
    if (!st?.position) return []
    return (adapter.actors?.() ?? []).filter(e => e.hostile === true && e.alive !== false && e.position && Math.hypot(e.position.x - st.position.x, e.position.z - st.position.z) <= STORAGE_AREA_RADIUS && Math.abs(e.position.y - st.position.y) <= 12)
  }
  async function waitForQuietStorage (myEpoch, target = null) {
    const busy = list => list.length >= 3 || list.some(e => /witch|evoker|ravager|vindicator|creeper/.test(e.entityType ?? ''))
    let list = storageHostiles(target)
    if (!busy(list)) return
    note('storage_area_hostile', { count: list.length, types: [...new Set(list.map(e => e.entityType))].slice(0, 6) })
    const until = now() + STORAGE_WAIT_MS
    while (now() < until && busy(list)) {
      guard(myEpoch)
      if (job.config.quarryCombat.enabled && adapter.combatActive()) throw new QuarryInterrupt('COMBAT')
      await sleep(2000)
      list = storageHostiles(target)
    }
    note(busy(list) ? 'storage_area_wait_timeout' : 'storage_area_clear', { count: list.length })
  }

  function validSupplyBindings (bindings, mode = job?.config?.inventory) {
    const roles = mode === 'four_layers' || mode?.depositWhen === 'four_layers' || mode?.supplyLayout === 'v22' ? ['pickaxe', 'shovel', 'dirt', 'totem'] : ['pickaxe', 'shovel', 'food', 'dirt']
    return Array.isArray(bindings) && bindings.length === 4 && roles.every(role => bindings.filter(b => b?.role === role && typeof b.key === 'string' && typeof b.itemName === 'string').length === 1) && new Set(bindings.map(b => b.key)).size === 4
  }
  function completedV22Loadout (requireReady = true) {
    if (!usesV22Loadout() || requireReady && job.loadoutReady !== true) return null
    const cp = job.loadout?.checkpoint, home = job.config.homeChest
    if (cp?.version !== 1 || cp.direction !== 'withdraw' || cp.phase !== 'completed' || cp.index !== 34 || cp.intent != null || !samePoint(cp.position, home?.position) ||
        cp.jobId !== job.config.jobId || cp.operationId !== job.loadout.operationId || !Array.isArray(cp.plan) || cp.plan.length !== 34 || !Array.isArray(cp.receipts) || cp.receipts.length !== 34 ||
        !Array.isArray(cp.identities) || cp.identities.length !== 34 || cp.identities.some(value => typeof value !== 'string' || !value) ||
        cp.receipts.some((receipt, i) => ['from', 'to', 'name', 'count'].some(key => receipt?.[key] !== cp.plan[i]?.[key]))) return null
    try {
      const state = adapter.getState(), world = assertJobWorld(job, state)
      const key = JSON.stringify([world.profile, world.realmId, world.dimension])
      if (cp.world !== key || cp.life !== JSON.stringify([key, lifeOf(state)])) return null
      if (job.config.initialLoadout === 'v22') {
        const registered = adapter.registeredHomeChest?.()
        if (!registered || !['position', 'other', 'stand', 'stage'].every(part => samePoint(home?.[part], registered[part]))) return null
      }
      return true
    } catch { return null }
  }
  async function verifyExitSupplyStock (myEpoch) {
    const state = guard(myEpoch), main = items(state), view = adapter.equipmentView?.(), bindings = job.config.inventory.supplyBoxes
    if (!main || view?.known !== true || view.uncertain || view.armor?.known !== true || view.offhand?.known !== true ||
      !completedV22Loadout() || !validSupplyBindings(bindings)) { await finish('PAUSED', 'EXIT_SUPPLY_UNCONFIRMED'); return false }
    const required = Math.max(192, job.config.exit?.reservedDirt ?? 0, job.exitReservation?.plan?.totalDirt ?? 0)
    const available = dirtCount(main)
    if (available >= required) return true
    const binding = bindings.find(row => row.role === 'dirt'), candidates = (view?.slots ?? []).filter(row => row?.known === true && !row.empty && row.count === 1 && row.name === binding?.boxName && binding.itemName === 'minecraft:dirt' && carriedContainerKey(row) === binding?.key)
    const slots = candidates.length === 1 && candidates[0].container?.known === true ? candidates[0].container.slots : null
    if (!Array.isArray(slots) || slots.length !== 27 || slots.some(row => row && !(row.known === true && (row.empty === true && row.count === 0 || row.name === 'minecraft:dirt' && Number.isInteger(row.count) && row.count > 0 && row.count <= 64)))) {
      await finish('PAUSED', 'EXIT_SUPPLY_UNCONFIRMED'); return false
    }
    const stored = slots.reduce((total, row) => total + (row && !row.empty ? row.count : 0), 0)
    if (available + stored < required) { await finish('PAUSED', 'EXIT_SUPPLY_MISSING', { pauseDetails: { carried: available, stored, required } }); return false }
    return true
  }
  function initialSupplyStation () {
    const progress = ledger.summary(), home = job.config.homeChest
    if (!completedV22Loadout() || progress.minedBlocks + progress.reminedTemporary !== 0) return null
    const registered = adapter.registeredHomeChest?.()
    if (!registered || !['position', 'other', 'stand', 'stage'].every(part => samePoint(home?.[part], registered[part]))) return null
    if (job.config.initialLoadout === 'v22' && ![home.stand, home.stage].every(p => regions.columns.has(`${p.x},${p.z}`))) return null
    return { stand: copy(home.stand), stage: copy(home.stage) }
  }
  const supplyCanPlace = p => supplyPlacementAllowed(regions, p, initialSupplyStation())
  const supplyCanClear = p => permits(regions, 'break', p).allowed && clearableSitePlant(planningBlocks(job.config)(p.x, p.y, p.z))
  // Nearest reachable stand inside the quarry columns (higher first: the
  // surface), walked to with the ordinary verified movement. Bounded.
  async function enterQuarryForSupply (myEpoch, from) {
    const reach = await planner.reachableFromAsync(from)
    guard(myEpoch)
    const stands = [...reach].map(([k, distance]) => { const [x, y, z] = k.split(',').map(Number); return { stand: { x, y, z }, distance } })
      .filter(c => regions.columns.has(c.stand.x + ',' + c.stand.z) && planner.standable(c.stand) && permits(regions, 'travel', c.stand).allowed)
      .sort((a, b) => a.distance - b.distance || b.stand.y - a.stand.y || a.stand.x - b.stand.x || a.stand.z - b.stand.z)
    if (!stands.length) return { ok: false, details: { cause: 'NO_REACHABLE_STAND_INSIDE', reachable: reach.size } }
    const tried = []
    for (const { stand } of stands.slice(0, 4)) {
      try { await moveToStance(myEpoch, stand); return { ok: true, stand } } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        tried.push({ stand, error: String(error.message ?? error).slice(0, 100) })
      }
    }
    return { ok: false, details: { cause: 'ENTRY_MOVE_FAILED', candidates: stands.length, tried } }
  }

  async function approachSupplySite (myEpoch, active) {
    // An existing child owns a physical location and possibly an uncertain
    // placement/transfer. Its normal recovery must run before any relocation.
    if (active.checkpoint?.child) return true
    const blocked = async (reason, details = {}) => {
      job.lastSupplyResult = { operationId: active.operationId, status: 'blocked', reason, serverConfirmed: false, withdrawn: copy(active.checkpoint?.withdrawn ?? []), returned: copy(active.checkpoint?.returned ?? []) }
      note('supply_site_blocked', { reason, cause: details.cause ?? null, position: details.position ?? null, block: details.block ?? null, counts: details.counts ?? null })
      await finish('PAUSED', 'SUPPLY_RESTOCK_BLOCKED', { pauseDetails: { reason, ...copy(details), operationId: active.operationId } })
      return false
    }
    const state = guard(myEpoch)
    if (!items(state)) return blocked('SUPPLY_INVENTORY_UNKNOWN')
    if (active.checkpoint && !isDeepStrictEqual(active.checkpoint.scope, supplyScope(state))) return blocked('SUPPLY_SCOPE_CHANGED')
    if (typeof adapter.previewSupplySite !== 'function') return blocked('SUPPLY_APPROACH_UNSUPPORTED')
    const approachFrom = from => planSupplyApproach({ origin: from, regions, planner, canPlace: supplyCanPlace, initialStation: initialSupplyStation(),
      previewSite: stand => adapter.previewSupplySite(stand, { canPlace: supplyCanPlace, canClear: supplyCanClear }),
      previewRoute: typeof adapter.previewStorage === 'function' ? (site, path) => call(myEpoch, 'preview_supply_route', signal => adapter.previewStorage({ stand: site.stand, position: site.positions[0] }, { signal, path, travel: p => permits(regions, 'travel', p).allowed })) : null,
      guard: () => { const current = guard(myEpoch); if (!samePoint(feetCell(current), from)) throw new QuarryInterrupt('SUPPLY_APPROACH_ORIGIN_CHANGED') } })
    guard(myEpoch)
    let origin = feetCell(guard(myEpoch))
    let selected = await approachFrom(origin)
    guard(myEpoch)
    // Started outside the quarry columns: from out there only the chunk's edge
    // cells are reachable (live 2026-11-09: 26 wall cells, all rejected). Walk
    // to the nearest reachable stand inside the columns and search from there.
    // Placement rules are unchanged: boxes still go only inside the chunk.
    if (!selected.ready && selected.reason === 'STORAGE_SITE_UNOBSERVED' && !regions.columns.has(origin.x + ',' + origin.z)) {
      const entered = await enterQuarryForSupply(myEpoch, origin)
      if (!entered.ok) return blocked('SUPPLY_ENTRY_UNREACHABLE', { origin, firstReason: selected.reason, ...entered.details })
      note('supply_entered', { from: origin, to: entered.stand })
      origin = feetCell(guard(myEpoch))
      selected = await approachFrom(origin)
    }
    if (!selected.ready) return blocked(selected.reason, { ...selected.details, origin })
    active.approach = { phase: 'planned', origin, stand: copy(selected.site.stand), positions: copy(selected.site.positions), pathLength: selected.path.length, predictionOnly: true }
    await save('supply_approach_intent')
    if (!samePoint(origin, selected.site.stand)) {
      note('supply_approach', { from: origin, to: selected.site.stand, steps: selected.path.length - 1 })
      active.approach.phase = 'moving'
      try { await moveToStance(myEpoch, selected.site.stand) } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        guard(myEpoch)
        return blocked('SUPPLY_APPROACH_MOVE_FAILED', { target: selected.site.stand, error: String(error.message ?? error).slice(0, 120) })
      }
    }
    const arrived = feetCell(guard(myEpoch))
    if (!samePoint(arrived, selected.site.stand)) return blocked('SUPPLY_APPROACH_ARRIVAL_UNCONFIRMED', { target: selected.site.stand, position: arrived })
    // Prepare only the explicitly proposed, dry, non-colliding plants. This
    // does not authorize excavation outside the quarry or mark cells as air.
    const preparation = selected.site.preparation ?? []
    if (!Array.isArray(preparation) || preparation.length > 4) return blocked('SUPPLY_SITE_PREPARATION_INVALID')
    for (const target of preparation) {
      const current = guard(myEpoch), block = adapter.getBlock(target.x, target.y, target.z)
      if (!samePoint(feetCell(current), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: target, cause: 'PREPARATION_ORIGIN_CHANGED' })
      if (plainAir(block)) continue
      if (samePoint(target, arrived) || !supplyCanClear(target) || !clearableSitePlant(block) || block.name !== target.expectedName || (target.expectedRuntimeId != null && block.runtimeId !== target.expectedRuntimeId)) return blocked('SUPPLY_SITE_CHANGED', { position: target, cause: 'PREPARATION_BLOCK_CHANGED', block: block?.name ?? null })
      const rule = blockRule(block.name), drops = (rule.drops ?? []).map(name => ({ name: `minecraft:${name}`, count: rule.maxDrop ?? 1 }))
      if (!canAccept(items(current), drops, { minFreeSlots: 1 })) return blocked('SUPPLY_SITE_PREPARATION_CAPACITY', { position: target })
      await equipTool(myEpoch, { kind: 'hand' })
      const action = recordAction({ type: 'supply_site_clear', position: target, expectedName: target.expectedName })
      await save('supply_site_clear_intent')
      guard(myEpoch)
      if (!supplyCanClear(target) || !samePoint(feetCell(adapter.getState()), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: target })
      note('supply_site_prepare', { position: target, block: target.expectedName })
      try { await call(myEpoch, 'supply_site_clear', signal => adapter.mine([{ ...target, accessPreparation: 'quarry', requiredTool: null }], { signal })) } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        guard(myEpoch)
        action.status = 'unconfirmed'
        return blocked('SUPPLY_SITE_PREPARATION_FAILED', { position: target, error: String(error.message ?? error).slice(0, 120) })
      }
      guard(myEpoch)
      if (!plainAir(adapter.getBlock(target.x, target.y, target.z))) return blocked('SUPPLY_SITE_PREPARATION_UNCONFIRMED', { position: target })
      action.status = 'confirmed'; action.confirmedBy = 'received_air'
      observeInventory('SUPPLY_SITE_PREPARE')
      await save('supply_site_cleared')
    }
    if (!samePoint(feetCell(guard(myEpoch)), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: arrived, cause: 'PREPARATION_ORIGIN_CHANGED' })
    const refreshed = adapter.previewSupplySite(arrived, { canPlace: supplyCanPlace })
    if (refreshed?.ready !== true || !samePoint(refreshed.stand, arrived) || !refreshed.positions?.length || !refreshed.positions.every(supplyCanPlace)) return blocked('SUPPLY_SITE_CHANGED', { position: arrived, cause: refreshed?.reason ?? 'UNCONFIRMED' })
    // This is a walking/terrain observation, not a successful box transfer.
    active.approach = { ...active.approach, phase: 'arrived', positions: copy(refreshed.positions) }
    note('supply_arrived', { stand: arrived, box: refreshed.positions[0] })
    await save('supply_approach_arrived')
    return true
  }
  async function restock (myEpoch, resumeTo = 'SURVEY', force = false) {
    const bindings = job.config.inventory.supplyBoxes
    if (!bindings?.length && !job.supplyRestock) return false
    if (job.portableStorage) return false
    if (!validSupplyBindings(bindings) || typeof adapter.restockSupplies !== 'function') { await finish('PAUSED', 'SUPPLY_UNSUPPORTED'); return true }
    const inventory = items(guard(myEpoch)), equipmentView = adapter.equipmentView?.()
    const policy = { ...job.config.inventory, tools: job.config.tools,
      ...(v22SupplyLayout(job.config) ? { totemNeeded: equipmentView?.offhand?.known === true && equipmentView.offhand.slots?.[0]?.empty === true } : {}),
      ...(deferredExitSupplies() ? { deferExitSupplies: true, exitPreparing: job.egressPreparation === true,
        exitDirtTarget: job.egressPreparation === true ? Math.max(192, job.config.inventory.keepExitDirt ?? 0) : 64 } : {}),
      ...(job.miningExhausted ? { miningExhausted: copy(job.miningExhausted) } : {}),
      ...(fourLayerStorage() ? { keepExitDirt: 0, keepSealBlocks: 64,
        exitPreparing: job.egressPreparation === true, exitDirtTarget: job.egressPreparation === true ? Math.max(192, job.config.inventory.keepExitDirt ?? 0) : 64,
        totemNeeded: equipmentView?.offhand?.known === true && equipmentView.offhand.slots?.[0]?.empty === true,
        shovelExhausted: job.shovelSupplyExhausted === true } : {})
    }
    if (!inventory && !job.supplyRestock) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    const need = supplyNeeds(inventory ?? [], policy)
    const shortage = Object.values(need.required).some(Boolean)
    if (!job.supplyRestock && !(shortage || force && need.returns.length)) return false
    if (!job.supplyRestock) { job.supplySequence = (job.supplySequence ?? 0) + 1; job.supplyRestock = { operationId: `${job.config.jobId}:supplies:${job.supplySequence}`, checkpoint: null, resumeTo } }
    const owner = job, active = job.supplyRestock
    if (!(await approachSupplySite(myEpoch, active))) return true
    guard(myEpoch)
    setState('RESTOCK'); await save('supply_intent')
    const response = await call(myEpoch, 'restock_supplies', signal => adapter.restockSupplies({ jobId: job.config.jobId, operationId: active.operationId, bindings: copy(bindings), policy: copy(policy), checkpoint: copy(active.checkpoint), canPlace: supplyCanPlace }, { signal, onCheckpoint: async checkpoint => {
      if (job !== owner || job.supplyRestock !== active || checkpoint?.jobId !== owner.config.jobId || checkpoint?.operationId !== active.operationId) throw new Error('Supply checkpoint belongs to another operation')
      active.checkpoint = copy(checkpoint); await save('supply_checkpoint')
    } }))
    guard(myEpoch)
    job.lastSupplyResult = { operationId: active.operationId, status: response?.status ?? 'blocked', reason: response?.reason ?? null, serverConfirmed: response?.serverConfirmed === true, withdrawn: copy(response?.withdrawn ?? []), returned: copy(response?.returned ?? []) }
    if (response?.status !== 'completed' && SUPPLY_ROOM_REASONS.has(response?.reason) && await makeSupplyRoom(myEpoch, active)) { setState('RESTOCK'); await save('supply_room_retry'); return true }
    if (response?.status !== 'completed' && SUPPLY_SITE_REASONS.has(response?.reason) && supplyUntouched(response?.checkpoint) && (active.siteRetries ?? 0) < SUPPLY_SITE_RETRIES) {
      active.siteRetries = (active.siteRetries ?? 0) + 1
      const issue = response.checkpoint?.child?.siteIssue ?? null
      note('supply_site_retry', { reason: response.reason, attempt: active.siteRetries, issue: copy(issue), mobOverlap: /^ENTIT/.test(issue?.cause ?? ''), waits: (response.checkpoint?.child?.siteWaits ?? []).length, site: copy(active.approach ?? null) })
      active.checkpoint = null; active.approach = null
      await save('supply_site_retry')
      const until = now() + SUPPLY_SITE_RETRY_WAIT_MS
      while (now() < until) { await sleep(100); guard(myEpoch) }
      setState('RESTOCK'); return true
    }
    if (fourLayerStorage() && response?.reason === 'SUPPLY_EXHAUSTED' && active.checkpoint?.bindings?.[active.checkpoint.index]?.role === 'shovel') {
      job.shovelSupplyExhausted = true
      job.miningExhausted = null
      job.miningExhaustedTried = false
      job.supplyRestock = null
      await save('shovel_supply_exhausted')
      setState('SURVEY')
      return true
    }
    if (response?.status !== 'completed' || response.serverConfirmed !== true || !validSupplyBindings(response.bindings)) { await finish('PAUSED', 'SUPPLY_RESTOCK_BLOCKED', { pauseDetails: { reason: response?.reason ?? 'UNCONFIRMED', operationId: active.operationId } }); return true }
    job.config.inventory.supplyBoxes = copy(response.bindings)
    job.supplyReceipts ??= []
    if (!job.supplyReceipts.some(receipt => receipt.operationId === active.operationId)) job.supplyReceipts.push({ operationId: active.operationId, at: new Date(now()).toISOString(), withdrawn: copy(response.withdrawn ?? []), returned: copy(response.returned ?? []) })
    note('supplies_restocked', { withdrawn: response.withdrawn, returned: response.returned })
    job.supplyRestock = null; lastInventory = totals(items(adapter.getState()) ?? [])
    clearWorkDeferred([...TOOL_WAIT]); job.miningEquipmentPending = true
    await save('supply_completed'); setState(active.resumeTo ?? resumeTo)
    return true
  }
  function hasStorageOption () {
    return !!job.portableStorage || !shulkerOnly && !!job.config.inventory.storage?.length || typeof adapter.storeCarried === 'function' && !!cargoSelection(items(adapter.getState()), { excludedShulkerKeys: [...(job.exhaustedShulkerKeys ?? []), ...storageSupplyExclusions(job.config.inventory.supplyBoxes)] })
  }

  const storagePoint = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
  function protectStorageCells (positions, stand = null) {
    const boxes = job.config.permissions.protectedRegion ??= []
    let changed = false
    for (const p of positions) {
      if (!storagePoint(p)) throw new Error('Carried storage needs exact block positions')
      if (boxes.some(b => b.xMin === p.x && b.xMax === p.x && b.zMin === p.z && b.zMax === p.z && b.yMin <= p.y - 1 && b.yMax >= p.y)) continue
      boxes.push({ xMin: p.x, xMax: p.x, yMin: p.y - 1, yMax: p.y, zMin: p.z, zMax: p.z, source: 'quarry_storage' })
      changed = true
    }
    // A saved interaction stand remains useful only while its supporting cell
    // survives. Protect the floor alone so the bot may still walk onto it.
    if (storagePoint(stand) && !boxes.some(b => b.xMin <= stand.x && b.xMax >= stand.x && b.zMin <= stand.z && b.zMax >= stand.z && b.yMin <= stand.y - 1 && b.yMax >= stand.y - 1)) {
      boxes.push({ xMin: stand.x, xMax: stand.x, yMin: stand.y - 1, yMax: stand.y - 1, zMin: stand.z, zMax: stand.z, source: 'quarry_storage_stand' })
      changed = true
    }
    if (changed) rebuildPlanner()
  }

  function registerCarriedStorage (entries, active) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('Placed carried chest lacks its storage receipt')
    const list = job.config.inventory.storage ??= []
    for (const entry of entries) {
      const positions = entry.slotCount === 54 ? entry.pairedPositions : [entry.position]
      if (!storagePoint(entry.position) || !Array.isArray(positions) || positions.length !== (active.selection.kind === 'double_chest' ? 2 : 1) || !positions.every(storagePoint) || !positions.some(p => posKey(p) === posKey(entry.position))) throw new Error('Carried chest footprint is unconfirmed')
      if (positions.length === 2 && (entry.slotCount !== 54 || positions[0].y !== positions[1].y || Math.abs(positions[0].x - positions[1].x) + Math.abs(positions[0].z - positions[1].z) !== 1)) throw new Error('Double chest must have two adjacent confirmed cells')
      if (positions.some(p => !(active.checkpoint?.placed ?? []).some(c => c.name === 'minecraft:chest' && c.confirmedBy === 'server_block_and_inventory' && posKey(c.position) === posKey(p)))) throw new Error('Carried chest lacks this operation placement ownership receipts')
      if (positions.some(p => { const b = adapter.getBlock(p.x, p.y, p.z); return b?.known !== true || nameOf(b) !== 'chest' })) throw new Error('Carried chest blocks are not received from the server')
      const record = { ...copy(entry), slotCount: positions.length === 2 ? 54 : 27, addedBy: 'carried', operationId: active.operationId }
      const prior = list.findIndex(st => posKey(st.position) === posKey(record.position))
      if (prior < 0) list.push(record); else list[prior] = { ...list[prior], ...record }
      protectStorageCells(positions, entry.stand)
    }
    rebuildPlanner()
  }

  async function capacityWork (myEpoch, context, options) {
    const normalMineReceipt = async ({ actionId, decision }, reconcile = false) => {
      guard(myEpoch)
      const rec = job.actions.find(action => action.type === 'mine' && action.capacityActionId === actionId)
      if (!rec) return { actionId, status: 'not_started', serverConfirmed: true }
      const expected = new Set(decision.targets.map(t => `${t.position.x},${t.position.y},${t.position.z}`))
      if (!rec.targets?.length || rec.targets.some(t => !expected.has(`${t.x},${t.y},${t.z}`))) return { actionId, status: 'unknown', serverConfirmed: false }
      if (!rec.results && reconcile) {
        const blocks = rec.targets.map(t => adapter.getBlock(t.x, t.y, t.z))
        if (blocks.some(b => b?.known !== true)) return { actionId, status: 'unknown', serverConfirmed: false }
        if (!blocks.some(b => AIR.has(nameOf(b)) && !b.extra?.length)) return { actionId, status: 'pending', serverConfirmed: false }
        confirmMined(rec, rec.targets.map(t => ({ ...t, expectedName: t.name })))
        rec.status = 'partial'; await save('capacity_mine_reconciled')
      }
      const confirmedTargets = (rec.results ?? []).filter(r => r.result === 'removed').map(r => { const [x, y, z] = r.position.split(',').map(Number); return { x, y, z } })
      return { actionId, status: confirmedTargets.length === decision.targets.length ? 'completed' : 'partial', serverConfirmed: confirmedTargets.length > 0, confirmedTargets, recordId: rec.id }
    }
    const controller = createQuarryCapacityBatch({
      getState: () => guard(myEpoch), getBlock: (x, y, z) => planningBlocks(job.config)(x, y, z), ...context.ports,
      reconcileMine: request => normalMineReceipt(request, true),
      mineBatch: async request => {
        const existing = await normalMineReceipt(request)
        if (existing.status !== 'not_started') return existing
        await mine(myEpoch, request.decision, { capacityActionId: request.actionId })
        setState('PORTABLE_STORAGE')
        return normalMineReceipt(request)
      },
      collectBatch: async ({ actionId, checkpoint }, { onCheckpoint }) => {
        const received = new Map((checkpoint?.receivedDrops ?? []).map(d => [String(d.runtimeId), copy(d)]))
        const capture = async actors => {
          let changed = false
          for (const e of actors.filter(e => e.kind === 'item' && e.position)) {
            if (!permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }).allowed) continue
            if (typeof e.name !== 'string' || !Number.isSafeInteger(e.count) || e.count < 1) throw Object.assign(new Error('Received drop details are unknown'), { code: 'CAPACITY_DROP_EVIDENCE_INVALID' })
            const id = String(e.runtimeId), previous = received.get(id)
            if (previous && nameOf(previous.name) !== nameOf(e.name)) throw Object.assign(new Error('Drop identity changed'), { code: 'CAPACITY_DROP_EVIDENCE_INVALID' })
            if (!previous || previous.count < e.count) { received.set(id, { runtimeId: id, name: e.name, count: e.count }); changed = true }
          }
          if (changed) await onCheckpoint({ receivedDrops: [...received.values()] })
        }
        for (let round = 0; round < 4; round++) {
          guard(myEpoch); await capture(adapter.entities())
          await collect(myEpoch, 'capacity_batch', { onObservation: capture })
          setState('PORTABLE_STORAGE'); await sleep(250)
        }
        guard(myEpoch)
        const actors = adapter.entities(); await capture(actors)
        const live = new Set(actors.filter(e => e.kind === 'item').map(e => String(e.runtimeId)))
        return { actionId, serverConfirmed: true, receivedDrops: [...received.values()], pendingDropIds: [...received.keys()].filter(id => live.has(id)) }
      }, now
    })
    return controller.workWithContainer(context, options)
  }

  async function storeCarried (myEpoch, why, depositLimit = null, capacityDecision = null) {
    const state = guard(myEpoch); const inv = items(state)
    if (!inv) { await sleep(300); return true }
    const feet = feetCell(state), head = { ...feet, y: feet.y + 1 }
    if (!permits(regions, 'travel', feet).allowed || !permits(regions, 'travel', head).allowed) {
      if (Array.isArray(job.config.permissions.travelRegion)) { await finish('PAUSED', 'OUTSIDE_TRAVEL_REGION', { pauseDetails: { feet, head, phase: 'carried_storage' } }); return true }
      // Storage recovery may follow a combat escape. Rebuild only automatic
      // travel permissions; keep every mining exclusion and earned depth.
      rebuildPlanner(); note('storage_travel_rebound', { feet })
    }
    const capacity = !!capacityDecision || job.portableStorage?.purpose === 'capacity_batch'
    const deposits = capacity ? [] : job.portableStorage?.depositLimit ?? depositLimit ?? keepPlan(inv, inventoryPolicy()).deposits
    if (!job.portableStorage && !deposits.length && !capacity) return false
    if (typeof adapter.storeCarried !== 'function') {
      if (job.portableStorage) { await finish('PAUSED', 'CARRIED_STORAGE_UNAVAILABLE'); return true }
      return false
    }
    const selection = job.portableStorage?.selection ?? cargoSelection(inv, { excludedShulkerKeys: [...(job.exhaustedShulkerKeys ?? []), ...storageSupplyExclusions(job.config.inventory.supplyBoxes)] })
    if (!selection) return false
    if (shulkerOnly && selection.kind !== 'shulker') throw new QuarryInterrupt('LEGACY_CHEST_STORAGE')
    if (capacity && selection.kind !== 'shulker') return false
    const markerDirt = capacity && job.config.exit?.mode === 'adjacent_pillar'
    const markerReserve = job.config.initialLoadout === 'v22' && deferredExitSupplies() && !job.egressPreparation ? 0 : Math.max(192, job.config.inventory.keepExitDirt ?? 192)
    if (!job.portableStorage && markerDirt && dirtCount(inv) <= markerReserve) { await finish('PAUSED', 'CAPACITY_MARKER_MATERIAL_MISSING'); return true }
    if (!job.portableStorage) {
      job.portableStorageSequence = (job.portableStorageSequence ?? 0) + 1
      job.portableStorage = { operationId: `${job.config.jobId}:storage:${job.portableStorageSequence}`, selection: copy(selection), checkpoint: null, why, ...(depositLimit ? { depositLimit: copy(depositLimit) } : {}), ...(capacity ? { purpose: 'capacity_batch', capacityBatch: { decision: copy(capacityDecision), beforePlacementItems: copy(inv), inventoryPolicy: copy(inventoryPolicy()), markerDirt } } : {}) }
      await save('carried_storage_intent')
    }
    const owner = job; const active = job.portableStorage
    const rec = recordAction({ type: 'carried_storage', operationId: active.operationId, kind: selection.kind, why: active.why })
    setState(why === 'manual' ? 'PORTABLE_STORAGE' : 'DEPOSIT')
    const callState = guard(myEpoch), startSequence = adapter.userControlInterruption?.()?.sequence ?? 0, startedAt = now()
    let checkpointOpen = true, checkpointTail = Promise.resolve(), checkpointFailure = null, callbackCount = 0
    const commitCheckpoint = async checkpoint => {
      if (job !== owner || job.portableStorage !== active || checkpoint?.operationId !== active.operationId || checkpoint?.jobId !== owner.config.jobId || checkpoint?.kind !== selection.kind) throw new Error('Carried storage checkpoint belongs to another operation')
      const priorCheckpoint = active.checkpoint
      active.checkpoint = copy(checkpoint)
      if (selection.kind !== 'shulker') {
        const placed = (checkpoint.placed ?? []).filter(c => c.name === 'minecraft:chest' && storagePoint(c.position)).map(c => c.position)
        if (placed.length) protectStorageCells(placed, checkpoint.stand)
      }
      // Delayed confirmed receipts may still be saved after a manual stop, but
      // can never overwrite a replacement job or a later storage operation.
      try { await save('carried_storage_checkpoint') } catch (error) { active.checkpoint = priorCheckpoint; throw error }
    }
    const onCheckpoint = checkpoint => {
      if (!checkpointOpen) return Promise.reject(new Error('STORAGE_STALE_CHECKPOINT'))
      callbackCount++
      const captured = copy(checkpoint)
      const pending = checkpointTail.then(() => commitCheckpoint(captured))
      checkpointTail = pending.catch(error => { checkpointFailure ??= error })
      return pending
    }
    const combatEvidence = () => {
      const s = adapter.getState(), evidence = adapter.userControlInterruption?.()
      if (!job.config.quarryCombat.enabled || job !== owner || job.portableStorage !== active || epoch !== myEpoch || job.userRunIntent !== 'running' || !ACTIVE.has(job.state) || s?.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || !(s.health > 0) || scopeOf(s) !== scopeOf(callState) || lifeOf(s) !== lifeOf(callState)) return null
      if (evidence?.preemptionStarted !== true || evidence.kind !== 'combat' || !Number.isSafeInteger(evidence.sequence) || evidence.sequence <= startSequence || evidence.jobId !== owner.config.jobId || evidence.operationId !== active.operationId || evidence.epoch !== myEpoch || evidence.scope !== scopeOf(callState) || evidence.life !== lifeOf(callState) || !Number.isFinite(evidence.claimedAt) || evidence.claimedAt < startedAt || evidence.claimedAt > now()) return null
      return copy(evidence)
    }
    let result
    try {
      let callFailure = null
      try { result = await call(myEpoch, 'carried_storage', async signal => {
        try { return await adapter.storeCarried({ jobId: owner.config.jobId, operationId: active.operationId, selection: copy(selection), deposits, inventoryPolicy: copy(inventoryPolicy()), checkpoint: copy(active.checkpoint), ...(!capacity && active.why === 'full' && passivePickup() && fullOnlyStorage() ? { allowRecoverySpace: true } : {}), ...(capacity ? { purpose: 'capacity_batch', capacityBatch: copy(active.capacityBatch) } : {}) }, {
        signal, onCheckpoint,
        ...(capacity ? { capacityWork: (context, options) => capacityWork(myEpoch, context, options) } : {}),
        canPlace: p => storagePoint(p) && !(job.config.boundarySeal?.closeOpenings && regions.seal.columns.has(`${p.x},${p.z}`)) && permits(regions, 'travel', p).allowed && permits(regions, 'travel', { ...p, y: p.y + 1 }).allowed && !planner.isStairCell(p) && !planner.isStairCell({ ...p, y: p.y - 1 })
        }) } finally { checkpointOpen = false }
      }, { drain: true }) } catch (error) { callFailure = error; result = error.drainedResult ?? null }
      checkpointOpen = false
      await checkpointTail
      guard(myEpoch, { combat: false })
      if (checkpointFailure) throw checkpointFailure
      if (result?.checkpoint) {
        if (callbackCount && !isDeepStrictEqual(result.checkpoint, active.checkpoint)) throw new Error('STORAGE_FINAL_CHECKPOINT_CHANGED')
        if (!isDeepStrictEqual(result.checkpoint, active.checkpoint)) await commitCheckpoint(result.checkpoint)
      }
      guard(myEpoch, { combat: false })
      const originalReason = result?.reason ?? callFailure?.drainedError?.message ?? callFailure?.message
      const stopped = result?.details, mine = stopped?.mining, cp = active.checkpoint, owned = cp?.placed?.length === 1 ? cp.placed[0] : null, target = mine?.target
      const ownedMiningStop = result?.status === 'blocked' && result.reason === 'STORAGE_BREAK_FAILED' && stopped?.kind === 'owned_shulker_mining_stop' && stopped.operationId === active.operationId && isDeepStrictEqual(stopped.scope, cp?.scope) && selection.kind === 'shulker' && cp?.stage === 'breaking' && cp.intent?.type === 'break' && owned?.confirmedBy === 'server_block_and_inventory' && samePoint(cp.intent.position, owned?.position) && mine?.phase === 'stopped' && mine.reason === 'user_behavior' && mine.operation === 'owned_shulker' && mine.completedCount === 0 && mine.remainingCount === 1 && target?.accessPreparation === 'owned_shulker' && target.ownershipKey === active.operationId && target.expectedName === owned.name && target.expectedRuntimeId === owned.runtimeId && samePoint(target, owned.position)
      // A wrapped break error is safe to reclassify only with both the exact
      // primitive stop and the same action's actual combat preemption receipt.
      const miningPreemption = ownedMiningStop ? combatEvidence() : null
      const cancelOnly = ['user_behavior', 'STORAGE_ABORTED', 'ABORTED'].includes(originalReason) || !!miningPreemption
      const criticalResult = result?.status === 'blocked' && !cancelOnly
      const criticalChildError = callFailure?.drainedError && !['user_behavior', 'STORAGE_ABORTED', 'ABORTED'].includes(callFailure.drainedError.code ?? callFailure.drainedError.message)
      const successfulReturn = (['completed', 'full'].includes(result?.status) && result.serverConfirmed === true && (selection.kind !== 'shulker' || result.recovered === true)) || (result?.status === 'replan' && result.serverConfirmed === false && result.checkpoint?.stage === 'planned' && result.checkpoint.intent == null)
      const liveOwnerLoss = successfulReturn && adapter.combatActive()
      const evidence = !criticalResult && !criticalChildError && (cancelOnly || callFailure?.code === 'COMBAT' || liveOwnerLoss) ? miningPreemption ?? combatEvidence() : null
      if (evidence) {
        rec.status = 'interrupted'; rec.result = copy(result ?? { status: 'blocked', reason: originalReason, checkpoint: active.checkpoint })
        note('storage_combat_interrupted', { operationId: active.operationId, originalReason: originalReason ?? 'COMBAT', ...(miningPreemption ? { miningReason: mine.reason } : {}), sequence: evidence.sequence })
        suspendForCombat({ reason: 'storage_user_preemption', originalReason: originalReason ?? 'COMBAT', ...(miningPreemption ? { storageCause: copy(stopped) } : {}), operationId: active.operationId, combatEvidence: evidence })
        return true
      }
      if (callFailure && !criticalResult) throw callFailure.drainedError ?? callFailure
      if (!criticalResult) guard(myEpoch)
      if (result?.status === 'replan' && result.serverConfirmed === false && result.checkpoint?.stage === 'planned' && result.checkpoint.intent == null && !result.checkpoint.placed?.length) {
        rec.status = 'replanned'; rec.result = copy(result)
        note('carried_storage_site_replanned', { operationId: active.operationId, rejected: result.checkpoint.rejectedPlacementSites?.length ?? 0 })
        setState('RETURN'); return true
      }
      const openRetries = active.openRetries === undefined ? 0 : active.openRetries
      const openRetryScope = cp?.scope && ['profile', 'dimension', 'connectionId', 'startedAt'].every(field => cp.scope[field] === callState[field]) && cp.scope.realmId === String(callState.realm?.id) && cp.scope.runtimeEntityId === String(callState.runtimeEntityId) && cp.scope.life === lifeOf(callState)
      // Opening a confirmed, untouched box can be retried without replaying a
      // placement or transfer. Preserve the failed attempt; the next normal
      // storage call still requires a fresh GUI and exact contents evidence.
      if (!callFailure && !capacity && selection.kind === 'shulker' && result?.status === 'blocked' && result.reason === 'サーバーから設置・使用の完了を確認できませんでした。' && result.serverConfirmed === false && result.recovered === false && Array.isArray(result.deposited) && result.deposited.length === 0 && cp?.kind === 'shulker' && cp.purpose == null && cp.stage === 'placed' && cp.intent == null && cp.recovered == null && cp.opened !== true && cp.windowId == null && cp.initialContents && cp.initialContentsVerified == null && cp.positions?.length === 1 && cp.placed?.length === 1 && owned?.confirmedBy === 'server_block_and_inventory' && samePoint(owned.position, cp.positions[0]) && Number.isSafeInteger(owned.runtimeId) && owned.runtimeId >= 0 && owned.runtimeId <= 4294967295 && Array.isArray(cp.deposited) && cp.deposited.length === 0 && Array.isArray(cp.plan) && cp.plan.length > 0 && cp.plan.every(entry => Number.isSafeInteger(entry.count) && entry.count > 0 && entry.transferred === 0) && openRetryScope && Number.isSafeInteger(openRetries) && openRetries >= 0 && openRetries < 2) {
        guard(myEpoch)
        active.openRetries = openRetries + 1
        rec.status = 'blocked'; rec.result = copy(result)
        await save('storage_open_retry_pending')
        guard(myEpoch)
        note('storage_open_retry', { operationId: active.operationId, attempt: active.openRetries })
        setState('RETURN'); await sleep(200); return true
      }
      if (result?.status === 'blocked' && result.reason === 'STORAGE_SOURCE_REJECTED' && cp?.stage === 'depositing' && cp.intent?.type === 'deposit' && cp.intent.rejectionProof?.protocolStatusCode === 49 && (active.sourceRejectionRetries ?? 0) < 2) {
        guard(myEpoch)
        active.sourceRejectionRetries = (active.sourceRejectionRetries ?? 0) + 1
        rec.status = 'interrupted'; rec.result = copy(result)
        await save('storage_source_rejection_pending')
        guard(myEpoch)
        note('storage_source_rejection_retry', { operationId: active.operationId, attempt: active.sourceRejectionRetries, requestId: cp.intent.rejectionProof.requestId })
        setState('RETURN'); await sleep(200); return true
      }
      if (!['completed', 'full'].includes(result?.status) || result.serverConfirmed !== true || selection.kind === 'shulker' && result.recovered !== true) {
        rec.status = 'blocked'; rec.result = copy(result)
        await finish('PAUSED', 'CARRIED_STORAGE_BLOCKED', { pauseDetails: { reason: result?.reason ?? 'UNCONFIRMED_RESULT', operationId: active.operationId, kind: selection.kind, ...(result?.details ? { details: copy(result.details) } : {}) } })
        return true
      }
      if (selection.kind !== 'shulker') registerCarriedStorage(result.storage, active)
      const receipts = job.carriedStorageReceipts ??= []
      if (!receipts.includes(active.operationId)) {
        for (const d of result.deposited ?? []) {
          if (typeof d.name !== 'string' || !Number.isSafeInteger(d.count) || d.count < 1 || isShulkerBox(d.name)) throw new Error('Carried storage transfer receipt is invalid')
          ledger.add('deposited', d.name, d.count)
        }
        receipts.push(active.operationId)
        if (receipts.length > 128) receipts.splice(0, receipts.length - 128)
      }
      if (selection.kind === 'shulker' && result.status === 'full') {
        if (!Array.isArray(result.exhaustedShulkerKeys) || !result.exhaustedShulkerKeys.length || !result.exhaustedShulkerKeys.every(k => typeof k === 'string' && k.length)) throw new Error('Recovered full shulker lacks its current inventory identity')
        job.exhaustedShulkerKeys = [...new Set([...(job.exhaustedShulkerKeys ?? []), ...result.exhaustedShulkerKeys])].slice(-128)
      } else if (selection.kind !== 'shulker' && result.status === 'full') {
        job.fullStorage = [...new Set([...(job.fullStorage ?? []), ...result.storage.map(st => posKey(st.position))])]
      }
      rec.status = 'confirmed'; rec.result = copy(result)
      job.portableStorage = null
      rebuildPlanner()
      const fresh = items(guard(myEpoch))
      if (!fresh) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
      lastInventory = totals(fresh)
      await save('carried_storage_done')
      note('carried_storage_done', { kind: selection.kind, status: result.status, operationId: active.operationId, deposited: (result.deposited ?? []).reduce((n, d) => n + d.count, 0) })
      const remaining = keepPlan(fresh, inventoryPolicy()).deposits.length
      if (remaining && result.status === 'completed' && !(result.deposited?.length)) {
        await finish('PAUSED', 'CARRIED_STORAGE_NO_PROGRESS', { pauseDetails: { operationId: active.operationId, kind: selection.kind } })
        return true
      }
      if (why === 'final') {
        if (!remaining) setState('FINAL_CHECK', { finalDeposited: true })
        else setState('RETURN')
      } else if (!remaining && freeSlots(fresh) >= job.config.inventory.minFreeSlots) setState('SURVEY')
      else setState('RETURN')
      return true
    } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      await finish('PAUSED', 'CARRIED_STORAGE_FAILED', { pauseDetails: { operationId: active.operationId, kind: selection.kind, error: rec.error.slice(0, 200) } })
      return true
    } finally { checkpointOpen = false }
  }

  async function returnAndDeposit (myEpoch, why) {
    if (!job.portableStorage && !job.supplyRestock) { await applyStorageConfiguration(); guard(myEpoch) }
    // Re-evaluate actual room after safety travel or a completed box. Full-only
    // never starts a new storage operation merely because RETURN was queued.
    if (fullOnlyStorage() && !job.portableStorage) {
      const inventory = items(guard(myEpoch))
      if (!inventory) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
      if (freeSlots(inventory) > 0) {
        if (why === 'final') { recordFinalStorageSkip(inventory); setState('FINAL_CHECK') }
        else setState(healthRatio(adapter.getState()) < job.config.safety.resumeHealthRatio ? 'RECOVER' : 'SURVEY')
        return
      }
    }
    if (await storeCarried(myEpoch, why)) return
    if (shulkerOnly || !job.config.inventory.storage?.length) {
      const inventory = items(guard(myEpoch)), free = inventory ? freeSlots(inventory) : null
      // Passive pickup + full-only storage: once every carried storage box is
      // full, the user's "dig through first" policy keeps mining; new drops are
      // simply not picked up (natural pickup fails on a full bag) and are
      // recorded, instead of pausing the job (live 2026-11-10 12:16).
      const noBox = inventory && keepPlan(inventory, inventoryPolicy()).deposits.length && !cargoSelection(inventory, { excludedShulkerKeys: [...(job.exhaustedShulkerKeys ?? []), ...storageSupplyExclusions(job.config.inventory.supplyBoxes)] })
      if (passivePickup() && fullOnlyStorage() && noBox) {
        if (!job.storageExhausted) { job.storageExhausted = { at: new Date(now()).toISOString(), freeSlots: free }; note('storage_exhausted', { freeSlots: free }); await save('storage_exhausted') }
        if (why === 'final') { recordFinalStorageSkip(inventory); setState('FINAL_CHECK') } else setState('SURVEY')
        return
      }
      return finish('PAUSED', fourLayerStorage() ? 'CARGO_CAPACITY_EXHAUSTED' : 'WAITING_FOR_STORAGE', { pauseDetails: { reason: inventory && !keepPlan(inventory, inventoryPolicy()).deposits.length ? 'NO_DEPOSITABLE_ITEMS' : 'NO_CARRIED_STORAGE', freeSlots: free, minFreeSlots: job.config.inventory.minFreeSlots } })
    }
    let st = currentStorage()
    if (!st) {
      // Every chest is full: add one more and keep going.
      const added = await expandStorage(myEpoch)
      if (added.retry) { await sleep(100); return }
      if (!added.ok) return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'all chests full', chests: (job.config.inventory.storage ?? []).length, addChest: added } })
      st = added.storage
    }
    // A chest whose stand cannot be walked to right now is skipped like a full
    // one (retried after the next resume) instead of failing the whole action.
    try {
      // First reject storage that cannot be walked to. A hostile around an old
      // unreachable chest must not cost another 20-second wait per box.
      await previewStorageRoute(myEpoch, st)
      await waitForQuietStorage(myEpoch, st)
      // Enemy motion or knockback during the wait invalidates the preview's
      // origin; goToStorage always recomputes its ordinary path before moving.
      await goToStorage(myEpoch, st)
    } catch (error) {
      guard(myEpoch)
      if (storagePreviewBusy(error)) { await sleep(100); return }
      if (error instanceof QuarryInterrupt && error.code !== 'STORAGE_UNREACHABLE') throw error
      note('storage_unroutable', { position: st.position, error: String(error.message ?? error).slice(0, 160) })
      job.fullStorage = [...new Set([...(job.fullStorage ?? []), posKey(st.position)])]
      return
    }
    setState('DEPOSIT')
    const s = guard(myEpoch)
    const inv = items(s)
    if (!inv) { await sleep(300); return }
    const { deposits } = keepPlan(inv, inventoryPolicy())
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
      if (keepPlan(items(adapter.getState()) ?? [], inventoryPolicy()).deposits.length) { setState('RETURN'); return }
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

  // A bounded read request can fill a reconnect's missing vertical sections.
  // Its send result is never evidence: callers re-read received blocks/counts.
  async function requestTerrainObservation (myEpoch, purpose, position = null) {
    if (typeof adapter.requestTerrain !== 'function') return false
    const state = guard(myEpoch); const scope = scopeOf(state); const life = lifeOf(state)
    let observation = job.terrainObservation
    if (!observation || observation.scope !== scope || observation.life !== life) observation = job.terrainObservation = { scope, life, requests: 0, purpose, waiting: false, waitUntil: null, phase: 'idle' }
    const wait = async () => { while (observation.waitUntil > now()) { await sleep(Math.min(250, observation.waitUntil - now())); guard(myEpoch) }; observation.waiting = false; observation.waitUntil = null }
    // Yield during the wait, but do not rescan the complete 123-layer quarry
    // every 250ms while a terrain response is still in flight.
    if (observation.waiting && observation.waitUntil > now()) { await wait(); return true }
    observation.waiting = false; observation.waitUntil = null
    if (observation.requests >= TERRAIN_OBSERVATION_MAX_REQUESTS) { observation.phase = 'exhausted'; return false }
    const requestTop = purpose === 'egress' ? regions.worldMaxY : job.yTop
    observation.requests++; observation.purpose = purpose; observation.requestedAt = now(); observation.lastError = null; observation.phase = 'requested'; observation.requestTop = requestTop
    if (purpose === 'boundary') observation.position = copy(position ?? null)
    await save('terrain_request_intent')
    try { await call(myEpoch, 'request_terrain', signal => adapter.requestTerrain({ config: copy(job.config), yTop: requestTop, yBottom: regions.yBottom }, { signal })) } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      observation.lastError = String(error.message ?? error).slice(0, 200)
      note('terrain_request_failed', { purpose, attempt: observation.requests, error: observation.lastError })
    }
    guard(myEpoch)
    observation.waiting = true; observation.waitUntil = now() + TERRAIN_OBSERVATION_WAIT_MS; observation.phase = 'waiting'
    note('terrain_requested', { purpose, attempt: observation.requests, yBottom: regions.yBottom, yTop: job.yTop, requestTop })
    await save('terrain_requested')
    await wait()
    return true
  }

  function layerUnknown (y) {
    let n = 0
    for (const column of regions.columns) { const [x, z] = column.split(',').map(Number); if (adapter.getBlock(x, y, z)?.known !== true) n++ }
    return n
  }
  // Unknown is never treated as safe: the layer is requested again a bounded
  // number of times, and work continues only once the cells actually arrive.
  async function retryLayerTerrain (myEpoch, y) {
    if (typeof adapter.requestTerrain !== 'function' || !Number.isSafeInteger(y)) return false
    const state = guard(myEpoch), scope = scopeOf(state), life = lifeOf(state)
    let t = job.layerTerrain
    if (!t || t.y !== y || t.scope !== scope || t.life !== life) t = job.layerTerrain = { y, scope, life, requests: 0 }
    if (t.requests >= TERRAIN_LAYER_WAITS_MS.length) { note('terrain_layer_unobserved', { y, requests: t.requests, unknown: layerUnknown(y) }); return false }
    const waitMs = TERRAIN_LAYER_WAITS_MS[t.requests]
    t.requests++; t.requestedAt = now()
    note('terrain_layer_requested', { y, attempt: t.requests, unknown: layerUnknown(y) })
    await save('terrain_layer_request')
    try { await call(myEpoch, 'request_terrain', signal => adapter.requestTerrain({ config: copy(job.config), yTop: job.yTop, yBottom: regions.yBottom }, { signal })) } catch (error) {
      if (error instanceof QuarryInterrupt) throw error
      t.lastError = String(error.message ?? error).slice(0, 200)
    }
    const until = now() + waitMs
    while (now() < until) { await sleep(Math.min(250, Math.max(0, until - now()))); guard(myEpoch); if (layerUnknown(y) === 0) break }
    return true
  }
  // Ask early for the next layers while the current one is dug; it only sends
  // requests and never marks anything received.
  function prefetchTerrain (y) {
    if (typeof adapter.requestTerrain !== 'function' || !Number.isSafeInteger(y)) return
    if (job.terrainPrefetchAt && now() - job.terrainPrefetchAt < TERRAIN_PREFETCH_INTERVAL_MS) return
    const ahead = [y - 1, y - 2].filter(v => v >= regions.yBottom)
    if (!ahead.some(v => layerUnknown(v) > 0)) return
    job.terrainPrefetchAt = now()
    note('terrain_prefetch', { y: ahead[0] })
    Promise.resolve().then(() => adapter.requestTerrain({ config: copy(job.config), yTop: job.yTop, yBottom: regions.yBottom })).catch(() => {})
  }

  // Nothing placed, nothing withdrawn or returned, no transfer pending: the
  // restock can start over from the beginning without any received evidence lost.
  function supplyUntouched (cp) {
    if (!cp) return true
    if ((cp.withdrawn ?? []).length || (cp.returned ?? []).length) return false
    const child = cp.child
    if (!child) return true
    return !(child.placed ?? []).length && !(child.deposited ?? []).length && !child.intent && !child.supplyCheckpoint?.intent && !(child.supplyCheckpoint?.withdrawn ?? []).length && !(child.supplyCheckpoint?.returned ?? []).length
  }

  async function makeSupplyRoom (myEpoch, active) {
    active.roomAttempts = (active.roomAttempts ?? 0) + 1
    if (active.roomAttempts > SUPPLY_ROOM_MAX_ATTEMPTS || typeof adapter.place !== 'function' || typeof adapter.equip !== 'function') return false
    let inventory = items(guard(myEpoch))
    if (!inventory) return false
    const roomPolicy = job.config.initialLoadout === 'v22' && deferredExitSupplies() ? inventoryPolicy() : job.config.inventory
    const keepDirt = (roomPolicy?.keepExitDirt ?? 192) + (roomPolicy?.keepSealBlocks ?? 32)
    const dirtTotal = inventory.filter(i => nameOf(i.name) === 'dirt' && i.slot >= 0 && i.slot < 36).reduce((n, i) => n + i.count, 0)
    const pick = inventory.filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < 36 && i.count > 0 && i.count <= SUPPLY_ROOM_MAX_BLOCKS && SEAL_MATERIALS.includes(nameOf(i.name)) && (nameOf(i.name) !== 'dirt' || dirtTotal - i.count >= keepDirt)).sort((a, b) => a.count - b.count || a.slot - b.slot)[0]
    if (!pick) { note('supply_room_unavailable', {}); return false }
    const material = nameOf(pick.name)
    let slot = pick.slot
    // A supply box left open by the blocked restock is closed first: the
    // normal inventory refuses a hotbar move while a container is open.
    adapter.closeContainer?.()
    if (slot > 8) {
      await call(myEpoch, 'equip_seal', signal => adapter.equip(slot, { signal }))
      inventory = items(guard(myEpoch))
      const moved = inventory?.find(i => i.slot >= 0 && i.slot <= 8 && nameOf(i.name) === material && i.count === pick.count && (pick.stackId == null || i.stackId === pick.stackId))
      if (!moved) return false
      slot = moved.slot
    }
    const home = feetCell(guard(myEpoch))
    // Only into dug cells of the excavated range, so the blocks are mined again.
    if (home.y > job.yTop || home.y < regions.yBottom) return false
    // Dug cells of this level that can take a block (received air over a
    // received solid floor); a stack larger than these is not attempted.
    const roomCells = () => {
      const out = []
      for (const column of regions.columns) {
        const [x, z] = column.split(',').map(Number)
        const b = adapter.getBlock(x, home.y, z), below = adapter.getBlock(x, home.y - 1, z)
        if (b?.known === true && AIR.has(nameOf(b)) && !b.extra?.length && below?.known === true && below.boundingBox === 'block') out.push({ x, y: home.y, z })
      }
      return out
    }
    if (roomCells().length < pick.count + 2) { note('supply_room_unavailable', { reason: 'FEW_DUG_CELLS', count: pick.count }); return false }
    let placed = 0, moved = false
    for (let n = 0; n < pick.count; n++) {
      inventory = items(guard(myEpoch))
      const current = inventory?.find(i => i.slot === slot)
      if (!current || nameOf(current.name) !== material || current.count < 1) break
      const feet = feetCell(guard(myEpoch))
      const cells = roomCells().filter(c => !(c.x === feet.x && c.z === feet.z) && !(c.x === home.x && c.z === home.z))
      cells.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
      // Prefer a placement from where the bot stands; otherwise walk to another
      // stance of this level that can place one (the box is reached again after).
      let decision = null, fallback = null
      for (const p of cells.slice(0, 32)) {
        const d = await planner.previewSealPlacement({ position: p, purpose: 'temporary', materialRequired: material, slot }, feet, inventory)
        guard(myEpoch)
        if (!d?.action || !d.stance) continue
        if (d.stance.x === feet.x && d.stance.y === feet.y && d.stance.z === feet.z) { decision = d; break }
        if (!fallback && d.stance.y === home.y && !(d.stance.x === home.x && d.stance.z === home.z)) fallback = d
      }
      if (!decision && fallback) {
        try { await moveToStance(myEpoch, fallback.stance); moved = true } catch (error) { if (error instanceof QuarryInterrupt) throw error; break }
        const at = feetCell(guard(myEpoch))
        if (at.x !== fallback.stance.x || at.y !== fallback.stance.y || at.z !== fallback.stance.z) break
        decision = await planner.previewSealPlacement({ position: fallback.position, purpose: 'temporary', materialRequired: material, slot }, at, items(guard(myEpoch)))
        if (!decision?.action || !(decision.stance.x === at.x && decision.stance.y === at.y && decision.stance.z === at.z)) break
      }
      if (!decision) break
      const rec = recordAction({ type: 'place', purpose: 'supply_room', position: decision.position, material: decision.material })
      await save('supply_room_intent')
      try {
        await call(myEpoch, 'place', signal => adapter.place({ position: decision.position, slot: decision.slot, clicked: decision.clicked, face: decision.face, point: decision.point, expectedBlock: 'minecraft:' + material }, { signal }))
      } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        rec.status = 'failed'; rec.error = String(error.message ?? error).slice(0, 200); break
      }
      const b = adapter.getBlock(decision.position.x, decision.position.y, decision.position.z)
      const after = items(guard(myEpoch))?.find(i => i.slot === slot)
      const left = after && nameOf(after.name) === material ? after.count : 0
      if (!(b?.known === true && nameOf(b) === material) || left !== current.count - 1) { rec.status = 'unconfirmed'; break }
      rec.status = 'confirmed'; rec.confirmedBy = 'server_block_and_inventory'
      planner.recordPlacement(decision.position, 'temporary', decision.material)
      countsRevision++; ledger.add('placedTemporary', decision.material); placed++
    }
    // Back to the supply stand the restock was using.
    if (moved) { try { await moveToStance(myEpoch, home) } catch (error) { if (error instanceof QuarryInterrupt) throw error } }
    const back = feetCell(guard(myEpoch))
    const freed = !(items(guard(myEpoch)) ?? []).some(i => i.slot === slot && i.count > 0) && back.x === home.x && back.y === home.y && back.z === home.z
    note('supply_room', { material, placed, freed, moved })
    await save('supply_room')
    return freed
  }

  function terrainObserved (purpose) {
    const observation = job.terrainObservation
    if (observation?.purpose === purpose) { observation.waiting = false; observation.waitUntil = null; observation.phase = 'observed' }
  }

  async function finalCheck (myEpoch) {
    guard(myEpoch)
    if (!job.portableStorage && !job.supplyRestock) { await applyStorageConfiguration(); guard(myEpoch) }
    if (passivePickup()) { observeInventory(job.state); observeDrops(); recordPassivePickup('final_check') }
    if (job.fluidDrain) return observeFluidDrain(myEpoch)
    if (job.surfaceReturnedAt) return finishAfterExit()
    if (job.portableStorage) return returnAndDeposit(myEpoch, job.portableStorage.why ?? 'final')
    const floorY = workFloorY()
    keepEarlierLayers(floorY)
    // Re-scan the whole range (§16.3): unknown never completes.
    const counts = planner.counts(job.yTop)
    job.finalCounts = counts
    if (counts.unknown > 0) {
      if (await requestTerrainObservation(myEpoch, 'final_check')) return
      return finish('PAUSED', 'UNOBSERVED_CELLS', { pauseDetails: counts })
    }
    terrainObserved('final_check')
    if (counts.remaining > 0) { job.cursorY = floorY; setState('SURVEY'); return }
    if (!job.finalDeposited) {
      const inventory = items(adapter.getState())
      if (!inventory) return finish('PAUSED', 'INVENTORY_UNKNOWN')
      if (!keepPlan(inventory, inventoryPolicy()).deposits.length) { job.finalDeposited = true; delete job.finalStorageSkipped }
      else if (fullOnlyStorage() && (freeSlots(inventory) > 0 || job.storageExhausted)) recordFinalStorageSkip(inventory)
      else if (hasStorageOption()) { await collect(myEpoch, 'final'); job.depositReason = 'final'; await returnAndDeposit(myEpoch, 'final'); return }
      else return finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'final deposits remain' } })
    }
    // UNREACHABLE is relative to where the bot stood; re-try from here a few
    // times before treating those cells as exceptions.
    // Same for cells put aside after transient mining refusals.
    if (planner.deferredList().some(d => Number(d.position.split(',')[1]) <= floorY && TRANSIENT_DEFER.includes(d.reason)) && (job.unreachableRetries ?? 0) < 3) {
      job.unreachableRetries = (job.unreachableRetries ?? 0) + 1
      clearWorkDeferred(TRANSIENT_DEFER)
      badStances.clear()
      note('unreachable_retry', { attempt: job.unreachableRetries })
      job.cursorY = floorY; setState('SURVEY'); return
    }
    // One last sweep for anything still lying in the area (drops that were
    // unreachable earlier, items that fell later), then store it as well.
    if (!job.finalSweepDone) {
      job.finalSweepDone = true
      const lying = adapter.entities().filter(e => e.kind === 'item' && e.position && permits(regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed).length
      if (lying && !passivePickup()) {
        note('final_sweep', { items: lying })
        if (hasStorageOption()) job.finalDeposited = false
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
    if (deferredExitSupplies() && job.config.exit?.mode === 'adjacent_pillar') {
      // The dirt box keeps the exit reserve while the quarry is in progress.
      // Withdraw only after all ordinary drops have reached the cargo boxes.
      if (!job.egressPreparation) { job.egressPreparation = true; await save('egress_dirt_intent') }
      const inv = items(guard(myEpoch))
      if (!inv) return finish('PAUSED', 'INVENTORY_UNKNOWN')
      if ((totals(inv).get('dirt') ?? 0) < Math.max(192, job.config.inventory.keepExitDirt ?? 0)) {
        if (await restock(myEpoch, 'FINAL_CHECK', true)) return
        return finish('PAUSED', 'EXIT_DIRT_WITHDRAW_BLOCKED')
      }
      if (!(await prepareExit(myEpoch))) return
    }
    if (job.config.exit?.mode === 'adjacent_pillar') {
      job.miningCompletedAt ??= new Date(now()).toISOString()
      await save('mining_completed')
      setState('EGRESS'); return
    }
    if (exceptions.length && !job.acceptedExceptions) return finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { count: exceptions.length, byReason, exceptions: exceptions.slice(0, 50) } })
    return finish(exceptions.length ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', null)
  }
  async function finishAfterExit () {
    const exceptions = exceptionsList()
    const byReason = {}
    for (const e of exceptions) { const r = e.reason ?? e.kind; byReason[r] = (byReason[r] ?? 0) + 1 }
    if (exceptions.length && !job.acceptedExceptions) return finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { count: exceptions.length, byReason, exceptions: exceptions.slice(0, 50), miningCompleted: true, surfaceReturned: true } })
    if (fourLayerStorage()) {
      const home = job.config.homeChest, owner = job
      if (!home?.position || !home.stand) return finish('PAUSED', 'FINAL_CHEST_UNKNOWN')
      if (!job.finalChest) {
        job.finalChest = { operationId: job.config.jobId + ':final_chest:1', checkpoint: null }
        await save('final_chest_intent')
      }
      const active = job.finalChest
      const myEpoch = epoch
      const current = guard(myEpoch)
      if (!samePoint(feetCell(current),home.stand)) await moveToStance(myEpoch,home.stand)
      const result = await call(myEpoch,'final_chest',signal=>adapter.finalChestDeposit({
        jobId:job.config.jobId,operationId:active.operationId,position:copy(home.position),
        checkpoint:copy(active.checkpoint)
      },{signal,onCheckpoint:async cp=>{
        if(job!==owner || job.finalChest!==active || cp.operationId!==active.operationId) throw new Error('FINAL_CHEST_STALE_CHECKPOINT')
        active.checkpoint=copy(cp);await save('final_chest_checkpoint')
      }}),{drain:true})
      guard(myEpoch)
      if(result?.status!=='completed' || result.serverConfirmed!==true) {
        return finish('PAUSED',result?.reason??'FINAL_CHEST_UNCONFIRMED',{pauseDetails:{operationId:active.operationId}})
      }
      job.finalChestStoredAt=new Date(now()).toISOString()
      await save('final_chest_verified')
    }
    await finish(exceptions.length ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', null)
    if (fourLayerStorage() && job?.state === 'FINISHED' && job.persistence?.status !== 'failed' && typeof adapter.logout === 'function') {
      try { await adapter.logout() } catch (error) { note('logout_failed',{error:String(error.message??error).slice(0,200)}) }
    }
  }

  async function egress (myEpoch) {
    const s = guard(myEpoch)
    if (job.surfaceReturnedAt) { setState('FINAL_CHECK'); return }
    if (!job.miningCompletedAt || job.config.exit?.mode !== 'adjacent_pillar') return finish('PAUSED', 'EXIT_NOT_READY')
    if (typeof adapter.egress !== 'function') return finish('PAUSED', 'EXIT_UNAVAILABLE')
    if (!job.egress?.operationId) {
      const read = planningBlocks(job.config); let unknownExitTerrain = false
      const exitBlocks = (x, y, z) => { const b = read(x, y, z); if (b?.known !== true) unknownExitTerrain = true; return b }
      const selected = planQuarryExit({ regions, yTop: job.yTop, feet: feetCell(s), getBlock: exitBlocks, inventory: items(s), policy: { ...job.config.tools, ...job.config.collection }, minFreeSlots: deferredExitSupplies() ? 0 : job.config.inventory.minFreeSlots, allowFullBag: deferredExitSupplies() || !!job.storageExhausted && passivePickup(), exit: job.config.exit, reservation: job.exitReservation?.plan ?? null, reachable: planner.reachableFrom(feetCell(s)) })
      job.egress = { phase: selected.ok ? 'planned' : 'blocked', reason: selected.reason ?? null, plan: copy(selected.plan ?? null), operationId: null, checkpoint: null, scope: scopeOf(s), life: lifeOf(s) }
      if (selected.plan) job.config.inventory.keepExitDirt = selected.plan.totalDirt
      if (!selected.ok && selected.reason === 'EXIT_COLUMN_UNAVAILABLE' && unknownExitTerrain && await requestTerrainObservation(myEpoch, 'egress')) { job.egress.phase = 'planned'; job.egress.reason = 'EXIT_TERRAIN_PENDING'; return }
      if (!unknownExitTerrain || selected.plan) terrainObserved('egress')
      if (!selected.ok) return finish('PAUSED', selected.reason, { pauseDetails: copy(selected.details ?? null) })
      job.egress.operationId = `${job.config.jobId}:egress:1`
      await save('egress_intent')
    }
    const owner = job; const active = job.egress
    // A new connection with the same life may continue the egress; the egress
    // runtime rebinds only with a server-confirmed pose on the column.
    let reconnect = false
    if (active.scope !== scopeOf(s) && active.life === lifeOf(s) && active.checkpoint) { reconnect = true; active.scope = scopeOf(s); note('egress_reconnect', { operationId: active.operationId }) }
    if (active.scope !== scopeOf(s) || active.life !== lifeOf(s)) return finish('PAUSED', 'EXIT_SCOPE_CHANGED', { pauseDetails: { operationId: active.operationId } })
    // The native mover is bounded to 12m. Supply the ordinary walking graph's
    // path so the adapter can split a far pit entrance into its existing short
    // segments. A paused entry may resume elsewhere, so never reuse its origin.
    if (!active.checkpoint || active.checkpoint.phase === 'entry') {
      const from = feetCell(guard(myEpoch)), path = planner.pathTo(from, active.plan.entry)
      if (!path) return finish('PAUSED', 'EXIT_ENTRY_UNREACHABLE', { pauseDetails: { from, entry: copy(active.plan.entry), operationId: active.operationId } })
      active.plan.entryPath = copy(path)
      await save('egress_entry_path')
    }
    const onCheckpoint = async checkpoint => {
      if (job !== owner || job.egress !== active || checkpoint?.operationId !== active.operationId || checkpoint?.jobId !== owner.config.jobId) throw new Error('Exit checkpoint belongs to another operation')
      active.checkpoint = copy(checkpoint)
      await save('egress_checkpoint')
    }
    active.phase = 'running'; active.reason = null
    const hpBefore = Number(guard(myEpoch).health), feetBefore = active.checkpoint?.confirmedFeetY ?? null
    const rec = recordAction({ type: 'egress', operationId: active.operationId, column: active.plan.column })
    const result = await call(myEpoch, 'egress', signal => adapter.egress({ jobId: owner.config.jobId, operationId: active.operationId, plan: copy(active.plan), checkpoint: copy(active.checkpoint), ...(reconnect ? { reconnect: true } : {}), ...(deferredExitSupplies() || job.storageExhausted && passivePickup() ? { allowFullInventory: true } : {}) }, { signal, onCheckpoint }))
    guard(myEpoch)
    if (result?.checkpoint) await onCheckpoint(result.checkpoint)
    rec.result = copy(result ?? null)
    if (result?.status !== 'completed' || result.serverConfirmed !== true || !active.checkpoint) {
      const reason = /^(EXIT_|EGRESS_|ASCENT_)/.test(result?.reason ?? '') ? result.reason : 'EXIT_UNCONFIRMED'
      // A combat claim that could do nothing (no target action: bow out of
      // range, no melee stance) ends within moments and leaves HP unchanged
      // (live 2026-11-10 13:43: a skeleton on a ledge 17 blocks above). The
      // climb continues instead of pausing, like work continues for bow
      // targets without a sight line. Real fights (damage, a longer
      // engagement such as an approach or a creeper) still pause the exit.
      if (/COMBAT_INTERRUPTED$/.test(reason)) {
        if (active.checkpoint?.confirmedFeetY !== feetBefore) job.egressNoopCombat = 0
        const started = now()
        while (adapter.combatActive() && now() - started < EGRESS_NOOP_COMBAT_MS) { await sleep(100); guard(myEpoch) }
        const after = guard(myEpoch)
        if (!adapter.combatActive() && now() - started < EGRESS_NOOP_COMBAT_MS && Number(after.health) >= hpBefore && (job.egressNoopCombat ?? 0) < EGRESS_NOOP_COMBAT_RETRIES) {
          job.egressNoopCombat = (job.egressNoopCombat ?? 0) + 1
          rec.status = 'interrupted'; active.phase = 'planned'; active.reason = null
          note('egress_noop_combat_continue', { count: job.egressNoopCombat, feetY: active.checkpoint?.confirmedFeetY ?? null })
          await save('egress_noop_combat')
          setState('EGRESS')
          return
        }
      }
      if (EGRESS_TRANSIENT.has(reason)) {
        if (active.checkpoint?.confirmedFeetY !== feetBefore) job.egressTransient = 0
        const after = guard(myEpoch)
        if (Number(after.health) >= hpBefore && !adapter.combatActive() && (job.egressTransient ?? 0) < EGRESS_TRANSIENT_RETRIES) {
          job.egressTransient = (job.egressTransient ?? 0) + 1
          rec.status = 'interrupted'; active.phase = 'planned'; active.reason = null
          note('egress_transient_retry', { reason, count: job.egressTransient, feetY: active.checkpoint?.confirmedFeetY ?? null })
          await save('egress_transient_retry')
          if (reason === 'ASCENT_INVENTORY_UNKNOWN' && typeof adapter.resyncInventory === 'function') { try { await adapter.resyncInventory() } catch {} ; guard(myEpoch) }
          const until = now() + EGRESS_TRANSIENT_WAIT_MS
          while (now() < until) { await sleep(100); guard(myEpoch) }
          setState('EGRESS')
          return
        }
      }
      rec.status = 'blocked'; active.phase = 'blocked'; active.reason = reason
      return finish('PAUSED', reason, { pauseDetails: { operationId: active.operationId, reason: result?.reason ?? null } })
    }
    rec.status = 'confirmed'; active.phase = 'completed'
    job.surfaceReturnedAt = new Date(now()).toISOString()
    await save('surface_returned')
    setState('FINAL_CHECK')
  }

  function exceptionsList () {
    const list = []
    for (const d of planner.deferredList()) if (!PLANNED_EXCLUSIONS.has(d.reason)) list.push({ kind: 'deferred', ...d })
    for (const t of planner.temporaryList()) { const [x, y, z] = t.position.split(',').map(Number); const b = adapter.getBlock(x, y, z); if (job.config.exit?.mode === 'adjacent_pillar' && t.purpose === 'stair' && y > job.config.exit.migrationFloorY) continue; if (b?.known && !AIR.has(nameOf(b))) list.push({ kind: 'temporary', ...t }) }
    if (job.config.exit?.mode !== 'adjacent_pillar' && (job.records?.stair || planner.exportRecords().stair)) {
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
    clearAutoResume()
    const paused = result === 'PAUSED'
    if (!paused) {
      const still = new Set(adapter.entities().filter(e => e.kind === 'item').map(e => e.runtimeId))
      for (const d of pendingDrops) ledger.add(still.has(d.runtimeId) ? 'lost' : 'unaccounted', d.name ?? 'unknown', d.count ?? 1)
      pendingDrops = []
    }
    job.result = { type: result, reason, at: new Date(now()).toISOString(), ...copy(extra) }
    job.pauseReason = paused ? reason : null
    // The pose at the pause is the reference for the next resume; an
    // unconfirmed-pose pause keeps the original reference so it is checked again.
    if (paused && reason !== 'POSITION_UNCONFIRMED') { try { const ps = adapter.getState(); job.pauseFeet = ps?.position ? feetCell(ps) : null } catch { job.pauseFeet = null } }
    if (!paused) job.userRunIntent = 'finished'
    if (!paused) combatBridge.deactivate()
    setState(paused ? 'PAUSED' : 'FINISHED', { pauseDetails: extra.pauseDetails ?? null })
    try { if (!adapter.combatActive()) await adapter.stopAll(`quarry:${result}`) } catch (error) { note('stop_failed', { error: String(error.message ?? error) }) }
    try { await save(`finish:${result}`) } catch (error) {
      // In-memory completion is not durable completion. Never publish success
      // or schedule an automatic retry over a stale running checkpoint.
      job.userRunIntent = 'paused'
      job.pauseReason = 'PERSISTENCE_FAILED'
      job.result = { type: 'PAUSED', reason: 'PERSISTENCE_FAILED', intendedResult: result, at: new Date(now()).toISOString() }
      setState('PAUSED')
    }
    if (job.persistence?.status !== 'failed' && result === 'PAUSED' && /^ACTION_FAILED/.test(String(reason)) && (job.autoResumes ?? 0) < 3 && job.userRunIntent === 'running') {
      const owner = job, expectedEpoch = epoch
      const retry = () => {
        autoResumeTimer = null
        if (job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running') return
        if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(retry, 100); autoResumeTimer.unref?.(); return }
        job.autoResumes = (job.autoResumes ?? 0) + 1; job.lastAutoResumeAt = now()
        note('auto_resume', { reason, count: job.autoResumes })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
      }
      autoResumeTimer = setTimeout(retry, autoResumeMs); autoResumeTimer.unref?.()
    }
    // Loose drops around a placed storage box (passive pickup leaves them) can
    // block its safe recovery. They despawn within minutes and nothing moves
    // while waiting, so this pause retries itself (bounded) instead of
    // stalling for hours (live 2026-11-10 05:38: 2h until a manual resume).
    const capacityWait = paused && reason === 'CARRIED_STORAGE_BLOCKED' && extra.pauseDetails?.reason === 'STORAGE_PICKUP_CAPACITY_REQUIRED'
    if (job.persistence?.status !== 'failed' && capacityWait && (job.capacityRetries ?? 0) < CAPACITY_RETRIES && job.userRunIntent === 'running') {
      const owner = job, expectedEpoch = epoch
      const retry = () => {
        autoResumeTimer = null
        if (job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running') return
        if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(retry, 100); autoResumeTimer.unref?.(); return }
        job.capacityRetries = (job.capacityRetries ?? 0) + 1
        note('capacity_wait_resume', { count: job.capacityRetries, required: extra.pauseDetails?.details?.requiredFreeSlots ?? null, free: extra.pauseDetails?.details?.freeSlots ?? null })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
      }
      autoResumeTimer = setTimeout(retry, capacityRetryMs); autoResumeTimer.unref?.()
    }
    try { adapter.onFinished?.(status()) } catch {}
  }

  // ---- operations (§4.1) -------------------------------------------------
  async function configureStorage (options = {}) {
    if (!job) throw new Error('No quarry job')
    if (!options || typeof options !== 'object' || Array.isArray(options) || !Object.keys(options).length || Object.keys(options).some(key => !['pickupMode', 'depositWhen'].includes(key)) || Object.hasOwn(options, 'pickupMode') && !['active', 'passive'].includes(options.pickupMode) || Object.hasOwn(options, 'depositWhen') && !['capacity', 'full', 'four_layers'].includes(options.depositWhen)) throw new Error('Storage configuration accepts pickupMode active/passive and depositWhen capacity/full only')
    const next = { ...storageSettings(), ...(job.pendingStorageConfiguration ? { pickupMode: job.pendingStorageConfiguration.pickupMode, depositWhen: job.pendingStorageConfiguration.depositWhen } : {}), ...copy(options) }
    if (!validStoragePair(next)) throw new Error('Only active/capacity, active/four_layers or passive/full storage policies are supported')
    const current = job.pendingStorageConfiguration ?? storageSettings()
    if (next.pickupMode === current.pickupMode && next.depositWhen === current.depositWhen) return status()
    const owner = job, prior = job.pendingStorageConfiguration
    const pending = { ...next, requestedAt: new Date(now()).toISOString() }
    job.pendingStorageConfiguration = pending
    try { await save('storage_configuration_requested') } catch (error) {
      if (job === owner && job.pendingStorageConfiguration === pending) { if (prior) job.pendingStorageConfiguration = prior; else delete job.pendingStorageConfiguration }
      throw error
    }
    if (job === owner && !worker && !ACTIVE.has(job.state)) await applyStorageConfiguration()
    return status()
  }

  async function configureTools (options = {}) {
    if (!job || !['PAUSED', 'IDLE'].includes(job.state) || worker) throw new Error('Tool configuration requires a fully paused or idle quarry')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['reserveMinUses', 'reserveFraction', 'returnUses'].includes(k))) throw new Error('Only durability reserve settings may be changed')
    const tools = { reserveMinUses: 1, reserveFraction: 0, returnUses: 0, reservedTools: [], ...job.config.tools, ...copy(options) }
    if (!Number.isSafeInteger(tools.reserveMinUses) || tools.reserveMinUses < 0 || tools.reserveMinUses > 10000 || !Number.isFinite(tools.reserveFraction) || tools.reserveFraction < 0 || tools.reserveFraction > 1 || !Number.isSafeInteger(tools.returnUses) || tools.returnUses < 0 || tools.returnUses > 10000) throw new Error('Invalid durability reserve settings')
    job.config.tools = tools
    const cleared = clearWorkDeferred(['TOOL_DURABILITY_RESERVE'])
    job.planned.tools = copy(tools)
    countsRevision++
    note('tools_configured', { reserveMinUses: tools.reserveMinUses, reserveFraction: tools.reserveFraction, returnUses: tools.returnUses, retriedCells: cleared })
    await save('tools_configured')
    return status()
  }

  async function configureExit (options = {}) {
    if (!job || !['PAUSED', 'IDLE'].includes(job.state) || worker) throw new Error('Exit configuration requires a fully paused or idle quarry')
    if (job.egress?.operationId) throw new Error('A saved exit operation cannot be replaced')
    const exit = normalizeExit({ ...job.config.exit, ...copy(options) })
    if (exit.mode === 'adjacent_pillar' && job.config.exit?.mode !== 'adjacent_pillar') exit.migrationFloorY = workFloorY()
    else if (exit.mode === 'adjacent_pillar') {
      if (Number.isSafeInteger(job.config.exit.migrationFloorY)) exit.migrationFloorY = job.config.exit.migrationFloorY
      else delete exit.migrationFloorY
    }
    job.config.exit = exit
    job.config.inventory.keepExitDirt = exit.mode === 'adjacent_pillar' ? exit.reservedDirt : 0
    rebuildPlanner()
    job.planned.exit = copy(exit)
    note('exit_configured', { mode: exit.mode, migrationFloorY: exit.migrationFloorY ?? null, reservedDirt: exit.reservedDirt })
    job.exitReservation = null; job.exitPreflight = null; delete regions.exitReservation
    await save('exit_configured')
    return status()
  }

  async function configureSupplies ({ bindings = null } = {}) {
    if (!job || worker || !['PAUSED', 'IDLE'].includes(job.state)) throw new Error('Supply registration requires a drained paused or idle job')
    if (job.supplyRestock || job.portableStorage) throw new Error('An unfinished container operation must be reconciled before changing supply bindings')
    if (!bindings) {
      const discovered = adapter.discoverSupplies?.()
      if (!discovered?.ok) throw new Error(discovered?.reason ?? 'SUPPLY_BOXES_UNCONFIRMED')
      bindings = discovered.bindings
    }
    if (!validSupplyBindings(bindings) || typeof adapter.restockSupplies !== 'function') throw new Error('SUPPLY_BINDINGS_INVALID')
    const inventory = items(adapter.getState())
    if (!inventory || bindings.some(binding => !inventory.some(item => isShulkerBox(item.name) && carriedContainerKey(item) === binding.key))) throw new Error('SUPPLY_BOXES_UNCONFIRMED')
    job.config.inventory.supplyBoxes = copy(bindings); job.config.inventory.autoSupplies = true
    if (job.planned) { job.planned.issues = job.planned.issues.filter(issue => !/^SUPPLY_/.test(issue)); job.planned.ready = job.planned.issues.length === 0 }
    await save('supplies_configured')
    return status()
  }
  async function reconcileObservedStoragePlacement () {
    if (!job || worker || job.state !== 'PAUSED' || job.userRunIntent !== 'running' || typeof adapter.reconcileObservedPlacement !== 'function') throw new Error('Observed placement reconciliation requires a drained error-paused running intent')
    const owner = job, active = job.portableStorage, generation = epoch, intent = job.userRunIntent
    const reason = 'サーバーから設置・使用の完了を確認できませんでした。'
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || active.checkpoint.stage !== 'placing' || active.checkpoint.intent?.type !== 'place' || job.supplyRestock || job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || job.pauseDetails?.operationId !== active.operationId || job.pauseDetails?.reason !== reason) throw new Error('No matching timed-out cargo placement is recorded')
    const before = copy(active.checkpoint)
    const record = job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active.operationId && action.status === 'blocked' && action.result?.status === 'blocked' && action.result.reason === reason)
    if (!record || !isDeepStrictEqual(record.result.checkpoint, before)) throw new Error('Timed-out placement record differs from its pending checkpoint')
    const prior = { pauseReason: job.pauseReason, pauseDetails: copy(job.pauseDetails), result: copy(job.result), savedAt: job.savedAt }
    const owns = () => {
      const current = adapter.getState()
      if (job !== owner || job.portableStorage !== active || epoch !== generation || job.state !== 'PAUSED' || job.userRunIntent !== intent || scopeOf(current) !== job.scope || lifeOf(current) !== job.life || adapter.combatActive()) throw new Error('Observed placement reconciliation was interrupted')
    }
    const unchanged = checkpoint => {
      const stable = copy(checkpoint)
      for (const key of ['intent', 'stage', 'placed', 'windowId']) delete stable[key]
      return stable
    }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    worker = lock; reconcilingCarriedPlacement = true
    try {
      owns()
      const response = await adapter.reconcileObservedPlacement({ jobId: owner.config.jobId, operationId: active.operationId, selection: copy(active.selection), checkpoint: copy(before), recordedFailure: copy(record) }, {
        onCheckpoint: async checkpoint => {
          owns()
          const placed = checkpoint?.placed?.[0]
          if (checkpoint?.stage !== 'placed' || checkpoint.intent != null || checkpoint.placed?.length !== 1 || !isDeepStrictEqual(placed?.position, before.intent.position) || placed.name !== before.intent.name || placed.confirmedBy !== 'server_block_and_inventory' || !Number.isSafeInteger(placed.runtimeId) || placed.runtimeId < 0 || placed.runtimeId > 4294967295 || placed.placementReconciliation?.confirmedBy !== 'received_empty_source_main_and_fresh_exact_container' || placed.placementReconciliation.requestOutcome !== 'unacknowledged' || !isDeepStrictEqual(unchanged(checkpoint), unchanged(before))) throw new Error('Observed placement reconciliation changed assets or credited storage')
          staged = copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.placementConfirmed !== true || response.serverConfirmed !== false || !staged || !isDeepStrictEqual(staged, response.checkpoint) || !isDeepStrictEqual(staged.placed[0].placementReconciliation, response.proof)) return { ...status(), observedPlacementReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = copy(staged)
      job.pauseReason = 'STORAGE_PLACEMENT_RECONCILED'; job.pauseDetails = { operationId: active.operationId, placementConfirmed: true, requestOutcome: 'unacknowledged' }; job.result = null
      try { await save('storage_placement_reconciled') } catch (error) { active.checkpoint = before; Object.assign(job, prior); throw error }
      note('storage_placement_reconciled', { operationId: active.operationId, credited: 0, confirmedBy: response.proof.confirmedBy })
      return { ...status(), observedPlacementReconciliation: { status: 'reconciled', placementConfirmed: true, serverConfirmed: false, proof: copy(response.proof) } }
    } finally { reconcilingCarriedPlacement = false; release(); if (worker === lock) worker = null }
  }
  async function reconcileRejectedStorage () {
    if (!job || worker || job.state !== 'PAUSED' || job.userRunIntent !== 'running' || typeof adapter.reconcileRejectedDeposit !== 'function') throw new Error('Rejected storage reconciliation requires a drained error-paused running intent')
    const owner = job, active = job.portableStorage, generation = epoch, intent = job.userRunIntent
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || active.checkpoint.stage !== 'depositing' || active.checkpoint.intent?.type !== 'deposit' || job.supplyRestock || job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || job.pauseDetails?.operationId !== active.operationId) throw new Error('No matching rejected cargo transfer is recorded')
    const before = copy(active.checkpoint)
    const record = job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active.operationId && action.status === 'blocked' && action.result?.status === 'blocked' && ['サーバーがチェストへの移動を拒否しました。', 'STORAGE_SOURCE_REJECTED'].includes(action.result.reason))
    if (!record || !isDeepStrictEqual(record.result.checkpoint, before)) throw new Error('Rejected storage record differs from its pending checkpoint')
    const prior = { pauseReason: job.pauseReason, pauseDetails: copy(job.pauseDetails), result: copy(job.result) }
    const owns = () => {
      const current = adapter.getState()
      if (job !== owner || job.portableStorage !== active || epoch !== generation || job.state !== 'PAUSED' || job.userRunIntent !== intent || scopeOf(current) !== job.scope || lifeOf(current) !== job.life || adapter.combatActive()) throw new Error('Rejected storage reconciliation was interrupted')
    }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    worker = lock; reconcilingCarriedPlacement = true
    try {
      owns()
      const response = await adapter.reconcileRejectedDeposit({ jobId: owner.config.jobId, operationId: active.operationId, selection: copy(active.selection), checkpoint: copy(before), recordedFailure: copy(record) }, {
        onCheckpoint: async checkpoint => {
          owns()
          if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== before.kind || checkpoint.selectionKey !== before.selectionKey || checkpoint.stage !== 'depositing' || checkpoint.intent != null || checkpoint.recovered != null || !isDeepStrictEqual(checkpoint.scope, before.scope) || !isDeepStrictEqual(checkpoint.positions, before.positions) || !isDeepStrictEqual(checkpoint.stand, before.stand) || !isDeepStrictEqual(checkpoint.plan, before.plan) || !isDeepStrictEqual(checkpoint.deposited, before.deposited) || !isDeepStrictEqual(checkpoint.placed, before.placed) || !isDeepStrictEqual(checkpoint.sourceIdentities, before.sourceIdentities)) throw new Error('Rejected storage reconciliation changed assets or credited a transfer')
          staged = copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.notApplied !== true || response.serverConfirmed !== false || !staged || !isDeepStrictEqual(staged, response.checkpoint)) return { ...status(), rejectedStorageReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = copy(staged)
      job.pauseReason = 'STORAGE_REJECTION_RECONCILED'; job.pauseDetails = { operationId: active.operationId, notApplied: true }; job.result = null
      try { await save('storage_source_rejection_reconciled') } catch (error) { active.checkpoint = before; Object.assign(job, prior); throw error }
      note('storage_source_rejection_reconciled', { operationId: active.operationId, requestId: response.proof?.requestId, credited: 0 })
      return { ...status(), rejectedStorageReconciliation: { status: 'reconciled', notApplied: true, serverConfirmed: false, proof: copy(response.proof) } }
    } finally { reconcilingCarriedPlacement = false; release(); if (worker === lock) worker = null }
  }
  async function reconcileCarriedPlacement () {
    if (!job || worker || job.state !== 'PAUSED' || typeof adapter.reconcileCarriedPlacement !== 'function') throw new Error('Cargo placement reconciliation requires a drained paused operation')
    const owner = job, active = job.portableStorage, generation = epoch, intent = job.userRunIntent
    const record = job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active?.operationId)
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || job.supplyRestock || job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || job.pauseDetails?.operationId !== active.operationId || job.pauseDetails?.reason !== UNSENT_PLACE_REASON || record?.status !== 'blocked' || record.result?.status !== 'blocked' || record.result.reason !== UNSENT_PLACE_REASON || !isDeepStrictEqual(record.result.checkpoint, active.checkpoint)) throw new Error('The recorded before-begin cargo placement refusal is required')
    const before = copy(active.checkpoint)
    const priorStatus = { pauseReason: job.pauseReason, pauseDetails: copy(job.pauseDetails), result: copy(job.result), savedAt: job.savedAt }
    const owns = () => { if (job !== owner || job.portableStorage !== active || epoch !== generation || job.state !== 'PAUSED' || job.userRunIntent !== intent) throw new Error('Cargo placement reconciliation was interrupted') }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    worker = lock; reconcilingCarriedPlacement = true
    try {
      const response = await adapter.reconcileCarriedPlacement({ jobId: job.config.jobId, operationId: active.operationId, purpose: 'cargo', selection: copy(active.selection), checkpoint: copy(before), reason: UNSENT_PLACE_REASON }, {
        canPlace: p => storagePoint(p) && !(job.config.boundarySeal?.closeOpenings && regions.seal.columns.has(`${p.x},${p.z}`)) && permits(regions, 'travel', p).allowed && permits(regions, 'travel', { ...p, y: p.y + 1 }).allowed && !planner.isStairCell(p) && !planner.isStairCell({ ...p, y: p.y - 1 }),
        onCheckpoint: async checkpoint => {
          owns()
          if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== before.kind || checkpoint.selectionKey !== before.selectionKey || checkpoint.purpose != null || checkpoint.stage !== 'planned' || checkpoint.intent != null || !storagePoint(checkpoint.stand) || !Array.isArray(checkpoint.positions) || checkpoint.positions.length !== 1 || !checkpoint.positions.every(storagePoint) || !isDeepStrictEqual(checkpoint.scope, before.scope) || !isDeepStrictEqual(checkpoint.plan, before.plan) || !isDeepStrictEqual(checkpoint.deposited, before.deposited) || !isDeepStrictEqual(checkpoint.placed, before.placed) || !isDeepStrictEqual(checkpoint.sourceIdentities, before.sourceIdentities) || checkpoint.notSentPlacementProofs?.at(-1)?.notSent !== true) throw new Error('Cargo reconciliation changed the operation or transfer plan')
          staged = copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.notSent !== true || !staged || !isDeepStrictEqual(response.checkpoint, staged)) return { ...status(), carriedPlacementReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = copy(staged)
      job.pauseReason = 'MANUAL_PAUSE'; job.pauseDetails = null; job.result = null
      try { await save('cargo_placement_replanned') } catch (error) { active.checkpoint = before; Object.assign(job, priorStatus); throw error }
      note('cargo_placement_not_sent', { operationId: active.operationId, proof: response.proof, nextSite: response.nextSite })
      return { ...status(), carriedPlacementReconciliation: { status: 'reconciled', notSent: true, proof: copy(response.proof), nextSite: copy(response.nextSite) } }
    } finally { reconcilingCarriedPlacement = false; release(); if (worker === lock) worker = null }
  }
  async function reconcileSupplyPlacement () {
    if (!job || worker || job.state !== 'PAUSED' || typeof adapter.reconcileSupplyPlacement !== 'function') throw new Error('Placement reconciliation requires a drained paused supply operation')
    const owner = job, active = job.supplyRestock
    if (!active?.checkpoint?.child || job.pauseDetails?.reason !== UNSENT_PLACE_REASON || job.lastSupplyResult?.reason !== UNSENT_PLACE_REASON || job.lastSupplyResult?.operationId !== active.operationId) throw new Error('The recorded pre-begin placement refusal is required')
    const before = copy(active.checkpoint)
    let release
    const lock = new Promise(resolve => { release = resolve })
    worker = lock; reconcilingSupplyPlacement = true
    try {
    const response = await adapter.reconcileSupplyPlacement({ jobId: job.config.jobId, operationId: active.operationId, checkpoint: copy(active.checkpoint), reason: UNSENT_PLACE_REASON, canPlace: supplyCanPlace }, { onCheckpoint: async checkpoint => {
      if (job !== owner || job.supplyRestock !== active || checkpoint?.jobId !== owner.config.jobId || checkpoint?.operationId !== active.operationId) throw new Error('Supply reconciliation belongs to another operation')
      active.checkpoint = copy(checkpoint)
      try { await save('supply_placement_not_sent') } catch (error) { active.checkpoint = before; throw error }
    } })
    if (response?.status !== 'reconciled' || response.notSent !== true) return { ...status(), supplyPlacementReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
    job.pauseReason = 'MANUAL_PAUSE'; job.pauseDetails = null; job.result = null
    job.lastSupplyResult = { operationId: active.operationId, status: 'reconciled', reason: 'PLACEMENT_NOT_SENT', serverConfirmed: false, notSent: true }
    note('supply_placement_not_sent', { operationId: active.operationId, proof: response.proof, nextSite: response.nextSite })
    await save('supply_placement_replanned')
    return { ...status(), supplyPlacementReconciliation: { status: 'reconciled', notSent: true, proof: copy(response.proof), nextSite: copy(response.nextSite) } }
    } finally { reconcilingSupplyPlacement = false; release(); if (worker === lock) worker = null }
  }
  async function restockSuppliesNow () {
    if (!job || worker || !['PAUSED', 'IDLE'].includes(job.state)) throw new Error('Manual supply work requires a drained paused or idle job')
    if (job.portableStorage) throw new Error('Resume the unfinished carried-storage operation before starting supply work')
    if (!job.config.inventory.supplyBoxes?.length) await configureSupplies()
    const owner = job, prior = { userRunIntent: job.userRunIntent, pauseReason: job.pauseReason, pauseDetails: copy(job.pauseDetails), result: copy(job.result) }
    const myEpoch = ++epoch
    abort = new AbortController(); job.userRunIntent = 'running'; setState('RESTOCK'); adapter.onStarted?.(status())
    const task = (async () => {
      try { const handled = await restock(myEpoch, 'SURVEY', true); return handled ? copy(job.lastSupplyResult) : { status: 'completed', serverConfirmed: true, withdrawn: [], returned: [] } }
      finally {
        if (job === owner && epoch === myEpoch) {
          const failed = job.state === 'PAUSED' && job.pauseReason === 'SUPPLY_RESTOCK_BLOCKED'
          job.userRunIntent = prior.userRunIntent
          if (!failed) Object.assign(job, { pauseReason: prior.pauseReason, pauseDetails: prior.pauseDetails, result: prior.result })
          if (!failed && prior.pauseReason === 'SUPPLY_RESTOCK_BLOCKED') Object.assign(job, { pauseReason: 'MANUAL_PAUSE', pauseDetails: null, result: null })
          setState('PAUSED'); await save('supply_manual_done'); try { adapter.onFinished?.(status()) } catch {}
        }
      }
    })()
    worker = task
    let supplyResult
    try { supplyResult = await task } finally { if (worker === task) worker = null }
    return { ...status(), supplyResult }
  }
  async function storeCarriedNow ({ deposits } = {}) {
    if (!job || job.state !== 'PAUSED' || worker) throw new Error('Carried storage can run only while the quarry is fully paused')
    if (job.supplyRestock || job.portableStorage?.purpose === 'capacity_batch') throw new Error('Resume the unfinished supply or capacity operation before manual storage')
    const state = adapter.getState(); const inv = items(state)
    if (state?.phase !== 'spawned' || state.dead || !inv || job.scope !== scopeOf(state) || job.life !== lifeOf(state)) throw new Error('Carried storage requires the paused job current connection, life and confirmed inventory')
    if (job.portableStorage && deposits !== undefined) throw new Error('Resume the saved carried-storage operation without replacing its transfer limit')
    let limit = null
    if (deposits !== undefined) {
      if (!Array.isArray(deposits) || !deposits.length || deposits.length > 36) throw new Error('Carried storage needs one to 36 bounded deposit requests')
      const available = new Map(keepPlan(inv, inventoryPolicy()).deposits.map(item => [`${item.slot}:${nameOf(item)}`, item.count]))
      limit = deposits.map(item => {
        const key = `${item?.slot}:${nameOf(item)}`; const room = available.get(key) ?? 0
        if (!Number.isInteger(item?.slot) || typeof item.name !== 'string' || !Number.isSafeInteger(item.count) || item.count <= 0 || item.count > room || isShulkerBox(item.name)) throw new Error('The requested transfer exceeds the current depositable inventory')
        available.set(key, room - item.count)
        return { slot: item.slot, name: item.name, count: item.count }
      })
    }
    const owner = job
    const prior = { userRunIntent: job.userRunIntent, pauseReason: job.pauseReason, pauseDetails: copy(job.pauseDetails), result: copy(job.result) }
    const myEpoch = ++epoch
    abort = new AbortController(); job.userRunIntent = 'running'
    setState('PORTABLE_STORAGE')
    adapter.onStarted?.(status())
    let storageCompleted = false
    const task = (async () => {
      try {
        const handled = await storeCarried(myEpoch, 'manual', limit)
        const rec = job.actions.findLast(action => action.type === 'carried_storage')
        const result = handled ? copy(rec?.result ?? { status: 'blocked', reason: job.pauseReason ?? rec?.error ?? 'UNCONFIRMED_RESULT' }) : { status: 'blocked', reason: 'NO_CARRIED_STORAGE' }
        storageCompleted = ['completed', 'full'].includes(result.status) && result.serverConfirmed === true
        return result
      } finally {
        if (job === owner && epoch === myEpoch) {
          const failed = job.state === 'PAUSED' && /^CARRIED_STORAGE_/.test(job.pauseReason ?? '')
          job.userRunIntent = prior.userRunIntent
          if (!failed) Object.assign(job, { pauseReason: prior.pauseReason, pauseDetails: prior.pauseDetails, result: prior.result })
          if (storageCompleted && /^CARRIED_STORAGE_/.test(prior.pauseReason ?? '')) Object.assign(job, { pauseReason: 'MANUAL_PAUSE', pauseDetails: null, result: null })
          setState('PAUSED')
          await save('carried_storage_manual_done')
          try { adapter.onFinished?.(status()) } catch {}
        }
      }
    })()
    worker = task
    let storageResult
    try { storageResult = await task } finally { if (worker === task) worker = null }
    return { ...status(), storageResult }
  }

  function start () {
    assertStoragePolicy()
    if (reconcilingSupplyPlacement || reconcilingCarriedPlacement) throw new Error('Placement reconciliation is still running')
    requireDrained()
    if (job) assertJobWorld(job, adapter.getState())
    if (job?.persistence?.status === 'failed') throw new QuarryInterrupt('PERSISTENCE_FAILED')
    clearAutoResume()
    if (!job) throw new Error('Run plan first')
    if (!job.planned?.ready) throw new Error(`Plan is not ready: ${job.planned.issues.join(', ')}`)
    if (ACTIVE.has(job.state)) return status()
    if (job.state === 'FINISHED') throw new Error('This job has finished; plan a new one')
    job.userRunIntent = 'running'; job.startedAt ??= new Date(now()).toISOString(); epoch++
    abort = new AbortController()
    setState('PREFLIGHT')
    adapter.onStarted?.(status())
    launchWorker()
    return status()
  }
  function resume () {
    assertStoragePolicy()
    if (reconcilingSupplyPlacement || reconcilingCarriedPlacement) throw new Error('Placement reconciliation is still running')
    requireDrained()
    if (job) assertJobWorld(job, adapter.getState())
    if (job?.persistence?.status === 'failed') throw new QuarryInterrupt('PERSISTENCE_FAILED')
    clearAutoResume()
    if (!job) throw new Error('No quarry job')
    if (ACTIVE.has(job.state)) return status()
    if (!['PAUSED', 'IDLE', 'DISCONNECTED'].includes(job.state)) throw new Error(`Cannot resume from ${job.state}`)
    // A user resume may try freeing a slot for a blocked restock again.
    if (job.supplyRestock) job.supplyRestock.roomAttempts = 0
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
    launchWorker()
    return status()
  }
  function stopJob (intent, reason, result = 'PAUSED') {
    if (!job) return Promise.resolve(status())
    clearAutoResume()
    // Repeated stop requests join the same drain; emergency/cancel intent wins.
    const priority = { paused: 1, stopped: 2, cancelled: 3 }
    if (stopTask) {
      if ((priority[intent] ?? 0) > (priority[job.userRunIntent] ?? 0)) { job.userRunIntent = intent; job.requestedStop = { reason, result } }
      return stopTask
    }
    if (job.state === 'FINISHED') return Promise.resolve(status())
    const owner = job, previousWorker = worker
    // Manual intent must be durable without erasing an unresolved storage
    // checkpoint's reason/details. PROCESS_RESTARTED is special: a later
    // explicit manual pause must withdraw its automatic-resume permission.
    const preserveFailure = intent === 'paused' && reason === 'MANUAL_PAUSE' && job.state === 'PAUSED' && job.pauseReason && job.pauseReason !== 'PROCESS_RESTARTED'
    const effectiveReason = preserveFailure ? job.pauseReason : reason
    const pauseDetails = preserveFailure ? copy(job.pauseDetails ?? null) : null
    job.userRunIntent = intent; job.requestedStop = { reason: effectiveReason, result, pauseDetails }; epoch++
    abort?.abort(new QuarryInterrupt('STOP_REQUESTED'))
    // Stop input synchronously before awaiting any persistence or controller.
    let stopping
    try { stopping = worker || ACTIVE.has(job.state) || pendingActions.size ? adapter.combatActive() ? Promise.resolve() : Promise.resolve(adapter.stopAll(`quarry:${reason}`)) : Promise.resolve() } catch (error) { stopping = Promise.reject(error) }
    pendingActions.add(stopping)
    void stopping.then(() => pendingActions.delete(stopping), () => pendingActions.delete(stopping))
    // Persist intent before waiting for slow/failed child controllers. A crash
    // during draining must not leave the last checkpoint saying "running".
    const intentSaved = save('stop_intent').catch(error => { note('stop_intent_save_failed', { error: String(error.message ?? error) }) })
    const operation = (async () => {
      let stopError = null, timer
      const drained = (async () => {
        try { await stopping } catch (error) { stopError = error; note('stop_failed', { error: String(error.message ?? error) }) }
        await previousWorker?.catch(() => {})
        await Promise.allSettled([...pendingActions])
        await intentSaved
      })()
      try {
        await Promise.race([drained, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new QuarryInterrupt('STOP_UNCONFIRMED')), stopTimeoutMs) })])
      } catch (error) {
        if (job !== owner) throw busyError()
        job.result = { type: 'PAUSED', reason: 'STOP_UNCONFIRMED', at: new Date(now()).toISOString() }
        setState('PAUSED', { pauseReason: 'STOP_UNCONFIRMED', pauseDetails: { pendingActions: pendingActions.size, timeoutMs: stopTimeoutMs } })
        await save('stop_unconfirmed')
        // Pending tasks stay fenced; timing out never grants a new owner.
        throw error
      } finally { clearTimeout(timer) }
      if (job !== owner) throw busyError()
      const request = job.requestedStop
      delete job.requestedStop
      await finish(stopError ? 'PAUSED' : request.result, stopError ? 'STOP_UNCONFIRMED' : request.reason, { pauseDetails: request.pauseDetails ?? null })
      if (job.persistence?.status === 'failed') throw new QuarryInterrupt('PERSISTENCE_FAILED')
      if (stopError) throw new QuarryInterrupt('STOP_UNCONFIRMED')
      return status()
    })()
    const task = operation.then(() => { if (stopTask === task) stopTask = null; return status() }, error => { if (stopTask === task) stopTask = null; throw error })
    stopTask = task
    return task
  }
  function pause (reason = 'MANUAL_PAUSE') { return stopJob('paused', reason) }
  function emergencyStop () { return stopJob('stopped', 'EMERGENCY_STOP') }
  function cancel () { return stopJob('cancelled', 'MANUAL_CANCEL', 'CANCELLED') }

  // Operator record of a debug action taken outside the job (e.g. a /tp
  // rescue). It changes nothing but the job log. Paused jobs only.
  async function recordDebugAction ({ kind, details = {} } = {}) {
    if (!job || job.state !== 'PAUSED' || worker) throw new Error('Recording a debug action requires a fully paused quarry')
    if (typeof kind !== 'string' || !/^[a-z_]{3,40}$/.test(kind)) throw new Error('kind must be a short snake_case label')
    note('debug_action', { kind, details: copy(details) })
    await save('debug_action')
    return { recorded: true, kind }
  }

  // Operator-only exception to "never go back to earlier layers": move the
  // work layer up to y and reopen EARLIER_LAYER_LEFTOVER cells only inside the
  // given box (the way down from a rescue stand). Paused jobs only.
  async function reopenWorkLayer ({ y, box, why = null } = {}) {
    if (!job || job.state !== 'PAUSED' || worker) throw new Error('Reopening a layer requires a fully paused quarry')
    const n = v => Number.isSafeInteger(v)
    if (!n(y) || y > job.yTop || y < regions.yBottom || !box || !['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'].every(k => n(box[k])) || box.xMin > box.xMax || box.zMin > box.zMax || box.yMin > box.yMax || box.yMin < y) throw new Error('reopenWorkLayer needs { y, box: {xMin,xMax,yMin,yMax,zMin,zMax} } with box.yMin >= y')
    const inBox = ([x, py, z]) => x >= box.xMin && x <= box.xMax && py >= box.yMin && py <= box.yMax && z >= box.zMin && z <= box.zMax
    const before = { deepestY: job.deepestY ?? null, cursorY: job.cursorY ?? null }
    const countBefore = planner.deferredList().length
    planner.clearDeferred(['EARLIER_LAYER_LEFTOVER'], k => !inBox(k.split(',').map(Number)))
    const reopened = countBefore - planner.deferredList().length
    job.deepestY = y; job.cursorY = y
    if (Number.isSafeInteger(job.lastMineY) && job.lastMineY < y) job.lastMineY = y
    note('work_layer_reopened', { y, box: copy(box), reopened, before, why })
    await save('work_layer_reopened')
    return { y, reopened, before }
  }
  function acceptExceptions () {
    if (!job || job.state !== 'PAUSED' || job.pauseReason !== 'UNRESOLVED_EXCEPTIONS') throw new Error('No exceptions are waiting for acceptance')
    job.acceptedExceptions = true
    return resume()
  }
  // Restores a saved job document without running it (§15.2, §15.3).
  function load (doc) {
    if (!doc?.config || doc.config.schemaVersion !== 2) throw new Error('Unsupported quarry job document')
    requireDrained()
    if (job && ACTIVE.has(job.state)) throw new Error('A quarry job is running')
    validateJobId(doc.config.jobId)
    const world = assertJobWorld(doc, adapter.getState())
    clearAutoResume()
    if (!validStoragePair(doc.config.inventory)) throw new Error('Unsupported saved storage policy')
    if (doc.config.initialLoadout != null && doc.config.initialLoadout !== 'v22') throw new Error('Unsupported saved initial loadout')
    if (doc.config.inventory.supplyLayout != null && doc.config.inventory.supplyLayout !== 'v22') throw new Error('Unsupported saved supply layout')
    const pendingStorage = doc.pendingStorageConfiguration
    if (pendingStorage != null && (typeof pendingStorage !== 'object' || Array.isArray(pendingStorage) || Object.keys(pendingStorage).some(key => !['pickupMode', 'depositWhen', 'requestedAt'].includes(key)) || typeof pendingStorage.pickupMode !== 'string' || typeof pendingStorage.depositWhen !== 'string' || !validStoragePair(pendingStorage) || pendingStorage.requestedAt !== undefined && (typeof pendingStorage.requestedAt !== 'string' || !Number.isFinite(Date.parse(pendingStorage.requestedAt))))) throw new Error('Invalid pending storage configuration')
    job = copy(doc)
    job.config.initialLoadout ??= null
    if (job.config.initialLoadout === 'v22') job.config.inventory.supplyLayout = 'v22'
    job.world = world
    job.instanceId = documentInstance(doc)
    job.actionSequence ??= Math.max(0, ...(job.actions ?? []).map(action => action.sequence ?? 0))
    // Missing exit settings identify older saved jobs. Loading alone never
    // changes their staircase policy; migration is explicit via configureExit.
    job.config.exit = normalizeExit(job.config.exit, { legacy: !job.config.exit })
    job.config.inventory.keepExitDirt ??= job.config.exit.mode === 'adjacent_pillar' ? job.config.exit.reservedDirt : 0
    regions = makeRegions(job.config, job.yTop, adapter.getState())
    planner = createQuarryPlanner({ regions, getBlock: planningBlocks(job.config), config: job.config.strategy, records: job.records ?? {}, exit: job.config.exit })
    ledger = createLedger(job.ledger ?? {})
    if (shulkerOnly && (job.config.inventory.storage?.length || job.portableStorage && job.portableStorage.selection?.kind !== 'shulker')) { job.state = 'PAUSED'; job.pauseReason = 'LEGACY_CHEST_STORAGE'; job.userRunIntent = 'paused' }
    if (ACTIVE.has(job.state)) {
      job.state = 'PAUSED'
      job.pauseReason = job.requestedStop?.reason ?? (job.userRunIntent === 'running' ? 'PROCESS_RESTARTED' : job.userRunIntent === 'stopped' ? 'EMERGENCY_STOP' : job.userRunIntent === 'cancelled' ? 'MANUAL_CANCEL' : 'MANUAL_PAUSE')
      if (job.userRunIntent === 'running') job.userRunIntent = 'paused'
    }
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
    const finalCarried = inv ? keepPlan(inv, inventoryPolicy()).deposits : null
    return copy({
      jobId: job.config.jobId, state: ['PAUSED', 'FINISHED'].includes(job.state) && (loopWorker || stopTask || pendingActions.size || savesInFlight) ? 'STOPPING' : job.state, draining: !!(worker || stopTask || pendingActions.size || savesInFlight), persistence: copy(job.persistence ?? null), world: copy(job.world), userRunIntent: job.userRunIntent, result: job.result, pauseReason: job.pauseReason, pauseDetails: job.pauseDetails ?? null,
      chunks: regions?.chunks ?? null, yTop: job.yTop, yBottom: regions?.yBottom ?? null, currentY: job.lastDecision?.y ?? job.cursorY,
      counts, deferred: planner?.deferredList().slice(0, 30) ?? [], deferredCount: planner?.deferredList().length ?? 0, temporary: planner?.temporaryList() ?? [], seals: planner?.sealList() ?? [],
      freeSlots: inv ? freeSlots(inv) : null, health: s?.health ?? null, food: foodOf(s), held: s?.heldItem?.name ?? null,
      storagePolicy: { ...storageSettings(), pending: job.pendingStorageConfiguration ? { pickupMode: job.pendingStorageConfiguration.pickupMode, depositWhen: job.pendingStorageConfiguration.depositWhen } : null, finalStorageSkipped: copy(job.finalStorageSkipped ?? null), finalCarried: finalCarried ? { stacks: finalCarried.length, count: finalCarried.reduce((n, item) => n + item.count, 0), items: copy(finalCarried) } : null },
      passivePickup: copy(job.passivePickup ?? null),
      ledger: ledger.summary(), ledgerDetail: ledger.export(), pendingDrops: pendingDrops.length, unreachableItems: job.unreachableItems ?? [],
      combat: { ...combatBridge.snapshot(), settle: job.settle ?? null, recovery: job.recovery ?? null, interruption: job.interruption },
      portableStorage: job.portableStorage ? { operationId: job.portableStorage.operationId, kind: job.portableStorage.selection?.kind, stage: job.portableStorage.checkpoint?.stage ?? 'intent', positions: copy(job.portableStorage.checkpoint?.positions ?? []), why: job.portableStorage.why } : null,
      supplies: { enabled: !!job.config.inventory.supplyBoxes?.length, bindings: copy(job.config.inventory.supplyBoxes ?? []), needs: items(s) ? supplyNeeds(items(s), { ...job.config.inventory, tools: job.config.tools,
        ...(deferredExitSupplies() ? { deferExitSupplies: true, exitPreparing: job.egressPreparation === true, exitDirtTarget: Math.max(192, job.config.inventory.keepExitDirt ?? 0) } : {}) }) : null, active: job.supplyRestock ? { operationId: job.supplyRestock.operationId, index: job.supplyRestock.checkpoint?.index ?? null, phase: job.supplyRestock.checkpoint?.phase ?? 'intent' } : null, lastResult: copy(job.lastSupplyResult ?? null) },
      egress: egressStatus(inv),
      tools: { ...copy(job.config.tools), hardMinimumRemaining: 1, states: inv ? inv.map(i => toolState(i, job.config.tools)).filter(Boolean).map(t => ({ slot: t.item.slot, name: t.item.name, remaining: t.remaining ?? null, reserve: t.reserve ?? null, usable: t.usable, reason: t.reason ?? null })) : null },
      terrainObservation: copy(job.terrainObservation ?? null),
      fluidDrain: job.fluidDrain ? { source: copy(job.fluidDrain.source?.position ?? null), remaining: job.fluidDrain.remaining, total: job.fluidDrain.cells.length, deadline: job.fluidDrain.deadline } : null,
      lastDecision: job.lastDecision ?? null, lastAction: job.actions.at(-1) ?? null, deaths: job.deaths, planned: job.planned, events: events.slice(-15)
    })
  }

  function ownsPortableRoute (owner) {
    if (!job || owner?.jobId !== job.config.jobId || job.userRunIntent !== 'running' || !['RETURN', 'DEPOSIT', 'PORTABLE_STORAGE', 'RESTOCK'].includes(job.state)) return false
    return job.portableStorage?.operationId === owner.operationId || job.supplyRestock?.checkpoint?.child?.operationId === owner.operationId
  }
  function portableTravel (position, owner) { return ownsPortableRoute(owner) && permits(regions, 'travel', position).allowed }
  function storageInterruptionContext () {
    if (!job || job.userRunIntent !== 'running' || !['RETURN', 'DEPOSIT', 'PORTABLE_STORAGE'].includes(job.state) || !job.portableStorage) return null
    return { jobId: job.config.jobId, operationId: job.portableStorage.operationId, epoch }
  }
  function portablePath (origin, goal, owner) {
    if (!ownsPortableRoute(owner)) throw new Error('STORAGE_RETURN_OWNER_CHANGED')
    const state = adapter.getState(), life = lifeOf(state)
    const scope = { profile: state.profile, realmId: String(state.realm?.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), life }
    if (state.phase !== 'spawned' || state.dead || state.isDead || !(state.health > 0) || !isDeepStrictEqual(scope, owner.scope) || !storagePoint(origin) || !storagePoint(goal) || !isDeepStrictEqual(origin, feetCell(state))) throw new Error('STORAGE_RETURN_SCOPE_OR_ORIGIN_CHANGED')
    if (!permits(regions, 'travel', origin).allowed || !permits(regions, 'travel', { ...origin, y: origin.y + 1 }).allowed) {
      if (Array.isArray(job.config.permissions.travelRegion)) return null
      rebuildPlanner()
    }
    return planner.pathTo(origin, goal)
  }
  function holdsWork () { return !!job && (ACTIVE.has(job.state) || !!worker || !!stopTask || pendingActions.size > 0) }
  function egressStatus (inv) {
    const e = job.egress; const p = e?.plan ?? job.exitReservation?.plan; const exit = job.config.exit ?? normalizeExit({}, { legacy: true })
    const available = inv ? dirtCount(inv) : null
    return { preflight: copy(job.exitPreflight ?? null), reserved: !!job.exitReservation, mode: exit.mode, phase: job.surfaceReturnedAt ? 'completed' : e?.phase ?? 'planned', miningCompleted: !!job.miningCompletedAt, surfaceReturned: !!job.surfaceReturnedAt, migrationFloorY: exit.migrationFloorY ?? null, column: p?.column ?? null, entry: p?.entry ?? null, landing: p?.landing ?? null, startFeet: p?.startFeet ?? null, targetFeetY: p?.targetFeetY ?? null, requiredDirt: p?.requiredDirt ?? null, reserveDirt: exit.reserveDirt, totalDirt: p?.totalDirt ?? null, reservedDirt: job.config.inventory.keepExitDirt ?? 0, dirtAvailable: available, dirtMissing: available != null && p ? Math.max(0, p.totalDirt - available) : null, estimatedDirtMissing: available == null ? null : Math.max(0, (job.config.inventory.keepExitDirt ?? 0) - available), reason: e?.reason ?? null, operationId: e?.operationId ?? null, checkpointStage: e?.checkpoint?.stage ?? e?.checkpoint?.phase ?? null }
  }
  function document () { return job ? copy({ ...job, records: planner?.exportRecords(), ledger: ledger.export() }) : null }
  return { plan, start, pause, emergencyStop, resume, cancel, reopenWorkLayer, recordDebugAction, retryPersistence, acceptExceptions, storeCarriedNow, configureExit, configureTools, configureStorage, configureSupplies, restockSuppliesNow, reconcileSupplyPlacement, reconcileCarriedPlacement, reconcileObservedStoragePlacement, reconcileRejectedStorage, portablePath, portableTravel, storageInterruptionContext, status, load, document, holdsWork, bridge: combatBridge, drain: () => Promise.allSettled([stopTask, worker, ...pendingActions]) }
}

module.exports = { createQuarryJob, QuarryInterrupt, defaults }
