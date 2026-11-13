'use strict'

const { diagnoseStrikeBody } = require('./combat-body-diagnostic')

const { createCombatExposure } = require('./combat-exposure')
const { createQuarryStore } = require('./quarry-store')
const { assertJobWorld } = require('./quarry-job-identity')
const { RESUMABLE: QUARRY_AUTO_RESUMABLE, recoverable: recoverableQuarry, selectRecoveryCandidate, retryableRecoveryError } = require('./quarry-recovery')

const { createActorReader } = require('./runtime-observation-views')
const { profileCpu, measureSnapshots } = require('./runtime-diagnostics')
const { createSightStanceSearch } = require('./sight-stance-search')
const { createQuarryPortableStorage } = require('./quarry-portable-storage')
const { createQuarrySupplies } = require('./quarry-supplies')
const { createQuarryV22Equipment } = require('./quarry-v22-equipment')
const { createQuarryV22ChestWork } = require('./quarry-v22-chest-work')
const { createRuntimeV22ChestReset, receivedEquipmentView, jobPending } = require('./loadout-runtime-adapter')
const { createManualChestRuntime } = require('./manual-chest-runtime-adapter')
const { createChunkTravel } = require('./chunk-travel')
const { chunkTravelThreatsClear } = require('./chunk-travel-threats')
const { createControlLocation } = require('./control-location')
const { normalizeChunkArea } = require('./chunk-area')
const { historicalSourceRejection } = require('./rejected-source-history')
const { historicalEmptyPlacement } = require('./placement-source-history')

const { resourceMinHealth } = require('./learning-health')

const { setTimeout: delay } = require('node:timers/promises')
// Reloadable behaviour only. The client, authentication, world observations,
// inventory journal, IDs and predicted working pose are owned by the host.
const { createInput } = require('./input')
const { createInputHistory } = require('./input-history')
const { createPhysics } = require('./physics')
const { createWaterPreviewObserver } = require('./water-preview-observer')
const { createMining } = require('./mining')
const { canonicalWindowId, sameWindowId } = require('./container-types')
const { createActionOwnerTracker } = require('./action-owner-tracker')
const { defenseEnabled, createDefenseAnchor, defenseMovementAllowed } = require('./combat-defense-policy')
const { evaluateCombatThreat } = require('./combat-threat-policy')
const { proveGroundAccess } = require('./ground-access-proof')
const { createQuarryJob } = require('./quarry-job')
const { createQuarryRuntimeAdapter } = require('./quarry-runtime-adapter')
const { createQuarryPillar } = require('./quarry-pillar')
const { createQuarryEgressRuntime } = require('./quarry-egress-runtime')
const { createServerPositionVerifier, observedScope } = require('./server-position-verifier')
const { createStoragePlacementAudit } = require('./storage-placement-audit')
const { createPlainsLocator } = require('./locate-plains')
const { createQuarryTerrainRequester } = require('./quarry-terrain')
const { permitsExitAction } = require('./quarry-exit-plan')
const { blockRule: quarryBlockRule, selectTool: quarrySelectTool, nameOf: quarryNameOf } = require('./quarry-rules')
const { createWalker } = require('./walking')
const { createMovement } = require('./movement')
const { createNavigator } = require('./navigation')
const { surveyShore } = require('./shore-survey')
const { createShoreLandmarks } = require('./shore-landmarks')
const { createCrafting } = require('./crafting')
const { createInteractions } = require('./interactions')
const { createCombat } = require('./combat')
const { createWaterCounterattack } = require('./water-counterattack')
const { createInventory } = require('./inventory')
const { createInventoryInspection } = require('./inventory-inspection')
const { createArmor } = require('./armor')
const { isDeepStrictEqual } = require('node:util')
const { createUserBehaviors } = require('./user-behaviors')
const { createFurnace } = require('./furnace')
const { createChest } = require('./chest')
const { createSurfaceReturn, returnScope } = require('./surface-return')
const { bindRecentDamage, observeOwnDamageEffect, planRecentDamageRetreat, retreatFrameAllowed } = require('./recent-damage-retreat')
const { createSelfResistance, createSelfSlowFalling, createSelfEffectEvents } = require('./self-resistance')
const { createDepotMission } = require('./depot-mission')
const { createDepotPrebuild, planPrebuildChestStance } = require('./depot-prebuild')
const { createWorksiteCamp, createWorksiteCampPrebuild } = require('./worksite-camp')
const { rankExplorationTargets } = require('./exploration')
const { rankCampResourceTargets } = require('./camp-local-resource')
const { planOwnedCampReturn } = require('./owned-camp-return')
const { createOwnedCampBootstrap } = require('./owned-camp-bootstrap')
const { createDepotStorageWork } = require('./depot-storage-work')
const { planDepotStorageAccess, selectDepotTableCell } = require('./depot-storage-access')
const { continuationScope } = require('./base-continuation')
const { planContinuationResource } = require('./continuation-resource')
const { createProspecting } = require('./prospecting')
const { createExcavation } = require('./excavation')
const { nextDiamondAction } = require('./diamond-planner')
const { supplyScope, tableMaterialShortfall, updateStationCatalog, readStationPages, planSupplyReturn } = require('./supply-return')
const { portableKit, reservedWorksiteCells, selectPortableWorksite, preparationTableTarget, portableFallbackStop, nextPortableStep, verifyPortableDeployment, portableSiteValid, useRays } = require('./portable-worksite')
const { immediateDiamond } = require('./immediate-diamond')
const { createDiamondActions } = require('./diamond-actions')
const { createDurabilityReader } = require('./durability')
const { createTunneling } = require('./tunneling')
const { annotateTerrainThreats, terrainOcclusionApplies } = require('./terrain-threats')
const { useCurrentAccess } = require('./action-access')
const { createRecovery, planLearningShore, proveLearningShoreRoute } = require('./recovery')
const { createFood, isSupportedFood } = require('./food')
const { createForaging } = require('./foraging')
const { normalizePlayerCorrection } = require('./server-physics')
const { evaluateThreats } = require('./threats')
const threatReachability = require('./threat-reachability')
const { landEdgeRecenterTargets } = require('./edge-recenter')
// melee_kite standpoint distances from the target after a hit.
const KITE_RADII = [3.4, 3.2, 3.6]
// Retreat directions relative to straight away from the target (radians).
const KITE_ANGLES = [0, 35, -35, 70, -70].map(deg => deg * Math.PI / 180)
// Up to 12 x 50ms waiting for a supported landing before a kite step.
const KITE_LANDING_POLLS = 12
const { constrainedSecondaryFloor, selectConstrainedPrimary, outsideSkeletonFloor, unarmedCreeperZombie: isUnarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned, unarmedZombieFloor, outsideUnarmedSpiderFloor, activeUnarmedSpiderFloor } = require('./escape-policy')
const { normalizeServerMotion } = require('./server-motion')
const { createShelter } = require('./shelter')
const { planShelter } = require('./shelter-planner')
const { nextSurvivalAction } = require('./survival-planner')
const { serverInventoryUpdate } = require('./inventory-updates')
const { createHut } = require('./hut')
const { planHut } = require('./hut-planner')
const { createBaseProtection } = require('./base-protection')
const { createGuardedRoute } = require('./guarded-route')
const { createIdleSafety } = require('./idle-safety')
const { knownSurfaceBody, lowHealthSurfaceEligible, proveLowHealthSurfaceRoute } = require('./low-health-water')
const { WORK_MARGIN, captureWorkActors, resolveWorkActors, workEscapeEvaluation } = require('./work-clearance')
const { planEmergencyLeafAsync, clearanceDistanceAllowed, clearanceEquipmentKey, clearanceTargetAllowed } = require('./emergency-leaf')
const { planProtectiveDrownedStepAsync, drownedStepThreatAllowed, drownedStepEquipmentKey, protectiveDrownedStepCurrent, skeletonStepThreatAllowed, planProtectiveSkeletonStepAsync, protectiveSkeletonStepCurrent } = require('./protective-drowned-step')
const { createMissionJournal } = require('./mission-journal')
const { createAutonomy, verifiedCoveredRoom } = require('./autonomy')
const { createRunner, createHttpClient } = require('./runner')
const RUNTIME_VERSION = '0.2.0-hot-reload'
const USER_NAVIGATION_INTENT = Symbol.for('minecraft.bot.runtime.userNavigationIntent')

// This only hands an already chosen tunnel to the existing ore executor.
// Survival priority and real mining/block/inventory receipts remain unchanged.
function normalizeReachableTunnel (state, decision, preview) {
  const names = { coal: ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore'], iron: ['minecraft:iron_ore', 'minecraft:deepslate_iron_ore'], diamond: ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore'] }
  const tiers = { coal: 1, iron: 2, diamond: 3 }
  const integer = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
  const same = point => integer(point) && ['x', 'y', 'z'].every(axis => point[axis] === decision.target[axis])
  if (decision?.type !== 'tunnel' || !names[decision.resource] || !integer(decision.target) || decision.resourceTarget != null && !same(decision.resourceTarget) || decision.targetOre?.position != null && !same(decision.targetOre.position) || typeof preview !== 'function') return decision
  if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || state.inventory?.known !== true || state.inventory.uncertain || !Array.isArray(state.inventory.items) || typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || state.dimension == null || state.runtimeEntityId == null || !Number.isSafeInteger(state.lifecycle?.deathId) || state.lifecycle.deathId < 0) return decision
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
  const tool = state.inventory.items.find(item => item.slot === slot && item.count === 1)
  const tier = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }[String(tool?.name ?? '').replace(/^minecraft:/, '')]
  const requiredTier = decision.requiredToolTier ?? tiers[decision.resource]
  if (!Number.isInteger(slot) || slot < 0 || slot > 8 || !tool || state.equipmentServerConfirmed === false || state.heldItem?.name !== tool.name || state.heldItem?.slot != null && state.heldItem.slot !== slot || !Number.isSafeInteger(requiredTier) || !(tier >= Math.max(tiers[decision.resource], requiredTier)) || tool.durabilityKnown !== true || !Number.isSafeInteger(tool.maxDurability) || tool.maxDurability < 1 || !Number.isSafeInteger(tool.durabilityUsed) || tool.durabilityUsed < 0 || tool.durabilityUsed >= tool.maxDurability) return decision
  try {
    const result = preview([{ ...decision.target }])
    const target = result?.targets?.[0]
    const expected = decision.block ?? decision.targetOre?.name
    if (result?.ready !== true || result.targets?.length !== 1 || !same(target?.position) || !names[decision.resource].includes(target.name) || expected != null && expected !== target.name) return decision
    return { ...decision, type: 'mine_ore', block: target.name, resourceTarget: { ...decision.target }, requiresLivePreview: true, requiresKnownDurability: true, reason: '現在の採掘面に届くことを確認した鉱石を、通常の採掘操作で掘ります。' }
  } catch { return decision }
}

function normalizeUnobservedTunnel (decision, readBlock) {
  const names = { coal: ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore'], iron: ['minecraft:iron_ore', 'minecraft:deepslate_iron_ore'], diamond: ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore'] }
  const integer = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
  const same = point => integer(point) && ['x', 'y', 'z'].every(axis => point[axis] === decision.target[axis])
  if (decision?.type !== 'tunnel' || !names[decision.resource] || !integer(decision.target) || decision.resourceTarget != null && !same(decision.resourceTarget) || decision.targetOre?.position != null && !same(decision.targetOre.position) || typeof readBlock !== 'function') return decision
  const expected = decision.block ?? decision.targetOre?.name
  if (expected != null && !names[decision.resource].includes(expected)) return decision
  try {
    const block = readBlock(decision.target)
    if (block?.protected === true || block?.natural === false || block?.known === true && (expected == null ? names[decision.resource].includes(block.name) : block.name === expected)) return decision
    return { type: 'prospect', stage: decision.stage, goal: decision.goal, counts: decision.counts, resource: decision.resource, count: decision.count, requiredToolTier: decision.requiredToolTier, rejectUnknown: true, scanOptions: { minY: -64, maxY: 80, chunkRadius: 1, maxResults: 64 }, reason: '記憶した鉱石の受信状態が変わったため、現在地の地形を正規に再観測します。' }
  } catch { return decision }
}

function selectReadyOreTunnel (state, decision, observations, options, { readBlock, previewTunnel, previewMining, isCurrent }) {
  const names = { coal: ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore'], iron: ['minecraft:iron_ore', 'minecraft:deepslate_iron_ore'], diamond: ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore'] }, tiers = { coal: 1, iron: 2, diamond: 3 }
  const integer = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis])), pointKey = point => JSON.stringify([point.x, point.y, point.z])
  if (decision?.type !== 'tunnel' || !names[decision.resource] || !Array.isArray(state?.inventory?.items) || [readBlock, previewTunnel, previewMining, isCurrent].some(fn => typeof fn !== 'function')) return decision
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot, tool = state.inventory?.items?.find(item => item.slot === slot && item.count === 1)
  const tier = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }[String(tool?.name ?? '').replace(/^minecraft:/, '')]
  if (state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.lifecycle?.dead || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || state.inventory?.known !== true || state.inventory.uncertain || !Number.isInteger(slot) || slot < 0 || slot > 8 || state.equipmentServerConfirmed === false || state.heldItem?.name !== tool?.name || state.heldItem?.slot != null && state.heldItem.slot !== slot || !(tier >= Math.max(tiers[decision.resource], decision.requiredToolTier ?? tiers[decision.resource])) || tool?.durabilityKnown !== true || !Number.isSafeInteger(tool.maxDurability) || !Number.isSafeInteger(tool.durabilityUsed) || tool.durabilityUsed < 0 || tool.durabilityUsed >= tool.maxDurability) return decision
  const known = candidate => {
    if (!['tunnel', 'mine_ore'].includes(candidate?.type) || candidate.resource !== decision.resource || !integer(candidate.target)) return false
    if ([candidate.resourceTarget, candidate.targetOre?.position].some(point => point != null && (!integer(point) || pointKey(point) !== pointKey(candidate.target)))) return false
    const expected = candidate.block ?? candidate.targetOre?.name, block = readBlock(candidate.target)
    return names[decision.resource].includes(expected) && block?.known === true && block.name === expected && !block.protected && block.natural !== false
  }
  try {
    if (!isCurrent() || !known(decision)) return decision
    const original = previewTunnel(decision, { maxExpanded: 3000 })
    if (!isCurrent() || original?.ready === true || original?.code !== 'NO_SAFE_ROUTE') return decision
    const scope = JSON.stringify([state.profile, String(state.realm?.id), state.dimension, state.connectionId, String(state.runtimeEntityId ?? '')])
    const excluded = [...(observations.progress?.excludedResources ?? [])], tried = new Set([pointKey(decision.target)])
    excluded.push({ resource: decision.resource, position: { ...decision.target }, scope })
    const feetY = state.position.y - 1.62
    const above = decision.target.y > feetY ? [...(observations.blocks ?? []), ...(observations.ores?.[decision.resource] ?? [])].filter(block => block?.known === true && names[decision.resource].includes(block.name) && integer(block.position) && block.position.y > feetY).map(block => ({ resource: decision.resource, position: { ...block.position }, scope })) : []
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!isCurrent()) return decision
      const view = { ...observations, progress: { ...observations.progress, excludedResources: attempt === 0 ? [...excluded, ...above] : [...excluded] } }
      let candidate = nextDiamondAction(state, view, options)
      if (attempt === 0 && above.length && ['prospect', 'explore'].includes(candidate?.type)) candidate = nextDiamondAction(state, { ...observations, progress: { ...observations.progress, excludedResources: [...excluded] } }, options)
      if (!['tunnel', 'mine_ore'].includes(candidate?.type) || candidate.resource !== decision.resource || !integer(candidate.target) || tried.has(pointKey(candidate.target))) return decision
      tried.add(pointKey(candidate.target))
      if (known(candidate)) {
        const direct = normalizeReachableTunnel(state, { ...candidate, type: 'tunnel' }, previewMining)
        if (!isCurrent()) return decision
        if (direct.type === 'mine_ore' && known(direct) && isCurrent()) return direct
        const plan = previewTunnel({ ...candidate, type: 'tunnel' }, { maxExpanded: 3000 })
        if (!isCurrent()) return decision
        if (plan?.ready === true && plan.withinDurability === true && plan.resource === decision.resource && integer(plan.target) && pointKey(plan.target) === pointKey(candidate.target) && plan.block === (candidate.block ?? candidate.targetOre?.name) && known(candidate) && isCurrent()) return { ...candidate, type: 'tunnel' }
        if (plan?.code !== 'NO_SAFE_ROUTE') return decision
      }
      excluded.push({ resource: decision.resource, position: { ...candidate.target }, scope })
    }
  } catch { /* A bounded alternative is optional; ordinary execution rechecks the original decision. */ }
  return decision
}

function baseSafetyError (reason) {
  const error = new Error(reason)
  error.code = 'STALE_OBSERVATION'
  return error
}
function baseReturnApproach (state, base, unknownPositionCount = 0) {
  const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
  const memo = base?.memo, site = memo?.site
  if (!base?.established || !base.geometryVerified || !base.structureIntact || !base.serverConfirmed || base.pendingPlacement || memo?.pendingPlacement || !site || memo.scope?.dimension !== state.dimension || memo.scope?.realmId == null || String(memo.scope.realmId) !== String(state.realm?.id) || memo.ownerProfile != null && memo.ownerProfile !== state.profile) return { ready: false, reason: 'The remembered base lacks current geometry or ownership proof' }
  const inside = site.innerStandpoint ?? site.insideStandpoint
  const outside = site.outsideStandpoint
  if (!finite(inside) || !finite(outside)) return { ready: false, reason: 'The base approach points are unknown' }
  const dirt = state.inventory?.known === true && !state.inventory.uncertain ? (state.inventory.items ?? []).reduce((sum, item) => sum + (item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0) : 0
  const requiredDirt = base.closureMaterials?.requiredDirt ?? 2
  // Remaining at an already verified inside stance to close funded doors does
  // not request a new approach or override the placement actor's live checks.
  if (base.inside && (base.closed || base.entranceClosed || dirt >= requiredDirt)) return { ready: true, stationaryClosure: true }
  const actors = state.entities ?? state.hostiles
  for (const target of [outside, inside]) {
    const check = evaluateThreats({ ...state, position: { x: target.x, y: target.y + 1.62, z: target.z } }, actors, { observationRadius: 32 })
    if (check.requiresObservation || unknownPositionCount > check.unknownPositions.length || check.threats.length) return { ready: false, reason: 'A current threat or unknown actor prevents a safe base approach' }
  }
  return { ready: true, stationaryClosure: false }
}
function createBaseMovement ({ movement, getState, getUnknownPositionCount = () => 0 }) {
  function currentOptions (options = {}) {
    const state = getState()
    const evaluated = evaluateThreats(state, state.entities ?? state.hostiles, { observationRadius: 32 })
    if (evaluated.requiresObservation || getUnknownPositionCount() > evaluated.unknownPositions.length || evaluated.threats.length) throw baseSafetyError('Current danger or unknown actors interrupt a new base movement')
    if (options.avoidance != null && !Array.isArray(options.avoidance)) throw baseSafetyError('The existing base movement avoidance policy is unknown')
    const circles = new Map((options.avoidance ?? []).map(circle => [circle.id, { ...circle }]))
    for (const actor of [...evaluated.outsideDanger, ...evaluated.suppressedByTerrain]) {
      if (!actor.runtimeId || !actor.position || !Number.isFinite(actor.dangerRadius)) throw baseSafetyError('A recognized actor lacks a usable base movement circle')
      const previous = circles.get(actor.runtimeId)
      circles.set(actor.runtimeId, { id: actor.runtimeId, position: { ...actor.position }, minDistance: Math.max(previous?.minDistance ?? 0, actor.dangerRadius), padding: previous?.padding ?? 0 })
    }
    return { ...options, avoidance: [...circles.values()] }
  }
  function checkedPreview (target, options) {
    const preview = movement.preview(target, options)
    if (!preview?.ready && options.avoidance.length) throw baseSafetyError('No known base path stays clear of the current actor circles')
    return preview
  }
  return {
    preview: (target, options) => checkedPreview(target, currentOptions(options)),
    start: (target, options) => {
      const fresh = currentOptions(options)
      if (!checkedPreview(target, fresh)?.ready) throw baseSafetyError('The base route changed before movement started')
      return movement.start(target, fresh)
    },
    stop: reason => movement.stop(reason)
  }
}

// Transport sequencing only. This never supplies a physics/replay witness.
function queuedWireConnection (state) {
  return typeof state?.connectionId === 'string' && state.connectionId && typeof state.startedAt === 'string' && state.startedAt ? JSON.stringify([state.connectionId, state.startedAt]) : null
}
function createActualQueuedWireClock ({ client, shared, getState }) {
  const key = Symbol.for('minecraftbot.actual_queued_wire_clock.v1')
  const asTick = value => { if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null; try { const tick = BigInt(value); return tick >= 0n && tick < 1n << 64n ? tick : null } catch { return null } }
  let tap = client[key]
  if (!tap) {
    const queue = client.queue
    tap = { version: 1, shared, getState, latest: null }
    client.queue = function (name, packet) {
      const receipt = queue.call(this, name, packet)
      if (name === 'player_auth_input') try {
        const tick = receipt?.tick == null ? null : asTick(receipt.tick), scope = queuedWireConnection(tap.getState()), queuedAt = Date.now()
        if (tick !== null && scope && Number.isFinite(queuedAt) && queuedAt >= 0 && (!tap.latest || tap.latest.scope !== scope || tick > BigInt(tap.latest.tick))) {
          tap.latest = Object.freeze({ scope, tick: String(tick), queuedAt, source: 'actual_client_queue_receipt', serverConfirmed: false })
          tap.shared.actualQueuedWireClock = tap.latest
        }
      } catch { /* Observing a receipt cannot alter the underlying queue result. */ }
      return receipt
    }
    Object.defineProperty(client, key, { value: tap })
  } else {
    if (tap.version !== 1) throw new Error('Unknown actual queued-wire clock tap')
    tap.shared = shared; tap.getState = getState
    if (tap.latest?.scope === queuedWireConnection(getState())) shared.actualQueuedWireClock = tap.latest
  }
  return {
    snapshot: () => tap.latest?.scope === queuedWireConnection(getState()) ? tap.latest : null,
    cursor: (modeled, generationScope, wallTick) => {
      if (queuedWireConnection(getState()) !== generationScope) throw new Error('Queued wire clock connection changed')
      const actual = tap.latest?.scope === generationScope ? tap.latest : null
      const modeledTick = modeled == null ? null : asTick(modeled.tick)
      const selected = actual && (modeled == null || modeledTick !== null && BigInt(actual.tick) >= modeledTick) ? actual : modeled
      // Never renew an old receipt. After the original wall clock overtakes
      // the wire tick, the existing no-cursor path may model one new input;
      // it does not fabricate the paused interval or restore a replay anchor.
      if (selected === actual && actual && Date.now() - actual.queuedAt > 200 && typeof wallTick === 'bigint' && wallTick > BigInt(actual.tick)) return null
      return selected ? { tick: selected.tick, queuedAt: selected.queuedAt } : null
    }
  }
}

function createRuntime (host) {
  host.registerPacketEvents?.(['set_time', 'sync_world_clocks', 'completed_using_item', 'set_entity_motion', 'motion_prediction_hints', 'inventory_transaction', 'update_abilities', 'update_adventure_settings', 'animate', 'set_health', 'mob_effect'])
  let inventoryLifeReceiptTask = null
  let foodBaselineRefreshTask = null
  const inventoryResyncClient = host.client
  let input = null
  let inputStream = null
  let inputOwner = 'none'
  let quarryCancellationRevision = 0
  const portableCancellationScope = () => {
    const s = raw()
    return JSON.stringify([s.profile ?? host.meta.profile ?? null, s.realm?.id ?? s.realmId ?? null, s.connectionId ?? null, s.startedAt ?? null, s.dimension ?? null, String(s.runtimeEntityId ?? ''), actualLifeId()])
  }
  const portableActionOwners = createActionOwnerTracker({ isCurrent: owner => !disposed && !disposing && owner.context?.generation === quarryPorts && owner.context?.revision === quarryCancellationRevision && owner.context?.scope === portableCancellationScope() })
  let idleTimer = null
  let idlePhysics = null
  let idlePhysicsState = null
  let idleOriginNavigator = null
  let idleStamp = null
  let idleFailureAt = 0
  let inputHistory = null
  let inputHistoryPhysics = null
  let inputHistoryGeneration = 0
  let stationaryRawPending = null
  const historyScope = state => ({ profile: state.profile, realmId: state.realm?.id, dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: state.runtimeEntityId, generation: inputHistoryGeneration })
  const movementCalibrationFrames = []
  const movementCalibration = { version: 1, frameColumns: ['tick', 'queuedAt', 'packetEye', 'nativeFeet', 'velocity', 'onGround', 'controlBits', 'yaw', 'health', 'mediumBits'], controlColumns: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'], scopeColumns: ['profile', 'realmId', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId', 'generation'], frameCapacity: 48, pairCapacity: 12, maxPairAgeMs: 2500, framesObserved: 0, frameCount: 0, skipped: {}, pairs: [] }
  const calibrationScope = state => JSON.stringify([String(state.profile ?? ''), String(state.realm?.id ?? ''), state.dimension ?? null, String(state.connectionId ?? ''), String(state.startedAt ?? ''), String(state.runtimeEntityId ?? ''), inputHistoryGeneration])
  function recordMovementCalibrationFrame (frame) {
    try {
      const point = value => value && ['x', 'y', 'z'].every(k => Number.isFinite(value[k])), vector = value => [value.x, value.y, value.z]
      const state = raw(), physical = frame.predictedState, tick = BigInt(frame.tick)
      if (frame.modeled !== true || frame.receiptConfirmed !== true || !['input', 'navigation'].includes(frame.producer) || tick < 0n || !Number.isFinite(frame.queuedAt) || !point(frame.packetPosition) || !point(physical?.position) || !point(physical.velocity) || typeof physical.onGround !== 'boolean' || !Number.isFinite(frame.yaw) || !Number.isFinite(frame.health) || !Number.isSafeInteger(host.shared.deathRespawn?.deathId) || actualLifeId() < 0 || !frame.controls || Object.entries(frame.controls).some(([key, value]) => !movementCalibration.controlColumns.includes(key) || typeof value !== 'boolean')) return
      const bits = movementCalibration.controlColumns.reduce((mask, key, index) => mask | (frame.controls[key] === true ? 1 << index : 0), 0)
      const medium = (physical.isInWater === true ? 1 : 0) | (physical.isInLava === true ? 2 : 0) | (typeof physical.isInWater !== 'boolean' || typeof physical.isInLava !== 'boolean' ? 4 : 0)
      movementCalibrationFrames.push({ row: [String(tick), frame.queuedAt, vector(frame.packetPosition), vector(physical.position), vector(physical.velocity), physical.onGround, bits, frame.yaw, frame.health, medium], scope: calibrationScope(state), life: actualLifeId(), force: userBehaviorForceRevision, producer: frame.producer })
      if (movementCalibrationFrames.length > 48) movementCalibrationFrames.shift()
      movementCalibration.framesObserved++; movementCalibration.frameCount = movementCalibrationFrames.length
    } catch { /* Diagnostics cannot change an already queued frame. */ }
  }
  function recordMovementCorrectionPair (packet, correction) {
    try {
      const skip = reason => { movementCalibration.skipped[reason] = (movementCalibration.skipped[reason] ?? 0) + 1 }
      if (!correction?.accepted || correction.tick === '0') { skip('not_accepted_player_correction'); return }
      if (!Number.isSafeInteger(host.shared.deathRespawn?.deathId) || actualLifeId() < 0) { skip('life_unknown'); return }
      const matches = movementCalibrationFrames.filter(frame => frame.row[0] === correction.tick)
      if (matches.length !== 1) { skip(matches.length > 1 ? 'duplicate_tick' : 'unmatched_or_evicted'); return }
      const matched = matches[0], at = Date.now(), lag = at - matched.row[1], state = raw()
      if (!Number.isFinite(lag) || lag < 0 || lag > 2500) { skip('late_or_future'); return }
      if (matched.life !== actualLifeId()) { skip('cross_life'); return }
      if (matched.scope !== calibrationScope(state)) { skip('cross_scope'); return }
      if (matched.force !== userBehaviorForceRevision) { skip('force_changed'); return }
      const records = [2n, 1n, 0n].map(offset => movementCalibrationFrames.filter(frame => BigInt(frame.row[0]) === BigInt(correction.tick) - offset))
      if (records.some(records => records.length !== 1)) { skip('previous_ticks_missing_or_duplicate'); return }
      const frames = records.map(records => records[0])
      if (frames.some(frame => frame.scope !== matched.scope || frame.life !== matched.life || frame.force !== matched.force)) { skip('previous_context_changed'); return }
      const a = frames[0].row, b = frames[1].row
      const previousSteady = a[5] && b[5] && a[9] === 0 && b[9] === 0 && a[6] === b[6] && !!(a[6] & 15) && !(a[6] & 80) && Math.abs(a[7] - b[7]) < 0.5 && a[8] === b[8] && Math.abs(a[2][1] - b[2][1]) < 1e-4 && Math.hypot(a[4][0] - b[4][0], a[4][2] - b[4][2]) < 0.01 && Math.hypot(b[2][0] - a[2][0], b[2][2] - a[2][2]) > 0.001
      movementCalibration.pairs.push({ at, scope: JSON.parse(matched.scope), life: matched.life, forceRevision: matched.force, lagMs: lag, previousSteady: !!previousSteady, healthNow: state.health, correction: { tick: correction.tick, position: [packet.position.x, packet.position.y, packet.position.z], delta: [packet.delta.x, packet.delta.y, packet.delta.z], onGround: packet.on_ground }, frames: frames.map(frame => frame.row) })
      while (movementCalibration.pairs.length > 12 || Buffer.byteLength(JSON.stringify(movementCalibration), 'utf8') > 12288) movementCalibration.pairs.shift()
    } catch { /* A missing or malformed diagnostic pair cannot affect rebasing. */ }
  }

  let walker = null
  let movement = null
  let combat = null
  let excavation = null
  // Quarry mode (露天掘り): ports are bound per motion generation; the job is
  // created lazily on first use and survives reloads only as a saved document.
  let quarryPorts = null, quarryJob = null, quarryRetreatDepth = 0, quarryCombatArmed = false, quarryBehaviorRestore = null, quarryPortableStorage = null, quarrySupplies = null
  let quarryPillar = null, quarryPillarTask = null, quarryEgressRuntime = null, quarryEgressTask = null, quarryEgressAbort = null
  let quarryPositionVerifier = null
  let storagePlacementAudit = null
  let plainsLocator = null
  let quarryTerrainRequester = null
  let manualShulkerRecovery = null, manualShulkerDocument = null, manualShulkerTask = null, manualShulkerAbort = null, manualShulkerMiningSerial = null, manualShulkerLoadSequence = 0
  let manualChestStorage = null
  let tunneling = null
  let stoneAccessProposal = null, stoneAccessSequence = 0
  const STONE_ACCESS_BOUNDS = Object.freeze({ maxDistance: 6, maxVertical: 6, maxRouteSteps: 6, maxRouteDigBlocks: 16, maxExpanded: 3000 })
  let readCurrentTunnelFloors = () => []
  let depotPrebuild = null
  let depotMission = null, depotBuilder = null, depotStorage = null, continuationActions = null, continuationSafety = null
  let surfaceReturn = null, surfaceReturnOwner = null, surfaceReturnSequence = 0
  let recovery = null
  let foraging = null
  let shelter = null
  let hut = null
  let guardRoute = null
  let guardRouteProgress = null
  let boundedJumpSearch = null
  let idleSafety = null
  let userBehaviors = null
  let userBehaviorTimer = null
  let userBehaviorTickTask = null
  let userBehaviorLease = null
  let userBehaviorSleeping = false
  let userBehaviorWakePending = false
  let userBehaviorSleepStamp = null
  let userBehaviorSleepWitness = null
  let userBehaviorForceRevision = 0
  let userBehaviorGenerationScope = null
  let recoveryMotionDepth = 0
  let inspectEmergencyLeafPacket = null
  let inspectPartialEscapePacket = null
  let inspectIdleEscapePacket = null
  let safetyDispatchEpoch = 0
  host.shared.safetyWanted ??= false
  host.shared.safetyEnableEpoch ??= 0
  let loadoutReset = null, loadoutLease = null
  host.shared.loadoutGeneration = (host.shared.loadoutGeneration ?? 0) + 1
  let chunkTravel = null, chunkMoveLease = null, chunkMoveDepth = 0
  let quarryPlacementPreparation = null
  const chunkMoveHeld = () => chunkMoveLease !== null || chunkTravel?.isBusy() === true
  const controlLocation = createControlLocation({ getState: () => quarryState(), getObservedState: () => lightweightRawState(),
    generation: () => host.shared.loadoutGeneration, confirmPosition: (feet, options) => confirmQuarryPosition(feet, options),
    isMoving: () => chunkMoveHeld() || motionActive(), store: host.shared.dashboardControlLocation ??= {} })
  function publishControlPrediction (prediction, source) { controlLocation.notePrediction(prediction, source); host.setPrediction(prediction, source) }
  function stopChunkMovement (operationId, reason) {
    const owner = chunkMoveLease
    if (!owner || owner.id !== operationId || owner.stopped) return
    owner.stopped = true
    if (owner.startedMovement === movement && owner.startedSerial === portableMovementSerial) owner.startedMovement?.stop(reason ?? 'CHUNK_MOVE_STOP')
  }
  function cancelChunkMovement (reason) {
    const id = chunkMoveLease?.id
    const result = chunkTravel?.cancel(reason)
    if (id) stopChunkMovement(id, reason)
    return result
  }
  const resetHeld = () => loadoutLease !== null || loadoutReset?.status().busy === true
  let ownedCall = 0
  const pendingStops = new Set()
  let motionOrigin = null
  let disposed = false
  let disposing = false
  let replaying = true
  let readDurability = null
  function craftStatus () { return typeof crafting.status === 'function' ? crafting.status() : crafting.snapshot() }
  function craftInventory () { return typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot() }
  const working = () => {
    const state = host.getState()
    if (readDurability) {
      // Older connected hosts omit stack IDs from their public inventory.
      // Fill only missing fields from the matching received crafting inventory;
      // an explicitly unknown server stack ID remains unknown.
      if (state.inventory.items.some(item => !Object.hasOwn(item, 'stackId'))) {
        const received = craftInventory()
        const bySlot = received.inventoryKnown ? new Map((received.inventory ?? []).map(item => [item.slot, item])) : new Map()
        state.inventory.items = state.inventory.items.map(item => {
          if (Object.hasOwn(item, 'stackId')) return item
          const observed = bySlot.get(item.slot)
          return { ...item, stackId: observed?.name === item.name && observed.count === item.count ? observed.stackId : null }
        })
      }
      // Only tools read durability; skip cloning the raw stack for everything else.
      state.inventory.items = state.inventory.items.map(item => /_(?:pickaxe|sword|shovel|axe|hoe)$/.test(item?.name ?? '') ? readDurability(item, crafting.rawItem(item.slot)) : item)
      if (state.heldItem) state.heldItem = state.inventory.items.find(item => item.slot === state.heldItem.slot) ?? null
    }
    if (host.shared.inventoryUncertain) state.inventory = { ...state.inventory, known: false, uncertain: true }
    state.threatPolicy = host.shared.autoWanted ? 'online_learning' : 'balanced_mining'
    const held = state.inventory?.items ?? []
    const useful = suffix => held.some(i => new RegExp('^minecraft:(?:wooden|golden|stone|iron|diamond|netherite)_'+suffix+'$').test(i.name ?? '') && i.count > 0 && !(i.durabilityKnown === true && i.durabilityRemaining <= 0))
    state.spawnRangedClearance = depotMission?.isEnabled() === true && state.phase === 'spawned' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.spawnPending && !state.lifecycle?.dead
    state.survivalWorkClearance = depotMission?.isEnabled() === true && (held.some(i=>i.name==='minecraft:diamond' && i.count>0) || useful('sword') || useful('pickaxe'))
    return state
  }
  const raw = () => host.getServerState()
  const rawFields = fields => typeof host.getServerFields === 'function' ? host.getServerFields(fields) : raw()
  const scopeFields = ['profile', 'realm', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId']
  const rawScope = () => rawFields(scopeFields)
  const actualWireClock = createActualQueuedWireClock({ client: host.client, shared: host.shared, getState: () => rawFields(['connectionId', 'startedAt', 'runtimeEntityId']) })
  const actualLifeId = () => Number.isSafeInteger(host.shared.deathRespawn?.deathId) ? host.shared.deathRespawn.deathId : 0
  const effectState = () => {
    const state = rawFields([...scopeFields, 'phase', 'health', 'position', 'dead', 'isDead', 'spawnPending'])
    return { ...state, profile: state.profile ?? host.meta.profile, lifecycle: { deathId: actualLifeId(), dead: state.dead === true, phase: state.dead ? 'dead' : 'alive' } }
  }
  const selfResistance = createSelfResistance({ getState: effectState })
  const selfSlowFalling = createSelfSlowFalling({ getState: effectState })
  const selfEffectEvents = createSelfEffectEvents({ getState: effectState })
  const userScope = state => JSON.stringify([state.profile ?? host.meta.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.connectionId ?? null, state.startedAt ?? null, state.dimension ?? null, String(state.runtimeEntityId ?? ''), actualLifeId()])
  function userBehaviorError (error, source) { host.shared.userBehaviorError = { source, message: String(error?.message ?? error).slice(0, 300), at: new Date().toISOString() } }
  function userBehaviorSnapshot () {
    const defense = defenseEnabled(host.shared), automaticWork = host.shared.userBehaviorsEnabled === true
    try { return { enabled: defense || automaticWork, defenseEnabled: defense, automaticWorkEnabled: automaticWork, ready: userBehaviors !== null, ...(userBehaviors?.snapshot() ?? { busy: false, claim: null, sleeping: false, blocked: false }), wakePending: userBehaviorWakePending, approachAdmission: userBehaviorLease?.meleeApproach ? { reason: userBehaviorLease.meleeApproach.reason, targetRuntimeId: userBehaviorLease.meleeApproach.target.runtimeId, engagementReached: userBehaviorLease.meleeApproach.engagementReached } : null, runtimeError: structuredClone(host.shared.userBehaviorError ?? null) } } catch (error) { userBehaviorError(error, 'snapshot'); return { enabled: defense || automaticWork, defenseEnabled: defense, automaticWorkEnabled: automaticWork, ready: true, busy: true, blocked: true, sleeping: userBehaviorSleeping, lastError: host.shared.userBehaviorError.message } }
  }
  function userBehaviorOwns () { const s = userBehaviorSnapshot(); return !!userBehaviorLease || userBehaviorSleeping || userBehaviorWakePending || s.sleeping === true || s.enabled && (s.busy === true || s.blocked === true || s.claim != null) }
  function rememberCurrentMeleeReach (state) {
    const admission = userBehaviorLease?.meleeApproach
    if (!admission || admission.engagementReached || admission.scope !== userScope(state)) return
    const actor = state.entities?.find(e => String(e.runtimeId) === admission.target.runtimeId && String(e.uniqueId) === admission.target.uniqueId && e.entityType === admission.target.entityType && e.alive === true && e.hostile === true && e.positionKnown === true && e.dimension === state.dimension)
    const stamp = typeof state.positionUpdatedAt === 'number' ? state.positionUpdatedAt : Date.parse(state.positionUpdatedAt)
    const physical = state.predicted?.physicsState
    const current = Number.isFinite(stamp) && Date.now() - stamp >= 0 && Date.now() - stamp <= 200 && (state.positionSource !== 'client_prediction' || physical?.position && ['x', 'y', 'z'].every(axis => Number.isFinite(physical.position[axis]) && Math.abs(physical.position[axis] + (axis === 'y' ? 1.62 : 0) - state.position[axis]) <= 1e-6))
    if (actor && current && Math.hypot(state.position.x - actor.position.x, state.position.y - actor.position.y - (['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:vex', 'minecraft:phantom'].includes(actor.entityType) ? 0.2 : 0.9), state.position.z - actor.position.z) <= 2.8) admission.engagementReached = true
  }
  const allActors = createActorReader(host.entities)
  function lightweightUserState () {
    const state = working(), observed = raw(), actors = allActors()
    const dead = observed.dead === true || observed.isDead === true || observed.health === 0
    const current = { ...state, profile: state.profile ?? host.meta.profile, dead: state.dead === true || dead, isDead: state.isDead === true || dead, threatPolicy: host.shared.autoWanted ? 'online_learning' : 'balanced_mining', entities: actors, hostiles: actors.filter(e => e.hostile && e.alive), entityStats: host.entities.stats?.() ?? { unknownPositions: actors.filter(e => e.positionKnown !== true).length }, lifecycle: { ...(state.lifecycle ?? {}), deathId: actualLifeId(), dead, phase: dead ? 'dead' : 'alive' } }
    rememberCurrentMeleeReach(current)
    return current
  }
  function lightweightRawState () { const state = raw(); return { ...state, profile: state.profile ?? host.meta.profile, lifecycle: { ...(state.lifecycle ?? {}), deathId: actualLifeId(), dead: state.dead === true || state.isDead === true || state.health === 0 } } }
  function navigationDestination (state = working()) {
    const intent = host.shared[USER_NAVIGATION_INTENT]
    if (!intent) return null
    if (intent.scope !== userScope(state)) { delete host.shared[USER_NAVIGATION_INTENT]; return null }
    return { position: { ...intent.position } }
  }
  function rememberNavigationDestination (target) {
    if (!target || !['x', 'y', 'z'].every(k => Number.isFinite(target[k]))) return
    Object.defineProperty(host.shared, USER_NAVIGATION_INTENT, { configurable: true, enumerable: false, writable: true, value: { token: require('node:crypto').randomUUID(), scope: userScope(working()), position: { x: target.x, y: target.y, z: target.z } } })
  }
  function clearNavigationDestination () { delete host.shared[USER_NAVIGATION_INTENT] }
  function transportScopeState () {
    const state=lightweightUserState(),life=movementKnownLife()
    state.lifecycle={...state.lifecycle,deathId:life}
    if(disposed||disposing||!continuationScope(state))throw Error('Current confirmed living transport scope required')
    return state
  }
  function requireTransientWorkLease (leaseId,state=transportScopeState()) {
    const lease=host.shared.legacyWorkHoldLease,now=Date.now(),scope=userScope(state)
    if(typeof leaseId!=='string'||!lease||lease.id!==leaseId||lease.scope!==scope||host.shared.legacyWorkHoldScope!==scope||!Number.isFinite(lease.createdAt)||!Number.isFinite(lease.expiresAt)||lease.createdAt>now||now>=lease.expiresAt||!Number.isSafeInteger(lease.expiresAt-lease.createdAt)||lease.expiresAt-lease.createdAt<1000||lease.expiresAt-lease.createdAt>60000)throw Error('Current exact unexpired timed work lease required')
    return state
  }
  function movementDestination () {
    const state=transportScopeState(),destination=navigationDestination(state)
    if(!destination)return null
    const intent=host.shared[USER_NAVIGATION_INTENT]
    if(typeof intent.token!=='string')intent.token=require('node:crypto').randomUUID()
    return {version:1,token:intent.token,scope:continuationScope(state),position:{...intent.position}}
  }
  function clearMovementDestination ({expected,leaseId}={}) {
    requireTransientWorkLease(leaseId)
    const current=movementDestination()
    if(!current||expected?.version!==current.version||expected.token!==current.token||!expected.scope||Object.keys(current.scope).some(k=>expected.scope[k]!==current.scope[k])||!expected.position||['x','y','z'].some(k=>expected.position[k]!==current.position[k]))throw Error('Remembered destination identity or scope changed')
    if(physicalWorkBusy()||depotPrebuild?.snapshot().busy||depotMission?.isBusy())throw Error('Physical controllers must be idle before clearing destination')
    clearNavigationDestination()
    return {cleared:true,version:current.version,token:current.token,scope:current.scope,position:current.position,serverConfirmed:false}
  }
  function stopOrdinaryUserStream () { inputStream?.stop(false); inputOwner = 'none'; idlePhysicsState = null; idleStamp = null }
  function sleepProducerCounts () {
    const stream = inputStream?.stats(), motion = movement?.snapshot(), walk = walker?.snapshot(), history = inputHistory?.snapshot()
    if (![stream?.sent, motion?.sent, walk?.sent].every(v => Number.isSafeInteger(v) && v >= 0)) return null
    return { stream: stream.sent, movement: motion.sent, walker: walk.sent, cursor: history?.cursor?.tick == null ? null : String(history.cursor.tick), latestTick: history?.latestTick == null ? null : String(history.latestTick) }
  }
  function sameProducerCounts (a, b) { return a && b && ['stream', 'movement', 'walker', 'cursor', 'latestTick'].every(k => a[k] === b[k]) }
  function resumeUnchangedAuthoritativeWake (snapshot) {
    const witness = userBehaviorSleepWitness, receipt = snapshot.bed?.sleepReceipt
    if (!userBehaviorWakePending || !witness || witness.inputDuringStop || !receipt || receipt.sleeping !== false || !['own_server_metadata', 'own_server_wake_animation'].includes(receipt.source) || receipt.scope !== witness.receiptScope || !Number.isSafeInteger(receipt.sequence) || receipt.sequence <= witness.sequence) return false
    if (witness.stream !== inputStream || witness.movement !== movement || witness.walker !== walker || witness.history !== inputHistory || witness.forceRevision !== userBehaviorForceRevision || !sameProducerCounts(witness.counts, sleepProducerCounts())) return false
    const state = raw()
    if (userScope(state) !== witness.scope || state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !(Number.isFinite(state.health) && state.health > 0) || state.positionUpdatedAt !== witness.stamp || !state.position || ['x', 'y', 'z'].some(k => state.position[k] !== witness.position[k])) return false
    if (state.positionSource === 'client_prediction' || state.positionServerConfirmed !== true && !['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource)) return false
    try {
      const physical = idlePhysics.fromServer({ ...state, predicted: null, workingPrediction: null })
      if (physical.onGround !== true || physical.isInWater || physical.isInLava || physical.isInWeb || physical.flying || physical.riding) return false
      const p = physical.position
      for (let x = Math.floor(p.x - 0.299); x <= Math.floor(p.x + 0.299); x++) for (let z = Math.floor(p.z - 0.299); z <= Math.floor(p.z + 0.299); z++) for (let y = Math.floor(p.y - 0.05); y <= Math.floor(p.y + 1.799); y++) {
        const block = host.world.getBlock(x, y, z)
        if (block?.known !== true || (block.extra ?? []).some(layer => layer.known === false)) return false
      }
      idleOriginNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: idlePhysics })
      if (idleOriginNavigator.verifyOrigin(physical) !== true) return false
    } catch { return false }
    // This proves continued use of the SAME received standing pose. It neither
    // writes a position nor creates a new server movement/arrival receipt.
    userBehaviorWakePending = false; userBehaviorSleepWitness = null
    idlePhysicsState = null; idleStamp = null; motionOrigin = null; stationaryRawPending = null
    inputHistory?.invalidate('unchanged_authoritative_wake')
    return true
  }
  function synchronizeUserSleep () {
    const snapshot = userBehaviorSnapshot(), sleeping = snapshot.sleeping === true
    if (sleeping && !userBehaviorSleeping) {
      const state = raw(), counts = sleepProducerCounts(), receipt = snapshot.bed?.sleepReceipt
      userBehaviorSleeping = true; userBehaviorWakePending = false; userBehaviorSleepStamp = state.positionUpdatedAt
      stopOrdinaryUserStream(); mining.stop('実際の睡眠中は通常入力を休止します。'); walker?.stop('server_sleep'); movement?.resetLifecycle?.('server_sleep')
      autonomy.stop('user_behavior_sleep'); inputHistory?.invalidate('user_behavior_sleep'); stationaryRawPending = null; motionOrigin = null; host.shared.prediction = null; host.shared.motionSource = null
      const after = sleepProducerCounts()
      userBehaviorSleepWitness = receipt?.sleeping === true && ['own_server_metadata', 'own_server_wake_animation'].includes(receipt.source) && typeof receipt.scope === 'string' && Number.isSafeInteger(receipt.sequence) && state.position && state.positionUpdatedAt != null ? { scope: userScope(state), position: { ...state.position }, stamp: state.positionUpdatedAt, receiptScope: receipt.scope, sequence: receipt.sequence, counts: after, inputDuringStop: !counts || !after || ['stream', 'movement', 'walker'].some(k => counts[k] !== after[k]), forceRevision: userBehaviorForceRevision, stream: inputStream, movement, walker, history: inputHistory } : null
      const cleanup = Promise.resolve(idleSafety?.stop('server_sleep')).then(() => idleSafety?.drain()).catch(error => userBehaviorError(error, 'sleep_cleanup'))
      pendingStops.add(cleanup); void cleanup.finally(() => pendingStops.delete(cleanup))
    } else if (!sleeping && userBehaviorSleeping) {
      userBehaviorSleeping = false; userBehaviorWakePending = raw().positionUpdatedAt === userBehaviorSleepStamp
      stopOrdinaryUserStream(); motionOrigin = null; host.shared.prediction = null; host.shared.motionSource = null; inputHistory?.invalidate('user_behavior_wake')
    }
    if (!sleeping && userBehaviorWakePending) resumeUnchangedAuthoritativeWake(snapshot)
  }
  function maybeAutoStartUserBehaviors () {
    if (host.shared.userBehaviorsEnabled == null && host.shared.autoWanted === true && typeof host.meta.profile === 'string' && host.meta.startGame?.entity_id != null && raw().phase === 'spawned' && host.shared.loadingScreenEnded === true) host.shared.userBehaviorsEnabled = true
  }
  function tickUserBehaviors () {
    if (resetHeld()) return
    // Diagnostics: how often the combat tick actually runs and what holds it.
    const stats = host.shared.userTickStats ??= { calls: 0, ran: 0, heldByTask: 0, taskSince: null, lastRanAt: null }
    stats.calls++
    if (userBehaviorTickTask) { stats.heldByTask++; stats.taskSince ??= Date.now() }
    if (disposed || disposing || !userBehaviors || userBehaviorTickTask || replaying) return
    stats.ran++; stats.taskSince = null; stats.lastRanAt = Date.now()
    if (!defenseEnabled(host.shared) && host.shared.userBehaviorsEnabled !== true && !userBehaviorLease && !userBehaviorSleeping && !userBehaviorSnapshot().sleeping) return
    let result
    try { result = userBehaviors.tick() } catch (error) { userBehaviorError(error, 'tick'); return }
    const task = Promise.resolve(result).then(() => { synchronizeUserSleep(); if (!userBehaviorOwns() && host.shared.autoWanted && !autonomy.snapshot().running) return resumeRequested() }).catch(error => userBehaviorError(error, 'tick')).finally(() => { if (userBehaviorTickTask === task) userBehaviorTickTask = null })
    userBehaviorTickTask = task
  }
  function observeStationaryRaw () {
    if (!inputHistory) return
    const state = raw()
    stationaryRawPending = null
    if (state.phase !== 'spawned' || state.dead || state.spawnPending || !state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis]))) return
    const receivedAt = typeof state.positionUpdatedAt === 'number' ? state.positionUpdatedAt : typeof state.positionUpdatedAt === 'string' ? Date.parse(state.positionUpdatedAt) : NaN
    if (!(state.health > 0)) {
      if (state.health == null) stationaryRawPending = { history: inputHistory, revision: inputHistory.snapshot().revision, position: { ...state.position }, rawStamp: state.positionUpdatedAt, scope: JSON.stringify(historyScope(state)), receivedAt }
      return
    }
    inputHistory.observeStationaryRaw({ rawPosition: state.position, rawStamp: state.positionUpdatedAt, scope: historyScope(state), health: state.health, receivedAt })
  }
  function completeStationaryRawHealth () {
    const pending = stationaryRawPending
    stationaryRawPending = null
    if (!pending || pending.history !== inputHistory || pending.revision !== inputHistory.snapshot().revision) return
    const state = raw()
    if (state.phase !== 'spawned' || state.dead || state.spawnPending || !(state.health > 0) || state.positionUpdatedAt !== pending.rawStamp || JSON.stringify(historyScope(state)) !== pending.scope || !state.position || ['x', 'y', 'z'].some(axis => state.position[axis] !== pending.position[axis])) return
    inputHistory.observeStationaryRaw({ rawPosition: pending.position, rawStamp: pending.rawStamp, scope: historyScope(state), health: state.health, receivedAt: pending.receivedAt })
  }
  const baseProtectedWorld = createBaseProtection({ world: host.world, getState: raw, getHutMemo: () => host.shared.hutMemo, getShelterMemo: () => host.shared.shelterMemo, ownerProfile: raw().profile ?? null })
  const noTunnelFloorKeys = new Set()
  let tunnelFloorViewCache = null
  function tunnelFloorKeys () {
    const journal = host.shared.tunnelFloors
    if (journal == null) { tunnelFloorViewCache = null; return noTunnelFloorKeys }
    const state = raw()
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !['overworld', 'nether', 'end'].includes(state.dimension)) throw Object.assign(new Error('帰路の床のワールド情報が未確定のため、計画を停止します。'), { code: 'TUNNEL_FLOOR_SCOPE_UNKNOWN' })
    if (journal.version !== 1 || !journal.scopes || typeof journal.scopes !== 'object' || Array.isArray(journal.scopes)) throw new Error('帰路の床の記録が不明なため、計画を停止します。')
    const scope = JSON.stringify([state.profile, String(state.realm.id), state.dimension])
    const entry = journal.scopes[scope], points = entry?.floors
    if (entry != null && (!entry || typeof entry !== 'object' || !Array.isArray(points) || points.length > 1024)) throw new Error('帰路の床の記録が不正なため、計画を停止します。')
    // Accepted floor receipts replace their entry/array. Validate once for
    // each immutable revision, not once per physics block read.
    if (tunnelFloorViewCache?.scope === scope && tunnelFloorViewCache.journal === journal && tunnelFloorViewCache.entry === entry && tunnelFloorViewCache.points === points && tunnelFloorViewCache.count === (points?.length ?? 0) && tunnelFloorViewCache.reader === readCurrentTunnelFloors) return tunnelFloorViewCache.keys
    const floors = readCurrentTunnelFloors()
    if (floors.length !== (points?.length ?? 0)) throw new Error('帰路の床の検証を待ってから計画してください。')
    const keys = new Set(floors.map(point => String(point.x) + ',' + String(point.y) + ',' + String(point.z)))
    tunnelFloorViewCache = { scope, journal, entry, points, count: points?.length ?? 0, reader: readCurrentTunnelFloors, keys }
    return keys
  }
  const protectTunnelFloor = (block, point, keys) => block?.known === true && block.protected !== true && keys.has(String(point.x) + ',' + String(point.y) + ',' + String(point.z)) ? { ...block, protected: true, protectionSource: 'tunnel_floor' } : block
  let portableConstraintCache = null
  let portableMovementLease = null
  let portableMovementOwner = null
  let portableMovementSerial = 0
  let portableFallbackProposal = null
  function portableKeys () {
    const memo = host.shared.portableWorksiteMemo
    if (portableConstraintCache && portableConstraintCache.memo === memo) return portableConstraintCache.keys
    const keys = new Set(reservedWorksiteCells(memo, raw()).map(point => String(point.x) + ',' + String(point.y) + ',' + String(point.z)))
    portableConstraintCache = { memo, keys }; return keys
  }
  const protectPortable = (block, point) => block?.known === true && !block.protected && portableKeys().has(String(point.x) + ',' + String(point.y) + ',' + String(point.z)) ? { ...block, protected: true, protectionSource: 'portable_worksite_reserved' } : block
  const protectDepot = block => {
    if (!block?.known || !block.position) return block
    const p = block.position
    return depotMission?.isProtected(p) ? { ...block, protected: true, protectionSource: 'owned_depot' } : block
  }
  const planningWorld = {
    ...baseProtectedWorld,
    getBlock: (x, y, z) => { const keys = tunnelFloorKeys(); return protectDepot(protectPortable(protectTunnelFloor(baseProtectedWorld.getBlock(x, y, z), { x, y, z }, keys), { x, y, z })) },
    getArea: (center, radius = 1) => { const keys = tunnelFloorKeys(); return baseProtectedWorld.getArea(center, radius).map(block => protectDepot(protectPortable(protectTunnelFloor(block, block.position, keys), block.position))) }
  }
  const activeBase = () => {
    const fallback=()=>host.shared.depotHutUpgraded === true ? null : host.shared.hutMemo?.site && hut ? hut : shelter
    const memo=host.shared.shelterMemo ?? shelter?.memo?.()
    if(!shelter || memo?.site?.type!=='soil_hill_shelter')return fallback()
    try {
      const state=raw(),sameWorld=memo.scope?.realmId!=null && String(memo.scope.realmId)===String(state.realm?.id) && memo.scope.dimension===state.dimension
      const soil=shelter.snapshot(),verified=value=>value?.established===true && value.structureIntact===true && value.geometryVerified===true && value.serverConfirmed===true
      const soilOwned=sameWorld && verified(soil) && soil.confirmedBy==='received_structure_and_own_placement_inventory' && !memo.pendingPlacement?.requiresReconciliation
      const soilCover=soilOwned && soil.inside===true && soil.closed===true && soil.entranceClosed===true && soil.usable===true
      const soilOperation=soilOwned && soil.busy===true
      if(soilCover || soilOperation){
        const old=hut?.snapshot(),oldCover=host.shared.depotHutUpgraded!==true && verified(old) && old.inside===true && old.closed===true && old.usable===true
        if(!oldCover)return shelter
      }
    } catch { /* Only current confirmed owned cover can replace the old selector. */ }
    return fallback()
  }
  const missionJournal = createMissionJournal({
    workspaceRoot: host.meta.workspaceRoot, store: host.missionMemory,
    getScope: () => { const state = raw(); return { profile: state.profile ?? host.meta.profile, realmId: state.realm?.id, dimension: state.dimension } },
    getMemo: () => host.shared.hutMemo ?? host.shared.shelterMemo ?? null,
    getGeneration: () => inputStream, isCurrent: () => !disposed,
    restoreMemo: (kind, memo, scope, generation) => {
      if (disposed || disposing || generation !== inputStream || host.shared.hutMemo != null || host.shared.shelterMemo != null) return false
      const actor = kind === 'hut' ? hut : shelter
      if (!actor || actor.memo() != null || actor.snapshot().busy) return false
      actor.restoreMemo(memo)
      host.shared[kind === 'hut' ? 'hutMemo' : 'shelterMemo'] = actor.memo()
      return true
    },
    onError: error => { host.shared.missionMemoryError = error.code; host.log(`拠点記録を保存・復元できませんでした: ${error.code}`) }
  })
  const missionReady = result => result?.status !== 'deferred' && !(result?.status === 'skipped' && result.code !== 'EXISTING_MEMORY')
  const shoreMemory = missionJournal.enabled ? createShoreLandmarks({ workspaceRoot: host.meta.workspaceRoot }) : null
  let shoreMemoryTask = null
  function loadShoreHistory () {
    if (!shoreMemory || disposed || disposing || !raw().realm?.id) return Promise.resolve()
    if (shoreMemoryTask) return shoreMemoryTask
    const scope = { profile: raw().profile, realmId: String(raw().realm.id), dimension: raw().dimension }
    shoreMemoryTask = (async () => {
      await shoreMemory.load()
      if (disposed || disposing) return
      await shoreMemory.seedShelterHistory(scope)
      if (disposed || disposing) return
      await shoreMemory.save()
    })().catch(error => { host.shared.shoreMemoryError = String(error.message).slice(0, 160) })
    return shoreMemoryTask
  }
  function shoreScore (state, from, target) {
    if (!shoreMemory) return null
    try { return shoreMemory.directionScore({ profile: state.profile, realmId: String(state.realm?.id), dimension: state.dimension }, from, target) } catch { return null }
  }
  function noteShelterProgress (data) {
    host.shared.shelterMemo = data.memo
    const state = working()
    host.shared.shelterEvents ??= []
    host.shared.shelterEvents.push({ phase: data.phase, at: new Date().toISOString(), health: state.health, position: state.position, inventory: state.inventory.items.map(item => ({ name: item.name, count: item.count, slot: item.slot })), code: data.code, reason: data.reason })
    if (host.shared.shelterEvents.length > 80) host.shared.shelterEvents.shift()
    void missionJournal.save()
    host.noteProgress(data)
  }
  function noteHutProgress (data) { host.shared.hutMemo = data.memo; void missionJournal.save(); host.noteProgress(data) }
  // Route evidence for nearby hostiles (see threat-reachability.js). Missing
  // or truncated evidence stays unknown and the normal threat policy applies.
  // Daylight watchdog. The owner keeps this sandbox Realm at permanent day; it
  // was found at night twice (mobs on the surface, a death at the chests).
  // Every 30s: if the overworld clock moved since the last check (day cycle
  // running) or it is night, log it and re-apply noon + no day cycle (at most
  // every 5 minutes). Only the world-clock packets are read; no proof claimed.
  const daylightTimer = setInterval(() => {
    if (disposed || disposing) { clearInterval(daylightTimer); return }
    try {
      const clock = Object.values(host.shared.worldClocks ?? {}).find(c => /overworld/.test(c?.name ?? ''))
      if (!clock || !Number.isFinite(Number(clock.time)) || raw().phase !== 'spawned') return
      const t = Number(clock.time); const day = ((t % 24000) + 24000) % 24000
      const w = host.shared.daylightWatch ?? (host.shared.daylightWatch = { lastTime: null, lastFixAt: 0, fixes: 0 })
      const moving = w.lastTime !== null && Math.abs(t - w.lastTime) > 40
      const night = day >= 12500 && day <= 23500
      w.lastTime = t
      if (!moving && !night) return
      host.log(`昼固定の監視: 時刻の変化を検知しました time=${t} dayTime=${day} cycleRunning=${moving} night=${night}`)
      if (Date.now() - w.lastFixAt < 300000) return
      w.lastFixAt = Date.now(); w.fixes++
      for (const command of ['/gamerule dodaylightcycle false', '/time set noon']) host.client.queue('command_request', { command, origin: { type: 'player', uuid: require('node:crypto').randomUUID(), request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' })
      host.log(`昼固定の監視: 昼固定を再設定しました（${w.fixes}回目）`)
    } catch { /* The next check retries. */ }
  }, 30000)
  daylightTimer.unref?.()
  let reachabilityTimer = null
  function refreshThreatReachability () {
    // The flood fill runs outside the caller's state read, one timer at once.
    if (reachabilityTimer || disposed || disposing) return
    reachabilityTimer = setTimeout(() => {
      reachabilityTimer = null
      try {
        if (disposed || disposing || raw().phase !== 'spawned') return
        threatReachability.refresh(working(), allActors(), { world: host.world })
      } catch { /* Unknown reachability keeps the normal threat policy. */ }
    }, 100)
    reachabilityTimer.unref?.()
  }
  const observedState = () => {
    const startedAt = performance.now()
    const state = working()
    const entities = annotateTerrainThreats(state, allActors(), { world: host.world, ownedEntities: true })
    refreshThreatReachability()
    if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
      host.shared.perfObservations ??= {}
      host.shared.perfObservations.observedStateMs = Math.max(host.shared.perfObservations.observedStateMs ?? 0, performance.now() - startedAt)
    }
    return { ...state, threatPolicy: host.shared.autoWanted ? 'online_learning' : 'balanced_mining', entities, removedEntities: host.entities.snapshotRemoved?.() ?? [], hostiles: entities.filter(entity => entity.hostile && entity.alive) }
  }
  // Left over from before ranged shots were recorded separately (see userBehaviors onUncertain).
  if (host.shared.inventoryUncertain?.operation === 'ranged_shot') host.shared.inventoryUncertain = null
  const onUncertain = details => { host.shared.inventoryUncertain = { ...details, at: new Date().toISOString() }; try { host.log(`持ち物が未確定になりました: ${JSON.stringify(details).slice(0, 200)} from=${String(new Error().stack).split('\n').slice(2, 5).map(s => s.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ').slice(0, 220)}`) } catch {} }
  function miningState () {
    const state = working()
    if (state.equipmentServerConfirmed === false) {
      state.selectedSlot = state.rawSelectedSlot
      state.heldItem = state.inventory.items.find(item => item.slot === state.rawSelectedSlot) ?? null
    }
    return state
  }
  const onInventory = packet => host.commitInventory(packet)
  const crafting = createCrafting({ client: host.client, getState: working, version: host.meta.version, onInventory, onUncertain, onContainerClose: packet => host.cache.observe('container_close', packet), allocateRequestId: () => host.allocate('craft') })
  readDurability = createDurabilityReader(host.meta.version)
  const inventoryInspection = createInventoryInspection({ crafting, armorStore: host.shared.armorStore ??= {}, getChest: () => chest, getState: raw, store: host.shared.inventoryInspectionStore ??= {}, version: host.meta.version })
  const UserCombatItem = require('prismarine-item')(`bedrock_${host.meta.version}`)
  const furnace = createFurnace({ client: host.client, getState: working, crafting, version: host.meta.version, allocateRequestId: () => host.allocate('craft'), onUncertain, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) } })
  const prospecting = createProspecting({ client: host.client, getState: working, world: host.world })
  const inventory = createInventory({ client: host.client, getState: working, crafting, allocateRequestId: () => host.allocate('craft'), commitSelection: typeof host.commitSelection === 'function' ? slot => host.commitSelection(slot) : null, selectionStore: host.shared.inventorySelection ??= {}, onUncertain, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) } })
  let armorTask = null
  let manualArmorOwner = null
  const armor = createArmor({ client: host.client, getState: working, crafting, allocateRequestId: () => host.allocate('craft'), store: host.shared.armorStore ??= {}, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) }, log: message => host.log(message) })
  function canEmergencyEatHere () {
    const state = observedState()
    const threats = evaluateThreats(state, state.entities, { observationRadius: 32 })
    if (threats.requiresObservation || host.entities.stats?.().unknownPositions > threats.unknownPositions.length) return false
    // snapshot() re-reads the current pose, shell, doors and ownership receipts;
    // a historical memo alone cannot prove that food use is covered now.
    const base = activeBase()?.snapshot()
    if (verifiedCoveredRoom({ ...state, shelter: base, idleProtection: safetySnapshot(), entityStats: host.entities.stats?.() }, threats)) return true
    return threats.threats.length === 0 && threats.outsideDanger.every(actor => actor.distance >= actor.dangerRadius + 8 || terrainOcclusionApplies(state, state.entities.find(entity => String(entity.runtimeId) === actor.runtimeId && entity.uniqueId != null && entity.entityType === actor.name && entity.dimension === state.dimension && entity.positionKnown === true)))
  }
  // An interrupted meal only leaves the food count in doubt (one item eaten
  // or not). Marking the whole inventory unknown disabled every attack in the
  // fight that interrupted it, so it is recorded on its own.
  const food = createFood({ client: host.client, getState: () => { const state = working(); return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: foodKnownLife() } } }, crafting, getInput: () => input, equip: (slot, options) => inventory.equipForFood(slot, options), allocateLegacyId: () => host.allocate('interaction'), canEmergencyEat: canEmergencyEatHere, onUncertain: details => { host.shared.foodUncertain = { ...details, at: new Date().toISOString() }; try { host.log(`食事の結果が未確認です（持ち物全体は不明扱いにしません）: ${String(details?.reason ?? '').slice(0, 80)}`) } catch {} }, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) } })
  const mining = createMining({ getState: () => ({ ...miningState(), lifecycle: { deathId: actualLifeId() } }), world: host.world, getInput: () => input, getRawItem: slot => crafting.rawItem(slot), isProtected: point => { const block = planningWorld.getBlock(point.x,point.y,point.z); return block?.protected === true || !!block?.protectionSource || (depotBuilder?.protectedCells() ?? []).some(p => p.x===point.x && p.y===point.y && p.z===point.z) }, verifyOwnedBed: (state, target, block) => userBehaviors?.ownsBedTarget(state, target, block) === true, verifyOwnedShulker: (state, target, block) => quarryPortableStorage?.ownsShulker(state, target, block) === true || manualShulkerRecovery?.ownsShulker(state, target, block) === true })
  const interactions = createInteractions({ client: host.client, getState: () => ({ ...working(), lifecycle: { deathId: actualLifeId() } }), world: host.world, crafting, getInput: () => input, version: host.meta.version, onInventory, onUncertain, allocateLegacyId: () => host.allocate('interaction') })

  function commitChestMainDelta (delta) {
    if (!delta || delta.source !== 'server_item_stack_response' || !Number.isInteger(delta.slot) || delta.slot < 0 || delta.slot >= 36 || !delta.item) throw new Error('Chest main-slot response is not an authoritative delta')
    crafting.applyPacket('inventory_slot', delta)
    const input = Array.from({ length: 36 }, (_, slot) => crafting.rawItem(slot))
    if (input.some(item => !item)) throw new Error('Chest response cannot reconcile an unknown inventory baseline')
    // This is the prior observed baseline plus ONE accepted server response.
    // It is not a newly received 36-slot refresh and never clears uncertainty.
    host.commitInventory({ window_id: 'inventory', input, changedSlots: [delta.slot], fullRefresh: false, source: delta.source, requestId: delta.requestId })
    host.shared.lastChestInventoryUpdate = { source: delta.source, requestId: delta.requestId, changedSlots: [delta.slot], fullRefresh: false, at: new Date().toISOString() }
  }
  const chest = createChest({ client: host.client, getState: () => { const state = working(); return { ...state, profile: state.profile ?? host.meta.profile, lifecycle: { ...(state.lifecycle ?? {}), deathId: foodKnownLife() } } }, world: host.world, crafting, interactions, version: host.meta.version, allocateRequestId: () => host.allocate('craft'), onUncertain, onInventory: commitChestMainDelta })
  const quarryV22Equipment = createQuarryV22Equipment({
    client: host.client,
    crafting,
    getState: () => ({ ...working(), lifecycle: { ...(working().lifecycle ?? {}), deathId: actualLifeId() } }),
    getView: () => inventoryInspection.snapshot(),
    getRawMain: slot => crafting.rawItem(slot),
    getRawEquipment: (kind, slot) => kind === 'armor' ? host.shared.armorStore?.worn?.get(slot) : kind === 'offhand' ? host.shared.inventoryInspectionStore?.offhand?.get(slot) : null,
    allocateRequestId: () => host.allocate('craft'),
    commitMain: (slot, item, requestId) => {
      const delta = { window_id: 'inventory', slot, item, source: 'server_item_stack_response', requestId }
      crafting.applyPacket('inventory_slot', delta)
      host.commitInventory({ window_id: 'inventory',
        input: Array.from({ length: 36 }, (_, i) => crafting.rawItem(i)),
        changedSlots: [slot], fullRefresh: false, source: 'server_item_stack_response', requestId })
    },
    commitEquipment: (kind, slot, item, requestId) => {
      const delta = { window_id: kind, slot, item, source: 'server_item_stack_response', requestId }
      if (kind === 'armor') armor.applyPacket('inventory_slot', delta)
      inventoryInspection.applyPacket('inventory_slot', delta)
    },
    onUncertain: onUncertain
  })
  portableActionOwners.track(inventory, ['equip', 'equipForMining', 'equipForCombat', 'equipForFood'], { invalidate: ['cancel'], isActive: c => c.snapshot().busy === true })
  portableActionOwners.track(interactions, ['placeBlock', 'placeQuarryBlock', 'placeBed', 'placeCraftingTable', 'useBed', 'openShulker', 'openChest', 'openFurnace', 'openWorkbench', 'openCraftingTable'], { invalidate: ['cancel'], isActive: c => c.snapshot().pendingOperation != null })
  portableActionOwners.track(chest, ['open', 'depositItem', 'depositDiamond', 'withdrawItem'], { invalidate: ['cancel'], isActive: c => c.snapshot().busy === true })
  portableActionOwners.track(mining, ['start', 'startAccessClearance'], { invalidate: ['stop'], isActive: c => c.snapshot().phase === 'mining' })

  async function executeSurfaceReturn (options = {}, context = {}) {
    if (disposed || disposing || !surfaceReturn || surfaceReturnOwner || userBehaviorOwns() || autonomy.snapshot().actionActive) throw new Error('地上への移動処理が使用中です。')
    const lease = { serial: ++surfaceReturnSequence, scope: returnScope(lightweightUserState()), operationId: null }
    surfaceReturnOwner = lease
    try {
      autonomy.stop('地上への帰路へ操作を引き継ぎます。')
      await autonomy.tick()
      await observeDepotSky(context.signal)
      const plan = await surfaceReturn.previewAsync(options)
      if (!plan.ready) return { phase: 'observing', busy: false, surfaceReached: false, code: plan.code, reason: plan.reason }
      if (lease.scope !== plan.scope) throw new Error('帰路の観測後に接続状態が変わりました。')
      await idleSafety?.stop('確認済みの帰路へ保護操作を引き継ぎます。')
      await idleSafety?.drain()
      requireIdle({ inventoryRequired: false })
      return await surfaceReturn.execute(options, { signal: context.signal })
    } finally { if (surfaceReturnOwner === lease) { surfaceReturnOwner = null; resumeSafety() } }
  }

  function foodHungerScope () {
    const state = raw(), deathId = foodKnownLife()
    if (!Number.isSafeInteger(deathId) || deathId < 0) return null
    return { profile: state.profile ?? host.meta.profile, realmId: state.realm?.id == null ? null : String(state.realm.id), connectionId: state.connectionId, startedAt: state.startedAt, dimension: state.dimension, runtimeEntityId: state.runtimeEntityId == null ? null : String(state.runtimeEntityId), deathId }
  }
  function verifiedInitialLifeReceipt () {
    if (host.shared.deathRespawn != null || host.shared.inventoryLifeReceipt?.source !== 'host_status_get' || host.shared.inventoryLifeReceipt.deathId !== 0) return null
    const state = raw(), receipt = host.shared.inventoryLifeReceipt, key = inventoryLifeBaseKey(state), started = Date.parse(state.startedAt)
    if (host.shared.deathRespawn != null || host.shared.initialLifeDeathKey === key || receipt?.source !== 'host_status_get' || receipt.deathId !== 0 || receipt.key !== key || !Number.isFinite(receipt.observedAt) || !Number.isFinite(started) || started > receipt.observedAt || receipt.observedAt > Date.now() || host.shared.loadingScreenEnded !== true || host.shared.respawnTerrain?.pending || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= 0 || String(host.meta.startGame?.runtime_entity_id) !== String(state.runtimeEntityId)) return null
    return receipt
  }
  function foodKnownLife () { return Number.isSafeInteger(host.shared.deathRespawn?.deathId) && host.shared.deathRespawn.deathId >= 0 ? host.shared.deathRespawn.deathId : verifiedInitialLifeReceipt() ? 0 : null }
  function restoreFoodHungerBaseline () {
    if (typeof food.restoreHunger !== 'function') return null
    const observation = host.shared.vitals?.hunger
    if (!observation || host.shared.loadingScreenEnded !== true || host.shared.respawnTerrain?.pending) return null
    // Old Host-local values have no scope field. The own-entity receiver and
    // confirmed life timestamp bound them; new receipts retain explicit scope.
    const initial = verifiedInitialLifeReceipt()
    if (initial && typeof food.restoreInitialHunger === 'function') {
      const scope = foodHungerScope()
      const result = food.restoreInitialHunger({ ...structuredClone(observation), scope: observation.scope == null ? scope : structuredClone(observation.scope), evidence:'initial_life_baseline', noDeathObserved:true, initialLife:{ ...structuredClone(initial), scope } })
      const attributeAt = Date.parse(observation.observedAt)
      if (result?.reason === 'initial_observation_invalid' && observation.source === 'server_attribute' && Number.isFinite(observation.value) && observation.value >= 0 && observation.value <= 20 && Number.isFinite(attributeAt) && attributeAt > initial.observedAt && attributeAt <= Date.now() && !foodBaselineRefreshTask) {
        // Refresh only the actual Host lifecycle receipt. This never requests
        // InventoryMismatch, invents respawn, or credits food consumption.
        try {
          const task = prepareInventoryLifeReceipt().then(() => restoreFoodHungerBaseline()).catch(error => { host.shared.foodBaselineRefreshError = String(error.message ?? error).slice(0,200) }).finally(() => { if (foodBaselineRefreshTask === task) foodBaselineRefreshTask = null })
          foodBaselineRefreshTask = task
        } catch { /* The normal idle tick retries after the shared read cooldown. */ }
      }
      return result
    }
    return food.restoreHunger({ ...structuredClone(observation), scope: Object.hasOwn(observation, 'scope') ? structuredClone(observation.scope) : foodHungerScope(), respawn: structuredClone(host.shared.deathRespawn ?? null) })
  }
  function motionState () {
    const latest = { ...raw(), threatPolicy: host.shared.autoWanted ? 'online_learning' : 'balanced_mining', vitals: structuredClone(host.shared.vitals ?? {}) }
    if (!motionOrigin) return latest
    return { ...latest, position: { ...motionOrigin.position }, positionUpdatedAt: motionOrigin.positionUpdatedAt, positionSource: motionOrigin.positionSource, predicted: motionOrigin.predicted ? structuredClone(motionOrigin.predicted) : null }
  }
  function motionActive () {
    return walker?.snapshot().phase === 'walking' || ['moving', 'settling'].includes(movement?.snapshot().phase)
  }
  function stopIdleStream () {
    if (inputOwner !== 'idle') return
    inputStream?.stop()
    inputOwner = 'none'
  }
  function neutralFrame ({ state, rotation }) {
    const previous = idlePhysicsState && idlePhysics.toServerPosition(idlePhysicsState)
    const drift = previous ? Math.hypot(previous.x - state.position.x, previous.y - state.position.y, previous.z - state.position.z) : Infinity
    const serverStamp = state.rawServerPositionUpdatedAt ?? state.positionUpdatedAt
    if (!idlePhysicsState || drift > 0.025 || idleStamp !== serverStamp) idlePhysicsState = idlePhysics.fromServer(state)
    idleStamp = serverStamp
    // An idle model may retain a tiny wall penetration from replaying an
    // input at float32 contact. Repair only the wall normal witnessed by the
    // unchanged raw observation; tangential progress and raw timestamps stay.
    if (inputOwner === 'idle' && !ownedCall && !pendingStops.size && !motionActive() && idlePhysicsState.onGround === true && !idlePhysicsState.isInWater && !idlePhysicsState.isInLava && Math.hypot(idlePhysicsState.velocity.x, idlePhysicsState.velocity.z) < 0.006 && idlePhysicsState.velocity.y <= 0.05 && idlePhysicsState.velocity.y >= -0.12) {
      try {
        idleOriginNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: idlePhysics })
        if (!idleOriginNavigator.verifyOrigin(idlePhysicsState) && !autonomy.snapshot().busy && !idleSafety?.snapshot().busy && !guardRoute?.snapshot().busy && !excavation?.snapshot().busy && !tunneling?.snapshot().busy && !recovery?.snapshot().busy && !(foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) && !shelter?.snapshot().busy && !hut?.snapshot().busy && !combat?.snapshot().busy && !combat?.snapshot().defending && !combat?.snapshot().engaging && !food.snapshot().busy && !(furnace.snapshot().busy || chest.snapshot().busy) && !inventory.snapshot().busy && craftStatus().pendingRequestId == null && !interactions.snapshot().pendingOperation) {
          const observed = raw()
          const sameScope = ['profile', 'startedAt', 'connectionId', 'runtimeEntityId', 'dimension'].every(key => observed[key] != null && observed[key] === state[key]) && observed.realm?.id != null && String(observed.realm.id) === String(state.realm?.id)
          const sameRawPose = observed.position && state.rawServerPosition && ['x', 'y', 'z'].every(axis => Number.isFinite(observed.position[axis]) && observed.position[axis] === state.rawServerPosition[axis])
          if (sameScope && sameRawPose && observed.phase === 'spawned' && !observed.dead && observed.health === state.health && observed.positionUpdatedAt != null && observed.positionUpdatedAt === state.rawServerPositionUpdatedAt) {
            const received = idlePhysics.fromServer(observed)
            if (idleOriginNavigator.verifyOrigin(received)) {
              const repaired = idlePhysics.repairHorizontalContact?.(idlePhysicsState, received, { maxNormalAdjustment: 0.05, maxDistance: 0.75 })
              if (repaired && idleOriginNavigator.verifyOrigin(repaired.physicsState)) {
                inputHistory?.invalidate('idle_contact_repair')
                idlePhysicsState = { ...repaired.physicsState, originReconciliation: { source: 'known_authoritative_wall_contact', adjustment: repaired.adjustment, rawPositionUpdatedAt: observed.positionUpdatedAt, serverConfirmed: false } }
                motionOrigin = null
              }
            }
          }
        }
      } catch { /* A failed model proof cannot alter a received observation. */ }
    }
    const surface = idlePhysics.waterSurface(idlePhysicsState.position)
    // A player standing on the edge of a bank can have water below part of
    // the footprint. A nearby surface alone is not water contact: jumping
    // from that dry edge repeatedly destabilizes recovery and safety checks.
    const feetInSurfaceWater = surface && idlePhysicsState.position.y < surface.surfaceY - 0.05
    // Native water contact remains valid when the submerged feet touch bottom;
    // waterSurface intentionally rejects a head that is still underwater.
    const floating = idlePhysicsState.isInWater || !!feetInSurfaceWater
    const wasJumping = idlePhysicsState.controls?.jump === true
    idlePhysicsState = idlePhysics.step({ ...idlePhysicsState, yaw: rotation.yaw, pitch: rotation.pitch }, { jump: !!floating })
    const position = idlePhysics.toServerPosition(idlePhysicsState)
    const predictedState = structuredClone(idlePhysicsState)
    return { position, delta: predictedState.velocity, physicsState: predictedState, predictedState, controls: { jump: !!floating }, inputFlags: floating ? ['jumping', 'want_up', ...(!wasJumping ? ['start_jumping'] : [])] : [], commitPrediction: () => publishControlPrediction({ position, feetPosition: predictedState.position, velocity: predictedState.velocity, onGround: predictedState.onGround, physicsState: predictedState, source: 'client_prediction', serverConfirmed: false }, 'idle_physics') }
  }
  function maintainIdle () {
    if (disposed || disposing || !inputStream || !host.shared.loadingScreenEnded || host.shared.respawnTerrain?.pending) return
    if (userBehaviorSleeping || userBehaviorWakePending || userBehaviorSnapshot().sleeping) { stopOrdinaryUserStream(); return }
    publishWalker()
    const state = working()
    resumeSafety()
    if (state.phase !== 'spawned' || state.dead || state.spawnPending || state.health <= 0) { inputStream.stop(); inputOwner = 'none'; return }
    maybeResyncInventory()
    maybeEquipArmor()
    if (food.snapshot().hunger == null && !food.snapshot().busy) restoreFoodHungerBaseline()
    if (motionActive()) { stopIdleStream(); return }
    if (chunkMoveHeld() && !userBehaviorOwns()) { stopIdleStream(); return }
    if (inputOwner === 'task') return
    if (!inputStream.stats().running && Date.now() - idleFailureAt > 1000) {
      try { inputOwner = 'idle'; inputStream.start(); host.shared.idleError = null } catch (error) { inputOwner = 'none'; idleFailureAt = Date.now(); host.shared.idleError = error.message }
    }
  }
  function startIdle () {
    if (disposed || disposing) return
    if (!idleTimer) idleTimer = setInterval(maintainIdle, 50)
    maintainIdle()
  }
  function guardRouteSnapshot () {
    if (!guardRoute) return null
    return { ...guardRoute.snapshot(), lastReached: structuredClone(guardRouteProgress?.lastReached ?? null), lastProgress: structuredClone(guardRouteProgress) }
  }
  function safetySnapshot () {
    const effective = { ...(idleSafety?.snapshot() ?? { running: false, busy: false, active: null, phase: 'waiting_spawn' }), wanted: host.shared.safetyWanted === true, enableEpoch: host.shared.safetyEnableEpoch, lastManualActionAt: host.shared.safetyManualActionAt ?? null, emergency: structuredClone(host.shared.safetyEmergency ?? null), respawnTerrain: structuredClone(host.shared.respawnTerrain ?? null) }
    return userBehaviorOwns() ? { ...effective, requestedSafetyWanted: effective.wanted, wanted: true, running: true, busy: true, active: userBehaviorSnapshot().activeKind ?? 'user_behavior', phase: 'user_behavior', userBehaviorOwned: true } : effective
  }
  function resumeSafety () {
    if (resetHeld() || manualChestStorage?.isBusy() || chunkMoveHeld()) return safetySnapshot()
    if (surfaceReturnOwner || userBehaviorOwns()) return safetySnapshot()
    if (disposed || disposing || host.shared.respawnTerrain?.pending || !host.shared.safetyWanted || !idleSafety || idleSafety.snapshot().running || idleSafety.snapshot().busy) return safetySnapshot()
    idleSafety.start({ enableEpoch: host.shared.safetyEnableEpoch, ...(host.shared.safetyRecoveryDeadline ? { recoveryDeadline: host.shared.safetyRecoveryDeadline } : {}) })
    return safetySnapshot()
  }
  function requireIdle ({ inventoryRequired = true, armorOwner = null, loadoutHandoff = false, loadoutOwner = null, storageHandoff = false, chunkMoveHandoff = false } = {}) {
    const behavior = userBehaviorSnapshot()
    const combatHandoff = loadoutHandoff && (userBehaviorLease?.kind === 'combat' || behavior.claim?.kind === 'combat' || combat?.snapshot().busy || combat?.snapshot().defending || combat?.snapshot().engaging)
    if (resetHeld() && (loadoutOwner === null || loadoutOwner !== loadoutLease)) throw Object.assign(new Error('初期アイテムのリセット処理中です。'), { code: 'RESET_BUSY' })
    if (!ownedCall && !storageHandoff && manualChestStorage?.isBusy()) throw Object.assign(new Error('ラージチェストへの収納操作中です。'), { code: 'STORAGE_BUSY' })
    if (chunkMoveHeld() && !chunkMoveHandoff && chunkMoveDepth === 0 && !(ownedCall && userBehaviorLease?.kind === 'combat')) throw Object.assign(new Error('Botの移動が終わるまで待ってください。'), { code: 'CHUNK_MOVE_BUSY' })
    if (!ownedCall && manualShulkerTask) throw new Error('指定したシュルカーボックスの回収完了を待ってください。')
    if (manualArmorOwner && manualArmorOwner !== armorOwner) throw new Error('手動の防具装備が完了するまで待ってください。')
    if (disposed || disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
    if (host.shared.respawnTerrain?.pending) throw new Error('リスポーン先の地形と前の操作の終了を確認しています。')
    if (working().spawnPending) throw new Error('参加位置をサーバーで確認するまで行動を待機します。')
    if (inventoryRequired && host.shared.inventoryUncertain) throw new Error('操作後の持ち物が未確定です。新しいサーバー情報を待っています。')
    if (!ownedCall && userBehaviorOwns() && !(combatHandoff && !userBehaviorSleeping && !userBehaviorWakePending && !behavior.sleeping)) throw new Error('利用者指定の戦闘・睡眠・片付け動作が操作を使用中です。')
    if (!ownedCall && pendingStops.size) throw new Error('前の操作の終了処理を待ってください。')
    if (!ownedCall && quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。/quarry pause で一時停止してから操作してください。')
    if (!ownedCall && quarryPillar?.snapshot().busy) throw new Error('土柱の設置と着地の確認を待ってください。')
    if (!ownedCall && (idleSafety?.snapshot().busy && !combatHandoff || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || (foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) || shelter?.snapshot().busy || hut?.snapshot().busy || guardRoute?.snapshot().busy)) throw new Error('前の操作が終わるまで待ってください。')
    if (!combatHandoff && (motionActive() || input?.stats().running || combat?.snapshot().busy || combat?.snapshot().defending || combat?.snapshot().engaging) || food.snapshot().busy || (furnace.snapshot().busy || chest.snapshot().busy) || inventory.snapshot().busy || craftStatus().pendingRequestId != null || interactions.snapshot().pendingOperation) throw new Error('前の操作が完了するまで待ってください。')
    if (!ownedCall) host.shared.safetyManualActionAt = Date.now()
  }
  function inventoryLifeBaseKey (state) { return JSON.stringify([state.profile ?? host.meta.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId ?? ''), state.dimension ?? null]) }
  function prepareInventoryLifeReceipt () {
    if (!inventoryLifeReceiptTask) {
      if (Number.isFinite(host.shared.inventoryLifeReceiptRetryAt) && Date.now() < host.shared.inventoryLifeReceiptRetryAt) throw Object.assign(new Error('Host lifecycle receipt is not ready'), { code: 'RESYNC_SCOPE_UNKNOWN' })
      const expected = inventoryLifeBaseKey(raw())
      host.shared.inventoryLifeReceiptRetryAt = Date.now()+2000
      const task = http('GET', '/status', undefined, { signal: AbortSignal.timeout(1000) }).then(response => {
        const current = raw(), life = response?.lifecycle
        if (disposed || disposing || replaying || host.client !== inventoryResyncClient || expected !== inventoryLifeBaseKey(current) || expected !== inventoryLifeBaseKey(response ?? {}) || typeof response?.profile !== 'string' || !response.profile || response?.phase !== 'spawned' || response.dead || response.isDead || response.spawnPending || life?.dead || life?.phase !== 'alive' || !Number.isSafeInteger(life.deathId) || life.deathId < 0 || response.health !== current.health || !(response.health > 0) || current.phase !== 'spawned' || current.dead || current.isDead || current.spawnPending || Number.isSafeInteger(host.shared.deathRespawn?.deathId) && host.shared.deathRespawn.deathId !== life.deathId) throw Object.assign(new Error('Actual Host lifecycle receipt does not match current resync scope'), { code: 'RESYNC_SCOPE_UNKNOWN' })
        host.shared.inventoryLifeReceipt = { source: 'host_status_get', key: expected, deathId: life.deathId, health: current.health, observedAt: Date.now() }
        restoreFoodHungerBaseline()
      }).finally(() => { if (inventoryLifeReceiptTask === task) inventoryLifeReceiptTask = null })
      inventoryLifeReceiptTask = task
    }
    return inventoryLifeReceiptTask
  }
  function requestInventoryResyncWithReceipt (source = 'manual', options = {}) {
    try { return requestInventoryResync(source, options) } catch (error) { if (error.code !== 'RESYNC_SCOPE_UNKNOWN') throw error }
    inventoryResyncIdle(options)
    return prepareInventoryLifeReceipt().then(() => requestInventoryResync(source, options))
  }
  function inventoryResyncScope () {
    const state = raw()
    const receipt = host.shared.inventoryLifeReceipt
    const receiptCurrent = receipt?.source === 'host_status_get' && receipt.key === inventoryLifeBaseKey(state) && receipt.health === state.health && Date.now()-receipt.observedAt >= 0 && Date.now()-receipt.observedAt <= 2000
    const life = Number.isSafeInteger(host.shared.deathRespawn?.deathId) ? host.shared.deathRespawn.deathId : receiptCurrent ? receipt.deathId : null
    const profile = state.profile ?? host.meta.profile
    if (disposed || disposing || replaying || host.client !== inventoryResyncClient || typeof host.client?.queue !== 'function') throw Object.assign(new Error('現在の接続で再同期できる状態ではありません。'), { code: 'RESYNC_NOT_READY' })
    if (host.meta.version !== '1.26.60' || !host.meta.startGame || String(host.meta.startGame.runtime_entity_id) !== String(state.runtimeEntityId) || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || host.shared.respawnTerrain?.pending || host.shared.loadingScreenEnded !== true || !Number.isFinite(state.health) || state.health <= 0 || !['survival', 0].includes(state.gameMode)) throw Object.assign(new Error('生存中の現在の参加状態を確認してから再同期します。'), { code: 'RESYNC_NOT_READY' })
    if (typeof profile !== 'string' || !profile || state.realm?.id == null || !['overworld', 'nether', 'end'].includes(state.dimension) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !/^\d+$/.test(String(state.runtimeEntityId)) || !Number.isSafeInteger(life) || life < 0) throw Object.assign(new Error('再同期に必要な接続と生存回数の情報が未確認です。'), { code: 'RESYNC_SCOPE_UNKNOWN' })
    return { profile, realmId: String(state.realm.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), deathId: life }
  }
  function inventoryResyncIdle ({ combatLease = null } = {}) {
    // Only the current combat owner waiting for real receipts may refresh
    // without releasing defense. No weapon/movement or mutation may be active.
    if (combatLease) {
      if (combatLease !== userBehaviorLease || combatLease.kind !== 'combat' || !combatLease.ready || combatLease.receiptsReady !== false) throw Object.assign(new Error('戦闘の持ち物確認は現在の操作権に限ります。'), { code: 'RESYNC_COMBAT_OWNER_CHANGED' })
      if (ownedCall || pendingStops.size || inputOwner === 'task' || motionActive() || input?.stats().running || inventory.snapshot().busy || mining.snapshot().phase === 'mining' || food.snapshot().busy || food.snapshot().pendingRequestId != null || furnace.snapshot().busy || chest.snapshot().busy || craftStatus().pendingRequestId != null || interactions.snapshot().pendingOperation || combat?.snapshot().busy || combat?.snapshot().engaging) throw Object.assign(new Error('戦闘の入力と送信済み操作が終了するまで持ち物の実受信を待ちます。'), { code: 'BUSY' })
      return
    }
    const behavior = userBehaviorSnapshot()
    if (ownedCall || pendingStops.size || userBehaviorOwns() || userBehaviorTickTask || behavior.cleanupUnconfirmed || inputOwner === 'task' || motionActive() || input?.stats().running || autonomy.snapshot().actionActive || idleSafety?.snapshot().busy || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || (foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) || shelter?.snapshot().busy || hut?.snapshot().busy || guardRoute?.snapshot().busy || mining.snapshot().phase === 'mining' || walker?.snapshot().phase === 'walking' || food.snapshot().busy || food.snapshot().pendingRequestId != null || inventory.snapshot().busy || (furnace.snapshot().busy || chest.snapshot().busy) || furnace.snapshot().waitingOutput || interactions.snapshot().pendingOperation || combat?.snapshot().busy || combat?.snapshot().defending || combat?.snapshot().engaging || host.shared.equipment != null || craftStatus().pendingRequestId != null) throw Object.assign(new Error('現在の操作が完了してから持ち物を再同期します。'), { code: 'BUSY' })
  }
  function inventoryResyncSuccessKey (ledger, scopeKey) {
    const r = ledger?.lastRequest
    const requested = Date.parse(r?.requestedAt), observed = Date.parse(r?.observedAt)
    if (r?.status !== 'FRESH_MAIN_OBSERVED' || r.freshMainObserved !== true || r.requestSent !== true || JSON.stringify(r.scope) !== scopeKey || !Number.isFinite(requested) || !Number.isFinite(observed) || observed < requested || !Number.isSafeInteger(r.fullCountAtSend) || !Number.isSafeInteger(ledger.actualFullCount) || ledger.actualFullCount <= r.fullCountAtSend) return null
    return JSON.stringify([scopeKey, r.requestedAt, r.fullCountAtSend])
  }
  function requestInventoryResync (source = 'manual', options = {}) {
    const scope = inventoryResyncScope()
    inventoryResyncIdle(options)
    const key = JSON.stringify(scope), lifeKey = JSON.stringify([scope.profile, scope.realmId, scope.connectionId, scope.startedAt, scope.deathId]), now = Date.now(), prior = host.shared.inventoryResync
    if (Number.isFinite(prior?.lastRequestedAt) && now - prior.lastRequestedAt < 20000) throw Object.assign(new Error('前の再同期要求から20秒待ってください。'), { code: 'RESYNC_RATE_LIMIT' })
    const sameLife = prior?.lifeKey === lifeKey
    let count = sameLife && Number.isSafeInteger(prior.count) ? prior.count : 0
    let retryWindowStartedAt = sameLife && Number.isFinite(prior.retryWindowStartedAt) ? prior.retryWindowStartedAt : sameLife && Number.isFinite(prior.lastRequestedAt) ? prior.lastRequestedAt : now
    let lastSuccessResetKey = sameLife ? prior.lastSuccessResetKey ?? null : null
    // Older runtimes counted even proven successful refreshes for the whole
    // life. Normalize one such receipt once, without reusing it after failures.
    const successKey = sameLife ? inventoryResyncSuccessKey(prior, key) : null
    if (successKey && successKey !== lastSuccessResetKey) { count = 0; retryWindowStartedAt = now; lastSuccessResetKey = successKey }
    if (count > 0 && now - retryWindowStartedAt >= 120000) { count = 0; retryWindowStartedAt = now }
    if (count >= 3) throw Object.assign(new Error('再同期が連続3回未確認のため、2分間の再試行枠が空くまで待ってください。'), { code: 'RESYNC_LIFE_LIMIT' })
    if (count === 0) retryWindowStartedAt = now
    const actualFullCount = Number.isSafeInteger(prior?.actualFullCount) ? prior.actualFullCount : 0
    const request = { status: 'REQUEST_SENT', source, requestedAt: new Date(now).toISOString(), scope, attempt: count + 1, requestSent: true, serverConfirmed: false, freshMainObserved: false, fullCountAtSend: actualFullCount }
    host.shared.inventoryResync = { scopeKey: key, lifeKey, count: count + 1, retryWindowStartedAt, lastSuccessResetKey, lastRequestedAt: now, actualFullCount, lastRequest: structuredClone(request) }
    try {
      // Vanilla BDS1.26.60.6 returned a fresh full main inventory for this
      // exact five-byte request without changing real counts or stack IDs.
      // It carries no predicted item/slot contents and never clears flags here.
      inventoryResyncClient.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0, legacy_transactions: null }, transaction_type: 'inventory_mismatch', actions: [], transaction_data: null } })
    } catch (error) {
      host.shared.inventoryResync.lastRequest = { ...request, status: 'QUEUE_FAILED', requestSent: false, error: String(error.message ?? error).slice(0, 160) }
      throw error
    }
    return structuredClone(request)
  }
  // Wear better owned armor while nothing hostile is close (out of combat).
  function nearestHostileDistance () {
    const s = raw(); if (!s.position) return Infinity
    let best = Infinity
    for (const e of host.entities.snapshot({ kind: 'all' })) if (e.hostile === true && e.alive !== false && e.position) best = Math.min(best, Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y, e.position.z - s.position.z))
    return best
  }
  function armorWorkFree () { return !userBehaviorOwns() && !inventory.snapshot().busy && !craftStatus().openContainer && craftStatus().pendingRequestId == null }
  function equipManualArmor () {
    requireIdle()
    if (armorTask || manualArmorOwner) throw new Error('防具の持ち替えが進行中です。')
    const finitePosition = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
    const owner = {}, scope = userScope(working())
    manualArmorOwner = owner
    async function run () {
      const moves = []
      for (let i = 0; i < 4; i++) {
        requireIdle({ armorOwner: owner })
        const state = working(), worn = host.shared.armorStore.worn
        if (userScope(state) !== scope || state.phase !== 'spawned' || state.dead || !(state.health > 0) || !finitePosition(state.position)) throw new Error('防具の持ち替え中に生存状態または接続範囲が変わりました。')
        if (!armorWorkFree() || craftStatus().authority !== true || craftStatus().inventoryKnown !== true || state.inventory?.known !== true) throw new Error('確定した持ち物と閉じたインベントリ画面が必要です。')
        if (!armor.snapshot().known || ![0, 1, 2, 3].every(slot => Number.isInteger(worn.get(slot)?.network_id))) throw new Error('サーバーから防具4枠の受信を待ってください。')
        const unsafe = host.entities.snapshot({ kind: 'all' }).some(actor => actor.hostile === true && actor.alive !== false && (!finitePosition(actor.position) || Math.hypot(actor.position.x - state.position.x, actor.position.y - state.position.y, actor.position.z - state.position.z) < 8))
        if (unsafe) throw new Error('防具の持ち替えには敵から8m以上離れた安全な場所が必要です。')
        const next = armor.preview()
        if (!next) break
        const before = crafting.rawItem(next.sourceSlot)
        const [receipt] = await armor.equipBest({ maxMoves: 1 })
        const after = worn.get(next.armorSlot)
        const current = working()
        const confirmed = userScope(current) === scope && current.phase === 'spawned' && !current.dead && current.health > 0 && armor.snapshot().known && receipt?.serverConfirmed === true && receipt.sourceSlot === next.sourceSlot &&
          receipt.armorSlot === next.armorSlot && after?.network_id === before?.network_id && after.count === 1 && after.has_stack_id === true &&
          Number.isInteger(after.stack_id) && after.stack_id > 0 && after.metadata === before.metadata && isDeepStrictEqual(after.extra, before.extra)
        if (!confirmed) return { phase: 'blocked', serverConfirmed: false, reason: receipt?.reason ?? 'ARMOR_SLOT_UNCONFIRMED', moves, worn: armor.snapshot().worn }
        moves.push(receipt)
      }
      return { phase: moves.length ? 'completed' : 'unchanged', serverConfirmed: moves.length > 0, moves, worn: armor.snapshot().worn }
    }
    const task = Promise.resolve().then(run)
    armorTask = task
    return task.finally(() => {
      if (armorTask === task) armorTask = null
      if (manualArmorOwner === owner) manualArmorOwner = null
    })
  }
  function maybeEquipArmor () {
    if (resetHeld() || manualChestStorage?.isBusy() || chunkMoveHeld() || quarryPlacementPreparation || host.shared.quarrySurfaceStorageOwner || !(host.shared.autoWanted === true || quarryCombatArmed) || armorTask || Date.now() - (host.shared.armorCheckedAt ?? 0) < 3000) return
    host.shared.armorCheckedAt = Date.now()
    try { if (!armor.preview() || !armorWorkFree() || nearestHostileDistance() < 8) return } catch { return }
    armorTask = armor.equipBest().catch(() => {}).finally(() => { armorTask = null })
  }
  function maybeResyncInventory () {
    if (quarryPlacementPreparation) return
    if (resetHeld() || !(defenseEnabled(host.shared) || host.shared.autoWanted === true || quarryCombatArmed) || !host.shared.inventoryUncertain) return
    const stamp = host.shared.inventoryUncertain.at
    const since = typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN
    const now = Date.now(), prior = host.shared.inventoryResync
    if (!Number.isFinite(since) || now - since < 500 || Number.isFinite(prior?.lastRequestedAt) && now - prior.lastRequestedAt < 6000) return // an unknown inventory disables every attack: resync fast
    try {
      const result = requestInventoryResyncWithReceipt('automatic')
      if (result && typeof result.then === 'function') void result.catch(() => {})
    } catch { /* Busy, incomplete scopes and exhausted bounds never cancel an owner or reset authority. */ }
  }
  function observeInventoryResync (packet) {
    const ledger = host.shared.inventoryResync
    if (!ledger || !Array.isArray(packet.input) || packet.input.length !== 36) return
    ledger.actualFullCount = (Number.isSafeInteger(ledger.actualFullCount) ? ledger.actualFullCount : 0) + 1
    const request = ledger.lastRequest
    if (request?.status !== 'REQUEST_SENT' || ledger.actualFullCount <= request.fullCountAtSend) return
    try {
      let currentScope
      try { currentScope = inventoryResyncScope() } catch (error) {
        if (error.code !== 'RESYNC_SCOPE_UNKNOWN' || !verifiedInitialLifeReceipt()) throw error
        const state = raw(); currentScope = { profile:state.profile ?? host.meta.profile, realmId:String(state.realm.id), dimension:state.dimension, connectionId:state.connectionId, startedAt:state.startedAt, runtimeEntityId:String(state.runtimeEntityId), deathId:0 }
      }
      if (JSON.stringify(currentScope) !== JSON.stringify(request.scope)) return
      ledger.lastRequest = { ...request, status: 'FRESH_MAIN_OBSERVED', freshMainObserved: true, observedAt: new Date().toISOString() }
      const successKey = inventoryResyncSuccessKey(ledger, JSON.stringify(currentScope))
      if (successKey && successKey !== ledger.lastSuccessResetKey) { ledger.count = 0; ledger.retryWindowStartedAt = null; ledger.lastSuccessResetKey = successKey }
    } catch { /* A late or different-life baseline cannot confirm this request. */ }
  }
  function publishWalker () {
    const state = walker?.snapshot()
    if (state?.sent > 0 && state.predictedPosition && ['walking', 'awaiting_server_confirmation'].includes(state.phase) && host.shared.motionSource === 'flat_walk') {
      inputHistory?.invalidate('unmodeled_flat_walk')
      publishControlPrediction({ position: state.predictedPosition, source: 'client_prediction', serverConfirmed: false }, 'flat_walk')
    }
  }
  function getSnapshot () {
    publishWalker()
    const state = observedState()
    const prospect = prospecting.snapshot()
    const observedOres = prospect.phase === 'idle' ? host.shared.prospecting ?? prospect : prospect
    return { ownedCampBootstrap: structuredClone(host.shared.ownedCampBootstrap ?? null), workHold: host.shared.legacyWorkHoldLease ? {leaseId:host.shared.legacyWorkHoldLease.id,scope:host.shared.legacyWorkHoldLease.scope,expiresAt:host.shared.legacyWorkHoldLease.expiresAt} : null, recentDamageRetreat: structuredClone(host.shared.recentDamageRetreatDiagnostic ?? null), survivalWorkClearance: state.survivalWorkClearance === true, spawnRangedClearance: state.spawnRangedClearance === true, depotPrebuild: depotPrebuild?.snapshot() ?? null, depotMission: depotMission?.snapshot() ?? null, surfaceReturn: surfaceReturn?.snapshot() ?? null, inventoryResync: structuredClone(host.shared.inventoryResync?.lastRequest ?? null), movementCalibration: structuredClone(movementCalibration), learningShoreEscape: structuredClone(host.shared.learningShoreEscape ?? null), startupPriority: structuredClone(host.shared.startupPriority ?? null), userBehaviors: userBehaviorSnapshot(), lowHealthWater: host.shared.lowHealthWaterDiagnostic ? { ...structuredClone(host.shared.lowHealthWaterDiagnostic), timing: structuredClone(host.shared.lowHealthWaterTiming ?? null) } : null, clearance: structuredClone(host.shared.clearanceDiagnostic ?? null), safety: safetySnapshot(), guardRoute: guardRouteSnapshot(), boundedJumpSearch: structuredClone(boundedJumpSearch), queuedPrediction: inputHistory?.snapshot() ?? null, queuedWireClock: structuredClone(actualWireClock.snapshot()), missionMemory: missionJournal.snapshot(), hut: hut?.snapshot() ?? null, shelter: activeBase()?.snapshot() ?? null, shelterKind: activeBase() === hut ? "hut" : "soil_hill", dayCycleStopTime: host.meta.startGame?.day_cycle_stop_time ?? null, worldClocks: structuredClone(host.shared.worldClocks ?? {}), lastServerMotion: structuredClone(host.shared.lastServerMotion ?? null), lastServerCorrection: structuredClone(host.shared.lastServerCorrection ?? null), worldTime: structuredClone(host.shared.worldTime ?? null), threatPolicy: state.threatPolicy, foraging: foraging?.snapshot() ?? null, food: food.snapshot(), vitals: structuredClone(host.shared.vitals ?? {}), recovery: recovery?.snapshot() ?? null, excavation: excavation?.snapshot() ?? null, quarry: quarrySnapshot(), tunneling: tunneling?.snapshot() ?? null, heldItem: state.heldItem, runtimeVersion: RUNTIME_VERSION, inventory: state.inventory, inventoryDetails: inventoryInspection.snapshot(state), inventoryConfidence: { known: !host.shared.inventoryUncertain, unresolved: host.shared.inventoryUncertain ?? null }, stations: structuredClone(host.shared.stations ?? {}), stationCatalog: structuredClone(host.shared.stationCatalog ?? null), portableWorksite: structuredClone(host.shared.portableWorksiteMemo ?? null), prospecting: observedOres, furnace: furnace.snapshot(), chest: chest.snapshot(), entities: state.entities, hostiles: state.hostiles, input: input?.stats() ?? null, mining: mining.snapshot(), walking: walker?.snapshot() ?? null, movement: movement ? { ...movement.snapshot(), runtimeHandoff: structuredClone(host.shared.movementHandoffTiming ?? null) } : null, crafting: crafting.snapshot(), inventoryActions: inventory.snapshot(), interactions: interactions.snapshot(), combat: combat?.snapshot() ?? null, agent: autonomy.snapshot(), idle: { owner: inputOwner, enabled: idleTimer !== null, error: host.shared.idleError ?? null, lastFailure: structuredClone(host.shared.lastInputFailure ?? null) } }
  }
  const http = createHttpClient({ baseUrl: host.apiUrl })
  function runnerFoodWalkBody (body) {
    if (!body || typeof body!=='object' || body.options!=null&&(typeof body.options!=='object'||Array.isArray(body.options)) || Object.hasOwn(body.options??{},'sprint')) return body
    const state=working(), hunger=host.shared.vitals?.hunger, scope=foodHungerScope(), started=Date.parse(state.startedAt), at=Date.parse(hunger?.observedAt)
    if (!scope || Object.values(scope).some(v=>v==null||v==='') || state.phase!=='spawned' || state.dead || state.isDead || state.spawnPending || state.lifecycle?.dead || !(state.health>0) || hunger?.source!=='server_attribute' || !Number.isFinite(hunger.value) || hunger.value<0 || hunger.value>=18 || !Number.isFinite(started) || !Number.isFinite(at) || at<started || at>Date.now() || !Object.keys(scope).every(k=>hunger.scope?.[k]===scope[k])) return body
    const observed=crafting.snapshot()
    if (state.inventory?.known!==true || state.inventory.uncertain || state.inventory.source==='client_prediction' || state.inventory.serverConfirmed===false || host.shared.inventoryUncertain || !Array.isArray(state.inventory.items) || observed.authority!==true || observed.inventoryKnown!==true || !Array.isArray(observed.inventory)) return body
    if(state.inventory.items.some(i=>!Number.isInteger(i.slot)||i.slot<0||i.slot>=36||!Number.isInteger(i.count)||i.count<1||i.count>64)||new Set(state.inventory.items.map(i=>i.slot)).size!==state.inventory.items.length)return body
    for(let slot=0;slot<36;slot++) {
      const rawItem=crafting.rawItem(slot), item=state.inventory.items.find(i=>i.slot===slot), canonical=observed.inventory.find(i=>i.slot===slot)
      if(!rawItem || !Number.isInteger(rawItem.network_id) || !Number.isInteger(rawItem.count) || rawItem.count<0 || rawItem.network_id===0&&(rawItem.count!==0||item?.count>0||canonical?.count>0) || rawItem.network_id!==0&&(rawItem.count<1 || !item || !canonical || canonical.name!==item.name || canonical.count!==rawItem.count || canonical.stackId!==rawItem.stack_id || item.count!==rawItem.count || (item.networkId??item.network_id)!==rawItem.network_id || !Number.isInteger(rawItem.stack_id) || rawItem.stack_id<=0 || rawItem.has_stack_id!==true || item.stackId!=null&&item.stackId!==rawItem.stack_id || typeof item.name!=='string')) return body
    }
    if(state.inventory.items.some(i=>i.count>0&&(isSupportedFood(i.name,state)||i.name==='minecraft:rotten_flesh')))return body
    return {...body,options:{...(body.options??{}),sprint:false}}
  }
  function readExplorerSupportBlock (position, expected) {
    const current=lightweightRawState(), life=movementKnownLife(), dead=current.dead || current.isDead || current.health===0
    const actualScope=continuationScope({...current,lifecycle:{...current.lifecycle,deathId:life,dead,phase:!dead && current.phase==='spawned' && !current.spawnPending ? 'alive':'unknown'}}), expectedScope=continuationScope(expected)
    if(!actualScope || !expectedScope || JSON.stringify(actualScope)!==JSON.stringify(expectedScope) || current.health<expected.health || !position || !['x','y','z'].every(k=>Number.isSafeInteger(position[k]) && Math.abs(position[k])<=30000000))return {known:false,position}
    return planningWorld.getBlock(position.x,position.y,position.z)
  }
  const runner = createRunner({
    baseUrl: host.apiUrl,
    readSupportBlock:readExplorerSupportBlock,
    request: (method, pathname, body, options) => {
      if (method==='POST'&&(pathname==='/move/preview'||pathname==='/move/start')) body=runnerFoodWalkBody(body)
      if (method === 'GET' && pathname.startsWith('/blocks?') && typeof host.world.getArea === 'function') {
        if (options?.signal?.aborted) throw options.signal.reason ?? new Error('観測を中断しました。')
        const params = new URL(pathname, host.apiUrl).searchParams
        const center = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number(params.get(axis))]))
        return Promise.resolve({ blocks: planningWorld.getArea(center, Number(params.get('radius') ?? 0)) })
      }
      const lease = portableMovementLease
      if (lease && method === 'POST') {
        if (pathname === '/move/stop') return Promise.resolve(stopPortableMovement(lease, 'Portable Runner cleanup'))
        if (pathname === '/move/preview' || pathname === '/move/start') body = { ...body, options: { ...(body?.options ?? {}), _portableMovementLease: lease.id } }
        if (pathname === '/action' && body?.group === 'movement' && body.method === 'settle') throw portablePolicyError('tagged settle requires a fresh grounded observation')
      }
      return pathname === '/equipment/select'
        ? http('POST', '/action', { group: 'inventory', method: 'equip', args: [body.slot] }, options)
        : http(method, pathname, body, options)
    },
    verifyPosition: async () => {
      return { accepted: true, phase: 'predicted', serverConfirmed: false, verificationPending: true, state: working() }
    },
    onProgress: data => host.noteProgress(data)
  })
  const diamondActions = createDiamondActions({ request: runner.request, refreshState: runner.refreshState, getState: runner.getState, baseActions: runner.actions, onProgress: data => host.noteProgress(data), timeoutMs: 90000, validateStoneAccess: requireStoneAccess, tunnel: (decision, context) => {
    requireIdle()
    if (decision.resource !== 'stone') return tunneling.execute(decision, { signal: context.signal, maxSteps: 2, maxDigBlocks: 6 })
    const { proposal, frame } = requireStoneAccess(decision)
    const live = proposal.tunneling.preview(decision, STONE_ACCESS_BOUNDS)
    if (!stoneAccessFirstReady(live, frame)) throw Object.assign(new Error('石への最初の掘削または移動を現在の地形で確認できません。'), { code: 'STALE_OBSERVATION' })
    requireStoneAccess(decision)
    proposal.started = true
    return proposal.tunneling.execute(decision, { ...STONE_ACCESS_BOUNDS, signal: context.signal, maxSteps: 1, maxDigBlocks: 3 })
  } })
  async function executeShelterBatch (actor, options, context) {
    requireIdle()
    const current = actor?.snapshot()
    const checkReturn = base => {
      if (!base?.established) return
      const proof = baseReturnApproach(observedState(), base, host.entities.stats?.().unknownPositions)
      if (!proof.ready) throw baseSafetyError(proof.reason)
    }
    checkReturn(current)
    const materials = current?.closureMaterials
    if (materials?.missingDirt > 0 && materials.missingDirt <= 2 && current.structureIntact === true && current.geometryVerified === true) {
      const memo = actor.memo(); const state = observedState()
      if (!memo?.site || memo.pendingPlacement || memo.scope?.realmId == null || String(memo.scope.realmId) !== String(state.realm?.id) || memo.scope.dimension !== state.dimension || memo.ownerProfile != null && memo.ownerProfile !== state.profile || options.site && options.site.id !== memo.site.id) {
        const error = new Error('Door material gathering requires the current own base and received geometry.')
        error.code = 'SITE_SCOPE_CHANGED'; throw error
      }
      const excluded = new Map()
      const add = value => { const point = value?.position ?? value; if (point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis])) && Math.hypot(point.x - state.position.x, point.z - state.position.z) <= 8 && Math.abs(point.y - (state.position.y - 1.62)) <= 4) excluded.set(`${point.x},${point.y},${point.z}`, { x: point.x, y: point.y, z: point.z }) }
      for (const saved of [host.shared.hutMemo, host.shared.shelterMemo, memo]) {
        for (const receipt of saved?.placements ?? []) add(receipt.position)
        for (const values of Object.values(saved?.site?.preserved ?? {})) for (const point of values) add(point)
        for (const field of ['floor', 'walls', 'wallCells', 'roof', 'doorCells', 'footprint', 'buildCells', 'ownedBuildCells', 'temporaryPillar', 'tempCells']) for (const point of (Array.isArray(saved?.site?.[field]) ? saved.site[field] : saved?.site?.[field] ? [saved.site[field]] : [])) add(point)
      }
      for (const point of readCurrentTunnelFloors()) add(point)
      const gathered = await runner.actions.gather_dirt({ count: materials.missingDirt, site: structuredClone(memo.site), excludedPositions: [...excluded.values()] }, context)
      const refreshed = actor.snapshot().closureMaterials
      if (!refreshed || refreshed.missingDirt > 0) return { ...gathered, ok: true, phase: 'progress', partial: true, goalComplete: false, arrived: false, closureComplete: false, requiresObservation: true }
    }
    checkReturn(actor.snapshot())
    return actor.execute(options, { signal: context.signal })
  }
  function knownLearningLocalBody (state) {
    try {
      if (!idlePhysics || !planningWorld) return false
      const physical = idlePhysics.fromServer(state)
      if (physical.onGround !== true || physical.isInWater || physical.isInLava || physical.isInWeb || physical.flying || physical.riding) return false
      idleOriginNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: idlePhysics })
      return idleOriginNavigator.verifyOrigin(physical) === true
    } catch { return false }
  }
  function localLearningWork (state, threats = null, base = undefined) {
    if (resourceMinHealth(state) !== 0) return { eligible: false, bodyProof: null }
    threats ??= evaluateThreats(state, state.entities ?? state.hostiles ?? [], { observationRadius: 32 })
    base ??= activeBase()?.snapshot()
    if (base?.inside === true || threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length || threats.threats.length) return { eligible: false, bodyProof: null }
    const bodyProof = knownLearningLocalBody(state)
    return { eligible: bodyProof === true, bodyProof }
  }
  function readyNightSoilShelter (state, observations = {}) {
    if(disposed || disposing || logicalWorkHeld() || userBehaviorOwns() || pendingStops.size || state.threatPolicy!=='online_learning' || state.dimension!=='overworld' || !nutritionInventoryReady(state))return null
    const current=lightweightUserState(),knownLife=movementKnownLife(),receipt=host.shared.deathRespawn
    current.lifecycle={...current.lifecycle,deathId:knownLife}
    const scope=continuationScope(state),freshScope=continuationScope(current),at=Date.parse(receipt?.at),started=Date.parse(state.startedAt)
    if(!scope || !freshScope || JSON.stringify(scope)!==JSON.stringify(freshScope) || !Number.isSafeInteger(knownLife) || knownLife<3 || receipt?.deathId!==knownLife || receipt.connectionId!==state.connectionId || receipt.phase!=='confirmed' || receipt.serverConfirmed!==true || !Number.isFinite(at) || !Number.isFinite(started) || at<started || at>Date.now() || current.health<state.health || !nutritionInventoryReady(current))return null
    if([state,current].some(value=>value.inventory.items.some(item=>item.name==='minecraft:diamond' && item.count>0)))return null
    const clock=Object.values(host.shared.worldClocks ?? {}).find(value=>value.name==='minecraft:overworld' && value.source==='server_sync_world_clocks')
    if(!Number.isSafeInteger(clock?.time))return null
    const time=((clock.time%24000)+24000)%24000
    if(time>=200 && time<12000 || !localLearningWork(current).eligible)return null
    const preview=observations.shelter?.preview,memo=shelter?.memo?.()
    const minimal=plan=>plan?.ready===true && plan.type==='soil_hill_shelter' && plan.materials?.requiredForClosure?.name==='minecraft:dirt' && plan.materials.requiredForClosure.count===2 && plan.materials.requireActualInventory===true && Number.isSafeInteger(plan.materials.initialDigBlocks) && plan.materials.initialDigBlocks>=0 && plan.materials.initialDigBlocks<=4
    if(!minimal(preview) || !shelter || observations.capabilities?.build_shelter!==true || memo?.pendingPlacement || memo?.site && memo.site.id!==preview.id)return null
    const fresh=shelter.preview({site:preview.site ?? preview,radius:0})
    if(!minimal(fresh) || fresh.id!==preview.id || fresh.origin?.connectionId!==state.connectionId || fresh.origin.startedAt!==state.startedAt || String(fresh.origin.ownRuntimeEntityId)!==String(state.runtimeEntityId) || fresh.origin.dimension!==state.dimension)return null
    const final=lightweightUserState();final.lifecycle={...final.lifecycle,deathId:movementKnownLife()}
    if(JSON.stringify(continuationScope(final))!==JSON.stringify(scope) || final.health<current.health || Math.hypot(final.position.x-current.position.x,final.position.y-current.position.y,final.position.z-current.position.z)>.1 || !localLearningWork(final).eligible)return null
    return {type:'build_shelter',stage:'shelter',reason:'確認済みの夜間は、すでに検証された土の斜面の避難場所を先に閉じます。',plan:fresh,site:fresh.site ?? fresh,...(memo?{memo:structuredClone(memo)}:{}),requiresLivePreview:true,requiresServerBlocks:true,nightReadyShelter:true}
  }
  const nutritionInventoryReady = state => state.inventory?.known === true && !state.inventory.uncertain && state.inventory.serverConfirmed !== false && state.inventory.source !== 'client_prediction'
  const nutritionSword = (state, heldOnly = false) => {
    if (!nutritionInventoryReady(state)) return false
    const sword = item => item?.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)
    if (!heldOnly) return state.inventory.items.some(sword) || state.equipmentServerConfirmed !== false && sword(state.heldItem)
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const item = state.inventory.items.find(item => item.slot === slot && item.count === 1 && sword(item))
    return state.equipmentServerConfirmed !== false && Number.isInteger(slot) && slot >= 0 && slot <= 8 && !!item && state.heldItem?.name === item.name && state.heldItem?.count === 1 && (state.heldItem.slot == null || state.heldItem.slot === slot)
  }
  const nutritionWindow = () => {
    const clock = Object.values(host.shared.worldClocks ?? {}).find(clock => clock.name === 'minecraft:overworld')
    const time = Number.isSafeInteger(clock?.time) ? ((clock.time % 24000) + 24000) % 24000 : null
    return time == null ? null : time >= 200 && time < 11400 ? 'day' : time < 200 || time >= 12000 ? 'night' : null
  }
  const nutritionSourceAllowed = (state, preview, window) => preview?.ready === true && (window === 'day' || window === 'night' && (preview.kind === 'drop' || preview.kind === 'prey' && nutritionSword(state, true)))
  const nutritionTarget = preview => ({ kind: preview.kind, runtimeId: String(preview.target?.runtimeId), name: preview.target?.name })
  function checkNutritionDispatch (state, decision, { allowSwordEquip = false } = {}) {
    const scope = JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null])
    const threats = evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
    const window = nutritionWindow()
    const preview = foraging.preview()
    const target = nutritionTarget(preview)
    const pinned = decision.nutritionTarget
    const equipSource = allowSwordEquip && window === 'night' && preview.ready === true && preview.kind === 'prey' && nutritionSword(state)
    const unknownPositions = state.entityStats?.unknownPositions ?? host.entities.stats?.().unknownPositions
    if (!(state.health > resourceMinHealth(state)) || !nutritionInventoryReady(state) || threats.requiresObservation || unknownPositions > threats.unknownPositions.length || threats.threats.length || window == null || window !== (decision.nutritionWindow ?? 'day') || decision.nutritionScope !== scope || host.shared.nutritionTask?.scope !== scope || host.shared.nutritionTask?.phase !== 'seeking_food' || preview.code !== 'FOOD_ALREADY_AVAILABLE' && ((!nutritionSourceAllowed(state, preview, window) && !equipSource) || window === 'night' && (!pinned || pinned.kind !== target.kind || pinned.runtimeId !== target.runtimeId || pinned.name !== target.name))) {
      const error = new Error('食料調達前に、時間帯・装備・食料源・接続と周囲の安全を再確認します。'); error.code = 'STALE_OBSERVATION'; throw error
    }
    return { preview, window }
  }
  function portablePolicyError (reason) { return Object.assign(new Error('PORTABLE_REOBSERVE: ' + reason), { code: 'STALE_OBSERVATION', reasonCode: 'PORTABLE_REOBSERVE' }) }
  const samePortableTarget = (a, b) => a && b && ['x', 'y', 'z'].every(k => Number.isFinite(a[k]) && Number.isFinite(b[k]) && Math.abs(a[k] - b[k]) < 1e-6)
  function portableLightState () {
    const state = working(), life = host.shared.deathRespawn?.deathId
    return { ...state, entities: host.entities.snapshot({ kind: 'all' }), lifecycle: { ...(state.lifecycle ?? {}), deathId: Number.isSafeInteger(life) ? life : null } }
  }
  function portablePolicyCircles (lease, provided = []) {
    if (portableMovementLease !== lease || lease.closed || lease.closing || lease.signal.aborted || disposed || disposing || userBehaviorOwns()) throw portablePolicyError('movement owner changed')
    const state = portableLightState()
    if (supplyScope(state) !== lease.scope || state.threatPolicy !== lease.threatPolicy || state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !(state.health > resourceMinHealth(state)) || state.health < lease.health || state.inventory?.known !== true || state.inventory.uncertain) throw portablePolicyError('life, health or inventory changed')
    if (lease.siteId && host.shared.portableWorksiteMemo?.site?.id !== lease.siteId) throw portablePolicyError('worksite changed')
    const evaluated = evaluateThreats(state, state.entities, { observationRadius: 32 })
    if (evaluated.requiresObservation || evaluated.threats.length || (host.entities.stats?.().unknownPositions ?? 0) > evaluated.unknownPositions.length || !Array.isArray(provided) || provided.length > 64 || new Set(provided.map(c => c?.id)).size !== provided.length) throw portablePolicyError('current actor observations changed')
    const actors = [...new Map([...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].map(actor => [actor.runtimeId, actor])).values()]
    const extra = new Map(provided.map(circle => [circle.id, circle])), circles = [], unique = new Set()
    for (const actor of actors) {
      const entity = state.entities.find(e => String(e.runtimeId) === actor.runtimeId), previous = lease.identities.get(actor.runtimeId)
      if (!entity || entity.uniqueId == null || entity.alive !== true || entity.positionKnown !== true || entity.dimension !== state.dimension || entity.entityType !== actor.name || !actor.position || !['x', 'y', 'z'].every(k => Number.isFinite(actor.position[k])) || !Number.isFinite(actor.dangerRadius) || unique.has(String(entity.uniqueId)) || !previous && [...lease.identities].some(([oldId, old]) => oldId !== actor.runtimeId && old.uid === String(entity.uniqueId)) || previous && (previous.uid !== String(entity.uniqueId) || previous.name !== actor.name || previous.dimension !== entity.dimension)) throw portablePolicyError('actor identity is unknown or reused')
      unique.add(String(entity.uniqueId)); lease.identities.set(actor.runtimeId, { uid: String(entity.uniqueId), name: actor.name, dimension: entity.dimension })
      const option = extra.get(actor.runtimeId), retained = lease.minimums.get(actor.runtimeId)
      if (option && (!Number.isFinite(option.minDistance) || option.minDistance < 0 || option.minDistance > 64 || !Number.isFinite(option.padding ?? 0) || (option.padding ?? 0) < 0 || (option.padding ?? 0) > 0.5)) throw portablePolicyError('provided actor bounds are invalid')
      const minDistance = Math.max(actor.dangerRadius, option?.minDistance ?? 0, retained?.minDistance ?? 0), padding = Math.max(0.5, option?.padding ?? 0, retained?.padding ?? 0)
      lease.minimums.set(actor.runtimeId, { minDistance, padding }); extra.delete(actor.runtimeId)
      circles.push({ id: actor.runtimeId, position: { ...actor.position }, minDistance, padding })
    }
    if (extra.size || circles.length > 64) throw portablePolicyError('actor policy is incomplete or exceeds its existing bound')
    return { state, circles }
  }
  function stopPortableMovement (lease, reason) {
    if (portableMovementOwner !== lease.id) return { phase: 'ignored', serverConfirmed: false }
    portableMovementOwner = null
    return lease.movement?.stop(reason)
  }
  function yieldPortableMovement () {
    const lease = portableMovementLease
    if (!lease) return
    stopPortableMovement(lease, 'Portable movement yielded to another owner')
    lease.controller.abort(portablePolicyError('another movement owner took control'))
  }
  function portableMovementOptions (target, options = {}) {
    const id = options?._portableMovementLease
    if (id == null) return options
    const lease = portableMovementLease
    if (!lease || lease.id !== id || lease.kind === 'place' || !samePortableTarget(target, lease.target)) throw portablePolicyError('stale lease or unexpected movement target')
    const { state, circles } = portablePolicyCircles(lease, options.avoidance ?? [])
    const { _portableMovementLease, ...clean } = options
    const originalGuard = clean.beforeInput
    return { ...clean, avoidance: circles, allowWater: false, beforeInput: frame => {
      const fresh = portablePolicyCircles(lease)
      const to = frame?.packetPosition, feet = frame?.predictedState?.position
      if (!to || !feet || !['x', 'y', 'z'].every(k => Number.isFinite(to[k]) && Number.isFinite(feet[k])) || Math.hypot(to.x - feet.x, to.y - feet.y - 1.62, to.z - feet.z) > 1e-6) throw portablePolicyError('the next Native eye position is unknown or inconsistent')
      const from = fresh.state.position
      for (const circle of fresh.circles) {
        const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
        const t = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * delta.x + (circle.position.y - from.y) * delta.y + (circle.position.z - from.z) * delta.z) / length)) : 0
        const distance = Math.hypot(from.x + t * delta.x - circle.position.x, from.y + t * delta.y - circle.position.y, from.z + t * delta.z - circle.position.z)
        const originDistance = Math.hypot(from.x - circle.position.x, from.y - circle.position.y, from.z - circle.position.z), padded = circle.minDistance + circle.padding
        if (distance < (originDistance < padded ? Math.max(circle.minDistance, originDistance) : padded) - 1e-4) throw portablePolicyError('fresh actor circle intersects the next eye segment')
      }
      if (originalGuard) { const result = originalGuard(frame); if (result === false || result && typeof result.then === 'function') throw portablePolicyError('the existing synchronous frame guard rejected input') }
      return true
    } }
  }
  function tagPortableOwnedMove (target, options = {}) {
    const lease = portableMovementLease
    return lease?.kind === 'excavate' && recoveryMotionDepth === 0 ? { ...options, _portableMovementLease: lease.id } : options
  }
  async function withPortableMovementLease (decision, context, kind, execute, controllers = { excavation, interactions }) {
    if (portableMovementLease) throw portablePolicyError('another portable action is draining')
    const memo = host.shared.portableWorksiteMemo, site = memo?.site, state = portableGuard(decision.portableSiteId ? site : null)
    let target = kind === 'excavate' ? { x: decision.target.x + 0.5, y: decision.target.y, z: decision.target.z + 0.5 } : decision.target
    if (kind === 'move') {
      if (decision.portableSiteId) {
        const expected = nextPortableStep({ state, memo, world: planningWorld })
        if (site?.id !== decision.portableSiteId || expected.type !== 'move_to' || !samePortableTarget(expected.target, target)) throw portablePolicyError('the site move is no longer current')
      } else {
        if (site?.scope === supplyScope(state) || portableFallbackProposal?.scope !== supplyScope(state) || !samePortableTarget(portableFallbackProposal.target, target)) throw portablePolicyError('the fallback target is stale')
        const threats = evaluateThreats(state, state.entities, { observationRadius: 32 }), actors = [...new Map([...threats.outsideDanger, ...threats.suppressedByTerrain].map(a => [a.runtimeId, a])).values()]
        const freshTarget = portableFallbackStop({ state, world: planningWorld, preservedFloors: readCurrentTunnelFloors(), physics: idlePhysics, avoidance: actors.map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 })), inspected: host.shared.portableWorksiteSearch?.scope === supplyScope(state) ? host.shared.portableWorksiteSearch.inspectedOrigins : [] })
        if (!samePortableTarget(freshTarget, target)) throw portablePolicyError('the exact preserved fallback stop changed')
      }
    }
    const controller = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
    host.shared.portableMovementSequence = (host.shared.portableMovementSequence ?? 0) + 1
    const lease = { id: state.connectionId + ':' + host.shared.portableMovementSequence, controller, signal, scope: supplyScope(state), threatPolicy: state.threatPolicy, health: state.health, siteId: decision.portableSiteId ?? null, target, kind, closed: false, identities: new Map(), minimums: new Map(), movement, excavation: controllers.excavation, interactions: controllers.interactions, childStarted: false }
    const childStatus = (kind === 'excavate' ? lease.excavation : kind === 'place' ? lease.interactions : null)?.snapshot?.()
    if (childStatus?.busy || childStatus?.pendingOperation) throw portablePolicyError('the selected child controller is already owned')
    portableMovementLease = lease
    const cancel = () => { stopPortableMovement(lease, 'Portable movement aborted'); if (!lease.executing || !lease.childStarted) return; if (kind === 'excavate') void lease.excavation.stop('Portable excavation aborted'); if (kind === 'place') lease.interactions.cancel('Portable placement aborted') }
    signal.addEventListener('abort', cancel, { once: true })
    try { portablePolicyCircles(lease); lease.executing = true; return await execute(signal, kind === 'excavate' ? lease.excavation : lease.interactions, () => { lease.childStarted = true }) } finally {
      lease.executing = false; lease.closing = true
      const ownedMovement = lease.startedMovement === lease.movement && lease.startedSerial === portableMovementSerial, ownedSerial = portableMovementSerial
      stopPortableMovement(lease, 'Portable movement complete; drain before releasing policy')
      if (kind === 'excavate' && lease.childStarted) await lease.excavation.stop('Portable excavation complete')
      if (ownedMovement && portableMovementSerial === ownedSerial && typeof lease.movement?.drain === 'function') { try { await lease.movement.drain() } catch (error) { lease.closed = true; throw error } }
      lease.closed = true; signal.removeEventListener('abort', cancel)
      if (portableMovementLease === lease) portableMovementLease = null
    }
  }
  function portableState () {
    const state = observedState(), life = host.shared.deathRespawn?.deathId
    return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: Number.isSafeInteger(life) ? life : null } }
  }
  function portableGuard (site, baseline = null) {
    if (disposed || disposing) throw new Error('Portable worksite runtime changed')
    const state = portableState()
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > resourceMinHealth(state)) || state.inventory?.known !== true || state.inventory.uncertain || site && supplyScope(state) !== site.scope || baseline && state.health < baseline.health) throw Object.assign(new Error('地下作業前に生存・接続・持ち物を再確認します。'), { code: 'STALE_OBSERVATION' })
    if (site && !portableSiteValid(site, planningWorld)) throw Object.assign(new Error('地下作業場所の床・屋根・空間が変わりました。'), { code: 'STALE_OBSERVATION' })
    const threats = evaluateThreats(state, state.entities, { observationRadius: 32 })
    if (threats.requiresObservation || threats.threats.length || (host.entities.stats?.().unknownPositions ?? 0) > threats.unknownPositions.length) throw Object.assign(new Error('地下作業中に敵または位置不明のactorを確認しました。'), { code: 'NEARBY_THREAT' })
    return state
  }
  function observePortableWorksite (observed) {
    const state = observed.state, scope = supplyScope(state)
    if (!scope) return observed
    const kit = portableKit(state), rawIron = state.inventory.items.reduce((sum, i) => sum + (['minecraft:raw_iron', 'minecraft:iron_ore', 'minecraft:deepslate_iron_ore'].includes(i.name) ? i.count : 0), 0)
    let memo = host.shared.portableWorksiteMemo
    const result = { enabled: true, scope, kit, site: null, deployed: false, step: null }
    if (memo?.site?.scope !== scope) memo = null
    if (rawIron >= 3 && kit.ready && !memo && idlePhysics) {
      try {
        const fresh = portableGuard(null)
        if (supplyScope(fresh) === scope && Math.hypot(fresh.position.x - state.position.x, fresh.position.y - state.position.y, fresh.position.z - state.position.z) < 0.1) {
          const threats = evaluateThreats(fresh, fresh.entities, { observationRadius: 32 })
          const avoidance = [...new Map([...threats.outsideDanger, ...threats.suppressedByTerrain].map(a => [a.runtimeId, a])).values()].map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 }))
          if (avoidance.length <= 64) {
            const site = selectPortableWorksite({ state: fresh, world: planningWorld, preservedFloors: readCurrentTunnelFloors(), physics: idlePhysics, avoidance })
            if (site) memo = host.shared.portableWorksiteMemo = { site, receipts: {} }
          }
        }
      } catch { /* No actor/body proof means no projected site becomes active. */ }
    }
    if (memo) {
      portableFallbackProposal = null
      if (!memo.deployedProof && idlePhysics) {
        try {
          const fresh = portableGuard(memo.site)
          const threats = evaluateThreats(fresh, fresh.entities, { observationRadius: 32 })
          const avoidance = [...new Map([...threats.outsideDanger, ...threats.suppressedByTerrain].map(a => [a.runtimeId, a])).values()].map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 }))
          if (avoidance.length <= 64 && verifyPortableDeployment({ state: fresh, memo, world: planningWorld, physics: idlePhysics, avoidance })) memo = host.shared.portableWorksiteMemo = { ...memo, deployedProof: { scope, knownReturnAndUseGeometry: true, predictionOnly: true, serverConfirmed: false } }
        } catch { /* Verified placement receipts do not imply current use access. */ }
      }
      result.site = memo.site
      const step = nextPortableStep({ state, memo, world: planningWorld })
      result.deployed = step.deployed === true
      result.step = step.deployed ? null : step
    }
    try {
      const fresh = portableGuard(memo?.site ?? null), threats = evaluateThreats(fresh, fresh.entities, { observationRadius: 32 })
      const avoidance = [...new Map([...threats.outsideDanger, ...threats.suppressedByTerrain].map(a => [a.runtimeId, a])).values()].map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 }))
      const floors = readCurrentTunnelFloors()
      const prepPages = !memo && kit.table > 0 && kit.furnace < 1 ? readStationPages({ state: fresh, stations: host.shared.stations, catalog: host.shared.stationCatalog, world: planningWorld }) : null
      const prepWanted = !!prepPages && nextDiamondAction(state, { ...observed, stationPages: prepPages, portableWorksite: result }, { diamondCount: 1 }).capability === 'known_safe_workbench_placement'
      if (prepWanted) result.preparationTarget = preparationTableTarget({ state: fresh, world: planningWorld, preservedFloors: floors, avoidance })
      if (!memo && rawIron >= 3 && kit.ready) {
        const pages = readStationPages({ state: fresh, stations: host.shared.stations, catalog: host.shared.stationCatalog, world: planningWorld })
        if (pages.craftingTable?.block?.name === 'minecraft:crafting_table' && ['minecraft:furnace', 'minecraft:lit_furnace'].includes(pages.furnace?.block?.name)) result.useExisting = useRays(fresh, { originCell: { x: Math.floor(fresh.position.x), y: Math.round(fresh.position.y - 1.62), z: Math.floor(fresh.position.z) }, table: pages.craftingTable.position, furnace: pages.furnace.position }, planningWorld)
      }
      if (!memo && !result.useExisting && ((rawIron >= 3 && kit.ready) || prepWanted && !result.preparationTarget)) {
        let search = host.shared.portableWorksiteSearch
        if (search?.scope !== scope) search = { scope, inspectedOrigins: [] }
        const origin = String(Math.floor(fresh.position.x)) + ',' + String(Math.round(fresh.position.y - 1.62)) + ',' + String(Math.floor(fresh.position.z))
        if (!search.inspectedOrigins.includes(origin) && search.inspectedOrigins.length < 3) search = { ...search, inspectedOrigins: [...search.inspectedOrigins, origin] }
        host.shared.portableWorksiteSearch = search
        const target = avoidance.length <= 64 ? portableFallbackStop({ state: fresh, world: planningWorld, preservedFloors: floors, physics: idlePhysics, avoidance, inspected: search.inspectedOrigins }) : null
        const fallback = target ? { type: 'move_to', stage: 'portable_worksite', target, allowWater: false, requiresReobservation: true, requiresLivePreview: true } : { type: 'capability_required', stage: 'portable_worksite', capability: 'known_safe_underground_worksite', reason: '既知の作業場所と短い坑道の候補を確認できません。', inspectedOrigins: search.inspectedOrigins.length }
        portableFallbackProposal = target ? { scope, target: { ...target } } : null
        result.preparationStep = fallback
        if (rawIron >= 3) result.step = fallback
      }
    } catch { /* Existing safety policy owns any new danger; no blind primitive. */ }
    return { ...observed, portableWorksite: result }
  }
  async function portablePrimitive (decision, context, kind) {
    const memo = host.shared.portableWorksiteMemo, site = memo?.site
    const ownedControllers = { excavation, interactions }; let ownedChildStarted = false
    if (!site || decision.portableSiteId !== site.id) throw new Error('地下作業場所の計画が変わりました。')
    requireIdle()
    const baseline = portableGuard(site), expected = nextPortableStep({ state: baseline, memo, world: planningWorld })
    if (expected.type !== decision.type || JSON.stringify(expected.target) !== JSON.stringify(decision.target) || kind === 'place' && expected.item !== decision.item) throw new Error('地下作業の次の手順を再確認してください。')
    const controller = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
    const cancel = () => { if (!ownedChildStarted) return; if (kind === 'excavate') void ownedControllers.excavation.stop('地下作業を中断しました。'); else ownedControllers.interactions.cancel('地下設備の設置を中断しました。') }
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setInterval(() => { try { portableGuard(site, baseline) } catch (error) { controller.abort(error) } }, 50)
    try {
      if (kind === 'excavate') return await withPortableMovementLease(decision, { signal }, 'excavate', (movementSignal, child, started) => { ownedChildStarted = true; started(); return child.execute({ target: decision.target }, { signal: movementSignal }) }, ownedControllers)
      const countBefore = baseline.inventory.items.filter(i => i.name === decision.item).reduce((n, i) => n + i.count, 0)
      const action = decision.item === 'minecraft:furnace' ? diamondActions.place_furnace : runner.actions.place_crafting_table
      const response = await withPortableMovementLease(decision, { signal }, 'place', (movementSignal, child, started) => { ownedChildStarted = true; started(); return action({ ...decision, type: decision.item === 'minecraft:furnace' ? 'place_furnace' : 'place_crafting_table' }, { ...context, signal: movementSignal }) }, ownedControllers)
      const after = portableGuard(site, baseline), block = host.world.getBlock(decision.target.x, decision.target.y, decision.target.z)
      const countAfter = after.inventory.items.filter(i => i.name === decision.item).reduce((n, i) => n + i.count, 0)
      if (response?.phase !== 'completed' || response.serverConfirmed !== true || block?.known !== true || block.name !== decision.item || countAfter !== countBefore - 1) throw new Error('地下設備の実ブロックと消費を確認できません。')
      if (host.shared.portableWorksiteMemo !== memo) throw new Error('地下設備の接続または計画が変わりました。')
      host.shared.portableWorksiteMemo = { ...memo, receipts: { ...memo.receipts, [decision.item === 'minecraft:furnace' ? 'furnace' : 'table']: { scope: site.scope, serverConfirmed: true, position: { ...decision.target }, confirmedBy: response.confirmedBy ?? 'server_block_and_inventory' } } }
      return response
    } finally { clearInterval(timer); signal.removeEventListener('abort', cancel) }
  }
  function stoneAccessKey (decision) {
    return JSON.stringify([decision?.type, decision?.resource ?? decision?.stage, decision?.target ?? null, decision?.resourceTarget ?? null, decision?.subgoal?.name ?? null, decision?.subgoal?.stone ?? null])
  }
  function stoneAccessObservedState () {
    const state = observedState(), known = Number.isSafeInteger(host.shared.deathRespawn?.deathId) && host.shared.deathRespawn.deathId >= 0
    return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: known ? actualLifeId() : null } }
  }
  function stoneAccessFrame () {
    if (disposed || disposing || userBehaviorOwns() || !Number.isSafeInteger(host.shared.deathRespawn?.deathId)) throw Object.assign(new Error('石への接近計画の操作権が変わりました。'), { code: 'STALE_OBSERVATION' })
    const state = stoneAccessObservedState()
    const scope = supplyScope(state), slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const item = state.inventory?.items?.find(item => item.slot === slot && item.count === 1)
    const rawItem = Number.isInteger(slot) ? crafting.rawItem(slot) : null
    const tool = item && typeof readDurability === 'function' ? readDurability(item, rawItem) : null
    if (!scope || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle.dead || state.spawnPending || state.gameMode !== 'survival' && state.gameMode !== 0 || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || state.inventory?.known !== true || state.inventory.uncertain || !knownLearningLocalBody(state)) throw Object.assign(new Error('石への接近には現在の生存状態と既知の身体空間が必要です。'), { code: 'STALE_OBSERVATION' })
    if (!Number.isInteger(slot) || slot < 0 || slot > 8 || state.equipmentServerConfirmed === false || !tool || !/^minecraft:(?:wooden|golden|stone|iron|diamond|netherite)_pickaxe$/.test(tool.name) || state.heldItem?.name !== tool.name || state.heldItem?.slot != null && state.heldItem.slot !== slot || tool.durabilityKnown !== true || !Number.isSafeInteger(tool.durabilityUsed) || tool.durabilityUsed < 0 || !Number.isSafeInteger(tool.maxDurability) || tool.maxDurability < 1 || tool.durabilityRemaining !== tool.maxDurability - tool.durabilityUsed || tool.durabilityRemaining < 3 || rawItem?.count !== 1 || rawItem.has_stack_id !== true || !Number.isInteger(rawItem.stack_id) || rawItem.stack_id < 1) throw Object.assign(new Error('現在選択されているツルハシと受信済みの耐久を確認します。'), { code: 'STALE_OBSERVATION' })
    const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
    if (evaluation.requiresObservation || evaluation.threats.length || (host.entities.stats?.().unknownPositions ?? 0) > evaluation.unknownPositions.length) throw Object.assign(new Error('石への接近前に敵と位置情報を再確認します。'), { code: 'NEARBY_THREAT' })
    const avoidance = [...new Map([...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].map(actor => [actor.runtimeId, actor])).values()].map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerRadius, padding: 0 }))
    if (avoidance.length > 64) throw Object.assign(new Error('石への接近経路の敵情報が上限を超えています。'), { code: 'STALE_OBSERVATION' })
    return { state, scope, tool: { name: tool.name, slot, used: tool.durabilityUsed, remaining: tool.durabilityRemaining, stackId: rawItem.stack_id }, avoidance }
  }
  function stoneAccessBlock (point) {
    if (!point || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))) return null
    const block = planningWorld.getBlock(point.x, point.y, point.z)
    return block?.known === true && ['minecraft:stone', 'minecraft:deepslate'].includes(block.name) && block.diggable !== false && !block.protected && !block.protectionSource && block.natural !== false && !block.extra?.length ? block : null
  }
  function stoneAccessFirstReady (plan, frame) {
    if (plan?.ready !== true || plan.withinDurability !== true || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 6 || plan.plannedDigBlocks > 16 || plan.plannedDigBlocks + 2 > frame.tool.remaining) return false
    const first = plan.steps[0]
    if (first.kind === 'excavate') {
      if (excavation.preview({ target: first.targetCell })?.ready !== true) return false
      const target = first.blocksToMine?.[0]
      return !!target && mining.preview([target])?.ready === true
    }
    if (first.kind !== 'move') return false
    motionOrigin = frame.state
    return movement.preview(first.target, { allowWater: false, maxDistance: 2, avoidance: frame.avoidance })?.ready === true
  }
  function requireStoneAccess (decision, observed = null) {
    const proposal = stoneAccessProposal, frame = stoneAccessFrame()
    if (!proposal || proposal.id !== decision.stoneAccessId || proposal.kind !== 'tunnel' || proposal.scope !== frame.scope || observed && supplyScope(observed) !== proposal.scope || proposal.tunneling !== tunneling || proposal.excavation !== excavation || proposal.movement !== movement || Date.now() - proposal.createdAt < 0 || !proposal.started && Date.now() - proposal.createdAt > 5000 || frame.state.health < proposal.health || frame.tool.name !== proposal.tool.name || frame.tool.slot !== proposal.tool.slot || !proposal.started && frame.tool.stackId !== proposal.tool.stackId || frame.tool.used < proposal.tool.used || JSON.stringify(decision.target) !== JSON.stringify(proposal.target) || decision.block !== proposal.block || decision.resource !== 'stone' || !stoneAccessBlock(proposal.target)) throw Object.assign(new Error('石への接近計画の接続・生存回・対象・道具が変わりました。'), { code: 'STALE_OBSERVATION' })
    return { proposal, frame }
  }
  async function runStoneTunnel (decision, context) {
    const { proposal } = requireStoneAccess(decision)
    if (proposal.executing) throw Object.assign(new Error('石への接近処理の終了を待ちます。'), { code: 'STALE_OBSERVATION' })
    proposal.executing = true
    try { return await diamondActions.tunnel(decision, context) } finally { if (stoneAccessProposal === proposal) stoneAccessProposal = null }
  }
  function applyStoneAccess (state, chosen, observation) {
    const proposal = stoneAccessProposal
    if (!proposal || observation.id !== proposal.id || proposal.sourceKey !== stoneAccessKey(chosen) || supplyScope(state) !== proposal.scope || proposal.tunneling !== tunneling || proposal.excavation !== excavation || proposal.movement !== movement || Date.now() - proposal.createdAt < 0 || Date.now() - proposal.createdAt > 5000 || Math.hypot(state.position.x - proposal.origin.x, state.position.y - proposal.origin.y, state.position.z - proposal.origin.z) > 0.1) return null
    return { ...chosen, type: proposal.kind === 'mine' ? 'mine_stone' : 'tunnel', stage: 'stone', resource: 'stone', target: { ...proposal.target }, resourceTarget: { ...proposal.target }, block: proposal.block, count: proposal.count, requiredToolTier: 1, requiresKnownDurability: true, requiresLivePreview: true, requiresReobservation: true, ...(proposal.kind === 'tunnel' ? { stoneAccessId: proposal.id } : {}), reason: proposal.kind === 'mine' ? '実際の採掘面に届く既知の石を通常の採掘で集めます。' : '近くで確認済みの石へ、帰路を残す短い掘削を一段だけ進めます。' }
  }
  async function observeStoneAccess (observed, options) {
    if (stoneAccessProposal?.executing) return observed
    stoneAccessProposal = null
    try {
      const state = observed.state, progress = { ...observed.progress, ...options?.progress }, observations = { ...observed, progress }
      const planOptions = { objective: 'diamond', diamondCount: options?.goal?.diamond ?? 1, logCount: options?.goal?.logs ?? 3, stoneCount: options?.goal?.stone ?? 16 }
      const local = localLearningWork(state), chosen = nextSurvivalAction(state, observations, local.eligible ? { ...planOptions, deferOptionalShelter: true } : planOptions) ?? nextDiamondAction(state, observations, planOptions)
      if (!(chosen.type === 'scan_blocks' && chosen.resource === 'stone' || chosen.type === 'move_to' && (chosen.resource ?? chosen.stage) === 'stone' && chosen.resourceTarget)) return observed
      const origin = stoneAccessFrame()
      if (supplyScope(state) !== origin.scope || Math.hypot(state.position.x - origin.state.position.x, state.position.y - origin.state.position.y, state.position.z - origin.state.position.z) > 0.1) return observed
      if (chosen.type === 'move_to') {
        motionOrigin = origin.state
        const ordinary = movement.preview(chosen.target, { allowWater: false, maxDistance: 12, maxExpanded: 1500, avoidance: origin.avoidance })
        if (ordinary?.ready !== false || ordinary.settleRequired) return observed
      }
      const feet = Math.round(origin.state.position.y - 1.62), floors = new Set(readCurrentTunnelFloors().map(p => `${p.x},${p.y},${p.z}`)), candidates = []
      for (const dx of [-0.3 + 1e-4, 0.3 - 1e-4]) for (const dz of [-0.3 + 1e-4, 0.3 - 1e-4]) floors.add(`${Math.floor(origin.state.position.x + dx)},${feet - 1},${Math.floor(origin.state.position.z + dz)}`)
      const excluded = point => (progress.excludedResources ?? []).some(entry => typeof entry === 'string' ? entry === `${point.x},${point.y},${point.z}` || entry === `stone:${point.x},${point.y},${point.z}` : (entry?.resource == null || entry.resource === 'stone') && ['x', 'y', 'z'].every(axis => (entry.position ?? entry.target ?? entry)?.[axis] === point[axis]))
      for (let down = 1; down <= 6; down++) for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 6) continue
        const point = { x: Math.floor(origin.state.position.x) + dx, y: feet - down, z: Math.floor(origin.state.position.z) + dz }
        if (floors.has(`${point.x},${point.y},${point.z}`) || excluded(point)) continue
        const block = stoneAccessBlock(point)
        if (block) candidates.push({ point, block, cost: down * 1.5 + Math.abs(dx) + Math.abs(dz) })
      }
      candidates.sort((a, b) => a.cost - b.cost || a.point.x - b.point.x || a.point.y - b.point.y || a.point.z - b.point.z)
      const rejected = []
      for (const candidate of candidates.slice(0, 4)) {
        await new Promise(resolve => setImmediate(resolve))
        if (options?.signal?.aborted) throw options.signal.reason
        const fresh = stoneAccessFrame()
        if (fresh.scope !== origin.scope || fresh.state.health < origin.state.health || fresh.tool.stackId !== origin.tool.stackId || Math.hypot(fresh.state.position.x - origin.state.position.x, fresh.state.position.y - origin.state.position.y, fresh.state.position.z - origin.state.position.z) > 0.1) return observed
        const block = stoneAccessBlock(candidate.point)
        if (!block) continue
        const direct = mining.preview([candidate.point]), kind = direct?.ready === true ? 'mine' : 'tunnel'
        const request = { type: 'tunnel', resource: 'stone', target: { ...candidate.point }, resourceTarget: { ...candidate.point }, block: block.name, requiredToolTier: 1 }
        if (kind === 'tunnel') {
          const plan = tunneling.preview(request, STONE_ACCESS_BOUNDS)
          if (!stoneAccessFirstReady(plan, fresh)) { rejected.push({ target: candidate.point, code: plan.code ?? plan.reason ?? 'first_step_not_ready' }); continue }
        }
        const id = `stone-access:${++stoneAccessSequence}`
        stoneAccessProposal = { id, kind, scope: fresh.scope, sourceKey: stoneAccessKey(chosen), target: candidate.point, block: block.name, origin: { ...fresh.state.position }, tool: fresh.tool, health: fresh.state.health, tunneling, excavation, movement, createdAt: Date.now(), count: Number.isSafeInteger(chosen.count) && chosen.count > 0 ? chosen.count : 1 }
        return { ...observed, stoneAccess: { ready: true, id, target: candidate.point, predictionOnly: true, serverConfirmed: false } }
      }
      return { ...observed, stoneAccess: { ready: false, rejected } }
    } catch (error) { if (options?.signal?.aborted) throw error; return observed }
  }

  async function observeStationSupplies (observed, options) {
    const state = observed.state, life = host.shared.deathRespawn?.deathId
    const current = () => ({ ...working(), entities: host.entities.snapshot({ kind: 'all' }), lifecycle: { deathId: Number.isSafeInteger(host.shared.deathRespawn?.deathId) ? host.shared.deathRespawn.deathId : null } })
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !supplyScope(state) || !Number.isSafeInteger(life) || supplyScope(state) !== supplyScope(current())) return observed
    host.shared.stationCatalog = updateStationCatalog({ state, blocks: observed.blocks, catalog: host.shared.stationCatalog })
    const stationPages = readStationPages({ state, stations: host.shared.stations, catalog: host.shared.stationCatalog, world: planningWorld })
    const enriched = { ...observed, stationPages }
    if (!tableMaterialShortfall(state) || !stationPages.craftingTable) return enriched
    const requested = nextDiamondAction(state, enriched, { diamondCount: options?.goal?.diamond ?? 1 })
    if (requested.supplyReturnRequested !== true) return enriched
    let supplyReturn = planSupplyReturn({ state, floors: readCurrentTunnelFloors(), floorScope: { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension }, stationPage: stationPages.craftingTable, world: planningWorld })
    if (supplyReturn.ready) {
      await new Promise(resolve => setImmediate(resolve))
      const fresh = current()
      if (fresh.phase !== 'spawned' || fresh.dead || fresh.isDead || fresh.spawnPending || supplyScope(fresh) !== supplyReturn.scope || fresh.health < state.health || Math.hypot(fresh.position.x - state.position.x, fresh.position.y - state.position.y, fresh.position.z - state.position.z) > 0.1 || !idlePhysics) supplyReturn = { ...supplyReturn, ready: false, reason: 'supply_origin_changed' }
      else {
        const threats = evaluateThreats(fresh, fresh.entities, { observationRadius: 32 })
        if (threats.requiresObservation || threats.threats.length || threats.outsideDanger.length > 64 || (host.entities.stats?.().unknownPositions ?? 0) > threats.unknownPositions.length) supplyReturn = { ...supplyReturn, ready: false, reason: 'supply_threat_observation' }
        else {
          const avoidance = threats.outsideDanger.map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerRadius, padding: 0.5 }))
          try {
            const navigator = createNavigator({ world: planningWorld, version: host.meta.version, physics: idlePhysics.withWorld(planningWorld, { allowWater: false }) })
            const preview = navigator.plan(navigator.physics.fromServer(fresh), supplyReturn.target, { maxDistance: 12, maxExpanded: 500, avoidance })
            const prefixOnly = preview.ready && preview.waypoints.length <= 2 && preview.waypoints.every(step => supplyReturn.waypoints.some(point => Math.hypot(step.position.x - point.x, step.position.y - point.y, step.position.z - point.z) < 1e-4))
            supplyReturn = { ...supplyReturn, ready: !!prefixOnly, ...(prefixOnly ? {} : { reason: preview.reason ?? 'return_prefix_not_native' }), nativePreview: { ready: !!prefixOnly, waypoints: preview.waypoints, predictionOnly: true, serverConfirmed: false } }
          } catch (error) { supplyReturn = { ...supplyReturn, ready: false, reason: 'return_native_preview_failed' } }
        }
      }
    }
    return { ...enriched, supplyReturn }
  }
  const autonomy = createAutonomy({
    requestWorkClearance: () => idleSafety?.requestWorkClearance?.() ?? { pending: false },
    getState: () => {
      const state = observedState(), knownLife = Number.isSafeInteger(host.shared.deathRespawn?.deathId) && host.shared.deathRespawn.deathId >= 0
      const dead = state.dead === true || state.isDead === true || state.lifecycle?.dead === true || state.health === 0
      return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: knownLife ? actualLifeId() : null, dead, phase: dead ? 'dead' : state.phase === 'spawned' && !state.spawnPending && state.health > 0 ? 'alive' : 'unknown' }, idleProtection: safetySnapshot(), shelter: activeBase()?.snapshot(), entityStats: host.entities.stats?.(), world: host.world.stats(), mining: mining.snapshot(), walking: walker?.snapshot(), movement: movement?.snapshot(), crafting: crafting.snapshot(), furnace: furnace.snapshot(), chest: chest.snapshot(), droppedItems: host.entities.snapshot() }
    },
    observe: async options => {
      const observed = await runner.observe(options)
      const scan = prospecting.snapshot()
      const baseActor = activeBase()
      let shelterMemo = baseActor?.memo()
      let shelterPreview = baseActor?.preview({ radius: baseActor === hut ? 10 : 12 })
      const boundaries = Object.values(shelterMemo?.site?.preserved ?? {}).flat()
      if (shelterMemo && !shelterPreview?.ready && boundaries.some(item => { const p = item.position; if (!p) return false; const b = host.world.getBlock(p.x, p.y, p.z); return b.known && ['minecraft:air', 'minecraft:cave_air'].includes(b.name) })) {
        shelterMemo = {}
        shelterPreview = shelter?.preview({ radius: 12, memo: {} })
      }
      const supplied = await observeStationSupplies(observePortableWorksite({ ...observed, shelter: { status: baseActor?.snapshot(), preview: shelterPreview, memo: shelterMemo }, ores: (scan.phase === 'ready' ? scan : host.shared.prospecting)?.ores ?? {}, furnace: furnace.snapshot(), chest: chest.snapshot(), stations: structuredClone(host.shared.stations ?? {}), capabilities: { ...observed.capabilities, build_shelter: !!baseActor, leave_shelter: !!baseActor, move: !!movement, respawn: true, prospect: true, mine_ore: true, furnace: true, place_furnace: true, open_furnace: true, put_furnace_input: true, put_furnace_fuel: true, take_furnace_output: true, tunnel: !!tunneling } }), options)
      return observeStoneAccess(supplied, options)
    },
    observeSafety: async ({ signal }) => {
      const state = observedState()
      if (signal.aborted) throw signal.reason
      const center = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
      const blocks = []
      for (let x = center.x - 8; x <= center.x + 8; x++) for (let y = center.y - 3; y <= center.y + 5; y++) for (let z = center.z - 8; z <= center.z + 8; z++) blocks.push(host.world.getBlock(x, y, z))
      const evaluated = evaluateThreats(state, state.entities, { observationRadius: 32 })
      return { state, center, radius: 8, blocks, entities: state.entities, threats: evaluated.threats, threatEvaluation: evaluated, capabilities: { move: true, explore: true, respawn: true } }
    },
    actions: continuationActions = { ...runner.actions, ...diamondActions,
      tunnel: (decision, context) => decision.resource === 'stone' ? runStoneTunnel(decision, context) : diamondActions.tunnel(decision, context),
      move_to: (decision, context) => decision.portableSiteId || decision.stage === 'portable_worksite' ? withPortableMovementLease(decision, context, 'move', signal => runner.actions.move_to(decision, { ...context, signal })) : runner.actions.move_to(decision, context),
      excavate_worksite_step: (decision, context) => portablePrimitive(decision, context, 'excavate'),
      place_worksite_block: (decision, context) => portablePrimitive(decision, context, 'place'),
      equip: (decision, context) => {
        if (decision.nutritionEquip !== true) return runner.actions.equip(decision, context)
        requireIdle()
        const state = observedState()
        const { preview, window } = checkNutritionDispatch(state, decision, { allowSwordEquip: true })
        const sword = state.inventory.items.find(item => item.slot === decision.slot && item.name === decision.item && item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
        if (window !== 'night' || preview.kind !== 'prey' || !sword) { const error = new Error('夜の狩りに使う実際の剣と食料源を再確認します。'); error.code = 'STALE_OBSERVATION'; throw error }
        return inventory.equip(sword.slot)
      },
      build_shelter: (decision, context) => { const actor = (decision.site?.type ?? decision.plan?.type) === 'soil_hut' ? hut : shelter; return executeShelterBatch(actor, { plan: decision.plan, site: decision.site ?? decision.plan, memo: decision.memo }, context) },
      return_shelter: (decision, context) => executeShelterBatch(activeBase(), {}, context),
      leave_shelter: (decision, context) => {
        requireIdle()
        if (decision.purpose === 'food') {
          const state = observedState()
          if (checkNutritionDispatch(state, decision).preview.ready !== true) {
            const error = new Error('食料のために入口を開ける前に、目的地と周囲の安全を再確認します。'); error.code = 'STALE_OBSERVATION'; throw error
          }
        }
        return activeBase().leave({}, { signal: context.signal })
      },
      defend: async (decision, context) => {
        requireIdle()
        const state = observedState()
        const swordTier = name => ['wooden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(/^minecraft:(\w+)_sword$/.exec(name)?.[1])
        // Defend with the strongest usable sword (higher tier = higher Bedrock damage), not merely the first one listed.
        const sword = state.inventory.items.filter(item => /^minecraft:(?:wooden|stone|iron|diamond|netherite)_sword$/.test(item.name) && item.count > 0 && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)).sort((x, y) => swordTier(y.name) - swordTier(x.name) || x.slot - y.slot)[0]
        if ((!sword && decision.purpose !== 'push_back') || state.inventory.known !== true || state.inventory.uncertain || state.health <= 10) throw new Error('十分な体力と確定した主手を確認してから自衛します。')
        const stop = () => combat.cancel('自衛を中断しました。')
        context.signal?.addEventListener('abort', stop, { once: true })
        try {
          const selected = state.rawSelectedSlot
          if (sword && sword.slot !== selected) await inventory.equip(sword.slot)
          crafting.closeContainer()
          if (context.signal?.aborted) throw context.signal.reason
          // Engagement eligibility also requires the confirmed equipped hand
          // and a known actor identity, so recheck it after the real equip.
          const result = sword && combat.previewEngage(decision.targetRuntimeId).ready ? await combat.engage(decision.targetRuntimeId, { durationMs: 6000, maxHits: 8, signal: context.signal }) : await combat.attack(decision.targetRuntimeId)
          return { ok: true, phase: 'completed', attack: result, serverConfirmed: result.mode === 'engage' ? result.serverConfirmed : result.phase === 'observed', collected: false, enemyDefeated: null }
        } catch (error) {
          const current = working()
          if (current.dead || current.health === 0) error.code = 'DEAD'
          else if (current.health < state.health) error.code = 'TOOK_DAMAGE'
          throw error
        } finally { context.signal?.removeEventListener('abort', stop) }
      },
      recover: (decision, context) => { requireIdle({ inventoryRequired: false }); return recovery.execute({}, { signal: context.signal }) },
      forage: (decision, context) => {
        requireIdle()
        const state = observedState()
        const { preview, window } = checkNutritionDispatch(state, decision)
        if (preview.code === 'FOOD_ALREADY_AVAILABLE') return { ok: true, phase: 'observed', foodAvailable: true, serverConfirmed: true, collected: false }
        return foraging.execute(window === 'night' ? { targetRuntimeId: preview.target.runtimeId } : {}, { signal: context.signal })
      },
      eat: async (decision, context) => { requireIdle(); const stop = () => food.cancel('食事を中断しました。'); context.signal?.addEventListener('abort', stop, { once: true }); try { return await food.eat({ slot: decision.slot, ...(decision.allowEmergencyRotten === true ? { allowEmergencyRotten: true } : {}) }) } finally { context.signal?.removeEventListener('abort', stop) } }
    },
    planSafety: continuationSafety = function planSafety (state, observations = {}) {
      if (disposed || disposing) return { type: 'wait', stage: 'safety', code: 'runtime_reloading', reason: '行動コードの更新完了を待ちます。' }
      if (host.shared.respawnTerrain?.pending) return { type: 'wait', stage: 'safety', code: 'respawn_terrain_pending', reason: 'リスポーン先の地形と前の操作の終了を確認しています。' }
      const physical = state.predicted?.physicsState ?? state.physicsState
      const foot = state.position && { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
      const cell = foot && host.world?.getBlock?.(foot.x, foot.y, foot.z)
      const actuallyWet = physical?.isInWater === true || cell?.known === true && ['minecraft:water', 'minecraft:flowing_water'].includes(cell.name)
      const cachedWater = Object.hasOwn(observations, 'userRecoveryPreview')
      if (actuallyWet && typeof recovery?.previewAsync === 'function' && !cachedWater) return Promise.resolve(recovery.previewAsync()).then(escape => planSafety(state, { ...observations, userRecoveryPreview: escape }))
      const escape = cachedWater ? observations.userRecoveryPreview : recovery?.preview()
      if (escape?.requiresDedicatedRoute) return { type: 'wait', stage: 'safety', code: 'navigation_route_required', reason: '指定された立体的な目的地には別の確認済み経路が必要です。水面への到着とは扱いません。' }
      if (escape?.ready && !escape.alreadyAshore) return { type: 'recover', stage: 'safety', reason: '水辺から確認済みの岸へ戻ることを優先します。' }
      const threats = evaluateThreats(state, state.entities ?? state.hostiles ?? [], { observationRadius: 32 })
      const base = activeBase()?.snapshot()
      const underCover = base?.inside && base?.entranceClosed && base?.usable && base?.serverConfirmed
      const melee = threats.threats.find(threat => threat.distance <= 4 && ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk', 'minecraft:spider', 'minecraft:cave_spider', 'minecraft:drowned'].includes(threat.name) && combat?.preview(threat.runtimeId).ready)
      const inventoryReady = nutritionInventoryReady(state)
      const learningAlive = resourceMinHealth(state) === 0
      const nutritionHealthReady = state.health > resourceMinHealth(state)
      const armed = inventoryReady && state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|diamond|netherite)_sword$/.test(item.name))
      const explosive = threats.threats.some(threat => threat.name === 'minecraft:creeper' && threat.distance <= 8)
      const boss = threats.threats.some(threat => threat.category === 'boss' || ['minecraft:warden', 'minecraft:wither', 'minecraft:ender_dragon'].includes(threat.name))
      const scope = JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null])
      const scopeReady = typeof state.profile === 'string' && state.profile.length > 0 && state.realm?.id != null && ['overworld', 'nether', 'end'].includes(state.dimension)
      const now = Date.now()
      const clock = Object.values(host.shared.worldClocks ?? {}).find(clock => clock.name === 'minecraft:overworld')
      const dayTime = Number.isSafeInteger(clock?.time) ? ((clock.time % 24000) + 24000) % 24000 : null
      const knownDay = dayTime != null && dayTime >= 200 && dayTime < 12000
      const knownNight = dayTime != null && !knownDay
      const foodDay = knownDay && dayTime < 11400
      const hungerValue = host.shared.vitals?.hunger
      const hunger = typeof hungerValue === 'number' ? hungerValue : hungerValue?.source === 'client_prediction' ? null : hungerValue?.value
      const hungerKnown = Number.isFinite(hunger) && hunger >= 0 && hunger <= 20
      const items = inventoryReady ? state.inventory.items.filter(item => item.count > 0 && isSupportedFood(item.name, state)) : []
      // Rotten flesh remains emergency food only. While already full and
      // well-fed, its real reserve can defer optional stocking in explicit
      // online learning; no eating, healing or healthy-food credit is granted.
      const receivedReserveCount = inventoryReady ? Math.min(2304, state.inventory.items.reduce((sum, item) => sum + (item.name === 'minecraft:rotten_flesh' && Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 64 ? item.count : 0), 0)) : null
      const foodReserveDeferred = inventoryReady && !items.length && learningAlive && state.health === 20 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 18 && receivedReserveCount >= 2
      const needsFood = inventoryReady && !items.length && (state.health > 14 || hungerKnown && hunger <= 17) && !foodReserveDeferred
      const safeOutside = !threats.requiresObservation && !(state.entityStats?.unknownPositions > threats.unknownPositions.length) && !threats.threats.length && !boss
      const foodWindow = foodDay ? 'day' : knownNight ? 'night' : null
      const localWork = localLearningWork(state, threats, base)
      const learningLocalWork = localWork.eligible
      let task = host.shared.nutritionTask
      const validTask = task && ['seeking_food', 'cooldown'].includes(task.phase) && Number.isFinite(task.expiresAt) && (task.phase === 'seeking_food' ? Number.isFinite(task.startedAt) && task.startedAt <= now && task.expiresAt <= task.startedAt + 180000 : Number.isFinite(task.retryAfter) && task.expiresAt === task.retryAfter)
      if (task && (!validTask || !scopeReady || task.scope !== scope || items.length || !inventoryReady || !safeOutside || !foodWindow)) host.shared.nutritionTask = task = null
      if (task?.phase === 'cooldown' && now >= task.retryAfter) host.shared.nutritionTask = task = null
      if (task?.phase === 'seeking_food' && now >= task.expiresAt) {
        host.shared.nutritionTask = task = { scope, phase: 'cooldown', retryAfter: now + 60000, expiresAt: now + 60000 }
      }
      const foragePreview = needsFood && scopeReady && nutritionHealthReady && safeOutside && foodWindow && task?.phase !== 'cooldown' ? foraging?.preview() : null
      const sourcePosition = foragePreview?.target?.position
      const sourceDistance = sourcePosition && state.position && ['x', 'y', 'z'].every(axis => Number.isFinite(sourcePosition[axis]) && Math.abs(sourcePosition[axis]) <= 30000000 && Number.isFinite(state.position[axis]) && Math.abs(state.position[axis]) <= 30000000) ? Math.hypot(sourcePosition.x - state.position.x, sourcePosition.y - state.position.y, sourcePosition.z - state.position.z) : null
      const usableStonePick = inventoryReady && state.inventory.items.some(item => item.count === 1 && /^minecraft:(?:stone|copper|iron|diamond|netherite)_pickaxe$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
      // First obtain the basic stone kit while already full and well-fed.
      // The distant source still exists; this defers only optional dispatch,
      // never grants food/eating credit, and does not interrupt an owned hunt.
      const stoneBootstrapVitals = learningAlive && inventoryReady && state.health === 20 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 18 && !usableStonePick
      const localStarterVitals = learningLocalWork && inventoryReady && !items.length && !nutritionSword(state) && state.health >= 14 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 10 && scopeReady && safeOutside
      const distantFoodDeferred = (stoneBootstrapVitals || localStarterVitals) && foragePreview?.ready === true && sourceDistance !== null && sourceDistance > 8
      const canForage = nutritionSourceAllowed(state, foragePreview, foodWindow) && !distantFoodDeferred
      if (task?.phase === 'seeking_food' && foodWindow === 'night' && !canForage) host.shared.nutritionTask = task = null
      const seekingFood = task?.phase === 'seeking_food' && needsFood && nutritionHealthReady && safeOutside && canForage
      // This exception returns only the existing bounded wooden-sword plan;
      // it never releases the ordinary mining or diamond resource planner.
      const firstWeaponVitals = inventoryReady && !items.length && (learningAlive || state.health >= 12) && hungerKnown && hunger >= 16 && scopeReady && !nutritionSword(state)
      const prepareFirstWeapon = firstWeaponVitals && safeOutside && !(canForage && (learningAlive || foragePreview.kind === 'drop'))
      const localFirstWeapon = learningLocalWork && inventoryReady && !items.length && scopeReady && !nutritionSword(state) && !(canForage && (foragePreview.kind === 'drop' || hungerKnown && hunger <= 17))
      const priority = host.shared.startupPriority = { policy: state.threatPolicy, health: state.health, receivedHunger: hungerKnown ? hunger : null, foodReserveDeferred, receivedReserveCount, distantFoodDeferred, sourceDistance, bodyProof: localWork.bodyProof, localWorkEligible: learningLocalWork, actualDanger: threats.threats.length, unknown: threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length, foodReady: { owned: null, source: foragePreview?.ready === true, sourceEligible: canForage, sourceKind: foragePreview?.kind ?? null }, hasSword: nutritionSword(state), firstSwordPlan: null, deferOptionalShelter: learningLocalWork }
      const firstWeapon = () => {
        const decision = nextSurvivalAction(state, observations, { firstWoodenSwordOnly: true }) ?? foodWait()
        priority.firstSwordPlan = { type: decision.type, code: decision.code ?? null, reason: String(decision.reason ?? '').slice(0, 80) }
        return decision
      }
      const foodPurpose = () => ({ purpose: 'food', nutritionScope: scope, nutritionWindow: foodWindow, ...(foodWindow === 'night' ? { nutritionTarget: nutritionTarget(foragePreview) } : {}) })
      const beginFood = () => {
        if (!seekingFood) host.shared.nutritionTask = { scope, phase: 'seeking_food', startedAt: now, expiresAt: now + 180000 }
      }
      const foodWait = () => ({ type: 'wait', stage: 'safety', code: task?.phase === 'cooldown' ? 'food_acquisition_cooldown' : 'food_source_required', reason: '回復と採掘に使う食料がありません。時間帯と装備に合う安全な食料源の観測を待ちます。' })
      if (!underCover && state.health > 10 && melee && inventoryReady && !explosive && !boss && combat?.preview(melee.runtimeId).ready) {
        if (combat.snapshot().cooldownRemainingMs > 0) return { type: 'wait', stage: 'safety', code: 'defense_cooldown', reason: '次の自衛の一撃まで待ちます。' }
        return { type: 'defend', purpose: armed ? 'defense' : 'push_back', stage: 'safety', targetRuntimeId: melee.runtimeId, reason: armed ? '剣を使い、近づいた敵に自衛します。' : '近づいた敵を一撃で押し返し、退避や拠点を閉じる時間を作ります。' }
      }
      const emergencyMeal = inventoryReady && !items.length && hungerKnown && hunger < 18 ? food.preview({ allowEmergencyRotten: true }) : null
      if (!boss && emergencyMeal?.ready === true && emergencyMeal.name === 'minecraft:rotten_flesh') return { type: 'eat', stage: 'safety', slot: emergencyMeal.slot, allowEmergencyRotten: true, reason: '対応食料がないため、確認済みの安全な場所で手持ちの腐った肉を1個食べて空腹を補います。' }
      if (needsFood && !distantFoodDeferred && foodWindow === 'night' && safeOutside && foragePreview?.ready === true && foragePreview.kind === 'prey' && nutritionSword(state) && !nutritionSword(state, true)) {
        const sword = state.inventory.items.find(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
        if (sword) { beginFood(); return { type: 'equip', ...foodPurpose(), nutritionEquip: true, slot: sword.slot, item: sword.name, stage: 'safety', reason: '夜の確認済みの食料源へ向かう前に、実際の剣を装備して主手の確認を待ちます。' } }
      }
      if (underCover && !boss) {
        const item = items.find(item => food.preview({ slot: item.slot }).ready)
        if ((state.health < 20 || hungerKnown && hunger <= 17) && item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '入口を閉じた拠点で食事と回復を優先します。' }
        if (needsFood && canForage && !prepareFirstWeapon) { host.shared.shelterNightWait = null; beginFood(); return { type: 'leave_shelter', ...foodPurpose(), stage: 'shelter', reason: '安全を確認した食料源へ向かうため、入口を開けます。' } }
        if (knownNight) {
          const cycle = Math.floor(clock.time / 24000) + (dayTime >= 12000 ? 1 : 0)
          let waiting = host.shared.shelterNightWait
          if (waiting?.scope !== scope || waiting.cycle !== cycle) {
            const remaining = (200 - dayTime + 24000) % 24000
            host.shared.shelterNightWait = waiting = { scope, cycle, until: now + Math.min(900000, remaining * 50 + 30000) }
          }
          return { type: 'wait', stage: 'safety', code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: waiting.until, reason: '夜の間は入口を閉じた拠点で待機し、明るくなってから資材集めへ戻ります。' }
        }
        host.shared.shelterNightWait = null
        if (needsFood && safeOutside && nutritionHealthReady) {
          if (!prepareFirstWeapon) return foodWait()
        }
        if (state.health > 14 && !threats.requiresObservation && threats.threats.every(threat => threat.distance > 8)) return { type: 'leave_shelter', stage: 'shelter', reason: '拠点の入口に近い敵がいないため、入口を開けて資材準備へ戻ります。' }
        return { type: 'wait', stage: 'safety', code: 'shelter_cover', reason: '入口を閉じた拠点の中で、敵の接近が収まるまで待ちます。' }
      }
      if (learningLocalWork && (state.health < 20 || hungerKnown && hunger <= 17)) {
        const item = items.find(item => food.preview({ slot: item.slot }).ready)
        priority.foodReady.owned = !!item
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '確認済みの現在地で手持ちの食料を優先し、回復と空腹を補います。' }
      }
      const insideTarget = base?.memo?.site?.innerStandpoint ?? base?.memo?.site?.insideStandpoint
      if (!learningLocalWork && !boss && base?.established && (!base.inside || !base.closed) && state.health > 6 && insideTarget && Math.hypot(state.position.x - insideTarget.x, state.position.y - 1.62 - insideTarget.y, state.position.z - insideTarget.z) <= 10 && (knownNight && !canForage || threats.threats.length || state.health < 14 && !canForage)) {
        const approach = baseReturnApproach(state, base, host.entities.stats?.().unknownPositions)
        if (approach.ready) return { type: 'return_shelter', stage: 'safety', reason: '作業を中断し、確認済みの安全な拠点へ戻って入口を閉じます。' }
        if (safeOutside && !learningLocalWork) return { type: 'wait', stage: 'safety', code: 'shelter_approach_unsafe', reason: '拠点の接近先に敵か未確認の状況があるため、現在地で通常の保護を保ち、食料調達と安全な接近先の次の観測を待ちます。' }
      }
      if (state.health > 0 && state.health <= 6 && threats.threats.length) return { type: 'avoid_threat', emergency: true, stage: 'safety', reason: '体力が少ないため、既知の陸上経路で敵から離れます。', threat: threats.threats[0] }
      if (state.health > 0 && state.health < 20 && safeOutside) {
        const item = items.find(item => food.preview({ slot: item.slot }).ready)
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '持ち物の食料を食べて回復を優先します。' }
      }
      if (state.health === 20 && hungerKnown && hunger <= 17 && safeOutside) {
        const item = items.find(item => food.preview({ slot: item.slot }).ready)
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '体力が満タンでも空腹を補い、採掘前に食料を使います。' }
      }
      if (firstWeaponVitals && (threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length)) return { type: 'wait', stage: 'safety', code: 'threat_observation_unknown', reason: '近くの状況が未確認のため、最初の剣の準備を始める前に観測を待ちます。' }
      const nightShelter=readyNightSoilShelter(state,observations)
      if(nightShelter){priority.deferOptionalShelter=false;return nightShelter}
      if (localFirstWeapon || prepareFirstWeapon) return firstWeapon()
      if (needsFood && nutritionHealthReady && safeOutside) {
        if (canForage) { beginFood(); return { type: 'forage', ...foodPurpose(), stage: 'safety', reason: '採掘を休止し、確認済みの食料源から実際の食料を調達します。' } }
        if (!learningAlive) return foodWait()
      }
      if (!learningAlive && state.health > 0 && state.health <= 6) {
        return { type: 'wait', stage: 'safety', code: 'health_recovery', reason: '体力が少ないため採掘と遠出を休止します。手持ちの食料か安全な補給が必要です。' }
      }
      return null
    },
    planAction: (state, observations, options) => {
      const localWork = localLearningWork(state)
      const nightShelter=readyNightSoilShelter(state,observations)
      const survivalOptions = localWork.eligible && !nightShelter ? { ...options, deferOptionalShelter: true } : options
      if (host.shared.startupPriority) Object.assign(host.shared.startupPriority, { bodyProof: localWork.bodyProof, localWorkEligible: localWork.eligible, deferOptionalShelter: localWork.eligible && !nightShelter })
      if(nightShelter)return nightShelter
      const diamond = nextDiamondAction(state, observations, options)
      const direct = immediateDiamond(state, diamond, targets => mining.preview(targets))
      const chosen = direct ? { ...diamond, type: 'mine_ore', stage: 'diamond', reason: '確認済みの採掘面に直接届くダイヤ鉱石を採ります。', resourceTarget: diamond.target, requiresLivePreview: true } : nextSurvivalAction(state, observations, survivalOptions) ?? diamond
      const current = raw()
      const sameScope = !disposed && !disposing && ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].every(field => state[field] === current[field]) && state.profile === (current.profile ?? host.meta.profile) && String(state.realm?.id ?? '') === String(current.realm?.id ?? '') && Number.isSafeInteger(host.shared.deathRespawn?.deathId) && state.lifecycle?.deathId === actualLifeId()
      const stone = sameScope && observations.stoneAccess?.ready === true ? applyStoneAccess(state, chosen, observations.stoneAccess) : null
      const observedTunnel = sameScope ? normalizeUnobservedTunnel(chosen, target => planningWorld.getBlock(target.x, target.y, target.z)) : chosen
      const reachable = stone ?? (sameScope ? normalizeReachableTunnel(state, observedTunnel, targets => mining.preview(targets)) : chosen)
      const routeGeneration = inputHistoryGeneration
      const routeCurrent = () => {
        const actual = raw(), position = working().position
        return sameScope && !disposed && !disposing && inputHistoryGeneration === routeGeneration && state.lifecycle?.deathId === actualLifeId() && state.health === actual.health && ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].every(field => state[field] === actual[field]) && state.profile === (actual.profile ?? host.meta.profile) && String(state.realm?.id ?? '') === String(actual.realm?.id ?? '') && position && Math.hypot(position.x - state.position.x, position.y - state.position.y, position.z - state.position.z) <= 1e-4
      }
      const decision = sameScope ? selectReadyOreTunnel(state, reachable, observations, options, { readBlock: target => planningWorld.getBlock(target.x, target.y, target.z), previewTunnel: (target, limits) => tunneling?.preview(target, limits), previewMining: targets => mining.preview(targets), isCurrent: routeCurrent }) : reachable
      if (host.shared.startupPriority && String(decision.preparation ?? '').startsWith('wooden_sword')) host.shared.startupPriority.firstSwordPlan = { type: decision.type, code: decision.code ?? null, reason: String(decision.reason ?? '').slice(0, 80) }
      return decision.type === 'move_to' && decision.resourceTarget ? useCurrentAccess(decision, mining.preview([decision.resourceTarget])) : decision
    },
    onDecision: decision => host.log(`次の行動: ${decision.reason}`),
    onProgress: progress => {
      host.shared.autonomyProgress = progress.progress
      host.noteProgress(progress)
    }
  })

  function initialiseMotion () {
    if (disposed || disposing || raw().phase !== 'spawned' || !host.meta.startGame) return
    if (userBehaviorGenerationScope === userScope(rawScope()) && userBehaviorOwns()) return
    if (host.meta.version !== host.world.stats().version) throw new Error('接続版と地形データの版が違うため操作しません。')
    inputHistory?.invalidate('motion_generation_changed')
    if (inputStream) {
      const reason = 'スポーン位置から操作を初期化します。'
      manualShulkerAbort?.abort(new Error('SHULKER_RECOVERY_GENERATION_CHANGED'))
      manualShulkerRecovery?.cancel('SHULKER_RECOVERY_GENERATION_CHANGED')
      // Abort the old owners synchronously, and force-stop their base stream.
      // release() deliberately keeps idle ticks alive and is insufficient here.
      userBehaviors?.cancel(reason, 'SESSION_CHANGED')
      const cleanup = Promise.allSettled([userBehaviors?.drain(), idleSafety?.stop(reason), idleSafety?.drain(), excavation?.stop(reason), tunneling?.stop(reason), recovery?.stop(reason), foraging?.stop(reason), surfaceReturn?.stop(reason), shelter?.stop(reason), hut?.stop(reason), guardRoute?.stop(reason)])
      pendingStops.add(cleanup)
      cleanup.finally(() => pendingStops.delete(cleanup))
      inventory.cancel(reason)
      mining.stop(reason)
      walker?.stop(reason)
      movement?.stop(reason)
      combat?.cancel(reason)
      inputStream.stop()
    }
    inputOwner = 'none'
    idlePhysicsState = null
    idleStamp = null
    motionOrigin = working()
    const common = { client: host.client, version: host.meta.version, startGame: host.meta.startGame, startGameReceivedAt: host.meta.startGameReceivedAt }
    idlePhysics = createPhysics({ world: host.world, version: host.meta.version, allowWater: true })
    idleOriginNavigator = null
    const generationPhysics = idlePhysics
    // Build the planning view before any escape owns the input timer. Reusing
    // the generation's definitions avoids a cold registry scan mid-flight.
    const generationPlanningPhysics = generationPhysics.withWorld(planningWorld)
    inputHistoryGeneration++
    boundedJumpSearch = null
    const generationHistory = createInputHistory({ physics: generationPhysics, maxAgeMs: 4000, maxTicks: 80 })
    const wireConnection = queuedWireConnection(raw())
    const queuedCursor = () => {
      let wallTick = null
      try { wallTick = BigInt(common.startGame.current_tick) + BigInt(Math.max(0, Math.floor((performance.now() - common.startGameReceivedAt) / 50))) } catch {}
      return actualWireClock.cursor(generationHistory.snapshot().cursor, wireConnection, wallTick)
    }
    inputHistory = generationHistory
    inputHistoryPhysics = generationPhysics
    observeStationaryRaw()
    const completedDryProofs = new WeakMap()
    const queuedTailProofs = new WeakMap()
    const preMovementFences = new WeakMap()
    let queuedMotionFrames = 0; let unprovedInputFrames = 0
    const queuedForageLandingFrames = [], foragingLandingOwners = new WeakMap(), foragingLandingProofs = new WeakMap()
    let generationForaging = null
    let generationPillar = null, pillarInputToken = null
    const currentGeneration = () => !disposed && !disposing && inputStream === generationStream
    const requireGeneration = () => { if (!currentGeneration()) throw new Error('スポーン前の操作は終了しました。新しい位置からやり直してください。') }
    const queuedFrame = frame => {
      if (!currentGeneration()) { generationHistory.invalidate('stale_motion_generation'); return }
      recordMovementCalibrationFrame(frame)
      if (Object.values(frame.controls ?? {}).some(Boolean)) queuedMotionFrames++
      if (frame.modeled !== true || frame.receiptConfirmed !== true) unprovedInputFrames++
      const accepted = generationHistory.recordQueued({ ...frame, scope: historyScope(raw()) })
      if (quarryPlacementPreparation?.history === generationHistory) {
        const neutral = frame.controls && typeof frame.controls === 'object' && !Array.isArray(frame.controls) && Object.entries(frame.controls).every(([key, value]) => ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(key) && value === false)
        const physical = frame.predictedState
        quarryPlacementPreparation.frame = accepted?.accepted === true && inputOwner === 'idle' && frame.producer === 'input' && frame.modeled === true && frame.receiptConfirmed === true && neutral && physical?.onGround === true && !physical.isInWater && !physical.isInLava && Math.hypot(physical.velocity?.x ?? Infinity, physical.velocity?.z ?? Infinity) <= 0.003
          ? { tick: String(frame.tick), at: frame.queuedAt, position: { ...frame.packetPosition } } : null
      }
      generationPillar?.onQueuedFrame(frame)
      try {
        const physical = frame.predictedState, state = raw(), snapshot = generationHistory.snapshot(), controls = frame.controls
        const neutral = controls && typeof controls === 'object' && !Array.isArray(controls) && Object.entries(controls).every(([key, value]) => ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(key) && value === false)
        if (accepted?.accepted !== true || frame.producer !== 'input' || frame.modeled !== true || frame.receiptConfirmed !== true || !neutral || !Number.isSafeInteger(host.shared.deathRespawn?.deathId) || physical?.onGround !== true || physical.isInWater || physical.isInLava || state.health !== frame.health || snapshot.anchorKind !== 'server_correction' || !snapshot.anchorTick || BigInt(frame.tick) <= BigInt(snapshot.anchorTick) || !['x', 'y', 'z'].every(k => Number.isFinite(frame.packetPosition?.[k]) && Math.abs(frame.packetPosition[k] - physical.position[k] - (k === 'y' ? 1.62 : 0)) <= 1e-4) || !fullStandingGeometry({ position: frame.packetPosition, predicted: { physicsState: physical } }, physical.position)) { queuedForageLandingFrames.length = 0; return }
        const entry = { tick: String(frame.tick), at: frame.queuedAt, scope: userScope(state), life: actualLifeId(), health: frame.health, rawStamp: state.positionUpdatedAt, rawPosition: { ...state.position }, forceRevision: userBehaviorForceRevision, anchorTick: snapshot.anchorTick, leaseAt: snapshot.leaseAt, packetPosition: { ...frame.packetPosition }, physicsState: structuredClone(physical) }
        const last = queuedForageLandingFrames.at(-1)
        if (last && (BigInt(entry.tick) !== BigInt(last.tick) + 1n || ['scope', 'life', 'health', 'rawStamp', 'forceRevision', 'anchorTick', 'leaseAt'].some(k => last[k] !== entry[k]) || !['x', 'y', 'z'].every(k => last.rawPosition[k] === entry.rawPosition[k]))) queuedForageLandingFrames.length = 0
        queuedForageLandingFrames.push(entry); if (queuedForageLandingFrames.length > 2) queuedForageLandingFrames.shift()
      } catch { queuedForageLandingFrames.length = 0 }
    }
    function onInputError (error) {
      if (!currentGeneration()) return
      const at = Date.now(), owner = inputOwner, cursor = generationHistory.snapshot().cursor
      const observed = raw(), mine = mining.snapshot()
      host.shared.lastInputFailure = {
        at: new Date(at).toISOString(), error: String(error.message ?? error).slice(0, 240), owner,
        cursorTick: cursor?.tick == null ? null : String(cursor.tick).slice(0, 24), cursorAgeMs: Number.isFinite(cursor?.queuedAt) ? at - cursor.queuedAt : null,
        rawPhase: observed.phase ?? null, dead: observed.dead === true, spawnPending: observed.spawnPending === true,
        deathId: host.shared.deathRespawn?.deathId ?? host.shared.respawnTerrain?.deathId ?? null,
        rawSource: observed.positionSource ?? null, lastSource: host.shared.motionSource ?? null,
        movementPhase: movement?.snapshot().phase ?? null, miningPhase: mine.phase, miningActiveTarget: mine.activeTarget != null
      }
      generationPillar?.cancel(error.message)
      queuedForageLandingFrames.length = 0
      generationHistory.invalidate('input_failed')
      inputOwner = 'none'; idleFailureAt = at; host.shared.idleError = error.message
      if (owner === 'task' && mine.phase === 'mining' && mine.activeTarget != null) mining.stop(error.message, 'failed')
    }
    const generationStream = createInput({ ...common, getState: () => { requireGeneration(); return working() }, frameProvider: frame => {
      requireGeneration()
      const recovery = manualShulkerRecovery?.snapshot(), target = mining.snapshot().activeTarget
      if (recovery?.busy && target?.ownershipKey === recovery.operationId && manualShulkerMiningSerial === portableActionOwners.serial(mining)) manualShulkerRecovery.beforeInput(frame)
      return generationPillar?.frame(frame) ?? neutralFrame(frame)
    }, onQueuedFrame: queuedFrame, getQueuedCursor: queuedCursor, onError: onInputError })
    inputStream = generationStream
    input = {
      start: () => { requireGeneration(); inputOwner = 'task'; generationStream.start() },
      stop: () => { if (!currentGeneration()) { generationStream.stop(); return }; inputOwner = 'idle'; if (generationStream.release) generationStream.release(); else generationStream.stop() },
      lookAt: point => { requireGeneration(); return generationStream.lookAt(point) }, sendAction: (...args) => { requireGeneration(); return generationStream.sendAction(...args) }, sendTransaction: (...args) => { requireGeneration(); return generationStream.sendTransaction(...args) },
      stats: () => ({ ...generationStream.stats(), running: currentGeneration() && inputOwner === 'task' && generationStream.stats().running, streamRunning: generationStream.stats().running, owner: currentGeneration() ? inputOwner : 'stale' })
    }
    const generationInput = input
    let waterPreviewObserver = null
    // combatMotion: a combat claim is moving itself (approach / sight stance).
    const combatMoving = () => { try { return userBehaviorLease?.kind === 'combat' && ['approaching', 'repositioning'].includes(userBehaviorSnapshot().combat?.phase) } catch { return false } }
    const generationMotionState = () => { requireGeneration(); const state = motionState(); const scoped={...state,profile:state.profile??host.meta.profile,lifecycle:{...(state.lifecycle??{}),deathId:movementKnownLife()},combatMotion:combatMoving()}; waterPreviewObserver?.captureState(scoped); return scoped }
    walker = createWalker({ ...common, getState: generationMotionState, world: host.world })
    const generationMovement = createMovement({ ...common, replanMixedAfterReplay:true, getState: generationMotionState, world: host.world, physics: generationPhysics.withWorld(host.world, { allowWater: false }), waterPhysics: generationPhysics, onQueuedFrame: queuedFrame, getQueuedCursor: queuedCursor, onPrediction: prediction => { if (currentGeneration()) publishControlPrediction({ ...host.shared.prediction, ...prediction }, 'navigation') } })
    portableActionOwners.track(generationMovement, ['start', 'startHop', 'settle'], { invalidate: ['stop', 'resetLifecycle'], isActive: c => ['moving', 'settling'].includes(c.snapshot().phase) })
    movement = generationMovement
    waterPreviewObserver = createWaterPreviewObserver({preview:generationMovement.preview,getLife:actualLifeId,getGeneration:()=>inputHistoryGeneration,publish:value=>{host.shared.waterPreviewObservation=value}})
    generationMovement.preview = waterPreviewObserver.preview
    // A cancelled legacy defender must not release the new combat owner's input.
    const combatOwnsInput = () => userBehaviorLease?.kind === 'combat' && userBehaviorLease.ready === true
    const legacyInput = {
      ...generationInput,
      start: () => { if (userBehaviorLease?.kind === 'combat') throw new Error('Combat owns input'); return generationInput.start() },
      stop: () => { if (!combatOwnsInput()) return generationInput.stop() },
      lookAt: (...args) => { if (userBehaviorLease?.kind === 'combat') throw new Error('Combat owns input'); return generationInput.lookAt(...args) },
      sendAction: (...args) => { if (userBehaviorLease?.kind === 'combat') throw new Error('Combat owns input'); return generationInput.sendAction(...args) },
      sendTransaction: (...args) => { if (userBehaviorLease?.kind === 'combat') throw new Error('Combat owns input'); return generationInput.sendTransaction(...args) }
    }
    const generationCombat = createCombat({ client: host.client, getState: () => { requireGeneration(); return observedState() }, world: host.world, entities: host.entities, crafting, getInput: () => { requireGeneration(); return legacyInput }, verifyUnarmedBody, version: host.meta.version })
    combat = generationCombat
    const own = fn => (...args) => { requireGeneration(); if (userBehaviorLease?.kind === 'combat') throw new Error('COMBAT_PRIORITY'); ownedCall++; try { return fn(...args) } finally { ownedCall-- } }
    const cancelBackgroundInventory = reason => {
      if (userBehaviorLease?.kind === 'combat' && (userBehaviorLease.ready || inventory.snapshot().pendingRequestId != null)) return
      inventory.cancel(reason)
    }
    const backgroundInventory = { ...inventory, cancel: cancelBackgroundInventory }
    const generationMiningState = () => { requireGeneration(); return miningState() }
    const ownedMining = { preview: own(targets => mining.preview(targets)), start: own(targets => operations.mining.start(targets)), stop: reason => { if (combatOwnsInput()) return mining.snapshot(); return currentGeneration() ? mining.stop(reason) : generationStream.stop() } }
    const ownedMovement = { preview: own((target, options) => operations.movement.preview(target, tagPortableOwnedMove(target, options))), start: own((target, options) => startMotion('navigation', target, tagPortableOwnedMove(target, options))), stop: reason => { if (combatOwnsInput()) return generationMovement.snapshot(); return portableMovementLease?.kind === 'excavate' ? stopPortableMovement(portableMovementLease, reason) : generationMovement.stop(reason) } }
    const ownsPillarInput = (token, stream) => currentGeneration() && pillarInputToken === token && stream === generationInput && inputOwner === 'task' && !host.shared.respawnTerrain?.pending
    generationPillar = createQuarryPillar({
      getState: () => { requireGeneration(); return quarryState() },
      getBlock: (x, y, z) => planningWorld.getBlock(x, y, z),
      getPhysics: () => generationPhysics.withWorld(host.world, { allowWater: false }),
      getInput: () => generationInput,
      confirmPosition: (feet, settings) => confirmQuarryPosition(feet, settings),
      equipDirt: own(async (slot, options) => {
        requireIdle(); crafting.closeContainer()
        return inventory.equip(slot, options)
      }),
      placeBlock: options => { requireGeneration(); if (!pillarInputToken || inputOwner !== 'task') throw new Error('ASCENT_INPUT_CHANGED'); return interactions.placeBlock(options) },
      cancelPlace: reason => { if (currentGeneration() && pillarInputToken && inputOwner === 'task') interactions.cancel(reason) },
      acquireInput: ({ token }) => {
        requireGeneration()
        if (pillarInputToken || userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size) throw new Error('ASCENT_INPUT_BUSY')
        own(() => requireIdle())()
        pillarInputToken = token
        // The step starts the same input stream after recording its intent.
        inputOwner = 'task'
      },
      ownsInput: ownsPillarInput,
      releaseInput: (token, stream) => { if (!ownsPillarInput(token, stream)) return; pillarInputToken = null; generationInput.stop() },
      onPrediction: prediction => { if (currentGeneration()) publishControlPrediction({ ...host.shared.prediction, ...prediction }, 'quarry_pillar') }
    })
    quarryPillar = generationPillar
    const pillarStep = (request, options) => {
      requireGeneration()
      const task = generationPillar.step(request, options)
      quarryPillarTask = task
      return task.finally(() => { if (quarryPillarTask === task) quarryPillarTask = null })
    }
    quarryPorts = { mining: ownedMining, movement: ownedMovement, cancelPortableMovement: (owner, reason) => portableActionOwners.cancel(generationMovement, owner, () => generationMovement.stop(reason)), previewStorageRoute: (target, options) => { requireGeneration(); return generationMovement.preview(target, options) }, getMining: () => mining.snapshot(), getMovement: () => generationMovement.snapshot(), standingClear: fullStandingGeometry, own, pillarStep }
    const recoveryMovement = { ...ownedMovement, start: (target, options) => { recoveryMotionDepth++; try { return ownedMovement.start(target, options) } finally { recoveryMotionDepth-- } } }
    const generationExcavation = createExcavation({ getState: generationMiningState, world: host.world, mining: ownedMining, movement: ownedMovement, getMining: own(() => mining.snapshot()), getMovement: () => generationMovement.snapshot(), onProgress: data => { if (currentGeneration()) host.noteProgress(data) } })
    excavation = generationExcavation
    const tunnelScopeOf = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null])
    const tunnelScope = tunnelScopeOf(raw())
    const tunnelFloors = () => {
      requireGeneration()
      if (tunnelScopeOf(raw()) !== tunnelScope) throw new Error('掘削のワールドが変わったため帰路の床を再確認してください。')
      const journal = host.shared.tunnelFloors
      if (journal != null && (journal.version !== 1 || !journal.scopes || typeof journal.scopes !== 'object' || Array.isArray(journal.scopes))) throw new Error('帰路の床の記録が不明なため掘削を停止します。')
      const entry = journal?.scopes[tunnelScope]
      if (entry != null && (!entry || typeof entry !== 'object' || !Array.isArray(entry.floors))) throw new Error('帰路の床の記録が不正なため掘削を停止します。')
      const floors = entry?.floors ?? []
      if (!Array.isArray(floors) || floors.length > 1024 || floors.some(point => !point || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000) || point.y < -64 || point.y > 319)) throw new Error('帰路の床の記録が不正なため掘削を停止します。')
      return structuredClone(floors)
    }
    readCurrentTunnelFloors = tunnelFloors
    tunneling = createTunneling({ getState: () => { requireGeneration(); return stoneAccessObservedState() }, world: planningWorld, excavation: generationExcavation, movement: ownedMovement, getMovement: () => generationMovement.snapshot(), mining: { preview: ownedMining.preview }, getPreservedFloors: tunnelFloors, onPreserveFloor: point => {
      const floors = tunnelFloors()
      if (!point || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000) || point.y < -64 || point.y > 319) throw new Error('帰路の床の座標が不正です。')
      if (floors.some(floor => floor.x === point.x && floor.y === point.y && floor.z === point.z)) return
      if (floors.length >= 1024) throw new Error('帰路の床の保存上限に達したため掘削を停止します。')
      host.shared.tunnelFloors ??= { version: 1, scopes: {} }
      host.shared.tunnelFloors.scopes[tunnelScope] = { floors: [...floors, structuredClone(point)] }
    }, onProgress: data => { if (currentGeneration()) host.noteProgress(data) } })
    recovery = createRecovery({ getState: () => { requireGeneration(); return lightweightUserState() }, world: host.world, movement: recoveryMovement, getMovement: () => generationMovement.snapshot(), physics: generationPhysics, getDestination: navigationDestination, flatShoreOnly: true, getShoreDirection: state => {
      const remembered = shoreScore(state, state.position, state.position)
      return remembered ? { position: remembered.landmark.position, observationOnly: true, requiresWorldValidation: true } : null
    }, getAvoidance: state => {
      const threats = evaluateThreats(state, state.entities, { observationRadius: 32 })
      if (threats.requiresObservation || host.entities.stats?.().unknownPositions > threats.unknownPositions.length) { const error = new Error('岸への移動前に敵の位置を確認します。'); error.code = 'STALE_OBSERVATION'; throw error }
      if (threats.threats.length) { const error = new Error('近くの敵への自衛を優先します。'); error.code = 'NEARBY_THREAT'; throw error }
      return threats.outsideDanger.map(actor => ({ id: actor.runtimeId, position: { ...actor.position }, minDistance: actor.dangerRadius, padding: state.threatPolicy === 'online_learning' ? 0 : 0.5 }))
    }, onProgress: data => { if (currentGeneration()) host.noteProgress(data) } })
    function verifyForagingQueuedLanding (request) {
      try {
        requireGeneration()
        if (!request || !request.operationToken || typeof request.operationToken !== 'object' || request.signal?.aborted || typeof request.isCurrent !== 'function' || request.isCurrent() !== true || !generationForaging || foraging !== generationForaging || generationForaging.snapshot().busy !== true || !Number.isSafeInteger(host.shared.deathRespawn?.deathId) || host.shared.deathRespawn.deathId < 0) return null
        const binding = request.targetBinding
        if (!binding || binding.uniqueId == null || !['prey', 'drop'].includes(binding.kind)) return null
        const state = lightweightUserState(), life = actualLifeId(), key = JSON.stringify([String(binding.runtimeId), String(binding.uniqueId), binding.kind, binding.name, binding.dimension])
        const target = state.entities.find(e => String(e.runtimeId) === String(binding.runtimeId)), statusTarget = generationForaging.snapshot().target
        if (state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.inventory?.known !== true || state.inventory.uncertain || !target || String(target.uniqueId) !== String(binding.uniqueId) || target.dimension !== state.dimension || binding.dimension !== state.dimension || target.positionKnown !== true || !target.position || target.kind !== (binding.kind === 'drop' ? 'item' : 'mob') || (binding.kind === 'drop' ? target.name : target.entityType) !== binding.name || target.alive === false || target.protected || target.owned || target.tamed || target.isTamed || target.owner != null || target.ownerId != null || target.ownerUniqueId != null || String(statusTarget?.runtimeId) !== String(binding.runtimeId) || statusTarget?.kind !== binding.kind || statusTarget?.name !== binding.name) return null
        if (!Number.isSafeInteger(request.before?.lifecycle?.deathId) || request.before.lifecycle.deathId !== life || state.health !== request.before.health) return null
        const physical = state.predicted?.physicsState ?? state.physicsState, feet = { ...state.position, y: state.position.y - 1.62 }
        if (physical?.onGround !== true || physical.isInWater || physical.isInLava || !fullStandingGeometry(state, feet)) return null
        const witness = generationHistory.witness({ scope: historyScope(state), health: state.health, position: state.position })
        if (witness.ready !== true || witness.anchor?.kind !== 'server_correction' || witness.anchor.derived !== false || witness.anchor.physicsState?.onGround !== false || witness.queuedTicks < 2 || !queuedTailTrajectoryFree(witness)) return null
        const rawState = raw(), anchor = witness.anchor, stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        const previousStamp = stamp(request.before.rawServerPositionUpdatedAt ?? request.before.positionUpdatedAt), currentStamp = stamp(rawState.positionUpdatedAt)
        if (!Number.isFinite(request.startedAt) || !Number.isFinite(previousStamp) || !Number.isFinite(currentStamp) || !(currentStamp > previousStamp && currentStamp >= request.startedAt - 1000 && currentStamp <= Date.now() + 1000) || stamp(anchor.rawStamp) !== currentStamp || stamp(state.rawServerPositionUpdatedAt) !== currentStamp || !['x', 'y', 'z'].every(k => anchor.rawPosition[k] === rawState.position[k] && state.rawServerPosition[k] === rawState.position[k])) return null
        const correction = host.shared.lastServerCorrection, motionAt = stamp(host.shared.lastServerMotion?.receivedAt)
        if (correction?.accepted !== true || correction.source !== 'correct_player_move_prediction' || String(correction.tick) !== witness.anchorTick || correction.onGround !== false || !['x', 'y', 'z'].every(k => correction.position?.[k] === rawState.position[k]) || Number.isFinite(motionAt) && motionAt >= anchor.receivedAt) return null
        if (!['x', 'y', 'z'].every(k => Math.abs(witness.expectedPosition[k] - state.position[k]) <= 1e-4 && Math.abs(witness.physicsState.position[k] - physical.position[k]) <= 1e-4 && Math.abs(witness.physicsState.velocity[k] - physical.velocity[k]) <= 1e-4)) return null
        const audit = queuedForageLandingFrames
        if (audit.length !== 2 || BigInt(audit[1].tick) !== BigInt(audit[0].tick) + 1n || generationHistory.snapshot().latestTick !== audit[1].tick || generationStream.stats().tick !== audit[1].tick || generationStream.stats().lastError != null || Date.now() < audit[1].at || Date.now() - audit[1].at > 200 || witness.tick !== audit[1].tick) return null
        for (const frame of audit) {
          const replay = witness.physicsTrace.find(p => p.tick === frame.tick)
          if (!replay || frame.life !== life || frame.scope !== userScope(state) || frame.health !== state.health || frame.forceRevision !== userBehaviorForceRevision || frame.rawStamp !== rawState.positionUpdatedAt || frame.anchorTick !== witness.anchorTick || frame.leaseAt !== anchor.leaseAt || BigInt(frame.tick) <= BigInt(witness.anchorTick) || !['x', 'y', 'z'].every(k => frame.rawPosition[k] === rawState.position[k] && Math.abs(replay.physicsState.position[k] - frame.physicsState.position[k]) <= 1e-4 && Math.abs(replay.physicsState.velocity[k] - frame.physicsState.velocity[k]) <= 1e-4) || !fullStandingGeometry({ position: frame.packetPosition, predicted: { physicsState: frame.physicsState } }, frame.physicsState.position)) return null
        }
        if (!['x', 'y', 'z'].every(k => Math.abs(audit[1].packetPosition[k] - state.position[k]) <= 1e-4)) return null
        const owner = foragingLandingOwners.get(request.operationToken)
        if (owner && (owner.signal !== request.signal || owner.isCurrent !== request.isCurrent || owner.targetKey !== key || owner.life !== life || owner.scope !== userScope(state))) return null
        if (!owner) foragingLandingOwners.set(request.operationToken, { signal: request.signal, isCurrent: request.isCurrent, targetKey: key, life, scope: userScope(state) })
        const lease = { operationToken: request.operationToken, signal: request.signal, isCurrent: request.isCurrent, targetKey: key, life, scope: userScope(state), health: state.health, rawStamp: rawState.positionUpdatedAt, rawPosition: { ...rawState.position }, anchorTick: witness.anchorTick, leaseAt: anchor.leaseAt, forceRevision: userBehaviorForceRevision, tick: witness.tick, position: { ...state.position }, velocity: { ...physical.velocity } }
        if (request.mode === 'prepare') { const proof = Object.freeze({}); foragingLandingProofs.set(proof, lease); return proof }
        if (request.mode !== 'consume' || !request.proof) return null
        const saved = foragingLandingProofs.get(request.proof)
        if (!saved || ['operationToken', 'signal', 'isCurrent', 'targetKey', 'life', 'scope', 'health', 'rawStamp', 'anchorTick', 'leaseAt', 'forceRevision', 'tick'].some(k => saved[k] !== lease[k]) || !['x', 'y', 'z'].every(k => saved.rawPosition[k] === lease.rawPosition[k] && Math.abs(saved.position[k] - lease.position[k]) <= 1e-4 && Math.abs(saved.velocity[k] - lease.velocity[k]) <= 1e-4) || request.isCurrent() !== true || request.signal.aborted) return null
        foragingLandingProofs.delete(request.proof)
        return request.proof
      } catch { return null }
    }

    generationForaging = createForaging({ getState: () => { requireGeneration(); const state = observedState(); return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: Number.isSafeInteger(host.shared.deathRespawn?.deathId) ? actualLifeId() : null } } }, verifyQueuedLanding: verifyForagingQueuedLanding, world: host.world, entities: host.entities, movement: ownedMovement, getMovement: () => generationMovement.snapshot(), combat: { previewHunt: own(id => generationCombat.previewHunt(id)), hunt: own(id => operations.combat.hunt(id)), cancel: reason => generationCombat.cancel(reason) }, onProgress: data => { if (currentGeneration()) host.noteProgress(data) } })
    foraging = generationForaging
    const generationSurfaceReturn = createSurfaceReturn({ getState: () => { requireGeneration(); return lightweightUserState() }, world: host.world, physics: generationPhysics, getQueuedCursor: () => actualWireClock.snapshot(), movement: { ...ownedMovement, drain: () => generationMovement.drain?.() }, getMovement: () => generationMovement.snapshot(), canAct: ({ operationId, scope }) => {
      if (!currentGeneration() || !surfaceReturnOwner || surfaceReturnOwner.scope !== scope || scope !== returnScope(lightweightUserState())) return false
      if (surfaceReturnOwner.operationId === null) surfaceReturnOwner.operationId = operationId
      return surfaceReturnOwner.operationId === operationId
    }, onProgress: value => { if (currentGeneration()) { host.shared.surfaceReturnStatus = { ...value, at: new Date().toISOString() }; host.noteProgress({ type: 'surface_return', ...value }) } } })
    surfaceReturn = generationSurfaceReturn
    const depotAdmission = () => currentGeneration() && !disposed && !disposing && depotMission?.isEnabled() === true && !userBehaviorOwns() && !idleSafety?.snapshot().busy
    depotBuilder = createWorksiteCamp({getState:prebuildState,world:host.world,crafting,interactions,inventory:backgroundInventory,movement:ownedMovement,getMovement:()=>generationMovement.snapshot(),getSurface:()=>host.shared.depotSurfaceAnchor,getDepotMemo:()=>depotMission?.extra().campBuilder ?? null,getQueuedCursor:()=>inputHistory?.snapshot().cursor,canAct:depotAdmission})
    depotStorage = createDepotStorageWork({ getState: () => lightweightUserState(), world: host.world, crafting, interactions, chest, inventory:backgroundInventory, validate: depotAdmission })
    const baseMovement = createBaseMovement({ movement: ownedMovement, getState: () => { requireGeneration(); return observedState() }, getUnknownPositionCount: () => host.entities.stats?.().unknownPositions })
    const generationShelter = createShelter({ getState: () => { requireGeneration(); return observedState() }, world: host.world, planner: planShelter, mining: ownedMining, getMining: own(() => mining.snapshot()), movement: baseMovement, getMovement: () => generationMovement.snapshot(), inventory: { equip: own(slot => operations.inventory.equip(slot)) }, interactions: { previewPlace: own(data => interactions.previewPlace(data)), placeBlock: own(data => operations.interactions.placeBlock(data)) }, memo: host.shared.shelterMemo, maxTotalActions: 512, onProgress: data => { if (currentGeneration()) noteShelterProgress(data) } })
    shelter = generationShelter
    const generationHut = createHut({ getState: () => { requireGeneration(); return observedState() }, world: host.world, planner: planHut, mining: ownedMining, getMining: own(() => mining.snapshot()), movement: baseMovement, getMovement: () => generationMovement.snapshot(), inventory: { equip: own(slot => operations.inventory.equip(slot)), cancel: cancelBackgroundInventory }, interactions: { previewPlace: own(data => interactions.previewPlace(data)), placeBlock: own(data => operations.interactions.placeBlock(data)), cancel: reason => { if (!combatOwnsInput()) interactions.cancel(reason) } }, memo: host.shared.hutMemo, maxActions: 32, maxTotalActions: 512, onProgress: data => { if (currentGeneration()) noteHutProgress(data) } })
    hut = generationHut
    const routeScope = state => ({ profile: state.profile, realmId: state.realm?.id == null ? null : String(state.realm.id), dimension: state.dimension })
    const sameRouteScope = (a, b) => a?.profile != null && a.profile === b?.profile && a.realmId != null && String(a.realmId) === String(b?.realmId) && a.dimension === b?.dimension
    let inspectIdleEscape = null
    const routeState = () => {
      requireGeneration()
      const state = { ...observedState(), entityStats: host.entities.stats?.(), hut: host.shared.hutMemo?.site ? generationHut.snapshot() : null, shelter: host.shared.shelterMemo?.site ? generationShelter.snapshot() : null, food: food.snapshot(), vitals: structuredClone(host.shared.vitals ?? {}), crafting: crafting.snapshot(), movement: generationMovement.snapshot() }
      inspectIdleEscape?.(state)
      return state
    }
    function fullStandingGeometry (state, target) {
      const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
      if (!finite(state.position) || !finite(target)) return false
      const feet = { ...state.position, y: state.position.y - 1.62 }
      if (Math.hypot(feet.x - target.x, feet.z - target.z) > 0.5 || Math.abs(feet.y - target.y) > 0.05) return false
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround === false || physical?.isInWater || physical?.isInLava || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return false
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      const minX = feet.x - 0.3; const maxX = feet.x + 0.3; const minZ = feet.z - 0.3; const maxZ = feet.z + 0.3
      try {
        const columns = []
        let contactTop = null
        for (let x = Math.floor(minX + 1e-4); x <= Math.floor(maxX - 1e-4); x++) for (let z = Math.floor(minZ + 1e-4); z <= Math.floor(maxZ - 1e-4); z++) {
          const support = generationPhysics.blockAt({ x, y: Math.floor(feet.y - 1e-4), z })
          const surface = support.shapes.find(box => Math.abs(support.position.y + box[4] - feet.y) <= 1e-4 && x + box[0] <= Math.max(minX, x) + 1e-7 && x + box[3] >= Math.min(maxX, x + 1) - 1e-7 && z + box[2] <= Math.max(minZ, z) + 1e-7 && z + box[5] >= Math.min(maxZ, z + 1) - 1e-7)
          if (hazard.test(support.name) || !surface) return false
          const top = support.position.y + surface[4]
          if (contactTop !== null && Math.abs(top - contactTop) > 1e-7) return false
          contactTop = top
          columns.push({ x, z })
        }
        // The entire footprint has a received coplanar surface. Only its body
        // bottom gets the same 1e-4 float32 contact skin as the physics model;
        // raw position, head height and horizontal collision remain untouched.
        for (const { x, z } of columns) {
          for (let y = Math.floor(feet.y + 1e-7); y <= Math.floor(feet.y + 1.8 - 1e-7); y++) {
            const body = generationPhysics.blockAt({ x, y, z })
            if (hazard.test(body.name) || body.shapes.some(box => maxX > x + box[0] + 1e-4 && minX < x + box[3] - 1e-4 && feet.y + 1.8 > y + box[1] + 1e-7 && feet.y < y + box[4] - 1e-4 && maxZ > z + box[2] + 1e-4 && minZ < z + box[5] - 1e-4)) return false
          }
        }
        return true
      } catch { return false }
    }

    function verifyRouteStanding (observed, target, { signal } = {}) {
      requireGeneration()
      if (signal?.aborted) throw signal.reason ?? new Error('経路の接地確認を中断しました。')
      const state = working()
      if (![observed?.position, state.position].every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) || !sameRouteScope(routeScope(state), routeScope(observed)) || Math.hypot(state.position.x - observed.position.x, state.position.y - observed.position.y, state.position.z - observed.position.z) > 0.05 || !fullStandingGeometry(state, target)) return false
      try {
        motionOrigin = state
        return generationMovement.preview({ ...state.position, y: state.position.y - 1.62 }, { emergency: true, allowWater: false, maxDistance: 1, maxExpanded: 32 })?.ready === true
      } catch { return false }
    }

    function queuedTailTrajectoryFree (witness) {
      const trace = witness?.physicsTrace
      if (!Array.isArray(trace) || trace.length < 2 || trace.length > 81) return false
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      try {
        for (const frame of trace) {
          const physical = frame.physicsState; const feet = physical?.position
          if (!feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis])) || physical.isInWater || physical.isInLava) return false
          for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) for (let y = Math.floor(feet.y + 1e-6); y <= Math.floor(feet.y + 1.8 - 1e-6); y++) {
            const block = generationPhysics.blockAt({ x, y, z })
            if (hazard.test(block.name) || block.shapes.some(box => feet.x + 0.3 > x + box[0] + 1e-4 && feet.x - 0.3 < x + box[3] - 1e-4 && feet.y + 1.8 > y + box[1] + 1e-6 && feet.y < y + box[4] - 1e-4 && feet.z + 0.3 > z + box[2] + 1e-4 && feet.z - 0.3 < z + box[5] - 1e-4)) return false
          }
        }
        return true
      } catch { return false }
    }

    function queuedTailWitness (state, originMode = 'target_landing') {
      if (!currentGeneration() || state.phase !== 'spawned' || state.dead || state.loading || state.spawnPending || state.inventory?.known !== true || state.inventory.uncertain) return null
      const witness = generationHistory.witness({ scope: historyScope(state), health: state.health, position: state.position })
      if (!witness.ready || witness.navigationQueued < 1 || witness.queuedTicks < 1 || !witness.anchor?.physicsState || witness.anchor.rawStamp !== state.rawServerPositionUpdatedAt || !state.rawServerPosition || ['x', 'y', 'z'].some(axis => witness.anchor.rawPosition[axis] !== state.rawServerPosition[axis])) return null
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (originMode === 'trajectory_landing') {
        // Only an exact received correction can begin the airborne branch.
        // Independent queued replay must actually land at the current model;
        // the history's wider contradiction bound cannot authorize a shadow.
        if (witness.anchor.kind !== 'server_correction' || witness.anchor.derived !== false || physical?.onGround !== true || witness.physicsState?.onGround !== true || Math.hypot(witness.expectedPosition.x - state.position.x, witness.expectedPosition.y - state.position.y, witness.expectedPosition.z - state.position.z) > 0.05 || !queuedTailTrajectoryFree(witness)) return null
        routeOriginNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, physics: generationPlanningPhysics })
        if (!routeOriginNavigator.verifyOrigin(witness.physicsState, { stablePartialOrigin: true }) || !verifyRouteOrigin(state, { ...state.position, y: state.position.y - 1.62 }, { stablePartialOrigin: true })) return null
        return witness
      }
      if (physical?.onGround !== true || witness.anchor.physicsState.onGround !== true || !fullStandingGeometry(state, { ...state.position, y: state.position.y - 1.62 })) return null
      const anchored = { ...state, position: witness.anchor.rawPosition, predicted: { physicsState: witness.anchor.physicsState } }
      if (!fullStandingGeometry(anchored, { ...anchored.position, y: anchored.position.y - 1.62 })) return null
      return witness
    }

    function verifyQueuedTail (state, context) {
      try {
        requireSafety()
        const current = working()
        if (!sameRouteScope(routeScope(state), routeScope(current)) || Math.hypot(current.position.x - state.position.x, current.position.y - state.position.y, current.position.z - state.position.z) > 0.05 || !context?.receiptKey || typeof context.validateTail !== 'function') return null
        const originMode = context.originMode === 'trajectory_landing' ? 'trajectory_landing' : 'target_landing'
        const witness = queuedTailWitness(state, originMode)
        const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        if (!witness || !(stamp(witness.anchor.rawStamp) > stamp(context.previousPose?.stamp)) || originMode === 'target_landing' && (Math.hypot(state.rawServerPosition.x - context.target.x, state.rawServerPosition.z - context.target.z) > 0.4 || Math.abs(state.rawServerPosition.y - 1.62 - context.target.y) > 1e-4)) return null
        queuedTailProofs.set(context.receiptKey, { operationId: owners.escape?.operationId ?? null, health: state.health, originMode, anchorTick: witness.anchorTick, rawPosition: structuredClone(state.rawServerPosition), rawStamp: state.rawServerPositionUpdatedAt, validateTail: context.validateTail })
        return witness
      } catch { return null }
    }

    async function verifyQueuedTailHandoff (result, observed, { signal, operationId } = {}) {
      const proof = result?.queuedTailKey && queuedTailProofs.get(result.queuedTailKey)
      if (!proof || proof.operationId !== operationId || signal?.aborted) return false
      const coherent = state => {
        if (state.health !== proof.health || state.rawServerPositionUpdatedAt !== proof.rawStamp || !state.rawServerPosition || ['x', 'y', 'z'].some(axis => state.rawServerPosition[axis] !== proof.rawPosition[axis])) return false
        const witness = queuedTailWitness(state, proof.originMode)
        return !!witness && witness.anchorTick === proof.anchorTick && proof.validateTail(state, witness)
      }
      const origin = state => proof.originMode === 'trajectory_landing' ? verifyRouteOrigin(state, { ...state.position, y: state.position.y - 1.62 }, { signal, stablePartialOrigin: true }) : verifyRouteStanding(state, { ...state.position, y: state.position.y - 1.62 }, { signal })
      if (!coherent(observed) || !await origin(observed)) return false
      const current = safetyState()
      return coherent(current) && origin(current) ? current : null
    }

    async function verifyCompletedDryProgress (result, observed, { signal, operationId } = {}) {
      requireSafety()
      const proof = result && completedDryProofs.get(result)
      if (!proof || proof.operationId !== operationId || signal?.aborted) return false
      const coherent = state => {
        if (!currentGeneration() || state.health !== proof.health || state.phase !== 'spawned' || state.dead || state.loading || state.spawnPending) return false
        if (state.rawServerPositionUpdatedAt !== proof.rawStamp || !state.rawServerPosition || ['x', 'y', 'z'].some(axis => state.rawServerPosition[axis] !== proof.rawPosition[axis])) return false
        const witness = generationHistory.witness({ scope: historyScope(state), health: state.health, position: state.position })
        return witness.ready === true && witness.revision >= proof.revision && witness.anchorTick === proof.anchorTick && witness.anchor?.kind === proof.anchorKind && witness.anchor?.checkpointTick === proof.checkpointTick && witness.anchor?.leaseAt === proof.leaseAt && witness.anchor?.rawStamp === proof.rawStamp && ['x', 'y', 'z'].every(axis => witness.anchor?.rawPosition?.[axis] === proof.rawPosition[axis]) && witness.navigationQueued >= proof.navigationQueued && witness.queuedTicks > 0
      }
      if (!coherent(observed) || !await verifyRouteStanding(observed, { ...observed.position, y: observed.position.y - 1.62 }, { signal })) return false
      // Full received standing and the exact anchor must still hold after the
      // verifier yields. The caller separately pins/rechecks the actor roster.
      const current = safetyState()
      return coherent(current) && Math.hypot(current.position.x - observed.position.x, current.position.y - observed.position.y, current.position.z - observed.position.z) <= 0.05 && verifyRouteStanding(current, { ...current.position, y: current.position.y - 1.62 }, { signal })
    }

    let routeOriginNavigator = null
    function verifyRouteOrigin (observed, target, { signal, stablePartialOrigin = false } = {}) {
      if (verifyRouteStanding(observed, target, { signal })) return true
      if (!stablePartialOrigin) return false
      requireGeneration()
      if (signal?.aborted) throw signal.reason ?? new Error('経路の開始位置確認を中断しました。')
      const state = working()
      const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
      if (!finite(state.position) || !finite(observed?.position) || !finite(target) || !sameRouteScope(routeScope(state), routeScope(observed)) || Math.hypot(state.position.x - observed.position.x, state.position.y - observed.position.y, state.position.z - observed.position.z) > 0.05) return false
      const feet = { ...state.position, y: state.position.y - 1.62 }
      if (Math.hypot(feet.x - target.x, feet.z - target.z) > 0.05 || Math.abs(feet.y - target.y) > 0.05) return false
      try {
        routeOriginNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, physics: generationPlanningPhysics })
        if (!routeOriginNavigator.verifyOrigin(routeOriginNavigator.physics.fromServer(state), { stablePartialOrigin: true })) return false
        motionOrigin = state
        return true
      } catch { return false }
    }

    const routeMovement = {
      preview: own((target, options) => { motionOrigin = working(); return generationMovement.preview(target, options) }),
      start: own((target, options) => { crafting.closeContainer(); stopIdleStream(); idlePhysicsState = null; motionOrigin = working(); host.shared.motionSource = 'navigation'; return generationMovement.start(target, options) }),
      settle: own(options => { stopIdleStream(); idlePhysicsState = null; motionOrigin = working(); host.shared.motionSource = 'navigation_settle'; return generationMovement.settle(options) }),
      stop: reason => { if (!combatOwnsInput()) return generationMovement.stop(reason) }
    }
    const routeInventory = {
      equip: own(async (slot, { signal } = {}) => {
        const cancel = () => { if (currentGeneration()) cancelBackgroundInventory('経路の持ち替えを中断しました。') }
        if (signal?.aborted) throw signal.reason ?? new Error('経路の持ち替えを中断しました。')
        signal?.addEventListener('abort', cancel, { once: true })
        try { const result = await inventory.equip(slot); requireGeneration(); if (result.serverConfirmed) host.shared.equipment = null; return result } finally { signal?.removeEventListener('abort', cancel) }
      }),
      cancel: reason => { if (currentGeneration()) cancelBackgroundInventory(reason) }
    }
    const closeReturnedHut = own(context => host.shared.depotHutUpgraded === true ? {supported:false,serverConfirmed:false,reason:'OWNED_DEPOT_LAYOUT'} : generationHut.execute({}, { signal: context.signal }))
    const generationGuardRoute = createGuardedRoute({
      getState: routeState, movement: routeMovement, getMovement: own(() => generationMovement.snapshot()), inventory: routeInventory,
      combat: { previewEngage: own(id => generationCombat.previewEngage(id)), engage: own((id, options) => generationCombat.engage(id, options)), preview: own(id => generationCombat.preview(id)), attack: own(id => generationCombat.attack(id)), cancel: reason => generationCombat.cancel(reason), drain: () => generationCombat.drain() },
      verifyStanding: verifyRouteStanding,
      verifyOrigin: verifyRouteOrigin,
      verifyQueuedTail,
      closeContainer: own(() => crafting.closeContainer()),
      onReturned: async (returned, context) => {
        requireGeneration()
        if (context.signal?.aborted) throw context.signal.reason ?? new Error('小屋の再閉鎖を中断しました。')
        const state = routeState(); const memo = host.shared.hutMemo; const site = memo?.site; const origin = context.visitedPrefix?.[0]
        const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
        if (site?.type !== 'soil_hut' || !finite(site.center) || !Number.isInteger(site.forward?.x) || !Number.isInteger(site.forward?.z) || Math.abs(site.forward.x) + Math.abs(site.forward.z) !== 1 || !finite(origin) || !sameRouteScope(routeScope(state), context.scope) || memo.scope?.dimension !== state.dimension || memo.scope?.realmId == null || String(memo.scope.realmId) !== String(state.realm?.id) || memo.ownerProfile != null && memo.ownerProfile !== state.profile) return { skipped: true, reason: '帰路の開始点に一致する記憶済みの小屋がありません。' }
        const doorway = { x: site.center.x - site.forward.x + 0.5, y: site.center.y, z: site.center.z - site.forward.z + 0.5 }
        const feet = { ...state.position, y: state.position.y - 1.62 }
        if (Math.hypot(origin.x - doorway.x, origin.y - doorway.y, origin.z - doorway.z) > 1.25 || Math.hypot(feet.x - origin.x, feet.y - origin.y, feet.z - origin.z) > 0.6 || Math.hypot(returned.position.x - state.position.x, returned.position.y - state.position.y, returned.position.z - state.position.z) > 0.05) return { skipped: true, reason: '遠い帰路の開始点から小屋へ移動する処理は行いません。' }
        const handoffOrigin = state
        const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        const fresh = (next, previous) => Number.isFinite(stamp(next)) && Number.isFinite(stamp(previous)) && stamp(next) > stamp(previous)
        const ready = async current => {
          requireGeneration()
          if (context.signal?.aborted) throw context.signal.reason ?? new Error('小屋への帰還を中断しました。')
          const failure = (message, code) => Object.assign(new Error(message), { code })
          if (current.dead || current.isDead || current.phase !== 'spawned' || !(current.health > 6)) throw failure('小屋へ戻る現在の生存状態を確認できません。', 'DEAD')
          if (!sameRouteScope(routeScope(current), routeScope(handoffOrigin)) || ['connectionId', 'startedAt', 'runtimeEntityId'].some(field => handoffOrigin[field] != null && String(current[field]) !== String(handoffOrigin[field]))) throw failure('小屋へ戻るセッションが変わりました。', 'SESSION_CHANGED')
          if (current.health < handoffOrigin.health) throw failure('小屋への帰還中に被ダメージを確認しました。', 'TOOK_DAMAGE')
          if (current.inventory?.known !== true || current.inventory.uncertain) throw failure('小屋を閉じる持ち物が未確定です。', 'INVENTORY_UNKNOWN')
          if (!await verifyRouteStanding(current, { ...current.position, y: current.position.y - 1.62 }, { signal: context.signal })) throw failure('小屋を閉じ直す前の実支持を確認できません。', 'SUPPORT_UNKNOWN')
        }
        let attempts = 0
        for (let batch = 0; batch < 3; batch++) {
          const before = routeState()
          try {
            await ready(before)
            attempts++
            const result = await closeReturnedHut(context)
            await ready(routeState())
            return { ...result, hutHandoffAttempts: attempts }
          } catch (error) {
            error.hutHandoffAttempts = attempts
            if (error.code !== 'REPLAN_REQUIRED' || batch === 2) throw error
            const after = routeState()
            try { await ready(after) } catch (unsafe) { unsafe.hutHandoffAttempts = attempts; unsafe.hutHandoffCause = { code: error.code, reason: error.message }; throw unsafe }
            if (!fresh(after.positionUpdatedAt, before.positionUpdatedAt) && !fresh(after.rawServerPositionUpdatedAt, before.rawServerPositionUpdatedAt)) { error.hutHandoffRetryBlockedBy = 'stale_pose'; throw error }
          }
        }
        throw new Error('小屋を閉じる有限再試行が終了しました。')
      },
      onProgress: data => {
        if (!currentGeneration()) return
        const reached = data.reached && ['x', 'y', 'z'].every(axis => Number.isFinite(data.reached[axis])) ? data.reached : guardRouteProgress?.lastReached ?? null
        guardRouteProgress = { ...structuredClone(data), lastReached: structuredClone(reached), scope: routeScope(working()) }
        host.noteProgress({ type: 'guard_route', ...structuredClone(guardRouteProgress) })
      }
    })
    guardRouteProgress = null
    guardRoute = generationGuardRoute
    const safetyScope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId)])
    const safetyOriginScope = safetyScope(raw())
    const safetyCurrent = () => currentGeneration() && safetyScope(raw()) === safetyOriginScope && !combatOwnsInput()
    const requireSafety = () => { requireGeneration(); if (!safetyCurrent()) throw new Error('待機保護のワールド・プレイヤーが変わりました。') }
    const owners = { inventory: null, combat: null, hut: null, escape: null }
    let emergencyMiningOp = null
    let emergencyDropOp = null
    let emergencyWaterCounterOp = null
    async function safetyOwn (kind, context, fn) {
      requireSafety()
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('待機保護を中断しました。')
      const record = { operationId: context.operationId }
      owners[kind] = record
      try { const result = await own(fn)(); requireSafety(); return result } finally { if (owners[kind] === record) owners[kind] = null }
    }
    let recentUserSafetyObservation = null
    const safetyState = () => {
      requireSafety()
      const state = { ...routeState(), loading: !host.shared.loadingScreenEnded, loadingScreenEnded: host.shared.loadingScreenEnded === true, world: host.world.stats() }
      // Keep the raw entity catalogue intact. This safety view omits only
      // known non-intercepting actors; unknown access remains an observation.
      state.entities = state.entities.filter(actor => {
        if (actor.hostile !== true || actor.alive === false || actor.primed === true) return true
        const exposure = combatAttackExposure(actor, state)
        // A forbidden combat profile (boss/avoid-only) is still dangerous.
        // Only current, known attack-access/recognition negatives suppress it.
        if (exposure.reason === 'PROFILE_DISALLOWS_ENGAGEMENT') return true
        if (!exposure.unknown && exposure.evidence.sight === false) return false
        return exposure.unknown || !['ENEMY_ATTACK_ROUTE_BLOCKED', 'PROJECTILE_SIGHT_BLOCKED', 'NO_CURRENT_RECOGNITION'].includes(exposure.reason)
      })
      recentUserSafetyObservation = { state, at: Date.now(), scope: userScope(state) }
      return state
    }
    function safetyIdle (context = {}) {
      if (!safetyCurrent() || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy) return false
      if (userBehaviorOwns()) return false
      const ownActor = kind => context.operationId != null && owners[kind]?.operationId === context.operationId
      const ownHut = ownActor('hut')
      const ownEscape = ownActor('escape')
      const ownEmergencyMining = ownEscape && emergencyMiningOp === context.operationId
      // A fresh manual request cannot postpone an already active defense episode.
      // Actual foreign actor ownership always takes precedence over this monitor.
      if (!context.episodeActive && (pendingStops.size || Date.now() - (host.shared.safetyManualActionAt ?? 0) < 500)) return false
      // Read-only autonomy observations do not own survival, including at the
      // initial handoff. Only its dispatched action blocks that handoff; all
      // concrete foreign actor checks below retain their ownership rules.
      const protectedEpisode = context.episodeActive && idleSafety?.snapshot().busy === true
      if ((!ownEscape && generationGuardRoute.snapshot().busy) || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || (foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) || generationShelter.snapshot().busy || (!protectedEpisode && autonomy.snapshot().actionActive === true) || food.snapshot().busy || (furnace.snapshot().busy || chest.snapshot().busy) || craftStatus().pendingRequestId != null) return false
      if ((!ownHut && (generationHut.snapshot().busy || !ownEmergencyMining && mining.snapshot().phase === 'mining' || interactions.snapshot().pendingOperation)) || (!ownHut && !ownEscape && motionActive())) return false
      if (!ownHut && !ownEscape && !ownActor('inventory') && inventory.snapshot().busy) return false
      const fight = generationCombat.snapshot()
      if (!ownEscape && !ownActor('combat') && (fight.busy || fight.defending || fight.engaging)) return false
      if (!ownHut && !ownEscape && !ownActor('combat') && generationInput.stats().running) return false
      return true
    }
    function verifyStrikeBody (observed, { signal } = {}) {
      requireGeneration()
      if (signal?.aborted) return false
      const state = working(); const p = state.position
      if (!p || !observed?.position || !sameRouteScope(routeScope(state), routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05) return false
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.isInWater || physical?.isInLava) return false
      const foot = p.y - 1.62, minX = p.x - 0.3, maxX = p.x + 0.3, minZ = p.z - 0.3, maxZ = p.z + 0.3
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      try {
        // Match the physics model's float32 contact skin without changing
        // the received pose: micron-scale edge contact is not penetration.
        for (let x = Math.floor(minX + 1e-4); x <= Math.floor(maxX - 1e-4); x++) for (let z = Math.floor(minZ + 1e-4); z <= Math.floor(maxZ - 1e-4); z++) for (let y = Math.floor(foot + 1e-7); y <= Math.floor(foot + 1.8 - 1e-7); y++) {
          const block = generationPhysics.blockAt({ x, y, z })
          if (hazard.test(block.name) || block.shapes.some(box => maxX > x + box[0] + 1e-4 && minX < x + box[3] - 1e-4 && foot + 1.8 > y + box[1] + 1e-7 && foot < y + box[4] - 1e-4 && maxZ > z + box[2] + 1e-4 && minZ < z + box[5] - 1e-4)) return false
        }
        return true
      } catch { return false }
    }
    function strikeBodyDiagnostic (observed, { signal } = {}) {
      requireGeneration()
      const state = working()
      return diagnoseStrikeBody({ state, observed, signal,
        scopeMatches: !!observed?.position && sameRouteScope(routeScope(state), routeScope(observed)),
        blockAt: position => generationPhysics.blockAt(position) })
    }
    // Stationary combat can continue on a partially supported edge, but only
    // when the received collision shapes prove contact and every floor cell
    // beneath the footprint is known and harmless. Walking keeps its stricter
    // full-footprint route check.
    function verifyMeleeBody (observed, context = {}) {
      if (!verifyStrikeBody(observed, context)) return false
      const state = working(); const p = state.position
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround === false || physical?.isInWater || physical?.isInLava || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return false
      const feet = { x: p.x, y: p.y - 1.62, z: p.z }
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      try {
        for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
          const floor = generationPhysics.blockAt({ x, y: Math.floor(feet.y - 1e-4), z })
          if (hazard.test(floor.name)) return false
        }
        return generationPhysics.hasSupport(feet)
      } catch { return false }
    }
    function verifyUnarmedBody (observed, { continuation = false } = {}) {
      const physical = observed.predicted?.physicsState ?? observed.physicsState
      // A received upward impulse can precede the next on-ground flag. Prove
      // the dry body without rewriting that flag or inventing floor contact.
      if (physical?.onGround === false || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return continuation && ['x', 'y', 'z'].every(axis => Number.isFinite(physical.velocity?.[axis])) && verifyStrikeBody(observed)
      return verifyMeleeBody(observed) || verifyRouteOrigin(observed, { ...observed.position, y: observed.position.y - 1.62 }, { stablePartialOrigin: true })
    }
    // A dry, grounded shoreline can have water under one edge of the player.
    // This only permits recentering, never stationary combat or swimming.
    function verifyLedgeBody (observed, context = {}) {
      if (verifyMeleeBody(observed, context)) return true
      if (!verifyStrikeBody(observed, context)) return false
      const state = working(); const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround !== true || physical?.isInWater || physical?.isInLava || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return false
      const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
      const y = Math.floor(feet.y - 1e-4); let water = false
      const cube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
      try {
        for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
          const floor = generationPhysics.blockAt({ x, y, z })
          if (['water', 'flowing_water'].includes(floor.name) && floor.shapes.length === 0) { water = true; continue }
          if (!cube(floor) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(floor.name)) return false
          if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
            let stable = false
            for (let depth = 1; depth <= 8; depth++) {
              const below = generationPhysics.blockAt({ x, y: y - depth, z })
              if (!cube(below) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(below.name)) return false
              if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
            }
            if (!stable) return false
          }
        }
        return water && generationPhysics.hasSupport(feet)
      } catch { return false }
    }
    function shallowWaterTerrain (point, surfaceY, { allowDeepSurface = false, allowBriefSubmerge = false } = {}) {
      const fullCube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
      try {
        // Keep the modelled eye at least 0.02 blocks above the water surface.
        // Server corrections can legitimately put the feet deeper than 1.05
        // blocks even when the player's head is still in air.
        if (!point || !['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) || !Number.isInteger(surfaceY) || point.y < surfaceY - (allowBriefSubmerge ? 1.85 : 1.60)) return false
        for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
          const layer = generationPhysics.blockAt({ x, y: surfaceY - 1, z })
          if (['water', 'flowing_water'].includes(layer.name)) {
            // Keep the head above the received surface. A surface retreat can
            // cross deeper water only when five consecutive liquid layers are
            // known; no bottom or deeper terrain is inferred from that proof.
            if (!Number.isInteger(layer.metadata) || layer.metadata < 0 || layer.metadata >= 8) return false
            let floor = null; let floorY = null
            for (let depth = 1; depth <= 4; depth++) {
              const block = generationPhysics.blockAt({ x, y: surfaceY - 1 - depth, z })
              if (['water', 'flowing_water'].includes(block.name)) {
                if (!Number.isInteger(block.metadata) || block.metadata < 0 || block.metadata >= 8) return false
                continue
              }
              floor = block; floorY = surfaceY - 1 - depth; break
            }
            if (!floor && !allowDeepSurface) return false
            if (floor && (!fullCube(floor) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(floor.name))) return false
            if (floor && /^(?:sand|red_sand|gravel)$/.test(floor.name)) {
              let stable = false
              for (let depth = 1; depth <= 8; depth++) {
                const below = generationPhysics.blockAt({ x, y: floorY - depth, z })
                if (!fullCube(below) || /(?:lava|fire|cactus|magma|campfire|concrete_powder|anvil)/.test(below.name)) return false
                if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
              }
              if (!stable) return false
            }
          } else if (!fullCube(layer) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(layer.name)) return false
          const head = generationPhysics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
          const submergedHead = allowBriefSubmerge && ['water', 'flowing_water'].includes(head.name) && Number.isInteger(head.metadata) && head.metadata >= 0 && head.metadata < 8
          if (head.shapes.length || !submergedHead && /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/.test(head.name)) return false
          if (submergedHead) {
            const above = generationPhysics.blockAt({ x, y: surfaceY, z })
            if (above.shapes.length || !['air', 'cave_air', 'void_air'].includes(above.name)) return false
          }
        }
        return true
      } catch { return false }
    }
    function verifyShallowWater (observed, { signal, allowDeepSurface = false } = {}) {
      if (signal?.aborted) return false
      const state = working(); const p = state.position; const physical = state.predicted?.physicsState ?? state.physicsState
      if (!p || !observed?.position || !sameRouteScope(routeScope(state), routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05 || physical?.isInLava) return false
      const feet = { ...p, y: p.y - 1.62 }
      try {
        const surface = generationPhysics.waterSurface(feet)
        if (!surface) return false
        // On a new spawn the physics model can initially report isInWater
        // false before its first tick. A received water block actually around
        // the feet and a dry, shallow column are independent evidence.
        const contact = generationPhysics.blockAt(feet)
        const knownContact = ['water', 'flowing_water'].includes(contact.name) && feet.y < surface.surfaceY - 0.05
        // Immediately after a server-confirmed spawn there may be no local
        // physics frame yet. Known water at the received pose and the same
        // complete shallow-column checks are sufficient to run a preview;
        // they do not invent an on-ground or velocity observation.
        const unseededServerPose = !physical && state.positionSource !== 'client_prediction' && state.positionServerConfirmed !== false && knownContact
        return (physical?.isInWater === true || physical?.onGround === false && knownContact || unseededServerPose) && shallowWaterTerrain(feet, surface.surfaceY, { allowDeepSurface })
      } catch { return false }
    }
    function verifyNearSurfaceWater (observed, { signal } = {}) {
      if (signal?.aborted) return false
      const state = working(); const p = state.position; const physical = state.predicted?.physicsState ?? state.physicsState
      if (!p || !observed?.position || !sameRouteScope(routeScope(state), routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05 || physical?.isInWater !== true || physical.isInLava) return false
      const feet = { ...p, y: p.y - 1.62 }
      try {
        // waterSurface deliberately rejects a submerged head. For this bounded
        // wait, inspect the current head cell and the next two cells directly.
        const headY = Math.floor(feet.y + 1.62)
        let surfaceY = null
        for (let y = headY; y <= headY + 2; y++) {
          const block = generationPhysics.blockAt({ x: feet.x, y, z: feet.z })
          if (['air', 'cave_air', 'void_air'].includes(block.name)) { surfaceY = y; break }
          if (!['water', 'flowing_water'].includes(block.name)) return false
        }
        if (!Number.isInteger(surfaceY) || feet.y < surfaceY - 2.1 || feet.y >= surfaceY - 1.6 || !shallowWaterTerrain({ ...feet, y: surfaceY - 1.59 }, surfaceY, { allowDeepSurface: true })) return false
        for (let x = Math.floor(feet.x - 0.3 + 1e-4); x <= Math.floor(feet.x + 0.3 - 1e-4); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-4); z <= Math.floor(feet.z + 0.3 - 1e-4); z++) {
          for (let y = Math.floor(feet.y); y <= Math.floor(feet.y + 1.62); y++) {
            const block = generationPhysics.blockAt({ x, y, z })
            if (block.shapes.length || !['water', 'flowing_water', 'air', 'cave_air', 'void_air'].includes(block.name)) return false
          }
        }
        return true
      } catch { return false }
    }
    const waterCounter = createWaterCounterattack({
      getState: safetyState, world: planningWorld, version: host.meta.version, verifyShallow: verifyShallowWater, shallowPoint: shallowWaterTerrain, isCurrent: safetyCurrent,
      movement: { preview: routeMovement.preview, start: routeMovement.start, snapshot: () => generationMovement.snapshot(), stop: reason => { if (safetyCurrent()) routeMovement.stop(reason) } },
      combat: { physics: generationPhysics, previewWaterCreeper: id => own(() => generationCombat.previewWaterCreeper(id))(), waterCreeperAttack: (id, options) => own(() => generationCombat.waterCreeperAttack(id, options))(), cancel: reason => { if (safetyCurrent()) generationCombat.cancel(reason) } }
    })
    async function tryLearningShoreEscape (initial, context, deadline) {
      const initialPhysical = initial.predicted?.physicsState ?? initial.physicsState
      if (initial.threatPolicy !== 'online_learning' || initial.phase !== 'spawned' || initial.dead || initial.isDead || !(Number.isFinite(initial.health) && initial.health > 0 && initial.health <= 20) || initialPhysical?.isInWater !== true || !Number.isSafeInteger(host.shared.deathRespawn?.deathId) || context.operationId == null || !(context.movementBudget > 0) || Date.now() >= deadline) return null
      const life = actualLifeId(), scope = userScope(initial), owner = owners.escape, controller = new AbortController()
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
      const fail = (reason, code = 'LEARNING_SHORE_CHANGED') => Object.assign(new Error(reason), { code })
      const diagnostic = host.shared.learningShoreEscape = { at: new Date().toISOString(), connectionId: initial.connectionId, deathId: life, phase: 'planning', health: initial.health, starts: 0, target: null, reason: null, riskAccepted: false, actualSent: 0, serverConfirmed: false }
      const timer = setTimeout(() => controller.abort(fail('Learning shore deadline exceeded', 'TIMEOUT')), Math.max(1, deadline - Date.now()))
      const rawStamp = raw().positionUpdatedAt, forceStamp = host.shared.lastServerMotion?.receivedAt ?? null
      const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
      const feet = state => ({ ...state.position, y: state.position.y - 1.62 })
      const eye = point => ({ ...point, y: point.y + 1.62 })
      const segment = (p, a, b) => { const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, n = d.x ** 2 + d.y ** 2 + d.z ** 2; const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y + (p.z - a.z) * d.z) / n)) : 0; return Math.hypot(p.x - a.x - t * d.x, p.y - a.y - t * d.y, p.z - a.z - t * d.z) }
      let bindings = null, proof = null, started = false, sentBefore = 0, historyBefore = null, previous = null
      function fresh (checkActors = true) {
        requireSafety()
        if (signal.aborted) throw signal.reason ?? fail('Learning shore cancelled', 'ABORTED')
        if (Date.now() >= deadline) throw fail('Learning shore deadline exceeded', 'TIMEOUT')
        if (owners.escape !== owner || !safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) throw fail('Learning shore no longer owns movement', 'YIELD')
        if (!started && motionActive()) throw fail('Another native movement is already active', 'YIELD')
        const state = lightweightUserState()
        if (actualLifeId() !== life || userScope(state) !== scope || state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !(state.health > 0) || state.threatPolicy !== 'online_learning') throw fail('Learning shore life or scope changed', 'SESSION_CHANGED')
        if (state.health < initial.health) throw fail('Observed damage interrupted learning shore', 'DAMAGE')
        if (state.inventory?.known !== true || state.inventory.uncertain || !Number.isFinite(state.breath?.current) || !(state.breath.current > 0 && state.breath.current <= state.breath.maximum)) throw fail('Learning shore observations became unknown', 'OBSERVATION_UNKNOWN')
        if (raw().positionUpdatedAt !== rawStamp || (host.shared.lastServerMotion?.receivedAt ?? null) !== forceStamp) throw fail('Received movement changed the learning shore origin', 'ORIGIN_CHANGED')
        if (bindings && checkActors) currentBindings(state)
        return state
      }
      function currentBindings (state) {
        const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
        if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length) throw fail('Learning shore actor positions are unknown', 'ACTOR_UNKNOWN')
        const actors = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain]
        if (actors.length !== bindings.length) throw fail('Learning shore actor set changed', 'ACTORS_CHANGED')
        const seen = new Set(), uids = new Set()
        return bindings.map(binding => {
          const actor = actors.find(a => a.runtimeId === binding.id), entity = state.entities.find(e => String(e.runtimeId) === binding.id)
          if (!actor || !entity || String(entity.uniqueId) !== binding.uniqueId || entity.entityType !== binding.name || entity.dimension !== binding.dimension || entity.alive !== true || entity.positionKnown !== true || actor.dangerRadius !== binding.dangerRadius || seen.has(binding.id) || uids.has(binding.uniqueId)) throw fail('Learning shore actor identity or policy changed', 'ACTORS_CHANGED')
          if (actor.category === 'boss' || binding.name === 'minecraft:creeper' && (entity.primed || entity.ignited || entity.exploding || entity.charged || entity.isCharged || entity.primed !== false && ['creeper_prime_fuse', 32].includes(entity.lastEvent?.event))) throw fail('Learning shore unsupported actor state', 'ACTOR_UNSUPPORTED')
          seen.add(binding.id); uids.add(binding.uniqueId)
          return { ...binding, position: { ...entity.position } }
        })
      }
      function knownBody (point, swept = false) {
        if (!proof || !['x', 'y', 'z'].every(k => Number.isFinite(point?.[k])) || point.y + 1.62 < proof.surfaceY + 0.02 || point.y < proof.surfaceY - 1.6 || point.y > proof.surfaceY + 1.5) return false
        try {
          for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
            const head = generationPhysics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
            if (!['air', 'cave_air', 'void_air'].includes(head.name) || head.shapes.length) return false
              for (let y = Math.floor(point.y + 1e-6); y <= Math.floor(point.y + 1.8 - 1e-6); y++) { const b = generationPhysics.blockAt({ x, y, z }); if ((!swept && b.shapes.length) || !(swept && b.shapes.length || ['air', 'cave_air', 'void_air', 'water', 'flowing_water'].includes(b.name)) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|pointed_dripstone|wither_rose|sweet_berry_bush)/.test(b.name) || ['water', 'flowing_water'].includes(b.name) && (!Number.isInteger(b.metadata) || b.metadata < 0 || b.metadata >= 8)) { diagnostic.frameReject = { point: { ...point }, block: { x, y, z, name: b.name } }; return false } }
          }
          return true
        } catch { return false }
      }
      const terminalCodes = new Set(['DAMAGE', 'SESSION_CHANGED', 'ACTORS_CHANGED', 'ACTOR_UNKNOWN', 'ACTOR_UNSUPPORTED', 'ABORTED', 'YIELD'])
      const rejectPlan = plan => { diagnostic.reason = String(plan.reason ?? plan.code ?? 'NO_PLAN').slice(0, 180); if (terminalCodes.has(plan.code)) throw fail(diagnostic.reason, plan.code); return null }
      const cancel = () => { if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId) routeMovement.stop('Learning shore interrupted') }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const state = { ...fresh(), entities: initial.entities }, destination = navigationDestination(state)?.position ?? null
        const navigator = createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: generationPhysics })
        const input = { state, world: planningWorld, physics: generationPhysics, navigator, destination, validate: fresh, signal }
        const plan = await planLearningShore(input)
        if (!plan.ready) { diagnostic.phase = 'no_plan'; return rejectPlan(plan) }
        bindings = plan.actorBindings
        diagnostic.target = { ...plan.target }; diagnostic.riskAccepted = true
        diagnostic.actors = { count: bindings.length, floors: bindings.slice(0, 8).map(a => ({ id: a.id, name: a.name, initialDistance: a.initialDistance, minDistance: a.minDistance, hardMinimum: a.hardMinimum })) }
        let startState = null
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise(resolve => setImmediate(resolve))
          const current = fresh()
          // The final bounded rehearsal stays synchronous between its fresh
          // validations, like Movement.prepare; it does not lock observations.
          const selected = await proveLearningShoreRoute({ ...input, state: current, target: plan.target, actorBindings: plan.actorBindings, originScope: plan.originScope, yieldControl: () => Promise.resolve() })
          if (!selected.ready) { diagnostic.phase = 'no_plan'; return rejectPlan(selected) }
          const latest = fresh(), physical = generationPhysics.fromServer(latest), first = selected.trace?.[0]
          if (first && ['x', 'y', 'z'].every(k => Math.abs(first.position[k] - physical.position[k]) <= 1e-5 && Math.abs(first.velocity[k] - physical.velocity[k]) <= 1e-5)) { proof = selected; bindings = selected.actorBindings; startState = latest; break }
        }
        if (!proof || !startState) { diagnostic.phase = 'no_plan'; diagnostic.reason = 'Fresh working origin changed during selected-target proof'; return null }
        const origin = { ...proof.trace[0].position }
        previous = { ...origin }
        const beforeInput = frame => {
          const current = fresh(false), actors = currentBindings(current), next = frame.predictedState?.position
          if (!next || frame.predictedState.isInLava || horizontal(origin, next) > 1.5) throw fail('Learning shore native frame left its bound', 'SHORE_FRAME_UNSAFE')
          const length = Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z), pieces = Math.max(1, Math.ceil(length / 0.1))
          if (pieces > 16) throw fail('Learning shore native frame moved unexpectedly', 'SHORE_FRAME_UNSAFE')
          if (!knownBody(next)) throw fail('Learning shore actual native body, head or liquid became unsafe', 'BODY_UNKNOWN')
          // Native physics resolves solid collisions per axis. A diagonal
          // interpolation is only a known-cell/hazard sweep, not a new motion
          // model that rejects its already resolved bank contact.
          for (let n = 0; n <= pieces; n++) { const p = { x: previous.x + (next.x - previous.x) * n / pieces, y: previous.y + (next.y - previous.y) * n / pieces, z: previous.z + (next.z - previous.z) * n / pieces }; if (!knownBody(p, true)) throw fail('Learning shore swept head, liquid or terrain became unknown', 'BODY_UNKNOWN') }
          if (actors.some(a => segment(a.position, eye(previous), eye(next)) < a.minDistance - 1e-4)) throw fail('Learning shore current actor crossed its initial fixed floor', 'ACTOR_FLOOR')
          previous = { ...next }; return true
        }
        const current = fresh(), physical = generationPhysics.fromServer(current)
        if (!['x', 'y', 'z'].every(k => Math.abs(physical.position[k] - proof.trace[0].position[k]) <= 1e-5 && Math.abs(physical.velocity[k] - proof.trace[0].velocity[k]) <= 1e-5)) { diagnostic.phase = 'no_plan'; diagnostic.reason = 'Origin changed before native start'; return null }
        historyBefore = generationHistory.snapshot(); sentBefore = generationMovement.snapshot().sent ?? 0
        diagnostic.phase = 'moving'; diagnostic.executionTicks = proof.executionTicks; diagnostic.neutralCoastTicks = proof.neutralCoastTicks
        diagnostic.starts = 1; started = true; emergencyDropOp = context.operationId; context.onMovementStart?.()
        routeMovement.start(proof.target, { ...proof.options, avoidance: currentBindings(current).map(a => ({ id: a.id, position: a.position, minDistance: a.minDistance, padding: 0 })), beforeInput })
        while (true) {
          const state = fresh(), motion = generationMovement.snapshot()
          diagnostic.actualSent = Math.max(0, (motion.sent ?? 0) - sentBefore)
          if (['failed', 'stopped', 'replan_required'].includes(motion.phase)) throw fail(motion.reason ?? 'Learning shore native movement stopped', 'SHORE_MOVEMENT_STOPPED')
          if (['awaiting_server_confirmation', 'completed'].includes(motion.phase)) {
            const history = generationHistory.snapshot(), queuedAt = motion.queuedAt
            const receipt = motion.queuedReceiptConfirmed === true && diagnostic.actualSent >= proof.executionTicks && history.navigationQueued - historyBefore.navigationQueued >= diagnostic.actualSent && history.count > 0 && Number.isFinite(queuedAt) && Date.now() - queuedAt >= 0 && Date.now() - queuedAt <= 200 && motion.queuedTick != null && history.latestTick != null && BigInt(history.latestTick) >= BigInt(motion.queuedTick)
            const body = generationPhysics.fromServer(state), landing = feet(state)
            if (!receipt || body.onGround !== true || body.isInWater || body.isInLava || Math.abs(landing.y - proof.surfaceY) > 0.05 || horizontal(landing, proof.target) > 0.35 || !verifyRouteStanding(state, landing, { signal })) throw fail('Learning shore lacks queued-receipt or full landing proof', 'LANDING_UNCONFIRMED')
            const final = safetyState(), observed = evaluateThreats(final, final.entities, { observationRadius: 32 })
            fresh(); currentBindings(final)
            if (observed.requiresObservation || final.entityStats?.unknownPositions > observed.unknownPositions.length) throw fail('Learning shore final actor observation is unknown', 'ACTOR_UNKNOWN')
            const finalMotion = generationMovement.snapshot()
            if (finalMotion.queuedReceiptConfirmed !== true || finalMotion.queuedTick !== motion.queuedTick || Date.now() - queuedAt > 200) throw fail('Learning shore receipt became stale during landing verification', 'LANDING_UNCONFIRMED')
            diagnostic.phase = 'model_landing'; diagnostic.landing = { ...landing }; diagnostic.reason = 'Queued native frames reached known full standing; server arrival remains unconfirmed'
            diagnostic.receipt = { tick: String(motion.queuedTick), historyAdvance: history.navigationQueued - historyBefore.navigationQueued }
            return { supported: true, arrived: true, escaped: observed.threats.length === 0, partialEscape: observed.threats.length > 0, learningShore: true, movementStarts: 1, serverConfirmed: false, safe: false }
          }
          await delay(25, undefined, { signal })
        }
      } catch (error) {
        diagnostic.phase = started ? 'interrupted' : 'no_plan'; diagnostic.reason = String(error.message ?? error).slice(0, 180); diagnostic.code = error.code ?? 'SHORE_FAILED'
        if (!started && terminalCodes.has(error.code)) throw error
        return started ? { supported: true, arrived: false, escaped: false, partialEscape: false, learningShore: true, movementStarts: 1, code: 'LEARNING_SHORE_INTERRUPTED', reason: 'no_known_away_route', partialFailure: diagnostic.reason, serverConfirmed: false, safe: false } : null
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId) { routeMovement.stop('Learning shore episode finished'); if (typeof generationMovement.drain === 'function') await generationMovement.drain() }
        if (owners.escape === owner && emergencyDropOp === context.operationId) emergencyDropOp = null
        diagnostic.elapsedMs = Math.max(0, Date.now() - Date.parse(diagnostic.at))
      }
    }

    async function tryRecentDamageNoPrimary (initial, context, parentDeadline) {
      const damage = host.shared.recentDamageNoPrimary, life = actualLifeId(), scope = continuationScope(initial), owner = owners.escape
      const used = host.shared.recentDamageRetreatUsed
      if (!scope || !damage || context.operationId == null || !(context.movementBudget > 0) || used?.damageAt === damage.at && JSON.stringify(used.scope) === JSON.stringify(scope)) return null
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal])
      const deadline = Math.min(parentDeadline, Date.now() + 2000), startedAt = Date.now(), force = host.shared.lastServerMotion?.receivedAt ?? null, correction = host.shared.lastServerCorrection?.receivedAt ?? null
      const diagnostic = host.shared.recentDamageRetreatDiagnostic = { kind: 'recent_damage_no_primary', at: new Date().toISOString(), phase: 'planning', life, health: initial.health, riskAccepted: false, safetyConfirmed: false, serverConfirmed: false, attackerAttributed: false, actualSent: 0, code: null }
      const physics = generationPhysics.withWorld(host.world, { allowWater: false })
      let started = false, plan = null, sentBefore = 0, historyBefore = null, stamp = null
      const state = () => ({ ...safetyState(), lifecycle: { phase: 'alive', deathId: actualLifeId(), dead: raw().dead === true } })
      const fresh = () => {
        requireSafety(); if (signal.aborted) throw signal.reason ?? Error('Recent damage retreat cancelled')
        if (Date.now() >= deadline || !started && Date.now() - startedAt > 500) throw Error('Recent damage retreat deadline')
        const s = state()
        if (actualLifeId() !== life || JSON.stringify(continuationScope(s)) !== JSON.stringify(scope) || s.health < initial.health || owners.escape !== owner || owner?.operationId !== context.operationId || !safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true }) || (host.shared.lastServerMotion?.receivedAt ?? null) !== force || (host.shared.lastServerCorrection?.receivedAt ?? null) !== correction) throw Error('Recent damage retreat scope, owner, health or motion changed')
        if (!started && (motionActive() || Math.hypot(s.position.x - initial.position.x, s.position.y - initial.position.y, s.position.z - initial.position.z) > 1e-4)) throw Error('Recent damage retreat seed changed')
        return s
      }
      const cancel = () => { if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId && generationMovement.snapshot().timingDiagnostics?.start?.at === stamp) routeMovement.stop('Recent damage retreat interrupted') }
      const timer = setTimeout(() => controller.abort(Error('Recent damage retreat deadline')), Math.max(1, deadline - Date.now()))
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const seed = fresh()
        plan = await planRecentDamageRetreat({ state: seed, world: host.world, physics, damage, status: host.shared.ownDamageEffects, check: fresh })
        if (!plan.ready) { diagnostic.phase = 'declined'; diagnostic.code = plan.code; return null }
        fresh()
        const beforeInput = frame => retreatFrameAllowed({ state: fresh(), plan, frame, world: host.world, physics, damage: host.shared.recentDamageNoPrimary, status: host.shared.ownDamageEffects })
        const options = { allowWater: false, emergency: true, sprint: false, maxDistance: 2, maxExpanded: 300, maxTicks: 20, avoidance: plan.avoidance, beforeInput }
        if (Date.now() + 1000 > deadline || !routeMovement.preview(plan.target, options)?.ready) return null
        fresh(); sentBefore = generationMovement.snapshot().sent; historyBefore = generationHistory.snapshot().navigationQueued
        emergencyDropOp = context.operationId; context.onMovementStart?.(); diagnostic.target = { ...plan.target }; diagnostic.nativeTicks = plan.executionTicks
        started = true; const result = routeMovement.start(plan.target, options)
        stamp = generationMovement.snapshot().timingDiagnostics?.start?.at ?? result?.timingDiagnostics?.start?.at
        diagnostic.phase = 'moving'
        while (Date.now() < deadline) {
          const s = fresh(), m = generationMovement.snapshot()
          diagnostic.actualSent = Math.max(0, m.sent - sentBefore)
          if (m.timingDiagnostics?.start?.at !== stamp) throw Error('Recent damage retreat movement owner changed')
          if (diagnostic.actualSent > 0 && m.queuedReceiptConfirmed === true) host.shared.recentDamageRetreatUsed = { scope, damageAt: damage.at, queuedTick: m.queuedTick, queuedAt: m.queuedAt }
          if (m.phase === 'awaiting_server_confirmation') {
            const physical = generationPhysics.fromServer(s), end = physical.position, h = generationHistory.snapshot()
            const receipt = m.queuedReceiptConfirmed === true && diagnostic.actualSent >= plan.executionTicks && h.navigationQueued - historyBefore >= diagnostic.actualSent && Date.now() - m.queuedAt >= 0 && Date.now() - m.queuedAt <= 200
            if (!receipt || !createNavigator({ world: host.world, physics }).verifyOrigin(physical) || Math.hypot(end.x - plan.target.x, end.y - plan.target.y, end.z - plan.target.z) > .4) throw Error('Recent damage retreat landing is unconfirmed')
            diagnostic.phase = 'model_landing'
            return { supported: true, arrived: true, escaped: false, partialEscape: true, movementStarts: 1, code: 'RECENT_DAMAGE_RETREAT', recentDamageNoPrimary: true, safetyConfirmed: false, safe: false, serverConfirmed: false }
          }
          if (['failed', 'stopped', 'replan_required'].includes(m.phase)) throw Error(m.reason ?? 'Recent damage retreat replans')
          await delay(25, undefined, { signal })
        }
        throw Error('Recent damage retreat deadline')
      } catch (error) {
        diagnostic.phase = started ? 'interrupted' : 'declined'; diagnostic.code = String(error.code ?? 'RECENT_DAMAGE_REPLAN'); diagnostic.reason = String(error.message).slice(0, 160)
        return started ? { supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: 1, code: 'RECENT_DAMAGE_REPLAN', recentDamageNoPrimary: true, safetyConfirmed: false, safe: false, serverConfirmed: false } : null
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId && generationMovement.snapshot().timingDiagnostics?.start?.at === stamp) { routeMovement.stop('Recent damage retreat prefix ended'); await generationMovement.drain?.() }
        if (owners.escape === owner && emergencyDropOp === context.operationId) emergencyDropOp = null
      }
    }
    let partialEscapeAction = null
    const generationSafety = createIdleSafety({
      retryAfterEmergency: true,
      getState: safetyState, isIdle: safetyIdle, isCurrentGeneration: safetyCurrent, supportsWorkClearance: true,
      equipSword: context => safetyOwn('inventory', context, async () => {
        const state = safetyState()
        const ranks = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
        const swords = state.inventory?.items?.filter(item => item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)) ?? []
        swords.sort((a, b) => ranks.indexOf(b.name.slice(10, -6)) - ranks.indexOf(a.name.slice(10, -6)))
        if (state.inventory?.known !== true || state.inventory.uncertain || !swords.length) return { supported: false, serverConfirmed: false }
        const cancel = () => { if (safetyCurrent()) cancelBackgroundInventory('待機中の武器の持ち替えを中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { const result = await inventory.equip(swords[0].slot); requireSafety(); if (result.serverConfirmed) host.shared.equipment = null; return result } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      closeGui: context => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return own(() => crafting.closeContainer())() },
      previewEngage: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return own(() => generationCombat.previewEngage(id, { allowUnarmed: context.allowUnarmed === true }))() },
      engage: (id, context) => safetyOwn('combat', context, () => generationCombat.engage(id, { durationMs: context.durationMs, maxHits: context.maxHits, allowUnarmed: context.allowUnarmed === true, signal: context.signal })),
      previewStrike: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return own(() => generationCombat.preview(id))() },
      previewEmergency: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return own(() => generationCombat.previewEmergency(id, { allowDistantRanged: context.allowDistantRanged === true, allowDistantZombie: context.allowDistantZombie === true, allowGuardedGroup: context.allowGuardedGroup === true, allowCritical: context.allowCritical === true, allowEmergencyCreeper: context.allowEmergencyCreeper === true }))() },
      emergencyStrike: (id, context) => safetyOwn('combat', context, async () => {
        const cancel = () => { if (safetyCurrent()) generationCombat.cancel('緊急自衛を中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { return await generationCombat.emergencyAttack(id, { allowDistantRanged: context.allowDistantRanged === true, allowDistantZombie: context.allowDistantZombie === true, allowGuardedGroup: context.allowGuardedGroup === true, allowCritical: context.allowCritical === true, allowEmergencyCreeper: context.allowEmergencyCreeper === true }) } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      verifyStrikeBody: (state, context) => { requireSafety(); return verifyStrikeBody(state, context) },
      verifyMeleeBody: (state, context) => { requireSafety(); return verifyMeleeBody(state, context) },
      verifyLedgeBody: (state, context) => { requireSafety(); return verifyLedgeBody(state, context) },
      verifyShallowWater: (state, context) => { requireSafety(); return verifyShallowWater(state, { ...context, allowDeepSurface: true }) },
      verifyNearSurfaceWater: (state, context) => { requireSafety(); return verifyNearSurfaceWater(state, context) },
      waterCounter: context => safetyOwn('escape', context, async () => {
        emergencyWaterCounterOp = context.operationId; emergencyDropOp = context.operationId
        try { return await waterCounter.execute({ signal: context.signal }) } finally { if (emergencyWaterCounterOp === context.operationId) emergencyWaterCounterOp = null; if (emergencyDropOp === context.operationId) emergencyDropOp = null }
      }),
      strike: (id, context) => safetyOwn('combat', context, async () => {
        const cancel = () => { if (safetyCurrent()) generationCombat.cancel('空中での自衛を中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { return await generationCombat.attack(id) } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      verifyBody: (state, context) => { requireSafety(); return verifyRouteOrigin(state, { ...state.position, y: state.position.y - 1.62 }, { ...context, stablePartialOrigin: true }) },
      verifyCompletedDryProgress,
      partialEscape: partialEscapeAction = context => {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { supported: false, reason: 'foreign_actor' }
        return safetyOwn('escape', context, async () => {
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const initial = safetyState(); const origin = { ...initial.position, y: initial.position.y - 1.62 }
          const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
          const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1)
          const handItem = initial.inventory?.items?.find(item => item.slot === selected && item.count > 0)
          const bootstrapHand = !initial.heldItem && !handItem || initial.heldItem?.name === 'minecraft:rotten_flesh' && handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count
          const unarmed = initial.health >= 18 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && Number.isInteger(selected) && bootstrapHand && !initial.inventory.items?.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))
          const physical = initial.predicted?.physicsState ?? initial.physicsState
          const learningLife = actualLifeId()
          const confirmedHand = Number.isInteger(selected) && selected >= 0 && selected <= 8 && (initial.heldItem ? handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count && handItem.count > 0 : !handItem)
          const learningShore = resourceMinHealth(initial) === 0 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && confirmedHand && physical?.onGround === true && !physical.isInWater && !physical.isInLava && !verifyMeleeBody(initial, { signal }) && verifyLedgeBody(initial, { signal })
          if (!(initial.health > 0) || !(sword || unarmed || learningShore) || physical?.onGround !== true || !verifyLedgeBody(initial, { signal }) || await verifyRouteStanding(initial, origin, { signal })) return { supported: false, reason: 'no_known_escape_origin' }
          const initialThreats = evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          if (initialThreats.requiresObservation || initial.entityStats?.unknownPositions > initialThreats.unknownPositions.length || !initialThreats.threats.length) return { supported: false, reason: 'no_known_away_route' }
          const single = initialThreats.threats[0]
          const creeperRecenter = initialThreats.threats.length === 1 && single.name === 'minecraft:creeper' && single.dangerRadius === 8 && single.distance >= 3.9 && single.position && Math.hypot(single.position.x - origin.x, single.position.y - origin.y, single.position.z - origin.z) >= 3.1
          const criticalZombieRecenter = initial.health <= 6 && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 5.75
          const unarmedCreeperRecenter = unarmed && creeperRecenter && single.distance >= 5.5
          const unarmedZombieRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 8.5
          const unarmedDrownedRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:drowned' && single.distance >= 10.5
          const unarmedSpiderRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:spider' && single.distance >= 8.5
          const unarmedSpiderGroup = unarmed && initialThreats.threats.length === 2 && initialThreats.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          const unarmedCreeperZombie = isUnarmedCreeperZombie(initial, initialThreats.threats)
          const shoreRecenter = learningShore || !verifyMeleeBody(initial, { signal }) && (unarmedSpiderRecenter || unarmedSpiderGroup || unarmedCreeperRecenter || unarmedCreeperZombie)
          const shoreSpiderApproach = shoreRecenter && unarmedSpiderRecenter && initial.health === 20 && single.distance >= 9.5
          const creeperEntity = single && initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === single.runtimeId)
          const shoreCreeperCloseApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 5.75 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 5.5 && creeperEntity?.primed === false && creeperEntity?.charged === false
          const shoreCreeperApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 7 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 6.4 || shoreCreeperCloseApproach
          // A partly supported player can also recenter away from both members
          // of one identified, sufficiently distant creeper/spider pair. The
          // simulated and live corridor must never approach either actor.
          const unarmedDualRecenter = unarmedCreeperZombie || unarmed && initialThreats.threats.length === 2 && initialThreats.threats.some(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= 5.5) && initialThreats.threats.some(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          if (unarmed && !learningShore && !(unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter)) return { supported: false, reason: 'no_known_away_route' }
          // Below ten health permit a single ordinary creeper, or at critical
          // health a single sufficiently distant zombie. The retreat never
          // moves closer along its simulated corridor.
          if (initial.health < 10 && !learningShore && !creeperRecenter && !criticalZombieRecenter) return { supported: false, reason: 'no_known_away_route' }
          const primary = initialThreats.threats.reduce((a, b) => a.distance < b.distance ? a : b)
          const all = [...initialThreats.threats, ...initialThreats.outsideDanger]
          const activeIds = new Set(initialThreats.threats.map(actor => actor.runtimeId))
          const trackedRangedIds = new Set()
          const identities = new Map(); const circles = []
          for (const actor of all) {
            const entity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            if (entity?.uniqueId == null) return { supported: false, reason: 'no_known_away_route' }
            identities.set(actor.runtimeId, { uniqueId: String(entity.uniqueId), name: actor.name, radius: actor.dangerRadius })
            let minimum = actor.dangerRadius
            const ranged = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)
            const zombie = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)
            const spider = actor.name === 'minecraft:spider'
            const creeper = creeperRecenter && actor.runtimeId === single.runtimeId
            if (activeIds.has(actor.runtimeId)) {
              const exactDistance = learningShore || unarmedDualRecenter || unarmedSpiderGroup || creeper || (criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter) && actor.runtimeId === single.runtimeId
              const floor = exactDistance ? actor.distance : zombie ? (actor.runtimeId === primary.runtimeId ? 4.5 : 7.5) : spider ? 6 : ranged ? 18 : null
              if (floor === null || !exactDistance && actor.distance < floor + 0.1) return { supported: false, reason: 'no_known_away_route' }
              const recenterBudget = unarmedDrownedRecenter && initial.health === 20 && actor.distance >= 12.5 ? 0.5 : 0.25
              minimum = learningShore ? actor.distance : unarmedCreeperZombie && zombie ? unarmedZombieFloor(actor) : unarmedCreeperZombie && spider ? activeUnarmedSpiderFloor(actor) : unarmedCreeperZombie && actor.name === 'minecraft:creeper' ? Math.max(5.75, actor.distance - 0.4) : shoreCreeperApproach && actor.runtimeId === single.runtimeId ? shoreCreeperCloseApproach ? Math.max(5.25, actor.distance - 0.65) : Math.max(6.5, actor.distance - 0.4) : shoreSpiderApproach && actor.runtimeId === single.runtimeId ? Math.max(9, actor.distance - 0.4) : unarmedDrownedRecenter && actor.runtimeId === single.runtimeId ? Math.max(10.25, actor.distance - recenterBudget) : exactDistance ? actor.distance : actor.runtimeId === primary.runtimeId ? Math.max(floor, actor.distance - 0.4) : Math.max(floor, actor.distance - 1.5)
            } else if (ranged && actor.distance >= 18.25 && actor.distance <= actor.dangerRadius + 1.5) {
              // The same already observed ranged actor may cross its broad
              // avoidance radius while the short descent is underway. It still
              // must remain beyond 18 and within the fixed 1.5-block budget.
              trackedRangedIds.add(actor.runtimeId)
              minimum = Math.max(18, actor.distance - 1.5)
            }
            circles.push({ id: actor.runtimeId, position: { ...actor.position }, minDistance: minimum, padding: 0 })
          }
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          const eye = point => ({ ...point, y: point.y + 1.62 })
          const segment = (point, from, to) => {
            const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }; const length = d.x ** 2 + d.y ** 2 + d.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * d.x + (point.y - from.y) * d.y + (point.z - from.z) * d.z) / length)) : 0
            return distance(point, { x: from.x + t * d.x, y: from.y + t * d.y, z: from.z + t * d.z })
          }
          function knownFullRecenterFloor (target) {
            try {
              const cube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/
              for (let x = Math.floor(target.x - 0.3 + 1e-4); x <= Math.floor(target.x + 0.3 - 1e-4); x++) for (let z = Math.floor(target.z - 0.3 + 1e-4); z <= Math.floor(target.z + 0.3 - 1e-4); z++) {
                const floor = generationPhysics.blockAt({ x, y: target.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) return false
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = generationPhysics.blockAt({ x, y: target.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) return false
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) return false
                }
                for (const y of [target.y, target.y + 1]) {
                  const body = generationPhysics.blockAt({ x, y, z })
                  if (hazard.test(body.name) || body.shapes.length) return false
                }
              }
              return true
            } catch { return false }
          }
          let started = false; let timer; let watch; let trace = null; let traceIndex = 0
          const deadline = Date.now() + 4000
          const check = () => {
            requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Partial escape interrupted')
            if (Date.now() >= deadline) throw new Error('Partial escape deadline')
            const current = safetyState()
            if (current.dead || current.health < initial.health || learningShore && actualLifeId() !== learningLife || current.connectionId !== initial.connectionId || !sameRouteScope(routeScope(current), routeScope(initial))) throw new Error('Partial escape session or health changed')
            const currentPhysical = current.predicted?.physicsState ?? current.physicsState
            if (shoreRecenter && (currentPhysical?.isInWater || currentPhysical?.isInLava)) throw new Error('Partial escape entered water or lava')
            const currentSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
            const currentItem = current.inventory.items?.find(item => item.slot === currentSlot && item.count > 0)
            const equipmentValid = learningShore ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : unarmed ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : current.heldItem?.name === initial.heldItem?.name && current.heldItem?.count === 1 && currentItem?.name === current.heldItem.name && currentItem.count === 1
            if (current.inventory?.known !== true || current.inventory.uncertain || current.equipmentServerConfirmed === false || currentSlot !== selected || !equipmentValid) throw new Error('Partial escape equipment changed')
            const evaluation = evaluateThreats(current, current.entities, { observationRadius: 32 })
            if (evaluation.requiresObservation || current.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.some(actor => !activeIds.has(actor.runtimeId) && !trackedRangedIds.has(actor.runtimeId))) throw new Error('Partial escape danger changed')
            const actors = new Map([...evaluation.threats, ...evaluation.outsideDanger].map(actor => [actor.runtimeId, actor]))
            if (trace) {
              const nearest = trace.reduce((best, point, index) => index < traceIndex ? best : !best || distance(eye(point), current.position) < best.distance ? { index, distance: distance(eye(point), current.position) } : best, null)
              if (!nearest || nearest.distance > 0.5) throw new Error('Partial escape left its predicted corridor')
              traceIndex = nearest.index
              const remaining = [current.position, ...trace.slice(traceIndex + 1).map(eye)]
              for (const circle of circles) {
                const actor = actors.get(circle.id); const entity = current.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === circle.id); const known = identities.get(circle.id)
                if (!actor || !known) throw new Error('Partial escape actor no longer observed')
                if (String(entity?.uniqueId) !== known.uniqueId || actor.name !== known.name) throw new Error('Partial escape actor identity changed')
                if (actor.dangerRadius > known.radius) throw new Error('Partial escape actor danger expanded')
                if (actor.distance < circle.minDistance - 1e-4) throw new Error('Partial escape actor approached distance floor')
                if (unarmedCreeperZombie && actor.name === 'minecraft:creeper' && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < 5.5 || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < 5.5))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (shoreCreeperApproach && actor.runtimeId === single.runtimeId && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < (shoreCreeperCloseApproach ? 5 : 6) || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < (shoreCreeperCloseApproach ? 5 : 6)))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (remaining.slice(1).some((point, index) => segment(actor.position, remaining[index], point) < circle.minDistance - 1e-4)) throw new Error('Partial escape remaining path is unsafe')
              }
            }
            return current
          }
          const cancel = () => { if (started && safetyCurrent()) routeMovement.stop('Partial escape interrupted') }
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          signal.addEventListener('abort', cancel, { once: true })
          try {
            timer = setTimeout(() => controller.abort(new Error('Partial escape deadline')), 4000)
            let partialPlanningChecks = 0, partialPlanningSlice = performance.now()
            const yieldPartialPlanning = async (force = false) => {
              if (!force && ++partialPlanningChecks % 32 !== 0 && performance.now() - partialPlanningSlice < 12) return
              requireSafety(); if (signal.aborted) throw signal.reason
              maintainIdle()
              await new Promise(resolve => setImmediate(resolve))
              check()
              partialPlanningSlice = performance.now()
            }
            const targets = []
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const ox of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const oz of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const recenter of learningShore ? [true] : creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? [true, false] : [false]) {
              await yieldPartialPlanning()
              if (!recenter && (shoreRecenter || creeperRecenter && !clearanceDistanceAllowed(initial, single))) continue
              const target = { x: Math.floor(origin.x) + dx + ox, y: Math.round(origin.y) - (recenter ? 0 : 1), z: Math.floor(origin.z) + dz + oz }
              const horizontal = Math.hypot(target.x - origin.x, target.z - origin.z)
              const gain = distance(primary.position, eye(target)) - primary.distance
              // A partly supported ledge may require one short step onto its
              // support before an away route is possible. Restrict this to a
              // healthy unarmed player and a single distant drowned; the
              // fixed circle still bounds every simulated and observed frame.
              const mixedCreeperApproach = unarmedCreeperZombie && primary.name === 'minecraft:creeper' && primary.distance >= 6.5 && Math.hypot(primary.position.x - initial.position.x, primary.position.z - initial.position.z) >= 6
              const recenterGain = learningShore ? 0 : shoreRecenter && recenter ? (mixedCreeperApproach ? -0.3 : shoreCreeperCloseApproach ? -0.65 : shoreSpiderApproach || shoreCreeperApproach ? -0.4 : 0) : unarmedDrownedRecenter && recenter ? -(initial.health === 20 && single.distance >= 12.5 ? 0.5 : 0.25) : 0.25
              const creeperHorizontalSafe = !shoreCreeperApproach || segment({ ...single.position, y: 0 }, { ...initial.position, y: 0 }, { ...target, y: 0 }) >= (shoreCreeperCloseApproach ? 5 : 6)
              if (horizontal < 0.2 || horizontal > (unarmedCreeperZombie ? 0.9 : shoreCreeperCloseApproach ? 0.75 : 1.2) || gain < recenterGain || !creeperHorizontalSafe || circles.some(circle => segment(circle.position, initial.position, eye(target)) < circle.minDistance - 1e-4)) continue
              if ((learningShore || unarmedCreeperZombie) && recenter && !knownFullRecenterFloor(target)) continue
              targets.push({ target, gain, recenter })
            }
            targets.sort((a, b) => Number(b.recenter) - Number(a.recenter) || (unarmedCreeperZombie ? Math.hypot(a.target.x - origin.x, a.target.z - origin.z) - Math.hypot(b.target.x - origin.x, b.target.z - origin.z) : b.gain - a.gain))
            let candidate = null; let preview = null
            for (const entry of targets.slice(0, unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter ? 120 : 60)) {
              await new Promise(resolve => setImmediate(resolve)); check(); motionOrigin = working()
              const options = { emergency: true, allowWater: shoreRecenter, shoreRecenter, partialDrop: !entry.recenter, partialRecenter: entry.recenter, maxDistance: 2, maxTicks: 40, avoidance: circles }
              const planned = generationMovement.preview(entry.target, options)
              if (planned.ready && (entry.recenter ? planned.partialRecenter === true : planned.partialDrop === true) && Array.isArray(planned.predictedTrace) && planned.predictedTrace.length > 2) { candidate = { ...entry, options }; preview = planned; break }
            }
            if (!candidate) return { supported: false, reason: 'no_known_away_route' }
            trace = preview.predictedTrace
            await yieldPartialPlanning(true)
            watch = setInterval(inspectPacket, 25)
            inspectPartialEscapePacket = inspectPacket
            routeMovement.start(candidate.target, candidate.options); started = true
            while (true) {
              await delay(50, undefined, { signal })
              const current = check(); const movementState = generationMovement.snapshot()
              if (['failed', 'stopped', 'replan_required'].includes(movementState.phase)) return { supported: true, arrived: false, escaped: false, code: movementState.phase === 'replan_required' ? 'PARTIAL_REPLAN' : movementState.phase === 'failed' && movementState.reason === 'Movement input timer stalled' ? 'PARTIAL_STALLED' : 'PARTIAL_STOPPED', reason: 'no_known_away_route', partialFailure: typeof movementState.reason === 'string' ? movementState.reason.slice(0, 200) : null }
              if (['awaiting_server_confirmation', 'completed', 'idle'].includes(movementState.phase)) {
                if (!await verifyRouteStanding(current, candidate.target, { signal })) return { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' }
                const evaluation = evaluateThreats(current, current.entities, { observationRadius: 32 })
                return { supported: true, arrived: true, escaped: !evaluation.requiresObservation && !evaluation.threats.length, partialEscape: !evaluation.requiresObservation && evaluation.threats.length > 0, constrainedEscape: !(creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter), constrainedPrimaryId: creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? null : primary.runtimeId, serverConfirmed: false }
              }
            }
          } catch (error) {
            // Node's abortable delay reports a generic AbortError; preserve
            // the specific safety condition that stopped the owned motion.
            if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
            throw error
          } finally {
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (inspectPartialEscapePacket === inspectPacket) inspectPartialEscapePacket = null
            if (started && safetyCurrent()) routeMovement.stop('Partial escape finished')
          }
        })
      },
      clearEscape: context => {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { cleared: false }
        return safetyOwn('escape', context, async () => {
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const initial = safetyState()
          const initialEvaluation = evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          const drownedMode = initialEvaluation.threats.length === 1 && drownedStepThreatAllowed(initial, initialEvaluation.threats[0])
          const skeletonMode = initialEvaluation.threats.length === 1 && skeletonStepThreatAllowed(initial, initialEvaluation.threats[0])
          const stepMode = drownedMode || skeletonMode
          const stepThreatAllowed = skeletonMode ? skeletonStepThreatAllowed : drownedStepThreatAllowed
          const stepCurrent = skeletonMode ? protectiveSkeletonStepCurrent : protectiveDrownedStepCurrent
          const deadline = Date.now() + (stepMode ? 4000 : 2000)
          const planningStarted = performance.now()
          const diagnostic = { phase: 'planning', planningMs: null, maxPlanningSliceMs: 0, miningStartedMs: null, airReceivedMs: null, elapsedMs: 0, reason: null }
          host.shared.clearanceDiagnostic = diagnostic
          const mark = phase => { diagnostic.phase = phase; diagnostic.elapsedMs = Math.round((performance.now() - planningStarted) * 10) / 10 }
          const clearId = initialEvaluation.threats[0]?.runtimeId
          const clearEntity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
          const clearUniqueId = clearEntity?.uniqueId == null ? null : String(clearEntity.uniqueId)
          const equipmentKey = stepMode ? drownedStepEquipmentKey(initial) : clearanceEquipmentKey(initial)
          if (initialEvaluation.requiresObservation || initialEvaluation.threats.length !== 1 || !(stepMode || clearanceDistanceAllowed(initial, initialEvaluation.threats[0])) || clearUniqueId === null || equipmentKey === null) { mark('not_cleared'); diagnostic.reason = 'initial_conditions'; return { cleared: false } }
          if (stepMode) {
            const requested=context.state, requestedActor=requested?.entities?.find(item=>String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id)===clearId)
            if (!requested || JSON.stringify(continuationScope(requested))!==JSON.stringify(continuationScope(initial)) || requestedActor?.uniqueId==null || String(requestedActor.uniqueId)!==clearUniqueId || requestedActor.entityType!==clearEntity.entityType || drownedStepEquipmentKey(requested)!==equipmentKey || initial.health<requested.health || !requested.position || Math.hypot(initial.position.x-requested.position.x,initial.position.y-requested.position.y,initial.position.z-requested.position.z)>.1) {mark('not_cleared');diagnostic.reason=skeletonMode?'skeleton_step_context_changed':'drowned_step_context_changed';return {cleared:false}}
          }
          let plan = null; let soilSupport = null
          let drownedHealth = initial.health
          const initialDrownedTool = initial.inventory?.items?.find(item => item.slot === (initial.rawServerSelectedSlot ?? initial.rawSelectedSlot))
          let drownedWear = initialDrownedTool?.durabilityKnown === true ? initialDrownedTool.durabilityUsed : null
          let started = false; let timer; let watch
          const cancel = () => { if (started) ownedMining.stop('Emergency leaf clearance interrupted') }
          const check = () => {
            requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Emergency leaf clearance interrupted')
            if (Date.now() >= deadline) throw new Error('Emergency leaf clearance timed out')
            const state = safetyState(); const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 }); const target = evaluation.threats[0]
            const actor = state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
            if (state.dead || state.health < initial.health || state.connectionId !== initial.connectionId || !sameRouteScope(routeScope(state), routeScope(initial)) || !state.position || Math.hypot(state.position.x - initial.position.x, state.position.y - initial.position.y, state.position.z - initial.position.z) > 0.1 || equipmentKey === null || (stepMode ? drownedStepEquipmentKey(state) : clearanceEquipmentKey(state)) !== equipmentKey || evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length !== 1 || target?.runtimeId !== clearId || clearUniqueId === null || !(stepMode ? stepThreatAllowed(state, target) : clearanceDistanceAllowed(state, target)) || String(actor?.uniqueId) !== clearUniqueId || !verifyMeleeBody(state, { signal })) throw new Error('Emergency leaf clearance is no longer safe')
            if (stepMode) {
              if (state.health < drownedHealth) throw new Error('Protective drowned step observed damage')
              drownedHealth = Math.max(drownedHealth, state.health)
              const tool = state.inventory?.items?.find(item => item.slot === (state.rawServerSelectedSlot ?? state.rawSelectedSlot))
              if (drownedWear !== null) {
                if (tool?.durabilityKnown !== true || !Number.isFinite(tool.durabilityUsed) || tool.durabilityUsed < drownedWear || tool.durabilityUsed - initialDrownedTool.durabilityUsed > (skeletonMode ? 4 : 6) || !(tool.durabilityRemaining > 0)) throw new Error('Protective drowned step tool wear changed unexpectedly')
                drownedWear = tool.durabilityUsed
              }
              if (plan?.ready && !stepCurrent({state,world:planningWorld,plan})) throw new Error('Protective drowned step terrain or actors changed')
            }
            if (plan?.kind === 'soil') {
              const block = planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              const air = block?.known && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(block.name)
              const support = planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z)
              if (!block?.known || block.extra?.length || block.protected || block.protectionSource || !air && !clearanceTargetAllowed(plan, block) || !support?.known || support.name !== soilSupport?.name || support.runtimeId !== soilSupport?.runtimeId || support.extra?.length || support.protected || support.protectionSource) throw new Error('Emergency soil clearance terrain changed')
              for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const neighbour = planningWorld.getBlock(plan.block.x + x, plan.block.y + y, plan.block.z + z)
                if (!neighbour?.known || /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|pointed_dripstone|sand$|gravel$|concrete_powder|anvil/.test(neighbour.name ?? '') || neighbour.extra?.length) throw new Error('Emergency soil clearance terrain changed')
              }
            }
            return state
          }
          signal.addEventListener('abort', cancel, { once: true })
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          try {
            timer = setTimeout(() => controller.abort(new Error('Emergency leaf clearance timed out')), stepMode ? 4000 : 2000)
            watch = setInterval(inspectPacket, 25)
            inspectEmergencyLeafPacket = inspectPacket
            if (stepMode) {
              plan = await (skeletonMode ? planProtectiveSkeletonStepAsync : planProtectiveDrownedStepAsync)({state:initial,world:planningWorld,version:host.meta.version,physics:generationPhysics,retainedActors:context.retainedActors ?? [],signal,check,onSlice:ms=>{diagnostic.maxPlanningSliceMs=Math.max(diagnostic.maxPlanningSliceMs,Math.round(ms*10)/10)}})
            } else plan = await planEmergencyLeafAsync({ state: initial, world: planningWorld, version: host.meta.version, physics: generationPhysics, signal, check, onSlice: ms => { diagnostic.maxPlanningSliceMs = Math.max(diagnostic.maxPlanningSliceMs, Math.round(ms * 10) / 10) } })
            mark('planned'); diagnostic.planningMs = diagnostic.elapsedMs
            if (!plan.ready) { diagnostic.reason = plan.reason; return { cleared: false } }
            soilSupport = plan.kind === 'soil' ? planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z) : null
            check()
            const targets = stepMode ? plan.blocks?.map(block => ({...block.position})) : [plan.block]
            if (stepMode) {
              if (plan.kind !== (skeletonMode ? 'skeleton_step' : 'drowned_step') || !Array.isArray(targets) || targets.length < 1 || targets.length > (skeletonMode ? 2 : 3) || !stepCurrent({state:check(),world:planningWorld,plan})) return {cleared:false}
            } else {
              const leaf = planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              if (!clearanceTargetAllowed(plan, leaf)) return {cleared:false}
            }
            if (ownedMining.preview(targets)?.ready !== true) return {cleared:false}
            emergencyMiningOp = context.operationId
            mark('starting_mining')
            ownedMining.start(targets); started = true
            mark('mining'); diagnostic.miningStartedMs = diagnostic.elapsedMs
            while (true) {
              await delay(25, undefined, { signal }); check()
              const allAir = targets.every(position => {const block=host.world.getBlock(position.x,position.y,position.z);return block?.known === true && !block.extra?.length && ['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(block.name)})
              const phase = mining.snapshot().phase
              if (allAir) {
                if (diagnostic.airReceivedMs === null) { mark('received_air'); diagnostic.airReceivedMs = diagnostic.elapsedMs }
                if (phase === 'completed') { mark('cleared'); return { cleared: true, serverConfirmed: true, target: { ...plan.target }, kind: plan.kind } }
              }
              if (stepMode && phase === 'completed' && !allAir) {mark('failed');diagnostic.reason='incomplete_received_air';return {cleared:false}}
              if (['failed', 'stopped'].includes(phase)) { mark('failed'); diagnostic.reason = String(mining.snapshot().reason ?? phase).slice(0, 160); return { cleared: false } }
            }
          } catch (error) {
            mark('failed'); diagnostic.reason = String(error.message).slice(0, 160)
            throw error
          } finally {
            if (diagnostic.phase !== 'failed' && diagnostic.phase !== 'cleared') mark('not_cleared')
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (inspectEmergencyLeafPacket === inspectPacket) inspectEmergencyLeafPacket = null
            if (started) ownedMining.stop('Emergency leaf clearance finished')
            if (emergencyMiningOp === context.operationId) emergencyMiningOp = null
          }
        })
      },
      closeHut: context => {
        if (host.shared.depotHutUpgraded === true) return {supported:false,serverConfirmed:false,reason:'OWNED_DEPOT_LAYOUT'}
        requireSafety()
        const state = safetyState(); const base = state.hut
        const dirt = state.inventory?.items?.reduce((sum, item) => sum + (item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0) ?? 0
        if (!(state.health > 6) || state.dead || state.phase !== 'spawned' || state.loading || state.inventory?.known !== true || state.inventory.uncertain || dirt < 2 || base?.inside !== true || base.closed || base.entranceClosed || base.established !== true || !(base.structureIntact || base.geometryVerified) || base.serverConfirmed !== true || base.pendingPlacement || base.memo?.pendingPlacement) return { supported: false, serverConfirmed: false }
        return safetyOwn('hut', context, () => generationHut.execute({}, { signal: context.signal }))
      },

      escape: function escape (context) {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { supported: false, reason: 'foreign_actor' }
        if (escapePaused()) return { supported: false, reason: 'escape_paused_no_route' }
        return logEscapePhase(context, safetyOwn('escape', context, async () => {
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const inheritedFence = preMovementFences.get(context)
          const deadline = inheritedFence?.deadline ?? Date.now() + 4000
          const surfaceTiming = host.shared.lowHealthWaterTiming?.version === 'cooperative_surface_v1' ? host.shared.lowHealthWaterTiming : (host.shared.lowHealthWaterTiming = { version: 'cooperative_surface_v1', since: new Date().toISOString(), maxSlice: {}, lastSlice: null, recent: [] })
          const surfaceMark = () => { const cursor = generationHistory.snapshot().cursor; return { at: performance.now(), cursorAge: cursor ? Date.now() - cursor.queuedAt : null } }
          const surfaceRecord = (phase, mark) => {
            const ms = Math.round((performance.now() - mark.at) * 10) / 10
            surfaceTiming.maxSlice[phase] = Math.max(surfaceTiming.maxSlice[phase] ?? 0, ms)
            const cursor = generationHistory.snapshot().cursor
            surfaceTiming.lastSlice = { phase, ms, cursorBeforeMs: mark.cursorAge, cursorAfterMs: cursor ? Date.now() - cursor.queuedAt : null, owner: inputOwner, at: new Date().toISOString() }
            surfaceTiming.recent.push(surfaceTiming.lastSlice); if (surfaceTiming.recent.length > 16) surfaceTiming.recent.shift()
          }
          const surfaceTimed = (phase, fn) => { const mark = surfaceMark(); try { return fn() } finally { surfaceRecord(phase, mark) } }
          const initial = surfaceTimed('initialState', safetyState)
          const learningShoreResult = await tryLearningShoreEscape(initial, { ...context, signal, movementBudget: Math.max(0, 5 - (inheritedFence?.starts ?? 0)), onMovementStart: () => { if (inheritedFence) inheritedFence.starts++ } }, deadline)
          if (learningShoreResult) return learningShoreResult
          const entityId = entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id)
          const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          const fence = inheritedFence ?? { deadline, createdAt: deadline - 4000, origin: initial, sent: initial.movement?.sent ?? 0, motionFrames: queuedMotionFrames, unprovedFrames: unprovedInputFrames, starts: 0, replans: 0, guardInvoked: false, identities: new Map((initial.entities ?? []).map(entity => [entityId(entity), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }])) }
          let pendingReplan = null
          const restartState = state => {
            const origin = fence.origin
            if (context.signal?.aborted || Date.now() >= fence.deadline || fence.replans >= 2 || fence.guardInvoked || fence.starts !== 0 || state.movement?.sent !== fence.sent || !['idle', 'stopped'].includes(state.movement?.phase) || queuedMotionFrames !== fence.motionFrames || unprovedInputFrames !== fence.unprovedFrames || motionActive() || state.health !== origin.health || state.dead || state.phase !== 'spawned' || state.loading || state.inventory?.known !== true || state.inventory.uncertain) return false
            if (!['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId', 'rawServerPositionUpdatedAt'].every(key => state[key] === origin[key]) || String(state.realm?.id) !== String(origin.realm?.id) || ![state.position, state.rawServerPosition, origin.position, origin.rawServerPosition].every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) || ['x', 'y', 'z'].some(axis => state.position[axis] !== origin.position[axis] || state.rawServerPosition[axis] !== origin.rawServerPosition[axis])) return false
            const entities = state.entities ?? [], ids = new Set(), uniqueIds = new Set()
            for (const entity of entities) {
              const id = entityId(entity), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = fence.identities.get(id)
              if (!uid || ids.has(id) || uniqueIds.has(uid) || entity.positionKnown === false || !entity.position || !['x', 'y', 'z'].every(axis => Number.isFinite(entity.position[axis])) || dimension(entity.dimension) !== dimension(state.dimension) || old && (uid !== old.uniqueId || (entity.entityType ?? entity.name) !== old.name) || !old && [...fence.identities.values()].some(value => value.uniqueId === uid)) return false
              ids.add(id); uniqueIds.add(uid)
            }
            if ([...fence.identities].some(([id, old]) => !ids.has(id) && !(state.removedEntities ?? []).some(receipt => String(receipt.runtimeId) === id && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name && (typeof receipt.removedAt === 'number' ? receipt.removedAt : Date.parse(receipt.removedAt)) >= fence.createdAt))) return false
            const observed = evaluateThreats(state, entities, { observationRadius: 32 })
            return !observed.requiresObservation && !(state.entityStats?.unknownPositions > observed.unknownPositions.length)
          }
          const jumpSearchDiagnostic = { candidates: 0, previews: 0, verified: 0, rejected: 0, hungerReady: null, elapsedMs: 0, maxSliceMs: 0, chosen: null, attempts: 0, reason: 'ordinary_planning', preMovementReplans: fence.replans, deadline }
          boundedJumpSearch = jumpSearchDiagnostic
          let jumpSearchStartedAt = null
          const retainedActors = [...new Map([...captureWorkActors(initial, evaluateThreats(initial, initial.entities, { observationRadius: 32 })), ...(context.retainedActors ?? [])].map(actor => [actor.runtimeId, actor])).values()]
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          const feet = state => ({ ...state.position, y: state.position.y - 1.62 })
          const eye = point => ({ ...point, y: point.y + 1.62 })
          const assessEnemies = state => {
            const actors = state.entities ?? []
            const canonical = evaluateThreats(state, actors, { observationRadius: 32 })
            if (canonical.requiresObservation || state.entityStats?.unknownPositions > canonical.unknownPositions.length) throw new Error('Idle escape actor positions are unknown')
            const retained = resolveWorkActors(state, canonical, retainedActors)
            if (retained.invalid.length) throw new Error('Idle escape retained actor identity, policy or scope changed')
            const value = workEscapeEvaluation(canonical, retained.actors)
            // Match Guard: actual threats keep their distance; an outside actor
            // contributes its danger circle unless its current full proof applies.
            const outside = value.outsideDanger.filter(actor => {
              const entity = actors.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
              return !entity || !terrainOcclusionApplies(state, entity)
            })
            return { ...value, outside }
          }
          const baseline = assessEnemies(initial)
          const unarmedMixed = isUnarmedCreeperZombie(initial, baseline.threats) || verifyShallowWater(initial, { signal, allowDeepSurface: true }) && isUnarmedCreeperZombie(initial, baseline.threats, { creeperMinimum: 4, zombieMinimum: baseline.threats.length === 2 && baseline.threats.some(value => value.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true })
          const diagnostics = { visited: 0, candidates: 0, partials: 0, previews: 0, readyPreviews: 0, floorBlocked: 0, bodyBlocked: 0, terrainUnknown: 0, awayBlocked: 0, gainBlocked: 0 }
          const known = [...baseline.threats, ...baseline.outside]
          const ids = new Map(baseline.threats.map(actor => {
            const entity = initial.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            return [actor.runtimeId, { ...actor, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
          }))
          const outsideTracked = new Map(baseline.outside.flatMap(actor => {
            const entity = initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
            return (outsideSkeletonFloor(actor) !== null || unarmedMixed && outsideUnarmedSpiderFloor(actor) !== null) && entity?.uniqueId != null ? [[actor.runtimeId, { ...actor, uniqueId: String(entity.uniqueId) }]] : []
          }))
          const primary = baseline.threats.find(actor => actor.runtimeId === context.threats?.[0]?.runtimeId)
          let remainingTargets = null
          let remainingJumpTrace = null; let remainingJumpIndex = 0
          let remainingConstrained = false
          let dropTrace = null; let dropTraceIndex = 0; let dropCircles = null; let shallowWaterRun = false; let shallowWaterCheck = null; let shallowSurfaceY = null; let briefSubmerge = false; let submergedSince = null; let lowHealthSurfaceRun = false; let lowHealthSurfaceOrigin = null
          const inspect = state => {
            if (signal.aborted) return
            const startedAt = performance.now()
            try {
              requireSafety()
              if (state.dead || !(state.health > 0)) throw new Error('Idle escape stopped on death or unknown health')
              if (state.health < initial.health - 1e-6) throw new Error('Idle escape stopped on observed damage')
              if (Date.now() >= deadline) throw new Error('Idle escape four-second deadline exceeded')
              const current = assessEnemies(state)
              const changed = current.threats.filter(actor => {
                const previous = ids.get(actor.runtimeId) ?? outsideTracked.get(actor.runtimeId)
                const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                return !previous || actor.name !== previous.name || actor.dangerRadius > previous.dangerRadius || previous.uniqueId != null && String(entity?.uniqueId) !== previous.uniqueId
              })
              if (changed.length) {
                const error = new Error('Idle escape danger changed')
                const additions = changed.every(actor => !ids.has(actor.runtimeId) && !outsideTracked.has(actor.runtimeId) && !fence.identities.has(actor.runtimeId))
                if (additions && restartState(state)) {
                  const request = { state, operationId: context.operationId, deadline, movementStarts: fence.starts, replanCount: fence.replans + 1 }
                  if (typeof context.onPreMovementReplan !== 'function' || context.onPreMovementReplan(request) === true) pendingReplan = { error, state }
                }
                throw error
              }
              if (dropTrace && dropCircles) {
                if (lowHealthSurfaceRun && (!lowHealthSurfaceEligible(state, [...current.threats, ...current.outside], generationPhysics, { starting: false, surfaceY: shallowSurfaceY }) || Math.hypot(state.position.x - lowHealthSurfaceOrigin.x, state.position.z - lowHealthSurfaceOrigin.z) > 1.5)) throw new Error('Low-health surface body, breath, actor or distance changed')
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (shallowWaterRun && (!state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis])) || state.position.y - 1.62 < shallowSurfaceY - (briefSubmerge ? 1.85 : 1.60) || physical?.isInLava)) throw new Error('Shallow escape exceeded its known water depth')
                if (shallowWaterRun && briefSubmerge) {
                  if (state.position.y < shallowSurfaceY + 0.02) submergedSince ??= Date.now()
                  else submergedSince = null
                  if (submergedSince != null && Date.now() - submergedSince > 500) throw new Error('Surface recovery exceeded the bounded submersion time')
                }
                const actors = new Map([...current.threats, ...current.outside].map(actor => [actor.runtimeId, actor]))
                // Surface buoyancy is checked against its own depth/headroom
                // bounds above and below. It must not look like lateral
                // departure from an otherwise unchanged swimming corridor.
                const corridorDistance = point => shallowWaterRun ? Math.hypot(point.x - state.position.x, point.z - state.position.z) : distance(eye(point), state.position)
                const nearest = dropTrace.reduce((best, point, index) => index < dropTraceIndex ? best : !best || corridorDistance(point) < best.distance ? { index, distance: corridorDistance(point) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Controlled descent left its predicted corridor')
                dropTraceIndex = nearest.index
                const remaining = [state.position, ...dropTrace.slice(dropTraceIndex + 1).map(eye)]
                if (shallowWaterRun && (!shallowWaterCheck || !shallowWaterCheck(feet(state)) || dropTrace.slice(dropTraceIndex + 1, dropTraceIndex + 6).some(point => !shallowWaterCheck(point)))) throw new Error('Shallow escape terrain or headroom changed')
                if (current.outside.some(actor => !dropCircles.some(circle => circle.id === actor.runtimeId) && remaining.slice(1).some((point, index) => segmentDistance(actor.position, remaining[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Controlled descent newly exposed actor intersects the remaining path')
                for (const circle of dropCircles) {
                  const actor = actors.get(circle.id)
                  const entity = state.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === circle.id)
                  const unsafe = (reason, extra = {}) => Object.assign(new Error('Controlled descent actor or remaining path became unsafe'), { escapeDiagnostic: { reason, actorId: circle.id, actorName: actor?.name ?? null, ...extra } })
                  // A death event is authoritative evidence that this exact
                  // tracked actor no longer poses a collision threat. Missing,
                  // replaced or merely out-of-range actors remain unknown.
                  if (!actor && entity?.alive === false && String(entity.uniqueId) === circle.uniqueId && (entity.lastEvent?.event === 'death_animation' || entity.lastEvent?.event === 3)) continue
                  // A server remove event for an actor that was already
                  // outside the danger set means it is no longer tracked by
                  // this client. Any later add or approach is checked again.
                  const removed = !actor && !entity && !ids.has(circle.id) && (state.removedEntities ?? []).some(value => value.runtimeId === circle.id && value.uniqueId === circle.uniqueId)
                  if (removed) continue
                  if (!actor || String(entity?.uniqueId) !== circle.uniqueId || actor.dangerRadius > circle.radius) throw unsafe(!actor ? 'actor_unobserved' : String(entity?.uniqueId) !== circle.uniqueId ? 'identity_changed' : 'radius_increased')
                  // A pursuer may close in while the player moves away. In
                  // bounded surface water, recompute the remaining path from
                  // the current actor pose, without crossing hard floors.
                  const mobileWaterActor = shallowWaterRun && circle.horizontalMinimum != null
                  const distanceFloor = mobileWaterActor ? Math.max(circle.hardEye, Math.min(circle.minDistance, actor.distance - 0.4)) : circle.minDistance
                  if (actor.distance < (mobileWaterActor ? circle.hardEye : distanceFloor) - 1e-4) throw unsafe('actor_inside_floor', { distance: actor.distance, floor: mobileWaterActor ? circle.hardEye : distanceFloor })
                  const pathDistance = remaining.slice(1).reduce((min, point, index) => Math.min(min, segmentDistance(actor.position, remaining[index], point)), Infinity)
                  if (pathDistance < distanceFloor - 1e-4) throw unsafe('remaining_path_inside_floor', { distance: actor.distance, pathDistance, floor: distanceFloor })
                  const horizontal = Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z)
                  const horizontalFloor = mobileWaterActor ? Math.max(circle.hardHorizontal, Math.min(circle.horizontalMinimum, horizontal - 0.05)) : circle.horizontalMinimum
                  if (mobileWaterActor && (horizontal < circle.hardHorizontal || remaining.slice(1).some((point, index) => segmentDistance({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < horizontalFloor - 1e-4))) throw new Error('Shallow escape creeper horizontal distance became unsafe')
                }
              }
              if (remainingJumpTrace) {
                const currentFeet = feet(state)
                const nearest = remainingJumpTrace.reduce((best, point, index) => index < remainingJumpIndex ? best : !best || distance(point, currentFeet) < best.distance ? { index, distance: distance(point, currentFeet) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Idle bounded jump left its proven arc')
                remainingJumpIndex = nearest.index
                const points = [state.position, ...remainingJumpTrace.slice(remainingJumpIndex + 1).map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Idle bounded jump remaining arc danger changed')
              }
              if (remainingTargets) {
                const currentFeet = feet(state)
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (physical?.onGround !== false) {
                  const reached = remainingTargets.findLastIndex(point => Math.abs(currentFeet.y - point.y) <= 1e-4 && Math.hypot(currentFeet.x - point.x, currentFeet.z - point.z) <= 0.4)
                  if (reached >= 0) remainingTargets.splice(0, reached + 1)
                }
                const points = [state.position, ...remainingTargets.map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < (remainingConstrained ? constrainedFloors.get(actor.runtimeId) ?? actor.dangerRadius : actor.dangerRadius) - 1e-4))) throw new Error('Idle escape remaining path danger changed')
              }
            } catch (error) { controller.abort(error) } finally {
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                host.shared.perfObservations ??= {}
                host.shared.perfObservations.escapeInspectMs = Math.max(host.shared.perfObservations.escapeInspectMs ?? 0, performance.now() - startedAt)
              }
            }
          }
          // safetyState routes through inspectIdleEscape already; do not run
          // the expensive terrain/actor inspection twice for the same read.
          const ensure = () => surfaceTimed('ensure', () => { requireSafety(); if (signal.aborted) throw signal.reason; const observed = safetyState(); if (signal.aborted) throw signal.reason; return observed })
          const yieldPlanning = async () => {
            // Check ownership/abort cheaply before yielding. The one complete
            // fresh observation after the timer turn still performs inspect.
            requireSafety()
            if (signal.aborted) throw signal.reason
            maintainIdle()
            await new Promise(resolve => setImmediate(resolve))
            const state = ensure()
            maintainIdle()
            return state
          }
          const segmentDistance = (point, a, b) => {
            const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
            const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * delta.x + (point.y - a.y) * delta.y + (point.z - a.z) * delta.z) / length)) : 0
            return distance(point, { x: a.x + t * delta.x, y: a.y + t * delta.y, z: a.z + t * delta.z })
          }
          const constrainedPrimary = selectConstrainedPrimary(baseline.threats, initial.health)
          const constrainedFloors = new Map(baseline.threats.filter(actor => actor.runtimeId !== constrainedPrimary?.runtimeId).flatMap(actor => {
            const floor = unarmedMixed && actor.name === 'minecraft:zombie' ? unarmedZombieFloor(actor) : unarmedMixed && actor.name === 'minecraft:spider' ? activeUnarmedSpiderFloor(actor) : constrainedSecondaryFloor(actor, constrainedPrimary, baseline.threats, initial.health)
            const observed = ids.get(actor.runtimeId)
            return floor !== null && observed?.uniqueId != null ? [[actor.runtimeId, floor]] : []
          }))
          for (const actor of baseline.outside) if (outsideTracked.has(actor.runtimeId)) constrainedFloors.set(actor.runtimeId, (unarmedMixed ? outsideUnarmedSpiderFloor(actor) : null) ?? outsideSkeletonFloor(actor))
          const awayFromActors = (from, to, actors = known, constrained = false) => {
            const safe = actors.every(actor => segmentDistance(actor.position, eye(from), eye(to)) >= (constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? distance(actor.position, eye(from)) : actor.dangerRadius) - 1e-4)
            if (!safe) diagnostics.awayBlocked++
            return safe
          }
          const cellSafe = point => {
            try {
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder$|anvil$)/
              const cube = block => block.shapes.some(box => box.every((value, index) => value === [0, 0, 0, 1, 1, 1][index]))
              // Reject an endpoint whose player footprint reaches into a
              // neighbouring blocked cell, not just the centre column.
              for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
                const floor = generationPhysics.blockAt({ x, y: point.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) { diagnostics.floorBlocked++; return false }
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = generationPhysics.blockAt({ x, y: point.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) break
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) { diagnostics.floorBlocked++; return false }
                }
                for (const y of [point.y, point.y + 1]) { const body = generationPhysics.blockAt({ x, y, z }); if (hazard.test(body.name) || body.shapes.length) { diagnostics.bodyBlocked++; return false } }
              }
              return true
            } catch { diagnostics.terrainUnknown++; return false }
          }
          let timer; let watch
          inspectIdleEscape = inspect
          const inspectPacket = () => { try { safetyState() } catch (error) { controller.abort(error) } }
          inspectIdleEscapePacket = inspectPacket
          try {
            timer = setTimeout(() => controller.abort(new Error('Idle escape four-second deadline')), Math.max(1, deadline - Date.now()))
            watch = setInterval(() => { try { safetyState() } catch (error) { controller.abort(error) } }, 25)
            let planningState = initial; let episodeMovementStarts = fence.starts; let boundedJumpAttempted = false; let lastBoundedPartial = null
            escapePlanning: while (true) {
            ensure()
            const initial = planningState
            const baseline = assessEnemies(initial)
            const known = [...baseline.threats, ...baseline.outside]
            const primary = baseline.threats.find(actor => actor.runtimeId === context.threats?.[0]?.runtimeId) ?? baseline.threats[0]
            const away = (from, to, actors = known, constrained = false) => awayFromActors(from, to, actors, constrained)
            const origin = feet(initial)
            const lowHealthSurfaceDiagnostic = { observedAt: new Date().toISOString(), health: initial.health, reason: 'not_checked', previews: 0, ready: 0, attempts: 0, maxSlice: surfaceTiming.maxSlice }
            const receivedSurfaceOrigin = lowHealthSurfaceEligible(initial, known, generationPhysics, { diagnostic: lowHealthSurfaceDiagnostic })
            host.shared.lowHealthWaterDiagnostic = lowHealthSurfaceDiagnostic
            const alreadyShallow = receivedSurfaceOrigin || verifyShallowWater(initial, { signal, allowDeepSurface: true })
            const fullOrigin = alreadyShallow || await verifyRouteStanding(initial, origin, { signal })
            const partialOrigin = !fullOrigin && await verifyRouteOrigin(initial, origin, { signal, stablePartialOrigin: true })
            if (!primary && fullOrigin && !alreadyShallow) {
              const retreat = await tryRecentDamageNoPrimary({ ...initial, lifecycle: { phase: 'alive', deathId: actualLifeId(), dead: initial.dead === true } }, { ...context, signal, movementBudget: Math.max(0, 5 - episodeMovementStarts), onMovementStart: () => { episodeMovementStarts++; fence.starts = episodeMovementStarts } }, deadline)
              if (retreat) return retreat
            }
            if (!primary || !alreadyShallow && !fullOrigin && !partialOrigin) {
              const physical = initial.predicted?.physicsState ?? initial.physicsState
              if (primary && resourceMinHealth(initial) === 0 && partialEscapeAction && physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody(initial, { signal })) return partialEscapeAction({ ...context, signal })
              return { supported: false, reason: 'no_known_escape_origin' }
            }
            const urgentCreeper = baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 4.5
            const queue = alreadyShallow ? [] : [{ position: origin, depth: 0 }]; const visited = new Set(); const candidates = []; const partials = []; let planningChecks = 0
            let planningSlice = surfaceMark()
            const yieldCandidatePlanning = async (force = false) => {
              if (!force && ++planningChecks % 64 !== 0 && performance.now() - planningSlice.at < 12) return
              surfaceRecord('escapeCandidateSlice', planningSlice)
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                host.shared.perfObservations ??= {}
                host.shared.perfObservations.escapePlanningMaxSliceMs = Math.max(host.shared.perfObservations.escapePlanningMaxSliceMs ?? 0, surfaceTiming.lastSlice.ms)
              }
              await yieldPlanning()
              planningSlice = surfaceMark()
            }
            for (let i = 0; i < queue.length && i < (urgentCreeper ? 24 : 256); i++) {
              // Yield often enough for incoming actor, damage and abort
              // packets while bounding the cost of the local BFS.
              if ((i & 15) === 0) await yieldCandidatePlanning(true)
              const node = queue[i]
              if (node.depth >= (urgentCreeper ? 3 : 6)) continue
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
                await yieldCandidatePlanning()
                const target = { x: Math.floor(node.position.x) + dx + 0.5, y: Math.round(node.position.y) + dy, z: Math.floor(node.position.z) + dz + 0.5 }
                const key = [target.x, target.y, target.z].join(',')
                if (visited.has(key) || !cellSafe(target) || !away(node.position, target)) continue
                if (distance(primary.position, eye(target)) < distance(primary.position, eye(node.position)) + 0.25) { diagnostics.gainBlocked++; continue }
                visited.add(key); queue.push({ position: target, depth: node.depth + 1 })
                const gain = distance(primary.position, eye(target)) - primary.distance
                if (gain >= 0.25) {
                  const candidate = { target, depth: node.depth + 1, gain }
                  if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
                  else if (baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + 0.15)) partials.push(candidate)
                }
              }
            }
            // Grid-only steps can be trapped between two hostile circles even
            // when a diagonal path on the same known floor moves away from
            // both. Try finite headings; Nav and Guard verify the full path.
            for (let angle = 0; !alreadyShallow && angle < 32; angle += urgentCreeper ? 2 : 1) for (const length of urgentCreeper ? [0.75, 1, 1.5, 2] : [0.75, 1, 1.5, 2, 4, 6]) {
              await yieldCandidatePlanning()
              const theta = angle * Math.PI / 16
              const target = { x: origin.x + Math.cos(theta) * length, y: origin.y, z: origin.z + Math.sin(theta) * length }
              // A short diagonal can unlock the next safe segment between
              // several threat circles. Guard still requires a 0.25 gain from
              // the primary and validates the entire swept route.
              const minimumGain = length < 2 ? 0.15 : 0.5
              if (!cellSafe(target) || !away(origin, target)) continue
              if (distance(primary.position, eye(target)) < primary.distance + 0.25 || !baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + minimumGain)) { diagnostics.gainBlocked++; continue }
              const candidate = { target, depth: Math.ceil(length), gain: distance(primary.position, eye(target)) - primary.distance }
              if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Small offsets within the adjacent cell matter when the opening
            // is bordered by leaves or trunks; the body is wider than a point.
            const originOffsets = partialOrigin ? [0, -0.15, 0.15, -0.25, 0.25] : [0, -0.15, 0.15]
            const originDirections = partialOrigin ? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]
            for (const [dx, dz] of (alreadyShallow ? [] : originDirections)) for (const dy of (partialOrigin ? [0, -1] : [0])) for (const ox of originOffsets) for (const oz of originOffsets) {
              await yieldCandidatePlanning()
              if (!dx && !dz && dy) continue
              const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
              const gain = distance(primary.position, eye(target)) - primary.distance
              if (distance(origin, target) > 2 || gain < 0.25 || !cellSafe(target) || !away(origin, target) || !baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + 0.15)) continue
              const boundedRecenter = partialOrigin && !dy && distance(origin, target) <= 1.2
              const candidate = { target, depth: 1, gain, ...(boundedRecenter ? { recenter: true, recenterOffset: Math.abs(ox) + Math.abs(oz) } : {}) }
              if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Prefer useful pause clearance over the first point just outside
            // a hostile radius. Every chosen route still uses the actual hard
            // distance floors, complete body checks and the same deadline.
            const pauseClearance = candidate => Math.min(...known.map(actor => distance(actor.position, eye(candidate.target)) - actor.dangerRadius - WORK_MARGIN))
            candidates.sort((a, b) => pauseClearance(b) - pauseClearance(a) || b.gain - a.gain || a.depth - b.depth)
            partials.sort((a, b) => initial.health <= 6 ? a.depth - b.depth || b.gain - a.gain : b.gain - a.gain || a.depth - b.depth)
            diagnostics.visited = visited.size; diagnostics.candidates = candidates.length; diagnostics.partials = partials.length
            const choices = candidates.length ? [...candidates.slice(0, 6), ...partials.slice(0, 6)] : partials.slice(0, 12)
            // A nearby creeper leaves little time for previews. Include one
            // partial escape when available: a distant destination can fail
            // even though a shorter, guarded move away is feasible. The
            // supervisor can replan after that move from fresh observations.
            if (!['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 6.5) {
              const shortPartial = partials.filter(candidate => primary.distance + candidate.gain < primary.dangerRadius - 0.1 && candidate.gain >= 0.5).sort((a, b) => distance(origin, a.target) - distance(origin, b.target) || b.gain - a.gain)[0]
              const first = candidates[0] ?? shortPartial ?? partials[0]
              const second = candidates[0] ? shortPartial ?? partials[0] ?? candidates[1] : partials.find(candidate => candidate !== first)
              const next = [...partials, ...candidates].filter(candidate => candidate !== first && candidate !== second).sort((a, b) => distance(origin, a.target) - distance(origin, b.target))
              choices.splice(0, choices.length, ...[first, second, ...next.slice(0, 2)].filter(Boolean))
            }
            // The leaf planner has already simulated a route through the
            // intended opening. Recheck that exact point against the latest
            // terrain and actors, then run the ordinary live preview and Guard.
            const preferred = context.preferredTarget
            if (['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && preferred && ['x', 'y', 'z'].every(axis => Number.isFinite(preferred[axis])) && distance(origin, preferred) <= 2 && Math.abs(preferred.y - origin.y - (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) ? 1 : 0)) < 1e-4 && distance(primary.position, eye(preferred)) >= primary.distance + 0.25 && cellSafe(preferred) && away(origin, preferred)) choices.unshift({ target: { ...preferred }, depth: 1, gain: distance(primary.position, eye(preferred)) - primary.distance })
            // If no route moves away from every current enemy, consider a
            // single adjacent step that still moves away from the primary.
            // Only identified distant secondary zombies, spiders or skeletons
            // may lose up to 1.5 blocks, never below their fixed floors. The
            // Guard independently enforces the same bounds on every segment.
            const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
            const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1)
            if (initial.health > 6 && (sword || unarmedMixed) && baseline.threats.length > 1 && constrainedFloors.size && baseline.threats.every(actor => ids.get(actor.runtimeId)?.uniqueId != null)) {
              const constrainedChoices = []
              let checked = 0
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, -1, 1]) for (const ox of [0, -0.15, 0.15]) for (const oz of [0, -0.15, 0.15]) {
                if (++checked % 12 === 0) await yieldPlanning()
                const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
                const gain = distance(constrainedPrimary.position, eye(target)) - constrainedPrimary.distance
                if (distance(origin, target) > 2 || gain < 0.25 || !cellSafe(target) || !away(origin, target, known, true)) continue
                constrainedChoices.push({ target, depth: 1, gain, constrained: true })
              }
              constrainedChoices.sort((a, b) => b.gain - a.gain)
              choices.push(...constrainedChoices)
            }
            let lastRejected = null
            const previewCandidate = async candidate => {
              await yieldPlanning(); motionOrigin = working()
              diagnostics.previews++
              // The actor may have moved while the bounded search yielded.
              // Use its newest received position for each live preview; the
              // identity/radius check in ensure() still fences new dangers.
              const previewState = safetyState(), current = assessEnemies(previewState)
              let currentKnown = [...current.threats, ...current.outside]
              const avoidance = currentKnown.map(actor => {
                const minDistance = candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                // Guard uses this padding rule for its live movement preview.
                // Checking with zero padding here could select a candidate the
                // Guard immediately rejects, wasting the emergency deadline.
                const padding = candidate.constrained ? 0 : Math.min(0.5, Math.max(0, distance(actor.position, eye(candidate.target)) - minDistance))
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding }
              })
              const live = generationMovement.preview(candidate.target, { emergency: true, allowWater: false, directFlat: true, exactGoal: true, stablePartialOrigin: true, maxDistance: 8, maxExpanded: 800, avoidance })
              if (!live.ready || !Array.isArray(live.waypoints) || !live.waypoints.length || live.waypoints.length > 8) return null
              const refreshed = await yieldPlanning()
              if (distance(refreshed.position, previewState.position) > 0.05) return null
              const refreshedActors = assessEnemies(refreshed)
              currentKnown = [...refreshedActors.threats, ...refreshedActors.outside]
              diagnostics.readyPreviews++
              let previous = feet(safetyState()); let allowed = true
              for (const [index, waypoint] of live.waypoints.entries()) {
                const point = waypoint.position
                const sameCellConnector = point && index === 0 && Math.floor(point.x) === Math.floor(previous.x) && Math.floor(point.z) === Math.floor(previous.z) && Math.abs(point.y - previous.y) <= 1e-4 && distance(point, previous) <= (partialOrigin && candidate.recenter ? 1.2 : 0.5)
                const diagonalConnector = point && index === 0 && waypoint.action === 'walk' && Math.abs(point.y - previous.y) <= 1e-4 && Math.abs(Math.floor(point.x) - Math.floor(previous.x)) === 1 && Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1 && distance(point, previous) <= 1.5 && Array.from({ length: Math.max(1, Math.ceil(distance(point, previous) / 0.1)) + 1 }, (_, i) => i / Math.max(1, Math.ceil(distance(point, previous) / 0.1))).every(ratio => cellSafe({ x: previous.x + (point.x - previous.x) * ratio, y: previous.y, z: previous.z + (point.z - previous.z) * ratio }))
                const adjacent = point && (sameCellConnector || diagonalConnector || live.directFlat === true && live.waypoints.length === 1 && Math.abs(point.y - previous.y) <= 1e-4 && distance(point, previous) <= 6.1 || Math.abs(Math.floor(point.x) - Math.floor(previous.x)) + Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1)
                // A safe detour can turn slightly toward an actor after first
                // increasing separation. Keep the fixed observed minimum for
                // every segment, as the independent Guard also does.
                const corridorSafe = point && currentKnown.every(actor => segmentDistance(actor.position, eye(previous), eye(point)) >= (candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)
                // The received feet position can be a few float32 microns
                // above its block height; keep the same contact tolerance as
                // navigation when checking a one-block elevation change.
                if (!adjacent || waypoint.medium !== 'land' || !['walk', 'jump'].includes(waypoint.action) || Math.abs(point.y - previous.y) > 1.0001 || !cellSafe(point) || !corridorSafe) { allowed = false; break }
                previous = point
              }
              if (!allowed || distance(previous, candidate.target) > 0.05 || candidate.constrained && live.waypoints.length !== 1) return null
              // Rehearse descents and short multi-threat routes. A geometrical
              // target can be reachable while the settled pose falls short of
              // Guard's required gain or needs an unreceived lower block.
              const descentState = safetyState()
              const shortMultiThreat = baseline.threats.length > 1 && Math.hypot(candidate.target.x - descentState.position.x, candidate.target.z - descentState.position.z) <= 2.5
              if (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) || candidate.recenter || candidate.target.y < feet(descentState).y - 0.5 || shortMultiThreat) {
                try {
                  const navigator = createNavigator({ world: planningWorld, version: host.meta.version, physics: generationPlanningPhysics })
                  const initialPhysics = navigator.physics.fromServer(descentState)
                  const simulated = navigator.createStepper(live, initialPhysics, { maxTicks: 80, sprint: false })
                  let last = descentState.position; let complete = false
                  for (let tick = 0; tick < 80; tick++) {
                    if (tick > 0 && tick % 4 === 0) {
                      const current = await yieldPlanning()
                      if (distance(current.position, descentState.position) > 0.05) return null
                      const actors = assessEnemies(current)
                      currentKnown = [...actors.threats, ...actors.outside]
                    }
                    const frame = simulated.next(); const point = eye(frame.predictedState.position)
                    if (frame.predictedState.isInWater || frame.predictedState.isInLava || currentKnown.some(actor => segmentDistance(actor.position, last, point) < (candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)) break
                    last = point
                    if (frame.phase === 'awaiting_server_confirmation') { complete = !['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) || navigator.verifyOrigin(frame.predictedState); break }
                    if (frame.phase !== 'moving') break
                  }
                  const predictedPrimary = currentKnown.find(actor => actor.runtimeId === (candidate.constrained ? constrainedPrimary.runtimeId : primary.runtimeId))
                  if (!complete || !predictedPrimary || distance(predictedPrimary.position, last) < distance(predictedPrimary.position, descentState.position) + 0.25) return null
                } catch { return null }
              }
              return live
            }
            if (partialOrigin) {
              // First restore a complete footprint within the current or an
              // adjacent cell, using the same bounded partial-origin connector.
              // A valid cell centre has more landing margin than an offset;
              // prove at most two short choices before the ordinary gain list.
              const recenters = [...candidates, ...partials].filter(candidate => candidate.recenter).sort((a, b) => a.recenterOffset - b.recenterOffset || distance(origin, a.target) - distance(origin, b.target) || b.gain - a.gain).slice(0, 2)
              choices.splice(0, choices.length, ...recenters, ...choices.filter(candidate => !candidate.recenter))
            }
            const jumpHungerReady = state => {
              const value = state.vitals?.hunger
              const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
              const observedAt = time(value?.observedAt), startedAt = time(state.startedAt)
              const matchingScope = ['connectionId', 'startedAt', 'runtimeEntityId'].every(key => value?.[key] == null || String(value[key]) === String(state[key]))
              return value?.source === 'server_attribute' && Number.isFinite(value.value) && value.value > 6 && value.value <= 20 && !!state.connectionId && Number.isFinite(startedAt) && matchingScope && Number.isFinite(observedAt) && observedAt <= Date.now() && observedAt >= startedAt
            }
            let jumpNavigator = null
            const previewJump = candidate => {
              const state = ensure()
              jumpSearchDiagnostic.hungerReady = jumpHungerReady(state)
              if (alreadyShallow || boundedJumpAttempted || !jumpSearchDiagnostic.hungerReady || !['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => state[key] === initial[key]) || String(state.realm?.id) !== String(initial.realm?.id)) return null
              const current = assessEnemies(state), actors = [...current.threats, ...current.outside]
              const primary = current.threats.find(actor => actor.runtimeId === baseline.threats[0]?.runtimeId) ?? current.threats[0]
              if (!primary) return null
              const circles = target => actors.map(actor => {
                const minDistance = ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding: target ? Math.min(0.5, Math.max(0, distance(actor.position, eye(target)) - minDistance)) : 0 }
              })
              try {
                motionOrigin = working()
                const settings = { emergency: true, sprint: true, allowWater: false, stablePartialOrigin: true, maxDistance: 8, boundedJump: candidate.boundedJump }
                jumpSearchDiagnostic.previews++
                const first = generationMovement.preview(null, { ...settings, avoidance: circles(null) })
                if (!first.ready || !first.boundedJump || !first.target) return null
                jumpSearchDiagnostic.previews++
                const live = generationMovement.preview(first.target, { ...settings, avoidance: circles(first.target) })
                if (!live.ready || !live.boundedJump || !live.target || !Array.isArray(live.predictedTrace) || !Array.isArray(live.neutralCoastTrace) || live.predictedTrace.length < 3 || live.predictedTrace.length > 41 || live.neutralCoastTrace.length < 3 || live.neutralCoastTrace.length > 41 || !(live.apexDrop < 3)) return null
                const safeSegments = points => points.every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) && points.slice(1).every((point, index) => actors.every(actor => segmentDistance(actor.position, eye(points[index]), eye(point)) >= (ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4))
                if (!safeSegments(live.predictedTrace) || !safeSegments(live.neutralCoastTrace) || distance(primary.position, eye(live.target)) < primary.distance + 0.25) return null
                jumpNavigator ??= createNavigator({ world: planningWorld, version: host.meta.version, physics: generationPlanningPhysics })
                const rehearsal = jumpNavigator.createStepper(live, generationPlanningPhysics.fromServer(state), { maxTicks: 40, sprint: true })
                let complete = false
                for (let tick = 0; tick < 40; tick++) {
                  const frame = rehearsal.next()
                  if (frame.phase === 'awaiting_server_confirmation') { complete = frame.boundedJumpLanded === true && jumpNavigator.verifyOrigin(frame.predictedState); break }
                  if (frame.phase !== 'moving') break
                }
                if (!complete) return null
                candidate.target = { ...live.target }
                candidate.gain = distance(primary.position, eye(live.target)) - primary.distance
                candidate.pauseClearance = Math.min(...actors.map(actor => distance(actor.position, eye(live.target)) - actor.dangerRadius - WORK_MARGIN))
                return live
              } catch { return null }
            }
            const measuredJumpPreview = candidate => {
              const startedAt = performance.now()
              jumpSearchDiagnostic.candidates++
              try {
                const preview = previewJump(candidate)
                if (preview) jumpSearchDiagnostic.verified++
                else jumpSearchDiagnostic.rejected++
                return preview
              } finally {
                const endedAt = performance.now()
                jumpSearchDiagnostic.maxSliceMs = Math.max(jumpSearchDiagnostic.maxSliceMs, Math.round((endedAt - startedAt) * 10) / 10)
                if (jumpSearchStartedAt !== null) jumpSearchDiagnostic.elapsedMs = Math.round((endedAt - jumpSearchStartedAt) * 10) / 10
              }
            }
            async function * escapeChoices () {
              const tiny = choices[0]
              const compareTiny = urgentCreeper && !['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && !alreadyShallow && !boundedJumpAttempted && tiny && Math.hypot(tiny.target.x - origin.x, tiny.target.z - origin.z) < 1
              if (compareTiny) {
                jumpSearchStartedAt = performance.now()
                jumpSearchDiagnostic.reason = 'priority_search'
                const yaw = -Math.atan2(origin.x - primary.position.x, origin.z - primary.position.z) * 180 / Math.PI
                const center = ((Math.round(yaw / 11.25) % 32) + 32) % 32
                const headings = [0, 1, -1, 2, -2, 3, -3].map(offset => (center + offset + 32) % 32)
                priorityJump: for (const driveTicks of [9, 6, 3]) for (const heading of headings) {
                  await yieldPlanning()
                  jumpSearchDiagnostic.hungerReady = jumpHungerReady(ensure())
                  if (!jumpSearchDiagnostic.hungerReady) { jumpSearchDiagnostic.reason = 'hunger_unready'; break priorityJump }
                  diagnostics.boundedJumpPreviews = (diagnostics.boundedJumpPreviews ?? 0) + 1
                  const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                  if (!measuredJumpPreview(candidate)) continue
                  const current = assessEnemies(ensure()), actors = [...current.threats, ...current.outside]
                  const currentPrimary = current.threats.find(actor => actor.runtimeId === primary.runtimeId)
                  const ordinaryGain = currentPrimary ? distance(currentPrimary.position, eye(tiny.target)) - currentPrimary.distance : Infinity
                  const ordinaryClearance = Math.min(...actors.map(actor => distance(actor.position, eye(tiny.target)) - actor.dangerRadius - WORK_MARGIN))
                  if (candidate.gain <= ordinaryGain || candidate.pauseClearance <= ordinaryClearance) continue
                  jumpSearchDiagnostic.reason = 'priority_ready'
                  yield candidate
                  break priorityJump
                }
                if (jumpSearchDiagnostic.reason === 'priority_search') jumpSearchDiagnostic.reason = 'no_stronger_arc'
              }
              for (const candidate of choices) yield candidate
              if (compareTiny) return
              if (alreadyShallow) { jumpSearchDiagnostic.reason = 'not_dry'; return }
              if (boundedJumpAttempted) return
              jumpSearchStartedAt = performance.now()
              jumpSearchDiagnostic.reason = 'searching'
              const jumps = []
              // Prove a small useful-clearance shortlist before committing a
              // tape. Longer drive can retain the same floors under pursuit.
              jumpSearch: for (const driveTicks of [9, 6, 3]) for (let heading = 0; heading < 32; heading++) {
                if (boundedJumpAttempted) return
                await new Promise(resolve => setImmediate(resolve))
                jumpSearchDiagnostic.hungerReady = jumpHungerReady(ensure())
                if (!jumpSearchDiagnostic.hungerReady) { jumpSearchDiagnostic.reason = 'hunger_unready'; jumpSearchDiagnostic.elapsedMs = Math.round((performance.now() - jumpSearchStartedAt) * 10) / 10; return }
                diagnostics.boundedJumpPreviews = (diagnostics.boundedJumpPreviews ?? 0) + 1
                const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                if (measuredJumpPreview(candidate)) {
                  jumps.push(candidate)
                  jumps.sort((a, b) => b.pauseClearance - a.pauseClearance || b.gain - a.gain)
                  jumps.splice(3)
                  if (jumps.length === 3) break jumpSearch
                }
              }
              jumpSearchDiagnostic.reason = jumps.length ? 'shortlist_ready' : 'no_safe_arc'
              for (const candidate of jumps) yield candidate
            }
            for await (const candidate of escapeChoices()) {
              const live = candidate.boundedJump ? measuredJumpPreview(candidate) : await previewCandidate(candidate)
              if (!live) { if (candidate.boundedJump) jumpSearchDiagnostic.reason = 'fresh_preview_rejected'; continue }
              ensure()
              remainingTargets = candidate.boundedJump ? null : live.waypoints.map(waypoint => ({ ...waypoint.position }))
              remainingJumpTrace = candidate.boundedJump ? [...live.predictedTrace, ...live.neutralCoastTrace.slice(1)].map(point => ({ ...point })) : null
              remainingJumpIndex = 0
              remainingConstrained = candidate.constrained === true
              const before = safetyState()
              const historyBefore = generationHistory.snapshot()
              // Server corrections can legitimately require several restarts
              // while the actor is already making guarded progress. The same
              // four-second episode deadline and per-frame threat checks still
              // bound the additional attempts.
              const remainingStarts = 5 - episodeMovementStarts
              if (remainingStarts < 1) return { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'START_LIMIT', movementStarts: episodeMovementStarts, safe: false }
              if (candidate.boundedJump) {
                boundedJumpAttempted = true
                jumpSearchDiagnostic.attempts++
                jumpSearchDiagnostic.chosen = { heading: live.boundedJump.heading, driveTicks: live.boundedJump.driveTicks, flightTicks: live.jumpFrames.length, expectedGain: candidate.gain }
                jumpSearchDiagnostic.reason = 'guard_attempt'
              }
              fence.guardInvoked = true
              const nativeProgressLife = actualLifeId()
              const result = await generationGuardRoute.escape([{ ...candidate.target }], { signal, timeoutMs: Math.max(100, deadline - Date.now()), maxMovementStarts: remainingStarts, maxLegDistance: candidate.constrained ? 2 : 8, allowUnarmedBootstrap: !candidate.constrained || unarmedMixed, allowConstrainedEscape: candidate.constrained === true, maxBootstrapNodes: 4, maxBootstrapDistance: 10, retainedActors, ...(candidate.boundedJump ? { boundedJump: live.boundedJump } : {}) })
              if (candidate.boundedJump) jumpSearchDiagnostic.reason = result.ok === true && result.arrived === true ? 'landed' : 'guard_rejected'
              const consumedStarts = Number.isSafeInteger(result.movementStarts) && result.movementStarts > 0 ? result.movementStarts : 0
              episodeMovementStarts += Math.min(remainingStarts, consumedStarts)
              fence.starts = episodeMovementStarts
              remainingTargets = null
              remainingJumpTrace = null
              remainingConstrained = false
              ensure()
              const after = safetyState(); const evaluation = evaluateThreats(after, after.entities, { observationRadius: 32 })
              if (candidate.boundedJump && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                const queued = generationHistory.snapshot().navigationQueued > historyBefore.navigationQueued
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (!queued || consumedStarts < 1 || !sameScope || after.health < before.health || !await verifyRouteStanding(after, feet(after), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: episodeMovementStarts, safe: false }
                const current = ensure()
                if (!verifyRouteStanding(current, feet(current), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: episodeMovementStarts, safe: false }
                const workClearancePending = resolveWorkActors(after, evaluation, retainedActors).actors.length > 0
                lastBoundedPartial = { ...result, supported: true, movementStarts: episodeMovementStarts, escaped: result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: evaluation.threats.length > 0 || workClearancePending, workClearancePending, returned: false, refugeConfirmed: false, safe: false }
                if (!lastBoundedPartial.partialEscape || episodeMovementStarts >= 5) return lastBoundedPartial
                planningState = await yieldPlanning()
                continue escapePlanning
              }
              if (result.code === 'ESCAPE_PROGRESS_REPLAN') {
                const progress = result.progressReplan
                const previousEvaluation = evaluateThreats(before, before.entities, { observationRadius: 32 })
                const previousActors = new Map([...previousEvaluation.threats, ...previousEvaluation.outsideDanger, ...previousEvaluation.suppressedByTerrain].map(actor => [actor.runtimeId, actor]))
                const sameActors = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].every(actor => {
                  const previous = previousActors.get(actor.runtimeId)
                  const beforeEntity = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  const afterEntity = after.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  return previous && previous.name === actor.name && actor.dangerRadius <= previous.dangerRadius && (beforeEntity?.uniqueId == null || String(beforeEntity.uniqueId) === String(afterEntity?.uniqueId))
                })
                const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
                const beforeStamp = stamp(before.rawServerPositionUpdatedAt ?? before.positionUpdatedAt)
                const afterStamp = stamp(after.rawServerPositionUpdatedAt ?? after.positionUpdatedAt)
                const proofStamp = stamp(progress?.authoritativeStamp)
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (progress?.kind === 'native_partial_landing') {
                  const eligible = sameScope && sameActors && actualLifeId() === nativeProgressLife && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.primaryGain) && progress.primaryGain >= 0.1 && progress.primaryGain < 0.25 && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.1 && /^\d+$/.test(String(progress.queuedTick)) && Number.isFinite(beforeStamp) && beforeStamp === afterStamp
                  const expectedAnchor = historyBefore.anchorTick ?? (historyBefore.stationary?.neutralFrames >= 8 ? historyBefore.stationary.checkpointTick : null)
                  let nativeBinding = null
                  const bindNativeLanding = state => {
                    if (!eligible || signal.aborted || actualLifeId() !== nativeProgressLife || state.health !== before.health || ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].some(key => before[key] !== state[key]) || String(before.realm?.id) !== String(state.realm?.id) || stamp(state.rawServerPositionUpdatedAt ?? state.positionUpdatedAt) !== beforeStamp || !state.rawServerPosition || !before.rawServerPosition || distance(state.rawServerPosition, before.rawServerPosition) > 1e-4 || !progress.position || distance(state.position, progress.position) > 0.05) return false
                    const evaluated = evaluateThreats(state, state.entities, { observationRadius: 32 })
                    if (evaluated.requiresObservation || state.entityStats?.unknownPositions > evaluated.unknownPositions.length || [...evaluated.threats, ...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].some(actor => {
                      const old = previousActors.get(actor.runtimeId), original = before.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId), current = state.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId)
                      return !old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || original?.uniqueId == null || String(current?.uniqueId) !== String(original.uniqueId)
                    })) return false
                    const witness = generationHistory.witness({ scope: historyScope(state), health: state.health, position: state.position })
                    if (!witness.ready || expectedAnchor == null || witness.anchorTick !== expectedAnchor || stamp(witness.anchor?.rawStamp) !== beforeStamp || witness.navigationQueued <= historyBefore.navigationQueued || witness.queuedTicks < 1 || !Array.isArray(witness.physicsTrace)) return false
                    // The first real moving frame freezes an already queued
                    // eight-neutral raw checkpoint. Retain that exact anchor
                    // and lease; never create or refresh one for this handoff.
                    if (historyBefore.anchorTick != null ? witness.anchor?.leaseAt !== historyBefore.leaseAt : witness.anchor?.kind !== 'stationary_raw_checkpoint' || witness.anchor?.derived !== true || witness.anchor?.checkpointTick !== expectedAnchor) return false
                    if (nativeBinding && (witness.anchorTick !== nativeBinding.anchorTick || witness.anchor?.leaseAt !== nativeBinding.leaseAt)) return false
                    const landingIndex = witness.physicsTrace.findIndex(frame => String(frame.tick) === String(progress.queuedTick))
                    const landing = witness.physicsTrace[landingIndex]
                    if (!landing || distance(landing.position, progress.position) > 1e-4 || landing.physicsState?.onGround !== true || landing.physicsState.isInWater || landing.physicsState.isInLava) return false
                    const currentActors = assessEnemies(state), points = [...witness.physicsTrace.slice(landingIndex).map(frame => frame.position), state.position]
                    for (const actor of [...currentActors.threats, ...currentActors.outside]) {
                      const floor = constrainedFloors.get(actor.runtimeId) ?? (ids.has(actor.runtimeId) ? Math.min(ids.get(actor.runtimeId).distance, actor.distance) : actor.dangerRadius)
                      for (let index = 1; index < points.length; index++) if (segmentDistance(actor.position, points[index - 1], points[index]) < floor - 1e-4) return false
                    }
                    nativeBinding ??= { anchorTick: witness.anchorTick, leaseAt: witness.anchor.leaseAt }
                    return true
                  }
                  if (!bindNativeLanding(after) || episodeMovementStarts >= 5 || Date.now() >= deadline || !await verifyRouteStanding(after, feet(after), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  const current = await yieldPlanning()
                  if (!bindNativeLanding(current) || Date.now() >= deadline || !await verifyRouteStanding(current, feet(current), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  planningState = current
                  continue escapePlanning
                }
                if (progress?.kind === 'queued_prediction_tail') {
                  const eligible = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp === afterStamp
                  const current = eligible && episodeMovementStarts < 5 && Date.now() < deadline ? await verifyQueuedTailHandoff(result, after, { signal, operationId: context.operationId }) : null
                  if (!current || Date.now() >= deadline) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  planningState = current
                  continue escapePlanning
                }
                // Idle physics may coast after the Guard drains its sender.
                // Bind the receipt to the unchanged authoritative position,
                // then prove the current model's coherence and origin anew.
                const sameReceipt = progress?.position && progress.authoritativePosition && after.rawServerPosition && distance(progress.position, progress.authoritativePosition) <= 0.05 && distance(progress.authoritativePosition, after.rawServerPosition) <= 0.05 && distance(after.position, after.rawServerPosition) <= 0.75
                const freshProgress = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && distance(before.position, after.position) >= 0.25 && Number.isFinite(progress?.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp > beforeStamp && proofStamp <= afterStamp && sameReceipt
                if (!freshProgress || episodeMovementStarts >= 5 || !await verifyRouteOrigin(after, feet(after), { signal, stablePartialOrigin: true })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                // The Guard has drained its old sender. Discard every old
                // candidate and sample this newly observed origin, while the
                // same controller, deadline and start budget remain active.
                planningState = after
                continue escapePlanning
              }
              // A preliminary preview can differ from Guard's actor-aware
              // preview. Try another known candidate only if no movement was
              // started, the pose remains essentially unchanged and the
              // enemy has not entered immediate reach.
              const rejectedPreview = result.routeRejection?.reason === 'invalid_route' && result.routeRejection?.detail === 'preview_not_ready' && result.routeInterruption?.reason === 'No known route stays clear of the observed dangers'
              if (!result.ok && result.movementStarts === 0 && (result.code === 'NO_SAFE_RETREAT' || result.routeInterruption?.code === 'NO_SAFE_RETREAT' || rejectedPreview) && distance(before.position, after.position) < 0.1 && evaluation.threats.every(actor => actor.distance > 3.5)) { lastRejected = result; continue }
              const reached = result.escaped === true && result.arrived === true && !evaluation.requiresObservation
              const workClearancePending = resolveWorkActors(after, evaluation, retainedActors).actors.length > 0
              const returned = { ...result, supported: true, movementStarts: episodeMovementStarts, constrainedEscape: candidate.constrained === true, constrainedPrimaryId: candidate.constrained ? constrainedPrimary.runtimeId : null, escaped: reached && result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: reached && (evaluation.threats.length > 0 || workClearancePending) && evaluation.threats.every(actor => ids.has(actor.runtimeId) || candidate.constrained && outsideTracked.has(actor.runtimeId)), workClearancePending, returned: false, refugeConfirmed: false, safe: false }
              if (boundedJumpAttempted && returned.partialEscape && result.ok === true && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                lastBoundedPartial = returned
                const tracked = assessEnemies(after).threats
                const legacyRecovered = tracked.every(actor => {
                  const old = ids.get(actor.runtimeId)
                  if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
                  if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
                    const previous = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                    const previousDistance = previous?.position ? distance(previous.position, before.position) : Infinity
                    return actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previousDistance - 0.6)
                  }
                  return actor.distance >= old.distance - 0.5
                })
                if (workClearancePending && !legacyRecovered && episodeMovementStarts < 5 && Date.now() < deadline && await verifyRouteStanding(after, feet(after), { signal })) {
                  const current = ensure()
                  if (verifyRouteStanding(current, feet(current), { signal })) { planningState = current; continue escapePlanning }
                }
              }
              const witness = generationHistory.witness({ scope: historyScope(after), health: after.health, position: after.position })
              if (returned.partialEscape && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeRejection && !result.remainingRouteRejection && !result.routeInterruption && consumedStarts > 0 && witness.ready === true && witness.navigationQueued > historyBefore.navigationQueued && witness.queuedTicks > 0 && after.health === before.health && distance(before.position, after.position) >= 0.1 && Date.now() <= deadline && await verifyRouteStanding(after, feet(after), { signal })) {
                completedDryProofs.set(returned, { operationId: context.operationId, health: after.health, revision: witness.revision, anchorTick: witness.anchorTick, anchorKind: witness.anchor?.kind, checkpointTick: witness.anchor?.checkpointTick, leaseAt: witness.anchor?.leaseAt, navigationQueued: witness.navigationQueued, rawPosition: structuredClone(after.rawServerPosition), rawStamp: after.rawServerPositionUpdatedAt })
                if (!await verifyCompletedDryProgress(returned, after, { signal, operationId: context.operationId }) || Date.now() > deadline) completedDryProofs.delete(returned)
              }
              return returned
            }
            // When an ordinary escape is unavailable, a healthy unarmed bot
            // can use either a known short descent away from one drowned or a
            // short dry detour around water near one distant spider. Both use
            // fully simulated trajectories and monitor every known actor.
            const drySpiderDetour = initial.health === 20 && baseline.threats.length >= 1 && baseline.threats.length <= 2 && baseline.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 9.5)
            const drownedDrop = initial.health >= 18 && baseline.threats.length === 1 && primary.name === 'minecraft:drowned' && primary.distance >= 10.5
            if (!alreadyShallow && !lastRejected && (drySpiderDetour || drownedDrop) && !sword && initial.inventory?.known === true && !initial.inventory.uncertain && ids.get(primary.runtimeId)?.uniqueId != null) {
              const current = assessEnemies(safetyState())
              const currentPrimary = current.threats.find(actor => actor.runtimeId === primary.runtimeId)
              const actors = [...current.threats, ...current.outside]
              if (currentPrimary && (drySpiderDetour ? current.threats.length === baseline.threats.length && current.threats.every(actor => ids.has(actor.runtimeId) && actor.name === 'minecraft:spider' && actor.distance >= 9.5) : current.threats.length === 1)) {
                const circles = actors.map(actor => {
                  const entity = initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
                  return { id: actor.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: actor.dangerRadius, position: { ...actor.position }, minDistance: ids.has(actor.runtimeId) ? drySpiderDetour ? Math.max(9, actor.distance - 0.5) : actor.distance : actor.dangerRadius, padding: 0 }
                })
                if (circles.every(circle => circle.uniqueId != null)) {
                  const targets = []
                  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const depth of (drySpiderDetour ? [0] : [2, 3])) for (const ox of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) for (const oz of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) {
                    const target = { x: Math.floor(origin.x) + dx + ox, y: Math.round(origin.y) - depth, z: Math.floor(origin.z) + dz + oz }
                    const gain = distance(currentPrimary.position, eye(target)) - currentPrimary.distance
                    const length = Math.hypot(target.x - origin.x, target.z - origin.z)
                    if (length <= (drySpiderDetour ? 1.25 : 1.5) && length >= 0.2 && gain >= (drySpiderDetour ? -0.5 : 0.5) && cellSafe(target)) targets.push({ target, gain, depth, length })
                  }
                  targets.sort((a, b) => a.depth - b.depth || (drySpiderDetour ? a.length - b.length || b.gain - a.gain : b.gain - a.gain))
                  for (const candidate of targets.slice(0, 36)) {
                    await new Promise(resolve => setImmediate(resolve)); ensure(); motionOrigin = working()
                    const options = { emergency: true, allowWater: false, ...(drySpiderDetour ? { directFlat: true, exactGoal: true } : { controlledDrop: true }), maxDistance: 2, maxTicks: 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    const preview = generationMovement.preview(candidate.target, options)
                    if (!preview.ready) continue
                    let predictedTrace = preview.predictedTrace
                    if (drySpiderDetour) {
                      if (preview.directFlat !== true || preview.waypoints.length !== 1) continue
                      try {
                        const navigator = createNavigator({ world: planningWorld, version: host.meta.version, physics: generationPlanningPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(safetyState()), { maxTicks: 80, sprint: false })
                        const trace = [origin]; let complete = false
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          if (frame.predictedState.onGround !== true || frame.predictedState.isInWater || frame.predictedState.isInLava || !cellSafe(next) || circles.some(circle => segmentDistance(circle.position, eye(previous), eye(next)) < circle.minDistance - 1e-4)) break
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = true; break }
                          if (frame.phase !== 'moving') break
                        }
                        if (!complete || trace.length < 3 || Math.hypot(trace.at(-1).x - origin.x, trace.at(-1).z - origin.z) < 0.15) continue
                        predictedTrace = trace
                      } catch { continue }
                    } else if (preview.controlledDrop !== true) continue
                    if (!Array.isArray(predictedTrace) || predictedTrace.length < 3) continue
                    dropTrace = predictedTrace; dropCircles = circles; dropTraceIndex = 0; ensure()
                    const stopDrop = () => { if (safetyCurrent()) routeMovement.stop('Controlled descent interrupted') }
                    signal.addEventListener('abort', stopDrop, { once: true })
                    emergencyDropOp = context.operationId
                    try {
                      routeMovement.start(candidate.target, options)
                      while (true) {
                        await delay(50, undefined, { signal }); ensure()
                        const state = safetyState(); const motion = generationMovement.snapshot()
                        if (['failed', 'stopped', 'replan_required'].includes(motion.phase)) return { supported: true, arrived: false, escaped: false, reason: 'no_known_away_route' }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          if (!await verifyRouteStanding(state, candidate.target, { signal })) return { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' }
                          const after = assessEnemies(state)
                          return { supported: true, arrived: true, escaped: after.threats.length === 0 && !after.requiresObservation, partialEscape: after.threats.length > 0 && !after.requiresObservation, serverConfirmed: false }
                        }
                      }
                    } finally {
                      signal.removeEventListener('abort', stopDrop)
                      if (emergencyDropOp === context.operationId) emergencyDropOp = null
                      if (safetyCurrent()) routeMovement.stop('Controlled descent finished')
                      dropTrace = null; dropCircles = null
                    }
                  }
                }
              }
            }
            // Last resort for a healthy player on a dry bank with a single
            // ordinary creeper: cross only bounded, received surface water,
            // keeping the head in air and every observed actor outside its
            // fixed corridor. This is prediction, never a server confirmation.
            const lowHealthSurface = receivedSurfaceOrigin
            const tightShallowPair = alreadyShallow && baseline.threats.length === 2 && baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8)
            const immediateShallowPair = tightShallowPair && baseline.threats.some(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) < 4.5)
            const soloZombie = alreadyShallow && unarmedWaterZombie(initial, baseline.threats)
            const allowBank = soloZombie || alreadyShallow && baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= 5.5 && Math.hypot(value.position.x - origin.x, value.position.z - origin.z) >= 5.5)
            // A separately observed critical start can be just inside the
            // ordinary 3.5-block horizontal guard. A local Bedrock 1.26.60
            // trial with the same pair geometry showed an outward surface
            // move while both actors moved. Keep this exception bounded to a
            // full-health pair above a 3.25-block absolute horizontal floor;
            // every subsequent packet still rechecks both actors and terrain.
            const boundaryShallowPair = immediateShallowPair && baseline.threats.some(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) < 3.5) && baseline.threats.every(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) >= 3.25 && value.position.y <= origin.y + 1.5)
            // If an unprimed pair is already close, require an almost
            // non-approaching horizontal route and keep at least one block
            // beyond the normal 2.5-block fuse trigger throughout the trace.
            const singleShallow = alreadyShallow && baseline.threats.length === 1
            const closeZombiePair = alreadyShallow && baseline.threats.length === 2 && baseline.threats.some(value => value.name === 'minecraft:creeper') && baseline.threats.some(value => value.name === 'minecraft:zombie')
            const drownedWaterEscape = alreadyShallow && (unarmedCreeperDrowned(initial, baseline.threats) || unarmedWaterDrowned(initial, baseline.threats))
            const mixedWaterEscape = soloZombie || drownedWaterEscape || isUnarmedCreeperZombie(initial, baseline.threats, { creeperMinimum: singleShallow || closeZombiePair ? 4 : alreadyShallow ? 5 : 5.5, zombieMinimum: closeZombiePair ? 9 : 9.5, allowSingle: singleShallow, allowCloseZombie: closeZombiePair })
            diagnostics.waterContext = { alreadyShallow, singleShallow, closeZombiePair, mixedWaterEscape, lowHealthSurface, threatCount: baseline.threats.length }
            const waterCreeperEyeFloor = immediateShallowPair ? 3.5 : tightShallowPair ? 4.75 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && alreadyShallow ? 5 : 5.5
            const waterCreeperHorizontalFloor = boundaryShallowPair ? 3.25 : immediateShallowPair ? 3.5 : tightShallowPair ? 4.5 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && alreadyShallow ? 5 : 5.5
            const waterThreatAllowed = value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= waterCreeperEyeFloor || mixedWaterEscape && value.name === 'minecraft:zombie' && value.distance >= (closeZombiePair || soloZombie ? 9 : 9.5) || mixedWaterEscape && value.name === 'minecraft:spider' && value.distance >= 11.25 || drownedWaterEscape && value.name === 'minecraft:drowned' && value.distance >= 10.75
            if ((!lastRejected || lowHealthSurface) && (initial.health === 20 || lowHealthSurface) && baseline.threats.length >= 1 && (lowHealthSurface || baseline.threats.length <= (alreadyShallow ? 2 : 1) || mixedWaterEscape) && baseline.threats.every(value => (lowHealthSurface || waterThreatAllowed(value)) && ids.get(value.runtimeId)?.uniqueId != null) && initial.inventory?.known === true && !initial.inventory.uncertain) {
              const waterObserved = safetyState()
              const current = assessEnemies(waterObserved)
              const actor = current.threats.find(value => value.runtimeId === primary.runtimeId) ?? selectConstrainedPrimary(current.threats, initial.health)
              const actors = [...current.threats, ...current.outside]
              const baselineActorsStillKnown = baseline.threats.every(previous => {
                const observed = actors.find(value => value.runtimeId === previous.runtimeId)
                const entity = waterObserved.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === previous.runtimeId)
                const known = ids.get(previous.runtimeId)
                return observed && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && observed.name === previous.name && observed.dangerRadius <= previous.dangerRadius
              })
              if (actor && (lowHealthSurface || actor.distance >= waterCreeperEyeFloor) && baselineActorsStillKnown && current.threats.every(value => ids.has(value.runtimeId) && (lowHealthSurface || waterThreatAllowed(value))) && (!lowHealthSurface || lowHealthSurfaceEligible(waterObserved, actors, generationPhysics))) {
                const circles = actors.map(value => {
                  const entity = (lowHealthSurface ? waterObserved : initial).entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === value.runtimeId)
                  if (lowHealthSurface) return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: ids.has(value.runtimeId) ? value.distance : value.dangerRadius, horizontalMinimum: null, padding: 0 }
                  // Buoyancy changes eye height even while moving sideways.
                  // Keep a separate, tighter horizontal floor so that a small
                  // vertical bob cannot be mistaken for enemy approach.
                  const mixedZombie = mixedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:zombie'
                  const mixedSpider = mixedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:spider'
                  const mixedDrowned = drownedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:drowned'
                  const initialHorizontal = Math.hypot(value.position.x - origin.x, value.position.z - origin.z)
                  const hardEye = mixedZombie ? 8.75 : mixedSpider ? 10.5 : mixedDrowned ? 10.25 : waterCreeperEyeFloor
                  const hardHorizontal = mixedZombie ? 7.5 : mixedSpider ? 9.5 : mixedDrowned ? Math.max(0, initialHorizontal - 0.75) : waterCreeperHorizontalFloor
                  // Vertical bob changes 3D separation without horizontal
                  // approach. Drowned routes therefore use a fixed 3D floor
                  // plus the independently checked outward horizontal path.
                  const minimum = mixedZombie ? unarmedZombieFloor(value) : mixedSpider ? activeUnarmedSpiderFloor(value) : mixedDrowned ? hardEye : ids.has(value.runtimeId) ? alreadyShallow ? Math.max(hardEye, value.distance - 0.4) : value.distance : constrainedFloors.get(value.runtimeId) ?? value.dangerRadius
                  return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: minimum, horizontalMinimum: ids.has(value.runtimeId) ? Math.max(hardHorizontal, initialHorizontal - (mixedDrowned ? 0.05 : mixedSpider ? 0.75 : immediateShallowPair ? 0.05 : alreadyShallow ? 0.35 : 0)) : null, hardEye, hardHorizontal, padding: 0 }
                })
                const surfaceY = alreadyShallow ? generationPhysics.waterSurface(origin)?.surfaceY : Math.round(origin.y)
                const initialVertical = (initial.predicted?.physicsState ?? initial.physicsState)?.velocity?.y
                const mayBrieflySubmerge = alreadyShallow && initial.health === 20 && Number.isFinite(initialVertical) && initialVertical < 0 && initial.position.y - surfaceY < 0.5
                const shallow = point => shallowWaterTerrain(point, surfaceY, { allowDeepSurface: alreadyShallow, allowBriefSubmerge: mayBrieflySubmerge }) && (!lowHealthSurface || knownSurfaceBody(generationPhysics, point, surfaceY))
                if (circles.every(circle => circle.uniqueId != null && (circle.horizontalMinimum == null || Math.hypot(circle.position.x - origin.x, circle.position.z - origin.z) >= circle.horizontalMinimum)) && shallow(origin)) {
                  const fastWater = alreadyShallow && mixedWaterEscape
                  for (let phase = 0; phase < (fastWater ? 2 : 1); phase++) {
                  const waterTargets = []
                  function considerWaterTarget (target) {
                    const length = Math.hypot(target.x - origin.x, target.z - origin.z)
                    if (length < (lowHealthSurface ? 0.5 : mixedWaterEscape && alreadyShallow ? 0.5 : immediateShallowPair || mixedWaterEscape ? 1.5 : alreadyShallow ? 0.5 : 2) || length > (lowHealthSurface ? 1 : 4.5) || distance(actor.position, eye(target)) < actor.distance + (alreadyShallow ? 0.1 : 0.25) || circles.some(circle => distance(circle.position, eye(target)) < circle.minDistance - 1e-4) || drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - target.x, threat.position.z - target.z) < Math.hypot(threat.position.x - origin.x, threat.position.z - origin.z) + 0.25) || !shallow(target)) return
                    let medium
                    try {
                      const below = generationPhysics.blockAt({ x: target.x, y: surfaceY - 1, z: target.z })
                      medium = ['water', 'flowing_water'].includes(below.name) ? 'water' : allowBank && generationPhysics.hasSupport(target) ? 'land' : null
                      if (!medium) return
                    } catch { return }
                    waterTargets.push({ target, length, medium })
                  }
                  if (lowHealthSurface) {
                    let enumerationMark = surfaceMark()
                    for (let heading = 0; heading < 32; heading++) {
                      if (heading % 8 === 0) { if (heading) surfaceRecord('enumerationSlice', enumerationMark); await yieldPlanning(); enumerationMark = surfaceMark() }
                      const theta = heading * Math.PI / 16
                      for (const length of [1, 0.75]) considerWaterTarget({ x: origin.x + Math.cos(theta) * length, y: surfaceY, z: origin.z + Math.sin(theta) * length })
                    }
                    surfaceRecord('enumerationSlice', enumerationMark)
                  } else if (fastWater && phase === 0) {
                    const direction = { x: 0, z: 0 }
                    for (const threat of current.threats) {
                      const dx = origin.x - threat.position.x; const dz = origin.z - threat.position.z; const h = Math.hypot(dx, dz)
                      if (!(h > 0)) continue
                      const weight = threat.runtimeId === actor.runtimeId ? 1 : 0.4
                      direction.x += weight * dx / h; direction.z += weight * dz / h
                    }
                    const angle = Math.atan2(direction.z, direction.x)
                    for (const offset of [0, -Math.PI / 8, Math.PI / 8, -Math.PI / 4, Math.PI / 4]) for (const length of [0.75, 1, 1.5, 1.75, 2.5, 3.25]) {
                      considerWaterTarget({ x: Math.round((origin.x + Math.cos(angle + offset) * length) * 4) / 4, y: surfaceY, z: Math.round((origin.z + Math.sin(angle + offset) * length) * 4) / 4 })
                    }
                    // A remembered shore is a direction only. Add headings
                    // toward it, then run the same known-terrain and actor
                    // checks used for every other candidate.
                    if (shoreScore(initial, origin, origin)) for (let heading = 0; heading < 16; heading++) for (const length of [0.75, 1.5, 2.5, 3.25]) {
                      const theta = heading * Math.PI / 8
                      considerWaterTarget({ x: Math.round((origin.x + Math.cos(theta) * length) * 4) / 4, y: surfaceY, z: Math.round((origin.z + Math.sin(theta) * length) * 4) / 4 })
                    }
                  } else {
                    let checkedWaterTargets = 0
                    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const ox of (alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) for (const oz of (alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) {
                      if (++checkedWaterTargets % 64 === 0) { await new Promise(resolve => setImmediate(resolve)); ensure() }
                      considerWaterTarget({ x: Math.floor(origin.x) + dx + ox, y: surfaceY, z: Math.floor(origin.z) + dz + oz })
                    }
                  }
                  const rankingMark = surfaceMark()
                  // An observed dry bank can end the slow water pursuit.
                  // It is still subjected to the same full trajectory, body,
                  // known terrain and hostile-distance checks as water.
                  if ((singleShallow || closeZombiePair) && mixedWaterEscape) {
                    // A nearby pursuer can make a bank-seeking sideways step
                    // unsafe before it pays off. Prefer headings that point
                    // away from the observed creeper; retain bank preference
                    // only for routes with the same outward alignment.
                    const dx = origin.x - actor.position.x; const dz = origin.z - actor.position.z
                    const alignment = candidate => ((candidate.target.x - origin.x) * dx + (candidate.target.z - origin.z) * dz) / candidate.length
                    waterTargets.sort((a, b) => alignment(b) - alignment(a) || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  } else waterTargets.sort((a, b) => Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  if (shoreScore(initial, origin, origin)) {
                    for (const candidate of waterTargets) candidate.shoreProgress = shoreScore(initial, origin, candidate.target)?.progress ?? -Infinity
                    waterTargets.sort((a, b) => b.shoreProgress - a.shoreProgress || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  }
                  if (lowHealthSurface) waterTargets.sort((a, b) => Math.min(...current.threats.map(value => distance(value.position, eye(b.target)) - value.distance)) - Math.min(...current.threats.map(value => distance(value.position, eye(a.target)) - value.distance)))
                  if (lowHealthSurface) surfaceRecord('ranking', rankingMark)
                  diagnostics.waterTargetCount = (diagnostics.waterTargetCount ?? 0) + waterTargets.length
                  for (const candidate of waterTargets.slice(0, alreadyShallow ? 24 : 12)) {
                    if (lowHealthSurface) await yieldPlanning()
                    else { await new Promise(resolve => setImmediate(resolve)); ensure() }
                    motionOrigin = working()
                    const options = { emergency: true, allowWater: true, directSurface: candidate.medium === 'water', exactGoal: true, maxDistance: lowHealthSurface ? 2 : 6, maxExpanded: lowHealthSurface ? 32 : 1500, maxTicks: lowHealthSurface ? 40 : 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    if (candidate.medium === 'water') {
                      options.continueAfterReplay = true
                      options.beforeInput = frame => {
                        const observed = ensure()
                        inspect({ ...observed, position: { ...frame.packetPosition }, predicted: { ...observed.predicted, position: { ...frame.packetPosition }, physicsState: structuredClone(frame.predictedState) }, physicsState: structuredClone(frame.predictedState) })
                        if (signal.aborted) throw signal.reason ?? new Error('Shallow escape frame is no longer safe')
                      }
                    }
                    if (lowHealthSurface) lowHealthSurfaceDiagnostic.previews++
                    const preview = lowHealthSurface ? surfaceTimed('preview', () => generationMovement.preview(candidate.target, options)) : generationMovement.preview(candidate.target, options)
                    if (!preview.ready || !preview.waypoints?.length || preview.waypoints.at(-1).medium !== candidate.medium) { if (lowHealthSurface) lowHealthSurfaceDiagnostic.reason = preview.reason ?? 'surface_preview_rejected'; continue }
                    let trace; let complete = false
                    try {
                      if (lowHealthSurface) {
                        // Preserve neutral input while yielding, then use the already
                        // freshly checked pose instead of repeating a full actor read.
                        const proofState = await yieldPlanning()
                        const navigator = createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: generationPhysics })
                        const proof = surfaceTimed('nativeProof', () => proveLowHealthSurfaceRoute({ navigator, initial: navigator.physics.fromServer(proofState), preview, circles, surfaceY, shallow }))
                        if (!proof.ready) { lowHealthSurfaceDiagnostic.reason = proof.reason; continue }
                        lowHealthSurfaceDiagnostic.ready++; lowHealthSurfaceDiagnostic.reason = 'native_surface_proven'; lowHealthSurfaceDiagnostic.ticks = proof.ticks
                        trace = proof.trace; complete = true
                      } else if (preview.directSurface === true && candidate.medium === 'water' && Array.isArray(preview.predictedTrace) && preview.predictedTrace.length >= 3 && preview.predictedTrace.length <= 81 && distance(preview.predictedTrace[0], origin) <= 0.05) {
                        trace = preview.predictedTrace.map(point => ({ ...point }))
                        complete = trace.every((next, index) => shallow(next) && (!index || circles.every(circle => !(circle.horizontalMinimum != null && segmentDistance({ ...circle.position, y: 0 }, { ...trace[index - 1], y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum) && segmentDistance(circle.position, eye(trace[index - 1]), eye(next)) >= circle.minDistance - 1e-4)))
                      } else {
                        // The shared water physics already reads the same live
                        // block geometry; the planning overlay only adds
                        // protection metadata, which physics does not use.
                        // Rebuilding the registry for every candidate can let
                        // a nearby pursuer close before movement starts.
                        const navigator = createNavigator({ world: planningWorld, version: host.meta.version, allowWater: true, physics: generationPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(safetyState()), { maxTicks: 80, sprint: false })
                        trace = [origin]; let submergedTicks = 0
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          submergedTicks = eye(next).y < surfaceY + 0.02 ? submergedTicks + 1 : 0
                          const blocked = circles.find(circle => circle.horizontalMinimum != null && segmentDistance({ ...circle.position, y: 0 }, { ...previous, y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum || segmentDistance(circle.position, eye(previous), eye(next)) < circle.minDistance - 1e-4)
                          if (frame.predictedState.isInLava || submergedTicks > 10 || !shallow(next) || blocked) {
                            diagnostics.waterTraceRejection = { reason: frame.predictedState.isInLava ? 'lava' : blocked ? 'actor' : 'terrain', actorId: blocked?.id ?? null, tick, floor: blocked?.minDistance ?? null, initialDistance: blocked ? distance(blocked.position, eye(origin)) : null, position: { ...next }, surfaceY }
                            break
                          }
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = candidate.medium === 'water' ? frame.predictedState.isInWater === true : frame.predictedState.onGround === true && frame.predictedState.isInWater !== true && generationPhysics.hasSupport(next); break }
                          if (frame.phase !== 'moving') break
                        }
                      }
                    } catch { continue }
                    if (!complete || trace.length < 3 || distance(actor.position, eye(trace.at(-1))) < actor.distance + (alreadyShallow ? 0.1 : 0.25) || drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - trace.at(-1).x, threat.position.z - trace.at(-1).z) < Math.hypot(threat.position.x - origin.x, threat.position.z - origin.z) + 0.25) || alreadyShallow && Math.hypot(actor.position.x - trace.at(-1).x, actor.position.z - trace.at(-1).z) < Math.hypot(actor.position.x - origin.x, actor.position.z - origin.z) + 0.2) continue
                    lowHealthSurfaceRun = lowHealthSurface; lowHealthSurfaceOrigin = { ...origin }; dropTrace = trace; dropCircles = circles; dropTraceIndex = 0; shallowWaterCheck = shallow; shallowSurfaceY = surfaceY; shallowWaterRun = true; briefSubmerge = mayBrieflySubmerge; submergedSince = null; surfaceTimed('finalEnsure', ensure)
                    const stopWater = () => { if (safetyCurrent()) routeMovement.stop('Shallow escape interrupted') }
                    signal.addEventListener('abort', stopWater, { once: true }); emergencyDropOp = context.operationId
                    try {
                      if (lowHealthSurface) { if (episodeMovementStarts >= 5) return { supported: false, reason: 'no_known_away_route', movementStarts: episodeMovementStarts }; episodeMovementStarts++; fence.starts = episodeMovementStarts; lowHealthSurfaceDiagnostic.attempts++; lowHealthSurfaceDiagnostic.reason = 'surface_start'; lowHealthSurfaceDiagnostic.target = { ...candidate.target } }
                      surfaceTimed('senderStart', () => routeMovement.start(candidate.target, options))
                      while (true) {
                        await delay(50, undefined, { signal }); ensure()
                        const state = safetyState(); const motion = generationMovement.snapshot()
                        if (motion.phase === 'replan_required') return { supported: true, arrived: false, escaped: false, code: 'SHALLOW_CORRECTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false }
                        if (motion.phase === 'stopped' && motion.reason === 'サーバーから速度の変更を受信したため再計画します。') return { supported: true, arrived: false, escaped: false, code: 'SHALLOW_MOTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false }
                        if (['failed', 'stopped'].includes(motion.phase)) return { supported: true, arrived: false, escaped: false, code: motion.phase === 'failed' ? 'SHALLOW_MOVEMENT_FAILED' : 'SHALLOW_MOVEMENT_STOPPED', reason: 'no_known_away_route', partialFailure: typeof motion.reason === 'string' ? motion.reason.slice(0, 200) : null }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          const after = assessEnemies(state)
                          const safeSurface = candidate.medium === 'water' ? shallowWaterTerrain(feet(state), surfaceY, { allowDeepSurface: true }) && (lowHealthSurface ? knownSurfaceBody(generationPhysics, feet(state), surfaceY) : (state.predicted?.physicsState ?? state.physicsState)?.isInWater === true) : await verifyRouteStanding(state, candidate.target, { signal })
                          return { supported: true, ...(lowHealthSurface ? { lowHealthSurface: true, movementStarts: episodeMovementStarts } : {}), arrived: safeSurface, escaped: safeSurface && after.threats.length === 0 && !after.requiresObservation, partialEscape: safeSurface && !after.requiresObservation && after.threats.length > 0 && after.threats.every(value => ids.has(value.runtimeId)), serverConfirmed: false }
                        }
                      }
                    } finally {
                      signal.removeEventListener('abort', stopWater)
                      if (emergencyDropOp === context.operationId) emergencyDropOp = null
                      if (safetyCurrent()) routeMovement.stop('Shallow escape finished')
                      dropTrace = null; dropCircles = null; shallowWaterRun = false; shallowWaterCheck = null; shallowSurfaceY = null; briefSubmerge = false; submergedSince = null; lowHealthSurfaceRun = false; lowHealthSurfaceOrigin = null
                    }
                  }
                  }
                }
              }
            }
            if (lastRejected) return { ...lastRejected, supported: true, escaped: false, partialEscape: false, safe: false, diagnostics }
            if (lastBoundedPartial) return { ...lastBoundedPartial, movementStarts: episodeMovementStarts, diagnostics }
            if (boundedJumpAttempted) return { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'NO_SAFE_RETREAT', reason: 'no_known_away_route', movementStarts: episodeMovementStarts, safe: false, diagnostics }
            return { supported: false, reason: 'no_known_away_route', diagnostics }
            }
          } catch (error) {
            if (pendingReplan && controller.signal.reason === pendingReplan.error && !context.signal?.aborted) {
              const fresh = safetyState()
              const roster = state => JSON.stringify((state.entities ?? []).map(entity => [entityId(entity), String(entity.uniqueId), entity.entityType ?? entity.name]).sort((a, b) => a[0].localeCompare(b[0])))
              if (restartState(fresh) && roster(fresh) === roster(pendingReplan.state)) {
                clearTimeout(timer); clearInterval(watch)
                if (inspectIdleEscape === inspect) inspectIdleEscape = null
                if (inspectIdleEscapePacket === inspectPacket) inspectIdleEscapePacket = null
                fence.replans++
                for (const entity of fresh.entities ?? []) fence.identities.set(entityId(entity), { uniqueId: String(entity.uniqueId), name: entity.entityType ?? entity.name })
                const next = { ...context, state: structuredClone(fresh), threats: evaluateThreats(fresh, fresh.entities, { observationRadius: 32 }).threats }
                preMovementFences.set(next, fence)
                return await escape(next)
              }
            }
            if (['searching', 'priority_search', 'guard_attempt'].includes(jumpSearchDiagnostic.reason)) jumpSearchDiagnostic.reason = Date.now() >= deadline || /deadline|timed out/i.test(error.message) ? 'deadline' : 'interrupted'
            if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
            throw error
          } finally {
            clearTimeout(timer); clearInterval(watch)
            if (inspectIdleEscape === inspect) inspectIdleEscape = null
            if (inspectIdleEscapePacket === inspectPacket) inspectIdleEscapePacket = null
            if (signal.aborted) await generationGuardRoute.stop('Idle escape interrupted')
          }
        }))
      },
      cancelOwned: async context => {
        if (!safetyCurrent()) return
        const owns = kind => owners[kind]?.operationId === context.operationId
        const cleanup = []
        if (owns('inventory')) cancelBackgroundInventory(context.reason)
        if (owns('combat')) { generationCombat.cancel(context.reason); cleanup.push(generationCombat.drain()) }
        if (owns('hut')) cleanup.push(generationHut.stop(context.reason))
        if (owns('escape')) { if (emergencyMiningOp === context.operationId) ownedMining.stop(context.reason); if (emergencyDropOp === context.operationId) routeMovement.stop(context.reason); if (emergencyWaterCounterOp === context.operationId) { generationCombat.cancel(context.reason); cleanup.push(generationCombat.drain()) }; cleanup.push(generationGuardRoute.stop(context.reason)) }
        await Promise.allSettled(cleanup)
      },
      onProgress: data => {
        if (!safetyCurrent()) return
        host.noteProgress({ type: 'idle_safety', ...data })
        // Display only: once protection is back to plain observation (no
        // threat, pursuer, unknown or owned action), an earlier online
        // emergency record is marked resolved. Nothing is unlocked by this:
        // gates only look at scheduled/in_flight, which are left untouched.
        if (data?.phase !== 'observing' || data.busy || data.active || data.workClearancePending || data.cleanupUnconfirmed) return
        const at = new Date().toISOString(); let resolved = false
        const receipt = host.shared.safetyEmergency
        if (receipt?.status === 'remaining_online' && receipt.scope === safetyOriginScope) { receipt.status = 'resolved'; receipt.resolvedAt = at; resolved = true }
        const online = host.shared.onlineEmergency
        if (online?.status === 'remaining_online' && online.reasonCode === 'LOCAL_DANGER' && !online.resumeError && online.connectionId === raw().connectionId) { online.status = 'resolved'; online.resolvedAt = at; resolved = true }
        if (resolved) host.log('待機保護: 危険が解消したため非常停止の記録を解決済みにしました（表示のみ）')
      },
      onEmergencyStop: details => {
        if (!safetyCurrent() || !host.shared.safetyWanted || String(details.enableEpoch) !== String(host.shared.safetyEnableEpoch)) return
        const previous = host.shared.safetyEmergency
        const captureDue = !previous || previous.scope !== safetyOriginScope || Date.now() - Date.parse(previous.capturedAt ?? previous.at) >= 5000
        const receipt = { enableEpoch: host.shared.safetyEnableEpoch, scope: safetyOriginScope, status: 'remaining_online', reason: details.reason, health: details.health, at: new Date().toISOString(), capturedAt: captureDue ? new Date().toISOString() : previous.capturedAt ?? previous.at, retries: (previous?.retries ?? 0) + 1, retryAt: details.retryAt ?? null }
        const dispatchEpoch = safetyDispatchEpoch
        host.shared.safetyEmergency = receipt
        // Reporting is local. A failed defense keeps the connection, wanted
        // state and supervisor alive; confirmed death uses normal recovery.
        setImmediate(() => {
          if (!safetyCurrent() || !host.shared.safetyWanted || dispatchEpoch !== safetyDispatchEpoch || host.shared.safetyEmergency !== receipt || receipt.enableEpoch !== host.shared.safetyEnableEpoch) { receipt.status = 'cancelled'; return }
          try { Promise.resolve(host.onEmergency?.({ ...details, continuedOnline: true })).catch(error => host.log(`待機保護の記録: ${error.message}`)) } catch (error) { host.log(`待機保護の記録: ${error.message}`) }
          if (!captureDue) return
          try {
            const reasonCode = new Map([
              ['Idle danger cannot be safely defended', 'DEFENSE_UNAVAILABLE'],
              ['Actual sword equip is unconfirmed', 'SWORD_UNCONFIRMED'],
              ['Known body or closed GUI is unconfirmed', 'BODY_OR_GUI_UNCONFIRMED'],
              ['Exact idle defense oracle refused', 'DEFENSE_PREVIEW_REFUSED'],
              ['Fresh idle defense state changed after preview', 'DEFENSE_STATE_CHANGED'],
              ['Idle danger remains after bounded defense', 'DANGER_REMAINS'],
              ['プレイヤー位置・次元が変わりました。', 'POSITION_OR_DIMENSION_CHANGED']
            ]).get(details.reason) ?? 'IDLE_PROTECTION_UNRESOLVED'
            const observed = raw()
            const phase = ['starting', 'connecting', 'joining', 'spawned', 'dead', 'disconnected'].includes(observed.phase) ? observed.phase : 'unknown'
            host.log(`待機保護の非常停止: reasonCode=${reasonCode} health=${Number.isFinite(observed.health) ? observed.health : 'unknown'} phase=${phase} sameScope=true`)
            if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
              try {
                const current = safetyState(); const p = current.position
                if (p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) && typeof host.world.getArea === 'function') {
                  const center = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62), z: Math.floor(p.z) }
                  const protection = generationSafety.snapshot()
                  const lowerTerrain = []
                  // Bound diagnostic capture to nearby received terrain; it is
                  // evidence only and never authorizes a movement by itself.
                  for (let x = center.x - 6; x <= center.x + 6; x++) for (let z = center.z - 6; z <= center.z + 6; z++) for (let y = center.y - 12; y <= center.y + 4; y++) lowerTerrain.push(host.world.getBlock(x, y, z))
                  const motion = generationMovement.snapshot()
                  const guardStatus = generationGuardRoute.snapshot()
                  const capturePoint = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) ? { x: point.x, y: point.y, z: point.z } : null
                  const captureText = value => typeof value === 'string' ? value.slice(0, 300) : null
                  const inputStatus = generationStream.stats()
                  const capture = { observedAt: new Date().toISOString(), health: current.health, position: p, rawServerPosition: current.rawServerPosition, predicted: current.predicted, realmId: current.realm?.id, dimension: current.dimension, performance: host.shared.perfObservations ?? null, movement: { phase: motion.phase, target: motion.target, sent: motion.sent, reason: motion.reason, lastTimerGapMs: motion.lastTimerGapMs, maxFrameTimings: motion.maxFrameTimings ?? null, inputReplay: motion.inputReplay ?? null, directSurface: motion.route?.directSurface === true, start: generationMovement.diagnostics?.() ?? null, route: motion.route ? { origin: motion.route.origin ?? null, flags: { directSurface: motion.route.directSurface === true, directFlat: motion.route.directFlat === true, partialDrop: motion.route.partialDrop === true, controlledDrop: motion.route.controlledDrop === true, partialRecenter: motion.route.partialRecenter === true, shoreRecenter: motion.route.shoreRecenter === true }, waypointCount: motion.route.waypoints?.length ?? 0, waypoints: (motion.route.waypoints ?? []).slice(0, 4), avoidanceCount: motion.route.avoidance?.length ?? 0, avoidance: (motion.route.avoidance ?? []).slice(0, 16), reason: motion.route.reason ?? null, unknownFrontier: (motion.route.unknownFrontier ?? []).slice(0, 4) } : null }, safety: { lastError: typeof protection.lastError === 'string' ? protection.lastError.slice(0, 300) : null, lastEscapeDiagnostic: protection.lastEscapeDiagnostic ?? null, lastResult: protection.lastResult, lastWaterSearch: protection.lastWaterSearch ?? null, lastWaterReplan: protection.lastWaterReplan ?? null, lastWaterCounter: protection.lastWaterCounter ?? null }, enemies: (current.entities ?? []).filter(actor => actor.hostile && actor.positionKnown && actor.position).map(actor => ({ runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, entityType: actor.entityType, position: actor.position, primed: actor.primed ?? null, ignited: actor.ignited ?? null, fuseLength: actor.fuseLength ?? null, charged: actor.charged ?? null, lastEvent: actor.lastEvent ?? null, terrainOcclusion: actor.terrainOcclusion ? { suppressed: actor.terrainOcclusion.suppressed, reason: actor.terrainOcclusion.reason, rays: actor.terrainOcclusion.rays.map(ray => ({ known: ray.known, blocked: ray.blocked, reason: ray.reason, barrierLength: ray.barrierLength, barrierCells: ray.barrierCells })) } : null })), blocks: host.world.getArea(center, 3), lowerTerrain }
                  capture.clearance = structuredClone(host.shared.clearanceDiagnostic ?? null)
                  capture.guardRoute = { phase: captureText(guardStatus.phase), code: captureText(guardStatus.code), reason: captureText(guardStatus.reason), routeInterruption: guardStatus.routeInterruption ? { code: captureText(guardStatus.routeInterruption.code), reason: captureText(guardStatus.routeInterruption.reason) } : null, interruptions: Number.isSafeInteger(guardStatus.interruptions) ? guardStatus.interruptions : null, movementStarts: Number.isSafeInteger(guardStatus.movementStarts) ? guardStatus.movementStarts : null, origin: capturePoint(guardStatus.visitedPrefix?.[0]), originCoordinates: 'feet', visitedPrefix: (guardStatus.visitedPrefix ?? []).slice(0, 8).map(capturePoint).filter(Boolean) }
                  const captureRejection = value => value ? { reason: captureText(value.reason), detail: captureText(value.detail), mode: captureText(value.mode), actorId: captureText(value.actorId), actorName: captureText(value.actorName), minDistance: Number.isFinite(value.minDistance) ? value.minDistance : null, required: Number.isFinite(value.required) ? value.required : null, requestedTarget: capturePoint(value.requestedTarget), segment: value.segment ? { index: Number.isSafeInteger(value.segment.index) ? value.segment.index : null, from: capturePoint(value.segment.from), to: capturePoint(value.segment.to) } : null, preview: value.preview ? { ready: value.preview.ready === true, reason: captureText(value.preview.reason), origin: capturePoint(value.preview.origin), target: capturePoint(value.preview.target), waypointCount: Number.isSafeInteger(value.preview.waypointCount) ? value.preview.waypointCount : null, waypoints: (value.preview.waypoints ?? []).slice(0, 4).map(waypoint => ({ position: capturePoint(waypoint.position), action: captureText(waypoint.action), medium: captureText(waypoint.medium) })) } : null, latestPose: value.latestPose ? { position: capturePoint(value.latestPose.position), rawServerPosition: capturePoint(value.latestPose.rawServerPosition), positionSource: captureText(value.latestPose.positionSource) } : null } : null
                  capture.safety.lastContinuation = protection.lastContinuation ?? null
                  capture.safety.workClearancePending = protection.workClearancePending === true
                  capture.safety.workClearance = protection.workClearance ?? null
                  capture.queuedPrediction = inputHistory?.snapshot() ?? null
                  capture.boundedJumpSearch = structuredClone(boundedJumpSearch)
                  capture.lastInputFailure = structuredClone(host.shared.lastInputFailure ?? null)
                  capture.input = { owner: inputOwner, running: inputStatus.running === true, tick: captureText(inputStatus.tick), sent: Number.isSafeInteger(inputStatus.sent) ? inputStatus.sent : null, lastError: captureText(inputStatus.lastError), idleError: captureText(host.shared.idleError) }
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { kind: captureText(guardStatus.progressReplan.kind), originMode: captureText(guardStatus.progressReplan.originMode), anchorTick: captureText(guardStatus.progressReplan.anchorTick), currentTick: captureText(guardStatus.progressReplan.currentTick) } : null
                  capture.connectionId = captureText(current.connectionId)
                  capture.profile = captureText(current.profile)
                  capture.phase = captureText(current.phase)
                  capture.gameMode = current.gameMode
                  capture.version = captureText(host.meta.version)
                  capture.threatPolicy = captureText(current.threatPolicy)
                  const capturedEvaluation = evaluateThreats(current, current.entities ?? [], { observationRadius: 32 })
                  const capturedActor = actor => ({ runtimeId: captureText(actor.runtimeId), name: captureText(actor.name), distance: actor.distance, dangerRadius: actor.dangerRadius, category: captureText(actor.category) })
                  capture.threatEvaluation = { observedAt: capture.observedAt, requiresObservation: capturedEvaluation.requiresObservation, unknownPositions: capturedEvaluation.unknownPositions.length, hostUnknownPositions: current.entityStats?.unknownPositions ?? null, threatCount: capturedEvaluation.threats.length, threats: capturedEvaluation.threats.slice(0, 32).map(capturedActor), outsideDanger: capturedEvaluation.outsideDanger.slice(0, 32).map(capturedActor), suppressedByTerrain: capturedEvaluation.suppressedByTerrain.slice(0, 32).map(capturedActor) }
                  capture.inventory = { known: current.inventory?.known === true, uncertain: current.inventory?.uncertain === true, items: (current.inventory?.items ?? []).slice(0, 36).map(item => ({ slot: item.slot, name: captureText(item.name), count: item.count })) }
                  capture.rawSelectedSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot ?? current.selectedSlot
                  capture.heldItem = current.heldItem ? { slot: current.heldItem.slot, name: captureText(current.heldItem.name), count: current.heldItem.count } : null
                  capture.equipmentServerConfirmed = current.equipmentServerConfirmed
                  capture.vitals = structuredClone(current.vitals ?? {})
                  capture.removedEntities = (current.removedEntities ?? []).slice(-16).map(actor => ({ runtimeId: captureText(actor.runtimeId), uniqueId: captureText(actor.uniqueId), entityType: captureText(actor.entityType), position: capturePoint(actor.position), removedAt: typeof actor.removedAt === 'string' ? captureText(actor.removedAt) : Number.isFinite(actor.removedAt) ? actor.removedAt : null }))
                  capture.guardRoute.routeRejection = captureRejection(guardStatus.routeRejection)
                  capture.guardRoute.remainingRouteRejection = captureRejection(guardStatus.remainingRouteRejection)
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { from: capturePoint(guardStatus.progressReplan.from), target: capturePoint(guardStatus.progressReplan.target), position: capturePoint(guardStatus.progressReplan.position), authoritativePosition: capturePoint(guardStatus.progressReplan.authoritativePosition), horizontalProgress: Number.isFinite(guardStatus.progressReplan.horizontalProgress) ? guardStatus.progressReplan.horizontalProgress : null, targetOvershoot: Number.isFinite(guardStatus.progressReplan.targetOvershoot) ? guardStatus.progressReplan.targetOvershoot : null, authoritativeStamp: typeof guardStatus.progressReplan.authoritativeStamp === 'number' ? guardStatus.progressReplan.authoritativeStamp : captureText(guardStatus.progressReplan.authoritativeStamp) } : null
                  process.stdout.write('EMERGENCY_CAPTURE ' + JSON.stringify(capture) + '\n')
                }
              } catch { /* Diagnostics must never block the emergency stop. */ }
            }
            const protection = generationSafety.snapshot()
            const escape = protection.lastResult?.action === 'escape' ? protection.lastResult : null
            const defense = protection.lastDefense
            if (protection.lastClear?.cleared) host.log('待機保護の障害物: 自然の葉1個の除去を確認')
            if (defense) host.log(`待機保護の自衛: action=${defense.action} phase=${defense.phase} code=${defense.code ?? 'none'} reason=${defense.reasonCode ?? 'none'} hits=${Number.isSafeInteger(defense.hitsRequested) ? defense.hitsRequested : 'unknown'} confirmed=${defense.serverConfirmed === true}`)
            const errorText = String(protection.lastError ?? '')
            const errorCode = /damage/i.test(errorText) ? 'DAMAGE' : /deadline|timed out|timeout/i.test(errorText) ? 'TIMEOUT' : /danger|threat|enemy/i.test(errorText) ? 'THREAT_CHANGED' : /support|terrain|ground|landing/i.test(errorText) ? 'TERRAIN' : /scope|session|generation/i.test(errorText) ? 'SCOPE' : /cancel|abort|stopped/i.test(errorText) ? 'CANCELLED' : errorText ? 'OTHER' : 'none'
            host.log(`待機保護の退避: attempts=${Number.isSafeInteger(protection.escapes) ? protection.escapes : 0} supported=${escape?.supported === true} partial=${escape?.partialEscape === true} code=${escape?.code ?? escape?.reason ?? 'none'} cause=${escape?.cause ?? 'none'} error=${errorCode}`)
            const errorDetail = new Map([['Idle escape danger changed', 'IDENTITY_OR_NEW_THREAT'], ['Idle escape remaining path danger changed', 'OUTSIDE_THREAT_CROSSED_PATH'], ['New or unknown danger interrupted protection', 'NEW_OR_UNKNOWN_THREAT'], ['Idle escape four-second deadline exceeded', 'DEADLINE'], ['Idle escape stopped on observed damage', 'DAMAGE']]).get(errorText)
            if (errorDetail) host.log(`待機保護の中断詳細: ${errorDetail}`)
            if (escape?.diagnostics) host.log(`待機保護の探索: visited=${escape.diagnostics.visited} candidates=${escape.diagnostics.candidates} partials=${escape.diagnostics.partials} previews=${escape.diagnostics.previews} ready=${escape.diagnostics.readyPreviews} floor=${escape.diagnostics.floorBlocked} body=${escape.diagnostics.bodyBlocked} unknown=${escape.diagnostics.terrainUnknown} away=${escape.diagnostics.awayBlocked} gain=${escape.diagnostics.gainBlocked}`)
            try {
              const current = working(); const physical = current.predicted?.physicsState ?? current.physicsState
              const grounded = typeof physical?.onGround === 'boolean' ? String(physical.onGround) : 'unknown'
              const sword = current.inventory?.known === true && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(current.heldItem?.name ?? '')
              const bodyClear = verifyStrikeBody(current)
              host.log(`待機保護の体勢: grounded=${grounded} bodyClear=${bodyClear} meleeSupport=${verifyMeleeBody(current)} swordHeld=${sword} inventoryKnown=${current.inventory?.known === true} defenses=${Number.isSafeInteger(protection.defenses) ? protection.defenses : 0}`)
              if (!bodyClear) host.log(`待機保護の体勢詳細: ${JSON.stringify(strikeBodyDiagnostic(current))}`)
            } catch { /* Diagnostics cannot interrupt online protection. */ }
            if (escape?.rejection) host.log(`待機保護の経路: reason=${escape.rejection.reason} detail=${escape.rejection.detail ?? 'none'} preview=${escape.rejection.previewCode ?? 'none'} actor=${escape.rejection.actorName ?? 'unknown'} distance=${Number.isFinite(escape.rejection.minDistance) ? escape.rejection.minDistance.toFixed(2) : 'unknown'} required=${Number.isFinite(escape.rejection.required) ? escape.rejection.required.toFixed(2) : 'unknown'}`)
            // Keep a bounded, non-packet summary for diagnosing a protection
            // failure while the bot remains online. Never log
            // player names, positions, inventory, chat or authentication.
            try {
              const state = { ...observed, threatPolicy: host.shared.autoWanted ? 'online_learning' : 'balanced_mining' }
              const danger = evaluateThreats(state, host.entities.snapshot({ kind: 'all' }), { observationRadius: 32 })
              const nearest = danger.threats[0]
              if (nearest && /^minecraft:[a-z_]{1,40}$/.test(nearest.name) && Number.isFinite(nearest.distance)) host.log(`待機保護の近傍敵: type=${nearest.name} distance=${nearest.distance.toFixed(1)} cover=unverified unknown=${danger.requiresObservation} count=${danger.threats.length}`)
              if (danger.threats.length === 1 && nearest) {
                const preview = generationCombat.previewEngage(nearest.runtimeId)
                const reason = String(preview.errors?.[0] ?? '')
                const code = preview.ready ? 'READY' : /視線/.test(reason) ? 'SIGHT' : /近接範囲/.test(reason) ? 'RANGE' : /剣|持ち物|スロット|主手/.test(reason) ? 'EQUIPMENT' : /体力/.test(reason) ? 'HEALTH' : /操作/.test(reason) ? 'BUSY' : 'OTHER'
                host.log(`待機保護の交戦確認: ${code}`)
              }
              const summary = danger.threats.slice(0, 8).filter(actor => /^minecraft:[a-z_]{1,40}$/.test(actor.name) && Number.isFinite(actor.distance) && actor.position).map(actor => {
                const dx = actor.position.x - state.position.x; const dz = actor.position.z - state.position.z
                const direction = Math.abs(dx) > Math.abs(dz) * 2 ? (dx > 0 ? 'E' : 'W') : Math.abs(dz) > Math.abs(dx) * 2 ? (dz > 0 ? 'S' : 'N') : `${dz > 0 ? 'S' : 'N'}${dx > 0 ? 'E' : 'W'}`
                return `${actor.name}:${actor.distance.toFixed(1)}:${direction}`
              }).join(',')
              if (summary) host.log(`待機保護の敵一覧（遮蔽未評価）: ${summary}`)
            } catch { /* Logging must not prevent a fresh bounded response. */ }
          } catch (error) { host.log(`待機保護の記録に失敗しました: ${error.message}`) }
        })
      }
    })
    idleSafety = generationSafety
    function requireUserLease (context) {
      requireGeneration()
      if (!userBehaviorLease || userBehaviorLease.generation !== generationStream || context?.kind !== userBehaviorLease.kind || context.claimId !== userBehaviorLease.claimId || context.token !== userBehaviorLease.token) throw new Error('利用者指定動作の操作権が一致しません。')
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('User behavior cancelled')
      const state = lightweightUserState(), scope = context.scope
      if (scope && ['profile', 'connectionId', 'startedAt', 'dimension'].some(k => scope[k] != null && String(scope[k]) !== String(state[k])) || scope?.realmId != null && String(scope.realmId) !== String(state.realm?.id) || scope?.runtimeEntityId != null && String(scope.runtimeEntityId) !== String(state.runtimeEntityId) || scope?.deathId != null && scope.deathId !== actualLifeId()) throw new Error('User behavior scope changed')
      if (state.dead || !(state.health > 0)) throw new Error('User behavior requires a living player')
      return state
    }
    const sameLease = context => userBehaviorLease?.generation === generationStream && context?.kind === userBehaviorLease.kind && context?.claimId === userBehaviorLease.claimId && context?.token === userBehaviorLease.token
    let userMeleeSurvey = null
    const userApproachSurveys = new Map()
    async function combatCanPreemptSafety (state, actor, surfaceBinding, context) {
      const protection = generationSafety.snapshot()
      if (protection.running !== true) return true
      try {
        const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
        const weapon = require('./melee-weapons').selectMeleeWeapon({ items: craftInventory().inventory ?? [], rawItem: crafting.rawItem, selectedSlot: selected, target: actor })
        const motion = generationMovement.snapshot(), age = Date.now() - motion.queuedAt
        // A real in-flight escape must not be exchanged for an unarmed trade.
        // Without a moving escape, normal positive-health near defense remains.
        if ((!weapon.ready || weapon.fists === true) && owners.escape && protection.busy && protection.active === 'escape' && motion.running && motion.phase === 'moving' && motion.queuedReceiptConfirmed === true && motion.sent > 0 && Number.isFinite(age) && age >= 0 && age <= 200) return false
        userMeleeSurvey ??= require('./melee-combat').createMeleeCombat({ client: { queue: () => { throw Error('Passive melee survey cannot send packets') } }, getState: lightweightUserState, getRawState: lightweightRawState, world: host.world, entities: host.entities, crafting, equip: () => { throw Error('Passive melee survey cannot equip') }, getInput: () => { throw Error('Passive melee survey cannot own input') }, isBusy: () => false, version: host.meta.version })
        const attack = userMeleeSurvey.preview(actor.runtimeId)
        host.shared.lastPreemptSurvey = { code: attack.code ?? (attack.ready ? 'ready' : 'unknown'), error: (attack.errors ?? [])[0] ?? null, weapon: weapon.ready ? (weapon.fists ? 'fists' : 'weapon') : 'none', at: new Date().toISOString() }
        if (attack.ready === true && String(attack.targetUniqueId) === String(actor.uniqueId)) return true
        // A hostile inside real reach takes priority over the escape. A model
        // pose a tick past its 200ms window at the escape handover is not a
        // reason to keep trading hits; the bound controller re-verifies pose.
        if (attack.code === 'POSE_UNTRUSTED' && weapon.ready) {
          const reachAim = meleeApproachAim(actor)
          if (reachAim && Math.hypot(state.position.x - reachAim.x, state.position.y - reachAim.y, state.position.z - reachAim.z) <= 2.8) return true
        }
        const aim = meleeApproachAim(actor), range = Math.hypot(state.position.x - aim.x, state.position.y - aim.y, state.position.z - aim.z)
        // Far bow claims already require the actual Ranged passive survey in
        // Coordinator selection. A melee survey code (e.g. a momentarily stale
        // pose) must not veto that bow claim, so check it before the melee code.
        if (range >= 4 && userHasBowAndAmmo(state)) return true
        if (attack.code !== 'OUT_OF_REACH') return false
        // Immediate defence (ranked above the escape): a hostile just outside
        // real reach but within the 4-block defence range takes the lease with
        // a usable weapon; the bound approach still proves its own route.
        if (weapon.ready && range < 4) return true
        if (!surfaceMeleeSight(state.position, aim)) return false
        const physical = state.predicted?.physicsState ?? state.physicsState
        const initial = generationPhysics.fromServer(state), surfaceY = generationPhysics.waterSurface(initial.position)?.surfaceY
        const water = !(physical?.onGround === true && physical.isInWater !== true) && Number.isInteger(surfaceY) && knownSurfaceBody(generationPhysics, initial.position, surfaceY)
        if (water && !surfaceBinding || !water && (initial.isInWater || !initial.onGround)) return false
        const dx = state.position.x - actor.position.x, dz = state.position.z - actor.position.z, horizontal = Math.hypot(dx, dz)
        if (!horizontal) return false
        const avoidance = userAvoidance(state, actor)
        if (!userApproachSurveys.has(water)) userApproachSurveys.set(water, createNavigator({ world: host.world, version: host.meta.version, allowWater: water, physics: generationPhysics.withWorld(host.world, { allowWater: water }) }))
        const navigator = userApproachSurveys.get(water)
        for (const radius of [2, 1.8, 2.2]) for (const y of water ? [surfaceY] : [...new Set([Math.round(state.position.y - 1.62), Math.floor(actor.position.y), Math.floor(actor.position.y) + 1])]) {
          const target = { x: actor.position.x + dx / horizontal * radius, y, z: actor.position.z + dz / horizontal * radius }
          if (Math.hypot(target.x - state.position.x, target.y - state.position.y + 1.62, target.z - state.position.z) > 6) continue
          const targetEye = { ...target, y: y + 1.62 }
          if (Math.hypot(targetEye.x - aim.x, targetEye.y - aim.y, targetEye.z - aim.z) > 2.8 || !surfaceMeleeSight(targetEye, aim)) continue
          const route = navigator.plan(initial, target, { maxDistance: 6, maxExpanded: 300, avoidance, ...(water ? { directSurface: true, exactGoal: true } : {}) })
          if (route.ready === true && (!water || route.directSurface === true)) return true
          // Yield between bounded candidates while the existing sender keeps
          // ownership. A changed live seed/target/circle set needs a fresh try.
          await delay(0, undefined, { signal: context.signal })
          const fresh = lightweightUserState(), currentActor = fresh.entities?.find(e => String(e.runtimeId) === String(actor.runtimeId) && String(e.uniqueId) === String(actor.uniqueId) && e.entityType === actor.entityType)
          if (!currentGeneration() || context.signal?.aborted || userScope(fresh) !== userScope(state) || fresh.health < state.health || !currentActor || !['x', 'y', 'z'].every(k => currentActor.position?.[k] === actor.position[k] && Math.abs(fresh.position?.[k] - state.position[k]) <= 1e-4) || JSON.stringify(userAvoidance(fresh, currentActor)) !== JSON.stringify(avoidance)) return false
        }
      } catch (error) { host.shared.lastPreemptSurvey = { code: 'THROWN', error: String(error?.message ?? error).slice(0, 160), at: new Date().toISOString() } /* Unknown state, terrain, tool or actors cannot preempt safety. */ }
      return false
    }
    // Diagnostics only: the most recent root refusal of a user-behavior lease.
    function userAcquireDenied (reason) {
      host.shared.userAcquireDenials ??= {}
      const counts = host.shared.userAcquireDenials
      counts[reason] = (counts[reason] ?? 0) + 1
      host.shared.lastUserAcquireDenial = { reason, at: new Date().toISOString() }
      return { acquired: false, reason }
    }
    async function acquireUserControl (context) {
      requireGeneration()
      const preemptedBed = context.kind === 'combat' && userBehaviorLease?.kind === 'bed' && !userBehaviorSleeping && !userBehaviorSnapshot().sleeping ? userBehaviorLease : null
      if (userBehaviorLease && userBehaviorLease !== preemptedBed || context.signal?.aborted || disposed || disposing) return userAcquireDenied('busy_or_disposed')
      let meleeApproach = null, surfaceMeleeBinding = null
      if (context.kind === 'combat' && context.target) {
        const state = lightweightUserState(), aim = meleeApproachAim(context.target)
        const range = aim ? Math.hypot(state.position.x - aim.x, state.position.y - aim.y, state.position.z - aim.z) : NaN
        const canonical = evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
        const actor = state.entities?.find(e => String(e.runtimeId) === String(context.target.runtimeId) && String(e.uniqueId) === String(context.target.uniqueId) && e.entityType === context.target.entityType && e.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && e.dimension === state.dimension)
        const currentAim = actor && meleeApproachAim(actor), currentRange = currentAim ? Math.hypot(state.position.x - currentAim.x, state.position.y - currentAim.y, state.position.z - currentAim.z) : Infinity
        if (currentRange < 4 && actor && !canonical.requiresObservation && canonical.threats.some(e => e.runtimeId === String(actor.runtimeId) && e.category === 'melee') && state.inventory?.known === true && !state.inventory.uncertain && state.inventoryConfidence?.known !== false && Array.isArray(state.inventory.items)) surfaceMeleeBinding = { scope: userScope(state), runtimeId: String(actor.runtimeId), uniqueId: String(actor.uniqueId), entityType: actor.entityType, initialBodyRange: currentRange, threatPolicy: state.threatPolicy, radius: canonical.threats.find(e => e.runtimeId === String(actor.runtimeId)).dangerRadius }
        const scope = context.scope
        if (scope && ['profile', 'connectionId', 'startedAt', 'dimension'].some(k => scope[k] != null && String(scope[k]) !== String(state[k])) || scope?.realmId != null && String(scope.realmId) !== String(state.realm?.id) || scope?.runtimeEntityId != null && String(scope.runtimeEntityId) !== String(state.runtimeEntityId) || scope?.deathId != null && scope.deathId !== actualLifeId()) return userAcquireDenied('scope_changed')
        if (!actor) return userAcquireDenied('target_moved_or_unknown')
        // Coordinator already selected a live eligible target. Take control
        // before any work cleanup; moving mobs are re-read by the controller.
        if (range >= 4 && !userHasBowAndAmmo(state) && !canAcquireStuckMeleeApproach(context.target, state)) {
          if (canAcquireHealthyMeleeApproach(actor, state)) meleeApproach = { reason: 'healthy_armed_melee', scope: userScope(state), target: { runtimeId: String(actor.runtimeId), uniqueId: String(actor.uniqueId), entityType: actor.entityType }, engagementReached: false }
        }
      }
      const token = {}, lease = { kind: context.kind, claimId: context.claimId, token, generation: generationStream, scope: context.scope, ready: false, meleeApproach, surfaceMeleeBinding }
      quarryEgressAbort?.abort(new Error('EGRESS_COMBAT_INTERRUPTED'))
      // Revoke the old task before the combat lease makes its ownership check
      // fail. This also removes any not-yet-sent placement transaction.
      generationPillar?.cancel('ASCENT_COMBAT_INTERRUPTED')
      if (context.kind === 'combat') {
        cancelChunkMovement('COMBAT_PRIORITY')
        manualChestStorage?.cancel('COMBAT_PRIORITY')
        manualShulkerAbort?.abort(new Error('COMBAT_PRIORITY'))
        manualShulkerRecovery?.cancel('COMBAT_PRIORITY')
        if (!host.shared.autoWanted && quarryJob?.holdsWork()) lease.defenseAnchor = createDefenseAnchor(lightweightUserState())
        else if (!host.shared.autoWanted) {
          const state = lightweightUserState(), anchor = host.shared.combatDefenseAnchor
          if (!anchor || !defenseMovementAllowed({ anchor, state, position: anchor.feet, retreating: true }).allowed) host.shared.combatDefenseAnchor = createDefenseAnchor(state)
          lease.defenseAnchor = host.shared.combatDefenseAnchor
        }
      }
      userBehaviorLease = lease
      quarryCancellationRevision++
      const storageContext = quarryJob?.storageInterruptionContext?.()
      const preemption = storageContext ? (() => {
        const s = lightweightUserState()
        return { ...storageContext, sequence: host.shared.quarryUserPreemptionSequence = (host.shared.quarryUserPreemptionSequence ?? 0) + 1, preemptionStarted: true, kind: context.kind, claimedAt: Date.now(), claimId: String(context.claimId ?? ''), scope: JSON.stringify([s.profile ?? null, s.realm?.id ?? s.realmId ?? null, s.dimension ?? null, s.connectionId ?? null, s.startedAt ?? null]), life: actualLifeId(), outcome: 'preempting' }
      })() : null
      if (preemption) host.shared.quarryUserPreemption = preemption
      if (context.kind === 'combat') {
        const cleanupTasks = []
        const revoke = fn => { try { cleanupTasks.push(Promise.resolve(fn())) } catch (error) { cleanupTasks.push(Promise.reject(error)) } }
        // Release the exact food-use input while it still owns the stream.
        if (typeof food.preemptForCombat === 'function') food.preemptForCombat('user_behavior')
        else food.cancel('user_behavior')
        armor.preemptForCombat?.('user_behavior')
        // Cancel input synchronously. Bookkeeping/drain promises retain their
        // checkpoints but cannot delay the new combat owner's first action.
        stopOrdinaryUserStream(); mining.stop('user_behavior'); walker?.stop('user_behavior'); generationMovement.stop('user_behavior'); generationCombat.cancel('user_behavior')
        const mutationPending = () => inventory.snapshot().pendingRequestId != null || chest.snapshot().pendingRequestId != null || furnace.snapshot().pendingRequestId != null || craftStatus().pendingRequestId != null || manualChestStorage?.pendingMutation()
        const receiptWaiting = () => mutationPending() || inventory.snapshot().busy || chest.snapshot().busy || furnace.snapshot().busy || manualChestStorage?.equipmentBusy?.()
        if (craftStatus().pendingRequestId == null) crafting.cancel('user_behavior')
        if (furnace.snapshot().pendingRequestId == null) furnace.cancel('user_behavior')
        if (chest.snapshot().pendingRequestId == null) chest.cancel('user_behavior')
        interactions.cancel('user_behavior'); prospecting.cancel('user_behavior')
        // A request already on the wire keeps its reply observer. Combat
        // remains the owner while its actual inventory receipt settles.
        if (inventory.snapshot().pendingRequestId == null) inventory.cancel('user_behavior')
        if (!mutationPending()) { try { crafting.closeContainer() } catch {} }
        for (const fn of [
          () => autonomy.stop('user_behavior'), () => depotPrebuild?.cancel('user_behavior'), () => depotBuilder?.stop('user_behavior'), () => depotStorage?.cancel('user_behavior'),
          () => depotPrebuild?.drain(), () => quarryPillarTask, () => quarryEgressTask,
          () => generationSafety.stop('user_behavior'), () => generationSafety.drain(), () => generationCombat.drain(),
          () => excavation?.stop('user_behavior'), () => tunneling?.stop('user_behavior'), () => recovery?.stop('user_behavior'),
          () => foraging?.stop('user_behavior'), () => surfaceReturn?.stop('user_behavior'), () => generationShelter.stop('user_behavior'), () => generationHut.stop('user_behavior'), () => generationGuardRoute.stop('user_behavior')
        ]) revoke(fn)
        const cleanup = Promise.allSettled(cleanupTasks)
        void cleanup.then(results => {
          if (currentGeneration()) host.shared.combatPreemptionCleanup = { claimId: context.claimId, completedAt: Date.now(), failures: results.filter(r => r.status === 'rejected').length }
        })
        lease.ready = true
        lease.receiptsReady = !receiptWaiting() && !host.shared.inventoryUncertain
        if (!lease.receiptsReady) {
          // This observer never resumes the old operation. It keeps only the
          // sent request's response and closes its GUI before weapon input.
          void (async () => {
            const until = Date.now() + 10000
            let refreshSent = false
            while (currentGeneration() && userBehaviorLease === lease && !context.signal?.aborted && Date.now() < until) {
              if (!receiptWaiting()) {
                try { crafting.closeContainer() } catch {}
                if (!host.shared.inventoryUncertain) { lease.receiptsReady = true; return }
                if (!refreshSent) {
                  try { await requestInventoryResyncWithReceipt('combat_preemption', { combatLease: lease }); refreshSent = true } catch (error) { if (!['BUSY', 'RESYNC_RATE_LIMIT'].includes(error.code)) break }
                }
              }
              await delay(25)
            }
            if (userBehaviorLease === lease && !lease.receiptsReady) userBehaviors?.cancel('戦闘前の持ち物受信を確認できませんでした。', 'INVENTORY_RECEIPT_UNCONFIRMED')
          })().catch(error => { host.shared.combatReceiptError = String(error.message ?? error).slice(0, 200) })
        }
        if (preemption) { preemption.outcome = 'ready'; preemption.readyAt = Date.now() }
        host.shared.combatPriorityTransition = { claimId: context.claimId, target: context.target?.entityType ?? null, at: Date.now(), cleanupPending: true }
        startIdle()
        return token
      }
      autonomy.stop('user_behavior')
      depotPrebuild?.cancel('user_behavior'); depotBuilder?.stop('user_behavior'); depotStorage?.cancel('user_behavior')
      // A cancelled prebuild settles with its abort reason; that is not an acquire failure.
      await depotPrebuild?.drain()?.catch(() => {})
      stopOrdinaryUserStream(); mining.stop('user_behavior'); walker?.stop('user_behavior'); generationMovement.stop('user_behavior'); generationCombat.cancel('user_behavior')
      crafting.cancel('user_behavior'); furnace.cancel('user_behavior'); inventory.cancel('user_behavior'); food.cancel('user_behavior'); interactions.cancel('user_behavior'); prospecting.cancel('user_behavior')
      const stopped = await Promise.allSettled([quarryPillarTask, quarryEgressTask, generationSafety.stop('user_behavior'), generationSafety.drain(), generationCombat.drain(), excavation?.stop('user_behavior'), tunneling?.stop('user_behavior'), recovery?.stop('user_behavior'), foraging?.stop('user_behavior'), generationShelter.stop('user_behavior'), generationHut.stop('user_behavior'), generationGuardRoute.stop('user_behavior')])
      const deadline = Date.now() + 2000
      while ((autonomy.snapshot().actionActive || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy) && Date.now() < deadline && currentGeneration()) await delay(25)
      if (!currentGeneration() || stopped.some(r => r.status === 'rejected') || autonomy.snapshot().actionActive || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy) { if (preemption) preemption.outcome = 'cleanup_failed'; if (userBehaviorLease === lease) userBehaviorLease = null; return userAcquireDenied('stops_rejected_or_still_busy') }
      lease.ready = true
      if (preemption) { preemption.outcome = 'ready'; preemption.readyAt = Date.now() }
      // A first combat claim can precede resumeRequested and its idle timer.
      // Keep real neutral physics queued during equipment/observation waits.
      if (lease.kind === 'combat') startIdle()
      return token
    }
    async function resumeUserControl (context) {
      // An acquisition that threw never handed out a token. Refusing its release
      // left the coordinator release_blocked (no combat at all) for the rest of
      // the life. Nothing was granted, so clear a half-set lease of the same
      // claim and report the release as complete.
      if (context?.token == null && (!userBehaviorLease || userBehaviorLease.kind === context?.kind && userBehaviorLease.claimId === context?.claimId && userBehaviorLease.ready !== true)) {
        if (userBehaviorLease) userBehaviorLease = null
        return { resumed: true, reason: 'NO_ROOT_LEASE_GRANTED' }
      }
      if (!sameLease(context)) return { resumed: false, reason: 'STALE_ROOT_USER_BEHAVIOR_TOKEN' }
      userBehaviorLease = null
      if (context.kind === 'combat' && !lightweightUserState().entities?.some(e => e.hostile === true && e.alive !== false && e.positionKnown === true && e.position && Math.hypot(e.position.x - working().position.x, e.position.y - working().position.y + 1.62, e.position.z - working().position.z) <= 32)) host.shared.combatDefenseAnchor = null
      return { resumed: true }
    }
    function userClock () {
      const clock = Object.values(host.shared.worldClocks ?? {}).find(c => c.name === 'minecraft:overworld' && c.source === 'server_sync_world_clocks' && Number.isSafeInteger(c.time))
      if (clock) return { time: clock.time, source: clock.source }
      const fallback = host.shared.worldTime
      return raw().dimension === 'overworld' && fallback?.source === 'server_set_time' && Number.isSafeInteger(fallback.ticks) ? { time: fallback.ticks, source: fallback.source } : { time: null, source: 'unknown' }
    }
    async function userInteraction (method, value, context) {
      requireUserLease(context)
      const cancel = () => { if (sameLease(context)) interactions.cancel('Bed interaction cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try { const result = await interactions[method](value); requireUserLease(context); return result } finally { context.signal?.removeEventListener('abort', cancel) }
    }
    async function mineUserBed (target, context) {
      requireUserLease(context)
      const cancel = () => { if (sameLease(context)) mining.stop('Owned bed mining cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try {
        mining.start([target])
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          requireUserLease(context)
          const result = mining.snapshot()
          if (result.phase === 'completed') return { ...result, serverConfirmed: true, confirmedBy: 'normal_miner_received_block_air' }
          if (['failed', 'stopped'].includes(result.phase)) throw new Error(result.reason ?? 'Owned bed mining stopped')
          await delay(50, undefined, { signal: context.signal })
        }
        throw new Error('Owned bed mining confirmation timed out')
      } finally { context.signal?.removeEventListener('abort', cancel) }
    }
    // Fighting several hostiles: their full danger radii (a skeleton's is its
    // shot range) blocked every approach step to the primary. Only a creeper's
    // blast radius is kept; other bodies are just stepped around.
    function combatAvoidRadius (e, radius) { return e.entityType === 'minecraft:creeper' || e.kind === 'player' ? radius : Math.min(radius, 2.5) }
    function userAvoidance (state, primary = null) {
      const actors = host.entities.snapshot({ kind: 'all' })
      if (actors.some(e => e.alive !== false && e.kind !== 'item' && (e.positionKnown !== true || !e.position))) throw new Error('User movement has unknown actor bodies')
      const threats = evaluateThreats(state, actors, { observationRadius: 32 })
      if (threats.requiresObservation) throw new Error('User movement needs known actor positions')
      return actors.filter(e => e.alive !== false && e.kind !== 'item' && e.entityType !== 'minecraft:arrow' && String(e.runtimeId) !== String(primary?.runtimeId)).map(e => ({ id: String(e.runtimeId), position: { ...e.position }, minDistance: combatAvoidRadius(e, threats.threats.concat(threats.outsideDanger, threats.suppressedByTerrain ?? []).find(t => t.runtimeId === String(e.runtimeId))?.dangerRadius ?? (e.kind === 'player' ? 3 : 1.5)), padding: 0 }))
    }
    function surfaceMeleeSight (from, to) {
      const passable = p => { const b = host.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b?.known === true && !b.extra?.length && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:flowing_water'].includes(b.name) }
      const axes = ['x', 'y', 'z'], cell = {}, step = {}, next = {}, delta = {}
      for (const k of axes) { cell[k] = Math.floor(from[k]); const d = to[k] - from[k]; step[k] = Math.sign(d); delta[k] = d ? 1 / Math.abs(d) : Infinity; next[k] = d ? (cell[k] + Number(d > 0) - from[k]) / d : Infinity }
      if (!passable(cell)) return false
      for (let count = 0; count < 64; count++) {
        const crossing = Math.min(...axes.map(k => next[k])); if (crossing > 1) return true
        const crossed = axes.filter(k => Math.abs(next[k] - crossing) < 1e-10)
        for (let mask = 1; mask < 1 << crossed.length; mask++) { const p = { ...cell }; crossed.forEach((k, i) => { if (mask & 1 << i) p[k] += step[k] }); if (!passable(p)) return false }
        for (const k of crossed) { cell[k] += step[k]; next[k] += delta[k] }
      }
      return false
    }
    function surfaceCombatState (target, context, expected = null) {
      const state = requireUserLease(context), lease = userBehaviorLease, binding = lease?.surfaceMeleeBinding
      if (!binding || lease.kind !== 'combat' || String(target?.runtimeId) !== binding.runtimeId || String(target?.uniqueId) !== binding.uniqueId || target?.entityType !== binding.entityType) return null
      if (binding.scope !== userScope(state) || expected && expected.scope !== binding.scope || state.threatPolicy !== binding.threatPolicy || host.shared.autoWanted !== true || host.shared.userBehaviorsEnabled !== true || host.shared.respawnTerrain?.pending || userBehaviorSleeping || userBehaviorWakePending || replaying) throw new Error('Surface melee approach scope or policy changed')
      const actor = state.entities?.find(e => String(e.runtimeId) === binding.runtimeId && String(e.uniqueId) === binding.uniqueId && e.entityType === binding.entityType && e.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && e.dimension === state.dimension)
      if (!actor || actor.positionSource === 'client_prediction' || state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false) throw new Error('Surface melee target or inventory changed')
      const evaluated = evaluateThreats(state, state.entities, { observationRadius: 32 }), canonical = [...evaluated.threats, ...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].find(e => e.runtimeId === binding.runtimeId)
      if (evaluated.requiresObservation || !canonical || canonical.category !== 'melee' || canonical.dangerRadius !== binding.radius) throw new Error('Surface melee target policy changed')
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (!expected && physical?.onGround === true && physical.isInWater !== true) return null
      const initial = generationPhysics.fromServer(state), surfaceY = generationPhysics.waterSurface(initial.position)?.surfaceY
      if (!Number.isInteger(surfaceY) || !knownSurfaceBody(generationPhysics, initial.position, surfaceY)) { if (expected) throw new Error('Surface melee water, body or head changed'); return null }
      if (expected && surfaceY !== expected.surfaceY) throw new Error('Surface melee received surface changed')
      const stamp = typeof state.positionUpdatedAt === 'number' ? state.positionUpdatedAt : Date.parse(state.positionUpdatedAt)
      if (!Number.isFinite(stamp) || Date.now() - stamp < 0 || Date.now() - stamp > 200 || !physical || !['x', 'y', 'z'].every(k => Number.isFinite(physical.velocity?.[k])) || physical.isInLava || state.positionSource === 'client_prediction' && !['x', 'y', 'z'].every(k => Number.isFinite(state.predicted?.position?.[k]) && Math.abs(state.predicted.position[k] - state.position[k]) <= 1e-6 && Number.isFinite(physical.position?.[k]) && Math.abs(physical.position[k] + (k === 'y' ? 1.62 : 0) - state.position[k]) <= 1e-6)) throw new Error('Surface melee current native pose is untrusted')
      const aim = meleeApproachAim(actor)
      if (!aim || !surfaceMeleeSight(state.position, aim)) throw new Error('Surface melee sight is blocked or unknown')
      return { state, actor, scope: binding.scope, surfaceY, initial }
    }
    function surfaceEyeSegmentSafe (from, to, circles) {
      return circles.every(circle => {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = dx * dx + dy * dy + dz * dz
        const t = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * dx + (circle.position.y - from.y) * dy + (circle.position.z - from.z) * dz) / length)) : 0
        return Math.hypot(from.x + t * dx - circle.position.x, from.y + t * dy - circle.position.y, from.z + t * dz - circle.position.z) >= circle.minDistance + (circle.padding ?? 0) - 1e-4
      })
    }
    async function moveUserNative (target, context, primary = null, surface = null) {
      const initial = requireUserLease(context), expectedScope = userScope(initial), controller = generationMovement, owner = userBehaviorLease
      const counterOrigin = { ...initial.position, y: initial.position.y - 1.62 }
      const emergencyCounterhit = context.kind === 'combat' && context.emergencyCreeperStrike === true && primary?.entityType === 'minecraft:creeper' && Math.hypot(initial.position.x - primary.position.x, initial.position.y - primary.position.y - 0.9, initial.position.z - primary.position.z) <= 4.5
      if (context.emergencyCreeperStrike === true && !emergencyCounterhit) throw new Error('Invalid emergency creeper counterstep')
      const checkCounterstep = points => {
        if (!emergencyCounterhit) return
        for (const p of points) if (!p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k])) || Math.hypot(p.x - counterOrigin.x, p.y - counterOrigin.y, p.z - counterOrigin.z) > 1.5) throw new Error('Emergency creeper counterstep exceeds1.5m')
      }
      checkCounterstep([target])
      if (context.kind === 'combat' && quarryJob?.holdsWork()) {
        // Quarry §9.3: ordinary combat steps stay within 8m of the fixed anchor
        // on the current layer; kite retreats count as emergency escapes.
        quarryJob.bridge.interrupt(initial, { reason: 'combat_movement' })
        const verdict = quarryJob.bridge.canMoveTo(target, { reason: emergencyCounterhit ? 'emergency_counterhit' : quarryRetreatDepth > 0 ? 'emergency_escape' : 'combat' })
        if (!verdict.allowed) throw Object.assign(new Error(`Quarry combat movement refused: ${verdict.reason}`), { code: 'QUARRY_ANCHOR' })
      }
      const checkDefenseRoute = (state, position, waypoints = []) => {
        checkCounterstep([...waypoints.map(p=>p?.position??p),position])
        if (context.kind !== 'combat' || !owner.defenseAnchor) return
        const verdict = defenseMovementAllowed({ anchor: owner.defenseAnchor, state, position, waypoints, retreating: quarryRetreatDepth > 0 || emergencyCounterhit })
        if (!verdict.allowed) throw Object.assign(new Error(`Defense movement refused: ${verdict.reason}`), { code: 'DEFENSE_ANCHOR' })
      }
      checkDefenseRoute(initial, target)
      let waterSerial = null
      if (!target || !['x', 'y', 'z'].every(k => Number.isFinite(target[k])) || Math.hypot(target.x - initial.position.x, target.y - initial.position.y + 1.62, target.z - initial.position.z) > 6) throw new Error('User movement exceeds its known six-block step')
      const ensure = () => {
        const fresh = requireUserLease(context)
        if (userScope(fresh) !== expectedScope || userBehaviorLease !== owner || controller !== movement || surface && waterSerial != null && waterSerial !== portableMovementSerial) throw new Error('User movement life or owner changed')
        if (primary && !host.entities.snapshot({ kind: 'all' }).some(e => String(e.runtimeId) === String(primary.runtimeId) && String(e.uniqueId) === String(primary.uniqueId) && e.entityType === primary.entityType && e.alive === true && e.positionKnown === true)) throw new Error('Combat approach target changed')
        if (emergencyCounterhit) {
          const actor = host.entities.snapshot({kind:'all'}).find(e=>String(e.runtimeId)===String(primary.runtimeId)&&String(e.uniqueId)===String(primary.uniqueId))
          if (!actor?.position || Math.hypot(actor.position.x-fresh.position.x,actor.position.y+0.9-fresh.position.y,actor.position.z-fresh.position.z)>4.5) throw new Error('Creeper counterstep target is no longer close')
        }
        if (surface && !surfaceCombatState(primary, context, surface)) throw new Error('Surface melee approach lost its bound admission')
        validateHealthyMeleeApproach(fresh, primary)
        return fresh
      }
      const options = { allowWater: surface !== null, emergency: true, maxDistance: 6, maxExpanded: 300, ...(surface ? { directSurface: true, exactGoal: true, sprint: false, maxTicks: 80 } : {}), avoidance: userAvoidance(initial, primary), signal: context.signal, beforeInput: frame => {
        const fresh = ensure(), eye = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
        checkDefenseRoute(fresh, frame.predictedState.position)
        if (surface) {
          if (!knownSurfaceBody(generationPhysics, frame.predictedState.position, surface.surfaceY) || !frame.packetPosition || Math.hypot(eye.x - frame.packetPosition.x, eye.y - frame.packetPosition.y, eye.z - frame.packetPosition.z) > 1e-6) return false
          return surfaceEyeSegmentSafe(fresh.position, eye, userAvoidance(fresh, primary))
        }
        return userAvoidance(fresh, primary).every(a => Math.hypot(eye.x - a.position.x, eye.y - a.position.y, eye.z - a.position.z) >= a.minDistance)
      } }
      ensure(); motionOrigin = working()
      const preview = controller.preview(target, options)
      if (!preview?.ready || surface && preview.directSurface !== true) return { ready: false, reason: 'No known native user movement route' }
      if ((owner.defenseAnchor || emergencyCounterhit) && (!Array.isArray(preview.waypoints) || !preview.waypoints.length)) return { ready: false, reason: 'Defense route waypoints are unknown' }
      checkDefenseRoute(ensure(), target, preview.waypoints ?? [])
      ensure(); stopOrdinaryUserStream(); motionOrigin = working(); host.shared.motionSource = 'navigation'
      const owns = () => sameLease(context) && userBehaviorLease === owner && controller === movement && (!surface || waterSerial === portableMovementSerial)
      const cancel = () => { if (owns()) controller.stop('User movement cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try {
        ensure()
        if (surface) { yieldPortableMovement(); waterSerial = ++portableMovementSerial; portableMovementOwner = null }
        controller.start(target, options)
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          const fresh = ensure(), motion = controller.snapshot()
          if (primary) {
            const e = host.entities.snapshot({ kind: 'all' }).find(e => String(e.runtimeId) === String(primary.runtimeId)), p = e && (surface ? meleeApproachAim(e) : { ...e.position, y: e.position.y + 0.9 })
            if (p && Math.hypot(fresh.position.x - p.x, fresh.position.y - p.y, fresh.position.z - p.z) <= (surface ? 2.8 : 2.2) && (!surface || surfaceMeleeSight(fresh.position, p))) return { phase: 'predicted', accepted: true, serverConfirmed: false, ...(surface ? { meleeReady: true, surfaceApproach: true } : {}) }
          }
          if (['failed', 'stopped'].includes(motion.phase)) throw new Error(motion.reason ?? 'User movement stopped')
          if (['awaiting_server_confirmation', 'completed', 'replan_required'].includes(motion.phase)) return { phase: 'predicted', accepted: true, serverConfirmed: false, movement: motion }
          await delay(50, undefined, { signal: context.signal })
        }
        throw new Error('User movement step timed out')
      } finally { context.signal?.removeEventListener('abort', cancel); if (owns()) controller.stop('User movement step ended') }
    }
    async function approachSurfaceMelee (target, context) {
      const initial = surfaceCombatState(target, context)
      if (!initial) return null
      const pinned = { scope: initial.scope, surfaceY: initial.surfaceY }
      for (const radius of [2, 1.8, 2.2]) {
        const current = surfaceCombatState(target, context, pinned), dx = current.state.position.x - current.actor.position.x, dz = current.state.position.z - current.actor.position.z, distance = Math.hypot(dx, dz)
        if (!distance) return { ready: false, reason: 'Surface melee approach direction is unknown' }
        const candidate = { x: current.actor.position.x + dx / distance * radius, y: pinned.surfaceY, z: current.actor.position.z + dz / distance * radius }
        if (Math.hypot(candidate.x - current.state.position.x, candidate.y - current.state.position.y + 1.62, candidate.z - current.state.position.z) > 6) continue
        const options = { allowWater: true, emergency: true, directSurface: true, exactGoal: true, sprint: false, maxTicks: 80, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(current.state, current.actor) }
        motionOrigin = working()
        const preview = generationMovement.preview(candidate, options)
        if (preview?.ready && preview.directSurface === true) return moveUserNative(candidate, context, current.actor, pinned)
      }
      return { ready: false, reason: 'No known bounded surface melee stance' }
    }
    function meleeApproachAim (target) {
      return target?.position && ['x', 'y', 'z'].every(axis => Number.isFinite(target.position[axis])) ? { ...target.position, y: target.position.y + (['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:vex', 'minecraft:phantom'].includes(target.entityType) ? 0.2 : 0.9) } : null
    }
    function userHasBowAndAmmo (state) {
      return state.inventory?.known === true && !state.inventory.uncertain && Array.isArray(state.inventory.items) && state.inventory.items.some(i => i.name === 'minecraft:bow' && i.count === 1) && state.inventory.items.some(i => i.name === 'minecraft:arrow' && Number.isSafeInteger(i.count) && i.count > 0)
    }
    function knownUserSword (state) {
      const inventory = craftInventory()
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || !Array.isArray(state.inventory.items) || inventory.authority !== true || inventory.inventoryKnown !== true || inventory.pendingRequestId != null) return false
      return state.inventory.items.some(item => {
        if (!/^minecraft:(?:wooden|golden|stone|copper|iron|diamond|netherite)_sword$/.test(item.name) || item.count !== 1 || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) return false
        const raw = crafting.rawItem(item.slot), observed = inventory.inventory?.find(value => value.slot === item.slot)
        if (!raw || !Number.isSafeInteger(raw.network_id) || raw.network_id <= 0 || raw.count !== 1 || raw.has_stack_id !== true || !Number.isSafeInteger(raw.stack_id) || raw.stack_id <= 0 || observed?.name !== item.name || observed.count !== 1 || observed.stackId !== raw.stack_id || item.stackId != null && item.stackId !== raw.stack_id) return false
        const extra = raw.extra, marker = extra?.has_nbt
        if (!['false', 'true', false, true, 0, 65535].includes(marker) || !Array.isArray(extra?.can_place_on) || !Array.isArray(extra?.can_destroy)) return false
        if (['true', true, 65535].includes(marker)) {
          const nbt = extra.nbt?.nbt, damage = nbt?.value?.Damage
          if (nbt?.type !== 'compound' || !nbt.value || typeof nbt.value !== 'object' || Array.isArray(nbt.value) || damage != null && (!['int', 'short'].includes(damage.type) || !Number.isSafeInteger(damage.value))) return false
        } else if (extra.nbt != null) return false
        try {
          const parsed = UserCombatItem.fromNotch(structuredClone(raw))
          return parsed && 'minecraft:' + parsed.name === item.name && Number.isSafeInteger(parsed.maxDurability) && parsed.maxDurability > 0 && Number.isSafeInteger(parsed.durabilityUsed) && parsed.durabilityUsed >= 0 && parsed.maxDurability - parsed.durabilityUsed >= 4
        } catch { return false }
      })
    }
    function healthyMeleeReady (target, state) {
      const authoritative = raw()
      if (!Number.isSafeInteger(host.shared.deathRespawn?.deathId) || state.lifecycle?.deathId !== actualLifeId() || state.health !== authoritative.health || ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].some(field => state[field] !== authoritative[field]) || state.profile !== (authoritative.profile ?? host.meta.profile) || String(state.realm?.id ?? '') !== String(authoritative.realm?.id ?? '')) return false
      if (!currentGeneration() || replaying || host.shared.autoWanted !== true || host.shared.userBehaviorsEnabled !== true || resourceMinHealth(state) !== 0 || state.health < 12 || host.shared.respawnTerrain?.pending || userBehaviorSleeping || userBehaviorWakePending || userHasBowAndAmmo(state)) return false
      if (!['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk', 'minecraft:spider', 'minecraft:cave_spider'].includes(target?.entityType) || target.kind !== 'mob' || target.hostile !== true || target.alive !== true || target.positionKnown !== true || target.positionSource === 'client_prediction' || target.dimension !== state.dimension || !/^\d+$/.test(String(target.runtimeId)) || !/^-?\d+$/.test(String(target.uniqueId)) || !meleeApproachAim(target)) return false
      const current = evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
      if (current.requiresObservation || state.entityStats?.unknownPositions > current.unknownPositions.length || !current.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category === 'melee')) return false
      const actor = state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType && e.alive === true && e.positionKnown === true)
      return !!actor && ['x', 'y', 'z'].every(axis => actor.position?.[axis] === target.position[axis]) && knownUserSword(state)
    }
    function canAcquireHealthyMeleeApproach (target, state) {
      const protection = generationSafety.snapshot(), observation = recentUserSafetyObservation
      if (protection.running !== true || protection.cleanupUnconfirmed || !observation || Date.now() - observation.at < 0 || Date.now() - observation.at > 500 || observation.scope !== userScope(state) || !['x', 'y', 'z'].every(axis => state.position?.[axis] === observation.state.position?.[axis]) || !healthyMeleeReady(target, state)) return false
      const observed = observation.state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType)
      if (!observed || !['x', 'y', 'z'].every(axis => observed.position?.[axis] === target.position[axis])) return false
      const canonical = evaluateThreats(observation.state, observation.state.entities, { observationRadius: 32 })
      return !canonical.requiresObservation && !(observation.state.entityStats?.unknownPositions > canonical.unknownPositions.length) && canonical.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category === 'melee')
    }
    function validateHealthyMeleeApproach (state, primary) {
      const admission = userBehaviorLease?.meleeApproach
      if (!admission || !primary) return
      const actor = state.entities?.find(e => String(e.runtimeId) === admission.target.runtimeId && String(e.uniqueId) === admission.target.uniqueId && e.entityType === admission.target.entityType && e.alive === true && e.positionKnown === true)
      if (!actor) throw new Error('Healthy melee approach target changed')
      rememberCurrentMeleeReach(state)
      // This is approach permission, never proof of a hit. After entering real
      // current melee reach, the existing positive-health fight keeps its lease.
      if (!admission.engagementReached && !healthyMeleeReady(actor, state)) throw new Error('Healthy melee approach admission was revoked before engagement')
    }
    function canAcquireStuckMeleeApproach (target, state) {
      if (!currentGeneration() || replaying || host.shared.autoWanted !== true || host.shared.userBehaviorsEnabled !== true || resourceMinHealth(state) !== 0 || host.shared.respawnTerrain?.pending || userBehaviorSleeping || userBehaviorWakePending) return false
      const protection = generationSafety.snapshot(), result = protection.lastResult
      if (protection.running !== true || protection.phase !== 'emergency_retry' || protection.cleanupUnconfirmed || !(result?.action === 'escape' && (result.reason === 'no_known_away_route' || ['NO_ROUTE', 'AVOIDANCE', 'SEARCH_LIMIT'].includes(result.rejection?.previewCode) || result.cause === 'NO_SAFE_ROUTE') || /four-second deadline exceeded/i.test(protection.lastError ?? ''))) return false
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || !Array.isArray(state.inventory.items)) return false
      if (state.inventory.items.some(i => i.name === 'minecraft:bow' && i.count === 1) && state.inventory.items.some(i => i.name === 'minecraft:arrow' && Number.isSafeInteger(i.count) && i.count > 0)) return false
      const observation = recentUserSafetyObservation
      if (!observation || Date.now() - observation.at < 0 || Date.now() - observation.at > 500 || observation.scope !== userScope(state) || !['x', 'y', 'z'].every(axis => state.position?.[axis] === observation.state.position?.[axis])) return false
      const current = evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
      if (current.requiresObservation || state.entityStats?.unknownPositions > current.unknownPositions.length) return false
      const observed = observation.state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType)
      if (!observed || !['x', 'y', 'z'].every(axis => observed.position?.[axis] === target.position?.[axis])) return false
      const canonical = evaluateThreats(observation.state, observation.state.entities, { observationRadius: 32 })
      return !canonical.requiresObservation && !(observation.state.entityStats?.unknownPositions > canonical.unknownPositions.length) && canonical.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category !== 'boss')
    }
    // melee_kite: after a hit, one short native step straight away from the
    // target to a known standpoint just outside its reach (never a long
    // escape; the ordinary approach brings the bot back in for the next hit).
    async function retreatUserTarget (target, context) {
      quarryRetreatDepth++
      try { return await retreatUserTargetInner(target, context) } finally { quarryRetreatDepth-- }
    }
    async function retreatUserTargetInner (target, context) {
      // The kite step follows a hit that is often a critical hop: the native
      // planner refuses an airborne origin, so wait briefly for the landing.
      for (let i = 0; i < KITE_LANDING_POLLS; i++) {
        const now = requireUserLease(context), physical = now.predicted?.physicsState ?? now.physicsState
        if (physical?.onGround === true && !generationMovement.snapshot().running) break
        await delay(50, undefined, { signal: context.signal })
      }
      const state = requireUserLease(context), dx = state.position.x - target.position.x, dz = state.position.z - target.position.z, d = Math.hypot(dx, dz)
      if (!d) return { ready: false, reason: 'Retreat direction is unknown' }
      // A creeper retreat asks for farther standpoints and a longer (still
      // bounded, at most 6) step; the kite default is a short 3-block step.
      const radii = Array.isArray(context.radii) && context.radii.every(r => Number.isFinite(r) && r > 0 && r <= 12) ? context.radii : KITE_RADII
      const maxStep = Number.isFinite(context.maxStep) && context.maxStep > 0 && context.maxStep <= 6 ? context.maxStep : 3
      let tried = 0, skipped = 0, lastReason = null
      // Straight back first, then diagonal-back directions when the terrain
      // directly behind has no known standpoint.
      for (const angle of KITE_ANGLES) for (const radius of radii) for (const y of [...new Set([Math.round(state.position.y - 1.62), Math.round(state.position.y - 1.62) - 1, Math.round(state.position.y - 1.62) + 1])]) {
        const cos = Math.cos(angle), sin = Math.sin(angle), ux = (dx * cos - dz * sin) / d, uz = (dx * sin + dz * cos) / d
        const candidate = { x: target.position.x + ux * radius, y, z: target.position.z + uz * radius }
        if (Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z) > maxStep) { skipped++; continue }
        motionOrigin = working()
        const preview = generationMovement.preview(candidate, { emergency: true, allowWater: false, maxDistance: Math.ceil(maxStep) + 1, maxExpanded: 300, avoidance: userAvoidance(state, target) })
        tried++
        if (preview?.ready) return moveUserNative(candidate, context, target)
        lastReason = preview?.reason ?? preview?.error ?? lastReason
      }
      return { ready: false, reason: `No known retreat standpoint (tried=${tried} skipped=${skipped} last=${lastReason ?? 'none'})` }
    }
    // Bow sight stance: a short move (<=4.5m, higher ground first) to a
    // standable cell from which the eye has a clear line to the target body.
    function bowSightClear (from, to) { return bowSightClearAt(from, to) }
    function bowSightClearUnused (from, to) {
      const ok = p => { const b = host.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b?.known === true && !b.extra?.length && (/^minecraft:(?:air|cave_air|void_air)$/.test(b.name) || b.boundingBox === 'empty' && !/water|lava|bubble|powder_snow|cobweb|portal/.test(String(b.name))) }
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25)
      for (let i = 1; i < steps; i++) { const f = i / steps; if (!ok({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f })) return false }
      return true
    }
    const seekSightStance = createSightStanceSearch({
      requireLease: requireUserLease,
      getTarget: id => typeof host.entities.get === 'function' ? host.entities.get(id) : allActors().find(actor => String(actor.runtimeId) === String(id)),
      getActors: allActors,
      getVelocity: id => host.entities.motion?.(id)?.velocity ?? null,
      getWorldRevision: () => host.world.revision?.() ?? null,
      getBlock: (x, y, z) => host.world.getBlock(x, y, z),
      sightClear: bowSightClear,
      standingClear: fullStandingGeometry,
      previewRoute: (point, state, target) => {
        motionOrigin = working()
        return generationMovement.preview(point, { emergency: true, allowWater: false, maxDistance: 18, maxExpanded: 900, avoidance: userAvoidance(state, target) })
      },
      move: moveUserNative,
      log: message => host.log(message)
    })
    async function approachUserTarget (target, context) {
      if (context?.purpose === 'sight') return seekSightStance(target, context)
      if (context.emergencyCreeperStrike === true && target?.entityType === 'minecraft:creeper') {
        const state=requireUserLease(context),dx=target.position.x-state.position.x,dz=target.position.z-state.position.z,d=Math.hypot(dx,dz),feetY=state.position.y-1.62
        if(!d)return {ready:false,reason:'No horizontal creeper counterstep'}
        for(const step of [...new Set([Math.min(1.2,Math.max(0.25,d-2.4)),0.6,0.3])]) {
          const p={x:state.position.x+dx/d*step,y:Math.round(feetY),z:state.position.z+dz/d*step}
          const probe={...state,position:{...p,y:p.y+1.62},predicted:null,physicsState:null}
          if(!fullStandingGeometry(probe,p))continue
          motionOrigin=working()
          if(!generationMovement.preview(p,{emergency:true,allowWater:false,maxDistance:2,maxExpanded:200,avoidance:userAvoidance(state,target)})?.ready)continue
          return moveUserNative(p,context,target)
        }
        return {ready:false,reason:'No known safe short creeper counterstep'}
      }
      const surface = await approachSurfaceMelee(target, context)
      if (surface) return surface
      validateHealthyMeleeApproach(requireUserLease(context), target)
      const state = requireUserLease(context), dx = state.position.x - target.position.x, dz = state.position.z - target.position.z, d = Math.hypot(dx, dz)
      if (!d) return { ready: false, reason: 'Approach direction is unknown' }
      const candidates = []
      for (const radius of [2, 1.8, 2.2]) for (const y of [...new Set([Math.round(state.position.y - 1.62), Math.floor(target.position.y), Math.floor(target.position.y) + 1])]) candidates.push({ x: target.position.x + dx / d * radius, y, z: target.position.z + dz / d * radius })
      for (const candidate of candidates) {
        if (Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z) > 6) continue
        motionOrigin = working()
        if (generationMovement.preview(candidate, { emergency: true, allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(state, target) })?.ready) return moveUserNative(candidate, context, target)
      }
      for (const candidate of candidates) {
        const range = Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z)
        if (range <= 6 || range > 12) continue
        requireUserLease(context)
        motionOrigin = working()
        const options = { emergency: true, allowWater: false, maxDistance: 12, maxExpanded: 600, avoidance: userAvoidance(state, target) }
        const route = generationMovement.preview(candidate, options)
        if (!route?.ready || !Array.isArray(route.waypoints)) continue
        const relays = route.waypoints.filter(waypoint => {
          const p = waypoint.position
          if (waypoint.medium !== 'land' || !p || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))) return false
          const distance = Math.hypot(p.x - state.position.x, p.y - state.position.y + 1.62, p.z - state.position.z)
          if (distance < 0.25 || distance > 6) return false
          // This is a passive geometry probe for a Native planned waypoint;
          // no received pose, prediction or movement receipt is rewritten.
          const probe = { ...state, position: { x: p.x, y: p.y + 1.62, z: p.z }, predicted: null, physicsState: null }
          return fullStandingGeometry(probe, p)
        }).sort((a, b) => Math.hypot(b.position.x - state.position.x, b.position.y - state.position.y + 1.62, b.position.z - state.position.z) - Math.hypot(a.position.x - state.position.x, a.position.y - state.position.y + 1.62, a.position.z - state.position.z))
        for (const relay of relays) {
          requireUserLease(context)
          motionOrigin = working()
          if (!generationMovement.preview(relay.position, { ...options, maxDistance: 6, maxExpanded: 300 })?.ready) continue
          const result = await moveUserNative(relay.position, context, target)
          return { ...result, code: 'PARTIAL_APPROACH', partialApproach: true, targetReached: false, serverConfirmed: false }
        }
      }
      const initialRange = Math.hypot(state.position.x - target.position.x, state.position.y - (target.position.y + 0.9), state.position.z - target.position.z)
      // Slopes: the straight-line step at the current feet height is buried or
      // floating on a hillside, so each step also tries standing heights a few
      // blocks up and down (nearest first).
      const feetY = Math.round(state.position.y - 1.62)
      for (const step of [5.5, 4, 2, 1]) for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const point = { x: state.position.x - dx / d * step, y: feetY + dy, z: state.position.z - dz / d * step }
        const nextRange = Math.hypot(point.x - target.position.x, point.y + 1.62 - (target.position.y + 0.9), point.z - target.position.z)
        if (nextRange >= initialRange - 0.25) continue
        requireUserLease(context)
        const probe = { ...state, position: { x: point.x, y: point.y + 1.62, z: point.z }, predicted: null, physicsState: null }
        if (!fullStandingGeometry(probe, point)) continue
        motionOrigin = working()
        if (!generationMovement.preview(point, { emergency: true, allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(state, target) })?.ready) continue
        const result = await moveUserNative(point, context, target)
        return { ...result, code: 'PARTIAL_APPROACH', partialApproach: true, targetReached: false, serverConfirmed: false }
      }
      return { ready: false, reason: 'No known bounded melee stance' }
    }
    try {
      userBehaviors = createUserBehaviors({ client: host.client, getState: () => { requireGeneration(); return lightweightUserState() }, getRawState: () => { requireGeneration(); return lightweightRawState() }, world: host.world, entities: host.entities, crafting, inventory,
        getInput: () => { requireGeneration(); if (userBehaviorSleeping || userBehaviorWakePending || generationMovement.snapshot().running) throw new Error('Native movement or actual sleep owns input'); return generationInput }, getSelfUniqueId: () => host.meta.startGame?.entity_id,
        previewHop: options => { requireGeneration(); if (motionActive()) return { ready: false, reason: 'Another native movement owns input' }; motionOrigin = working(); return generationMovement.previewHop(options) },
        startHop: options => { requireGeneration(); stopOrdinaryUserStream(); motionOrigin = working(); host.shared.motionSource = 'navigation'; return generationMovement.startHop(options) }, getMovement: () => generationMovement.snapshot(), stopHop: (reason, id) => { const m = generationMovement.snapshot(); if (currentGeneration() && m.route?.operation === 'critical_hop' && m.criticalHopId === id) generationMovement.stop(reason) },
        getClock: userClock, getBedMemory: () => structuredClone(host.shared.userBehaviorBedMemory ?? null), setBedMemory: memory => { host.shared.userBehaviorBedMemory = structuredClone(memory) },
        placeBed: (value, context) => userInteraction('placeBed', value, context), useBed: (value, context) => userInteraction('useBed', value, context), wakeBed: (value, context) => userInteraction('wakeBed', value, context), mineBed: mineUserBed,
        moveBed: (value, context) => moveUserNative(value.target, context), collectBed: (value, context) => moveUserNative({ x: value.position.x + 0.5, y: value.position.y, z: value.position.z + 0.5 }, context),
        cancelBedActions: async (reason, context) => { if (!sameLease(context)) return { cleaned: true }; mining.stop(reason); interactions.cancel(reason); if (inventory.snapshot().pendingRequestId == null) inventory.cancel(reason); generationMovement.stop(reason); stopOrdinaryUserStream(); return { cleaned: true } },
        acquireControl: acquireUserControl, resumeControl: resumeUserControl, approach: approachUserTarget, retreat: retreatUserTarget,
        rangedOptions: { log: host.log, onSelectionSent: slot => host.commitSelection(slot) },
        meleeOptions: { log: host.log },
        coordinatorOptions: { log: host.log, controlReady: ({ claimId, token }) => !(userBehaviorLease?.kind === 'combat' && userBehaviorLease.claimId === `combat:${claimId}` && userBehaviorLease.token === token && userBehaviorLease.receiptsReady === false), canAcquireMeleeApproach: (target, state) => canAcquireStuckMeleeApproach(target, state) || canAcquireHealthyMeleeApproach(target, state), canEngage: (target, state) => combatAttackExposure(target, state).intercept, engageRadius: threatReachability.ENGAGE_RADIUS, getRecentDamageAt: () => host.shared.recentDamageNoPrimary?.at ?? null, workGuard: { canSelectTarget: quarryCanSelectTarget, canContinue: quarryCanContinue } },
        // Defense remains available while work is paused; other behaviors keep
        // their original work permission. An eligible enemy preempts meals.
        canAct: ({ kind } = {}) => !resetHeld() && currentGeneration() && !replaying && host.shared.loadingScreenEnded === true && !host.shared.respawnTerrain?.pending && !userBehaviorWakePending && (kind === 'combat' ? defenseEnabled(host.shared) : !manualChestStorage?.isBusy() && !chunkMoveHeld() && !quarryPlacementPreparation && !surfaceReturnOwner && host.shared.userBehaviorsEnabled === true && (host.shared.autoWanted === true || quarryCombatArmed)),
        isBusy: context => !sameLease(context) || !userBehaviorLease?.ready || userBehaviorLease.receiptsReady === false || pendingStops.size > 0 || craftStatus().pendingRequestId != null || inventory.snapshot().busy || (furnace.snapshot().busy || chest.snapshot().busy) || food.snapshot().busy || mining.snapshot().phase === 'mining',
        // A released bow shot with no ammo delta only leaves the arrow count in
        // doubt (no arrow fired = unchanged inventory). Marking the whole
        // inventory unknown disabled every attack until a full resync and got
        // the bot killed by a zombie, so it is recorded separately.
        onUncertain: details => { if (details?.operation === 'ranged_shot') { host.shared.rangedShotUncertain = { ...details, at: new Date().toISOString() }; try { host.log(`射撃未確認: 矢の消費が確認できませんでした（持ち物は不明扱いにしません）`) } catch {} ; return } onUncertain(details) }, onProgress: value => { if (currentGeneration()) host.shared.userBehaviorProgress = { busy: value.busy, sleeping: value.sleeping, activeKind: value.activeKind, at: new Date().toISOString() } }, version: host.meta.version
      })
      userBehaviorGenerationScope = userScope(rawScope())
      if (!userBehaviorTimer) userBehaviorTimer = setInterval(() => { try { tickUserBehaviors() } catch (error) { userBehaviorError(error, 'timer') } }, 50) // one game tick: combat decisions must not lag a real-time fight
    } catch (error) { userBehaviors = null; userBehaviorError(error, 'initialise') }
    host.setCapabilities({ mining: true, movement: true, flatWalking: true, navigationPrediction: true, crafting: true, interactions: true, guardRoute: true, idleSafety: true })
  }

  function applyPacket (name, packet, { entityDangerChanged = true } = {}) {
    if (['start_game', 'change_dimension'].includes(name)) portableConstraintCache = null
    if (disposed) return
    if (!replaying) loadoutReset?.applyPacket(name, packet)
    if (!replaying && ['start_game', 'change_dimension', 'respawn', 'disconnect', 'close'].includes(name)) { selfResistance.clear(); selfSlowFalling.clear(); selfEffectEvents.clear() }
    if (!replaying && !disposing) plainsLocator?.applyPacket(name, packet)
    if (!replaying && !disposing) {
      if (name === 'command_output' && storagePlacementAudit?.snapshot().requestId === packet.origin?.uuid) host.shared.storagePlacementAuditOutput = { at: Date.now(), success_count: packet.success_count, output: (packet.output ?? []).slice(0, 1).map(value => ({ success: value.success, message_id: value.message_id, parameters: (value.parameters ?? []).slice(0, 3) })) }
      storagePlacementAudit?.applyPacket(name, packet)
    }
    if (name === 'command_output') {
      const diag = host.shared.diagCommandOutputs?.get(packet.origin?.uuid)
      if (diag) { diag.output = { at: Date.now(), success_count: packet.success_count, output: (packet.output ?? []).slice(0, 3).map(o => ({ success: o.success, message_id: o.message_id, parameters: (o.parameters ?? []).slice(0, 4) })) } }
      if (quarryPositionVerifier?.snapshot().pending) host.shared.quarryPositionOutput = { at: Date.now(), keys: Object.keys(packet), origin: packet.origin ? { type: packet.origin.type, uuid: packet.origin.uuid, request_id: packet.origin.request_id, player_entity_id: packet.origin.player_entity_id == null ? null : String(packet.origin.player_entity_id), player_entity_id_type: typeof packet.origin.player_entity_id, player_entity_id_class: packet.origin.player_entity_id?.constructor?.name } : null, output_type: packet.output_type, has_data: packet.has_data, dataType: typeof packet.data, success_count: packet.success_count, output: (packet.output ?? []).slice(0, 3).map(item => ({ success: item.success, message_id: item.message_id, parameters: (item.parameters ?? []).slice(0, 3) })) }
      quarryPositionVerifier?.applyPacket(name, packet)
      return
    }
    if (!replaying && !disposing) mining?.applyPacket?.(name, packet)
    // Host has already decoded these into World. Only the active mining
    // observer consumes whole terrain packets; the other controllers poll
    // received blocks or handle the small block-update packets below.
    if (name === 'level_chunk' || name === 'subchunk') return
    if (!replaying) logCreeperFuse(name, packet)
    if (!replaying && name === 'mob_effect') {
      if (!disposing) { selfEffectEvents.observe(packet); selfResistance.observe(packet); selfSlowFalling.observe(packet) }
      const received = raw()
      host.shared.ownDamageEffects = observeOwnDamageEffect(host.shared.ownDamageEffects, packet, { ...received, lifecycle: { phase: received.dead ? 'dead' : 'alive', deathId: actualLifeId(), dead: received.dead === true } })
    }
    if (!replaying && (name === 'set_entity_motion' && String(packet.runtime_entity_id) === String(raw().runtimeEntityId) || name === 'motion_prediction_hints' && String(packet.entity_runtime_id) === String(raw().runtimeEntityId))) userBehaviorForceRevision++
    if (!replaying && inputHistory && !userBehaviorSleeping && !userBehaviorWakePending && ['start_game', 'respawn', 'change_dimension', 'server_post_move', 'move_player', 'correct_player_move_prediction', 'set_health', 'update_attributes'].includes(name)) {
      if (stationaryRawPending && (name === 'set_health' || name === 'update_attributes' && String(packet.runtime_entity_id) === String(raw().runtimeEntityId))) completeStationaryRawHealth()
      const ownMove = name === 'move_player' && String(packet.runtime_id ?? packet.runtime_entity_id) === String(raw().runtimeEntityId)
      const ownRespawn = name === 'respawn' && packet.state === 1 && String(packet.runtime_entity_id) === String(raw().runtimeEntityId)
      const posePacket = name === 'start_game' || name === 'server_post_move' || ownMove || ownRespawn
      const received = raw(), point = name === 'start_game' ? packet.player_position : packet.position
      const exactOwnPose = posePacket && point && received.position && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]) && point[axis] === received.position[axis])
      const observedAt = typeof received.positionUpdatedAt === 'number' ? received.positionUpdatedAt : typeof received.positionUpdatedAt === 'string' ? Date.parse(received.positionUpdatedAt) : NaN
      if (['start_game', 'respawn', 'change_dimension', 'server_post_move'].includes(name) || ownMove) inputHistory.invalidate('authoritative_lifecycle_or_pose_changed', exactOwnPose ? { observedAt } : undefined)
      if (exactOwnPose) observeStationaryRaw()
      if (name === 'correct_player_move_prediction') {
        // Capture the exact correction before Movement consumes/replays it.
        // A missing tick record cannot be replaced with the current prediction.
        const correction = normalizePlayerCorrection(packet, { version: host.meta.version, lastCorrectionTick: host.shared.lastPhysicsCorrectionTick, currentInputTick: inputHistory.snapshot().latestTick ?? undefined, historyAvailable: true })
        recordMovementCorrectionPair(packet, correction)
        if (correction.accepted && correction.tick !== '0') {
          try {
            const state = raw()
            const physicsState = inputHistoryPhysics.fromServer({ ...state, position: correction.position, positionSource: 'server_correction', predicted: null }, { velocity: correction.velocity, onGround: correction.onGround })
            inputHistory.observeAnchor({ tick: correction.tick, physicsState, rawPosition: correction.position, rawStamp: state.positionUpdatedAt, scope: historyScope(state), health: state.health, receivedAt: Date.now() })
          } catch { inputHistory.invalidate('correction_anchor_unknown') }
        } else if (correction.code !== 'STALE_CORRECTION') inputHistory.invalidate('correction_anchor_unknown')
      }
    }
    if (name === 'inventory_transaction' && !replaying) {
      const update = serverInventoryUpdate(packet, { getRawItem: slot => crafting.rawItem(slot) })
      host.shared.lastInventoryUpdate = { accepted: update.accepted, phase: update.phase, code: update.code, reason: update.reason, changedSlots: update.changedSlots, oldMismatchSlots: update.oldMismatchSlots, unknownStackSlots: update.unknownStackSlots, at: new Date().toISOString() }
      if (update.accepted) {
        // Only these actual received slot writes are fresh observations. The
        // remaining 36-slot baseline is cached, so this is not a full refresh
        // and must not clear uncertainty about another in-flight request.
        host.commitInventory(update)
        for (const slot of update.changedSlots) {
          const delta = { window_id: 'inventory', slot, item: update.input[slot], source: update.source }
          crafting.applyPacket('inventory_slot', delta)
          inventoryInspection.applyPacket('inventory_slot', delta)
          furnace.applyPacket('inventory_slot', delta)
          chest.applyPacket('inventory_slot', delta, { replaying: false })
          inventory.applyPacket('inventory_slot', delta)
          food.applyPacket('inventory_slot', delta)
          interactions.applyPacket('inventory_slot', delta)
          try { userBehaviors?.applyPacket('inventory_slot', { ...delta, source: 'received_inventory_transaction' }) } catch (error) { userBehaviorError(error, 'wire_inventory_delta') }
        }
      }
    }
    if (['inventory_content', 'inventory_slot', 'take_item_entity', 'add_item_entity', 'inventory_transaction', 'item_stack_response'].includes(name) && !replaying) {
      host.shared.inventoryEvents ??= []
      const event = { name, at: new Date().toISOString(), health: raw().health, position: working().position }
      if (name === 'inventory_content') Object.assign(event, { windowId: packet.window_id, items: (packet.input ?? []).map((item, slot) => ({ slot, id: item.network_id, count: item.count })).filter(item => item.count > 0) })
      if (name === 'inventory_slot') Object.assign(event, { windowId: packet.window_id, slot: packet.slot, item: { id: packet.item?.network_id, count: packet.item?.count } })
      if (name === 'take_item_entity') Object.assign(event, { itemRuntimeId: String(packet.runtime_entity_id), targetRuntimeId: String(packet.target) })
      if (name === 'add_item_entity') Object.assign(event, { itemRuntimeId: String(packet.runtime_entity_id), item: { id: packet.item?.network_id, count: packet.item?.count }, itemPosition: packet.position })
      if (name === 'inventory_transaction') Object.assign(event, { type: packet.transaction?.transaction_type, actions: (packet.transaction?.actions ?? []).map(action => ({ type: action.source_type, windowId: action.window_id, slot: action.slot, oldCount: action.old_item?.count, newCount: action.new_item?.count, itemId: action.new_item?.network_id })) })
      if (name === 'item_stack_response') event.requests = (packet.responses ?? []).map(response => ({ id: response.request_id, status: response.status }))
      host.shared.inventoryEvents.push(event)
      if (host.shared.inventoryEvents.length > 120) host.shared.inventoryEvents.splice(0, host.shared.inventoryEvents.length - 120)
    }
    if (name === 'set_time' && Number.isSafeInteger(packet.time)) host.shared.worldTime = { ticks: packet.time, dayTime: ((packet.time % 24000) + 24000) % 24000, observedAt: new Date().toISOString(), source: 'server_set_time' }
    if (name === 'sync_world_clocks') {
      host.shared.worldClocks ??= {}
      for (const clock of packet.clocks ?? packet.sync_states ?? []) {
        const id = clock.id ?? clock.clock_id
        if (id == null || !Number.isSafeInteger(clock.time) || typeof clock.paused !== 'boolean') continue
        host.shared.worldClocks[String(id)] = { ...host.shared.worldClocks[String(id)], id: String(id), ...(typeof clock.name === 'string' ? { name: clock.name } : {}), time: clock.time, paused: clock.paused, observedAt: new Date().toISOString(), source: 'server_sync_world_clocks' }
      }
    }
    if (name === 'update_attributes' && String(packet.runtime_entity_id) === String(raw().runtimeEntityId)) {
      host.shared.vitals ??= {}
      const names = { 'minecraft:player.hunger': 'hunger', 'minecraft:player.saturation': 'saturation', 'minecraft:player.exhaustion': 'exhaustion', 'minecraft:health': 'health' }
      for (const attribute of packet.attributes ?? []) if (names[attribute.name] && Number.isFinite(attribute.current)) host.shared.vitals[names[attribute.name]] = { value: attribute.current, observedAt: new Date().toISOString(), source: 'server_attribute', ...(attribute.name === 'minecraft:player.hunger' ? { scope: foodHungerScope() } : {}) }
    }
    if (!replaying && name === 'inventory_content' && (packet.window_id === 'inventory' || packet.window_id === 0)) observeInventoryResync(packet)
    if (!replaying && name === 'inventory_content' && (packet.window_id === 'inventory' || packet.window_id === 0)) host.shared.inventoryUncertain = null
    if (!replaying) {
      const life = rawFields(['health', 'dead', 'isDead'])
      if (name === 'death_info' || life.health === 0 || life.dead || life.isDead) host.shared.initialLifeDeathKey = inventoryLifeBaseKey(rawScope())
    }
    crafting.applyPacket(name, packet)
    inventoryInspection.applyPacket(name, packet, { replaying })
    furnace.applyPacket(name, packet)
    chest.applyPacket(name, packet, { replaying })
    inventory.applyPacket(name, packet, { replaying })
    if (!replaying) quarryV22Equipment.applyPacket(name, packet)
    if (!replaying) {
      // An owned close may finish between behavior reload and the next button
      // click. Preserve that actual response for the connection-owned barrier.
      if (!manualChestStorage && host.shared.manualChestCloseBarrier && ['container_open', 'container_close'].includes(name)) ensureManualChestStorage()
      manualChestStorage?.applyPacket(name, packet)
    }
    // A reload replays the cached start_game; that is not a new world for armor.
    if (!(replaying && ['start_game', 'change_dimension', 'respawn'].includes(name))) armor.applyPacket(name, packet)
    food.applyPacket(name, packet)
    interactions.applyPacket(name, packet)
    combat?.applyPacket(name, packet)
    walker?.applyPacket(name, packet)
    const movementPacket = movement?.applyPacket(name, packet)
    if (name === 'correct_player_move_prediction' && movementPacket?.replayed === true) {
      host.shared.lastPhysicsCorrectionTick = movementPacket.correctionTick
      host.shared.lastServerCorrection = { ...normalizePlayerCorrection(packet, { version: host.meta.version, currentInputTick: movementPacket.currentTick, historyAvailable: true }), receivedAt: new Date().toISOString(), replayedToTick: movementPacket.currentTick }
      idlePhysicsState = null
    }
    if (name === 'correct_player_move_prediction' && movementPacket?.replayed !== true && idlePhysics && !working().dead && !userBehaviorSleeping && !userBehaviorWakePending) {
      const correction = normalizePlayerCorrection(packet, { version: host.meta.version, lastCorrectionTick: host.shared.lastPhysicsCorrectionTick, historyAvailable: false })
      if (correction.accepted && correction.maySeedNow) {
        if (correction.tick !== '0') host.shared.lastPhysicsCorrectionTick = correction.tick
        host.shared.lastServerCorrection = { ...correction, receivedAt: new Date().toISOString() }
        if (!host.shared.respawnTerrain?.pending) {
          const state = { ...working(), position: correction.position, positionSource: 'server_correction', predicted: null }
          const physicsState = idlePhysics.fromServer(state, { velocity: correction.velocity, onGround: correction.onGround })
          publishControlPrediction({ position: correction.position, feetPosition: physicsState.position, velocity: correction.velocity, onGround: correction.onGround, physicsState, serverCorrection: correction, serverConfirmed: false }, 'server_physics_rebase')
        }
        idlePhysicsState = null
      }
    }
    if (['set_entity_motion', 'motion_prediction_hints'].includes(name) && idlePhysics && !working().dead && !userBehaviorSleeping && !userBehaviorWakePending) {
      host.shared.motionArrivalSequence = (host.shared.motionArrivalSequence ?? 0) + 1
      const motion = normalizeServerMotion(name, packet, { ownRuntimeId: raw().runtimeEntityId, version: host.meta.version, lastMotionTick: host.shared.lastMotionTick, historyAvailable: false, arrivalSequence: host.shared.motionArrivalSequence, lastHintSequence: host.shared.lastHintSequence })
      if (motion.accepted && motion.maySeedNow) {
        inputHistory?.invalidate('server_motion_changed')
        if (motion.nextMotionTick != null) host.shared.lastMotionTick = motion.nextMotionTick
        if (motion.nextHintSequence != null) host.shared.lastHintSequence = motion.nextHintSequence
        host.shared.lastServerMotion = { ...motion, receivedAt: new Date().toISOString() }
        if (host.shared.respawnTerrain?.pending) return
        mining.stop('サーバーから速度の変更を受信しました。')
        walker?.stop('サーバーから速度の変更を受信しました。')
        movement?.stop('サーバーから速度の変更を受信したため再計画します。')
        const state = working()
        const physicsState = idlePhysics.fromServer(state)
        physicsState.velocity = { ...motion.velocity }
        physicsState.velocitySource = motion.source
        if (Object.hasOwn(motion, 'onGround')) physicsState.onGround = motion.onGround
        publishControlPrediction({ position: state.position, feetPosition: physicsState.position, velocity: motion.velocity, onGround: physicsState.onGround, physicsState, serverMotion: motion, serverConfirmed: false }, 'server_motion_rebase')
        idlePhysicsState = null
      }
    }
    // Host has already applied these server observations to state and entities.
    // Abort an owned leaf break on the same packet turn instead of waiting for
    // the next periodic safety check when a hostile approaches or damage lands.
    if (['move_entity', 'move_entity_delta', 'move_player', 'add_entity', 'add_player', 'remove_entity', 'entity_event', 'set_entity_data', 'update_attributes', 'set_health', 'change_dimension'].includes(name)) { inspectEmergencyLeafPacket?.(); inspectPartialEscapePacket?.() }
    if (name === 'set_entity_data' && entityDangerChanged) inspectIdleEscapePacket?.()
    if (!replaying) {
      try { userBehaviors?.applyPacket(name, packet); synchronizeUserSleep() } catch (error) { userBehaviorError(error, 'wire_packet') }
      const receivedState = raw()
      if (receivedState.dead || receivedState.isDead || receivedState.health === 0) clearNavigationDestination()
      if (userBehaviorWakePending && !userBehaviorSleeping && receivedState.positionUpdatedAt !== userBehaviorSleepStamp && ['move_player', 'server_post_move', 'correct_player_move_prediction', 'respawn'].includes(name)) { userBehaviorWakePending = false; userBehaviorSleepWitness = null; idlePhysicsState = null; motionOrigin = null; observeStationaryRaw(); void Promise.resolve(resumeRequested()).catch(error => userBehaviorError(error, 'wake_resume')) }
      const observed = raw(), intent = navigationDestination(observed)
      if (intent && observed.position && observed.positionSource !== 'client_prediction' && Math.hypot(observed.position.x - intent.position.x, observed.position.z - intent.position.z) <= 0.4 && Math.abs(observed.position.y - 1.62 - intent.position.y) <= 0.15) clearNavigationDestination()
    }
  }
  function stopActions (reason) {
    if (resetHeld()) {
      const s = raw()
      // The explicit debug reset owns all inputs. A nonfatal hit must not
      // cancel its acknowledged inventory transfers or re-arm combat.
      if (!disposed && !disposing && reason === 'ダメージを検知しました。' && s.phase === 'spawned' && s.health > 0 && !s.dead && !s.isDead && !s.spawnPending && !s.lifecycle?.dead) return Promise.resolve([])
      loadoutReset?.cancel()
    }
    return stopActionsAfterRaw(reason)
  }
  function stopActionsAfterRaw (reason, confirmedRespawn = null) {
    cancelChunkMovement(reason ?? 'CHUNK_MOVE_INTERRUPTED')
    manualChestStorage?.cancel(reason ?? 'STORAGE_INTERRUPTED')
    manualShulkerAbort?.abort(new Error(reason ?? 'SHULKER_RECOVERY_INTERRUPTED'))
    manualShulkerRecovery?.cancel(reason ?? 'SHULKER_RECOVERY_INTERRUPTED')
    const receiptState = raw()
    quarryEgressAbort?.abort(new Error(reason ?? 'EGRESS_INTERRUPTED'))
    quarryPillar?.cancel(reason ?? 'ASCENT_INTERRUPTED')
    quarryPositionVerifier?.cancel(reason ?? 'POSITION_QUERY_INTERRUPTED')
    storagePlacementAudit?.cancel(reason ?? 'STORAGE_AUDIT_INTERRUPTED')
    plainsLocator?.cancel()
    if (reason === 'ダメージを検知しました。' && !disposed && !disposing) {
      const damage = bindRecentDamage({ ...receiptState, lifecycle: { phase: receiptState.dead ? 'dead' : 'alive', deathId: actualLifeId(), dead: receiptState.dead === true } })
      if (damage) host.shared.recentDamageNoPrimary = damage
    }
    const keepUserCombat = !disposing && !disposed && reason === 'ダメージを検知しました。' && receiptState.phase === 'spawned' && !receiptState.dead && !receiptState.isDead && receiptState.health > 0 && (userBehaviorLease?.kind === 'combat' || userBehaviorSnapshot().claim?.kind === 'combat')
    if (keepUserCombat && userBehaviorLease?.ready) {
      // Combat's own approach/sight move is re-validated by combat on every
      // poll; stopping it on each hit (a witch's poison ticks every second)
      // aborted every approach and the bot never closed in (live 2026-11-05).
      const phase = (() => { try { return userBehaviorSnapshot().combat?.phase ?? null } catch { return null } })()
      if (!['approaching', 'repositioning'].includes(phase)) { movement?.stop(reason); walker?.stop(reason) }
      return Promise.resolve([])
    }
    let userCleanup = null
    if (!keepUserCombat) { try { userBehaviors?.cancel(reason, receiptState.dead || receiptState.health === 0 ? 'NOT_ALIVE' : 'CANCELLED'); userCleanup = userBehaviors?.drain() } catch (error) { userBehaviorError(error, 'cancel') } }
    const exactRespawn = confirmedRespawn?.serverConfirmed === true && confirmedRespawn.health > 0 && confirmedRespawn.health === receiptState.health && receiptState.phase === 'spawned' && !receiptState.dead && confirmedRespawn.position && receiptState.position && ['x', 'y', 'z'].every(axis => Number.isFinite(confirmedRespawn.position[axis]) && confirmedRespawn.position[axis] === receiptState.position[axis])
    const observedAt = typeof receiptState.positionUpdatedAt === 'number' ? receiptState.positionUpdatedAt : typeof receiptState.positionUpdatedAt === 'string' ? Date.parse(receiptState.positionUpdatedAt) : NaN
    inputHistory?.invalidate(exactRespawn ? 'authoritative_respawn_cleanup' : 'actions_cancelled', exactRespawn ? { observedAt } : undefined)
    publishWalker()
    // Damage stops the current movement, while its bounded recovery supervisor
    // must remain alive to replan from the correction and new health. Explicit
    // stop, death and reload still cancel the entire recovery operation.
    const recoveryCleanup = reason === 'ダメージを検知しました。' ? null : recovery?.stop(reason)
    const current = raw()
    const keepEngagement = !disposing && !disposed && reason === 'ダメージを検知しました。' && combat?.snapshot().engaging && current.phase === 'spawned' && !current.dead && !current.isDead && Number.isFinite(current.health) && current.health > 6
    const combatCleanup = keepEngagement ? null : combat?.drain()
    const keepGuardRoute = !disposing && !disposed && reason === 'ダメージを検知しました。' && current.phase === 'spawned' && !current.dead && !current.isDead && Number.isFinite(current.health) && current.health > 0
    const guardCleanup = keepGuardRoute ? null : guardRoute?.stop(reason)
    const keepSafety = !disposing && !disposed && reason === 'ダメージを検知しました。' && current.phase === 'spawned' && !current.dead && !current.isDead && Number.isFinite(current.health) && current.health > 0
    if (!keepSafety) safetyDispatchEpoch++
    const safetyCleanup = keepSafety ? null : idleSafety?.stop(reason)
    const cleanup = Promise.allSettled([quarryPillarTask, quarryEgressTask, userCleanup, safetyCleanup, keepSafety ? null : idleSafety?.drain(), excavation?.stop(reason), tunneling?.stop(reason), recoveryCleanup, foraging?.stop(reason), surfaceReturn?.stop(reason), shelter?.stop(reason), hut?.stop(reason), combatCleanup, guardCleanup])
    pendingStops.add(cleanup)
    cleanup.finally(() => pendingStops.delete(cleanup))
    mining.stop(reason)
    walker?.stop(reason)
    movement?.stop(reason)
    if (!keepEngagement) input?.stop()
    crafting.cancel(reason)
    furnace.cancel(reason)
    chest.cancel(reason)
    surfaceReturn?.cancel(reason)
    depotPrebuild?.cancel(reason); depotBuilder?.stop(reason); depotStorage?.cancel(reason)
    prospecting.cancel(reason)
    inventory.cancel(reason)
    // Damage with no hostile close (starvation, a stray arrow) must not cancel a
    // meal: eating is what stops starvation, and cancelling it looped to death.
    if (!(reason === 'ダメージを検知しました。' && food.snapshot().busy && nearestHostileDistance() > 6)) food.cancel(reason)
    interactions.cancel(reason)
    if (!keepEngagement) combat?.cancel(reason)
    publishWalker()
    return cleanup
  }
  function hostRespawnScope (state,life) {
    if(!Number.isSafeInteger(life)||life<1||Number.isSafeInteger(state?.lifecycle?.deathId)&&state.lifecycle.deathId!==life)return null
    return continuationScope({...state,profile:state.profile??host.meta.profile,lifecycle:{...(state.lifecycle??{}),phase:state.lifecycle?.phase??'alive',deathId:life}})
  }
  function rememberHostRespawnReceipt (confirmed) {
    const state=raw(),request=host.shared.deathRespawn,scope=hostRespawnScope(state,confirmed?.deathId),at=Date.now()
    if(disposed||disposing||confirmed?.phase!=='alive'||confirmed.serverConfirmed!==true||!scope||request?.deathId!==confirmed.deathId||request.connectionId!==state.connectionId||!(Number.isFinite(confirmed.health)&&confirmed.health>0)||confirmed.health!==state.health||!confirmed.position||!state.position||['x','y','z'].some(k=>!Number.isFinite(confirmed.position[k])||confirmed.position[k]!==state.position[k])||!['respawn','move_player','correct_player_move_prediction','server_post_move','change_dimension'].includes(confirmed.positionSource)||Date.parse(scope.startedAt)>at)return
    host.shared.hostRespawnReceipt={version:1,source:'host_on_respawn',scope,at:new Date(at).toISOString(),phase:confirmed.phase,serverConfirmed:true,health:confirmed.health,position:{...confirmed.position},positionSource:confirmed.positionSource}
  }
  function currentHostRespawnReceipt () {
    const state=raw(),request=host.shared.deathRespawn,receipt=host.shared.hostRespawnReceipt,scope=hostRespawnScope(state,request?.deathId),at=Date.parse(receipt?.at)
    if(disposed||disposing||host.shared.respawnTerrain?.pending||!scope||request.connectionId!==state.connectionId||receipt?.version!==1||receipt.source!=='host_on_respawn'||receipt.phase!=='alive'||receipt.serverConfirmed!==true||!Number.isFinite(at)||at<Date.parse(scope.startedAt)||at>Date.now()||!receipt.scope||Object.keys(scope).some(k=>receipt.scope[k]!==scope[k])||!Number.isFinite(receipt.health)||receipt.health<=0||!receipt.position||['x','y','z'].some(k=>!Number.isFinite(receipt.position[k])))return null
    return receipt
  }
  function movementKnownLife () {
    const state=raw(),r=host.shared.deathRespawn
    if(Number.isSafeInteger(r?.deathId)&&r.deathId>=0&&r.connectionId===state.connectionId&&r.phase==='confirmed'&&r.serverConfirmed===true)return r.deathId
    const confirmed=currentHostRespawnReceipt()
    if(confirmed)return confirmed.scope.life
    if(verifiedInitialLifeReceipt())return 0
    return hostStatusLife(state)
  }
  // A Host /status receipt for this exact connection/entity/dimension names the
  // life the Host itself tracks. Any later death updates deathRespawn first, so
  // a receipt whose life differs from that record is never used.
  function hostStatusLife (state=raw()) {
    const receipt=host.shared.inventoryLifeReceipt,r=host.shared.deathRespawn,started=Date.parse(state.startedAt)
    if(disposed||disposing||receipt?.source!=='host_status_get'||!Number.isSafeInteger(receipt.deathId)||receipt.deathId<0||receipt.key!==inventoryLifeBaseKey(state)||!Number.isFinite(receipt.observedAt)||!Number.isFinite(started)||receipt.observedAt<started||receipt.observedAt>Date.now()||host.shared.loadingScreenEnded!==true||host.shared.respawnTerrain?.pending)return null
    if(r!=null&&(r.deathId!==receipt.deathId||r.connectionId!==state.connectionId||Date.parse(r.at)>receipt.observedAt))return null
    if(state.phase!=='spawned'||state.dead||state.isDead||state.lifecycle?.dead||state.spawnPending||!(Number.isFinite(state.health)&&state.health>0))return null
    return receipt.deathId
  }
  async function ensureMovementLifeKnown () {
    if(movementKnownLife()!=null)return true
    try{await prepareInventoryLifeReceipt()}catch{ /* reported below as an unknown life */ }
    return movementKnownLife()!=null
  }
  function normalWaterMovementOptions (options, { combatAware = false } = {}) {
    if(options?.allowWater!==true||options.beforeInput!=null)return options
    const initial=lightweightUserState();initial.lifecycle={...initial.lifecycle,deathId:movementKnownLife()};const scope=continuationScope(initial),controller=movement,generation=inputHistoryGeneration,serial=portableMovementSerial,force=userBehaviorForceRevision
    if(!scope||!controller||!idlePhysics)throw Object.assign(new Error(!scope?'Botの生存状態をまだ確認できていません。数秒待ってからもう一度お試しください。':'移動の準備ができていません。数秒待ってからもう一度お試しください。'),{code:!scope?'MOVE_LIFE_UNKNOWN':'MOVE_NOT_READY'})
    let previous={...initial.position}
    return {...options,continueAfterReplay:options.continueAfterReplay??true,beforeInput:frame=>{
      const current=lightweightUserState();current.lifecycle={...current.lifecycle,deathId:movementKnownLife()};const p=frame?.packetPosition,n=frame?.predictedState
      if(disposed||disposing||movement!==controller||inputHistoryGeneration!==generation||portableMovementSerial!==serial||userBehaviorForceRevision!==force||controller.snapshot().phase!=='moving'||JSON.stringify(continuationScope(current))!==JSON.stringify(scope)||current.health<initial.health||current.entityStats?.unknownPositions!==0||!p||!n?.position||!['x','y','z'].every(k=>Number.isFinite(p[k])&&Number.isFinite(n.position[k]))||Math.hypot(p.x-n.position.x,p.y-n.position.y-1.62,p.z-n.position.z)>1e-4||n.isInLava)return false
      const risk=evaluateThreats(current,current.entities,{observationRadius:32})
      if (combatAware) {
        if (!chunkTravelThreatsClear({ state: current, previous, next: p, risk, attackExposure: combatAttackExposure })) return false
      } else {
        if(risk.requiresObservation||risk.threats.length)return false
        for(const a of [...risk.outsideDanger,...risk.suppressedByTerrain]){
        if(!current.entities.some(e=>String(e.runtimeId)===a.runtimeId&&e.uniqueId!=null&&/^-?\d+$/.test(String(e.uniqueId))&&String(e.uniqueId)!=='0'&&e.entityType===a.name&&e.dimension===current.dimension&&e.positionKnown===true&&e.position&&['x','y','z'].every(k=>Number.isFinite(e.position[k]))))return false
        const q=a.position,dx=p.x-previous.x,dy=p.y-previous.y,dz=p.z-previous.z,den=dx*dx+dy*dy+dz*dz,t=den?Math.max(0,Math.min(1,((q.x-previous.x)*dx+(q.y-previous.y)*dy+(q.z-previous.z)*dz)/den)):0
        if(Math.hypot(previous.x+t*dx-q.x,previous.y+t*dy-q.y,previous.z+t*dz-q.z)<a.dangerRadius-1e-4)return false
        }
      }
      try{for(let x=Math.floor(n.position.x-.3+1e-6);x<=Math.floor(n.position.x+.3-1e-6);x++)for(let z=Math.floor(n.position.z-.3+1e-6);z<=Math.floor(n.position.z+.3-1e-6);z++)for(let y=Math.floor(n.position.y+1e-6);y<=Math.floor(n.position.y+1.8-1e-6);y++){
        const b=idlePhysics.blockAt({x,y,z});if(!b||b.known===false||['lava','flowing_lava','fire','soul_fire','magma','magma_block','cactus'].includes(String(b.name).replace(/^minecraft:/,''))||!Array.isArray(b.shapes))return false
        for(const box of b.shapes)if(n.position.x+.3>x+box[0]+1e-4&&n.position.x-.3<x+box[3]-1e-4&&n.position.z+.3>z+box[2]+1e-4&&n.position.z-.3<z+box[5]-1e-4&&n.position.y+1.8>y+box[1]+1e-4&&n.position.y<y+box[4]-1e-4)return false
      }}catch{return false}
      previous={...p};return true
    }}
  }
  function startMotion (type, target, options) {
    const started = performance.now(), timing = { at: Date.now(), type, ownerAtEntry: inputOwner, idleRunningAtEntry: inputStream?.stats().running === true, phasesMs: {}, outcome: 'preparing' }
    host.shared.movementHandoffTiming = timing
    const cursor = () => { try { const value = inputHistory?.snapshot().cursor; return value ? { tick: String(value.tick), queuedAt: value.queuedAt, ageMs: Date.now() - value.queuedAt } : null } catch (error) { return { error: String(error.message ?? error).slice(0, 120) } } }
    timing.entryCursor = cursor()
    let mark = started
    const phase = name => { const current = performance.now(); timing.phasesMs[name] = current - mark; mark = current }
    try {
      if(options?.rememberDestination===false)requireTransientWorkLease(options.transientLeaseId)
      if (options?._portableMovementLease != null) portableMovementOptions(target, options)
      requireIdle({ inventoryRequired: false }); phase('requireIdle')
      crafting.closeContainer(); phase('closeGui')
      stopIdleStream(); phase('stopIdle'); timing.ownerAfterStop = inputOwner
      idlePhysicsState = null
      motionOrigin = working(); phase('origin')
      if (options?._portableMovementLease == null) yieldPortableMovement()
      else if (type !== 'navigation') throw portablePolicyError('unexpected portable movement type')
      portableMovementSerial++
      host.shared.motionSource = type === 'navigation' ? 'navigation' : 'flat_walk'
      if (type === 'navigation') {
        if (!movement) throw new Error('経路移動の初期化を待ってください。')
        if (chunkMoveDepth === 0 && options?.rememberDestination!==false && !recoveryMotionDepth && !userBehaviorLease && !(ownedCall && options?.emergency === true)) rememberNavigationDestination(target)
        phase('destination'); timing.beforeStartCursor = cursor()
        let result
        let preparedPortableOptions
        if (chunkMoveDepth > 0) {
          const owner = chunkMoveLease, controllerGuard = options?.beforeInput, baseOptions = { ...options }
          delete baseOptions.beforeInput
          const ordinary = normalWaterMovementOptions(portableMovementOptions(target, baseOptions), { combatAware: true }), ordinaryGuard = ordinary.beforeInput
          preparedPortableOptions = { ...ordinary, beforeInput: frame => {
            if (!owner || chunkMoveLease !== owner || owner.signal?.aborted || disposed || disposing) return false
            if (controllerGuard && controllerGuard(frame) === false) return false
            return ordinaryGuard ? ordinaryGuard(frame) !== false : true
          } }
        } else preparedPortableOptions = normalWaterMovementOptions(portableMovementOptions(target, options))
        portableMovementOwner = options?._portableMovementLease ?? null
        if (portableMovementLease?.id === portableMovementOwner) { portableMovementLease.startedMovement = movement; portableMovementLease.startedSerial = portableMovementSerial }
        try { result = movement.start(target, preparedPortableOptions) } finally { phase('movementStart') }
        timing.outcome = 'started'; return result
      }
      if (!walker) throw new Error('歩行の初期化を待ってください。')
      const result = walker.start(target); phase('walkerStart'); timing.outcome = 'started'; return result
    } catch (error) { timing.outcome = 'failed'; timing.error = String(error.message ?? error).slice(0, 200); throw error } finally { timing.elapsedMs = performance.now() - started; timing.exitCursor = cursor() }
  }

  function getRegisteredQuarryHomeSite () {
    if (host.shared.quarryV22HomeChest) return structuredClone(host.shared.quarryV22HomeChest)
    try {
      const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto')
      const state = quarryState()
      const key = createHash('sha256').update(JSON.stringify([state.profile, String(state.realm?.id), state.dimension])).digest('hex')
      const record = JSON.parse(fs.readFileSync(path.join(__dirname,'..','.local','loadout-reset-v22',key+'.json'),'utf8'))
      if (record?.phase !== 'completed' || record.serverConfirmed !== true || record.world !== JSON.stringify([state.profile,String(state.realm?.id),state.dimension]) || !record.home?.position) return null
      host.shared.quarryV22HomeChest = structuredClone(record.home)
      return structuredClone(record.home)
    } catch { return null }
  }
  const operations = {
    loadout: { preview: input => { requireIdle({ loadoutHandoff: true }); return ensureLoadoutReset().prepare({ area: normalizeChunkArea(input?.area) }) },
      start: input => { requireIdle({ loadoutHandoff: true }); return ensureLoadoutReset().start({ ...input, area: normalizeChunkArea(input?.area) }) },
      status: () => loadoutReset?.status() ?? { busy: false, phase: 'idle' }, cancel: () => loadoutReset?.cancel() ?? { busy: false, phase: 'idle' } },
    shulkerRecovery: {
      load: id => loadManualShulkerRecovery(id),
      run: () => runManualShulkerRecovery(),
      status: () => ({ ...(manualShulkerRecovery?.snapshot() ?? { busy: false }), document: structuredClone(manualShulkerDocument) }),
      cancel: reason => { manualShulkerAbort?.abort(new Error(reason ?? 'MANUAL_STOP')); manualShulkerRecovery?.cancel(reason ?? 'MANUAL_STOP'); return manualShulkerTask ?? Promise.resolve(manualShulkerRecovery?.snapshot() ?? { busy: false }) }
    },
    quarry: {
      moveToChunk: input => ensureChunkTravel().start({ area: normalizeChunkArea(input?.area) }),
      cancelChunkMove: operationId => {
        if (!operationId || chunkTravel?.status().operationId !== operationId) throw Object.assign(new Error('移動操作が変わりました。状態を更新してください。'), { code: 'STALE_CHUNK_MOVE' })
        return cancelChunkMovement('MANUAL_STOP')
      },
      chunkMoveStatus: () => chunkTravel?.status() ?? { available: true, busy: false, phase: 'idle', operationId: null, serverConfirmed: false },
      controlPosition: () => controlLocation.snapshot(),
      confirmControlPosition: (area, options) => controlLocation.confirm(null, { ...options, area: normalizeChunkArea(area), radius: 0.12, operationId: 'dashboard_area_position' }),
      plan: config => {
        if (!quarryJob?.holdsWork()) requireIdle()
        const input=structuredClone(config??{})
        const registered=getRegisteredQuarryHomeSite()
        const view=receivedEquipmentView(inventoryInspection,crafting,quarryState())
        const empty=section=>section?.known===true&&Array.isArray(section.slots)&&section.slots.every(slot=>slot?.known===true&&slot.empty===true&&slot.count===0)
        const emptyBot=view.known===true&&!view.uncertain&&view.slots?.length===36&&empty(view)&&view.armor?.slots?.length===4&&empty(view.armor)&&view.offhand?.slots?.length===1&&empty(view.offhand)
        const explicit=input.initialLoadout==='v22'
        if (explicit && (!registered || input.homeChest && ['position','other','stand','stage'].some(part=>['x','y','z'].some(axis=>input.homeChest[part]?.[axis]!==registered[part]?.[axis])))) {
          throw Object.assign(new Error('初期セットの登録済みチェストを確認してください。'),{code:'LOADOUT_SOURCE_NOT_REGISTERED'})
        }
        if (registered && (explicit || input.homeChest==null&&emptyBot)) {
          input.homeChest=registered
          input.initialLoadout='v22'
          input.inventory={...input.inventory,supplyLayout:'v22'}
        } else if (input.homeChest == null && (input.inventory?.depositWhen == null || input.inventory.depositWhen === 'four_layers')) {
          input.homeChest=registered
        }
        return ensureQuarryJob().plan(input)
      },
      start: () => { requireIdle(); return ensureQuarryJob().start() },
      resume: () => { requireIdle(); return ensureQuarryJob().resume() },
      retryPersistence: () => ensureQuarryJob().retryPersistence(),
      configureExit: options => ensureQuarryJob().configureExit(options ?? {}),
      configureTools: options => ensureQuarryJob().configureTools(options ?? {}),
      configureStorage: options => ensureQuarryJob().configureStorage(options ?? {}),
      configureDirtSupply: options => ensureQuarryJob().configureDirtSupply(options ?? {}),
      configureAnimalClearing: options => ensureQuarryJob().configureAnimalClearing(options ?? {}),
      acceptCarriedStorageLoss: options => ensureQuarryJob().acceptCarriedStorageLoss(options ?? {}),
      // Manual selective storage into a large chest within reach (2026-11-13 user
      // request): cargo boxes and loose items go in; supply boxes, tools, worn
      // armour, the totem and food stay. Only while no quarry job is running.
      storeToChest: async (options = {}) => {
        const doc = quarryJob?.document?.()
        if (doc && !['FINISHED', 'PAUSED', 'IDLE', 'CANCELLED'].includes(doc.state)) throw new Error('露天掘りの実行中は収納できません。')
        const p = options?.position
        if (!p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) || Object.keys(options).some(k => !['position', 'all'].includes(k))) throw new Error('storeToChest accepts { position: {x,y,z}, all?: true } of a large chest')
        const operationId = 'manual-store:' + new Date().toISOString().replace(/[:.]/g, '-')
        const file = require('node:path').join(process.cwd(), '.local', 'manual-chest-deposit', operationId.replace(':', '-') + '.json')
        require('node:fs').mkdirSync(require('node:path').dirname(file), { recursive: true })
        const save = cp => require('node:fs').writeFileSync(file, JSON.stringify(cp, null, 1))
        const { FINAL_CHEST_KEEP } = require('./quarry-job')
        ensureQuarryJob()
        if (!quarrySurfaceChestRunner) throw new Error('収納の準備ができていません。')
        // all: true stores the gear too (2026-11-13 18:17 user request).
        const result = await quarrySurfaceChestRunner('depositAll', { jobId: doc?.config?.jobId ?? 'manual', operationId, position: { x: p.x, y: p.y, z: p.z }, checkpoint: null, ...(options.all === true ? {} : { keep: FINAL_CHEST_KEEP }) }, { onCheckpoint: async cp => save(cp) })
        save({ ...(result.checkpoint ?? {}), result: { status: result.status, reason: result.reason ?? null, serverConfirmed: result.serverConfirmed } })
        host.log(`手動収納（選択）: ${result.status} ${result.reason ?? ''} 記録 ${file}`)
        return { status: result.status, reason: result.reason ?? null, serverConfirmed: result.serverConfirmed, stored: (result.checkpoint?.receipts ?? []).filter(r => /deposit/.test(r.kind)).reduce((n, r) => n + (r.count ?? 0), 0), stacks: (result.checkpoint?.receipts ?? []).length, record: file }
      },
      configureCargoLossAcceptance: options => ensureQuarryJob().configureCargoLossAcceptance(options ?? {}),
      configureSpareArmor: options => ensureQuarryJob().configureSpareArmor(options ?? {}),
      requestTerrain: () => { const doc = ensureQuarryJob().document(); if (!doc) throw new Error('No quarry job'); return requestQuarryTerrain({ config: doc.config, yTop: doc.yTop, yBottom: doc.config.yBottom }) },
      confirmPosition: (feet, options) => confirmQuarryPosition(feet, options),
      positionStatus: () => ({ ...(quarryPositionVerifier?.snapshot() ?? { busy: false }), lastOutput: structuredClone(host.shared.quarryPositionOutput ?? null) }),
      pillarStatus: () => quarryPillar?.snapshot() ?? { busy: false, phase: 'unavailable' },
      pillarContext: () => {
        const state = quarryState()
        return { phase: state.phase, health: state.health, position: state.position, rawServerPosition: state.rawServerPosition, rawServerPositionUpdatedAt: state.rawServerPositionUpdatedAt, connectionId: state.connectionId, startedAt: state.startedAt, lifecycle: state.lifecycle, inventory: state.inventory, heldItem: state.heldItem, selectedSlot: state.selectedSlot, protectionBusy: idleSafety?.snapshot().busy === true, userControlBusy: userBehaviorOwns(), loadingScreenEnded: host.shared.loadingScreenEnded === true }
      },
      testPillar: options => testQuarryPillar(options ?? {}),
      storeCarried: options => { requireIdle(); return ensureQuarryJob().storeCarriedNow(options ?? {}) },
      configureSupplies: options => { requireIdle(); return ensureQuarryJob().configureSupplies(options ?? {}) },
      restockSuppliesNow: () => { requireIdle(); return ensureQuarryJob().restockSuppliesNow() },
      reconcileSupplyPlacement: () => { requireIdle({ inventoryRequired: false }); return ensureQuarryJob().reconcileSupplyPlacement() },
      reconcileCarriedPlacement: () => { requireIdle({ inventoryRequired: false }); return ensureQuarryJob().reconcileCarriedPlacement() },
      reconcileCurrentStoragePlacement: () => { requireIdle({ inventoryRequired: false }); return ensureQuarryJob().reconcileCurrentStoragePlacement() },
      currentPlacementAuditStatus: () => ({ ...(storagePlacementAudit?.snapshot() ?? {}), lastOutput: structuredClone(host.shared.storagePlacementAuditOutput ?? null) }),
      reconcileRejectedStorage: () => { requireIdle({ inventoryRequired: false }); return ensureQuarryJob().reconcileRejectedStorage() },
      reconcileObservedStoragePlacement: () => { requireIdle({ inventoryRequired: false }); return ensureQuarryJob().reconcileObservedStoragePlacement() },
      acceptExceptions: () => ensureQuarryJob().acceptExceptions(),
      reopenWorkLayer: options => ensureQuarryJob().reopenWorkLayer(options ?? {}),
      recordDebugAction: options => ensureQuarryJob().recordDebugAction(options ?? {}),
      pause: () => { cancelQuarryRestore(); cancelChunkMovement('QUARRY_PAUSE'); return quarryJob ? quarryJob.pause('MANUAL_PAUSE') : quarrySnapshot() },
      emergencyStop: () => { cancelQuarryRestore(); cancelChunkMovement('EMERGENCY_STOP'); return quarryJob ? quarryJob.emergencyStop() : quarrySnapshot() },
      cancel: () => { cancelQuarryRestore(); cancelChunkMovement('QUARRY_CANCEL'); return quarryJob ? quarryJob.cancel() : quarrySnapshot() },
      load: jobId => loadQuarryFile(jobId),
      status: () => quarrySnapshot(),
      document: () => quarryJob?.document() ?? structuredClone(host.shared.quarryDocument ?? null)
    },
    storage: {
      prepare: options => ensureManualChestStorage().prepare(options ?? {}),
      start: options => ensureManualChestStorage().start(options ?? {}),
      status: () => manualChestStorage?.status() ?? { available: true, busy: false, phase: 'idle', operationId: null, serverConfirmed: false, target: null, transferredStacks: 0, remainingStacks: null, error: null },
      diagnostics: () => ensureManualChestStorage().diagnostics(),
      retryClose: () => ensureManualChestStorage().retryClose(),
      cancel: reason => manualChestStorage?.cancel(reason ?? 'MANUAL_STOP') ?? { available: true, busy: false, phase: 'idle' },
      drain: () => manualChestStorage?.drain() ?? Promise.resolve()
    },
    userBehaviors: {
      start: () => { if (disposed || disposing) throw new Error('Runtime is reloading'); host.shared.combatDefenseWanted = true; host.shared.userBehaviorsEnabled = true; tickUserBehaviors(); return userBehaviorSnapshot() },
      stop: async reason => { host.shared.combatDefenseWanted = false; host.shared.combatDefenseAnchor = null; host.shared.userBehaviorsEnabled = false; userBehaviors?.cancel(reason ?? 'manual_user_behavior_stop', 'CANCELLED'); await userBehaviors?.drain(); return userBehaviorSnapshot() },
      tick: () => { tickUserBehaviors(); return userBehaviorSnapshot() }, snapshot: userBehaviorSnapshot
    },
    safety: {
      start: (options = {}) => {
        if (disposed || disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'lowHealthRecoveryMs') || options.lowHealthRecoveryMs !== undefined && (!Number.isSafeInteger(options.lowHealthRecoveryMs) || options.lowHealthRecoveryMs < 0 || options.lowHealthRecoveryMs > 60000)) throw new Error('低体力回復の待機時間が不正です。')
        if (options.lowHealthRecoveryMs && idleSafety?.snapshot().running) throw new Error('保護動作中に低体力回復の期限は変更できません。')
        if (options.lowHealthRecoveryMs) host.shared.safetyRecoveryDeadline = Date.now() + options.lowHealthRecoveryMs
        else if (!host.shared.safetyWanted) host.shared.safetyRecoveryDeadline = 0
        if (!host.shared.safetyWanted) { host.shared.safetyEnableEpoch++; host.shared.safetyEmergency = null }
        host.shared.safetyWanted = true
        return resumeSafety()
      },
      stop: async reason => {
        if (disposed || disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        safetyDispatchEpoch++
        host.shared.safetyWanted = false
        await idleSafety?.stop(reason ?? '待機保護を停止しました。')
        await idleSafety?.drain()
        return safetySnapshot()
      },
      snapshot: safetySnapshot
    },
    guardRoute: {
      execute: (waypoints, options) => { requireIdle(); if (!guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = guardRoute.execute(waypoints, options); guardRouteProgress = null; return result },
      returnRoute: (prefix, options) => { requireIdle(); if (!guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = guardRoute.returnRoute(prefix, options); guardRouteProgress = null; return result },
      escape: (waypoints, options) => { requireIdle(); if (!guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = guardRoute.escape(waypoints, options); guardRouteProgress = null; return result },
      snapshot: guardRouteSnapshot,
      stop: reason => guardRoute?.stop(reason) ?? { phase: 'idle', busy: false }
    },
    hut: {
      preview: options => hut?.preview(options) ?? { ready: false },
      reconcileEmptyPlacement: () => { requireIdle(); if (!hut) throw new Error('小屋の初期化を待ってください。'); return hut.reconcileEmptyPlacement() },
      execute: options => { requireIdle(); return hut.execute(options) },
      leave: options => { requireIdle(); return hut.leave(options) },
      snapshot: () => hut?.snapshot() ?? null,
      stop: reason => hut?.stop(reason)
    },
    armor: { equipBest: equipManualArmor },
    diagnostics: {
      locatePlains: async () => {
        plainsLocator ??= createPlainsLocator({ client: host.client, getState: () => disposed || disposing || replaying ? null : lightweightRawState() })
        const result = await plainsLocator.locate()
        if (result.requestId) host.shared.lastPlainsLocate = structuredClone(result)
        return result
      },
      locatePlainsStatus: () => ({ pending: plainsLocator?.snapshot().pending ?? false, lastResult: structuredClone(host.shared.lastPlainsLocate ?? null) }),
      resistance: () => selfResistance.snapshot(),
      manualRecoveryGroundProof: runtimeId => {
        const state = manualRecoveryState(), target = host.entities.snapshot({ kind: 'all' }).find(actor => String(actor.runtimeId) === String(runtimeId))
        return manualGroundAccessProof(target, state)
      },
      slowFalling: () => selfSlowFalling.snapshot(),
      effectEvents: () => selfEffectEvents.snapshot(),
      lastWaterPreview: () => structuredClone(host.shared.waterPreviewObservation ?? null),
      movement: () => movement?.diagnostics() ?? null,
      shoreSurvey: async () => {
        const start = raw()
        if (start.phase !== 'spawned' || !start.position || start.dead) throw new Error('ワールド内の位置を確認できません。')
        const scope = JSON.stringify([start.profile, start.realm?.id, start.dimension, start.connectionId])
        const result = await surveyShore({ world: host.world, position: start.position, radius: 64, valid: () => {
          const current = raw()
          return !disposed && !disposing && current.phase === 'spawned' && !current.dead && JSON.stringify([current.profile, current.realm?.id, current.dimension, current.connectionId]) === scope
        } })
        if (shoreMemory && !disposed && !disposing) {
          await loadShoreHistory()
          shoreMemory.rememberSurvey({ profile: start.profile, realmId: String(start.realm?.id), dimension: start.dimension }, result)
          await shoreMemory.save()
        }
        return result
      },
      rawInventorySlot: slot => {
        if (!Number.isInteger(slot) || slot < 0 || slot > 35) throw new Error('持ち物スロットは0〜35で指定してください。')
        return crafting.rawItem(slot)
      },
      craftingRecipes: output => crafting.describeRecipes(output),
      lastInventoryUpdate: () => structuredClone(host.shared.lastInventoryUpdate ?? null),
      shelterEvents: () => structuredClone(host.shared.shelterEvents ?? []),
      inventoryEvents: () => structuredClone(host.shared.inventoryEvents ?? []),
      permissions: () => ({ permissionLevel: host.meta.startGame?.permission_level, playerGameMode: host.meta.startGame?.player_gamemode, worldGameMode: host.meta.startGame?.world_gamemode, serverAuthoritativeInventory: host.meta.startGame?.server_authoritative_inventory, serverAuthoritativeBlockBreaking: host.meta.startGame?.server_authoritative_block_breaking, playerName: raw().playerName, runtimeEntityId: raw().runtimeEntityId }),
      threatReachability: () => threatReachability.snapshot(),
      combatSearchBudget: () => combatExposure.snapshot(),
      combatCandidates: () => userBehaviors?.explainCombat?.() ?? null,
      // Read-only: each condition of the user-behavior combat canAct gate.
      combatGate: () => {
        const read = f => { try { return f() } catch (error) { return `unavailable: ${error.message}` } }
        return { surfaceReturnOwner: read(() => !!surfaceReturnOwner), replaying: read(() => !!replaying), combatDefenseWanted: defenseEnabled(host.shared), userBehaviorsEnabled: host.shared.userBehaviorsEnabled === true, autoWanted: host.shared.autoWanted === true, loadingScreenEnded: host.shared.loadingScreenEnded === true, respawnTerrainPending: !!host.shared.respawnTerrain?.pending, userBehaviorWakePending: read(() => !!userBehaviorWakePending), disposed: read(() => !!disposed || !!disposing) }
      },
      // Read-only test helper: dry, flat, open areas in received terrain.
      findFlatArea: (options = {}) => findFlatArea(options),
      // Read-only: in-process CPU profile (no inspector port is opened). Saves
      // .local/cpu-<time>.cpuprofile and returns the top self-time functions.
      cpuProfile: ms => profileCpu(ms),
      // Read-only: why the after-restart quarry restore did or did not run.
      quarryRestore: () => { const st = raw(); return { tried: host.shared.quarryRestoreTried === true, result: host.shared.quarryRestore ?? null, ports: !!quarryPorts, phase: st.phase, loadingScreenEnded: host.shared.loadingScreenEnded === true, spawnPending: !!st.spawnPending, inventoryKnown: st.inventory?.known ?? null, inventoryUncertain: host.shared.inventoryUncertain ?? null } },
      // Read-only: the raw server item in a slot (NBT, enchantments) as JSON.
      rawItem: slot => { const r = crafting.rawItem(Number(slot)); return r ? JSON.parse(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v)) : null },
      // Read-only: milliseconds spent in each part of the /status snapshot.
      snapshotTimings: () => {
        const parts = { userBehaviors: () => userBehaviorSnapshot(), safety: () => safetySnapshot(), guardRoute: () => guardRouteSnapshot(), queuedPrediction: () => inputHistory?.snapshot(), missionMemory: () => missionJournal.snapshot(), hut: () => hut?.snapshot(), shelter: () => activeBase()?.snapshot(), foraging: () => foraging?.snapshot(), food: () => food.snapshot(), recovery: () => recovery?.snapshot(), excavation: () => excavation?.snapshot(), quarry: () => quarrySnapshot(), tunneling: () => tunneling?.snapshot(), furnace: () => furnace.snapshot(), chest: () => chest.snapshot(), mining: () => mining.snapshot(), walking: () => walker?.snapshot(), movement: () => movement?.snapshot(), crafting: () => crafting.snapshot(), inventoryActions: () => inventory.snapshot(), interactions: () => interactions.snapshot(), combat: () => combat?.snapshot(), agent: () => autonomy.snapshot(), depotPrebuild: () => depotPrebuild?.snapshot(), depotMission: () => depotMission?.snapshot(), surfaceReturn: () => surfaceReturn?.snapshot(), entitiesAll: () => host.entities.snapshot({ kind: 'all' }), worldStats: () => host.world.stats() }
        return measureSnapshots(parts)
      },
      armor: () => armor.snapshot(),
      sightFrom: (x, y, z) => { const p = raw().position; const hs = host.entities.snapshot({ kind: 'all' }).filter(e => e.hostile && e.alive !== false && e.position && Math.hypot(e.position.x - x, e.position.z - z) < 32); return hs.map(e => ({ type: e.entityType, runtimeId: e.runtimeId, distance: +Math.hypot(e.position.x - x, e.position.y - y, e.position.z - z).toFixed(1), clear: bowSightClearAt({ x, y: y + 1.62, z }, { x: e.position.x, y: e.position.y + 0.9, z: e.position.z }), clearFromBot: p ? bowSightClearAt(p, { x: e.position.x, y: e.position.y + 0.9, z: e.position.z }) : null })).sort((a, b) => a.distance - b.distance).slice(0, 8) },
      blocksAround: () => { const p = raw().position; if (!p) return null; const fx = Math.floor(p.x), fy = Math.floor(p.y - 1.62), fz = Math.floor(p.z), rows = []; for (let dy = 2; dy >= -1; dy--) { const lines = []; for (let dz = -2; dz <= 2; dz++) { let line = ''; for (let dx = -2; dx <= 2; dx++) { const b = host.world.getBlock(fx + dx, fy + dy, fz + dz); line += !b?.known ? '?' : /air/.test(b.name) ? '.' : /water/.test(b.name) ? '~' : b.boundingBox === 'empty' ? ',' : '#' } lines.push(line) } rows.push({ dy, lines: lines.join(' ') }) } return { feet: { x: fx, y: fy, z: fz }, exact: p, rows } },
      userTick: () => { const s = host.shared.userTickStats ?? {}; return { inventoryUncertain: host.shared.inventoryUncertain ?? null, rangedShotUncertain: host.shared.rangedShotUncertain ?? null, resync: host.shared.inventoryResync?.lastRequest ?? null, ...s, taskAgeMs: s.taskSince ? Date.now() - s.taskSince : 0, sinceRanMs: s.lastRanAt ? Date.now() - s.lastRanAt : null, taskPending: !!userBehaviorTickTask, lastCombat: userBehaviors?.snapshot?.().combat?.lastResult?.code ?? null, worker: userBehaviors?.snapshot?.().combat?.phase ?? null } },
      acquireDenials: () => ({ last: host.shared.lastUserAcquireDenial ?? null, counts: { ...(host.shared.userAcquireDenials ?? {}) }, lastPreemptSurvey: host.shared.lastPreemptSurvey ?? null }),
      foodLife: () => ({ foodKnownLife: foodKnownLife(), deathRespawn: host.shared.deathRespawn?.deathId ?? null, receipt: host.shared.inventoryLifeReceipt ? { source: host.shared.inventoryLifeReceipt.source, deathId: host.shared.inventoryLifeReceipt.deathId, keyMatches: host.shared.inventoryLifeReceipt.key === inventoryLifeBaseKey(raw()) } : null, verified: !!verifiedInitialLifeReceipt(), hunger: food.snapshot().hunger }),
      // Operator helper: sends any slash command as the bot (the owner allows
      // all commands on this Realm). The result is not proof of anything;
      // check the world or inventory afterwards.
      command: (text, version = 'latest') => {
        if (typeof text !== 'string' || !/^\/\S/.test(text) || text.length > 512 || /[\r\n]/.test(text)) throw new Error('コマンドは / で始まる1行（512文字以内）で指定してください。')
        const uuid = require('node:crypto').randomUUID()
        // The reply with this request UUID is kept (bounded) for commandOutput().
        host.shared.diagCommandOutputs ??= new Map()
        host.shared.diagCommandOutputs.set(uuid, { command: text, sentAt: Date.now(), output: null })
        while (host.shared.diagCommandOutputs.size > 20) host.shared.diagCommandOutputs.delete(host.shared.diagCommandOutputs.keys().next().value)
        host.client.queue('command_request', { command: text, origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n }, internal: false, version: String(version) })
        return { sent: true, command: text, version: String(version), uuid }
      },
      // Runs the real storage air audit once (read-only) at a received cell.
      auditAir: async (x, y, z) => {
        if (![x, y, z].every(Number.isSafeInteger)) throw new Error('整数の座標を指定してください。')
        storagePlacementAudit ??= createStoragePlacementAudit({ client: host.client, getState: quarryState })
        return storagePlacementAudit.confirmAir({ x, y, z }, { operationId: 'diagnostics:audit-air' })
      },
      commandOutput: uuid => { const row = host.shared.diagCommandOutputs?.get(String(uuid ?? '').toLowerCase()) ?? host.shared.diagCommandOutputs?.get(String(uuid ?? '')); return row ? structuredClone(row) : null }
    },
    shelter: {
      preview: options => shelter?.preview(options) ?? { ready: false },
      execute: options => { requireIdle(); return shelter.execute(options) },
      leave: options => { requireIdle(); return shelter.leave(options) },
      snapshot: () => shelter?.snapshot() ?? null,
      stop: reason => shelter?.stop(reason)
    },
    foraging: {
      preview: options => foraging?.preview(options) ?? { ready: false },
      execute: options => { requireIdle(); return foraging.execute(options) },
      snapshot: () => foraging?.snapshot() ?? null,
      stop: reason => foraging?.stop(reason)
    },
    food: {
      preview: options => food.preview(options),
      eat: options => { requireIdle(); return food.eat(options) },
      snapshot: () => food.snapshot(),
      stop: reason => food.cancel(reason)
    },
    recovery: {
      preview: options => recovery?.preview(options) ?? { ready: false },
      previewAsync: options => recovery?.previewAsync(options) ?? Promise.resolve({ ready: false }),
      execute: options => { requireIdle({ inventoryRequired: false }); return recovery.execute(options) },
      snapshot: () => recovery?.snapshot() ?? null,
      stop: reason => recovery?.stop(reason)
    },
    tunneling: {
      preview: (decision, options) => tunneling?.preview(decision, options) ?? { ready: false },
      execute: (decision, options) => { requireIdle(); return tunneling.execute(decision, options) },
      snapshot: () => tunneling?.snapshot() ?? null,
      stop: reason => tunneling?.stop(reason)
    },
    excavation: {
      preview: options => excavation?.preview(options) ?? { ready: false },
      execute: options => { requireIdle(); return excavation.execute(options) },
      snapshot: () => excavation?.snapshot() ?? null,
      stop: reason => excavation?.stop(reason)
    },
    prospecting: {
      start: options => {
        prospecting.scan(options ?? {}).then(result => { if (!disposed && !disposing) host.shared.prospecting = result }).catch(error => { if (!disposed) host.shared.prospectingError = error.message })
        return prospecting.snapshot()
      },
      scan: async options => {
        const result = await prospecting.scan(options ?? {})
        if (!disposed && !disposing) host.shared.prospecting = result
        return result
      },
      snapshot: () => prospecting.snapshot(),
      stop: reason => prospecting.cancel(reason)
    },
    depotMission: {
      start: async () => { host.shared.legacyWorkHoldScope = null; host.shared.legacyWorkHoldLease = null; autonomy.stop('ダイヤ保管後も継続する作業へ引き継ぎます。'); return depotMission.start() },
      stop: () => depotMission.stop(),
      tick: () => depotMission.tick(),
      snapshot: () => depotMission.snapshot()
    },
    surfaceReturn: {
      preview: options => surfaceReturn?.previewAsync(options) ?? Promise.resolve({ ready: false, code: 'NOT_READY' }),
      previewAsync: options => surfaceReturn?.previewAsync(options) ?? Promise.resolve({ ready: false, code: 'NOT_READY' }),
      execute: options => executeSurfaceReturn(options),
      stop: reason => surfaceReturn?.stop(reason),
      snapshot: () => surfaceReturn?.snapshot() ?? null
    },
    chest: {
      open: (position, slot) => { requireIdle(); crafting.closeContainer(); return chest.open(position, slot) },
      withdrawItem: options => { requireIdle(); return chest.withdrawItem(options) },
      depositDiamond: options => { requireIdle(); return chest.depositDiamond(options) },
      depositItem: options => { requireIdle(); return chest.depositItem(options) },
      snapshot: () => chest.snapshot(),
      rawItem: slot => chest.rawItem(slot),
      cancel: reason => chest.cancel(reason)
    },
    furnace: {
      putInput: (...args) => { requireIdle(); return furnace.putInput(...args) },
      putFuel: (...args) => { requireIdle(); return furnace.putFuel(...args) },
      takeOutput: options => { requireIdle(); return furnace.takeOutput(options) },
      waitOutput: (...args) => furnace.waitOutput(...args),
      stop: reason => furnace.cancel(reason),
      cancel: reason => furnace.cancel(reason),
      snapshot: () => furnace.snapshot()
    },
    perception: {
      entities: () => host.entities.snapshot({ kind: 'all' }),
      nearby: (options = {}) => host.entities.nearby(working().position, options),
      observe: options => runner.observe(options ?? {})
    },
    mining: {
      previewAccessClearance: options => mining.previewAccessClearance(options),
      startAccessClearance: options => { requireIdle(); crafting.closeContainer(); return mining.startAccessClearance(options) },
      preview: targets => mining.preview(targets),
      start: targets => {
        requireIdle()
        if (Array.isArray(targets) && targets.some(p => p && portableKeys().has(String(p.x) + ',' + String(p.y) + ',' + String(p.z)))) throw Object.assign(new Error('地下作業場所の床と屋根は掘削しません。'), { code: 'PROTECTED_BLOCK' })
        if (!ownedCall && Array.isArray(targets) && targets.some(point => point && planningWorld.getBlock(point.x, point.y, point.z).protectionSource === 'bot_base')) {
          const error = new Error('拠点の床・壁・屋根は通常の資材採掘では壊しません。')
          error.code = 'PROTECTED_BLOCK'
          throw error
        }
        if (!ownedCall && Array.isArray(targets)) {
          const state = raw()
          if (host.shared.tunnelFloors != null && (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !['overworld', 'nether', 'end'].includes(state.dimension))) {
            const error = new Error('帰路の床のワールド情報が未確定のため、通常採掘を停止します。')
            error.code = 'TUNNEL_FLOOR_SCOPE_UNKNOWN'
            throw error
          }
          const floors = readCurrentTunnelFloors()
          if (targets.some(point => point && floors.some(floor => floor.x === point.x && floor.y === point.y && floor.z === point.z))) {
            const error = new Error('実際に通った坑道の帰路の床は、通常の資材採掘では壊しません。')
            error.code = 'PROTECTED_BLOCK'
            error.protectionSource = 'tunnel_floor'
            throw error
          }
        }
        crafting.closeContainer()
        return mining.start(targets)
      },
      stop: reason => mining.stop(reason)
    },
    walking: {
      preview: target => { requireIdle({ inventoryRequired: false }); motionOrigin = working(); return walker?.preview(target) ?? { ready: false, errors: ['歩行の初期化を待っています。'] } },
      start: target => startMotion('flat_walk', target),
      stop: reason => { publishWalker(); return walker?.stop(reason) ?? { phase: 'idle' } }
    },
    movement: {
      destination: movementDestination,
      clearDestination: clearMovementDestination,
      preview: (target, options) => { const guardedOptions = portableMovementOptions(target, options); requireIdle({ inventoryRequired: false }); motionOrigin = working(); return movement?.preview(target, guardedOptions) ?? { ready: false, errors: ['移動の初期化を待っています。'] } },
      start: (target, options) => startMotion('navigation', target, options),
      settle: options => {
        if (options?._portableMovementLease != null) throw portablePolicyError('tagged settle requires reobservation')
        requireIdle({ inventoryRequired: false })
        yieldPortableMovement()
        if (!movement?.settle) throw new Error('着地処理の更新を待っています。')
        stopIdleStream()
        idlePhysicsState = null
        motionOrigin = working()
        host.shared.motionSource = 'navigation_settle'
        return movement.settle(options)
      },
      stop: reason => {
        // A delayed external cleanup must not cancel a movement that the idle
        // safety supervisor has since acquired. Explicit agent/safety stops
        // still use their own cancellation and cleanup paths.
        if (!ownedCall && idleSafety?.snapshot().busy) throw new Error('保護動作が移動を使用中です。全体を停止する場合は自律動作か保護動作を停止してください。')
        return movement?.stop(reason) ?? { phase: 'idle' }
      }
    },
    crafting: {
      preview: (...args) => host.shared.inventoryUncertain ? { ready: false, errors: ['操作後の持ち物が未確定です。'] } : crafting.preview(...args),
      craft: (...args) => { requireIdle(); return crafting.craft(...args) },
      openInventory: () => { requireIdle({ inventoryRequired: false }); return crafting.openInventory() },
      closeContainer: () => crafting.closeContainer()
    },
    interactions: {
      cancel: reason => interactions.cancel(reason),
      equip: slot => { requireIdle(); const result = interactions.equip(slot); host.setEquipmentPrediction(slot); return result },
      placeCraftingTable: data => {
        requireIdle(); crafting.closeContainer()
        return interactions.placeCraftingTable(data).then(result => {
          host.shared.stations ??= {}
          host.shared.stations.craftingTable = { known: true, serverConfirmed: true, placedByBot: true, position: result.position }
          return result
        })
      },
      placeBlock: data => {
        requireIdle(); crafting.closeContainer()
        const plan = interactions.previewPlace(data)
        if (!plan.ready) throw new Error(plan.errors.join('\n'))
        return interactions.placeBlock(data).then(result => {
          const name = plan.expectedBlock
          if (name === 'minecraft:furnace' || name === 'minecraft:crafting_table') {
            host.shared.stations ??= {}
            host.shared.stations[name === 'minecraft:furnace' ? 'furnace' : 'craftingTable'] = { known: true, serverConfirmed: true, placedByBot: true, position: result.position }
          }
          return result
        })
      },
      previewPlace: data => interactions.previewPlace(data),
      // Manual normal placement against a side face (2026-11-13: a bridge to the
      // registered chest over the finished pit). Same checks as the quarry's seals.
      previewPlaceAgainst: data => interactions.previewQuarryPlace(data),
      placeAgainst: data => { requireIdle(); crafting.closeContainer(); const plan = interactions.previewQuarryPlace(data); if (!plan.ready) throw new Error((plan.errors ?? []).join(' / ') || 'placement refused'); return interactions.placeQuarryBlock(data) },
      openCraftingTable: (...args) => { requireIdle(); crafting.closeContainer(); return interactions.openCraftingTable(...args) },
      openFurnace: (...args) => { requireIdle(); crafting.closeContainer(); return interactions.openFurnace(...args) },
      openChest: (position, slot) => { requireIdle(); crafting.closeContainer(); return chest.open(position, slot) },
      previewOpenChest: (position, slot) => interactions.previewOpenChest(position, slot)
    },
    inventory: {
      resync: () => requestInventoryResyncWithReceipt(),
      resyncStatus: () => structuredClone(host.shared.inventoryResync?.lastRequest ?? null),
      equip: async slot => {
        requireIdle()
        const result = await inventory.equip(slot)
        if (result.serverConfirmed) host.shared.equipment = null
        return result
      }
    },
    combat: {
      previewHunt: id => combat?.previewHunt(id) ?? { ready: false },
      previewEngage: (id, options) => combat?.previewEngage(id, options) ?? { ready: false },
      previewWaterCreeper: id => combat?.previewWaterCreeper(id) ?? { ready: false },
      waterCreeperAttack: id => { requireIdle(); return combat.waterCreeperAttack(id) },
      hunt: id => { requireIdle(); return combat.hunt(id) },
      preview: id => combat?.preview(id) ?? { ready: false },
      attack: id => { requireIdle(); return combat.attack(id) },
      defend: options => { requireIdle(); return combat.defend(options) },
      engage: (id, options) => { requireIdle(); return combat.engage(id, options) },
      stop: reason => { combat?.cancel(reason); return combat?.drain() }
    },
    agent: {
      yieldWork: async reason => {
        if (disposed || disposing) throw new Error('Runtime is reloading')
        const options=reason&&typeof reason==='object'?reason:null, ttlMs=options?.ttlMs
        if(ttlMs!=null&&(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>60000))throw Error('Work hold ttlMs must be an integer1000..60000')
        const scope=userScope(rawScope()), lease=ttlMs==null?null:{id:require('node:crypto').randomUUID(),scope,createdAt:Date.now(),expiresAt:Date.now()+ttlMs}
        host.shared.legacyWorkHoldScope=scope;host.shared.legacyWorkHoldLease=lease
        autonomy.stop(options?.reason ?? (typeof reason==='string'?reason:'Logical work handoff'))
        await autonomy.tick()
        return {held:lease?host.shared.legacyWorkHoldLease?.id===lease.id&&logicalWorkHeld():logicalWorkHeld(),policyUnchanged:true,leaseId:lease?.id??null,scope,expiresAt:lease?.expiresAt??null,agent:autonomy.snapshot()}
      },
      releaseWork: leaseId => {
        const lease=host.shared.legacyWorkHoldLease
        if(typeof leaseId!=='string'||!lease||lease.id!==leaseId)return {released:false,policyUnchanged:true}
        host.shared.legacyWorkHoldLease=null
        if(host.shared.legacyWorkHoldScope===lease.scope)host.shared.legacyWorkHoldScope=null
        return {released:true,policyUnchanged:true}
      },
      start: options => {
        if (chunkMoveHeld()) throw Object.assign(new Error('Botの移動が終わるまで待ってください。'), { code: 'CHUNK_MOVE_BUSY' })
        if (manualChestStorage?.isBusy()) throw Object.assign(new Error('ラージチェストへの収納操作中です。'), { code: 'STORAGE_BUSY' })
        if (resetHeld()) throw Object.assign(new Error('初期アイテムのリセット処理中です。'), { code: 'RESET_BUSY' })
        if (disposed || disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        host.shared.legacyWorkHoldScope = null; host.shared.legacyWorkHoldLease = null
        host.shared.autoWanted = true
        host.shared.autoOptions = { objective: 'diamond', diamondCount: 1, maxRunMs: 7200000, maxWaitTicks: 1200, ...options }
        const start = () => { if (disposed || disposing || resetHeld() || manualChestStorage?.isBusy() || chunkMoveHeld()) return autonomy.snapshot(); return autonomy.start({ ...host.shared.autoOptions, progress: options?.progress ?? host.shared.autonomyProgress }) }
        return missionJournal.enabled ? missionJournal.load().then(result => missionReady(result) ? start() : autonomy.snapshot()) : start()
      },
      stop: reason => { host.shared.autoWanted = false; clearNavigationDestination(); const result = autonomy.stop(reason); stopActions(reason); return result },
      tick: () => { if (chunkMoveHeld()) throw Object.assign(new Error('Botの移動が終わるまで待ってください。'), { code: 'CHUNK_MOVE_BUSY' }); if (manualChestStorage?.isBusy()) throw Object.assign(new Error('ラージチェストへの収納操作中です。'), { code: 'STORAGE_BUSY' }); if (resetHeld()) throw Object.assign(new Error('初期アイテムのリセット処理中です。'), { code: 'RESET_BUSY' }); return autonomy.tick() }
    }
  }
  async function observeDepotSky (signal) {
    const state = lightweightUserState(), p = state.position
    if (!p || state.phase !== 'spawned' || state.dead || state.spawnPending || !(state.health > 0)) return
    let unknown = false
    for (let x=Math.floor(p.x-.3+1e-6);x<=Math.floor(p.x+.3-1e-6);x++) for (let z=Math.floor(p.z-.3+1e-6);z<=Math.floor(p.z+.3-1e-6);z++) if (host.world.getBlock(x,319,z)?.known !== true) unknown = true
    if (unknown) await prospecting.scan({minY:Math.max(-64,Math.floor(p.y-1.62)-2),maxY:319,chunkRadius:1,maxResults:1},{signal})
  }
  async function runDepotResource (intent, context) {
    if (['logs', 'wood', 'leaf', 'leaves'].includes(intent?.resource)) return { phase: 'blocked', code: 'WOOD_LEAF_HARVEST_DISABLED', reason: '木・葉の採取は無効です。必要な材料は補給してください。' }
    if (userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size) return { phase: 'yielding', owner: 'survival' }
    requireIdle()
    const observations = await runner.observe({ signal: context.signal, radius: 8 })
    observations.capabilities = {...observations.capabilities,move:!!movement,break_block:!!input,mine_ore:true,tunnel:!!tunneling,prospect:true,furnace:true,place_furnace:true,open_furnace:true,put_furnace_input:true,put_furnace_fuel:true,take_furnace_output:true}
    const state = { ...observedState(), lifecycle: lightweightUserState().lifecycle, entityStats: host.entities.stats?.() }
    let safetyDecision = await continuationSafety(state, observations)
    if (context.prebuild && state.health > 8 && food.snapshot().hunger > 6 && (safetyDecision?.type === 'forage' || safetyDecision?.nutritionEquip === true)) {
      const current = evaluateThreats(state,state.entities,{observationRadius:32})
      if (!current.requiresObservation && !current.threats.length && !(state.entityStats?.unknownPositions > current.unknownPositions.length)) safetyDecision = null
    }
    let decision = safetyDecision ?? planContinuationResource({ state, observations: { ...observations, progress: host.shared.autonomyProgress, foragingPreview: foraging?.preview() }, intent, options: host.shared.autoOptions ?? {} })
    if (!safetyDecision && intent.preparation === 'weapon') decision = nextSurvivalAction(state, observations, { firstWoodenSwordOnly: true }) ?? {type:'wait',code:'WEAPON_REOBSERVE'}
    if (!safetyDecision && intent.resource === 'food' && decision?.type === 'wait' && decision.code === 'NO_KNOWN_FOOD_SOURCE' && state.inventory?.known === true && !(state.inventory.items ?? []).some(item => item.count > 0 && (isSupportedFood(item.name, state) || item.name === 'minecraft:rotten_flesh'))) decision = { ...decision, type:'explore', stage:'continuation', resource:'food', code:'CONTINUATION_FOOD_EXPLORE', allowWater:false, requiresLivePreview:true, reason:'実際の食料源を近くの既知地形から観測します。' }
    const coverage = observations.coverage
    if (decision.type === 'scan_blocks' && decision.resource !== 'body' && coverage?.unknown === 0 && coverage.expected > 0 && coverage.known >= coverage.expected) decision = {...decision,type:'explore',stage:'exploration',requiresLivePreview:true}
    if (decision.requiresNutritionAdmission) {
      decision = await continuationSafety({ ...observedState(), lifecycle: lightweightUserState().lifecycle, entityStats: host.entities.stats?.() }, observations)
      if (decision?.type !== 'forage' && decision?.nutritionEquip !== true) return { phase: 'observing', code: 'NUTRITION_ADMISSION_PENDING' }
    }
    if (!decision || ['wait','stop','complete','capability_required'].includes(decision.type)) return { phase: 'observing', decision }
    if (context.prebuild) {
      const p = decision.resourceTarget ?? decision.target ?? decision.proposedAction?.resourceTarget ?? decision.proposedAction?.target
      const limit = Math.min(8,intent.prebuildMaxDistance ?? 8)
      if (p && Number.isFinite(p.x) && Math.hypot(p.x-state.position.x,p.y-(state.position.y-1.62),p.z-state.position.z)>limit) return {phase:'observing',code:'PREBUILD_LOCAL_RESOURCE_ONLY'}
      if (['explore','retreat','scan_blocks'].includes(decision.type) && !p) {
        const candidate=rankCampResourceTargets({state,observations,surface:host.shared.depotSurfaceAnchor,history:runner.getExplorationSnapshot()?.history ?? [],limit:20})[0]
        if(!candidate)return {phase:'observing',code:'NO_LOCAL_CAMP_RESOURCE_ROUTE'}
        decision={type:'move_to',target:candidate.position,allowWater:false,resource:'logs',requiresLivePreview:true,reason:'Approach a received local camp resource area'}
      }
    }
    const action = continuationActions[decision.type]
    if (typeof action !== 'function') return { phase: 'observing', code: 'ACTION_UNAVAILABLE', decision }
    host.shared.depotResourceDecision = decision
    return await action(decision, { signal: context.signal, state, observations, progress: host.shared.autonomyProgress ?? {} })
  }
  async function approachOwnedCamp (context, prepareOnly = false) {
    const state=lightweightUserState(), camp=context.extra.campBuilder
    const baseline={health:state.health,position:{...state.position},scope:continuationScope(state)}
    if(camp?.kind!=='worksite_camp'||!camp.tableCell)return null
    const distance=Math.hypot(state.position.x-camp.tableCell.x-.5,state.position.y-1.62-camp.tableCell.y,state.position.z-camp.tableCell.z-.5)
    if(distance<=7.5&&!prepareOnly)return null
    if(!prebuildIdle())return {phase:'yielding',owner:'survival_or_existing_work'}
    const evaluation=evaluateThreats(state,state.entities,{observationRadius:32})
    if(evaluation.requiresObservation||evaluation.threats.length||state.entityStats?.unknownPositions>evaluation.unknownPositions.length)return {phase:'yielding',owner:'survival'}
    const avoidance=[...evaluation.outsideDanger,...evaluation.suppressedByTerrain].map(a=>({id:a.runtimeId,position:{...a.position},minDistance:a.dangerRadius,padding:0}))
    let fullPlanner=null
    const previewRoute=(target,options)=>{
      if(!idlePhysics)return {ready:false,reason:'native_planning_physics_unavailable'}
      fullPlanner??=createNavigator({world:planningWorld,version:host.meta.version,allowWater:false,physics:idlePhysics.withWorld(planningWorld,{allowWater:false}),planningDistanceLimit:48})
      return fullPlanner.plan(fullPlanner.physics.fromServer(state),target,{...options,avoidance})
    }
    const proposal=planOwnedCampReturn({state,world:host.world,campMemo:camp,ownedChest:context.policy.memo().chest,previewMove:(target,options)=>operations.movement.preview(target,{...options,avoidance}),previewRoute})
    if(proposal.detour)await delay(0)
    if(!proposal.ready&&proposal.reason==='full_dry_origin_not_proven'&&!prepareOnly){
      // Half over an edge on dry land: step onto the nearest fully supported
      // cell center first, otherwise this re-observes forever.
      const physical=state.predicted?.physicsState??state.physicsState
      if(physical?.onGround===true&&!physical.isInWater&&!physical.isInLava){
        const recenter={partialRecenter:true,maxDistance:2,maxExpanded:64,maxTicks:40}
        for(const target of landEdgeRecenterTargets(host.world,{...state.position,y:state.position.y-1.62})){
          if(operations.movement.preview(target.position,{...recenter,avoidance})?.ready!==true)continue
          const moved=await movePrebuildStance({standpoint:target.position,avoidance,moveOptions:recenter},context)
          return {...moved,code:'LAND_EDGE_RECENTER'}
        }
      }
    }
    if(!proposal.ready)return {phase:'observing',code:'OWN_CAMP_RETURN_REOBSERVE',reason:proposal.reason,nearbyValidated:prepareOnly&&proposal.reason==='within_camp_revalidation_range',serverConfirmed:false}
    const fresh=lightweightUserState()
    if(context.signal.aborted||JSON.stringify(continuationScope(fresh))!==JSON.stringify(proposal.scope)||JSON.stringify(proposal.scope)!==JSON.stringify(baseline.scope)||fresh.health<baseline.health||Math.hypot(fresh.position.x-baseline.position.x,fresh.position.y-baseline.position.y,fresh.position.z-baseline.position.z)>.1||!prebuildIdle())return {phase:'observing',code:'OWN_CAMP_RETURN_ORIGIN_CHANGED',serverConfirmed:false}
    if(prepareOnly)return {ready:true,proposal,avoidance,baseline}
    return movePrebuildStance({standpoint:proposal.target,avoidance},context)
  }
  const ownedCampBootstrap = createOwnedCampBootstrap({
    getState:lightweightUserState,isHeld:logicalWorkHeld,isIdle:prebuildIdle,memo:host.shared.ownedCampBootstrap,
    prepare:context=>approachOwnedCamp(context,true),
    takeover:async(context,before)=>{
      if(context.signal.aborted||logicalWorkHeld()||!prebuildIdle())return false
      autonomy.stop('Approach the actual owned crafting camp before empty-bag bootstrap');await autonomy.tick()
      const state=lightweightUserState()
      return !context.signal.aborted&&!logicalWorkHeld()&&JSON.stringify(continuationScope(state))===JSON.stringify(before.scope)&&state.health>=before.health&&Math.hypot(state.position.x-before.position.x,state.position.y-before.position.y,state.position.z-before.position.z)<=.1&&prebuildIdle()
    },
    execute:(prepared,context)=>{
      const state=lightweightUserState(),age=Date.now()-inputHistory?.snapshot().cursor?.queuedAt,b=prepared.baseline
      if(!Number.isFinite(age)||age<0||age>=200||logicalWorkHeld()||JSON.stringify(continuationScope(state))!==JSON.stringify(b.scope)||state.health<b.health||Math.hypot(state.position.x-b.position.x,state.position.y-b.position.y,state.position.z-b.position.z)>.1||!prebuildIdle())throw Error('Owned camp bootstrap origin or input changed')
      return movePrebuildStance({standpoint:prepared.proposal.target,avoidance:prepared.avoidance},context)
    }
  })
  function refreshDepotSurfacePolicy (policy) {
    const before = lightweightUserState(), scope = continuationScope(before)
    if (!scope) return { ready: false, code: 'CURRENT_SURFACE_SCOPE_REQUIRED' }
    if (policy.hasCurrentSurface?.() === true) {
      const p = before.predicted, physical = p?.physicsState ?? before.physicsState
      const at = typeof p?.updatedAt === 'number' ? p.updatedAt : Date.parse(p?.updatedAt)
      const modeled = before.positionSource !== 'client_prediction' || p?.source === 'client_prediction' && p.updatedAt === before.positionUpdatedAt && Number.isFinite(at) && Date.now()-at >= 0 && Date.now()-at < 200 && ['x','y','z'].every(k => Number.isFinite(p.position?.[k]) && Number.isFinite(physical?.position?.[k]) && Number.isFinite(physical?.velocity?.[k]) && Math.abs(p.position[k]-before.position[k])<=1e-4 && Math.abs(physical.position[k]+(k==='y'?1.62:0)-before.position[k])<=1e-4)
      if (!modeled || physical?.onGround !== true || physical.isInWater || physical.isInLava || !knownLearningLocalBody(before)) return { ready: false, code: 'CURRENT_SURFACE_POSE_REQUIRED' }
      const state = lightweightUserState(), cursor = inputHistory?.snapshot().cursor, age = Date.now()-cursor?.queuedAt
      if (!Number.isFinite(age) || age < 0 || age >= 200 || JSON.stringify(continuationScope(state)) !== JSON.stringify(scope) || state.health < before.health || state.positionUpdatedAt !== before.positionUpdatedAt || Math.hypot(state.position.x-before.position.x,state.position.y-before.position.y,state.position.z-before.position.z)>1e-4 || policy.hasCurrentSurface() !== true) return { ready: false, code: 'CURRENT_SURFACE_CHANGED' }
      return { ready: true, retainedCurrentSurface: true, predictionOnly: true, serverConfirmed: false }
    }
    // A shared anchor is history. Re-run the existing full Native standing and
    // received-air-to319 proof before admitting it into a newly loaded policy.
    const proof = surfaceReturn?.preview({ radius: 1, up: 1, down: 0 })
    if (proof?.ready !== true || proof.surfaceReached !== true || proof.scope !== returnScope(before)) return { ready: false, code: proof?.code ?? 'CURRENT_SURFACE_REVALIDATION_REQUIRED' }
    const state = lightweightUserState(), cursor = inputHistory?.snapshot().cursor
    if (JSON.stringify(continuationScope(state)) !== JSON.stringify(scope) || state.health < before.health || state.positionUpdatedAt !== before.positionUpdatedAt || !proof.initial?.position || Math.hypot(state.position.x-proof.initial.position.x,state.position.y-1.62-proof.initial.position.y,state.position.z-proof.initial.position.z)>1e-4) return { ready: false, code: 'CURRENT_SURFACE_CHANGED' }
    policy.acceptSurface({ scope, source: 'validated_surface_anchor', anchorId: 'received-sky:'+JSON.stringify(proof.initial.position), position: proof.initial.position, positionUpdatedAt: state.positionUpdatedAt, queuedAt: cursor?.queuedAt })
    host.shared.depotSurfaceAnchor = { scope, position: { ...proof.initial.position } }
    return { ready: true, predictionOnly: true, serverConfirmed: false }
  }
  // While the depot mission owns resume, autonomy (whose planSafety normally
  // admits the shore return) never runs. Without this, a bot in water with a
  // maintain/safety intent just yields to "survival" and stays afloat.
  function actuallyInWater (state) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    const foot = state.position && { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
    const cell = foot && host.world?.getBlock?.(foot.x, foot.y, foot.z)
    return physical?.isInWater === true || cell?.known === true && ['minecraft:water', 'minecraft:flowing_water'].includes(cell.name)
  }
  async function depotWaterRecovery (context) {
    if (typeof recovery?.previewAsync !== 'function' || recovery.snapshot().busy || userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size) return null
    if (!actuallyInWater(lightweightUserState())) return null
    const escape = await recovery.previewAsync()
    if (context.signal.aborted || !escape?.ready || escape.alreadyAshore || escape.requiresDedicatedRoute) return null
    try {
      requireIdle({ inventoryRequired: false })
      return await recovery.execute({}, { signal: context.signal })
    } catch (error) { return { phase: 'observing', code: error.code ?? 'WATER_RECOVERY_FAILED', reason: String(error.message ?? error).slice(0, 200), serverConfirmed: false } }
  }
  // A dry pose half over an edge fails every planner's origin proof (camp
  // return, surface return, ordinary routes). Step onto the nearest fully
  // supported cell center with the navigator's bounded partial recenter.
  async function depotEdgeRecenter (context) {
    if (userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size || movement?.snapshot().running) return null
    const state = lightweightUserState(), physical = state.predicted?.physicsState ?? state.physicsState
    if (physical?.onGround !== true || physical.isInWater || physical.isInLava) return null
    const targets = landEdgeRecenterTargets(host.world, { ...state.position, y: state.position.y - 1.62 })
    if (!targets.length) return null
    const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
    const avoidance = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].map(a => ({ id: a.runtimeId, position: { ...a.position }, minDistance: a.dangerRadius, padding: 0 }))
    const recenter = { partialRecenter: true, maxDistance: 2, maxExpanded: 64, maxTicks: 40 }
    for (const target of targets) {
      if (operations.movement.preview(target.position, { ...recenter, avoidance })?.ready !== true) continue
      try { return { ...await movePrebuildStance({ standpoint: target.position, avoidance, moveOptions: recenter }, context), code: 'LAND_EDGE_RECENTER' } } catch (error) { return { phase: 'observing', code: 'LAND_EDGE_RECENTER_FAILED', reason: String(error.message ?? error).slice(0, 200), serverConfirmed: false } }
    }
    return null
  }
  async function dispatchDepotIntent (intent, context) {
    if (context.signal.aborted || disposed || disposing) throw new Error('Depot execution interrupted')
    if (context.extra.builder?.kind === 'owned_hut_depot' && (context.extra.builder.placements?.length || context.extra.builder.removals?.length)) host.shared.depotHutUpgraded = true
    // Only the return controller may admit its freshly proven full-solid cover
    // exception. The phase policy and canonical enemy telemetry stay strict.
    if (logicalWorkHeld()) return {phase:'yielding',owner:'manual_work_hold'}
    const waterEscape = await depotWaterRecovery(context)
    if (waterEscape) return waterEscape
    const edgeStep = await depotEdgeRecenter(context)
    if (edgeStep) return edgeStep
    const currentDepotState = lightweightUserState(), surfaceAnchor = host.shared.depotSurfaceAnchor
    if (!context.prebuild) {
      const preparation = await depotPrebuild.step(context)
      if (preparation.handled) return preparation.result
    }
    const carried = currentDepotState.inventory?.known === true && !currentDepotState.inventory.uncertain ? currentDepotState.inventory.items.filter(i=>i.name==='minecraft:diamond').reduce((n,i)=>n+i.count,0) : null
    if (!context.prebuild && carried === 0 && context.policy.memo().deposited === 0 && currentDepotState.lifecycle.deathId > 0) {
      // A confirmed empty bag after a real respawn must not leave the former
      // diamond objective permanently idle. Reuse the actual mining executor.
      host.shared.depotReacquireWanted = true
      const home=await ownedCampBootstrap.step(context)
      host.shared.ownedCampBootstrap=ownedCampBootstrap.snapshot()
      if(home.handled)return home.result
      const active = autonomy.snapshot()
      if (!userBehaviorOwns() && !pendingStops.size && !active.running && !active.busy && !active.actionActive && Date.now() >= (host.shared.depotMiningRestartAt ?? 0)) {
        host.shared.depotMiningRestartAt = Date.now()+10000
        autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...host.shared.autoOptions,progress:host.shared.autonomyProgress})
      }
      return {phase:'reacquiring_diamond',serverConfirmed:false,inventoryConfirmed:false}
    }
    if (carried > 0) host.shared.depotReacquireWanted = false
    const surfaceForCurrentLife = surfaceAnchor && JSON.stringify(surfaceAnchor.scope) === JSON.stringify(continuationScope(currentDepotState)) && currentDepotState.position.y-1.62 >= surfaceAnchor.position.y-4
    if (context.prebuild && intent.kind === 'prebuild_close') { crafting.closeContainer(); return {phase:'requested',serverConfirmed:false} }
    if (context.prebuild && intent.kind === 'prebuild_eat_owned') {
      requireIdle()
      const state=lightweightUserState(), item=state.inventory.items.find(i=>i.count>0 && isSupportedFood(i.name,state) && food.preview({slot:i.slot}).ready)
      return item ? continuationActions.eat({type:'eat',slot:item.slot},context) : {phase:'observing',code:'NO_READY_OWNED_FOOD'}
    }
    if (context.prebuild && ['prebuild_gather_dirt','prebuild_explore'].includes(intent.kind)) {
      requireIdle()
      const observations=await runner.observe({signal:context.signal,radius:6}),state=prebuildState()
      const threats=evaluateThreats(state,state.entities,{observationRadius:32})
      if (threats.requiresObservation || threats.threats.length || state.entityStats?.unknownPositions>threats.unknownPositions.length) return {phase:'yielding',owner:'survival'}
      return intent.kind === 'prebuild_gather_dirt'
        ? runner.actions.gather_dirt({type:'gather_dirt',count:Math.min(2,intent.count),excludedPositions:intent.excludedPositions ?? []},{...context,state,observations})
        : runner.actions.explore({type:'explore',resource:'logs',allowWater:false},{...context,state,observations})
    }
    if (intent.kind === 'return_surface' || intent.kind === 'safety' && !surfaceForCurrentLife && currentDepotState.inventory?.items?.some(item => item.name === 'minecraft:diamond' && item.count > 0)) {
      const result = await executeSurfaceReturn({ maxLegs: 4 }, context)
      if (result.surfaceReached === true) {
        const state = lightweightUserState(), cursor = inputHistory?.snapshot().cursor
        context.policy.acceptSurface({ scope: continuationScope(state), source: 'validated_surface_anchor', anchorId: 'received-sky:'+JSON.stringify(result.feetPosition), position: result.feetPosition, positionUpdatedAt: state.positionUpdatedAt, queuedAt: cursor?.queuedAt })
        host.shared.depotSurfaceAnchor = {scope:continuationScope(state),position:{...result.feetPosition}}
      }
      return result
    }
    if (intent.kind === 'safety' || userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size) return { phase: 'yielding', owner: 'survival' }
    if (intent.kind === 'establish_base') {
      if (!depotBuilder) return { phase: 'observing', code: 'BASE_BUILDER_NOT_READY' }
      const approach=await approachOwnedCamp(context)
      if(approach)return approach
      const currentSurface = refreshDepotSurfacePolicy(context.policy)
      if (!currentSurface.ready) return { phase: 'observing', code: currentSurface.code, serverConfirmed: false }
      const result = await depotBuilder.step({ memo: context.extra.campBuilder ?? null }, { signal: context.signal })
      if (result.memo || result.baseProof?.tableCell) context.setExtra({ ...context.extra, ...(result.memo ? {campBuilder: result.memo} : {}), ...(result.baseProof?.tableCell ? {tableCell: result.baseProof.tableCell} : {}) })
      if (result.memo?.kind === 'owned_hut_depot' && (result.memo.placements?.length || result.memo.removals?.length)) host.shared.depotHutUpgraded = true
      if (result.baseProof) context.policy.acceptBase(result.baseProof)
      if (result.code === 'NEED_LOGS' && Number.isSafeInteger(result.targetCount) && result.targetCount>=1 && result.targetCount<=3) return runDepotResource({...intent,kind:'work',resource:'logs',targetCount:result.targetCount,prebuildMaxDistance:8},context)
      if (result.code === 'FLOOR_CHANGED' && !result.memo) {
        const actualLogs = lightweightUserState().inventory.items.filter(i => /_(log|stem|wood|hyphae)$/.test(i.name)).reduce((n,i)=>n+i.count,0)
        if (actualLogs < 2) return runDepotResource({...intent,kind:'work',resource:'logs',targetCount:2},context)
      }
      return result
    }
    if (['ensure_chest','deposit_diamond','observe_storage'].includes(intent.kind)) {
      if (!depotStorage) return { phase: 'observing', code: 'STORAGE_CONTROLLER_NOT_READY' }
      const approach=await approachOwnedCamp(context)
      if(approach)return approach
      const memory = context.policy.memo()
      const storageCell = memory.base?.storageCell ?? intent.position
      const state = lightweightUserState(), center = memory.base?.position
      const localBlocks = center ? host.world.getArea(center, 3) : []
      const tablePosition = context.extra.campBuilder?.tableCell ?? localBlocks.filter(b => b.known && b.name === 'minecraft:crafting_table').sort((a,b) => Math.hypot(a.position.x-state.position.x,a.position.z-state.position.z)-Math.hypot(b.position.x-state.position.x,b.position.z-state.position.z))[0]?.position
      const tableCell = context.extra.tableCell ?? selectDepotTableCell({state,world:host.world,storageCell,reservedCells:depotBuilder?.protectedCells() ?? []})?.position
      if (tableCell && !context.extra.tableCell) context.setExtra({...context.extra,tableCell})
      const validated=depotBuilder.validate({memo:context.extra.campBuilder,ownedChest:memory.chest})
      if(!validated.ready)return {phase:'observing',code:'OWN_CAMP_REVALIDATION_REQUIRED',reason:validated.reason}
      let result
      if (intent.kind === 'observe_storage' && memory.chest) {
        const access=operations.interactions.previewOpenChest(memory.chest.position)
        if(access.ready===true){
          const opened=await operations.chest.open(memory.chest.position)
          const observed=context.policy.observeStored(chest.snapshot())
          return {phase:'observed',serverConfirmed:opened.serverConfirmed===true,storedDiamondRevalidated:observed}
        }
        result={kind:'need_access',position:memory.chest.position,errors:access.errors}
      } else {
        result = await depotStorage.step({ scope: context.scope, storageCell, tablePosition, tableCell, ownedChest: memory.chest, sourceSlot: intent.sourceSlot, count: intent.count }, { signal: context.signal })
      }
      if (result.kind === 'need_logs') {
        const actualLogs = state.inventory.items.filter(i => /_(log|stem|wood|hyphae)$/.test(i.name)).reduce((n,i)=>n+i.count,0)
        return runDepotResource({ ...intent, kind: 'work', resource: 'logs', targetCount: actualLogs+(result.count ?? 1) }, context)
      }
      if (result.kind === 'need_access' && result.position) {
        let probeState
        const probe = createInteractions({client:host.client,world:host.world,crafting,getState:()=>probeState,getInput:()=>input,version:host.meta.version})
        const access = planDepotStorageAccess({state:lightweightUserState(),world:host.world,target:result.position,previewOpenAt:({state:projected,target})=>{probeState=projected;return probe.previewOpenChest(target,projected.rawSelectedSlot)}})
        if (access.standpoint) return runner.actions.move_to({type:'move_to',target:access.standpoint,allowWater:false,reason:'Confirm depot access from an observed standing cell'}, {signal:context.signal,state:lightweightUserState(),observations:{},progress:{}})
        if (context.prebuild) {
          const close=planPrebuildChestStance({state:lightweightUserState(),scope:context.scope,world:host.world,base:memory.base,target:result.position,previewPlaceAt:({state:projected,target,slot})=>{probeState=projected;return probe.previewPlace({position:target,slot})},previewMove:(target,options)=>operations.movement.preview(target,options)})
          if (close?.standpoint) return movePrebuildStance(close,context)
        }
        return {phase:'observing',code:access.reason ?? 'ACCESS_REPREVIEW'}
      }
      if (result.receipt?.operation === 'place' && result.receipt.blockName === 'minecraft:chest') context.policy.acceptChest(result.receipt)
      if (result.receipt?.operation === 'deposit_diamond') context.policy.acceptDeposit(result.receipt)
      if (chest.snapshot().contentsKnown) context.policy.observeStored(chest.snapshot())
      return result
    }
    if (intent.kind === 'work') return runDepotResource(intent, context)
    if (intent.kind === 'maintain') {
      if (intent.priority === 'inventory_capacity') {
        const memory = context.policy.memo(), state = observedState(), position = memory.chest?.position
        if (!position) return { phase: 'observing', code: 'OWN_CHEST_UNKNOWN' }
        const candidate = state.inventory.items.find(item => ['minecraft:andesite','minecraft:granite','minecraft:diorite','minecraft:raw_copper','minecraft:raw_gold'].includes(item.name) && item.count > 0) ?? state.inventory.items.find(item => item.name === 'minecraft:cobblestone' && item.count > 0 && state.inventory.items.filter(i => i.name === item.name).reduce((n,i) => n+i.count,0) > 64)
        if (!candidate) return { phase: 'observing', code: 'NO_VALIDATED_SURPLUS' }
        if (!chest.snapshot().contentsKnown || JSON.stringify(chest.snapshot().window?.position) !== JSON.stringify(position)) return operations.chest.open(position)
        const retained = candidate.name === 'minecraft:cobblestone' ? 64 : 0
        const total = state.inventory.items.filter(i => i.name === candidate.name).reduce((n,i) => n+i.count,0)
        return operations.chest.depositItem({sourceSlot:candidate.slot,count:Math.min(candidate.count,total-retained),expectedName:candidate.name})
      }
      const actualIron = lightweightUserState().inventory.items.filter(i => ['minecraft:raw_iron','minecraft:iron_ingot'].includes(i.name)).reduce((n,i)=>n+i.count,0)
      return runDepotResource({ ...intent, kind:'work', resource: intent.priority === 'food_health' ? 'food' : 'iron', targetCount: intent.priority === 'food_health' ? 1 : Math.min(4096,actualIron+8), ...(intent.priority === 'weapon' ? {preparation:'weapon'} : {}) }, context)
    }
    if (intent.kind === 'observe_inventory' && host.shared.inventoryUncertain) return { phase: 'observing', code: 'INVENTORY_RECONCILIATION_REQUIRED' }
    return { phase: 'observing', code: intent.kind }
  }
  function prebuildState () {
    const state=lightweightUserState()
    const inventory={...state.inventory,items:state.inventory.items.map(item=>{
      const raw=crafting.rawItem(item.slot)
      return raw?.network_id===item.networkId && raw.count===item.count && raw.has_stack_id===true ? {...item,stackId:raw.stack_id} : item
    })}
    return {...state,inventory,food:food.snapshot(),crafting:crafting.snapshot()}
  }
  function prebuildIdle () {
    const idle = !disposed && !disposing && !userBehaviorOwns() && !pendingStops.size && !surfaceReturnOwner && !autonomy.snapshot().actionActive && !motionActive() && !input?.stats().running && !idleSafety?.snapshot().busy && mining.snapshot().phase!=='mining' && !food.snapshot().busy && !inventory.snapshot().busy && craftStatus().pendingRequestId==null && !interactions.snapshot().pendingOperation && !depotBuilder?.snapshot().busy && !depotStorage?.snapshot().busy && !foraging?.snapshot().busy && !recovery?.snapshot().busy && !tunneling?.snapshot().busy && !excavation?.snapshot().busy && !guardRoute?.snapshot().busy && !chest.snapshot().busy && !furnace.snapshot().busy && !combat?.snapshot().busy && !combat?.snapshot().engaging
    if (!idle) return false
    if (working().survivalWorkClearance === true) {
      if (!idleSafety?.snapshot().running || host.shared.safetyWanted !== true) { resumeSafety(); return false }
      if (idleSafety.requestWorkClearance?.().pending === true) return false
    }
    return true
  }
  async function movePrebuildStance (plan,context) {
    requireIdle({inventoryRequired:false})
    const original=lightweightUserState(), scope=JSON.stringify(continuationScope(original)), actor=movement
    const beforeInput=frame=>{
      const state=lightweightUserState(), p=frame.packetPosition
      if (context.signal.aborted || JSON.stringify(continuationScope(state))!==scope || state.health<original.health || !p) return false
      const e=evaluateThreats(state,state.entities,{observationRadius:32})
      if(e.requiresObservation || state.entityStats?.unknownPositions>e.unknownPositions.length)return false
      return [...e.threats,...e.outsideDanger,...e.suppressedByTerrain].every(a=>Math.hypot(p.x-a.position.x,p.y-a.position.y,p.z-a.position.z)>=a.dangerRadius-1e-4)
    }
    const receipt=operations.movement.start(plan.standpoint,{allowWater:false,maxDistance:6,maxExpanded:300,maxTicks:100,avoidance:plan.avoidance,beforeInput,...(plan.moveOptions??{})})
    const stamp=actor.snapshot().timingDiagnostics?.start?.at ?? receipt.timingDiagnostics?.start?.at
    try {
      for(let i=0;i<120;i++) {
        if(context.signal.aborted)throw context.signal.reason
        const state=lightweightUserState(), m=actor.snapshot()
        if(JSON.stringify(continuationScope(state))!==scope || state.health<original.health || m.timingDiagnostics?.start?.at!==stamp)throw Error('Prebuild stance ownership, life or health changed')
        if(m.phase==='awaiting_server_confirmation' && m.physicsState?.onGround && Math.hypot(m.physicsState.position.x-plan.standpoint.x,m.physicsState.position.y-plan.standpoint.y,m.physicsState.position.z-plan.standpoint.z)<=.4)return {phase:'predicted',serverConfirmed:false,requiresObservation:true,position:state.position}
        if(['failed','stopped','replan_required'].includes(m.phase))throw Error(m.reason ?? 'Prebuild stance interrupted')
        await delay(50,context.signal)
      }
      throw Error('Prebuild stance deadline reached')
    } finally { if(actor.snapshot().timingDiagnostics?.start?.at===stamp) {actor.stop('Prebuild stance ended');await actor.drain?.()} }
  }
  depotPrebuild=createWorksiteCampPrebuild({getState:prebuildState,getRawItem:slot=>crafting.rawItem(slot),world:host.world,getSurface:()=>host.shared.depotSurfaceAnchor,getBuilder:()=>depotBuilder?{...depotBuilder.snapshot(),protectedCells:depotBuilder.protectedCells()}:null,getStorage:()=>chest.snapshot(),isIdle:prebuildIdle,
    takeover:async({scope,signal})=>{if(signal.aborted || JSON.stringify(continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())return false;host.shared.depotReacquireWanted=false;autonomy.stop('Prepare a real depot before valuable mining');await autonomy.tick();return !signal.aborted && JSON.stringify(continuationScope(prebuildState()))===JSON.stringify(scope) && prebuildIdle()},
    dispatch:(intent,context)=>dispatchDepotIntent(intent,{...context,prebuild:true}),
    resumeLegacy:async({scope,signal})=>{if(signal.aborted || JSON.stringify(continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())throw Error('Prebuild release owner changed');host.shared.depotReacquireWanted=true;const s=autonomy.snapshot();if(!s.running&&!s.busy&&!s.actionActive)autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...host.shared.autoOptions,progress:host.shared.autonomyProgress})},onProgress:value=>{host.shared.depotPrebuildStatus=value}})
  depotMission = createDepotMission({ getState: () => ({ ...lightweightUserState(), hut: hut?.snapshot(), shelter: shelter?.snapshot(), food: food.snapshot() }), world: host.world, getRawItem: slot => crafting.rawItem(slot), workspaceRoot: host.meta.workspaceRoot, dispatch: dispatchDepotIntent, onProgress: value => { host.shared.depotMissionStatus = value } })
  host.cache.replay(applyPacket)
  replaying = false
  restoreFoodHungerBaseline()
  for (const player of host.entities.snapshot({ kind: 'all' }).filter(entity => entity.kind === 'player' && entity.positionKnown)) {
    if (!/^\d+$/.test(String(player.runtimeId))) continue
    const packet = { runtime_id: BigInt(player.runtimeId), position: player.position }
    if (player.uniqueId != null && /^-?\d+$/.test(String(player.uniqueId))) packet.unique_id = BigInt(player.uniqueId)
    interactions.applyPacket('add_player', packet)
  }
  if (raw().phase === 'spawned') initialiseMotion()
  void depotMission.resume().catch(error => { host.shared.depotResumeError = String(error.message).slice(0,200) })
  function onSpawn () { initialiseMotion(); maybeAutoStartUserBehaviors(); tickUserBehaviors(); resumeSafety(); void loadShoreHistory(); return missionJournal.load() }
  async function onRespawn (confirmed) {
    rememberHostRespawnReceipt(confirmed)
    const reason = 'リスポーン先へ操作を引き継ぎます。'
    // stopActions releases task ownership; a lifecycle boundary must also stop
    // the base idle sender and discard the previous life's physics/history.
    inputStream?.stop(false)
    inputOwner = 'none'
    idlePhysicsState = null; idleStamp = null; idleFailureAt = 0; motionOrigin = null
    movement?.resetLifecycle?.(reason)
    host.shared.prediction = null; host.shared.motionSource = null; host.shared.idleError = null
    host.shared.lastServerMotion = null; host.shared.lastServerCorrection = null
    const cleanup = stopActionsAfterRaw(reason, confirmed)
    const results = await cleanup
    await depotMission?.interrupt(reason)
    if (results.some(result => result.status === 'rejected')) throw new Error('リスポーン前の操作の終了を確認できません。')
    while (pendingStops.size) await Promise.allSettled([...pendingStops])
    const actual = raw()
    if (confirmed?.serverConfirmed === true && confirmed.health > 0 && actual.health === confirmed.health && actual.position && confirmed.position && ['x', 'y', 'z'].every(k => actual.position[k] === confirmed.position[k])) { userBehaviorLease = null; userBehaviorSleeping = false; userBehaviorWakePending = false; userBehaviorSleepWitness = null; clearNavigationDestination() }
    inputOwner = 'none'
    observeStationaryRaw()
  }
  function physicalWorkBusy () {
    return !!(pendingStops.size || motionActive() || mining.snapshot().phase==='mining' || mining.snapshot().activeTarget || foraging?.snapshot().busy || craftStatus().pendingRequestId!=null || inventory.snapshot().busy || interactions.snapshot().pendingOperation || chest.snapshot().busy || furnace.snapshot().busy || food.snapshot().busy || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || surfaceReturn?.snapshot().busy || guardRoute?.snapshot().busy || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy || shelter?.snapshot().busy || hut?.snapshot().busy || combat?.snapshot().busy || combat?.snapshot().engaging || userBehaviorOwns())
  }
  function logicalWorkHeld () {
    if (resetHeld()) return true
    if (quarryJob?.holdsWork()) return true
    const scope=userScope(rawScope()), lease=host.shared.legacyWorkHoldLease
    if (lease) {
      if (lease.scope!==scope) { host.shared.legacyWorkHoldLease=null; if(host.shared.legacyWorkHoldScope===lease.scope)host.shared.legacyWorkHoldScope=null; return false }
      if (Date.now()<lease.expiresAt || physicalWorkBusy()) return true
      host.shared.legacyWorkHoldLease=null
      if(host.shared.legacyWorkHoldScope===lease.scope)host.shared.legacyWorkHoldScope=null
      return false
    }
    return host.shared.legacyWorkHoldScope===scope
  }
  // Test helper: scan received terrain around the bot for a dry flat area
  // (size x size columns whose top solid block is at one height, open sky-ish
  // headroom, no water/lava/hazard and no cave opening) far from hostiles.
  function findFlatArea ({ radius = 64, size = 7, step = 4, top = 120, bottom = 40, hostileClearance = 20 } = {}) {
    const p = raw().position
    if (!p) return { found: false, reason: 'position unknown' }
    const surfaceCache = new Map()
    const name = b => String(b?.name ?? '').replace('minecraft:', '')
    const surface = (x, z) => {
      const k = `${x},${z}`; if (surfaceCache.has(k)) return surfaceCache.get(k)
      let result = null
      for (let y = top; y >= bottom; y--) {
        const b = host.world.getBlock(x, y, z)
        if (!b?.known) { result = null; break }
        if (b.boundingBox === 'block') { result = /water|lava|magma|ice|leaves|log|sand|gravel/.test(name(b)) ? null : y; break }
        if (/water|lava/.test(name(b))) { result = null; break }
      }
      surfaceCache.set(k, result); return result
    }
    const hostiles = host.entities.snapshot({ kind: 'all' }).filter(e => e.hostile && e.alive !== false && e.position)
    const half = Math.floor(size / 2), out = []
    for (let cx = Math.floor(p.x) - radius; cx <= Math.floor(p.x) + radius; cx += step) for (let cz = Math.floor(p.z) - radius; cz <= Math.floor(p.z) + radius; cz += step) {
      const y = surface(cx, cz); if (y == null) continue
      let flat = true
      for (let dx = -half; dx <= half && flat; dx++) for (let dz = -half; dz <= half && flat; dz++) {
        if (surface(cx + dx, cz + dz) !== y) flat = false
        else for (const hy of [1, 2]) { const b = host.world.getBlock(cx + dx, y + hy, cz + dz); if (!b?.known || b.boundingBox !== 'empty' || /water|lava/.test(name(b))) flat = false }
      }
      if (!flat) continue
      const center = { x: cx + 0.5, y: y + 1, z: cz + 0.5 }
      const nearest = hostiles.reduce((m, e) => Math.min(m, Math.hypot(e.position.x - center.x, e.position.y - center.y, e.position.z - center.z)), Infinity)
      if (nearest < hostileClearance) continue
      out.push({ position: center, nearestHostile: Number.isFinite(nearest) ? +nearest.toFixed(1) : null, distanceFromBot: +Math.hypot(center.x - p.x, center.z - p.z).toFixed(1) })
    }
    out.sort((a, b) => (b.nearestHostile ?? 999) - (a.nearestHostile ?? 999) || a.distanceFromBot - b.distanceFromBot)
    return { found: out.length > 0, candidates: out.slice(0, 8), scannedColumns: surfaceCache.size }
  }
  // Timeline logging (host.log adds a millisecond timestamp): idle escape
  // start/end, and the first fuse observation per creeper.
  // Repeated escapes with no route and no damage (a ledge with a pit in front
  // and a wall behind) only freeze the bot: pause them for a while so normal
  // movement can take over. Damage or a hostile within 4m ends the pause.
  const ESCAPE_PAUSE_MS = 20000
  function escapePaused () {
    const stuck = host.shared.escapeStuck
    if (!stuck || Date.now() >= stuck.until) return false
    const s = raw()
    if (!(s.health >= stuck.health) || nearestHostileDistance() <= 4) { stuck.until = 0; stuck.fails = 0; return false }
    return true
  }
  function noteEscapeOutcome (failedNoRoute) {
    const stuck = host.shared.escapeStuck ??= { fails: 0, until: 0, health: null }
    const hp = raw().health
    if (!failedNoRoute) { stuck.fails = 0; return }
    if (stuck.fails === 0) stuck.health = hp
    stuck.fails++
    if (stuck.fails >= 3 && hp >= stuck.health) { stuck.until = Date.now() + ESCAPE_PAUSE_MS; stuck.fails = 0; host.log(`待機保護の退避を一時停止: 経路なしが3回続き被弾なし（${ESCAPE_PAUSE_MS / 1000}秒）`) }
  }
  function logEscapePhase (context, task) {
    const started = Date.now(), nearest = nearestHostileText()
    host.log(`待機保護の退避開始: op=${context?.operationId ?? '?'} ${nearest}`)
    return Promise.resolve(task).then(result => {
      host.log(`待機保護の退避終了: ${Date.now() - started}ms supported=${result?.supported} escaped=${result?.escaped ?? result?.ok ?? '?'} code=${result?.code ?? result?.reason ?? 'none'}`)
      try { noteEscapeOutcome(result?.supported === false && /no_known/.test(String(result?.code ?? result?.reason ?? '')) || result?.supported === true && result?.escaped === false) } catch {}
      return result
    }, error => { host.log(`待機保護の退避終了: ${Date.now() - started}ms error=${error?.code ?? error?.message ?? error}`); try { if (!/CANCELLED/.test(String(error?.code ?? error?.message ?? ''))) noteEscapeOutcome(/deadline|stalled/.test(String(error?.message ?? ''))) } catch {} throw error })
  }
  const combatExposure = createCombatExposure({ world: host.world, entities: host.entities, scopeOf: userScope })
  function combatSightEvidence (from, to) { return combatExposure.sight(from, to) }
  const bowSightClearAt = (from, to) => combatSightEvidence(from, to) === true
  function combatAttackExposure (target, state) { return combatExposure.evaluate(target, state) }
  function nearestHostileText () {
    try {
      const s = raw(), p = s.position
      const near = host.entities.snapshot({ kind: 'all' }).filter(e => e.hostile && e.alive !== false && e.position).map(e => ({ type: String(e.entityType).replace('minecraft:', ''), d: Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) })).sort((a, b) => a.d - b.d)[0]
      return near ? `nearest=${near.type}:${near.d.toFixed(1)}m` : 'nearest=none'
    } catch { return 'nearest=unknown' }
  }
  const loggedPrimedCreepers = new Set()
  function logCreeperFuse (name, packet) {
    // Cheap pre-filter first: set_entity_data is very frequent with many mobs,
    // and an entity snapshot per packet stalled the loop. Only a prime event
    // or metadata that carries a fuse entry is worth a lookup.
    if (name === 'entity_event') { if (!['creeper_prime_fuse', 32].includes(packet.event_id)) return }
    else if (name !== 'set_entity_data' || !(packet.metadata ?? []).some(entry => entry?.key === 'fuse_length' || entry?.key === 55)) return
    const runtimeId = String(packet.runtime_entity_id ?? packet.runtime_id ?? '')
    if (!runtimeId) return
    try {
      const e = host.entities.snapshot({ kind: 'all' }).find(x => String(x.runtimeId) === runtimeId)
      if (e?.entityType !== 'minecraft:creeper') return
      const primed = name === 'entity_event' ? ['creeper_prime_fuse', 32].includes(packet.event_id) : e.primed === true
      if (!primed || loggedPrimedCreepers.has(runtimeId)) return
      loggedPrimedCreepers.add(runtimeId)
      if (loggedPrimedCreepers.size > 256) loggedPrimedCreepers.delete(loggedPrimedCreepers.values().next().value)
      const p = raw().position, d = p && e.position ? Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z).toFixed(1) : '?'
      host.log(`クリーパー膨張開始: id=${runtimeId} distance=${d}m via=${name}`)
    } catch { /* Logging only. */ }
  }
  // The initial-life receipt was only prepared lazily (inventory resync or a
  // hunger refresh). Without it foodKnownLife() is null, so eating was refused
  // ("食事には確定した接続・自分の識別・ライフが必要です") and a hot reload could not
  // restore hunger. Prepare it as soon as a spawned first life lacks one.
  function ensureInitialLifeReceipt () {
    try {
      const state = raw()
      if (host.shared.deathRespawn != null || state.phase !== 'spawned' || state.dead || state.spawnPending || host.shared.loadingScreenEnded !== true || host.shared.respawnTerrain?.pending || verifiedInitialLifeReceipt()) return
      void prepareInventoryLifeReceipt().catch(() => { /* Retried on the next resume after its own throttle. */ })
    } catch { /* Throttled or scope not ready yet. */ }
  }
  // ---- quarry mode (露天掘り, spec v1.2) ----------------------------------
  function manualShulkerFile (id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error('SHULKER_RECOVERY_ID_INVALID')
    return require('node:path').resolve(__dirname, '..', '.local', 'shulker-recovery', `${id}.json`)
  }
  async function saveManualShulkerRecovery (document) {
    const { validateRecoveryDocument } = require('./manual-shulker-recovery')
    const doc = validateRecoveryDocument(document), file = manualShulkerFile(doc.id)
    if (!manualShulkerDocument || doc.id !== manualShulkerDocument.id || !isDeepStrictEqual(doc.position, manualShulkerDocument.position) || !isDeepStrictEqual(doc.world, manualShulkerDocument.world) || !isDeepStrictEqual(doc.expectedContents, manualShulkerDocument.expectedContents)) throw new Error('SHULKER_RECOVERY_DOCUMENT_CHANGED')
    const fs = require('node:fs/promises'), path = require('node:path'), tmp = `${file}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2))
    await fs.rename(tmp, file)
    manualShulkerDocument = doc
  }
  async function loadManualShulkerRecovery (id) {
    requireIdle({ inventoryRequired: false })
    const ticket = ++manualShulkerLoadSequence, generation = quarryPorts
    const fs = require('node:fs/promises'), { validateRecoveryDocument } = require('./manual-shulker-recovery')
    const file = manualShulkerFile(id), stat = await fs.stat(file)
    if (stat.size > 262144) throw new Error('SHULKER_RECOVERY_DOCUMENT_TOO_LARGE')
    const doc = validateRecoveryDocument(JSON.parse(await fs.readFile(file, 'utf8')))
    if (doc.id !== id) throw new Error('SHULKER_RECOVERY_ID_MISMATCH')
    requireIdle({ inventoryRequired: false })
    if (ticket !== manualShulkerLoadSequence || generation !== quarryPorts) throw new Error('SHULKER_RECOVERY_LOAD_INTERRUPTED')
    manualShulkerDocument = doc
    return structuredClone(doc)
  }
  const manualGroundProofCache = new Map()
  function manualRecoveryState () { return { ...quarryState(), worldRevision: host.world.revision?.() } }
  function manualGroundAccessProof (target, state) {
    const key = JSON.stringify([portableCancellationScope(), state.worldRevision, target?.runtimeId, target?.uniqueId, target?.entityType, target?.positionKnown, target?.alive, target?.hostile, target?.primed, target?.position, state.position])
    const previous = manualGroundProofCache.get(key), now = Date.now()
    if (previous && now >= previous.observedAt && now - previous.observedAt < 100) return structuredClone(previous)
    const proof = proveGroundAccess({ target, state, getBlock: (x, y, z) => host.world.getBlock(x, y, z), getWorldRevision: () => host.world.revision?.() })
    manualGroundProofCache.set(key, proof)
    while (manualGroundProofCache.size > 16) manualGroundProofCache.delete(manualGroundProofCache.keys().next().value)
    return structuredClone(proof)
  }
  function getManualShulkerRecovery () {
    if (manualShulkerRecovery) return manualShulkerRecovery
    const { createManualShulkerRecovery } = require('./manual-shulker-recovery')
    const live = () => { if (!quarryPorts) throw new Error('SHULKER_RECOVERY_MOTION_NOT_READY'); return quarryPorts }
    const own = fn => (...args) => live().own(fn)(...args)
    manualShulkerRecovery = createManualShulkerRecovery({
      getState: manualRecoveryState,
      getGroundAccessProof: manualGroundAccessProof,
      getBlock: (x, y, z) => host.world.getBlock(x, y, z),
      crafting,
      chest: {
        open: own((...args) => { requireIdle(); return chest.open(...args) }),
        snapshot: () => chest.snapshot(), rawItem: slot => chest.rawItem(slot),
        close: () => crafting.closeContainer()
      },
      refreshInventory: async ({ signal } = {}) => {
        const since = Date.now()
        signal?.throwIfAborted()
        await requestInventoryResyncWithReceipt('manual_shulker_recovery')
        while (Date.now() - since < 5000) {
          signal?.throwIfAborted()
          const r = host.shared.inventoryResync?.lastRequest
          if (r?.status === 'FRESH_MAIN_OBSERVED' && r.freshMainObserved === true && Date.parse(r.requestedAt) >= since) return true
          await delay(50)
        }
        return false
      },
      prepareHand: async ({ signal } = {}) => {
        signal?.throwIfAborted()
        const state = quarryState(), damaging = name => /_(sword|pickaxe|axe|shovel|hoe)$|^minecraft:(bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/.test(name ?? '')
        if (!damaging(state.heldItem?.name)) return { prepared: true }
        const item = state.inventory?.items?.find(item => item.count > 0 && !damaging(item.name) && item.durabilityKnown !== true)
        if (!item) throw new Error('SHULKER_RECOVERY_HAND_UNAVAILABLE')
        const receipt = await own(slot => operations.inventory.equip(slot))(item.slot)
        signal?.throwIfAborted()
        if (receipt?.serverConfirmed !== true || damaging(quarryState().heldItem?.name)) throw new Error('SHULKER_RECOVERY_HAND_UNCONFIRMED')
        return { prepared: true }
      },
      mine: async (target, { signal } = {}) => {
        signal?.throwIfAborted()
        manualShulkerRecovery.beforeInput()
        const result = await own(() => { requireIdle(); return live().mining.start([target]) })()
        manualShulkerMiningSerial = portableActionOwners.serial(mining)
        return result
      },
      getMining: () => live().getMining(),
      stopMining: (reason, owner) => portableActionOwners.cancel(mining, owner, () => mining.stop(reason)),
      moveTo: async (cell, { signal } = {}) => {
        signal?.throwIfAborted()
        manualShulkerRecovery.beforeInput()
        const generation = live()
        const target = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
        const options = { allowWater: false, maxDistance: 4, maxExpanded: 400, maxTicks: 80, signal, beforeInput: frame => manualShulkerRecovery.beforeInput(frame) }
        const preview = generation.movement.preview(target, options)
        if (preview?.ready !== true) throw new Error('SHULKER_RECOVERY_PICKUP_ROUTE_UNCONFIRMED')
        own(() => { requireIdle(); return generation.movement.start(target, options) })()
        const since = Date.now()
        for (;;) {
          signal?.throwIfAborted()
          manualShulkerRecovery.beforeInput()
          if (live() !== generation) throw new Error('SHULKER_RECOVERY_GENERATION_CHANGED')
          const progress = generation.getMovement()
          const state = quarryState(), feet = state.position && { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
          const grounded = (state.predicted?.physicsState ?? state.physicsState)?.onGround !== false
          const near = feet && Math.hypot(feet.x - target.x, feet.z - target.z) <= 0.35 && Math.abs(feet.y - target.y) <= 0.1
          if (near && grounded && ['completed', 'idle', 'awaiting_server_confirmation', 'replan_required'].includes(progress?.phase)) return progress
          if (['failed', 'stopped'].includes(progress?.phase)) throw new Error(progress?.reason ?? 'SHULKER_RECOVERY_PICKUP_MOVE_FAILED')
          if (Date.now() - since >= 10000) throw new Error('SHULKER_RECOVERY_PICKUP_MOVE_TIMEOUT')
          await delay(50)
        }
      },
      getEntities: () => host.entities.snapshot({ kind: 'all' }),
      canAct: () => !disposed && !disposing && !replaying && !pendingStops.size && !userBehaviorOwns() && !host.shared.autoWanted && !host.shared.userBehaviorsEnabled && !idleSafety?.snapshot().busy && !idleSafety?.snapshot().active && !idleSafety?.snapshot().cleanupUnconfirmed && !['scheduled', 'in_flight'].includes(host.shared.safetyEmergency?.status) && !quarryJob?.holdsWork() && host.entities.stats().unknownPositions === 0 && host.shared.loadingScreenEnded === true && !host.shared.respawnTerrain?.pending,
      captureActionOwner: (kind, operation) => portableActionOwners.createOwner({ ...operation, kind, generation: live(), revision: quarryCancellationRevision, scope: portableCancellationScope() }),
      runActionOwned: (owner, fn) => portableActionOwners.run(owner, fn),
      cancelAction: (kind, reason, owner) => {
        if (kind === 'movement' || kind === 'move') owner?.context?.generation?.cancelPortableMovement(owner, reason)
        else if (kind === 'mining' || kind === 'mine') portableActionOwners.cancel(mining, owner, () => mining.stop(reason))
        else if (kind === 'equip') portableActionOwners.cancel(inventory, owner, () => inventory.cancel(reason))
        else if (kind === 'open' || kind === 'chest') {
          portableActionOwners.cancel(chest, owner, () => chest.cancel(reason))
          portableActionOwners.cancel(interactions, owner, () => interactions.cancel(reason))
        }
      }
    })
    return manualShulkerRecovery
  }
  function runManualShulkerRecovery () {
    requireIdle()
    if (manualShulkerTask || !manualShulkerDocument) throw new Error('SHULKER_RECOVERY_NOT_LOADED_OR_BUSY')
    manualShulkerLoadSequence++
    const controller = getManualShulkerRecovery(), abort = new AbortController()
    manualShulkerAbort = abort
    stopIdleStream()
    const task = controller.run(structuredClone(manualShulkerDocument), { signal: abort.signal, onCheckpoint: saveManualShulkerRecovery })
    manualShulkerTask = task
    return Promise.resolve(task).finally(() => {
      if (manualShulkerTask === task) { manualShulkerTask = null; manualShulkerAbort = null; manualShulkerMiningSerial = null }
    })
  }

  function quarryDir () { return require('node:path').resolve(__dirname, '..', '.local', 'quarry') }
  const quarryStorage = createQuarryStore({
    directory: quarryDir(),
    onSaved: doc => {
      if (!disposed && quarryJob?.document()?.instanceId === doc.instanceId) host.shared.quarryDocument = doc
    }
  })
  let quarryLoadSequence = 0
  let quarryRestoreTask = null
  function cancelQuarryRestore () {
    quarryLoadSequence++
    host.shared.quarryRestoreDisabled = true
    host.shared.quarryRestoreTried = true
  }
  function quarryEvidence (target, state) {
    const exposure = combatAttackExposure(target, state)
    return { route: exposure.evidence.routeToBot, sight: exposure.evidence.sight, intercept: exposure.intercept, unknown: exposure.unknown }
  }
  function quarryCanSelectTarget (target, state, info = {}) { return quarryJob?.holdsWork() ? quarryJob.bridge.canSelectTarget(target, state, { ...quarryEvidence(target, state), provoked: info.provoked === true }) : { allowed: true, reason: 'NO_QUARRY_JOB' } }
  function quarryCanContinue (target, state, info = {}) { return quarryJob?.holdsWork() ? quarryJob.bridge.canContinue(target, state, { ...quarryEvidence(target, state), provoked: info.provoked === true, retreating: info.retreating === true || quarryRetreatDepth > 0 }) : { allowed: true, reason: 'NO_QUARRY_JOB' } }
  function quarryState () {
    const state = lightweightUserState()
    const hunger = host.shared.vitals?.hunger
    return { ...state, food: Number.isFinite(hunger) ? hunger : Number.isFinite(hunger?.value) ? hunger.value : state.food ?? null, deathCause: host.shared.deathRespawn?.cause ?? null, inventory: host.shared.inventoryUncertain ? { ...state.inventory, uncertain: true } : state.inventory }
  }
  function confirmQuarryPosition (feet, settings) {
    quarryPositionVerifier ??= createServerPositionVerifier({ client: host.client, getState: quarryState })
    return quarryPositionVerifier.confirm(feet, settings)
  }
  function requestQuarryTerrain (request, settings) {
    quarryTerrainRequester ??= createQuarryTerrainRequester({ client: host.client, getState: quarryState, world: host.world })
    return quarryTerrainRequester.request(request, settings)
  }
  async function runQuarryEgress (adapter, live, own, request, options = {}) {
    if (quarryEgressTask) throw new Error('EGRESS_BUSY')
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const read = quarryBlockReader(), config = quarryJob?.document()?.config ?? {}
    const policy = { ...(config.tools ?? {}), ...(config.collection ?? {}) }
    const runner = createQuarryEgressRuntime({
      getState: quarryState, getBlock: read,
      confirmPosition: (feet, settings) => confirmQuarryPosition(feet, settings),
      moveTo: (cell, settings) => {
        if (!permitsExitAction(request.plan, 'travel', cell)) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
        return adapter.moveTo(cell, settings)
      },
      mineTargets: async (targets, settings = {}) => {
        for (const target of targets) {
          signal.throwIfAborted(); settings.signal?.throwIfAborted()
          const p = target.position
          if (!permitsExitAction(request.plan, 'break', p)) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
          const block = read(p.x, p.y, p.z)
          if (block?.known && ['air', 'cave_air', 'void_air'].includes(quarryNameOf(block))) continue
          if (block?.known !== true || block.protected || block.protectionSource || block.name !== target.name || block.extra?.length) throw new Error('EGRESS_TARGET_CHANGED')
          const state = quarryState(), rule = require('./quarry-exit-plan').exitDigRule(block.name)
          const tool = quarrySelectTool(rule, state.inventory?.items, policy)
          if (!tool.ok) throw new Error('EXIT_TOOL_MISSING')
          if (tool.kind !== 'hand') await adapter.prepareMining(tool, { signal })
          else {
            const hand = state.inventory?.items?.find(item => item.count > 0 && item.durabilityKnown !== true && !/_(sword|pickaxe|axe|shovel|hoe)$|:(bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/.test(item.name ?? ''))
            if (!hand) throw new Error('EXIT_HAND_ITEM_REQUIRED')
            await own(slot => { requireIdle(); return inventory.equip(slot) })(hand.slot)
          }
          signal.throwIfAborted()
          await adapter.mine([{ ...p, expectedName: block.name, expectedRuntimeId: block.runtimeId ?? target.expectedRuntimeId ?? null, requiredTool: tool.kind === 'hand' ? null : tool, ...(request.allowFullInventory === true ? { allowFullInventory: true } : {}), ...(rule.exitOre ? { exitShaftOre: true } : {}) }], { signal })
        }
        return { phase: 'completed' }
      },
      pillarStep: (step, settings) => {
        if (!permitsExitAction(request.plan, 'place', { ...step.column, y: step.feetY })) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
        return live().pillarStep(step, settings)
      }
    })
    quarryEgressRuntime = runner; quarryEgressAbort = controller
    const task = runner.run(request, { ...options, signal })
    quarryEgressTask = task
    try { return await task } finally {
      if (quarryEgressTask === task) { quarryEgressTask = null; quarryEgressAbort = null }
    }
  }
  // A bounded local diagnostic exercises the same controller without editing
  // the quarry cursor or granting mining permissions. It only uses the current
  // received column and is available while the job is paused.
  async function testQuarryPillar ({ steps = 1 } = {}) {
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 3) throw new Error('検証する土柱は1〜3段で指定してください。')
    if (!quarryPorts || quarryEgressTask || quarryPillarTask || quarryJob?.holdsWork() || userBehaviorOwns() || idleSafety?.snapshot().busy || pendingStops.size) throw new Error('土柱の検証を始められる待機状態ではありません。')
    const state = quarryState(), source = state.position
    if (state.phase !== 'spawned' || !(state.health > 0) || !source) throw new Error('ASCENT_NOT_ALIVE')
    const feet = { x: Math.floor(source.x), y: Math.floor(source.y - 1.62 + 1e-3), z: Math.floor(source.z) }
    const job = ensureQuarryJob(), document = job.document()
    if (document?.state !== 'PAUSED') throw new Error('露天掘りを一時停止してから土柱を検証してください。')
    const adapterMove = createQuarryRuntimeAdapter({ getState: quarryState, getBlock: quarryBlockReader(), entities: () => [], mining: quarryPorts.mining, movement: quarryPorts.movement, getMining: quarryPorts.getMining, getMovement: quarryPorts.getMovement, stopAll: () => {}, combatActive: () => false })
    const controller = new AbortController(), signal = controller.signal
    const operationId = 'pillar-validation:' + Date.now(), receipts = []
    quarryEgressAbort = controller
    const task = (async () => {
      await adapterMove.moveTo(feet, { signal })
      for (let i = 0; i < steps; i++) {
        signal.throwIfAborted()
        const result = await quarryPorts.pillarStep({ jobId: document.config.jobId, operationId, column: { x: feet.x, z: feet.z }, feetY: feet.y + i }, { signal, onCheckpoint: async checkpoint => { host.shared.quarryPillarValidation = structuredClone(checkpoint) } })
        receipts.push(result)
        if (result.status !== 'completed' || result.serverConfirmed !== true) return { status: 'blocked', reason: result.reason, serverConfirmed: false, operationId, origin: feet, receipts }
      }
      return { status: 'completed', serverConfirmed: true, operationId, origin: feet, steps, receipts }
    })()
    quarryEgressTask = task
    try { return await task } finally { if (quarryEgressTask === task) { quarryEgressTask = null; quarryEgressAbort = null } }
  }
  // The planner reads thousands of cells per decision. planningWorld.getBlock
  // re-derives its protection overlays on every call, which can hold the event
  // loop long enough to stall the movement input timer, so reads are memoised
  // until the world revision changes (or for at most one second).
  function quarryBlockReader () {
    let cache = new Map(), revision = -1, at = 0
    return (x, y, z) => {
      const rev = typeof host.world.revision === 'function' ? host.world.revision() : null, t = Date.now()
      if (rev !== revision || t - at > 1000) { cache = new Map(); revision = rev; at = t }
      const k = x + ',' + y + ',' + z
      let b = cache.get(k)
      if (b === undefined) { b = planningWorld.getBlock(x, y, z); cache.set(k, b) }
      return b
    }
  }
  // Quarry storage expansion: one more chest at the first candidate cell that
  // works. It reuses the depot storage controller, one primitive per step: a
  // carried chest is placed directly; otherwise planks are crafted from
  // carried logs, a crafting table is used (a nearby one, or one crafted and
  // placed at another candidate), and the chest is crafted and placed. Only a
  // server-confirmed chest block counts; nothing comes from commands.
  let quarryChestWork = null
  // Torches for the chest area (quarry). Crafted normally from carried coal or
  // charcoal plus sticks (planks from a carried log if needed); never by command.
  async function quarryCraftTorches ({ want = 8, signal } = {}) {
    const inv = () => lightweightUserState().inventory?.items ?? []
    const count = re => inv().filter(i => re.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
    const torches = () => count(/^minecraft:torch$/)
    if (torches() >= want) return { ok: true, torches: torches() }
    if (!count(/^minecraft:(coal|charcoal)$/)) return { ok: torches() > 0, reason: 'NO_COAL', torches: torches() }
    const made = []
    try {
      await crafting.openInventory()
      for (let guard = 0; guard < 6 && torches() < want && count(/^minecraft:(coal|charcoal)$/); guard++) {
        if (signal?.aborted) throw new Error('quarry torch crafting aborted')
        if (!count(/^minecraft:stick$/)) {
          if (!count(/_planks$/)) {
            const log = inv().find(i => /^minecraft:[a-z_]+_log$/.test(i.name ?? '') && !/stripped/.test(i.name))
            if (!log) return { ok: torches() > 0, reason: 'NO_WOOD', torches: torches(), made }
            await crafting.craft(log.name.replace(/_log$/, '_planks'), { times: 1 }); made.push('planks')
          }
          await crafting.craft('minecraft:stick', { times: 1 }); made.push('stick')
        }
        await crafting.craft('minecraft:torch', { times: 1 }); made.push('torch')
      }
    } catch (error) { return { ok: torches() > 0, reason: 'CRAFT_FAILED', error: String(error.message).slice(0, 160), torches: torches(), made } }
    finally { try { crafting.closeContainer() } catch {} }
    return { ok: torches() > 0, torches: torches(), made }
  }
  async function quarryPlaceTorch ({ position, signal } = {}) {
    let item = (lightweightUserState().inventory?.items ?? []).find(i => i.name === 'minecraft:torch' && i.count > 0)
    if (!item) return { ok: false, reason: 'NO_TORCH' }
    if (item.slot > 8) { await operations.inventory.equip(item.slot); item = (lightweightUserState().inventory?.items ?? []).find(i => i.name === 'minecraft:torch' && i.count > 0 && i.slot <= 8) }
    if (!item) return { ok: false, reason: 'TORCH_NOT_IN_HOTBAR' }
    if (signal?.aborted) throw new Error('quarry torch placement aborted')
    await interactions.placeBlock({ position, slot: item.slot, face: 1 })
    const b = host.world.getBlock(position.x, position.y, position.z)
    return { ok: b?.known === true && b.name === 'minecraft:torch', block: b?.name ?? null }
  }
  async function quarryAddChest ({ candidates = [], signal } = {}) {
    quarryChestWork ??= createDepotStorageWork({ getState: () => lightweightUserState(), world: host.world, crafting, interactions, chest, inventory })
    const isAir = p => { const b = host.world.getBlock(p.x, p.y, p.z); return b?.known === true && /^minecraft:(air|cave_air|void_air)$/.test(b.name) }
    const tried = []
    const crafted = []
    try {
      // The job walks to a stand beside candidates[0] before each call; the
      // other cells are only spare places for a crafting table.
      for (const cell of candidates.slice(0, 1)) {
        let lastKind = null
        for (let step = 0; step < 32; step++) {
          if (signal?.aborted) throw new Error('quarry add chest aborted')
          const b = host.world.getBlock(cell.x, cell.y, cell.z)
          if (b?.known === true && b.name === 'minecraft:chest') return { ok: true, position: { ...cell }, crafted }
          const state = lightweightUserState()
          const near = state.position ? host.world.getArea({ x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }, 3) : []
          const table = near.filter(x => x.known && x.name === 'minecraft:crafting_table').sort((a, c) => Math.hypot(a.position.x - state.position.x, a.position.z - state.position.z) - Math.hypot(c.position.x - state.position.x, c.position.z - state.position.z))[0]?.position ?? null
          const tableCell = candidates.find(c => (c.x !== cell.x || c.y !== cell.y || c.z !== cell.z) && isAir(c) && Math.abs(c.x - cell.x) + Math.abs(c.z - cell.z) >= 2) ?? null
          const options = { scope: continuationScope(state), storageCell: cell, tablePosition: table, tableCell }
          const decision = quarryChestWork.preview(options)
          lastKind = decision.kind
          if (decision.kind === 'need_logs') return { ok: false, reason: 'NO_CHEST_MATERIAL', needs: { logs: decision.count ?? 2, planks: decision.missingPlanks ?? null }, crafted }
          if (['need_access', 'need_equip', 'need_table_cell', 'blocked', 'verify_chest_ownership', 'observe_inventory'].includes(decision.kind)) { tried.push({ cell, kind: decision.kind, reason: decision.reason ?? decision.errors?.[0] ?? null }); break }
          const result = await quarryChestWork.step(options, { signal })
          if (decision.kind === 'craft') crafted.push(decision.output)
          if (result?.phase === 'failed') { tried.push({ cell, kind: decision.kind, reason: result.reason ?? null }); break }
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        if (lastKind && !tried.some(t => t.cell === cell)) tried.push({ cell, kind: lastKind, reason: 'STEP_LIMIT' })
      }
    } finally { try { crafting.closeContainer() } catch {} }
    return { ok: false, reason: 'NO_PLACEABLE_CELL', tried: tried.slice(0, 6), crafted }
  }
  // Set by ensureQuarryJob: the guarded surface chest runner (manual storage).
  let quarrySurfaceChestRunner = null
  function ensureQuarryJob () {
    if (quarryJob) return quarryJob
    if (disposed || disposing) throw new Error('行動コードを更新しています。少し待ってからやり直してください。')
    if (!quarryPorts) throw new Error('移動・採掘の準備がまだ終わっていません。スポーン後にやり直してください。')
    // Ports are looked up on every call: a teleport or respawn starts a new
    // input generation, and ports captured when the job was created would then
    // refuse every move/mine ("スポーン前の操作は終了しました") until a reload.
    const live = () => { if (!quarryPorts) throw new Error('移動・採掘の準備がまだ終わっていません。'); return quarryPorts }
    const own = fn => (...args) => live().own(fn)(...args)
    const ports = {
      mining: { preview: (...a) => live().mining.preview(...a), start: (...a) => live().mining.start(...a), stop: (...a) => live().mining.stop(...a) },
      movement: { preview: (...a) => live().movement.preview(...a), start: (...a) => live().movement.start(...a), stop: (...a) => live().movement.stop(...a) },
      getMining: () => live().getMining(), getMovement: () => live().getMovement()
    }
    let portableOwnedWindow = null
    const containerPorts = {
      open: own(async (position, slot, settings) => {
        requireIdle(); crafting.closeContainer()
        const owner = portableActionOwners.currentOwner(), pending = chest.open(position, slot, settings)
        const chestSerial = portableActionOwners.serial(chest), interactionSerial = portableActionOwners.serial(interactions)
        const result = await pending
        const window = chest.snapshot().window, open = crafting.snapshot().openContainer
        if (owner && portableActionOwners.isCurrent(owner) && result?.serverConfirmed === true && window && open && Number.isSafeInteger(window.epoch) && ['x', 'y', 'z'].every(axis => window.position?.[axis] === position[axis]) && sameWindowId(window.id, open.id) && sameWindowId(result.windowId, open.id) && portableActionOwners.serial(chest) === chestSerial && portableActionOwners.serial(interactions) === interactionSerial) portableOwnedWindow = { owner, epoch: window.epoch, id: canonicalWindowId(open.id), type: String(open.type), interactionSerial }
        return result
      }),
      depositItem: own(settings => { requireIdle(); return chest.depositItem(settings) }),
      withdrawItem: own(settings => { requireIdle(); return chest.withdrawItem(settings) }),
      snapshot: () => chest.snapshot(), rawItem: slot => chest.rawItem(slot), close: () => crafting.closeContainer()
    }
    let surfaceChestController = null
    const verifySurfaceChestOwner = () => {
      const owner = host.shared.quarrySurfaceStorageOwner
      owner?.signal?.throwIfAborted()
      if (owner && (disposed || disposing || owner.scope !== portableCancellationScope() || owner.revision !== quarryCancellationRevision)) throw Object.assign(new Error('SURFACE_STORAGE_INTERRUPTED'), { code: 'SURFACE_STORAGE_INTERRUPTED' })
    }
    quarrySurfaceChestRunner = (method, request, options) => runSurfaceChest(method, request, options)
    async function runSurfaceChest (method, request, options = {}) {
      options.signal?.throwIfAborted()
      if (host.shared.quarrySurfaceStorageOwner) throw Object.assign(new Error('SURFACE_STORAGE_BUSY'), { code: 'SURFACE_STORAGE_BUSY' })
      const owner = { scope: portableCancellationScope(), revision: quarryCancellationRevision, signal: options.signal }
      host.shared.quarrySurfaceStorageOwner = owner
      try {
        verifySurfaceChestOwner()
        const result = await surfaceChest()[method](request, options)
        verifySurfaceChestOwner()
        return result
      } finally {
        if (host.shared.quarrySurfaceStorageOwner === owner) delete host.shared.quarrySurfaceStorageOwner
      }
    }
    function surfaceChest () {
      if (surfaceChestController) return surfaceChestController
      return surfaceChestController = createQuarryV22ChestWork({
        getState: () => { verifySurfaceChestOwner(); return quarryState() },
        getView: () => inventoryInspection.snapshot(quarryState()),
        getRawMain: slot => crafting.rawItem(slot),
        getRawChest: slot => chest.rawItem(slot),
        getRawEquipment: (kind, slot) => inventoryInspection.rawEquipment(kind, slot),
        open: (position, slot, options) => containerPorts.open(position, slot, options),
        close: () => crafting.closeContainer(),
        withdraw: params => containerPorts.withdrawItem(params),
        deposit: params => containerPorts.depositItem(params),
        equipArmor: opts => armor.equipBest(opts),
        equipmentTransfer: params => quarryV22Equipment.transfer(params),
        resync: opts => adapter.resyncInventory(opts)
      })
    }
    function getSupplies () {
      return quarrySupplies ??= createQuarrySupplies({
        getState: quarryState, crafting, chest: containerPorts, getPortable,
        refreshInventory: options => adapter.resyncInventory(options)
      })
    }
    async function preparePortablePlacement (context, { signal } = {}) {
      const generation = live(), initial = quarryState(), scope = observedScope(initial)
      const fields = { profile: initial.profile, realmId: String(initial.realm?.id), dimension: initial.dimension, connectionId: initial.connectionId, startedAt: initial.startedAt, runtimeEntityId: String(initial.runtimeEntityId), life: initial.lifecycle?.deathId }
      if (!scope || !context?.scope || Object.keys(fields).some(key => fields[key] !== context.scope[key])) throw Object.assign(new Error('収納設置の接続範囲を確認できません。'), { code: 'STORAGE_SCOPE_CHANGED' })
      if (quarryPlacementPreparation) throw Object.assign(new Error('別の設置準備が進行中です。'), { code: 'STORAGE_PLACEMENT_NOT_SETTLED' })
      const prep = { history: inputHistory, revision: quarryCancellationRevision, frame: null }
      quarryPlacementPreparation = prep
      let lastTick = null, lastPosition = null, stableFrames = 0, health = initial.health
      const deadline = Date.now() + 4000
      const check = () => {
        signal?.throwIfAborted()
        const state = quarryState()
        if (disposed || disposing || live() !== generation || inputHistory !== prep.history || quarryCancellationRevision !== prep.revision || observedScope(state) !== scope || state.health < health || userBehaviorOwns()) throw Object.assign(new Error('収納設置準備が中断されました。'), { code: 'STORAGE_PREPARATION_INTERRUPTED' })
        health = Math.max(health, state.health)
        return state
      }
      try {
        while (Date.now() < deadline) {
          const state = check(), motion = generation.getMovement(), physical = state.predicted?.physicsState ?? state.physicsState
          const feet = state.position && { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
          if (motion.running || motionActive() || generation.getMining()?.phase === 'mining' || input?.stats().running || armorTask || manualArmorOwner) {
            stableFrames = 0; await delay(50); continue
          }
          // Keep only the existing neutral physics stream running; never stop
          // another movement owner or replace an observed position to settle.
          startIdle()
          const frame = prep.frame
          const ready = physical?.onGround === true && !physical.isInWater && !physical.isInLava && generation.standingClear(state, feet) && frame && Date.now() - frame.at >= 0 && Date.now() - frame.at <= 200 && Math.hypot(frame.position.x - state.position.x, frame.position.y - state.position.y, frame.position.z - state.position.z) <= 0.03
          if (!ready) { stableFrames = 0; lastPosition = null }
          else if (frame.tick !== lastTick) {
            stableFrames = lastPosition && Math.hypot(lastPosition.x - state.position.x, lastPosition.y - state.position.y, lastPosition.z - state.position.z) <= 0.01 ? stableFrames + 1 : 1
            lastTick = frame.tick; lastPosition = { ...state.position }
          }
          if (stableFrames >= 3) {
            const proof = await controlLocation.confirm(feet, { signal, radius: 0.12, operationId: context.operationId + ':prepare_placement' })
            const after = check()
            if (proof?.serverConfirmed === true && Date.now() < deadline && generation.standingClear(after, { x: after.position.x, y: after.position.y - 1.62, z: after.position.z }) && Math.hypot(after.position.x - state.position.x, after.position.y - state.position.y, after.position.z - state.position.z) <= 0.03) return { ready: true, proof }
            stableFrames = 0; lastPosition = null
          }
          await delay(50)
        }
        throw Object.assign(new Error('収納設置前の着地と実位置がまだ安定していません。'), { code: 'STORAGE_PLACEMENT_NOT_SETTLED' })
      } finally { if (quarryPlacementPreparation === prep) quarryPlacementPreparation = null }
    }
    async function reconcileCurrentPortablePlacement (request, options = {}) {
      const cp = request?.checkpoint
      if (request?.manual !== true || !cp?.scope || cp.intent?.type !== 'place') throw new Error('STORAGE_CURRENT_AUDIT_MANUAL_REQUIRED')
      await own(preparePortablePlacement)({ jobId: request.jobId, operationId: request.operationId, scope: cp.scope }, { signal: options.signal })
      const generation = live(), state = quarryState(), stream = inputStream, scope = observedScope(state)
      if (quarryPlacementPreparation || !scope || !stream?.drainQueued) throw new Error('STORAGE_CURRENT_AUDIT_BUSY')
      const owner = { kind: 'current_storage_audit', history: inputHistory, revision: quarryCancellationRevision, generation, stream, scope, request, signal: options.signal, health: state.health, startedAt: Date.now(), deadline: Date.now() + 20000 }
      quarryPlacementPreparation = owner
      try {
        requireCurrentPlacementAudit(owner)
        owner.drain = stream.drainQueued(); inputOwner = 'none'
        if (owner.drain.queuedTransaction !== false || owner.drain.queuedActions !== 0) throw new Error('STORAGE_CURRENT_AUDIT_QUEUE_PENDING')
        owner.transactionGeneration = owner.drain.revision
        startIdle()
        const current = requireCurrentPlacementAudit(owner), feet = { ...current.position, y: current.position.y - 1.62 }
        // Input and commands share Bedrock's RELIABLE_ORDERED channel 0.
        // This fresh reply follows all earlier queued input on this connection.
        const positionReceipt = await controlLocation.confirm(feet, { signal: options.signal, radius: 0.12, operationId: request.operationId + ':current_fence' })
        requireCurrentPlacementAudit(owner)
        if (positionReceipt?.serverConfirmed !== true || positionReceipt.receivedAt < owner.drain.drainedAt) throw new Error('STORAGE_CURRENT_AUDIT_FENCE_UNCONFIRMED')
        owner.fence = { kind: 'drained_input_and_server_position_barrier', generation: host.shared.loadoutGeneration, transactionGeneration: owner.transactionGeneration, startedAt: owner.drain.drainedAt, receivedAt: positionReceipt.receivedAt, drain: structuredClone(owner.drain), positionReceipt }
        return await getPortable().reconcileCurrentPlacement(request, options)
      } finally {
        if (quarryPlacementPreparation === owner) quarryPlacementPreparation = null
      }
    }
    function requireCurrentPlacementAudit (owner) {
      const state = quarryState(), stats = owner.stream.stats()
      if (owner.signal?.aborted || disposed || disposing || Date.now() >= owner.deadline || quarryPlacementPreparation !== owner || live() !== owner.generation || inputStream !== owner.stream || inputHistory !== owner.history || quarryCancellationRevision !== owner.revision || observedScope(state) !== owner.scope || state.health < owner.health || userBehaviorOwns() || motionActive() || input?.stats().running || mining.snapshot().phase === 'mining' || armorTask || manualArmorOwner || chest.snapshot().busy || inventory.snapshot().busy || craftStatus().pendingRequestId != null || interactions.snapshot().pendingOperation != null || owner.transactionGeneration !== undefined && (stats.queuedActions !== 0 || stats.queuedTransaction !== false || stats.actionRevision !== owner.transactionGeneration)) throw new Error('STORAGE_CURRENT_AUDIT_INTERRUPTED')
      owner.health = Math.max(owner.health, state.health)
      return state
    }
    async function confirmCurrentPlacementState (context, { signal } = {}) {
      const owner = quarryPlacementPreparation, cp = owner?.request?.checkpoint
      if (owner?.kind !== 'current_storage_audit' || !owner.fence || context.jobId !== cp?.jobId || context.operationId !== cp.operationId || JSON.stringify(context.scope) !== JSON.stringify(cp.scope) || ['x', 'y', 'z'].some(axis => context.position?.[axis] !== cp.intent.position[axis]) || context.slot !== cp.intent.slot || context.sourceStackId !== cp.placementSourcePin?.stackId) throw new Error('STORAGE_CURRENT_AUDIT_OWNER_CHANGED')
      signal?.throwIfAborted(); requireCurrentPlacementAudit(owner)
      storagePlacementAudit ??= createStoragePlacementAudit({ client: host.client, getState: quarryState })
      const targetAirReceipt = await storagePlacementAudit.confirmAir(context.position, { signal, operationId: cp.operationId })
      const state = requireCurrentPlacementAudit(owner), feet = { ...state.position, y: state.position.y - 1.62 }
      if (targetAirReceipt?.serverConfirmed !== true || targetAirReceipt.scope !== owner.scope) throw new Error(targetAirReceipt?.reason ?? 'STORAGE_CURRENT_TARGET_UNCONFIRMED')
      const positionReceipt = await controlLocation.confirm(feet, { signal, radius: 0.12, operationId: cp.operationId + ':current_after_air' })
      requireCurrentPlacementAudit(owner); signal?.throwIfAborted()
      if (positionReceipt?.serverConfirmed !== true || positionReceipt.scope !== owner.scope) throw new Error('STORAGE_CURRENT_POSITION_UNCONFIRMED')
      return { serverConfirmed: true, kind: 'current_placement_state', scope: structuredClone(cp.scope), jobId: cp.jobId, operationId: cp.operationId, position: structuredClone(context.position), targetAir: true, quiet: true, generation: host.shared.loadoutGeneration, transactionGeneration: owner.transactionGeneration, observedAt: positionReceipt.receivedAt, requestId: targetAirReceipt.requestId, fence: structuredClone(owner.fence), targetAirReceipt, positionReceipt }
    }
    function getPortable () {
      return quarryPortableStorage ??= createQuarryPortableStorage({ shulkerOnly: true,
        getState: quarryState,
        getObservationFreshness: () => ({
          inventoryObservedAt: inventoryInspection.snapshot(quarryState()).observedAt,
          inventoryResync: host.shared.inventoryResync?.lastRequest ?? null
        }),
        onRecoveryDiagnostic: diagnostic => {
          const summary = {
            operationId: diagnostic.operationId, scope: diagnostic.scope, stage: diagnostic.stage,
            checks: Object.fromEntries(Object.entries(diagnostic.checks).map(([name, check]) => [name, check.status])),
            baselineCount: diagnostic.baseline.count, actualCount: diagnostic.actual.count,
            candidateIds: diagnostic.actual.candidateIds, freshness: diagnostic.freshness
          }
          host.log(`収納回収照合: ${JSON.stringify(summary)}`)
          for (const candidate of diagnostic.candidates) {
            host.log(`収納回収内容差分: ${JSON.stringify({ operationId: diagnostic.operationId, slot: candidate.slot, stackId: candidate.stackId, status: candidate.contents.status, reason: candidate.contents.reason ?? null, differences: candidate.contents.differences, truncated: candidate.contents.truncated })}`)
          }
        },
        captureActionOwner: (kind, operation) => portableActionOwners.createOwner({ ...operation, kind, generation: live(), revision: quarryCancellationRevision, scope: portableCancellationScope() }),
        runActionOwned: (owner, fn) => portableActionOwners.run(owner, fn),
        getBlock: (x, y, z) => host.world.getBlock(x, y, z),
        crafting,
        chest: containerPorts,
        workWithContainer: (context, options) => getSupplies().workWithContainer(context, options),
        interactions: {
          snapshot: () => interactions.snapshot(),
          previewPlace: settings => interactions.previewPlace(settings),
          placeBlock: own(settings => { requireIdle(); crafting.closeContainer(); return interactions.placeBlock(settings) })
        },
        equip: own(slot => operations.inventory.equip(slot)),
        moveTo: (cell, settings) => adapter.moveTo(cell, settings),
        getPath: (origin, goal, owner) => ensureQuarryJob().portablePath(origin, goal, owner),
        travel: (position, owner) => ensureQuarryJob().portableTravel(position, owner),
        previewMove: cell => ports.movement.preview({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, { allowWater: false, maxDistance: 8, maxExpanded: 500 }),
        refreshInventory: ({ signal }) => adapter.resyncInventory({ signal }),
        preparePlacement: own(preparePortablePlacement),
        confirmPlacementState: confirmCurrentPlacementState,
        mine: async (target, { signal } = {}) => {
          signal?.throwIfAborted()
          // A cargo shulker's v2.2 break must preserve the selected pickaxe.
          // Normal supply / legacy recovery without requiredTool retains the
          // original non-damaging item behavior.
          if (target.requiredTool?.kind === 'pickaxe') {
            const hand = quarryState().heldItem
            if (!hand?.name || !/_(?:pickaxe)$/.test(hand.name) ||
                hand.durabilityKnown !== true ||
                !Number.isFinite(hand.durabilityRemaining) ||
                hand.durabilityRemaining <= target.requiredTool.reserve) {
              throw Object.assign(new Error('SHULKER_PICKAXE_UNCONFIRMED'), { code: 'SHULKER_PICKAXE_UNCONFIRMED' })
            }
          } else {
            const state = quarryState()
            const damaging = name => /_(sword|pickaxe|axe|shovel|hoe)$|^minecraft:(bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/.test(name ?? '')
            if (damaging(state.heldItem?.name)) {
              const held = state.inventory?.items?.find(item => item.count > 0 && !damaging(item.name) && item.durabilityKnown !== true)
              if (!held) throw new Error('箱回収に使う非耐久アイテムがありません。')
              await own(slot => operations.inventory.equip(slot))(held.slot)
            }
          }
          signal?.throwIfAborted()
          crafting.closeContainer()
          return ports.mining.start([target])
        },
        getMining: () => ports.getMining(), stopMining: (reason, owner) => portableActionOwners.cancel(mining, owner, () => mining.stop(reason)),
        getEntities: () => host.entities.snapshot({ kind: 'all' }),
        cancelAction: (kind, reason, owner) => {
          if (kind === 'equip') portableActionOwners.cancel(inventory, owner, () => inventory.cancel(reason))
          else if (kind === 'place' || kind === 'interaction') portableActionOwners.cancel(interactions, owner, () => interactions.cancel(reason))
          else if (kind === 'open' || kind === 'deposit' || kind === 'chest') {
            const proof = portableOwnedWindow, expected = proof?.owner?.context, actual = owner?.context
            const window = chest.snapshot().window, open = crafting.snapshot().openContainer
            const closeOwned = portableActionOwners.isCurrent(owner) && proof && expected?.generation === actual?.generation && expected?.revision === actual?.revision && expected?.scope === actual?.scope && expected?.jobId === actual?.jobId && expected?.operationId === actual?.operationId && window?.epoch === proof.epoch && sameWindowId(window?.id, proof.id) && sameWindowId(open?.id, proof.id) && String(open?.type) === proof.type && portableActionOwners.serial(interactions) === proof.interactionSerial
            portableActionOwners.cancel(chest, owner, () => chest.cancel(reason))
            portableActionOwners.cancel(interactions, owner, () => interactions.cancel(reason))
            if (closeOwned) { portableOwnedWindow = null; crafting.closeContainer() }
          } else if (kind === 'mine' || kind === 'mining') {
            portableActionOwners.cancel(inventory, owner, () => inventory.cancel(reason))
            portableActionOwners.cancel(mining, owner, () => mining.stop(reason))
          } else if (kind === 'move' || kind === 'movement') owner?.context?.generation?.cancelPortableMovement(owner, reason)
        }
      })
    }
    const adapter = createQuarryRuntimeAdapter({
      getState: quarryState,
      getBlock: quarryBlockReader(),
      requestTerrain: (request, options) => requestQuarryTerrain(request, options),
      confirmPosition: (feet, options) => confirmQuarryPosition(feet, options),
      // A prediction the server-position witness disproved (2026-11-13) is
      // discarded; the received raw position is never rewritten.
      discardPrediction: reason => discardWorkingPrediction(reason),
      rawItem: slot => crafting.rawItem(slot),
      inventoryDetails: () => inventoryInspection.snapshot(working()),
      attackAnimal: (runtimeId, options) => { if (!combat) throw new Error('戦闘モジュールが未準備です。'); return combat.animalAttack(runtimeId, options) },
      worldRevision: () => host.world.revision?.() ?? null,
      entities: () => host.entities.snapshot({ kind: 'all' }),
      mining: ports.mining, getMining: ports.getMining, movement: ports.movement, getMovement: ports.getMovement,
      previewStorageRoute: (target, options) => live().previewStorageRoute(target, options),
      equip: own(slot => operations.inventory.equip(slot)),
      prepareMining: async (tool, { signal } = {}) => {
        if (signal?.aborted) throw new Error('採掘再開は中断されました。')
        if (tool.kind === 'hand') return { prepared: true }
        let state = quarryState(), item = state.inventory?.items?.find(item => item.slot === tool.slot)
        if (state.inventory?.known !== true || state.inventory.uncertain || item?.name !== tool.name || !(item.count > 0)) throw new Error('採掘再開前の道具を確認できません。')
        const expectedScope = userScope(state), initialHealth = state.health
        const verify = () => {
          if (signal?.aborted) throw new Error('採掘再開は中断されました。')
          const current = quarryState(), actual = current.inventory?.items?.find(value => value.slot === tool.slot)
          if (userScope(current) !== expectedScope || current.phase !== 'spawned' || current.dead || current.isDead || current.lifecycle?.dead || !(current.health > 0) || current.health < initialHealth || current.inventory?.known !== true || current.inventory.uncertain || actual?.name !== tool.name || !(actual.count > 0)) throw new Error('採掘再開前の接続・生存状態・実際の道具が変わりました。')
          return { state: current, item: actual }
        }
        // Near the final use, an air update can arrive before the tool's next
        // damage packet. Request fresh inventory before acquiring the equip
        // owner: inventoryResyncIdle deliberately refuses an existing owner.
        if (item.durabilityKnown === true && item.durabilityRemaining <= 9) {
          const waitStartedAt = Date.now()
          for (;;) {
            verify(); inventoryResyncIdle()
            const last = host.shared.inventoryResync?.lastRequestedAt
            const remaining = Number.isFinite(last) ? 20000 - (Date.now() - last) : 0
            if (remaining <= 0) break
            if (Date.now() - waitStartedAt >= 20000 || remaining > 20000) throw Object.assign(new Error('持ち物再同期の安全な待機期限を超えました。'), { code: 'RESYNC_RATE_LIMIT' })
            await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)))
          }
          if (await adapter.resyncInventory({ signal }) !== true) throw new Error('TOOL_DURABILITY_OBSERVATION_PENDING')
          ;({ state, item } = verify())
        }
        return own(async () => {
          verify(); requireIdle()
          const result = await inventory.equipForMining(tool.slot, { signal })
          if (signal?.aborted) throw new Error('採掘再開は中断されました。')
          const latest = quarryState(), selected = latest.inventory?.items?.find(value => value.slot === result.slot)
          if (userScope(latest) !== expectedScope || latest.phase !== 'spawned' || latest.dead || latest.isDead || latest.lifecycle?.dead || latest.health < initialHealth) throw new Error('道具を選択した後の接続・生存状態が変わりました。')
          return { ...result, toolObservation: selected ? { slot: selected.slot, name: selected.name, stackId: selected.stackId ?? null, durabilityKnown: selected.durabilityKnown === true, durabilityRemaining: selected.durabilityRemaining } : null }
        })()
      },
      // Fresh inventory + selected slot from the server (quarry SLOW_BREAK).
      resyncInventory: async ({ signal } = {}) => {
        const startedAt = Date.now(); let sent = false; let lastError = null
        while (Date.now() - startedAt < 5000) {
          if (signal?.aborted) return false
          if (!sent) { try { await requestInventoryResyncWithReceipt('quarry_slow_break'); sent = true } catch (error) { lastError = error } }
          const r = host.shared.inventoryResync?.lastRequest
          if (sent && r?.status === 'FRESH_MAIN_OBSERVED' && Date.parse(r.requestedAt) >= startedAt - 50) return true
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!sent && lastError) throw lastError
        return false
      },
      placeQuarry: own(options => { requireIdle(); crafting.closeContainer(); return interactions.placeQuarryBlock(options) }),
      eat: own(() => operations.food.eat({})),
      equipmentTransfer: value => quarryV22Equipment.transfer(value),
      equipmentView: () => receivedEquipmentView(inventoryInspection,crafting,quarryState()),
      registeredHomeChest: () => getRegisteredQuarryHomeSite(),
      logout: () => { if (quarryJob?.status()?.state !== 'FINISHED' || quarryJob?.status()?.persistence?.status === 'failed') throw new Error('QUARRY_LOGOUT_NOT_READY'); host.disconnectOnCompletedQuarry() },
      chest: { open: own(position => operations.chest.open(position)), depositItem: own(options => operations.chest.depositItem(options)), close: () => crafting.closeContainer() },
      addChest: own(options => { requireIdle(); crafting.closeContainer(); return quarryAddChest(options) }),
      egress: (request, options) => runQuarryEgress(adapter, live, own, request, options),
      storeCarried: (request, options) => getPortable().storeCarried(request, options),
      discoverSupplies: layout => getSupplies().discoverBindings(layout),
      loadoutWithdraw: (request,options) => runSurfaceChest('withdrawAll',request,options),
      finalChestDeposit: (request,options) => runSurfaceChest('depositAll',request,options),
      restockSupplies: (request, options) => getSupplies().run(request, options),
      previewSupplySite: (stand, options) => getPortable().previewSupplySite(stand, options),
      reconcileSupplyPlacement: (request, options) => getSupplies().reconcileUnsentPlacement(request, options),
      reconcileCarriedPlacement: (request, options) => getPortable().reconcileUnsentPlacement(request, options),
      reconcileCurrentPlacement: (request, options) => reconcileCurrentPortablePlacement(request, options),
      reconcileObservedPlacement: (request, options) => {
        // New placement receipts retain send facts. The portable controller
        // validates them and still requires fresh source, block and exact NBT.
        if (request.checkpoint?.intent?.placementFailure?.wireSent === true) return getPortable().reconcileObservedPlacement(request, options)
        const matched = historicalEmptyPlacement({ checkpoint: request.checkpoint, recordedFailure: request.recordedFailure, events: host.shared.inventoryEvents ?? [], state: quarryState() })
        if (!matched.ok) return { status: 'blocked', reason: matched.reason, checkpoint: structuredClone(request.checkpoint) }
        return getPortable().reconcileObservedPlacement({ ...request, placementEvidence: matched.proof }, options)
      },
      reconcileRejectedDeposit: (request, options) => {
        if (request.checkpoint?.intent?.rejectionProof) return getPortable().reconcileRejectedDeposit({ ...request, rejectionProof: request.checkpoint.intent.rejectionProof }, options)
        const matched = historicalSourceRejection({ checkpoint: request.checkpoint, recordedFailure: request.recordedFailure, events: host.shared.inventoryEvents ?? [], state: quarryState() })
        if (!matched.ok) return { status: 'blocked', reason: matched.reason, checkpoint: structuredClone(request.checkpoint) }
        return getPortable().reconcileRejectedDeposit({ ...request, rejectionProof: matched.proof }, options)
      },
      craftTorches: own(options => { requireIdle(); return quarryCraftTorches(options) }),
      placeTorch: own(options => { requireIdle(); crafting.closeContainer(); return quarryPlaceTorch(options) }),
      stopAll: async reason => { try { quarrySupplies?.cancel?.(reason) } catch {} quarryEgressAbort?.abort(new Error(reason ?? 'EGRESS_INTERRUPTED')); quarryPillar?.cancel(reason); try { ports.mining.stop(reason) } catch {} try { ports.movement.stop(reason) } catch {} try { chest.cancel(reason) } catch {} try { interactions.cancel(reason) } catch {} await Promise.allSettled([quarryPillarTask, quarryEgressTask]) },
      // Idle-protection escapes move the bot too; treat them like a fight so the
      // quarry yields movement instead of racing them.
      combatActive: () => { const b = userBehaviorSnapshot(); return userBehaviorLease?.kind === 'combat' || b.activeKind === 'combat' || b.claim?.kind === 'combat' || idleSafety?.snapshot().busy === true },
      threatEvidence: target => quarryEvidence(target, lightweightUserState()),
      recentDamageAt: () => { const at = Number(host.shared.recentDamageNoPrimary?.at ?? NaN); return Number.isFinite(at) ? at : null },
      userControlInterruption: () => structuredClone(host.shared.quarryUserPreemption ?? null),
      log: message => { try { host.log(message) } catch {} }
    })
    adapter.onStarted = () => {
      const cfg = quarryJob?.document()?.config
      autonomy.stop('露天掘りを開始します。')
      if (!host.shared.safetyWanted) { host.shared.safetyEnableEpoch++; host.shared.safetyWanted = true }
      if (cfg?.quarryCombat?.enabled !== false) {
        host.shared.combatDefenseAnchor = null
        quarryBehaviorRestore ??= { userBehaviorsEnabled: host.shared.userBehaviorsEnabled === true }
        host.shared.userBehaviorsEnabled = true
        quarryCombatArmed = true
      }
      resumeSafety()
    }
    adapter.onFinished = s => {
      quarryCombatArmed = false
      if (quarryBehaviorRestore) { host.shared.userBehaviorsEnabled = quarryBehaviorRestore.userBehaviorsEnabled; quarryBehaviorRestore = null }
      try { host.log(`露天掘り: ${s?.result?.type ?? s?.state}${s?.pauseReason ? ` (${s.pauseReason})` : ''}`) } catch {}
    }
    // Read the same durable reset record on demand. The dashboard may restart
    // after the chest is built; a cached in-memory location is not enough.
    adapter.registeredHomeChest = getRegisteredQuarryHomeSite
    quarryJob = createQuarryJob({ adapter, storageMode: 'shulker', storage: quarryStorage, log: message => { try { host.log(`露天掘り: ${message}`) } catch {} } })
    if (host.shared.quarryDocument) { try { quarryJob.load(host.shared.quarryDocument) } catch (error) { host.shared.quarryLoadError = String(error.message).slice(0, 200) } }
    return quarryJob
  }
  function quarrySnapshot () {
    try { return quarryJob ? quarryJob.status() : host.shared.quarryDocument ? { state: host.shared.quarryDocument.state, jobId: host.shared.quarryDocument.config?.jobId ?? null, pauseReason: host.shared.quarryDocument.pauseReason ?? null, loaded: false } : null } catch (error) { return { error: String(error.message).slice(0, 200) } }
  }
  async function loadQuarryFile (jobId) {
    const ticket = ++quarryLoadSequence, generation = quarryPorts
    const owner = ensureQuarryJob(), before = owner.document()?.instanceId ?? null
    const doc = await quarryStorage.load(jobId)
    if (disposed || disposing || ticket !== quarryLoadSequence || generation !== quarryPorts || owner.document()?.instanceId !== before && !(before === null && owner.document() === null)) throw Object.assign(new Error('Quarry recovery context changed'), { code: 'RECOVERY_CONTEXT_CHANGED' })
    assertJobWorld(doc, quarryState())
    const status = owner.load(doc)
    host.shared.quarryDocument = owner.document()
    return status
  }

  // Supply boxes get new stack IDs on every connection; register them again
  // from the received inventory before an automatic resume (2026-11-13).
  async function rebindQuarrySupplies () {
    const doc = ensureQuarryJob().document()
    if (!doc?.config?.inventory?.supplyBoxes?.length) return
    try { await ensureQuarryJob().configureSupplies(); host.log('露天掘り: 補給箱を再登録しました。') } catch (error) { host.log(`露天掘り: 補給箱の再登録をせずに再開します: ${String(error.message).slice(0, 160)}`) }
  }
  async function restoreQuarryJob () {
    const job = ensureQuarryJob(), current = job.document()
    if (current) {
      if (!recoverableQuarry(current) || !QUARRY_AUTO_RESUMABLE.test(current.pauseReason ?? '')) return { skipped: 'job_loaded' }
      assertJobWorld(current, quarryState())
      job.resume()
      return { loaded: current.config.jobId, resumed: true }
    }
    const ticket = quarryLoadSequence, generation = quarryPorts
    const docs = await quarryStorage.list()
    if (disposed || disposing || host.shared.quarryRestoreDisabled || ticket !== quarryLoadSequence || generation !== quarryPorts || job.document()) throw Object.assign(new Error('Quarry recovery context changed'), { code: 'RECOVERY_CONTEXT_CHANGED' })
    const candidate = selectRecoveryCandidate(docs, quarryState())
    if (!candidate) return { skipped: 'none' }
    const status = await loadQuarryFile(candidate.config.jobId)
    const reason = status?.pauseReason ?? ''
    host.log(`露天掘り: 同じワールドのジョブを復元しました: ${candidate.config.jobId} (${reason || status?.state})`)
    if (!QUARRY_AUTO_RESUMABLE.test(reason)) return { loaded: candidate.config.jobId, resumed: false, reason }
    await rebindQuarrySupplies()
    ensureQuarryJob().resume()
    return { loaded: candidate.config.jobId, resumed: true, reason }
  }

  function maybeRestoreQuarryJob () {
    if (chunkMoveHeld()) return
    if (manualChestStorage?.isBusy()) return
    if (resetHeld()) return
    if (disposed || disposing || host.shared.quarryRestoreDisabled || host.shared.quarryRestoreTried || quarryRestoreTask || !quarryPorts || Date.now() < (host.shared.quarryRestoreNextAt ?? 0)) return
    const state = raw()
    if (state.phase !== 'spawned' || !host.shared.loadingScreenEnded || state.spawnPending || state.inventory?.known !== true || host.shared.inventoryUncertain) return
    const attempt = host.shared.quarryRestoreAttempts = (host.shared.quarryRestoreAttempts ?? 0) + 1
    const task = restoreQuarryJob().then(result => {
      if (disposed || disposing) return
      host.shared.quarryRestoreTried = true
      host.shared.quarryRestore = { ...result, attempts: attempt }
      host.log(`露天掘り: 再起動後の確認: ${JSON.stringify(result)}`)
    }).catch(error => {
      if (disposed || disposing) return
      const retry = !host.shared.quarryRestoreDisabled && retryableRecoveryError(error) && attempt < 3
      host.shared.quarryRestoreTried = !retry
      host.shared.quarryRestoreNextAt = retry ? Date.now() + 15000 * attempt : null
      host.shared.quarryRestore = { error: String(error.message).slice(0, 200), code: error.code ?? null, attempts: attempt, retryScheduled: retry }
      host.log(`露天掘り: 復元失敗 (${retry ? '再試行予定' : '自動再試行なし'}): ${String(error.message).slice(0, 160)}`)
    }).finally(() => { if (quarryRestoreTask === task) quarryRestoreTask = null })
    quarryRestoreTask = task
  }
  // resumeRequested is not reached while autonomy is running (as it is right
  // after a restart), so the restore also runs from its own timer.
  // A reset that switched command feedback on and never confirmed switching it
  // off (e.g. a disconnect mid-reset) is restored once after spawn (2026-11-13).
  const feedbackRestoreTimer = setInterval(() => {
    if (disposed || disposing) { clearInterval(feedbackRestoreTimer); return }
    if (host.shared.feedbackRestoreChecked || raw().phase !== 'spawned' || !host.shared.loadingScreenEnded) return
    host.shared.feedbackRestoreChecked = true
    Promise.resolve().then(() => ensureLoadoutReset().restoreFeedbackIfPending?.()).then(result => { if (result) host.log(`初期セット: コマンド応答の設定を戻しました ${JSON.stringify(result)}`) }).catch(error => host.log(`初期セット: コマンド応答の復元を確認できません: ${String(error.message).slice(0, 160)}`))
  }, 15000)
  feedbackRestoreTimer.unref?.()
  const quarryRestoreTimer = setInterval(() => { if (disposed || disposing) { clearInterval(quarryRestoreTimer); return } try { maybeRestoreQuarryJob() } catch {} }, 15000)
  quarryRestoreTimer.unref?.()
  // Keep the quarry's terrain: its chunks and the exit column are never evicted
  // from the world cache, and eviction starts far from them and from the bot.
  let worldRetentionJob = { at: 0, pinned: [] }
  function quarryRetentionChunks () {
    const doc = quarryJob?.document?.()
    if (!doc || ['FINISHED', 'CANCELLED'].includes(doc.state)) return []
    const target = doc.config?.target ?? {}
    const chunks = Array.isArray(target.chunks) ? target.chunks.map(c => ({ x: c.x, z: c.z })) : []
    const r = target.rect
    if (r && [r.x1, r.x2, r.z1, r.z2].every(Number.isSafeInteger) && (Math.abs(r.x2 - r.x1) + 1) * (Math.abs(r.z2 - r.z1) + 1) <= 64) {
      for (let x = Math.min(r.x1, r.x2); x <= Math.max(r.x1, r.x2); x++) for (let z = Math.min(r.z1, r.z2); z <= Math.max(r.z1, r.z2); z++) chunks.push({ x, z })
    }
    const column = doc.exitReservation?.plan?.column
    if (column && Number.isFinite(column.x) && Number.isFinite(column.z)) chunks.push({ x: Math.floor(column.x / 16), z: Math.floor(column.z / 16) })
    return chunks
  }
  function updateWorldRetention () {
    if (typeof host.world?.setRetention !== 'function') return
    if (Date.now() - worldRetentionJob.at > 60000) worldRetentionJob = { at: Date.now(), pinned: quarryRetentionChunks() }
    const points = [...worldRetentionJob.pinned]
    const position = quarryState()?.position
    if (position && Number.isFinite(position.x) && Number.isFinite(position.z)) points.push({ x: Math.floor(position.x / 16), z: Math.floor(position.z / 16) })
    host.world.setRetention({ pinned: worldRetentionJob.pinned, points })
  }
  const worldRetentionTimer = setInterval(() => { if (disposed || disposing) { clearInterval(worldRetentionTimer); return } try { updateWorldRetention() } catch {} }, 5000)
  worldRetentionTimer.unref?.()

  function resumeRequested () {
    if (disposed || disposing || resetHeld() || manualChestStorage?.isBusy()) return
    if (manualShulkerTask) return
    ensureInitialLifeReceipt()
    void loadShoreHistory()
    if (host.shared.respawnTerrain?.pending) return
    maybeAutoStartUserBehaviors()
    tickUserBehaviors()
    if (surfaceReturnOwner || userBehaviorOwns()) return
    if (chunkMoveHeld()) return
    resumeSafety()
    if (raw().phase === 'spawned' && host.shared.loadingScreenEnded) startIdle()
    maybeRestoreQuarryJob()
    // A pending automatic retry of the replaced instance is scheduled again here.
    if (host.shared.quarryRetryAfterReload && quarryPorts && raw().phase === 'spawned' && host.shared.loadingScreenEnded && !raw().spawnPending) {
      const pending = host.shared.quarryRetryAfterReload
      host.shared.quarryRetryAfterReload = null
      try { const job = ensureQuarryJob(), s = job.status(); if (s.jobId === pending.jobId && s.state === 'PAUSED' && s.pauseReason === pending.pauseReason) job.rescheduleAutoResume() } catch (error) { host.shared.quarryLoadError = String(error.message).slice(0, 200) }
    }
    // A quarry job paused only by a hot reload resumes once on the new code.
    if (host.shared.quarryAutoResume && quarryPorts && raw().phase === 'spawned' && host.shared.loadingScreenEnded && !raw().spawnPending) {
      host.shared.quarryAutoResume = false
      try { const job = ensureQuarryJob(); if (job.status().pauseReason === 'PROCESS_RESTARTED') { job.resume(); return } } catch (error) { host.shared.quarryLoadError = String(error.message).slice(0, 200) }
    }
    const resume = () => {
      if (chunkMoveHeld()) return
      if (manualChestStorage?.isBusy()) return
      if (logicalWorkHeld()) return
      if (depotMission?.isEnabled()) { void depotMission.resume(); return }
      const status = autonomy.snapshot()
      // stop() releases running before the current tick finally drains.
      // The next normal behavior tick retries; never start over that owner.
      if (!disposed && !disposing && !pendingStops.size && !userBehaviorOwns() && !host.shared.respawnTerrain?.pending && host.shared.autoWanted && raw().phase === 'spawned' && !raw().spawnPending && host.shared.loadingScreenEnded && !status.running && !status.busy && !status.actionActive) autonomy.start({ objective: 'diamond', diamondCount: 1, maxRunMs: 7200000, maxWaitTicks: 1200, ...host.shared.autoOptions, progress: host.shared.autonomyProgress })
    }
    // resumeRequested runs after every user-behavior tick (~20/s); a depot
    // resume rebuilds hut/shelter snapshots each time. At most once a second.
    const depotDue = Date.now() - (host.shared.depotResumeAttemptAt ?? 0) >= 1000
    if (!logicalWorkHeld() && depotMission?.isEnabled() && !depotDue) return Promise.resolve(null)
    if (!logicalWorkHeld() && depotMission?.isEnabled()) host.shared.depotResumeAttemptAt = Date.now()
    return Promise.resolve(logicalWorkHeld() ? null : depotMission?.resume()).then(() => {
      if (missionJournal.enabled) return missionJournal.load().then(result => { if (missionReady(result)) resume() })
      resume()
    }).catch(error => { host.shared.depotResumeError = String(error.message).slice(0,200) })
  }

  function ensureManualChestStorage () {
    if (manualChestStorage) return manualChestStorage
    const state = () => ({ ...quarryState(), loadingScreenEnded: host.shared.loadingScreenEnded })
    const quietJob = () => quarryJob ?? (host.shared.quarryDocument ? {
      document: () => host.shared.quarryDocument,
      status: () => ({ state: host.shared.quarryDocument.state, persistence: host.shared.quarryDocument.persistence }),
      holdsWork: () => false
    } : null)
    manualChestStorage = createManualChestRuntime({
      host, getState: state, getView: () => inventoryInspection.snapshot(state()),
      getRawMain: slot => crafting.rawItem(slot),
      getRawEquipment: (kind, slot) => inventoryInspection.rawEquipment(kind, slot),
      crafting, chest,
      generation: () => host.shared.loadoutGeneration ?? 0,
      jobIdentity: () => {
        const doc = quietJob()?.document()
        return doc ? `${doc.instanceId}:${doc.state}:${doc.userRunIntent}` : null
      },
      assertIdle: () => {
        requireIdle({ inventoryRequired: false, storageHandoff: true })
        if (craftStatus().authority !== true) throw Object.assign(new Error('サーバーから所持品の確認を待っています。'), { code: 'STORAGE_AUTHORITY_UNKNOWN' })
        if (armorTask || manualArmorOwner || manualShulkerTask || quarryRestoreTask || autonomy.snapshot().running || depotMission?.isBusy() || host.shared.rangedShotUncertain || jobPending(quietJob())) throw Object.assign(new Error('作業・収納・持ち替えの終了を確認してください。'), { code: 'STORAGE_NOT_IDLE' })
      },
      onAcquire: owner => {
        stopIdleStream()
        if (!owner.preview) {
          host.shared.autoWanted = false
          host.shared.quarryAutoResume = false
          host.shared.quarryRestoreDisabled = true
          autonomy.stop('ラージチェストへ収納')
        }
      },
      onRelease: () => { setTimeout(() => resumeSafety(), 0).unref?.() },
      refreshInventory: async ({ signal } = {}) => {
        const started = Date.now()
        signal?.throwIfAborted()
        await requestInventoryResyncWithReceipt('manual_chest_deposit')
        do {
          signal?.throwIfAborted()
          const receipt = host.shared.inventoryResync?.lastRequest
          if (receipt?.status === 'FRESH_MAIN_OBSERVED' && Date.parse(receipt.requestedAt) >= started - 50) return true
          await delay(80)
        } while (Date.now() - started < 5000)
        return false
      },
      allocateRequestId: () => host.allocate('craft'), onUncertain,
      commitMain: (slot, item, requestId) => {
        const delta = { window_id: 'inventory', slot, item, source: 'server_item_stack_response', requestId }
        crafting.applyPacket('inventory_slot', delta)
        host.commitInventory({ window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => crafting.rawItem(i)), changedSlots: [slot], fullRefresh: false, source: delta.source, requestId })
      },
      commitEquipment: (kind, slot, item, requestId) => {
        const delta = { window_id: kind, slot, item, source: 'server_item_stack_response', requestId }
        if (kind === 'armor') armor.applyPacket('inventory_slot', delta)
        inventoryInspection.applyPacket('inventory_slot', delta)
      }
    })
    return manualChestStorage
  }

  function chunkMoveJobIdentity () {
    const doc = quarryJob?.document() ?? host.shared.quarryDocument
    return doc ? JSON.stringify([doc.config?.jobId, doc.instanceId, doc.state, doc.userRunIntent, doc.persistence?.status]) : null
  }
  function verifyChunkMoveLease (id) {
    const owner = chunkMoveLease
    if (!owner || owner.id !== id || owner.signal?.aborted || disposed || disposing || owner.generation !== host.shared.loadoutGeneration ||
      owner.scope !== observedScope(quarryState()) || owner.job !== chunkMoveJobIdentity()) throw Object.assign(new Error('Botの移動条件が変わりました。'), { code: 'CHUNK_MOVE_CONTEXT_CHANGED' })
    return owner
  }
  // Discard a working prediction the server witness disproved; the received
  // raw position is never rewritten (2026-11-13).
  function discardWorkingPrediction (reason) { motionOrigin = null; host.shared.prediction = null; host.shared.motionSource = null; try { host.log(`位置: 外れた予測位置を破棄しました (${String(reason ?? '').slice(0, 80)})`) } catch {} return true }
  // Shared planning-origin check for moves (2026-11-13 live 22:35, see
  // move-origin.js): a stale or distant received position without support is
  // witnessed once before a route is planned.
  async function reconcilePlanningOrigin () {
    const { reconcileMoveOrigin } = require('./move-origin')
    return reconcileMoveOrigin({ state: quarryState(), confirm: (feet, options) => confirmQuarryPosition(feet, options), discardPrediction: discardWorkingPrediction,
      hasSupport: feet => idlePhysics ? idlePhysics.withWorld(host.world, { allowWater: true }).hasSupport(feet) : true, log: message => host.log(message) })
  }
  function ensureChunkTravel () {
    if (chunkTravel) return chunkTravel
    let planner = null
    chunkTravel = createChunkTravel({ getState: quarryState, getBlock: (x, y, z) => host.world.getBlock(x, y, z),
      getMovement: () => movement?.snapshot() ?? { phase: 'unavailable', running: false },
      generation: () => host.shared.loadoutGeneration, jobIdentity: chunkMoveJobIdentity, log: message => host.log(message),
      planRoute: async (target, options) => {
        if (!idlePhysics) return { ready: false, reason: '移動に必要な地形が未受信です。' }
        planner ??= createNavigator({ world: host.world, version: host.meta.version, allowWater: true,
          physics: idlePhysics.withWorld(host.world, { allowWater: true }), planningDistanceLimit: 48 })
        await reconcilePlanningOrigin()
        const origin = require('./move-origin').planningOrigin({ fromServer: state => planner.physics.fromServer(state), getState: quarryState, discardPrediction: discardWorkingPrediction })
        return planner.planAsync(origin, target, { ...options, maxDistance: 48, maxExpanded: 5000 })
      },
      previewMove: (target, options) => {
        verifyChunkMoveLease(chunkMoveLease?.id)
        motionOrigin = working()
        return movement?.preview(target, { ...options, allowWater: true, sprint: false, allowLowHealth: true })
      },
      startMove: (target, options) => {
        const owner = verifyChunkMoveLease(options.operationId)
        controlLocation.invalidate()
        chunkMoveDepth++
        try {
          const { operationId, ...native } = options
          // User decision 2026-11-13: a dashboard move runs at any health above zero.
          const result = startMotion('navigation', target, { ...native, allowWater: true, sprint: false, allowLowHealth: true })
          owner.startedMovement = movement; owner.startedSerial = portableMovementSerial; owner.stopped = false
          return result
        } finally { chunkMoveDepth-- }
      },
      stopMove: (id, reason) => stopChunkMovement(id, reason),
      confirmPosition: (feet, options) => controlLocation.confirm(feet, options),
      acquire: async (id, options) => {
        requireIdle({ inventoryRequired: false, chunkMoveHandoff: true })
        const doc = quarryJob?.document() ?? host.shared.quarryDocument
        if (chunkMoveLease || resetHeld() || manualChestStorage?.isBusy() || manualShulkerTask || armorTask || manualArmorOwner || quarryRestoreTask ||
          autonomy.snapshot().running || depotMission?.isBusy() || doc && (!['IDLE', 'PAUSED', 'FINISHED'].includes(doc.state) || doc.persistence?.status === 'failed' ||
          doc.state !== 'FINISHED' && (doc.portableStorage || doc.supplyRestock || doc.egress?.operationId && !doc.surfaceReturnedAt))) throw Object.assign(new Error('現在の作業を終了してからBotを移動させてください。'), { code: 'CHUNK_MOVE_NOT_IDLE' })
        chunkMoveLease = { id, scope: options.scope, signal: options.signal, generation: host.shared.loadoutGeneration, job: chunkMoveJobIdentity(), startedMovement: null, startedSerial: null, stopped: true }
        controlLocation.invalidate()
        loadoutReset?.cancel()
        stopIdleStream()
        idlePhysicsState = null
        await idleSafety?.stop('選択チャンクへの移動')
        await idleSafety?.drain()
        verifyChunkMoveLease(id)
        if (!(await ensureMovementLifeKnown())) throw Object.assign(new Error('Botの生存状態をまだ確認できていません。数秒待ってからもう一度お試しください。'), { code: 'MOVE_LIFE_UNKNOWN' })
        verifyChunkMoveLease(id)
      },
      release: id => { if (chunkMoveLease?.id === id) { stopChunkMovement(id, 'CHUNK_MOVE_FINISHED'); chunkMoveLease = null; resumeSafety() } }
    })
    return chunkTravel
  }

  function ensureLoadoutReset () {
    if (loadoutReset) return loadoutReset
    const getState = () => ({ ...quarryState(), loadingScreenEnded: host.shared.loadingScreenEnded })
    loadoutReset = createRuntimeV22ChestReset({
      host, getState, inspection: inventoryInspection, crafting, armor, inventory, chest,
      generation: () => host.shared.loadoutGeneration ?? 0,
      confirmArea: (area, options) => controlLocation.confirm(null, { ...options, area, radius: 0.12, operationId: 'debug_chest_selected_area' }),
      getJob: () => ensureQuarryJob(),
      assertIdle: () => {
        requireIdle({ loadoutHandoff: true })
        if (mining.snapshot().phase === 'mining' || mining.snapshot().activeTarget || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy || armorTask || manualArmorOwner || manualShulkerTask || quarryRestoreTask || autonomy.snapshot().running || depotMission?.isBusy() || host.shared.inventoryUncertain || host.shared.rangedShotUncertain || !host.shared.loadingScreenEnded) throw Object.assign(new Error('採掘・収納・持ち物操作の終了を確認してください。'), { code: 'RESET_NOT_IDLE' })
      },
      acquire: operationId => {
        if (resetHeld()) throw Object.assign(new Error('リセット処理中です。'), { code: 'RESET_BUSY' })
        requireIdle({ loadoutHandoff: true })
        loadoutLease = operationId
        host.shared.autoWanted = false; host.shared.quarryAutoResume = false; host.shared.quarryRestoreDisabled = true
        autonomy.stop('初期アイテムリセット')
        stopIdleStream()
        // Fence new combat immediately, then cancel/drain the old owner before
        // the first command. Use the private stop path to preserve this lease.
        return Promise.resolve().then(() => stopActionsAfterRaw('loadout_reset')).then(() => { requireIdle({ loadoutOwner: operationId }) })
      },
      release: operationId => { if (loadoutLease === operationId) { loadoutLease = null; resumeSafety() } },
      cancelTransfers: async operationId => {
        if (loadoutLease !== operationId) return
        inventory.cancel('loadout_end'); chest.cancel('loadout_end'); armor.preemptForCombat('loadout_end')
      }
    })
    return loadoutReset
  }

  function quarryPackingBusy () {
    if (!quarryJob?.holdsWork?.()) return false
    try { const status = quarryJob.status(); return status.portableStorage != null || status.supplies?.active != null } catch { return true }
  }
  return {
    operations, snapshot: getSnapshot, applyPacket, onSpawn, onRespawn, stopActions, resumeRequested,
    canReload: () => !quarryPlacementPreparation && !chunkMoveHeld() && !resetHeld() && !manualChestStorage?.isBusy() && !host.shared.quarrySurfaceStorageOwner && !quarryV22Equipment.status().busy && !quarryPackingBusy() && !manualShulkerTask && !manualArmorOwner && !quarryPortableStorage?.snapshot?.().busy && !quarrySupplies?.snapshot().busy && !quarryPillar?.snapshot().busy && !quarryPillarTask && !depotPrebuild?.snapshot().busy && !depotMission?.isBusy() && !userBehaviorOwns() && !userBehaviorTickTask && pendingStops.size === 0 && mining.snapshot().phase !== 'mining' && !idleSafety?.snapshot().busy && !['scheduled', 'in_flight'].includes(host.shared.safetyEmergency?.status) && !guardRoute?.snapshot().busy && !hut?.snapshot().busy && !shelter?.snapshot().busy && !food.snapshot().busy && !(foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) && !recovery?.snapshot().busy && !tunneling?.snapshot().busy && !excavation?.snapshot().busy && !(furnace.snapshot().busy || chest.snapshot().busy) && !inventory.snapshot().busy && craftStatus().pendingRequestId == null && !interactions.snapshot().pendingOperation && !combat?.snapshot().busy && !combat?.snapshot().defending && !combat?.snapshot().engaging,
    dispose: async reason => {
      if (disposed) return
      cancelChunkMovement('RUNTIME_RELOADED')
      const chunkMoveDrain = chunkTravel?.drain()
      manualChestStorage?.cancel('RUNTIME_RELOADED')
      const storageDrain = manualChestStorage?.drain()
      loadoutReset?.cancel()
      const resetDrain = loadoutReset?.drain()
      if (quarryJob?.holdsWork()) { try { await quarryJob.pause('PROCESS_RESTARTED'); host.shared.quarryAutoResume = true } catch {} }
      try { const doc = quarryJob?.document(); if (doc) host.shared.quarryDocument = doc } catch {}
      // The old instance's pending automatic retry is cancelled and handed to the new code.
      try { const retired = quarryJob?.retire?.(); host.shared.quarryRetryAfterReload = retired?.pendingAutoResume ? { jobId: retired.jobId, pauseReason: retired.pauseReason } : null } catch {}
      const memoryFlush = missionJournal.close()
      depotPrebuild?.cancel('Runtime reload')
      const depotFlush = depotMission?.close()
      disposing = true
      clearInterval(idleTimer)
      idleTimer = null
      clearInterval(userBehaviorTimer); userBehaviorTimer = null
      clearInterval(quarryRestoreTimer); clearInterval(worldRetentionTimer); quarryLoadSequence++
      publishWalker()
      autonomy.stop(reason ?? '行動コードを更新します。')
      const cleanup = stopActions(reason ?? '行動コードを更新します。')
      // Stop ordinary inputs synchronously above, then wait for owned reset cleanup.
      await Promise.allSettled([manualShulkerTask, resetDrain, storageDrain, chunkMoveDrain])
      inputStream?.stop()
      inputOwner = 'none'
      await cleanup
      await Promise.allSettled([...pendingStops])
      await autonomy.tick()
      await memoryFlush
      await depotFlush
      await depotPrebuild?.drain()
      await shoreMemory?.flush().catch(error => { host.shared.shoreMemoryError = String(error.message).slice(0, 160) })
      inputStream?.stop()
      disposed = true
    }
  }
}

module.exports = { createRuntime }
