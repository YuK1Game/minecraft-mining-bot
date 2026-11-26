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
const { blockRule, nameOf, selectTool, toolState, AIR, SEAL_MATERIALS, setUnknownBlockDefault } = require('./quarry-rules')
const { keepPlan, canAccept, dropsFittingStacks, totals, diff, createLedger, freeSlots, isFood, selectCarriedStorage, isShulkerBox, carriedContainerKey, spareArmorStackIds, egressDirtRoom } = require('./quarry-inventory')
const { createQuarryCombatBridge } = require('./quarry-combat-bridge')
const { miningUsesAfterExitReserve } = require('./exit/quarry-exit-reserve')
const { normalizeExit, dirtCount, planQuarryExit } = require('./exit/quarry-exit-plan')
const { supplyNeeds, supplyScope, storageSupplyExclusions } = require('./storage/quarry-supplies')
const { totemGuarded } = require('../safety/learning-health')
const { UNSENT_PLACE_REASON } = require('./storage/quarry-portable-storage')
const { supplyPlacementAllowed, planSupplyApproach } = require('./storage/quarry-supply-site')
const { clearableSitePlant, plainAir } = require('./storage/storage-site-terrain')
const { createQuarryCapacityBatch, fullDropBudget, chooseCapacityPrefix } = require('./storage/quarry-capacity-batch')

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
// Live 2026-11-14 02:38 (supplies:18): a placed supply box waited for pickup
// room with a full bag; making room is the same bounded placement of blocks.
const SUPPLY_ROOM_REASONS = new Set(['SUPPLY_CAPACITY_REQUIRED', 'SUPPLY_RECOVERY_SLOT_REQUIRED', 'STORAGE_PICKUP_CAPACITY_REQUIRED', 'STORAGE_RECOVERY_SLOT_REQUIRED'])
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
// Pick-up-then-top-up rounds before an owned box is recovered (bounded).
const PICKUP_SPACE_ROUNDS = 5
// Live 2026-11-12 23:42: the walk to a storage stand timed out before anything
// was placed (storage:102); like a refused site, a new site is chosen.
const storageMoveTimedOut = (result, cp) => result?.reason === 'quarry move: timed out' && cp?.stage === 'planned' && !(cp.placed ?? []).length
// Live 2026-11-13 01:28 (storage:237): a refusal raised by a precondition
// before anything was sent (not settled, face not visible, preview refused,
// ...) is transient when the received state did not change. Codes that report
// an unconfirmed, ambiguous or changed result are never transient.
const NOT_TRANSIENT = /UNCONFIRMED|AMBIGUOUS|RECONCIL|INVALID|PERSISTENCE|MISMATCH|SCOPE|OWNER|ABORT|DEAD|DISCONNECT|LEGACY|EXHAUSTED|FULL|NO_DEPOSITS|CAPACITY|SLOT_REQUIRED|SOURCE_CHANGED|ITEM_CHANGED|BASELINE_CHANGED|STALE/
const TRANSIENT_CODES = new Set(['STORAGE_SITE_CHANGED', 'STORAGE_STAND_UNCONFIRMED', 'SUPPLY_SITE_CHANGED', 'STORAGE_PLACEMENT_PREVIEW_REJECTED', 'STORAGE_PLACEMENT_NOT_SETTLED'])
// Messages about a server result or a timeout come after something was sent.
const AFTER_DISPATCH_TEXT = /サーバー|完了を確認できません|応答|timed out|timeout/i
const transientReason = reason => typeof reason === 'string' && reason.length > 0 && (TRANSIENT_CODES.has(reason) || !/^[A-Z][A-Z0-9_]*$/.test(reason) && !NOT_TRANSIENT.test(reason) && !AFTER_DISPATCH_TEXT.test(reason))
const TRANSIENT_RETRIES = 3, TRANSIENT_WAIT_MS = 1500
const storageFingerprint = cp => JSON.stringify(cp ? [cp.stage ?? null, (cp.placed ?? []).map(p => [p.position, p.name]), (cp.deposited ?? []).map(d => [d.name, d.count]), (cp.plan ?? []).map(e => e.transferred), cp.intent?.type ?? null, !!cp.recovered, !!cp.full] : null)
const supplyFingerprint = cp => JSON.stringify(cp ? [cp.index ?? null, (cp.withdrawn ?? []).length, (cp.returned ?? []).length, storageFingerprint(cp.child), (cp.child?.supplyCheckpoint?.withdrawn ?? []).length, (cp.child?.supplyCheckpoint?.returned ?? []).length] : null)
const { selectAnimalTarget } = require('./quarry-animal-clear')
// Automatic current-state reconciliation of an unconfirmed cargo placement
// (2026-11-13): after the inventory resync rate limit, at most twice per job run.
const AUTO_RECONCILE_WAIT_MS = 65000, AUTO_RECONCILES = 2
// Kept with the bot by the final chest storage of a v2.2 job (2026-11-13).
const FINAL_CHEST_KEEP = { equipment: true, names: ['^(blue|light_blue|brown|yellow)_shulker_box$', '_(pickaxe|shovel|axe|sword|hoe)$', '^(bow|crossbow|arrow|spectral_arrow|tipped_arrow|shield|totem_of_undying|shears|flint_and_steel)$', '^(bread|cooked_[a-z_]+|baked_potato|golden_carrot|golden_apple|enchanted_golden_apple|apple|carrot|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup)$'] }
// Bounded waits before SLOW_BREAK_PERSISTS (2026-11-13).
const SLOW_BREAK_WAITS = 3
const WORK_DIRT_DEMAND = 32 // dirt taken from the supply box when a seal needs it
// Carried storage refused before any placement, deposit or move (live 2026-11-12).
const STORAGE_SITE_RETRY_REASONS = new Set([...SUPPLY_SITE_REASONS, 'STORAGE_PLACEMENT_PREVIEW_REJECTED', 'STORAGE_PLACEMENT_NOT_SETTLED'])
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
    safety: { retreatHealthRatio: 0.70, emergencyHealthRatio: 0.40, resumeHealthRatio: 0.90, eatFoodLevel: 17, recoverTimeoutMs: 180000, ...(c.safety ?? {}) },
    quarryCombat: { enabled: true, ...(c.quarryCombat ?? {}) },
    persistence: { checkpointAfterBatch: true, ...(c.persistence ?? {}) }
  }
}

function createQuarryJob ({ adapter, storage = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {}, bridge = null, pollMs = 50, slowBreakWaitMs = 30000, cargoLossSearchMs = 60000, cargoLossStepMs = 5000, autoResumeMs = 30000, capacityRetryMs = 75000, stopTimeoutMs = 5000, storageMode = 'legacy' } = {}) {
  // The production Runtime pins this to shulker. Legacy primitives remain for
  // read/recovery tests, never as a browser/CLI-selectable policy.
  const shulkerOnly = storageMode === 'shulker'
  // The job's state items carry no NBT; attach the received raw bag item when
  // its stack ID matches (box identity and contents, 2026-11-13).
  const withRaw = inventory => Array.isArray(inventory) && typeof adapter.rawItem === 'function' ? inventory.map(item => {
    if (item?.raw || !Number.isInteger(item?.slot)) return item
    let raw = null; try { raw = adapter.rawItem(item.slot) } catch {}
    return raw && raw.stack_id === item.stackId && raw.count === item.count ? { ...item, raw } : item
  }) : inventory
  const cargoSelection = (inventory, options = {}) => selectCarriedStorage(withRaw(inventory), { excludedShulkerIdentities: job?.exhaustedShulkerIdentities ?? [], ...options, shulkerOnly })
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
  let stopTask = null; let autoResumeTimer = null; let savesInFlight = 0; let retired = false
  const pendingActions = new Set()
  const busyError = () => Object.assign(new Error('QUARRY_BUSY: previous work or checkpoint is still draining'), { code: 'QUARRY_BUSY' })
  function requireDrained () { if (worker || stopTask || pendingActions.size || savesInFlight) throw busyError() }
  // The scheduled bounded automatic retry, shown as a wait (not an error) on the
  // dashboard (2026-11-13).
  let autoRetryInfo = null
  function clearAutoResume () { clearTimeout(autoResumeTimer); autoResumeTimer = null; autoRetryInfo = null }
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
  // A received offhand totem: the 70%/40% retreat and the 90% recovery wait
  // do not stop the work (2026-11-14 01:59 user). Without it, unchanged.
  const healthRatio = s => totemGuarded(s) ? 1 : s.health / (Number.isFinite(s.maxHealth) && s.maxHealth > 0 ? s.maxHealth : 20)
  const foodOf = s => s.food ?? s.hunger ?? null
  const items = s => s?.inventory?.known === true && !s.inventory.uncertain && Array.isArray(s.inventory.items) ? s.inventory.items : null
  // Shulker-only jobs do not build storage chests. Keep explicit material
  // reservations, but do not inherit the old chest-building wood defaults.
  const spareArmor = () => { if (job.config.strategy?.storeSpareArmor !== true) return []; try { return spareArmorStackIds(adapter.inventoryDetails?.()) } catch { return [] } }
  const exitDirtGoal = () => job.exitDirtLimit ?? Math.max(192, job.config.inventory.keepExitDirt ?? 0)
  const inventoryPolicy = () => ({ ...job.config.inventory, ...(job.config.strategy?.clearAnimals === true ? { keepRawMeat: false } : {}), ...(job.config.strategy?.storeSpareArmor === true ? { cargoStackIds: spareArmor() } : {}), ...(shulkerOnly ? { keepLogs: job.config.inventory.keepLogs ?? 0, keepPlanks: job.config.inventory.keepPlanks ?? 0 } : {}), toolPolicy: job.config.tools, ...(fourLayerStorage() ? { keepExitDirt: 0, keepSealBlocks: 64 } :
    deferredExitSupplies() ? { keepExitDirt: job.egressPreparation === true ? exitDirtGoal() : 0, keepSealBlocks: job.egressPreparation === true && job.egressRoom === true ? 0 : 64, ...(job.egressPreparation === true && job.egressRoom === true ? { keepCoal: 0, keepSticks: 0 } : {}), ...(workDirtOnDemand() ? { sealDirt: job.egressPreparation === true || job.dirtDemand === true, keepSticks: job.config.inventory.keepSticks ?? 0 } : {}) } : {}) })
  // Live 2026-11-12 23:28: 34 of 36 slots were fixed items, leaving 2 for
  // mining. Opt-in (strategy.dirtFromSupplyOnDemand, 2026-11-13): in the v2.2
  // carried mode the 64 work dirt and the sticks are not held; dirt is taken
  // from the dirt supply box only when a seal needs it. New jobs keep the
  // v2.2 default (64 work dirt carried) unless the job asks for it.
  const workDirtOnDemand = () => job?.config.strategy?.dirtFromSupplyOnDemand === true && !fourLayerStorage() && deferredExitSupplies() && (job.config.inventory.supplyBoxes ?? []).some(b => b?.role === 'dirt')
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
    owner.records = planner?.exportRecords() ?? copy(owner.records)
    owner.ledger = ledger.export()
    const savedAt = new Date(now()).toISOString()
    const document = { ...copy({ ...owner, records: undefined, savedAt, persistence: { status: 'saved', savedAt }, events: events.slice(-50) }), records: owner.records }
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

  // This part lives in quarry-job-plan.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const jobPlan = require('./quarry-job-plan').createQuarryJobPlan({
    get ACTIVE () { return ACTIVE },
    get adapter () { return adapter }, set adapter ($value) { adapter = $value },
    get AIR () { return AIR },
    get blockRule () { return blockRule },
    get buildRegions () { return buildRegions },
    get cargoSelection () { return cargoSelection },
    get CAVE_RATIO () { return CAVE_RATIO },
    get CAVE_RUN () { return CAVE_RUN },
    get CAVE_UNKNOWN_RATIO () { return CAVE_UNKNOWN_RATIO },
    get chunkBounds () { return chunkBounds },
    get clearAutoResume () { return clearAutoResume },
    get configuredLoadoutHome () { return configuredLoadoutHome },
    get copy () { return copy },
    get countsRevision () { return countsRevision }, set countsRevision ($value) { countsRevision = $value },
    get createLedger () { return createLedger },
    get createQuarryPlanner () { return createQuarryPlanner },
    get defaults () { return defaults },
    get emptyLoadoutInventory () { return emptyLoadoutInventory },
    get feetCell () { return feetCell },
    get isFood () { return isFood },
    get items () { return items },
    get job () { return job }, set job ($value) { job = $value },
    get ledger () { return ledger }, set ledger ($value) { ledger = $value },
    get loadoutPorts () { return loadoutPorts },
    get nameOf () { return nameOf },
    get permits () { return permits },
    get planner () { return planner }, set planner ($value) { planner = $value },
    get planQuarryExit () { return planQuarryExit },
    get randomUUID () { return randomUUID },
    get regions () { return regions }, set regions ($value) { regions = $value },
    get requireDrained () { return requireDrained },
    get setUnknownBlockDefault () { return setUnknownBlockDefault },
    get shulkerOnly () { return shulkerOnly },
    get storageSupplyExclusions () { return storageSupplyExclusions },
    get v22SupplyLayout () { return v22SupplyLayout },
    get validStoragePair () { return validStoragePair },
    get validSupplyBindings () { return validSupplyBindings },
    get worldIdentity () { return worldIdentity }
  })
  function planningBlocks (...args) { return jobPlan.planningBlocks(...args) }
  function makeRegions (...args) { return jobPlan.makeRegions(...args) }
  function rebuildPlanner (...args) { return jobPlan.rebuildPlanner(...args) }
  function plan (...args) { return jobPlan.plan(...args) }

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
  // An exit action keeps only a summary of its checkpoint: the full checkpoint
  // (every climbed step with its diagnostics) already lives in job.egress, and
  // copying it into each action made saved jobs 10-15 MB and every save block
  // the event loop for most of a second during the climb.
  function egressActionResult (result) {
    if (result == null) return null
    const { checkpoint, ...rest } = result
    if (checkpoint == null || typeof checkpoint !== 'object') return copy(result)
    return { ...copy(rest), checkpoint: { summary: true, operationId: checkpoint.operationId ?? null, phase: checkpoint.phase ?? null, confirmedFeetY: checkpoint.confirmedFeetY ?? null, steps: Array.isArray(checkpoint.steps) ? checkpoint.steps.length : null, serverConfirmed: checkpoint.serverConfirmed ?? null } }
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

  // The selected exit column's dirt need (prediction only, no state change).
  function exitPlanDirt (myEpoch) {
    if (job.config.exit?.mode !== 'adjacent_pillar') return null
    try {
      const state = guard(myEpoch), read = planningBlocks(job.config)
      const result = planQuarryExit({ regions, yTop: job.yTop, feet: feetCell(state), getBlock: (x, y, z) => read(x, y, z), inventory: items(state), policy: { ...job.config.tools, ...job.config.collection }, exit: job.config.exit, preflight: true, reservation: job.exitReservation?.plan ?? null })
      return Number.isSafeInteger(result?.plan?.totalDirt) ? result.plan.totalDirt : null
    } catch (error) { if (error instanceof QuarryInterrupt) throw error; return null }
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
        if (job.exitDirtLimit != null && job.exitDirtLimit < result.plan.totalDirt + 8) { job.exitDirtLimit = result.plan.totalDirt + 8; note('egress_dirt_limited', { target: job.exitDirtLimit, from: 'exit_plan' }) }
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
          // 2026-11-13: unreceived equipment is fetched again and held items go to
          // the same chest first inside the withdrawal; no early refusal here.
        }
        return adapter.loadoutWithdraw({
        jobId: job.config.jobId, operationId: active.operationId,
        allowReceivedPrefixUse: job.config.initialLoadout === 'v22',
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
    if (job.config.initialLoadout === 'v22' && job.loadoutReady !== true) { setState('PREFLIGHT'); return }
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
    // 2026-11-14 02:01 user: "満腹度が一定以下になると体力を回復しなくなるので、満腹度が
    // 一定以下の場合は食事を取るようにしてください". Natural regeneration needs 18+:
    // below 18 the bot eats, then keeps eating up to 20 (saved jobs with the
    // old 16 are raised to 17).
    const eatBelow = Math.max(17, job.config.safety.eatFoodLevel ?? 17)
    if (Number.isFinite(food) && food <= eatBelow) job.eatingToFull = true
    if (Number.isFinite(food) && food >= 20) job.eatingToFull = false
    if (!(Number.isFinite(food) && (food <= eatBelow || (recovering || job.eatingToFull === true) && food < 20))) return false
    if (!inv.some(i => isFood(i.name))) { job.eatingToFull = false; return false }
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
    // Live 2026-11-13 17:15: after the exit dirt withdrawal the bag was full of
    // kept items only (exit dirt, tools, boxes); returning to store nothing
    // paused the job (WAITING_FOR_STORAGE). During the exit preparation a full
    // bag with nothing to deposit goes on to the exit instead.
    const egressFullOfKept = job.egressPreparation === true && freeSlots(inv) === 0 && !keepPlan(inv, inventoryPolicy()).deposits.length
    if (!egressFullOfKept && (fullOnlyStorage() ? freeSlots(inv) === 0 && !job.storageExhausted : freeSlots(inv) < job.config.inventory.minFreeSlots)) { await collect(myEpoch, 'capacity'); job.depositReason = fullOnlyStorage() ? 'full' : 'capacity'; setState('RETURN'); return }
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
    if (await clearAnimal(myEpoch)) return
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
      // A seal needs dirt that is no longer carried: take it from the dirt
      // supply box (ordinary supply restock, server-confirmed), retried on the
      // spot up to three times before the usual pause.
      if (decision.reason === 'SEAL_MATERIAL_MISSING' && workDirtOnDemand() && (job.dirtDemandTries ?? 0) < 3) {
        job.dirtDemand = true; job.dirtDemandTries = (job.dirtDemandTries ?? 0) + 1
        note('work_dirt_demand', { attempt: job.dirtDemandTries, details: copy(decision.details ?? null) })
        await save('work_dirt_demand')
        if (await restock(myEpoch, 'SURVEY')) return
      }
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

  // Quarry animal clearing (2026-11-13, opt-in strategy.clearAnimals): with
  // no hostile around and no combat active, remove one allowed passive animal
  // inside the pit (job columns + 1, surface to the deepest layer, 8 m from
  // the bot). Unreachable animals are left alone; drops are not collected.
  async function clearAnimal (myEpoch) {
    if (job.config.strategy?.clearAnimals !== true || typeof adapter.attackAnimal !== 'function' || typeof adapter.actors !== 'function' || adapter.combatActive()) return false
    if ((job.animalClearHoldUntil ?? 0) > now()) return false
    const s = guard(myEpoch), actors = adapter.actors()
    const pick = selectAnimalTarget({ actors, state: s, columns: regions.columns, yTop: job.config.yTop ?? job.yTop, yBottom: Math.min(job.deepestY ?? job.cursorY, job.cursorY) })
    if (!pick.target) return false
    const target = pick.target, skip = job.animalClearSkips ??= {}
    if ((skip[target.uniqueId] ?? 0) > now()) return false
    note('animal_clear_start', { type: target.entityType, runtimeId: target.runtimeId, distance: Math.round(pick.distance * 10) / 10 })
    // Live 2026-11-13 13:05: the 400 ms wait was shorter than the 750 ms attack
    // cooldown, so refused swings used up the attempts. Wait 800 ms; a cooldown
    // refusal is not an attempt.
    for (let attempt = 0; attempt < 8; attempt++) {
      guard(myEpoch)
      if (adapter.combatActive()) return true
      const current = adapter.actors().find(a => String(a.runtimeId) === String(target.runtimeId) && String(a.uniqueId) === String(target.uniqueId))
      if (!current || current.alive === false) {
        job.animalsCleared = (job.animalsCleared ?? 0) + 1
        note('animal_cleared', { type: target.entityType, runtimeId: target.runtimeId, total: job.animalsCleared })
        await save('animal_cleared'); return true
      }
      const st = guard(myEpoch), eye = st.position, aim = { x: current.position.x, y: current.position.y + 0.3, z: current.position.z }
      if (Math.hypot(aim.x - eye.x, aim.y - eye.y, aim.z - eye.z) > 2.6) {
        const f = feetCell(st), base = { x: Math.floor(current.position.x), y: Math.floor(current.position.y), z: Math.floor(current.position.z) }, cells = []
        for (let dy = -1; dy <= 1; dy++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) cells.push({ x: base.x + dx, y: base.y + dy, z: base.z + dz })
        const stance = cells.filter(c => planner.standable(c) && permits(regions, 'travel', c).allowed && permits(regions, 'travel', { ...c, y: c.y + 1 }).allowed)
          .sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y, a.z - f.z) - Math.hypot(b.x - f.x, b.y - f.y, b.z - f.z))[0]
        if (!stance) break
        try { await moveToStance(myEpoch, stance) } catch (error) { if (error instanceof QuarryInterrupt) throw error; break }
        continue
      }
      try { await call(myEpoch, 'attack_animal', signal => adapter.attackAnimal(target.runtimeId, { signal })) } catch (error) {
        if (error instanceof QuarryInterrupt) throw error
        const cooldown = /連打を避ける/.test(String(error.message ?? ''))
        if (cooldown) attempt--
        else note('animal_attack_refused', { runtimeId: target.runtimeId, error: String(error.message ?? error).slice(0, 120) })
      }
      await sleep(800)
    }
    skip[target.uniqueId] = now() + 60000
    job.animalClearHoldUntil = now() + 5000
    note('animal_clear_skipped', { type: target.entityType, runtimeId: target.runtimeId })
    return false
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
    // Passive pickup uses received inventory and stops at a full bag. Only
    // active collection and held-box batches need predicted drop capacity.
    const initial = guard(myEpoch)
    const receiptScope = { job, epoch: myEpoch, scope: scopeOf(initial), life: lifeOf(initial) }
    const inv = items(initial)
    if (!inv) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    const requireDropCapacity = !passivePickup() || capacityActionId != null
    let drops = []
    try { if (requireDropCapacity) drops = fullDropBudget(decision.targets, decision.tool) } catch (error) {
      if (/^DROP_/.test(error.code ?? '')) {
        const p = error.details?.target?.position
        const b = p ? adapter.getBlock(p.x, p.y, p.z) : null
        const held = initial.heldItem
        error.details = { ...(error.details ?? {}), reason: error.code, scope: scopeOf(initial), life: lifeOf(initial), selectedSlot: initial.selectedSlot ?? null, heldItem: held ? { name: held.name ?? null, slot: held.slot ?? null, stackId: held.stackId ?? null, enchantments: copy(held.enchantments ?? null) } : null, observedBlock: b ? { known: b.known === true, name: b.name ?? null, runtimeId: b.runtimeId ?? null, properties: copy(b.properties ?? null), extra: copy(b.extra ?? null), boundingBox: b.boundingBox ?? null } : null }
      }
      throw error
    }
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
    for (const target of plannedTargets.filter(t => ['leaf_litter', 'wildflowers'].includes(nameOf(t.name)))) {
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
    const targets = plannedTargets.map(t => ({ x: t.position.x, y: t.position.y, z: t.position.z, expectedName: t.name, expectedRuntimeId: t.runtimeId ?? null, requiredTool: tool.kind !== 'hand' ? { kind: tool.kind, tier: tool.tier, reserve: tool.reserve } : null, ...(['leaf_litter', 'wildflowers'].includes(nameOf(t.name)) ? { expectedProperties: copy(t.properties ?? null) } : {}), ...(t.accessPreparation ? { accessPreparation: t.accessPreparation } : {}), ...(t.fluidSource ? { fluidSource: copy(t.fluidSource) } : {}) }))
    const rec = recordAction({ type: 'mine', stance: decision.stance, targets: targets.map(t => ({ x: t.x, y: t.y, z: t.z, name: t.expectedName, ...(['minecraft:leaf_litter', 'minecraft:wildflowers'].includes(t.expectedName) ? { runtimeId: t.expectedRuntimeId, properties: copy(t.expectedProperties) } : {}) })), tool: decision.tool?.name ?? 'hand', ...(capacityActionId ? { capacityActionId } : {}) })
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
      // Live 2026-11-13 16:03: three slow breaks (2.12 s of a 2.1 s limit) were
      // the start of server lag that ended in a disconnect. Lag passes: resync,
      // wait (30 s, 60 s, 90 s) and try again; stop only when it persists.
      if (job.slowBreaks >= 3 && (job.slowBreakWaits ?? 0) < SLOW_BREAK_WAITS) {
        job.slowBreakWaits = (job.slowBreakWaits ?? 0) + 1
        const waitMs = slowBreakWaitMs * job.slowBreakWaits
        note('slow_break_wait', { attempt: job.slowBreakWaits, max: SLOW_BREAK_WAITS, waitMs, cells: copy(job.slowCells) })
        job.slowCells = []; job.slowBreaks = 0
        await save('slow_break_wait')
        const until = now() + waitMs
        while (now() < until) { await sleep(Math.min(500, waitMs)); guard(myEpoch) }
        try { await call(myEpoch, 'resync', signal => adapter.resyncInventory?.({ signal })) } catch (error) { if (error instanceof QuarryInterrupt) throw error; note('resync_failed', { error: String(error.message ?? error).slice(0, 200) }) }
        lastInventory = totals(items(adapter.getState()) ?? [])
        return
      }
      if (job.slowBreaks >= 3) return finish('PAUSED', 'SLOW_BREAK_PERSISTS', { pauseDetails: { lastError: rec.error, held: adapter.getState()?.heldItem?.name ?? null, cells: copy(job.slowCells) } })
      try { await call(myEpoch, 'resync', signal => adapter.resyncInventory?.({ signal })) } catch (error) { if (error instanceof QuarryInterrupt) throw error; note('resync_failed', { error: String(error.message ?? error).slice(0, 200) }) }
      lastInventory = totals(items(adapter.getState()) ?? [])
      return
    }
    // Confirmed progress also renews the terrain request budget: received
    // subchunks far above are dropped as the bot digs down, so the exit column
    // may need a fresh request later (live 2026-11-10 11:35: budget spent at start).
    if (confirmed) { job.slowBreaks = 0; job.slowCells = []; job.slowBreakWaits = 0; job.routeSkips = 0; job.autoResumes = 0; job.capacityRetries = 0; job.autoReconciles = 0; if (job.terrainObservation?.phase === 'exhausted') { job.terrainObservation.requests = 0; job.terrainObservation.phase = 'idle' } }
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
  async function collect (myEpoch, why, { onObservation = null, onlyDropIds = null } = {}) {
    const storageCleanup = why === 'storage_recovery_space'
    if (storageCleanup && (!Array.isArray(onlyDropIds) || !onlyDropIds.length || onlyDropIds.length > 16 || !onlyDropIds.every(id => typeof id === 'string' && /^\d{1,20}$/.test(id)) || new Set(onlyDropIds).size !== onlyDropIds.length)) throw new QuarryInterrupt('STORAGE_PICKUP_TARGETS_INVALID')
    const selectedIds = storageCleanup ? new Set(onlyDropIds) : null
    // The adapter already scopes/filters its item actors and intentionally
    // omits dimension/positionKnown from this narrow port. Honor either field
    // when present without requiring metadata the port does not expose.
    const selectedDrop = e => !storageCleanup || selectedIds.has(String(e.runtimeId)) && e.alive !== false && e.positionKnown !== false && (e.dimension == null || e.dimension === adapter.getState().dimension) && Number.isSafeInteger(e.count) && e.count > 0 && e.count <= 127 && ['x', 'y', 'z'].every(axis => Number.isFinite(e.position?.[axis])) && typeof e.name === 'string' && /^(?:minecraft:)?[a-z0-9_]+$/.test(e.name) && !isShulkerBox(e.name) && !['WOOD_HARVEST_DISABLED', 'LEAF_HARVEST_DISABLED'].includes(blockRule(e.name).reason)
    const preservedDrops = storageCleanup ? pendingDrops.filter(d => !selectedIds.has(String(d.runtimeId))) : []
    if (passivePickup() && !storageCleanup) {
      guard(myEpoch); observeInventory(job.state); observeDrops(); recordPassivePickup(why)
      setState('PLAN')
      return
    }
    setState('COLLECT', { collectReason: why })
    const s = guard(myEpoch)
    const ents = new Map(adapter.entities().filter(e => e.kind === 'item' && e.position && selectedDrop(e)).map(e => [e.runtimeId, e]))
    if (onObservation) await onObservation([...ents.values()])
    // Refresh tracked drops; vanished ones are unknown unless the bag grew.
    const initialInventory = items(s)
    if (storageCleanup && !initialInventory) throw new QuarryInterrupt('INVENTORY_UNKNOWN')
    const before = totals(initialInventory ?? [])
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
    for (let k = remaining.length - 1; k >= 0; k--) if (!storageCleanup && why !== 'final' && (stuckItems.has(remaining[k].runtimeId) || remaining[k].reason === 'STUCK_REPEATED')) skipped.push(...remaining.splice(k, 1))
    const unreachable = skipped.map(d => ({ ...d, reason: d.reason === 'STUCK_REPEATED' ? d.reason : 'STUCK' }))
    let needRoom = false
    const PASS = storageCleanup ? 4 : 48
    const around = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    const present = id => adapter.entities().some(e => e.runtimeId === id)
    const waitGone = async (id, ms) => { const until = now() + ms; while (now() < until && present(id)) await sleep(50); return !present(id) }
    let visits = 0
    // Rank by actual reachable paths, not distance through a wall or pit.
    // Drops at the collection deadline come first; a nearby stand can still
    // cover several items passively. Recompute after each confirmed move.
    while (remaining.length) {
      const here = guard(myEpoch); const feet = { x: here.position.x, y: here.position.y - FEET, z: here.position.z }
      const actors = adapter.entities().filter(selectedDrop)
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
      // Cleanup never relies on name-only stack merging to enter a full bag.
      if (storageCleanup && freeSlots(inv) === 0) { needRoom = true; unreachable.push({ ...d, reason: 'NO_CAPACITY' }); continue }
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
    pendingDrops = [...preservedDrops, ...unreachable.filter(d => still.has(d.runtimeId)).map(d => ({ ...d, unreachable: !['NO_CAPACITY', 'NEXT_PASS', 'STUCK'].includes(d.reason) }))]
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
    if (job.dirtDemand && nameOf(decision.material) === 'dirt') { job.dirtDemand = false; job.dirtDemandTries = 0 }
    planner.recordPlacement(decision.position, decision.purpose, decision.material)
    countsRevision++
    ledger.add(decision.purpose === 'seal' ? 'placedSeal' : 'placedTemporary', decision.material)
    if (decision.sourceSeal) { note('fluid_source_plugged', { position: decision.position, cells: decision.sourceSeal.size }); await save('fluid_source_plugged'); setState('SURVEY'); return }
    if (decision.boundaryOpening) { note('boundary_opening_closed', { position: decision.position }); await save('boundary_opening_closed'); setState('SURVEY'); return }
    if (decision.purpose === 'floor') { note('cave_floor_filled', { position: decision.position, material: decision.material }); await save('cave_floor_filled'); setState('SURVEY'); return }
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
    const required = exitDirtRequired(), available = dirtCount(main)
    if (available >= required) return true
    // 2026-11-14 (user: "土はシュルカーボックスにあるはずだが？"): the dirt the
    // mining put into the carried cargo boxes counts too. The withdrawal takes
    // from one bound box, so the box that covers the need becomes the source.
    const source = await preferDirtSource(required - available, 'exit_supply_check', view)
    if (source?.dirt != null && available + source.dirt >= required) return true
    const boxes = carriedDirtBoxes(view), stored = boxes.reduce((n, b) => n + (b.dirt ?? 0), 0)
    if (!boxes.some(b => b.bound) || boxes.some(b => b.dirt == null)) { await finish('PAUSED', 'EXIT_SUPPLY_UNCONFIRMED'); return false }
    await finish('PAUSED', 'EXIT_SUPPLY_MISSING', { pauseDetails: { carried: available, stored, best: Math.max(0, ...boxes.map(b => b.dirt ?? 0)), required } }); return false
  }
  const exitDirtRequired = () => Math.max(192, job.config.exit?.reservedDirt ?? 0, job.exitReservation?.plan?.totalDirt ?? 0)
  // Received dirt of each carried box: the bound dirt supply box and the cargo
  // boxes (not a supply colour). A box whose 27 slots were not all received
  // reports dirt null (unknown, never counted).
  function carriedDirtBoxes (view = adapter.equipmentView?.()) {
    const supply = require('../loadout/loadout-manifest').SUPPLY_NAMES, binding = (job.config.inventory.supplyBoxes ?? []).find(b => b?.role === 'dirt')
    const rows = []
    for (const row of view?.slots ?? []) {
      if (row?.known !== true || row.empty || row.count !== 1 || !isShulkerBox(row.name)) continue
      const key = carriedContainerKey(row), bound = key === binding?.key && row.name === binding?.boxName
      if (!bound && supply.includes(row.name)) continue
      const slots = row.container?.known === true ? row.container.slots : null
      const known = Array.isArray(slots) && slots.length === 27 && slots.every(s => !s || s.known === true && (s.empty === true || typeof s.name === 'string' && Number.isInteger(s.count) && s.count > 0 && s.count <= 64))
      const dirt = known ? slots.reduce((n, s) => n + (s && !s.empty && s.name === 'minecraft:dirt' ? s.count : 0), 0) : null
      rows.push({ key, boxName: row.name, stackId: row.stackId ?? null, slot: row.slot ?? null, bound, dirt })
    }
    return rows
  }
  // The bound dirt box when it covers the need; otherwise the carried cargo box
  // with the most received dirt that does becomes the dirt supply binding. The
  // withdrawal itself stays the ordinary supply operation (place, open,
  // withdraw, pick up; confirmed by the received inventory and box NBT).
  async function preferDirtSource (needed, why, view = adapter.equipmentView?.()) {
    const boxes = carriedDirtBoxes(view), bound = boxes.find(b => b.bound) ?? null
    if (job.supplyRestock || job.portableStorage || !validSupplyBindings(job.config.inventory.supplyBoxes)) return bound
    if (bound?.dirt != null && bound.dirt >= needed) return bound
    const best = boxes.filter(b => !b.bound && b.dirt != null && b.dirt >= needed).sort((a, b) => b.dirt - a.dirt || (a.slot ?? 99) - (b.slot ?? 99))[0]
    if (!best) return bound
    return (await rebindDirtSource(best, why)) ? best : bound
  }
  async function rebindDirtSource (box, why) {
    const bindings = job.config.inventory.supplyBoxes, index = bindings.findIndex(b => b?.role === 'dirt'), prior = copy(bindings[index] ?? null)
    if (index < 0 || typeof box?.key !== 'string') return false
    bindings[index] = { role: 'dirt', itemName: 'minecraft:dirt', key: box.key, boxName: box.boxName, stackId: box.stackId, source: 'cargo' }
    if (!validSupplyBindings(bindings)) { bindings[index] = prior; return false }
    job.dirtSourceChanges = [...(job.dirtSourceChanges ?? []), { at: new Date(now()).toISOString(), why, from: prior, to: copy(bindings[index]), dirt: box.dirt }].slice(-16)
    note('dirt_source_rebound', { why, from: prior?.boxName ?? null, to: box.boxName, slot: box.slot, dirt: box.dirt })
    await save('dirt_source_rebound')
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

  // This part lives in quarry-job-restock.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const jobRestock = require('./quarry-job-restock').createQuarryJobRestock({
    get adapter () { return adapter }, set adapter (value) { adapter = value },
    get blockRule () { return blockRule },
    get call () { return call },
    get canAccept () { return canAccept },
    get clearableSitePlant () { return clearableSitePlant },
    get clearWorkDeferred () { return clearWorkDeferred },
    get copy () { return copy },
    get deferredExitSupplies () { return deferredExitSupplies },
    get enterQuarryForSupply () { return enterQuarryForSupply },
    get equipTool () { return equipTool },
    get exitDirtGoal () { return exitDirtGoal },
    get feetCell () { return feetCell },
    get finish () { return finish },
    get fourLayerStorage () { return fourLayerStorage },
    get guard () { return guard },
    get initialSupplyStation () { return initialSupplyStation },
    get isDeepStrictEqual () { return isDeepStrictEqual },
    get items () { return items },
    get job () { return job }, set job (value) { job = value },
    get lastInventory () { return lastInventory }, set lastInventory (value) { lastInventory = value },
    get makeSupplyRoom () { return makeSupplyRoom },
    get moveToStance () { return moveToStance },
    get note () { return note },
    get now () { return now }, set now (value) { now = value },
    get observeInventory () { return observeInventory },
    get permits () { return permits },
    get plainAir () { return plainAir },
    get planner () { return planner }, set planner (value) { planner = value },
    get planSupplyApproach () { return planSupplyApproach },
    get QuarryInterrupt () { return QuarryInterrupt },
    get recordAction () { return recordAction },
    get refreshSupplyBindingKeys () { return refreshSupplyBindingKeys },
    get regions () { return regions }, set regions (value) { regions = value },
    get rescopeBoxAfterReconnect () { return rescopeBoxAfterReconnect },
    get samePoint () { return samePoint },
    get save () { return save },
    get setState () { return setState },
    get sleep () { return sleep }, set sleep (value) { sleep = value },
    get SUPPLY_ROOM_REASONS () { return SUPPLY_ROOM_REASONS },
    get SUPPLY_SITE_REASONS () { return SUPPLY_SITE_REASONS },
    get SUPPLY_SITE_RETRIES () { return SUPPLY_SITE_RETRIES },
    get SUPPLY_SITE_RETRY_WAIT_MS () { return SUPPLY_SITE_RETRY_WAIT_MS },
    get supplyCanClear () { return supplyCanClear },
    get supplyCanPlace () { return supplyCanPlace },
    get supplyFingerprint () { return supplyFingerprint },
    get supplyNeeds () { return supplyNeeds },
    get supplyScope () { return supplyScope },
    get supplyUntouched () { return supplyUntouched },
    get TOOL_WAIT () { return TOOL_WAIT },
    get totals () { return totals },
    get TRANSIENT_RETRIES () { return TRANSIENT_RETRIES },
    get TRANSIENT_WAIT_MS () { return TRANSIENT_WAIT_MS },
    get transientReason () { return transientReason },
    get v22SupplyLayout () { return v22SupplyLayout },
    get validSupplyBindings () { return validSupplyBindings },
    get WORK_DIRT_DEMAND () { return WORK_DIRT_DEMAND },
    get workDirtOnDemand () { return workDirtOnDemand }
  })
  function restock (...args) { return jobRestock.restock(...args) }
  // A box operation left with its box placed when only the connection
  // changed (live 2026-11-14 02:50: server-side disconnect; supplies:18 then
  // stopped SUPPLY_SCOPE_CHANGED). Continued on the new connection when: no
  // unconfirmed action (no intent anywhere), the placed box block is received
  // at its cell with the same name and block state, and the same player
  // (profile, realm), dimension and life. The scopes are taken over, the window
  // is opened again by the ordinary operation, and anything derived from old
  // stack IDs (pack baseline) is dropped so it is taken again before the break.
  // A box already being broken or awaiting pickup is never continued this way.
  async function rescopeBoxAfterReconnect (box, parent, kind, operationId) {
    if (!box || box.kind !== 'shulker' || box.placed?.length !== 1 || !['placed', 'depositing', 'packed'].includes(box.stage)) return false
    let scope = null
    try { scope = supplyScope(adapter.getState()) } catch { return false }
    const old = box.scope
    if (!old) return false
    if (['profile', 'realmId', 'dimension'].some(k => String(old[k]) !== String(scope[k])) || old.life !== scope.life) return false
    if (old.connectionId === scope.connectionId && old.startedAt === scope.startedAt && (!parent || isDeepStrictEqual(parent.scope, scope))) return false
    if (box.intent != null || parent?.intent != null || box.supplyCheckpoint?.intent != null || box.placementFailure) return false
    const placed = box.placed[0], block = adapter.getBlock(placed.position.x, placed.position.y, placed.position.z)
    if (block?.known !== true || nameOf(block) !== nameOf(placed.name) || placed.runtimeId != null && block.runtimeId != null && block.runtimeId !== placed.runtimeId) return false
    const from = { connectionId: old.connectionId, startedAt: old.startedAt }
    const take = s => s ? Object.assign(s, { connectionId: scope.connectionId, startedAt: scope.startedAt, runtimeEntityId: scope.runtimeEntityId }) : s
    take(box.scope); if (parent) take(parent.scope); take(box.supplyCheckpoint?.scope)
    const stage = box.stage
    box.stage = 'placed'; box.opened = false; box.windowId = null
    delete box.expectedContents; delete box.recoveryBaseline
    note('box_operation_rescoped', { kind, operationId: operationId ?? null, stage, position: copy(placed.position), from, to: { connectionId: scope.connectionId, startedAt: scope.startedAt } })
    await save('box_operation_rescoped')
    return true
  }
  // Stack IDs change on a reconnect (live 2026-11-14 02:19: after the bot
  // restarted, the pickaxe box was bound as blue:1158 but carried as blue:2597;
  // supplies:11 stopped SUPPLY_BOX_MISSING). Before a supply operation touches a
  // box, a binding whose key is not carried is re-found: a supply colour by its
  // one carried box of that colour; the cargo dirt source by the carried cargo
  // box with the most received dirt. Ambiguous or absent: left as is (the
  // operation then stops as before). An operation already holding a placed box
  // is never rebound.
  async function refreshSupplyBindingKeys (active) {
    const inv = items(adapter.getState()), bindings = job.config.inventory.supplyBoxes
    if (!inv || !Array.isArray(bindings) || active?.checkpoint?.child) return
    const supply = require('../loadout/loadout-manifest').SUPPLY_NAMES, carried = new Set(inv.map(i => carriedContainerKey(i)))
    const changes = []
    for (const b of bindings) {
      if (!b || typeof b.key !== 'string' || carried.has(b.key)) continue
      let next = null
      if (supply.includes(b.boxName)) {
        const same = inv.filter(i => i.name === b.boxName && i.count === 1)
        if (same.length === 1) next = same[0]
      } else if (b.role === 'dirt' && b.source === 'cargo') {
        const best = carriedDirtBoxes().filter(x => x.dirt != null && x.dirt > 0).sort((x, y) => y.dirt - x.dirt || (x.slot ?? 99) - (y.slot ?? 99))[0]
        if (best) next = inv.find(i => carriedContainerKey(i) === best.key) ?? null
      }
      if (!next) continue
      const key = carriedContainerKey(next)
      if (bindings.some(o => o !== b && o.key === key)) continue
      changes.push({ role: b.role, from: b.key, to: key })
      b.key = key; b.stackId = next.stackId ?? null
    }
    if (!changes.length) return
    const cp = active?.checkpoint
    if (cp && Array.isArray(cp.bindings) && !cp.child) for (const c of changes) { const row = cp.bindings.find(x => x.role === c.role); if (row) { row.key = c.to; row.stackId = bindings.find(x => x.role === c.role).stackId } }
    note('supply_bindings_refreshed', { changes })
    await save('supply_bindings_refreshed')
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

  const storageScopeMatches = (cp, state) => cp?.scope && ['profile', 'dimension', 'connectionId', 'startedAt'].every(field => cp.scope[field] === state[field]) && cp.scope.realmId === String(state.realm?.id) && cp.scope.runtimeEntityId === String(state.runtimeEntityId) && cp.scope.life === lifeOf(state)
  const sameOwnedStorageBox = (cp, state) => {
    if (!storageScopeMatches(cp, state) || cp.kind !== 'shulker' || cp.purpose != null || !['placed', 'depositing'].includes(cp.stage) || cp.intent != null && cp.intent.type !== 'deposit' || cp.placed?.length !== 1 || cp.positions?.length !== 1 || cp.recovered != null) return false
    const owned = cp.placed[0]
    if (owned.confirmedBy !== 'server_block_and_inventory' || !isShulkerBox(owned.name) || !samePoint(owned.position, cp.positions[0])) return false
    const block = adapter.getBlock(owned.position.x, owned.position.y, owned.position.z)
    return block?.known === true && nameOf(block.name) === nameOf(owned.name) && Number.isSafeInteger(owned.runtimeId) && owned.runtimeId >= 0 && owned.runtimeId <= 4294967295 && block.runtimeId === owned.runtimeId && !(block.extra ?? []).length
  }
  // This admits only read-only inventory refresh. A pending placement gains
  // no ownership, consumption or success credit until portable reconciliation.
  const samePendingStoragePlacement = (cp, state) => storageScopeMatches(cp, state) && cp.jobId === job.config.jobId && cp.operationId === job.portableStorage?.operationId && cp.selectionKey === job.portableStorage?.selection?.key && job.portableStorage?.selection?.kind === 'shulker' && cp.kind === 'shulker' && cp.purpose == null && cp.stage === 'placing' && cp.intent?.type === 'place' && cp.placed?.length === 0 && cp.positions?.length === 1 && samePoint(cp.intent.position, cp.positions[0]) && Number.isInteger(cp.intent.slot) && cp.intent.slot >= 0 && cp.intent.slot < 36 && isShulkerBox(cp.intent.name) && typeof cp.intent.source === 'string' && cp.intent.source.length > 0 && cp.recovered == null && cp.expectedContents == null && Array.isArray(cp.plan) && cp.plan.length > 0 && cp.plan.every(entry => entry.transferred === 0) && Array.isArray(cp.deposited) && cp.deposited.length === 0
  const requireStorageOwner = (myEpoch, owner, active, checkpoint) => {
    const state = guard(myEpoch)
    if (job !== owner || job.portableStorage !== active || active.checkpoint !== checkpoint || !storageScopeMatches(checkpoint, state)) throw new QuarryInterrupt('STORAGE_CHECKPOINT_CHANGED')
    return state
  }
  async function reserveStorageRecovery (myEpoch, owner, active, checkpoint, reason, maxAttempts = 3) {
    requireStorageOwner(myEpoch, owner, active, checkpoint)
    const current = now(), previous = active.recoveryAttempts?.[reason]
    if (active.recoveryAttempts !== undefined && (!active.recoveryAttempts || typeof active.recoveryAttempts !== 'object' || Array.isArray(active.recoveryAttempts))) return false
    if (previous !== undefined && (!previous || !Number.isSafeInteger(previous.attempts) || previous.attempts < 0 || !Number.isFinite(previous.startedAt) || !Number.isFinite(previous.deadlineAt) || previous.deadlineAt !== previous.startedAt + 120000)) return false
    if (previous && (previous.attempts >= maxAttempts || current < previous.startedAt || current >= previous.deadlineAt)) return false
    const next = { attempts: (previous?.attempts ?? 0) + 1, startedAt: previous?.startedAt ?? current, deadlineAt: previous?.deadlineAt ?? current + 120000, lastAttemptAt: current }
    active.recoveryAttempts ??= {}
    active.recoveryAttempts[reason] = next
    await save('storage_recovery_pending')
    requireStorageOwner(myEpoch, owner, active, checkpoint)
    note('storage_recovery_retry', { operationId: active.operationId, reason, attempt: next.attempts, deadlineAt: new Date(next.deadlineAt).toISOString() })
    return true
  }

  // This part lives in quarry-job-storage.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const jobStorage = require('./quarry-job-storage').createQuarryJobStorage({
    get ACTIVE () { return ACTIVE },
    get adapter () { return adapter }, set adapter (value) { adapter = value },
    get AIR () { return AIR },
    get applyStorageConfiguration () { return applyStorageConfiguration },
    get blockRule () { return blockRule },
    get call () { return call },
    get capacityWork () { return capacityWork },
    get cargoSelection () { return cargoSelection },
    get carriedContainerKey () { return carriedContainerKey },
    get collect () { return collect },
    get copy () { return copy },
    get currentStorage () { return currentStorage },
    get deferredExitSupplies () { return deferredExitSupplies },
    get diff () { return diff },
    get dirtCount () { return dirtCount },
    get dropsFittingStacks () { return dropsFittingStacks },
    get epoch () { return epoch }, set epoch (value) { epoch = value },
    get expandStorage () { return expandStorage },
    get feetCell () { return feetCell },
    get finish () { return finish },
    get fourLayerStorage () { return fourLayerStorage },
    get freeSlots () { return freeSlots },
    get fullOnlyStorage () { return fullOnlyStorage },
    get goToStorage () { return goToStorage },
    get guard () { return guard },
    get healthRatio () { return healthRatio },
    get inventoryPolicy () { return inventoryPolicy },
    get isDeepStrictEqual () { return isDeepStrictEqual },
    get isShulkerBox () { return isShulkerBox },
    get items () { return items },
    get job () { return job }, set job (value) { job = value },
    get keepPlan () { return keepPlan },
    get lastInventory () { return lastInventory }, set lastInventory (value) { lastInventory = value },
    get ledger () { return ledger }, set ledger (value) { ledger = value },
    get lifeOf () { return lifeOf },
    get moveToStance () { return moveToStance },
    get nameOf () { return nameOf },
    get note () { return note },
    get now () { return now }, set now (value) { now = value },
    get passivePickup () { return passivePickup },
    get permits () { return permits },
    get PICKUP_SPACE_ROUNDS () { return PICKUP_SPACE_ROUNDS },
    get planner () { return planner }, set planner (value) { planner = value },
    get posKey () { return posKey },
    get previewStorageRoute () { return previewStorageRoute },
    get protectStorageCells () { return protectStorageCells },
    get QuarryInterrupt () { return QuarryInterrupt },
    get rebuildPlanner () { return rebuildPlanner },
    get recordAction () { return recordAction },
    get recordFinalStorageSkip () { return recordFinalStorageSkip },
    get regions () { return regions }, set regions (value) { regions = value },
    get registerCarriedStorage () { return registerCarriedStorage },
    get requireStorageOwner () { return requireStorageOwner },
    get rescopeBoxAfterReconnect () { return rescopeBoxAfterReconnect },
    get reserveStorageRecovery () { return reserveStorageRecovery },
    get sameOwnedStorageBox () { return sameOwnedStorageBox },
    get samePendingStoragePlacement () { return samePendingStoragePlacement },
    get samePoint () { return samePoint },
    get save () { return save },
    get scopeOf () { return scopeOf },
    get setState () { return setState },
    get shulkerOnly () { return shulkerOnly },
    get sleep () { return sleep }, set sleep (value) { sleep = value },
    get STORAGE_SITE_RETRY_REASONS () { return STORAGE_SITE_RETRY_REASONS },
    get storageFingerprint () { return storageFingerprint },
    get storageMoveTimedOut () { return storageMoveTimedOut },
    get storagePoint () { return storagePoint },
    get storagePreviewBusy () { return storagePreviewBusy },
    get storageScopeMatches () { return storageScopeMatches },
    get storageSupplyExclusions () { return storageSupplyExclusions },
    get SUPPLY_SITE_RETRIES () { return SUPPLY_SITE_RETRIES },
    get SUPPLY_SITE_RETRY_WAIT_MS () { return SUPPLY_SITE_RETRY_WAIT_MS },
    get supplyUntouched () { return supplyUntouched },
    get suspendForCombat () { return suspendForCombat },
    get totals () { return totals },
    get TRANSIENT_RETRIES () { return TRANSIENT_RETRIES },
    get TRANSIENT_WAIT_MS () { return TRANSIENT_WAIT_MS },
    get transientReason () { return transientReason },
    get waitForQuietStorage () { return waitForQuietStorage }
  })
  function returnAndDeposit (...args) { return jobStorage.returnAndDeposit(...args) }
  function storeCarried (...args) { return jobStorage.storeCarried(...args) }

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

  // This part lives in quarry-job-egress.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const jobEgress = require('./quarry-job-egress').createQuarryJobEgress({
    get adapter () { return adapter }, set adapter (value) { adapter = value },
    get AIR () { return AIR },
    get applyStorageConfiguration () { return applyStorageConfiguration },
    get badStances () { return badStances },
    get call () { return call },
    get clearWorkDeferred () { return clearWorkDeferred },
    get collect () { return collect },
    get copy () { return copy },
    get countsRevision () { return countsRevision }, set countsRevision (value) { countsRevision = value },
    get deferredExitSupplies () { return deferredExitSupplies },
    get EGRESS_NOOP_COMBAT_MS () { return EGRESS_NOOP_COMBAT_MS },
    get EGRESS_NOOP_COMBAT_RETRIES () { return EGRESS_NOOP_COMBAT_RETRIES },
    get EGRESS_TRANSIENT () { return EGRESS_TRANSIENT },
    get EGRESS_TRANSIENT_RETRIES () { return EGRESS_TRANSIENT_RETRIES },
    get EGRESS_TRANSIENT_WAIT_MS () { return EGRESS_TRANSIENT_WAIT_MS },
    get egressActionResult () { return egressActionResult },
    get egressDirtRoom () { return egressDirtRoom },
    get epoch () { return epoch }, set epoch (value) { epoch = value },
    get exceptionsList () { return exceptionsList },
    get exitDirtGoal () { return exitDirtGoal },
    get exitPlanDirt () { return exitPlanDirt },
    get feetCell () { return feetCell },
    get FINAL_CHEST_KEEP () { return FINAL_CHEST_KEEP },
    get finish () { return finish },
    get fourLayerStorage () { return fourLayerStorage },
    get freeSlots () { return freeSlots },
    get fullOnlyStorage () { return fullOnlyStorage },
    get guard () { return guard },
    get hasStorageOption () { return hasStorageOption },
    get inventoryPolicy () { return inventoryPolicy },
    get items () { return items },
    get job () { return job }, set job (value) { job = value },
    get keepEarlierLayers () { return keepEarlierLayers },
    get keepPlan () { return keepPlan },
    get ledger () { return ledger }, set ledger (value) { ledger = value },
    get lifeOf () { return lifeOf },
    get moveToStance () { return moveToStance },
    get nameOf () { return nameOf },
    get note () { return note },
    get now () { return now }, set now (value) { now = value },
    get observeDrops () { return observeDrops },
    get observeFluidDrain () { return observeFluidDrain },
    get observeInventory () { return observeInventory },
    get passivePickup () { return passivePickup },
    get permits () { return permits },
    get planner () { return planner }, set planner (value) { planner = value },
    get planningBlocks () { return planningBlocks },
    get planQuarryExit () { return planQuarryExit },
    get preferDirtSource () { return preferDirtSource },
    get prepareExit () { return prepareExit },
    get QuarryInterrupt () { return QuarryInterrupt },
    get recordAcceptedExceptions () { return recordAcceptedExceptions },
    get recordAction () { return recordAction },
    get recordFinalStorageSkip () { return recordFinalStorageSkip },
    get recordPassivePickup () { return recordPassivePickup },
    get regions () { return regions }, set regions (value) { regions = value },
    get requestTerrainObservation () { return requestTerrainObservation },
    get restock () { return restock },
    get returnAndDeposit () { return returnAndDeposit },
    get samePoint () { return samePoint },
    get save () { return save },
    get scopeOf () { return scopeOf },
    get SEAL_MATERIALS () { return SEAL_MATERIALS },
    get setState () { return setState },
    get sleep () { return sleep }, set sleep (value) { sleep = value },
    get SUPPLY_ROOM_MAX_ATTEMPTS () { return SUPPLY_ROOM_MAX_ATTEMPTS },
    get SUPPLY_ROOM_MAX_BLOCKS () { return SUPPLY_ROOM_MAX_BLOCKS },
    get TOOL_WAIT () { return TOOL_WAIT },
    get totals () { return totals },
    get TRANSIENT_DEFER () { return TRANSIENT_DEFER },
    get workFloorY () { return workFloorY }
  })
  function finalCheck (...args) { return jobEgress.finalCheck(...args) }
  function egress (...args) { return jobEgress.egress(...args) }
  function terrainObserved (...args) { return jobEgress.terrainObserved(...args) }
  function makeSupplyRoom (...args) { return jobEgress.makeSupplyRoom(...args) }

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
    if (paused) scheduleAutoResume(reason, extra.pauseDetails)
    try { adapter.onFinished?.(status()) } catch {}
  }

  // Automatic resumes of a paused job (bounded; counts are persisted).
  function scheduleAutoResume (reason, pauseDetails) {
    if (!job || retired) return
    if (job.persistence?.status !== 'failed' && reason === 'SUPPLY_RESTOCK_BLOCKED' && job.config.strategy?.autoAcceptCargoLoss === true && job.userRunIntent === 'running' && lostDirtSupply() && !job.dirtSupplyLossStopped && supplyBoxCellAir()) { if (scheduleSupplyLossSearch(reason)) return }
    if (job.persistence?.status !== 'failed' && reason === 'CARRIED_STORAGE_BLOCKED' && pauseDetails?.reason === 'STORAGE_RECOVERY_UNCONFIRMED' && job.config.strategy?.autoAcceptCargoLoss === true && job.userRunIntent === 'running') { if (scheduleCargoLossSearch(reason)) return }
    // Pauses that a plain resume (which re-runs every check and reconciliation)
    // cleared by hand on 2026-11-13 also retry themselves, bounded like
    // ACTION_FAILED (3 per stretch without progress). Opt-out per job.
    const transientPause = job.config.strategy?.autoResumeTransient !== false && (/^(INVENTORY_UNKNOWN|POSITION_UNCONFIRMED|HEALTH_NOT_RECOVERING|UNOBSERVED_CELLS|SLOW_BREAK_PERSISTS|ASCENT_[A-Z_]+|EGRESS_POSITION_UNCONFIRMED|EGRESS_RESUME_POSITION_CHANGED|FINAL_CHEST_UNCONFIRMED|FINAL_CHEST_OPEN_UNCONFIRMED|LOADOUT_CHEST_OPEN_UNCONFIRMED|FINAL_INVENTORY_UNCONFIRMED|EXIT_SUPPLY_UNCONFIRMED)$/.test(String(reason)) ||
      ['CARRIED_STORAGE_BLOCKED', 'SUPPLY_RESTOCK_BLOCKED'].includes(reason) && ['STORAGE_SITE_UNOBSERVED'].includes(pauseDetails?.reason))
    if (job.persistence?.status !== 'failed' && (/^ACTION_FAILED/.test(String(reason)) || transientPause) && (job.autoResumes ?? 0) < 3 && job.userRunIntent === 'running') {
      const owner = job, expectedEpoch = epoch
      const retry = () => {
        autoResumeTimer = null
        // A retired instance (replaced by a hot reload) never resumes its old job.
        if (retired) return
        if (job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running') return
        if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(retry, 100); autoResumeTimer.unref?.(); return }
        job.autoResumes = (job.autoResumes ?? 0) + 1; job.lastAutoResumeAt = now()
        note('auto_resume', { reason, count: job.autoResumes })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
      }
      autoResumeTimer = setTimeout(retry, autoResumeMs); autoResumeTimer.unref?.()
      autoRetryInfo = { kind: 'action', reason: String(reason), attempt: (job.autoResumes ?? 0) + 1, max: 3, nextAt: now() + autoResumeMs }
    }
    // Loose drops around a placed storage box (passive pickup leaves them) can
    // block its safe recovery. They despawn within minutes and nothing moves
    // while waiting, so this pause retries itself (bounded) instead of
    // stalling for hours (live 2026-11-10 05:38: 2h until a manual resume).
    // Live 2026-11-13 00:59: a supply box (supplies:6) waited for loose drops the same way.
    // Live 2026-11-13 (storage:296/352/524): an unconfirmed cargo placement was
    // each time resolved by the current-state reconciliation (inverted air
    // audit, the same box and contents in hand, same connection and life).
    // Run it automatically; only a confirmed "nothing was placed" resumes.
    if (job.persistence?.status !== 'failed' && reason === 'CARRIED_STORAGE_BLOCKED' && pauseDetails?.reason === 'STORAGE_PLACEMENT_RECONCILE_REQUIRED' && (job.autoReconciles ?? 0) < AUTO_RECONCILES && job.userRunIntent === 'running') {
      const owner = job, expectedEpoch = epoch
      const run = async () => {
        autoResumeTimer = null; autoRetryInfo = null
        if (retired) return
        if (job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running') return
        if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(run, 500); autoResumeTimer.unref?.(); return }
        job.autoReconciles = (job.autoReconciles ?? 0) + 1
        note('storage_auto_reconcile', { attempt: job.autoReconciles, operationId: job.portableStorage?.operationId ?? null })
        let outcome = null
        try { outcome = await reconcileCurrentStoragePlacement() } catch (error) { note('storage_auto_reconcile_failed', { error: String(error.message ?? error).slice(0, 160) }) }
        if (outcome?.status === 'reconciled' && job === owner && job.state === 'PAUSED' && job.userRunIntent === 'running') { try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) } return }
        if (job === owner && job.state === 'PAUSED' && (job.autoReconciles ?? 0) < AUTO_RECONCILES && job.userRunIntent === 'running') {
          note('storage_auto_reconcile_blocked', { reason: outcome?.reason ?? null })
          autoResumeTimer = setTimeout(run, AUTO_RECONCILE_WAIT_MS); autoResumeTimer.unref?.()
          autoRetryInfo = { kind: 'reconcile', reason: 'STORAGE_PLACEMENT_RECONCILE_REQUIRED', attempt: (job.autoReconciles ?? 0) + 1, max: AUTO_RECONCILES, nextAt: now() + AUTO_RECONCILE_WAIT_MS }
        }
      }
      autoResumeTimer = setTimeout(run, AUTO_RECONCILE_WAIT_MS); autoResumeTimer.unref?.()
      autoRetryInfo = { kind: 'reconcile', reason: 'STORAGE_PLACEMENT_RECONCILE_REQUIRED', attempt: (job.autoReconciles ?? 0) + 1, max: AUTO_RECONCILES, nextAt: now() + AUTO_RECONCILE_WAIT_MS }
      return
    }
    const capacityWait = ['CARRIED_STORAGE_BLOCKED', 'SUPPLY_RESTOCK_BLOCKED'].includes(reason) && pauseDetails?.reason === 'STORAGE_PICKUP_CAPACITY_REQUIRED'
    if (job.persistence?.status !== 'failed' && capacityWait && (job.capacityRetries ?? 0) < CAPACITY_RETRIES && job.userRunIntent === 'running') {
      const owner = job, expectedEpoch = epoch
      const retry = () => {
        autoResumeTimer = null
        // A retired instance (replaced by a hot reload) never resumes its old job.
        if (retired) return
        if (job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running') return
        if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(retry, 100); autoResumeTimer.unref?.(); return }
        job.capacityRetries = (job.capacityRetries ?? 0) + 1
        note('capacity_wait_resume', { count: job.capacityRetries, required: pauseDetails?.details?.requiredFreeSlots ?? null, free: pauseDetails?.details?.freeSlots ?? null })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
      }
      autoResumeTimer = setTimeout(retry, capacityRetryMs); autoResumeTimer.unref?.()
      autoRetryInfo = { kind: 'capacity', reason: String(pauseDetails?.reason ?? reason), attempt: (job.capacityRetries ?? 0) + 1, max: CAPACITY_RETRIES, nextAt: now() + capacityRetryMs }
    }
  }
  // Live 2026-11-12 22:51: a capacity retry timer of the instance replaced by a
  // hot reload resumed the old job (STORAGE_ACTION_OWNER_CHANGED). The runtime
  // retires the old instance and asks the new one to schedule the retry again.
  function retire () {
    const pending = autoResumeTimer != null
    clearAutoResume(); retired = true
    return { pendingAutoResume: pending, jobId: job?.config?.jobId ?? null, pauseReason: job?.pauseReason ?? null }
  }
  function rescheduleAutoResume () {
    if (!job || retired || autoResumeTimer || job.state !== 'PAUSED' || worker || stopTask) return false
    scheduleAutoResume(job.pauseReason, job.pauseDetails ?? null)
    return autoResumeTimer != null
  }

  // Turns the opt-in quarry animal clearing on or off for the current job.
  async function configureAnimalClearing (options = {}) {
    if (!job) throw new Error('No quarry job')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 1 || typeof options.enabled !== 'boolean') throw new Error('configureAnimalClearing accepts { enabled: true|false } only')
    job.config.strategy = { ...(job.config.strategy ?? {}), clearAnimals: options.enabled }
    await save('animal_clearing_configured')
    note('animal_clearing_configured', { enabled: options.enabled })
    return status()
  }
  async function configureCargoLossAcceptance (options = {}) {
    if (!job) throw new Error('No quarry job')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 1 || typeof options.enabled !== 'boolean') throw new Error('configureCargoLossAcceptance accepts { enabled: true|false } only')
    job.config.strategy = { ...(job.config.strategy ?? {}), autoAcceptCargoLoss: options.enabled }
    await save('cargo_loss_acceptance_configured')
    note('cargo_loss_acceptance_configured', { enabled: options.enabled })
    return status()
  }
  // Opt-in (2026-11-13): store spare armour that is worse than what is worn.
  async function configureSpareArmor (options = {}) {
    if (!job) throw new Error('No quarry job')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 1 || typeof options.enabled !== 'boolean') throw new Error('configureSpareArmor accepts { enabled: true|false } only')
    job.config.strategy = { ...(job.config.strategy ?? {}), storeSpareArmor: options.enabled }
    await save('spare_armor_configured')
    note('spare_armor_configured', { enabled: options.enabled })
    return status()
  }
  // Turns the opt-in work-dirt-on-demand mode on or off for the current job.
  async function configureDirtSupply (options = {}) {
    if (!job) throw new Error('No quarry job')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length !== 1 || typeof options.dirtFromSupplyOnDemand !== 'boolean') throw new Error('configureDirtSupply accepts { dirtFromSupplyOnDemand: true|false } only')
    const prior = job.config.strategy?.dirtFromSupplyOnDemand
    if (prior === options.dirtFromSupplyOnDemand) return status()
    job.config.strategy = { ...(job.config.strategy ?? {}), dirtFromSupplyOnDemand: options.dirtFromSupplyOnDemand }
    try { await save('dirt_supply_configured') } catch (error) { if (prior === undefined) delete job.config.strategy.dirtFromSupplyOnDemand; else job.config.strategy.dirtFromSupplyOnDemand = prior; throw error }
    note('dirt_supply_configured', { dirtFromSupplyOnDemand: options.dirtFromSupplyOnDemand, active: workDirtOnDemand() })
    return status()
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
      // Live 2026-11-13 11:21: after a reconnect the v2.2 boxes (no food, a totem box)
      // were searched with the legacy layout and SUPPLY_BOXES_UNCONFIRMED followed.
      const discovered = adapter.discoverSupplies?.(v22SupplyLayout(job.config) ? 'v22' : 'legacy')
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
  // This part lives in quarry-job-reconcile.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const jobReconcile = require('./quarry-job-reconcile').createQuarryJobReconcile({
    get adapter () { return adapter }, set adapter (value) { adapter = value },
    get assertJobWorld () { return assertJobWorld },
    get clearAutoResume () { return clearAutoResume },
    get copy () { return copy },
    get epoch () { return epoch }, set epoch (value) { epoch = value },
    get isDeepStrictEqual () { return isDeepStrictEqual },
    get job () { return job }, set job (value) { job = value },
    get lifeOf () { return lifeOf },
    get note () { return note },
    get permits () { return permits },
    get planner () { return planner }, set planner (value) { planner = value },
    get pollMs () { return pollMs }, set pollMs (value) { pollMs = value },
    get QuarryInterrupt () { return QuarryInterrupt },
    get reconcilingCarriedPlacement () { return reconcilingCarriedPlacement }, set reconcilingCarriedPlacement (value) { reconcilingCarriedPlacement = value },
    get regions () { return regions }, set regions (value) { regions = value },
    get requireDrained () { return requireDrained },
    get samePendingStoragePlacement () { return samePendingStoragePlacement },
    get samePoint () { return samePoint },
    get save () { return save },
    get scopeOf () { return scopeOf },
    get status () { return status },
    get storagePoint () { return storagePoint },
    get storageScopeMatches () { return storageScopeMatches },
    get UNSENT_PLACE_REASON () { return UNSENT_PLACE_REASON },
    get worker () { return worker }, set worker (value) { worker = value }
  })
  function reconcileCurrentStoragePlacement (...args) { return jobReconcile.reconcileCurrentStoragePlacement(...args) }
  function reconcileCarriedPlacement (...args) { return jobReconcile.reconcileCarriedPlacement(...args) }
  function reconcileObservedStoragePlacement (...args) { return jobReconcile.reconcileObservedStoragePlacement(...args) }
  function reconcileRejectedStorage (...args) { return jobReconcile.reconcileRejectedStorage(...args) }
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
    // Live 2026-11-13 12:06: an untouched storage operation (nothing placed,
    // deposited or pending) that used up its site and preparation retries
    // starts over on a resume, at a newly chosen site with a fresh budget.
    const ps = job.portableStorage, pcp = ps?.checkpoint
    if (ps && ['CARRIED_STORAGE_BLOCKED', 'STORAGE_CURRENT_STATE_RECONCILED'].includes(job.pauseReason) && pcp?.stage === 'planned' && !(pcp.placed ?? []).length && !(pcp.deposited ?? []).length && pcp.intent == null) {
      // The site that left the placement unconfirmed is avoided by the new choice.
      if (job.pauseReason === 'STORAGE_CURRENT_STATE_RECONCILED') ps.avoidPositions = [...(ps.avoidPositions ?? []), ...(pcp.positions ?? []).filter(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])))].slice(-12)
      ps.checkpoint = null; delete ps.siteRetries; delete ps.transientRetries
      note('storage_untouched_restart', { operationId: ps.operationId })
    }
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
  // Received contents of the lost box (its NBT before placement plus what this
  // operation deposited), summarized by item name for the record and dashboard.
  function lostBoxItems (cp) {
    const totals = new Map()
    try {
      const raw = require('v8').deserialize(Buffer.from(cp.placed[0].placementObservation.sourceBefore, 'base64'))
      const root = raw?.extra?.nbt?.nbt ?? raw?.extra?.nbt
      for (const entry of root?.value?.Items?.value?.value ?? []) {
        const v = entry?.type === 'compound' ? entry.value : entry
        if (typeof v?.Name?.value === 'string' && Number.isSafeInteger(v?.Count?.value)) totals.set(v.Name.value, (totals.get(v.Name.value) ?? 0) + v.Count.value)
      }
    } catch {}
    for (const d of cp.deposited ?? []) if (typeof d?.name === 'string' && Number.isSafeInteger(d.count)) totals.set(d.name, (totals.get(d.name) ?? 0) + d.count)
    return [...totals].map(([name, count]) => ({ name, count })).slice(0, 27)
  }
  // Remaining cargo room of the carried, not-full cargo boxes (27 slots of 64,
  // less the received NBT entries) against the expected remaining deposits at
  // this job's storage rate. Unknown is reported as insufficient.
  function cargoCapacityOutlook () {
    const inv = withRaw(items(adapter.getState()))
    if (!inv) return { sufficient: false, reason: 'INVENTORY_UNKNOWN' }
    const supply = require('../loadout/loadout-manifest').SUPPLY_NAMES
    const exhaustedKeys = new Set(job.exhaustedShulkerKeys ?? []), exhaustedIds = new Set(job.exhaustedShulkerIdentities ?? [])
    const { carriedContainerIdentity } = require('./quarry-inventory')
    let room = 0
    for (const item of inv) {
      if (!isShulkerBox(item.name) || supply.includes(item.name) || exhaustedKeys.has(carriedContainerKey(item)) || exhaustedIds.has(carriedContainerIdentity?.(item))) continue
      const root = item.raw?.extra?.nbt?.nbt ?? item.raw?.extra?.nbt
      const used = Array.isArray(root?.value?.Items?.value?.value) ? root.value.Items.value.value.length : null
      if (used == null && item.raw?.extra?.has_nbt !== false && item.raw?.extra?.has_nbt !== 0) return { sufficient: false, reason: 'BOX_CONTENTS_UNKNOWN' }
      room += (27 - (used ?? 0)) * 64
    }
    const l = ledger.export()
    const sum = v => typeof v === 'number' ? v : Object.values(v ?? {}).reduce((a, b) => a + (Number(b) || 0), 0)
    const deposited = sum(l?.deposited ?? job.ledger?.deposited), mined = sum(l?.minedBlocks ?? job.ledger?.minedBlocks)
    const floor = regions?.yBottom ?? job.config.yBottom, cursor = Math.min(job.cursorY ?? job.yTop, job.deepestY ?? job.yTop)
    const layersDone = Math.max(1, job.yTop - cursor), layersLeft = Math.max(0, cursor - floor + 1)
    const columns = regions?.columns?.length ?? 256
    if (!Number.isFinite(floor) || !mined) return { sufficient: false, reason: 'RATE_UNKNOWN' }
    const need = Math.ceil(Math.max(deposited / layersDone * layersLeft, deposited / mined * columns * layersLeft))
    return { sufficient: room >= need, room, need }
  }
  // Opt-in automatic acceptance of a lost cargo shulker (2026-11-13 user
  // request): search up to 60 s (32 m items, inventory resync, the box cell);
  // anything found resumes the normal recovery. Otherwise it is accepted
  // unless it is a supply box, it would be this job's third lost cargo box,
  // the remaining cargo room is short, or the received state disagrees.
  const CARGO_LOSS_SEARCH_MS = cargoLossSearchMs, CARGO_LOSS_STEP_MS = cargoLossStepMs, CARGO_LOSS_LIMIT = 2
  function scheduleCargoLossSearch (reason) {
    const owner = job, expectedEpoch = epoch, ps = job.portableStorage, cp = ps?.checkpoint
    const operationId = ps?.operationId, startedAt = now(), box = cp?.placed?.[0]
    if (!operationId || cp?.kind !== 'shulker' || cp.stage !== 'awaiting_recovery' || !box) return false
    const baseline = Array.isArray(cp.recoveryBaseline) ? cp.recoveryBaseline.reduce((n, b) => n + (b.count ?? 0), 0) : null
    let resynced = false
    const stop = why => { note('cargo_loss_auto_stopped', { operationId, reason: why }); autoRetryInfo = null; autoResumeTimer = null }
    const run = async () => {
      autoResumeTimer = null
      if (retired || job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running' || job.portableStorage?.operationId !== operationId) return
      if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(run, 500); autoResumeTimer.unref?.(); return }
      if (!resynced && typeof adapter.resyncInventory === 'function') { resynced = true; try { await adapter.resyncInventory() } catch {} }
      const block = adapter.getBlock(box.position.x, box.position.y, box.position.z)
      if (block?.known !== true || nameOf(block) !== 'air') return stop('BOX_CELL_NOT_AIR')
      const inv = items(adapter.getState())
      const boxes = inv ? inv.filter(i => isShulkerBox(i.name)).reduce((n, i) => n + i.count, 0) : null
      const seen = (adapter.entities?.() ?? []).some(e => nameOf(e.name) === nameOf(box.name) && e.position && Math.hypot(e.position.x - box.position.x, e.position.y - box.position.y, e.position.z - box.position.z) <= 32)
      if ((baseline != null && boxes != null && boxes > baseline) || seen) {
        if ((job.cargoLossFoundResumes ?? 0) >= 2) return stop('FOUND_BUT_UNRECOVERED')
        job.cargoLossFoundResumes = (job.cargoLossFoundResumes ?? 0) + 1
        note('cargo_loss_box_found', { operationId, inInventory: boxes > baseline, entity: seen })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
        return
      }
      if (now() - startedAt < CARGO_LOSS_SEARCH_MS) {
        autoResumeTimer = setTimeout(run, CARGO_LOSS_STEP_MS); autoResumeTimer.unref?.()
        autoRetryInfo = { kind: 'cargo_loss', reason: 'STORAGE_RECOVERY_UNCONFIRMED', attempt: 1, max: 1, nextAt: startedAt + CARGO_LOSS_SEARCH_MS }
        return
      }
      if (require('../loadout/loadout-manifest').SUPPLY_NAMES.includes(box.name)) return stop('SUPPLY_BOX_LOST')
      if ((job.lostCargoBoxes ?? []).length >= CARGO_LOSS_LIMIT) return stop('CARGO_LOSS_LIMIT')
      const outlook = cargoCapacityOutlook()
      if (!outlook.sufficient) return stop(outlook.reason ?? 'CARGO_CAPACITY_SHORT')
      try { await acceptCarriedStorageLoss({ operationId }, { acceptedBy: 'auto' }) } catch (error) { stop(String(error.message ?? error).slice(0, 120)) }
    }
    autoResumeTimer = setTimeout(run, Math.min(1000, CARGO_LOSS_STEP_MS)); autoResumeTimer.unref?.()
    autoRetryInfo = { kind: 'cargo_loss', reason: 'STORAGE_RECOVERY_UNCONFIRMED', attempt: 1, max: 1, nextAt: startedAt + CARGO_LOSS_SEARCH_MS }
    note('cargo_loss_search', { operationId })
    return true
  }
  // The dirt supply box of the active supply operation was placed and is not
  // carried any more (2026-11-14 live: combat interrupted its pickup, then the
  // connection changed). Only the dirt role: other supply boxes still stop.
  function lostDirtSupply () {
    const active = job?.supplyRestock, cp = active?.checkpoint, child = cp?.child, binding = cp?.bindings?.[cp?.index]
    if (binding?.role !== 'dirt' || binding.itemName !== 'minecraft:dirt' || child?.kind !== 'shulker' || child.placed?.length !== 1 || child.placed[0].name !== binding.boxName) return null
    const at = child.placed[0].position
    if (!at || !['x', 'y', 'z'].every(k => Number.isSafeInteger(at[k]))) return null
    return { active, cp, child, binding, position: at }
  }
  // Only a box whose cell is received air can be lost. Live 2026-11-14 02:38
  // (supplies:18): the placed dirt box waited for pickup room
  // (STORAGE_PICKUP_CAPACITY_REQUIRED); the search started, stopped at once
  // (BOX_CELL_NOT_AIR) and kept the ordinary capacity retry from being armed.
  function supplyBoxCellAir () {
    const lost = lostDirtSupply()
    if (!lost) return false
    const block = adapter.getBlock(lost.position.x, lost.position.y, lost.position.z)
    return block?.known === true && nameOf(block) === 'air'
  }
  // Same bounded search as a lost cargo box (60 s: 32 m items, one inventory
  // resync, the box cell). Found: the ordinary recovery runs again. Otherwise
  // accepted only when one carried cargo box's received dirt plus the loose
  // dirt covers the exit; else it stops as before.
  function scheduleSupplyLossSearch (reason) {
    const owner = job, expectedEpoch = epoch, lost = lostDirtSupply(), startedAt = now()
    if (!lost) return false
    const operationId = lost.active.operationId, box = { name: lost.child.placed[0].name, position: copy(lost.position) }, baseline = Number.isInteger(lost.cp.boxCount) ? lost.cp.boxCount : null
    let resynced = false
    const stop = why => { job.dirtSupplyLossStopped = why; note('supply_loss_auto_stopped', { operationId, reason: why }); autoRetryInfo = null; autoResumeTimer = null }
    const run = async () => {
      autoResumeTimer = null
      if (retired || job !== owner || epoch !== expectedEpoch || job.state !== 'PAUSED' || job.pauseReason !== reason || job.userRunIntent !== 'running' || job.supplyRestock?.operationId !== operationId) return
      if (worker || stopTask || pendingActions.size || savesInFlight) { autoResumeTimer = setTimeout(run, 500); autoResumeTimer.unref?.(); return }
      if (!resynced && typeof adapter.resyncInventory === 'function') { resynced = true; try { await adapter.resyncInventory() } catch {} }
      const block = adapter.getBlock(box.position.x, box.position.y, box.position.z)
      if (block?.known !== true || nameOf(block) !== 'air') return stop('BOX_CELL_NOT_AIR')
      const inv = items(adapter.getState())
      const boxes = inv ? inv.filter(i => isShulkerBox(i.name)).reduce((n, i) => n + i.count, 0) : null
      const carried = inv ? inv.some(i => carriedContainerKey(i) === lost.binding.key || i.name === box.name) : null
      const seen = (adapter.entities?.() ?? []).some(e => nameOf(e.name) === nameOf(box.name) && e.position && Math.hypot(e.position.x - box.position.x, e.position.y - box.position.y, e.position.z - box.position.z) <= 32)
      if (carried || (baseline != null && boxes != null && boxes >= baseline) || seen) {
        if ((job.supplyLossFoundResumes ?? 0) >= 2) return stop('FOUND_BUT_UNRECOVERED')
        job.supplyLossFoundResumes = (job.supplyLossFoundResumes ?? 0) + 1
        note('supply_loss_box_found', { operationId, inInventory: carried === true, entity: seen })
        try { resume() } catch (error) { note('auto_resume_failed', { error: String(error.message ?? error) }) }
        return
      }
      if (now() - startedAt < CARGO_LOSS_SEARCH_MS) {
        autoResumeTimer = setTimeout(run, CARGO_LOSS_STEP_MS); autoResumeTimer.unref?.()
        autoRetryInfo = { kind: 'supply_loss', reason: 'SUPPLY_BOX_SEARCH', attempt: 1, max: 1, nextAt: startedAt + CARGO_LOSS_SEARCH_MS }
        return
      }
      if ((job.lostCargoBoxes ?? []).length >= CARGO_LOSS_LIMIT) return stop('CARGO_LOSS_LIMIT')
      try { await acceptLostDirtSupply({ acceptedBy: 'auto' }) } catch (error) { stop(String(error.message ?? error).slice(0, 120)) }
    }
    autoResumeTimer = setTimeout(run, Math.min(1000, CARGO_LOSS_STEP_MS)); autoResumeTimer.unref?.()
    autoRetryInfo = { kind: 'supply_loss', reason: 'SUPPLY_BOX_SEARCH', attempt: 1, max: 1, nextAt: startedAt + CARGO_LOSS_SEARCH_MS }
    note('supply_loss_search', { operationId, box: box.name, position: box.position })
    return true
  }
  async function acceptLostDirtSupply ({ acceptedBy = 'auto' } = {}) {
    const lost = lostDirtSupply()
    if (!job || job.state !== 'PAUSED' || worker || job.pauseReason !== 'SUPPLY_RESTOCK_BLOCKED' || !lost || job.portableStorage) throw new Error('No lost dirt supply box is waiting for acceptance')
    const block = adapter.getBlock(lost.position.x, lost.position.y, lost.position.z)
    if (block?.known !== true || nameOf(block) !== 'air') throw new Error('SUPPLY_BOX_CELL_NOT_AIR')
    const inv = items(adapter.getState()), view = adapter.equipmentView?.()
    if (!inv || view?.known !== true || view.uncertain) throw new Error('INVENTORY_UNKNOWN')
    if (inv.some(i => carriedContainerKey(i) === lost.binding.key || i.name === lost.child.placed[0].name)) throw new Error('SUPPLY_BOX_STILL_CARRIED')
    const required = exitDirtRequired(), loose = dirtCount(inv)
    const best = carriedDirtBoxes(view).filter(b => !b.bound && b.dirt != null).sort((a, b) => b.dirt - a.dirt || (a.slot ?? 99) - (b.slot ?? 99))[0]
    if (!best || loose + best.dirt < required) throw new Error('CARGO_DIRT_SHORT')
    // Received contents before placement less what this operation withdrew.
    const items0 = new Map(lostBoxItems(lost.child).map(i => [i.name, i.count]))
    for (const w of lost.child.supplyCheckpoint?.withdrawn ?? []) if (items0.has(w.name)) items0.set(w.name, Math.max(0, items0.get(w.name) - (w.count ?? 0)))
    const record = { operationId: lost.active.operationId, kind: 'supply', role: 'dirt', acceptedAt: new Date(now()).toISOString(), acceptedBy, position: copy(lost.position), items: [...items0].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })), box: lost.child.placed[0].name, selectionKey: lost.child.selectionKey ?? null, deposited: [], withdrawnBefore: copy(lost.cp.withdrawn ?? []), scope: copy(lost.child.scope ?? null), replacedBy: { boxName: best.boxName, slot: best.slot, dirt: best.dirt } }
    job.lostCargoBoxes = [...(job.lostCargoBoxes ?? []), record].slice(-32)
    for (const i of record.items) ledger.add('lost', i.name, i.count)
    ledger.add('lost', record.box, 1)
    job.supplyReceipts ??= []
    if (!job.supplyReceipts.some(r => r.operationId === record.operationId)) job.supplyReceipts.push({ operationId: record.operationId, at: record.acceptedAt, withdrawn: copy(lost.cp.withdrawn ?? []), returned: copy(lost.cp.returned ?? []), lossAccepted: true })
    job.lastSupplyResult = { operationId: record.operationId, status: 'loss_accepted', reason: 'SUPPLY_BOX_LOST', serverConfirmed: false, withdrawn: copy(lost.cp.withdrawn ?? []), returned: copy(lost.cp.returned ?? []) }
    job.supplyRestock = null
    rebuildPlanner()
    await save('supply_box_loss_accepted')
    note('supply_box_loss_accepted', { operationId: record.operationId, box: record.box, position: record.position, items: record.items, by: acceptedBy })
    if (!(await rebindDirtSource(best, 'supply_box_lost'))) throw new Error('DIRT_SOURCE_REBIND_FAILED')
    return resume()
  }
  // User-only acceptance (2026-11-13) of one cargo shulker that was mined
  // (received air) but never came back: its received contents are recorded as
  // lost and the storage operation is closed. Nothing is credited as stored.
  async function acceptCarriedStorageLoss (options = {}, { acceptedBy = 'user' } = {}) {
    if (!job || job.state !== 'PAUSED' || worker || job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || job.pauseDetails?.reason !== 'STORAGE_RECOVERY_UNCONFIRMED') throw new Error('No unrecovered cargo box is waiting for acceptance')
    if (!options || typeof options !== 'object' || Object.keys(options).some(k => k !== 'operationId') || typeof options.operationId !== 'string') throw new Error('acceptCarriedStorageLoss accepts { operationId } only')
    const ps = job.portableStorage, cp = ps?.checkpoint
    if (!ps || ps.operationId !== options.operationId || job.pauseDetails.operationId !== options.operationId || cp?.kind !== 'shulker' || cp.stage !== 'awaiting_recovery' || cp.placed?.length !== 1 || job.pendingRelief) throw new Error('The waiting operation does not match an unrecovered cargo box')
    const at = cp.placed[0].position, block = adapter.getBlock(at.x, at.y, at.z)
    if (block?.known !== true || nameOf(block) !== 'air') throw new Error('The box position is not received air')
    const record = { operationId: ps.operationId, acceptedAt: new Date(now()).toISOString(), acceptedBy, position: copy(at), items: lostBoxItems(cp), box: cp.placed[0].name, selectionKey: cp.selectionKey ?? null, deposited: copy(cp.deposited ?? []), initialContents: cp.initialContents ?? null, scope: copy(cp.scope ?? null) }
    job.lostCargoBoxes = [...(job.lostCargoBoxes ?? []), record].slice(-32)
    for (const d of cp.deposited ?? []) if (typeof d?.name === 'string' && Number.isSafeInteger(d.count) && d.count > 0) ledger.add('lost', d.name, d.count)
    ledger.add('lost', cp.placed[0].name, 1)
    const receipts = job.carriedStorageReceipts ??= []
    if (!receipts.includes(ps.operationId)) receipts.push(ps.operationId)
    for (const action of job.actions ?? []) if (action.type === 'carried_storage' && action.operationId === ps.operationId && action.status === 'blocked') action.status = 'loss_accepted'
    job.portableStorage = null
    rebuildPlanner()
    await save('carried_storage_loss_accepted')
    note('carried_storage_loss_accepted', { operationId: record.operationId, position: record.position, deposited: record.deposited })
    return resume()
  }
  function recordAcceptedExceptions (exceptions, byReason, by) {
    job.acceptedExceptionRecord = { at: new Date(now()).toISOString(), by, count: exceptions.length, byReason: copy(byReason), items: exceptions.slice(0, 1000).map(e => ({ position: e.position ?? null, reason: e.reason ?? e.kind ?? null, name: e.name ?? null })) }
  }
  function acceptExceptions () {
    if (!job || job.state !== 'PAUSED' || job.pauseReason !== 'UNRESOLVED_EXCEPTIONS') throw new Error('No exceptions are waiting for acceptance')
    { const list = exceptionsList(), byReason = {}; for (const e of list) { const r = e.reason ?? e.kind; byReason[r] = (byReason[r] ?? 0) + 1 } recordAcceptedExceptions(list, byReason, 'user') }
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
    setUnknownBlockDefault(doc.config.strategy?.unknownBlockDefault === true)
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
    for (const action of job.actions ?? []) if (action?.type === 'egress' && action.result?.checkpoint && action.result.checkpoint.summary !== true) action.result = egressActionResult(action.result)
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

  // Live accessors preserve the current closure values for quarry-status.js.
  const jobStatus = require('./quarry-status').createQuarryStatus({
    get adapter () { return adapter },
    get autoResumeTimer () { return autoResumeTimer },
    get autoRetryInfo () { return autoRetryInfo },
    get combatBridge () { return combatBridge },
    get copy () { return copy },
    get countsCache () { return countsCache }, set countsCache ($value) { countsCache = $value },
    get countsRevision () { return countsRevision },
    get countsWork () { return countsWork }, set countsWork ($value) { countsWork = $value },
    get deferredExitSupplies () { return deferredExitSupplies },
    get egressStatus () { return egressStatus },
    get epoch () { return epoch },
    get events () { return events },
    get exitDirtGoal () { return exitDirtGoal },
    get foodOf () { return foodOf },
    get freeSlots () { return freeSlots },
    get inventoryPolicy () { return inventoryPolicy },
    get items () { return items },
    get job () { return job },
    get keepPlan () { return keepPlan },
    get ledger () { return ledger },
    get lifeOf () { return lifeOf },
    get loopWorker () { return loopWorker },
    get now () { return now },
    get pendingActions () { return pendingActions },
    get pendingDrops () { return pendingDrops },
    get planner () { return planner },
    get regions () { return regions },
    get savesInFlight () { return savesInFlight },
    get scopeOf () { return scopeOf },
    get stopTask () { return stopTask },
    get storageSettings () { return storageSettings },
    get supplyNeeds () { return supplyNeeds },
    get toolState () { return toolState },
    get worker () { return worker }
  })
  function status (...args) { return jobStatus.status(...args) }
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
  // 2026-11-14 user: "シュルカーボックスの回収は最優先にしてください、戦闘より優先度
  // 高いです". While this job's own shulker (cargo or supply) is out in the world
  // as an item: from its break until the received inventory has it back
  // (01:29 correction: "シュルカーボックスの設置中は戦闘優先していい、壊して手元に
  // 戻してる間はロストのリスクがあります"; a placed box waits for combat),
  // combat does not take control. Only while the job is working.
  const BOX_OUT_STAGES = new Set(['breaking', 'awaiting_recovery'])
  function shulkerHold () {
    if (!holdsWork()) return null
    const out = (cp, operationId, kind) => cp?.kind === 'shulker' && BOX_OUT_STAGES.has(cp.stage) && !cp.recovered ? { operationId, kind, stage: cp.stage, box: cp.placed?.[0]?.name ?? null, position: copy(cp.placed?.[0]?.position ?? cp.positions?.[0] ?? null) } : null
    return out(job.portableStorage?.checkpoint, job.portableStorage?.operationId ?? null, 'cargo') ?? out(job.supplyRestock?.checkpoint?.child, job.supplyRestock?.operationId ?? null, 'supply')
  }
  function egressStatus (inv) {
    const e = job.egress; const p = e?.plan ?? job.exitReservation?.plan; const exit = job.config.exit ?? normalizeExit({}, { legacy: true })
    const available = inv ? dirtCount(inv) : null
    return { preflight: copy(job.exitPreflight ?? null), reserved: !!job.exitReservation, mode: exit.mode, phase: job.surfaceReturnedAt ? 'completed' : e?.phase ?? 'planned', miningCompleted: !!job.miningCompletedAt, surfaceReturned: !!job.surfaceReturnedAt, migrationFloorY: exit.migrationFloorY ?? null, column: p?.column ?? null, entry: p?.entry ?? null, landing: p?.landing ?? null, startFeet: p?.startFeet ?? null, targetFeetY: p?.targetFeetY ?? null, requiredDirt: p?.requiredDirt ?? null, reserveDirt: exit.reserveDirt, totalDirt: p?.totalDirt ?? null, reservedDirt: job.config.inventory.keepExitDirt ?? 0, dirtAvailable: available, dirtMissing: available != null && p ? Math.max(0, p.totalDirt - available) : null, estimatedDirtMissing: available == null ? null : Math.max(0, (job.config.inventory.keepExitDirt ?? 0) - available), reason: e?.reason ?? null, operationId: e?.operationId ?? null, checkpointStage: e?.checkpoint?.stage ?? e?.checkpoint?.phase ?? null }
  }
  function document () { return job ? copy({ ...job, records: planner?.exportRecords(), ledger: ledger.export() }) : null }
  return { shulkerHold, plan, start, pause, emergencyStop, resume, cancel, retire, rescheduleAutoResume, configureDirtSupply, configureAnimalClearing, acceptCarriedStorageLoss, acceptLostDirtSupply, configureCargoLossAcceptance, configureSpareArmor, reopenWorkLayer, recordDebugAction, retryPersistence, acceptExceptions, storeCarriedNow, configureExit, configureTools, configureStorage, configureSupplies, restockSuppliesNow, reconcileSupplyPlacement, reconcileCarriedPlacement, reconcileCurrentStoragePlacement, reconcileObservedStoragePlacement, reconcileRejectedStorage, portablePath, portableTravel, storageInterruptionContext, status, load, document, instance: () => job?.instanceId ?? null, holdsWork, bridge: combatBridge, drain: () => Promise.allSettled([stopTask, worker, ...pendingActions]) }
}

module.exports = { createQuarryJob, QuarryInterrupt, defaults, FINAL_CHEST_KEEP }
