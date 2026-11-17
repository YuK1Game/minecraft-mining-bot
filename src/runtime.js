'use strict'

const { diagnoseStrikeBody } = require('./combat/combat-body-diagnostic')

const { createCombatExposure } = require('./combat/combat-exposure')
const { createQuarryStore } = require('./quarry/quarry-store')
const { assertJobWorld } = require('./quarry/quarry-job-identity')
const { RESUMABLE: QUARRY_AUTO_RESUMABLE, recoverable: recoverableQuarry, selectRecoveryCandidate, retryableRecoveryError } = require('./quarry/quarry-recovery')

const { createActorReader, createSnapshotReader } = require('./runtime/runtime-observation-views')
const { inventoryRefreshDelay, refreshInventoryWithRetry } = require('./inventory/inventory-refresh')
const { profileCpu, measureSnapshots } = require('./runtime/runtime-diagnostics')
const { createSightStanceSearch } = require('./combat/sight-stance-search')
const { createQuarryPortableStorage } = require('./quarry/storage/quarry-portable-storage')
const { createQuarrySupplies } = require('./quarry/storage/quarry-supplies')
const { createQuarryV22Equipment } = require('./loadout/quarry-v22-equipment')
const { createQuarryV22ChestWork } = require('./loadout/quarry-v22-chest-work')
const { createRuntimeV22ChestReset, receivedEquipmentView, jobPending } = require('./loadout/loadout-runtime-adapter')
const { createInventoryStore } = require('./inventory/inventory-store')
const { createLoggedStallWatch, describeWork } = require('./runtime/event-loop-stall')
const { currentLifeId } = require('./common/life-identity')
const { createManualChestRuntime } = require('./loadout/manual-chest-runtime-adapter')
const { createChunkTravel } = require('./travel/chunk-travel')
const { chunkTravelThreatsClear } = require('./travel/chunk-travel-threats')
const { createControlLocation } = require('./movement/control-location')
const { normalizeChunkArea } = require('./common/chunk-area')
const { historicalSourceRejection } = require('./quarry/storage/rejected-source-history')
const { historicalEmptyPlacement } = require('./quarry/storage/placement-source-history')

const { resourceMinHealth } = require('./safety/learning-health')
const { threatFields } = require('./safety/threat-policy')

const { setTimeout: delay } = require('node:timers/promises')
// Reloadable behaviour only. The client, authentication, world observations,
// inventory journal, IDs and predicted working pose are owned by the host.
const { createInput } = require('./movement/input')
const { createInputHistory } = require('./movement/input-history')
const { createPhysics } = require('./movement/physics')
const { createWaterPreviewObserver } = require('./movement/water-preview-observer')
const { createMining } = require('./actions/mining')
const { canonicalWindowId, sameWindowId } = require('./inventory/container-types')
const { createActionOwnerTracker } = require('./common/action-owner-tracker')
const { defenseEnabled, createDefenseAnchor, defenseMovementAllowed } = require('./combat/combat-defense-policy')
const { evaluateCombatThreat } = require('./combat/combat-threat-policy')
const { proveGroundAccess } = require('./movement/ground-access-proof')
const { createQuarryJob } = require('./quarry/quarry-job')
const { createQuarryRuntimeAdapter } = require('./quarry/quarry-runtime-adapter')
const { createQuarryPillar } = require('./quarry/exit/quarry-pillar')
const { createQuarryEgressRuntime } = require('./quarry/exit/quarry-egress-runtime')
const { createServerPositionVerifier, observedScope } = require('./movement/server-position-verifier')
const { createStoragePlacementAudit } = require('./quarry/storage/storage-placement-audit')
const { createPlainsLocator } = require('./travel/locate-plains')
const { createQuarryTerrainRequester } = require('./quarry/quarry-terrain')
const { permitsExitAction } = require('./quarry/exit/quarry-exit-plan')
const { blockRule: quarryBlockRule, selectTool: quarrySelectTool, nameOf: quarryNameOf } = require('./quarry/quarry-rules')
const { createWalker } = require('./movement/walking')
const { createMovement } = require('./movement/movement')
const { createNavigator } = require('./movement/navigation')
const { surveyShore } = require('./movement/shore-survey')
const { createShoreLandmarks } = require('./movement/shore-landmarks')
const { createCrafting } = require('./actions/crafting')
const { createInteractions } = require('./actions/interactions')
const { createCombat } = require('./combat/combat')
const { createWaterCounterattack } = require('./combat/water-counterattack')
const { createInventory } = require('./inventory/inventory')
const { createInventoryInspection } = require('./inventory/inventory-inspection')
const { createArmor } = require('./actions/armor')
const { isDeepStrictEqual } = require('node:util')
const { createUserBehaviors } = require('./combat/user-behaviors')
const { createFurnace } = require('./actions/furnace')
const { createChest } = require('./actions/chest')
const { createSurfaceReturn, returnScope } = require('./survival/surface-return')
const { bindRecentDamage, observeOwnDamageEffect, planRecentDamageRetreat, retreatFrameAllowed } = require('./safety/recent-damage-retreat')
const { createSelfResistance, createSelfSlowFalling, createSelfEffectEvents } = require('./combat/self-resistance')
const { createDepotMission } = require('./survival/depot-mission')
const { createDepotPrebuild, planPrebuildChestStance } = require('./survival/depot-prebuild')
const { createWorksiteCamp, createWorksiteCampPrebuild } = require('./survival/worksite-camp')
const { rankExplorationTargets } = require('./survival/exploration')
const { rankCampResourceTargets } = require('./survival/camp-local-resource')
const { planOwnedCampReturn } = require('./survival/owned-camp-return')
const { createOwnedCampBootstrap } = require('./survival/owned-camp-bootstrap')
const { createDepotStorageWork } = require('./survival/depot-storage-work')
const { planDepotStorageAccess, selectDepotTableCell } = require('./survival/depot-storage-access')
const { continuationScope } = require('./survival/base-continuation')
const { planContinuationResource } = require('./survival/continuation-resource')
const { createProspecting } = require('./survival/prospecting')
const { createExcavation } = require('./survival/excavation')
const { nextDiamondAction } = require('./survival/diamond-planner')
const { supplyScope, tableMaterialShortfall, updateStationCatalog, readStationPages, planSupplyReturn } = require('./survival/supply-return')
const { portableKit, reservedWorksiteCells, selectPortableWorksite, preparationTableTarget, portableFallbackStop, nextPortableStep, verifyPortableDeployment, portableSiteValid, useRays } = require('./survival/portable-worksite')
const { immediateDiamond } = require('./survival/immediate-diamond')
const { createDiamondActions } = require('./survival/diamond-actions')
const { createDurabilityReader } = require('./inventory/durability')
const { createTunneling } = require('./survival/tunneling')
const { annotateTerrainThreats, terrainOcclusionApplies } = require('./combat/terrain-threats')
const { useCurrentAccess } = require('./actions/action-access')
const { createRecovery, planLearningShore, proveLearningShoreRoute } = require('./safety/recovery')
const { createFood, isSupportedFood } = require('./actions/food')
const { createForaging } = require('./survival/foraging')
const { normalizePlayerCorrection } = require('./movement/server-physics')
const { evaluateThreats } = require('./combat/threats')
const threatReachability = require('./combat/threat-reachability')
const { landEdgeRecenterTargets } = require('./movement/edge-recenter')
// melee_kite standpoint distances from the target after a hit.
const KITE_RADII = [3.4, 3.2, 3.6]
// Retreat directions relative to straight away from the target (radians).
const KITE_ANGLES = [0, 35, -35, 70, -70].map(deg => deg * Math.PI / 180)
// Up to 12 x 50ms waiting for a supported landing before a kite step.
const KITE_LANDING_POLLS = 12
const { constrainedSecondaryFloor, selectConstrainedPrimary, outsideSkeletonFloor, unarmedCreeperZombie: isUnarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned, unarmedZombieFloor, outsideUnarmedSpiderFloor, activeUnarmedSpiderFloor } = require('./movement/escape-policy')
const { normalizeServerMotion } = require('./movement/server-motion')
const { createShelter } = require('./survival/shelter')
const { planShelter } = require('./survival/shelter-planner')
const { nextSurvivalAction } = require('./survival/survival-planner')
const { serverInventoryUpdate } = require('./inventory/inventory-updates')
const { createHut } = require('./survival/hut')
const { planHut } = require('./survival/hut-planner')
const { createBaseProtection } = require('./safety/base-protection')
const { createGuardedRoute } = require('./movement/guarded-route')
const { createIdleSafety } = require('./safety/idle-safety')
const { knownSurfaceBody, lowHealthSurfaceEligible, proveLowHealthSurfaceRoute } = require('./movement/low-health-water')
const { WORK_MARGIN, captureWorkActors, resolveWorkActors, workEscapeEvaluation } = require('./safety/work-clearance')
const { planEmergencyLeafAsync, clearanceDistanceAllowed, clearanceEquipmentKey, clearanceTargetAllowed } = require('./safety/emergency-leaf')
const { planProtectiveDrownedStepAsync, drownedStepThreatAllowed, drownedStepEquipmentKey, protectiveDrownedStepCurrent, skeletonStepThreatAllowed, planProtectiveSkeletonStepAsync, protectiveSkeletonStepCurrent } = require('./safety/protective-drowned-step')
const { createMissionJournal } = require('./survival/mission-journal')
const { createAutonomy, verifiedCoveredRoom } = require('./survival/autonomy')
const { createRunner, createHttpClient } = require('./survival/runner')
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
  host.registerPacketEvents?.(['set_spawn_position', 'set_time', 'sync_world_clocks', 'completed_using_item', 'set_entity_motion', 'motion_prediction_hints', 'inventory_transaction', 'update_abilities', 'update_adventure_settings', 'animate', 'set_health', 'mob_effect'])
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
  function chestStatus () { return typeof chest.status === 'function' ? chest.status() : chest.snapshot() }
  // 2026-11-14 01:59 user: "クリーパーに爆破され落下しました。不死のトーテムを持っている
// 限り死ぬことはないので、過剰な待機保護をやめてください".
  // Only the offhand slot received from the server counts; an unreceived or
  // empty offhand is no totem.
  function offhandTotem () {
    try {
      // A totem received before the last consumption is not trusted.
      const info = inventoryStore.slotInfo?.('offhand', 0)
      if (Number.isFinite(host.shared.totemConsumedAt) && !(Date.parse(info?.at ?? '') > host.shared.totemConsumedAt)) return false
      const r = inventoryInspection.rawEquipment('offhand', 0); return !!r && r.count > 0 && crafting.itemNameOf(r.network_id) === 'minecraft:totem_of_undying'
    } catch { return false }
  }
  const working = () => {
    const state = host.getState()
    state.totemGuard = offhandTotem()
    state.emptyHandedPrep = emptyHandedPrep()
    // Raw chicken below hunger 18 when nothing else edible is held (coordinator 2026-11-14).
    try { const hv = host.shared.vitals?.hunger, hu = Number.isFinite(hv) ? hv : Number.isFinite(hv?.value) ? hv.value : null; state.rawChickenAllowed = hu !== null && hu < 18 && !(state.inventory?.items ?? []).some(i => i.count > 0 && /^minecraft:(?:cooked_[a-z_]+|bread|apple|carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|dried_kelp|cookie|pumpkin_pie|golden_carrot|golden_apple)$/.test(i.name ?? '')) } catch { state.rawChickenAllowed = false }
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
    Object.assign(state, threatFields(host.shared))
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
  const actualLifeId = () => currentLifeId({ hostLife: typeof host.getLife === 'function' ? host.getLife() : null, connectionId: rawFields(['connectionId']).connectionId ?? null, respawnRecord: host.shared.deathRespawn })
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
    const current = { ...state, profile: state.profile ?? host.meta.profile, dead: state.dead === true || dead, isDead: state.isDead === true || dead, ...threatFields(host.shared), entities: actors, hostiles: actors.filter(e => e.hostile && e.alive), entityStats: host.entities.stats?.() ?? { unknownPositions: actors.filter(e => e.positionKnown !== true).length }, lifecycle: { ...(state.lifecycle ?? {}), deathId: actualLifeId(), dead, phase: dead ? 'dead' : 'alive' } }
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
      autonomyRuntime.autonomy.stop('user_behavior_sleep'); inputHistory?.invalidate('user_behavior_sleep'); stationaryRawPending = null; motionOrigin = null; host.shared.prediction = null; host.shared.motionSource = null
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
    const task = Promise.resolve(result).then(() => { synchronizeUserSleep(); if (!userBehaviorOwns() && host.shared.autoWanted && !autonomyRuntime.autonomy.snapshot().running) return resumeRequested() }).catch(error => userBehaviorError(error, 'tick')).finally(() => { if (userBehaviorTickTask === task) userBehaviorTickTask = null })
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
  const baseProtectedWorld = createBaseProtection({ world: host.world, getState: raw, shared: host.shared, ownerProfile: raw().profile ?? null })
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
    return { ...state, ...threatFields(host.shared), entities, removedEntities: host.entities.snapshotRemoved?.() ?? [], hostiles: entities.filter(entity => entity.hostile && entity.alive) }
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
  // The one authoritative inventory record (main, armour, offhand, cursor).
  // It lives in host.shared so a behaviour reload keeps what was received.
  const inventoryStore = createInventoryStore({ shared: host.shared, getScope: () => {
    const s = raw()
    if (s.connectionId == null || s.startedAt == null || s.runtimeEntityId == null) return null
    return [s.profile ?? host.meta.profile ?? null, s.realm?.id == null ? null : String(s.realm.id), s.connectionId, s.startedAt, String(s.runtimeEntityId)]
  } })
  migrateLegacyInventoryRecords()
  const crafting = createCrafting({ client: host.client, getState: working, version: host.meta.version, onInventory, onUncertain, onContainerClose: packet => host.cache.observe('container_close', packet), allocateRequestId: () => host.allocate('craft'), inventory: inventoryStore.map('main', 'crafting') })
  readDurability = createDurabilityReader(host.meta.version)
  const inventoryInspection = createInventoryInspection({ crafting, inventoryStore, getChest: () => chest, getState: raw, store: host.shared.inventoryInspectionStore ??= {}, version: host.meta.version })
  const UserCombatItem = require('prismarine-item')(`bedrock_${host.meta.version}`)
  const furnace = createFurnace({ client: host.client, getState: working, crafting, version: host.meta.version, allocateRequestId: () => host.allocate('craft'), onUncertain, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) } })
  const prospecting = createProspecting({ client: host.client, getState: working, world: host.world })
  const inventory = createInventory({ client: host.client, getState: working, crafting, allocateRequestId: () => host.allocate('craft'), commitSelection: typeof host.commitSelection === 'function' ? slot => host.commitSelection(slot) : null, selectionStore: host.shared.inventorySelection ??= {}, onUncertain, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) } })
  let armorTask = null
  let manualArmorOwner = null
  const armor = createArmor({ client: host.client, getState: working, crafting, allocateRequestId: () => host.allocate('craft'), store: host.shared.armorStore ??= {}, inventoryStore, onInventory: packet => { crafting.applyPacket('inventory_content', packet); host.commitInventory(packet) }, log: message => host.log(message) })
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
  // Bare-hand deepslate takes about 15 s (2026-11-14 cave exit): 30 s per block.
  const mining = createMining({ blockTimeoutMs: 30000, logAllowance: () => longTravelLogAllowance(), travelDownAllowance: () => Date.now() < (host.shared.travelDownUntil ?? 0), getState: () => ({ ...miningState(), lifecycle: { deathId: actualLifeId() } }), world: host.world, getInput: () => input, getRawItem: slot => crafting.rawItem(slot), isProtected: point => { const block = planningWorld.getBlock(point.x,point.y,point.z); return block?.protected === true || !!block?.protectionSource || (depotBuilder?.protectedCells() ?? []).some(p => p.x===point.x && p.y===point.y && p.z===point.z) }, verifyOwnedBed: (state, target, block) => userBehaviors?.ownsBedTarget(state, target, block) === true || travelBedOwns(target, block), verifyOwnedShulker: (state, target, block) => quarryPortableStorage?.ownsShulker(state, target, block) === true || manualShulkerRecovery?.ownsShulker(state, target, block) === true || travelShulkerOwns(target, block) })
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
    getRawEquipment: (kind, slot) => ['armor', 'offhand'].includes(kind) ? inventoryStore.raw(kind, slot) : null,
    allocateRequestId: () => host.allocate('craft'),
    commitMain: (slot, item, requestId) => {
      const delta = { window_id: 'inventory', slot, item, source: 'server_item_stack_response', requestId }
      crafting.applyPacket('inventory_slot', delta)
      host.commitInventory({ window_id: 'inventory',
        input: Array.from({ length: 36 }, (_, i) => crafting.rawItem(i)),
        changedSlots: [slot], fullRefresh: false, source: 'server_item_stack_response', requestId })
    },
    commitEquipment: (kind, slot, item, requestId) => { inventoryStore.commit(kind, slot, item, 'server_item_stack_response') },
    onUncertain: onUncertain
  })
  portableActionOwners.track(inventory, ['equip', 'equipForMining', 'equipForCombat', 'equipForFood'], { invalidate: ['cancel'], isActive: c => c.snapshot().busy === true })
  portableActionOwners.track(interactions, ['placeBlock', 'placeQuarryBlock', 'placeBed', 'placeCraftingTable', 'useBed', 'openShulker', 'openChest', 'openFurnace', 'openWorkbench', 'openCraftingTable'], { invalidate: ['cancel'], isActive: c => c.snapshot().pendingOperation != null })
  portableActionOwners.track(chest, ['open', 'depositItem', 'depositDiamond', 'withdrawItem'], { invalidate: ['cancel'], isActive: c => c.snapshot().busy === true })
  portableActionOwners.track(mining, ['start', 'startAccessClearance'], { invalidate: ['stop'], isActive: c => c.snapshot().phase === 'mining' })

  async function executeSurfaceReturn (options = {}, context = {}) {
    if (disposed || disposing || !surfaceReturn || surfaceReturnOwner || userBehaviorOwns() || autonomyRuntime.autonomy.snapshot().actionActive) throw new Error('地上への移動処理が使用中です。')
    const lease = { serial: ++surfaceReturnSequence, scope: returnScope(lightweightUserState()), operationId: null }
    surfaceReturnOwner = lease
    try {
      autonomyRuntime.autonomy.stop('地上への帰路へ操作を引き継ぎます。')
      await autonomyRuntime.autonomy.tick()
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
    const latest = { ...raw(), ...threatFields(host.shared), vitals: structuredClone(host.shared.vitals ?? {}), totemGuard: offhandTotem() }
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
        if (!idleOriginNavigator.verifyOrigin(idlePhysicsState) && !autonomyRuntime.autonomy.snapshot().busy && !idleSafety?.snapshot().busy && !guardRoute?.snapshot().busy && !excavation?.snapshot().busy && !tunneling?.snapshot().busy && !recovery?.snapshot().busy && !(foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) && !shelter?.snapshot().busy && !hut?.snapshot().busy && !combat?.snapshot().busy && !combat?.snapshot().defending && !combat?.snapshot().engaging && !food.snapshot().busy && !(furnace.snapshot().busy || chestStatus().busy) && !inventory.snapshot().busy && craftStatus().pendingRequestId == null && !interactions.snapshot().pendingOperation) {
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
    const snapshot = createSnapshotReader()
    const behavior = userBehaviorSnapshot()
    const combatHandoff = loadoutHandoff && (userBehaviorLease?.kind === 'combat' || behavior.claim?.kind === 'combat' || snapshot(combat)?.busy || snapshot(combat)?.defending || snapshot(combat)?.engaging)
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
    if (!combatHandoff && (motionActive() || input?.stats().running || snapshot(combat)?.busy || snapshot(combat)?.defending || snapshot(combat)?.engaging) || snapshot(food).busy || (snapshot(furnace).busy || chestStatus().busy) || inventory.snapshot().busy || craftStatus().pendingRequestId != null || interactions.snapshot().pendingOperation) throw new Error('前の操作が完了するまで待ってください。')
    if (!ownedCall) host.shared.safetyManualActionAt = Date.now()
  }
  // First load of the single inventory record on a live connection: adopt the
  // equipment the previous behaviour code had already received, so a reload
  // does not turn the worn armour and offhand into "unknown". Main slots come
  // back through the session cache replay into crafting (the same record).
  function migrateLegacyInventoryRecords () {
    if (inventoryStore.revision() !== 0) return
    const armorLegacy = host.shared.armorStore, inspectionLegacy = host.shared.inventoryInspectionStore
    if (armorLegacy?.known === true && armorLegacy.worn instanceof Map && !(armorLegacy.worn.constructor?.name === 'StoreSlotMap')) {
      for (let slot = 0; slot < 4; slot++) if (armorLegacy.worn.has(slot)) inventoryStore.commit('armor', slot, armorLegacy.worn.get(slot), 'migrated_legacy_armor')
    }
    if (inspectionLegacy?.offhandKnown === true && inspectionLegacy.offhand instanceof Map && inspectionLegacy.offhand.has(0)) inventoryStore.commit('offhand', 0, inspectionLegacy.offhand.get(0), 'migrated_legacy_offhand')
  }
  // Slots the record has not received (after a reconnect, death, dimension
  // change or an unidentified stack move) are fetched again from the server
  // with the existing rate-limited resync, only while the Bot is idle.
  let inventoryStoreResyncTask = null
  function inventoryStoreResyncTick () {
    if (disposed || disposing || replaying) return
    const state = raw()
    if (state.phase !== 'spawned' || state.dead || state.isDead || !(state.health > 0) || state.spawnPending) { host.shared.inventoryStoreMissingSince = null; return }
    const missing = inventoryStore.missing(['main', 'armor', 'offhand'])
    if (!missing.length) { host.shared.inventoryStoreMissingSince = null; return }
    const now = Date.now()
    if (!Number.isFinite(host.shared.inventoryStoreMissingSince)) host.shared.inventoryStoreMissingSince = now
    if (now - host.shared.inventoryStoreMissingSince < 3000) return
    const note = result => inventoryStore.noteResync({ missing: missing.slice(0, 41), result })
    const notSent = error => note({ status: 'NOT_SENT', code: error?.code ?? null, reason: String(error?.message ?? error).slice(0, 120) })
    if (inventoryStoreResyncTask) return
    try {
      const task = Promise.resolve(requestInventoryResyncWithReceipt('inventory_store_missing'))
      inventoryStoreResyncTask = task
      task.then(result => { host.shared.inventoryStoreMissingSince = Date.now(); note(result) }, notSent).finally(() => { if (inventoryStoreResyncTask === task) inventoryStoreResyncTask = null })
    } catch (error) { notSent(error) }
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
    const snapshot = createSnapshotReader()
    // Only the current combat owner waiting for real receipts may refresh
    // without releasing defense. No weapon/movement or mutation may be active.
    if (combatLease) {
      if (combatLease !== userBehaviorLease || combatLease.kind !== 'combat' || !combatLease.ready || combatLease.receiptsReady !== false) throw Object.assign(new Error('戦闘の持ち物確認は現在の操作権に限ります。'), { code: 'RESYNC_COMBAT_OWNER_CHANGED' })
      if (ownedCall || pendingStops.size || inputOwner === 'task' || motionActive() || input?.stats().running || inventory.snapshot().busy || snapshot(mining).phase === 'mining' || snapshot(food).busy || snapshot(food).pendingRequestId != null || snapshot(furnace).busy || chestStatus().busy || craftStatus().pendingRequestId != null || interactions.snapshot().pendingOperation || snapshot(combat)?.busy || snapshot(combat)?.engaging) throw Object.assign(new Error('戦闘の入力と送信済み操作が終了するまで持ち物の実受信を待ちます。'), { code: 'BUSY' })
      return
    }
    const behavior = userBehaviorSnapshot()
    if (ownedCall || pendingStops.size || userBehaviorOwns() || userBehaviorTickTask || behavior.cleanupUnconfirmed || inputOwner === 'task' || motionActive() || input?.stats().running || autonomyRuntime.autonomy.snapshot().actionActive || idleSafety?.snapshot().busy || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || (foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) || shelter?.snapshot().busy || hut?.snapshot().busy || guardRoute?.snapshot().busy || snapshot(mining).phase === 'mining' || walker?.snapshot().phase === 'walking' || snapshot(food).busy || snapshot(food).pendingRequestId != null || inventory.snapshot().busy || (snapshot(furnace).busy || chestStatus().busy) || snapshot(furnace).waitingOutput || interactions.snapshot().pendingOperation || snapshot(combat)?.busy || snapshot(combat)?.defending || snapshot(combat)?.engaging || host.shared.equipment != null || craftStatus().pendingRequestId != null) throw Object.assign(new Error('現在の操作が完了してから持ち物を再同期します。'), { code: 'BUSY' })
  }
  function inventoryResyncSuccessKey (ledger, scopeKey) {
    const r = ledger?.lastRequest
    const requested = Date.parse(r?.requestedAt), observed = Date.parse(r?.observedAt)
    if (r?.status !== 'FRESH_MAIN_OBSERVED' || r.freshMainObserved !== true || r.requestSent !== true || JSON.stringify(r.scope) !== scopeKey || !Number.isFinite(requested) || !Number.isFinite(observed) || observed < requested || !Number.isSafeInteger(r.fullCountAtSend) || !Number.isSafeInteger(ledger.actualFullCount) || ledger.actualFullCount <= r.fullCountAtSend) return null
    return JSON.stringify([scopeKey, r.requestedAt, r.fullCountAtSend])
  }
  function inventoryResyncDelay () { return inventoryRefreshDelay(host.shared.inventoryResync?.lastRequestedAt, Date.now()) }
  function requestInventoryResync (source = 'manual', options = {}) {
    const scope = inventoryResyncScope()
    inventoryResyncIdle(options)
    const key = JSON.stringify(scope), lifeKey = JSON.stringify([scope.profile, scope.realmId, scope.connectionId, scope.startedAt, scope.deathId]), now = Date.now(), prior = host.shared.inventoryResync
    const retryAfterMs = inventoryRefreshDelay(prior?.lastRequestedAt, now)
    if (retryAfterMs > 0) throw Object.assign(new Error('前の再同期要求から20秒待ってください。'), { code: 'RESYNC_RATE_LIMIT', retryAfterMs })
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
        const state = working(), worn = inventoryStore.map('armor', 'manual_armor')
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
  // Armour, totem/shield (2026-11-14 user request relayed): worn automatically in
  // every state at a safe point, not only in the legacy auto mode. Never during
  // quarry work unless its combat is armed, never once the job has begun its
  // final chest store (the gear goes back to the chest), and not mid-walk on a
  // long trip (the trip equips between legs).
  let armorFinalMemo = { at: 0, value: false }
  function armorAutoAllowed () {
    if (travelRuntime.longTravel?.status?.().busy) return false
    if (!quarryJob?.holdsWork()) return true
    if (!quarryCombatArmed) return false
    // The job copy is costly: read whether the final chest store began at most every 3 s.
    if (Date.now() - armorFinalMemo.at > 3000) { let v = false; try { v = !!quarryJob.document?.()?.finalChest } catch {} armorFinalMemo = { at: Date.now(), value: v } }
    return !armorFinalMemo.value
  }
  // Live 2026-11-14 21:14: hostiles kept wandering within 8 m (in caves and
  // behind terrain) and the bot stood unarmoured for minutes. Armour waits only
  // for a hostile that can reach the bot (the threat evaluation) within 8 m.
  function armorThreatNear () {
    try {
      const st = lightweightUserState()
      const risk = evaluateThreats(st, st.entities, { observationRadius: 16 })
      if (risk.requiresObservation) return nearestHostileDistance() < 8
      return risk.threats.some(t => Number.isFinite(t.distance) ? t.distance < 8 : true)
    } catch { return nearestHostileDistance() < 8 }
  }
  function maybeEquipArmor () {
    if (resetHeld() || manualChestStorage?.isBusy() || chunkMoveHeld() || quarryPlacementPreparation || host.shared.quarrySurfaceStorageOwner || armorTask || Date.now() - (host.shared.armorCheckedAt ?? 0) < 3000 || !armorAutoAllowed()) return
    host.shared.armorCheckedAt = Date.now()
    try { if (!armor.preview() || !armorWorkFree() || armorThreatNear()) return } catch { return }
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
    return { ownedCampBootstrap: structuredClone(host.shared.ownedCampBootstrap ?? null), workHold: host.shared.legacyWorkHoldLease ? {leaseId:host.shared.legacyWorkHoldLease.id,scope:host.shared.legacyWorkHoldLease.scope,expiresAt:host.shared.legacyWorkHoldLease.expiresAt} : null, recentDamageRetreat: structuredClone(host.shared.recentDamageRetreatDiagnostic ?? null), survivalWorkClearance: state.survivalWorkClearance === true, spawnRangedClearance: state.spawnRangedClearance === true, depotPrebuild: depotPrebuild?.snapshot() ?? null, depotMission: depotMission?.snapshot() ?? null, surfaceReturn: surfaceReturn?.snapshot() ?? null, inventoryResync: structuredClone(host.shared.inventoryResync?.lastRequest ?? null), movementCalibration: structuredClone(movementCalibration), learningShoreEscape: structuredClone(host.shared.learningShoreEscape ?? null), startupPriority: structuredClone(host.shared.startupPriority ?? null), userBehaviors: userBehaviorSnapshot(), lowHealthWater: host.shared.lowHealthWaterDiagnostic ? { ...structuredClone(host.shared.lowHealthWaterDiagnostic), timing: structuredClone(host.shared.lowHealthWaterTiming ?? null) } : null, clearance: structuredClone(host.shared.clearanceDiagnostic ?? null), safety: safetySnapshot(), guardRoute: guardRouteSnapshot(), boundedJumpSearch: structuredClone(boundedJumpSearch), queuedPrediction: inputHistory?.snapshot() ?? null, queuedWireClock: structuredClone(actualWireClock.snapshot()), missionMemory: missionJournal.snapshot(), hut: hut?.snapshot() ?? null, shelter: activeBase()?.snapshot() ?? null, shelterKind: activeBase() === hut ? "hut" : "soil_hill", dayCycleStopTime: host.meta.startGame?.day_cycle_stop_time ?? null, worldClocks: structuredClone(host.shared.worldClocks ?? {}), lastServerMotion: structuredClone(host.shared.lastServerMotion ?? null), lastServerCorrection: structuredClone(host.shared.lastServerCorrection ?? null), worldTime: structuredClone(host.shared.worldTime ?? null), threatPolicy: state.threatPolicy, playerPlay: state.playerPlay, foraging: foraging?.snapshot() ?? null, food: food.snapshot(), vitals: structuredClone(host.shared.vitals ?? {}), recovery: recovery?.snapshot() ?? null, excavation: excavation?.snapshot() ?? null, quarry: quarrySnapshot(), tunneling: tunneling?.snapshot() ?? null, heldItem: state.heldItem, runtimeVersion: RUNTIME_VERSION, inventory: state.inventory, inventoryDetails: inventoryInspection.snapshot(state), inventoryStore: inventoryStore.snapshot(), inventoryConfidence: { known: !host.shared.inventoryUncertain, unresolved: host.shared.inventoryUncertain ?? null }, stations: structuredClone(host.shared.stations ?? {}), stationCatalog: structuredClone(host.shared.stationCatalog ?? null), portableWorksite: structuredClone(host.shared.portableWorksiteMemo ?? null), prospecting: observedOres, furnace: furnace.snapshot(), chest: chest.snapshot(), entities: state.entities, hostiles: state.hostiles, input: input?.stats() ?? null, mining: mining.snapshot(), walking: walker?.snapshot() ?? null, movement: movement ? { ...movement.snapshot(), runtimeHandoff: structuredClone(host.shared.movementHandoffTiming ?? null) } : null, crafting: crafting.snapshot(), inventoryActions: inventory.snapshot(), interactions: interactions.snapshot(), combat: combat?.snapshot() ?? null, agent: autonomyRuntime.autonomy.snapshot(), idle: { owner: inputOwner, enabled: idleTimer !== null, error: host.shared.idleError ?? null, lastFailure: structuredClone(host.shared.lastInputFailure ?? null) } }
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
  // Logs only for a long trip's preparation (scoped, bounded, never while
  // quarry work runs). 2026-11-14 user decision (relay): logs may be cut only to prepare a long trip, about 10, starting empty-handed. Leaves stay off, the quarry rule stays.
  // Empty hands, confirmed slot by slot from the server (never an unreceived
  // slot), while the long-trip preparation allowance is active.
  function emptyHandedPrep () {
    try {
      if (!longTravelLogAllowance()) return false
      // Main slots may hold only cheap regatherable items (decision a, 2026-11-14);
      // armour and offhand stay empty.
      const cheap = require('./safety/learning-health').cheapItem
      for (const [container, size] of [['main', 36], ['armor', 4], ['offhand', 1]]) {
        const v = inventoryStore.view(container)
        if (v.known !== true || v.slots.length !== size || !v.slots.every(slot => slot.received === true && slot.raw && (slot.raw.network_id === 0 || slot.raw.count === 0 || container === 'main' && cheap(crafting.itemNameOf(slot.raw.network_id))))) return false
      }
      return true
    } catch { return false }
  }
  function longTravelLogAllowance () {
    return !quarryJob?.holdsWork() && require('./modes/player-wood').logsAllowed(host.shared)
  }
  const runner = createRunner({
    logAllowance: () => longTravelLogAllowance(),
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
  // This part lives in autonomy-runtime.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const autonomyRuntime = require('./runtime/autonomy-runtime').createAutonomyRuntime({
    get activeBase () { return activeBase }, get armor () { return armor },
    get actualLifeId () { return actualLifeId },
    get applyStoneAccess () { return applyStoneAccess },
    get baseReturnApproach () { return baseReturnApproach },
    get checkNutritionDispatch () { return checkNutritionDispatch },
    get chest () { return chest },
    get combat () { return combat }, set combat (value) { combat = value },
    get continuationActions () { return continuationActions }, set continuationActions (value) { continuationActions = value },
    get continuationSafety () { return continuationSafety }, set continuationSafety (value) { continuationSafety = value },
    get crafting () { return crafting },
    get createAutonomy () { return createAutonomy },
    get diamondActions () { return diamondActions },
    get disposed () { return disposed }, set disposed (value) { disposed = value },
    get disposing () { return disposing }, set disposing (value) { disposing = value },
    get evaluateThreats () { return evaluateThreats },
    get executeShelterBatch () { return executeShelterBatch },
    get food () { return food },
    get foraging () { return foraging }, set foraging (value) { foraging = value },
    get furnace () { return furnace },
    get host () { return host }, set host (value) { host = value },
    get hut () { return hut }, set hut (value) { hut = value },
    get idleSafety () { return idleSafety }, set idleSafety (value) { idleSafety = value },
    get immediateDiamond () { return immediateDiamond },
    get inputHistoryGeneration () { return inputHistoryGeneration }, set inputHistoryGeneration (value) { inputHistoryGeneration = value },
    get inventory () { return inventory },
    get isSupportedFood () { return isSupportedFood },
    get localLearningWork () { return localLearningWork },
    get longTravelLogAllowance () { return longTravelLogAllowance },
    get mining () { return mining },
    get movement () { return movement }, set movement (value) { movement = value },
    get nextDiamondAction () { return nextDiamondAction },
    get nextSurvivalAction () { return nextSurvivalAction },
    get normalizeReachableTunnel () { return normalizeReachableTunnel },
    get normalizeUnobservedTunnel () { return normalizeUnobservedTunnel },
    get nutritionInventoryReady () { return nutritionInventoryReady },
    get nutritionSourceAllowed () { return nutritionSourceAllowed },
    get nutritionSword () { return nutritionSword },
    get nutritionTarget () { return nutritionTarget },
    get observedState () { return observedState },
    get observePortableWorksite () { return observePortableWorksite },
    get observeStationSupplies () { return observeStationSupplies },
    get observeStoneAccess () { return observeStoneAccess },
    get planningWorld () { return planningWorld },
    get portablePrimitive () { return portablePrimitive },
    get prospecting () { return prospecting },
    get raw () { return raw },
    get readyNightSoilShelter () { return readyNightSoilShelter },
    get recovery () { return recovery }, set recovery (value) { recovery = value },
    get require () { return require },
    get requireIdle () { return requireIdle },
    get resourceMinHealth () { return resourceMinHealth },
    get runner () { return runner },
    get runStoneTunnel () { return runStoneTunnel },
    get safetySnapshot () { return safetySnapshot },
    get selectReadyOreTunnel () { return selectReadyOreTunnel },
    get shelter () { return shelter }, set shelter (value) { shelter = value },
    get tunneling () { return tunneling }, set tunneling (value) { tunneling = value },
    get useCurrentAccess () { return useCurrentAccess },
    get walker () { return walker }, set walker (value) { walker = value },
    get withPortableMovementLease () { return withPortableMovementLease },
    get working () { return working }
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
    const ownedMining = { preview: own(targets => mining.preview(targets)), start: own(targets => runtimeOperations.operations.mining.start(targets)), stop: reason => { if (combatOwnsInput()) return mining.snapshot(); return currentGeneration() ? mining.stop(reason) : generationStream.stop() } }
    const ownedMovement = { preview: own((target, options) => runtimeOperations.operations.movement.preview(target, tagPortableOwnedMove(target, options))), start: own((target, options) => startMotion('navigation', target, tagPortableOwnedMove(target, options))), stop: reason => { if (combatOwnsInput()) return generationMovement.snapshot(); return portableMovementLease?.kind === 'excavate' ? stopPortableMovement(portableMovementLease, reason) : generationMovement.stop(reason) } }
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

    generationForaging = createForaging({ getState: () => { requireGeneration(); const state = observedState(); return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: Number.isSafeInteger(host.shared.deathRespawn?.deathId) ? actualLifeId() : null } } }, verifyQueuedLanding: verifyForagingQueuedLanding, world: host.world, entities: host.entities, movement: ownedMovement, getMovement: () => generationMovement.snapshot(), combat: { previewHunt: own(id => generationCombat.previewHunt(id)), hunt: own(id => runtimeOperations.operations.combat.hunt(id)), cancel: reason => generationCombat.cancel(reason) }, onProgress: data => { if (currentGeneration()) host.noteProgress(data) } })
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
    const generationShelter = createShelter({ getState: () => { requireGeneration(); return observedState() }, world: host.world, planner: planShelter, mining: ownedMining, getMining: own(() => mining.snapshot()), movement: baseMovement, getMovement: () => generationMovement.snapshot(), inventory: { equip: own(slot => runtimeOperations.operations.inventory.equip(slot)) }, interactions: { previewPlace: own(data => interactions.previewPlace(data)), placeBlock: own(data => runtimeOperations.operations.interactions.placeBlock(data)) }, memo: host.shared.shelterMemo, maxTotalActions: 512, onProgress: data => { if (currentGeneration()) noteShelterProgress(data) } })
    shelter = generationShelter
    const generationHut = createHut({ getState: () => { requireGeneration(); return observedState() }, world: host.world, planner: planHut, mining: ownedMining, getMining: own(() => mining.snapshot()), movement: baseMovement, getMovement: () => generationMovement.snapshot(), inventory: { equip: own(slot => runtimeOperations.operations.inventory.equip(slot)), cancel: cancelBackgroundInventory }, interactions: { previewPlace: own(data => interactions.previewPlace(data)), placeBlock: own(data => runtimeOperations.operations.interactions.placeBlock(data)), cancel: reason => { if (!combatOwnsInput()) interactions.cancel(reason) } }, memo: host.shared.hutMemo, maxActions: 32, maxTotalActions: 512, onProgress: data => { if (currentGeneration()) noteHutProgress(data) } })
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
        idleSafetyRuntime.requireSafety()
        const current = working()
        if (!sameRouteScope(routeScope(state), routeScope(current)) || Math.hypot(current.position.x - state.position.x, current.position.y - state.position.y, current.position.z - state.position.z) > 0.05 || !context?.receiptKey || typeof context.validateTail !== 'function') return null
        const originMode = context.originMode === 'trajectory_landing' ? 'trajectory_landing' : 'target_landing'
        const witness = queuedTailWitness(state, originMode)
        const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        if (!witness || !(stamp(witness.anchor.rawStamp) > stamp(context.previousPose?.stamp)) || originMode === 'target_landing' && (Math.hypot(state.rawServerPosition.x - context.target.x, state.rawServerPosition.z - context.target.z) > 0.4 || Math.abs(state.rawServerPosition.y - 1.62 - context.target.y) > 1e-4)) return null
        queuedTailProofs.set(context.receiptKey, { operationId: idleSafetyRuntime.owners.escape?.operationId ?? null, health: state.health, originMode, anchorTick: witness.anchorTick, rawPosition: structuredClone(state.rawServerPosition), rawStamp: state.rawServerPositionUpdatedAt, validateTail: context.validateTail })
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
      const current = idleSafetyRuntime.safetyState()
      return coherent(current) && origin(current) ? current : null
    }

    async function verifyCompletedDryProgress (result, observed, { signal, operationId } = {}) {
      idleSafetyRuntime.requireSafety()
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
      const current = idleSafetyRuntime.safetyState()
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
    // This part lives in idle-safety-runtime.js. It reads and writes these bindings of
    // this closure through accessors, so each use sees the current value exactly
    // as the code did when it was written here.
    const idleSafetyRuntime = require('./runtime/idle-safety-runtime').createIdleSafetyRuntime({
      get activeUnarmedSpiderFloor () { return activeUnarmedSpiderFloor },
      get actualLifeId () { return actualLifeId },
      get autonomy () { return autonomyRuntime.autonomy },
      get boundedJumpSearch () { return boundedJumpSearch }, set boundedJumpSearch (value) { boundedJumpSearch = value },
      get cancelBackgroundInventory () { return cancelBackgroundInventory },
      get captureWorkActors () { return captureWorkActors },
      get chestStatus () { return chestStatus },
      get clearanceDistanceAllowed () { return clearanceDistanceAllowed },
      get clearanceEquipmentKey () { return clearanceEquipmentKey },
      get clearanceTargetAllowed () { return clearanceTargetAllowed },
      get closeReturnedHut () { return closeReturnedHut },
      get combatAttackExposure () { return combatAttackExposure },
      get combatOwnsInput () { return combatOwnsInput },
      get completedDryProofs () { return completedDryProofs },
      get constrainedSecondaryFloor () { return constrainedSecondaryFloor },
      get continuationScope () { return continuationScope },
      get crafting () { return crafting },
      get craftStatus () { return craftStatus },
      get createGuardedRoute () { return createGuardedRoute },
      get createNavigator () { return createNavigator },
      get createWaterCounterattack () { return createWaterCounterattack },
      get currentGeneration () { return currentGeneration },
      get delay () { return delay },
      get depotBuilder () { return depotBuilder }, set depotBuilder (value) { depotBuilder = value },
      get depotStorage () { return depotStorage }, set depotStorage (value) { depotStorage = value },
      get diagnoseStrikeBody () { return diagnoseStrikeBody },
      get drownedStepEquipmentKey () { return drownedStepEquipmentKey },
      get drownedStepThreatAllowed () { return drownedStepThreatAllowed },
      get escapePaused () { return escapePaused },
      get evaluateThreats () { return evaluateThreats },
      get excavation () { return excavation }, set excavation (value) { excavation = value },
      get food () { return food },
      get foraging () { return foraging }, set foraging (value) { foraging = value },
      get furnace () { return furnace },
      get generationCombat () { return generationCombat },
      get generationHistory () { return generationHistory },
      get generationHut () { return generationHut },
      get generationInput () { return generationInput },
      get generationMovement () { return generationMovement },
      get generationPhysics () { return generationPhysics },
      get generationPlanningPhysics () { return generationPlanningPhysics },
      get generationSafety () { return generationSafety },
      get generationShelter () { return generationShelter },
      get generationStream () { return generationStream },
      get guardRoute () { return guardRoute }, set guardRoute (value) { guardRoute = value },
      get guardRouteProgress () { return guardRouteProgress }, set guardRouteProgress (value) { guardRouteProgress = value },
      get historyScope () { return historyScope },
      get host () { return host }, set host (value) { host = value },
      get idleSafety () { return idleSafety }, set idleSafety (value) { idleSafety = value },
      get inputHistory () { return inputHistory }, set inputHistory (value) { inputHistory = value },
      get inputOwner () { return inputOwner }, set inputOwner (value) { inputOwner = value },
      get inspectEmergencyLeafPacket () { return inspectEmergencyLeafPacket }, set inspectEmergencyLeafPacket (value) { inspectEmergencyLeafPacket = value },
      get inspectIdleEscape () { return inspectIdleEscape }, set inspectIdleEscape (value) { inspectIdleEscape = value },
      get inspectIdleEscapePacket () { return inspectIdleEscapePacket }, set inspectIdleEscapePacket (value) { inspectIdleEscapePacket = value },
      get inspectPartialEscapePacket () { return inspectPartialEscapePacket }, set inspectPartialEscapePacket (value) { inspectPartialEscapePacket = value },
      get interactions () { return interactions },
      get inventory () { return inventory },
      get isUnarmedCreeperZombie () { return isUnarmedCreeperZombie },
      get knownSurfaceBody () { return knownSurfaceBody },
      get lightweightUserState () { return lightweightUserState },
      get logEscapePhase () { return logEscapePhase },
      get lowHealthSurfaceEligible () { return lowHealthSurfaceEligible },
      get maintainIdle () { return maintainIdle },
      get mining () { return mining },
      get motionActive () { return motionActive },
      get motionOrigin () { return motionOrigin }, set motionOrigin (value) { motionOrigin = value },
      get navigationDestination () { return navigationDestination },
      get offhandTotem () { return offhandTotem },
      get outsideSkeletonFloor () { return outsideSkeletonFloor },
      get outsideUnarmedSpiderFloor () { return outsideUnarmedSpiderFloor },
      get own () { return own },
      get ownedMining () { return ownedMining },
      get pendingStops () { return pendingStops },
      get planEmergencyLeafAsync () { return planEmergencyLeafAsync },
      get planLearningShore () { return planLearningShore },
      get planningWorld () { return planningWorld },
      get planProtectiveDrownedStepAsync () { return planProtectiveDrownedStepAsync },
      get planProtectiveSkeletonStepAsync () { return planProtectiveSkeletonStepAsync },
      get planRecentDamageRetreat () { return planRecentDamageRetreat },
      get preMovementFences () { return preMovementFences },
      get protectiveDrownedStepCurrent () { return protectiveDrownedStepCurrent },
      get protectiveSkeletonStepCurrent () { return protectiveSkeletonStepCurrent },
      get proveLearningShoreRoute () { return proveLearningShoreRoute },
      get proveLowHealthSurfaceRoute () { return proveLowHealthSurfaceRoute },
      get queuedMotionFrames () { return queuedMotionFrames }, set queuedMotionFrames (value) { queuedMotionFrames = value },
      get raw () { return raw },
      get recovery () { return recovery }, set recovery (value) { recovery = value },
      get requireGeneration () { return requireGeneration },
      get resolveWorkActors () { return resolveWorkActors },
      get resourceMinHealth () { return resourceMinHealth },
      get retreatFrameAllowed () { return retreatFrameAllowed },
      get routeInventory () { return routeInventory },
      get routeMovement () { return routeMovement },
      get routeScope () { return routeScope },
      get routeState () { return routeState },
      get safetyDispatchEpoch () { return safetyDispatchEpoch }, set safetyDispatchEpoch (value) { safetyDispatchEpoch = value },
      get sameRouteScope () { return sameRouteScope },
      get selectConstrainedPrimary () { return selectConstrainedPrimary },
      get shoreScore () { return shoreScore },
      get skeletonStepThreatAllowed () { return skeletonStepThreatAllowed },
      get surfaceReturn () { return surfaceReturn }, set surfaceReturn (value) { surfaceReturn = value },
      get terrainOcclusionApplies () { return terrainOcclusionApplies },
      get tunneling () { return tunneling }, set tunneling (value) { tunneling = value },
      get unarmedCreeperDrowned () { return unarmedCreeperDrowned },
      get unarmedWaterDrowned () { return unarmedWaterDrowned },
      get unarmedWaterZombie () { return unarmedWaterZombie },
      get unarmedZombieFloor () { return unarmedZombieFloor },
      get unprovedInputFrames () { return unprovedInputFrames }, set unprovedInputFrames (value) { unprovedInputFrames = value },
      get userBehaviorOwns () { return userBehaviorOwns },
      get userScope () { return userScope },
      get verifyCompletedDryProgress () { return verifyCompletedDryProgress },
      get verifyQueuedTail () { return verifyQueuedTail },
      get verifyQueuedTailHandoff () { return verifyQueuedTailHandoff },
      get verifyRouteOrigin () { return verifyRouteOrigin },
      get verifyRouteStanding () { return verifyRouteStanding },
      get WORK_MARGIN () { return WORK_MARGIN },
      get workEscapeEvaluation () { return workEscapeEvaluation },
      get working () { return working }
    })
    function verifyUnarmedBody (...args) { return idleSafetyRuntime.verifyUnarmedBody(...args) }
    const generationSafety = createIdleSafety(idleSafetyRuntime.generationSafetyPorts)
    idleSafety = generationSafety
    // This part lives in user-control-runtime.js. It reads and writes these bindings of
    // this closure through accessors, so each use sees the current value exactly
    // as the code did when it was written here.
    const userControl = require('./runtime/user-control-runtime').createUserControlRuntime({
      get actualLifeId () { return actualLifeId },
      get allActors () { return allActors },
      get armor () { return armor },
      get autonomy () { return autonomyRuntime.autonomy },
      get bowSightClearAt () { return bowSightClearAt },
      get cancelChunkMovement () { return cancelChunkMovement },
      get chest () { return chest },
      get chestStatus () { return chestStatus },
      get chunkMoveHeld () { return chunkMoveHeld },
      get combatAttackExposure () { return combatAttackExposure },
      get combatExposure () { return combatExposure },
      get crafting () { return crafting },
      get craftInventory () { return craftInventory },
      get craftStatus () { return craftStatus },
      get createDefenseAnchor () { return createDefenseAnchor },
      get createNavigator () { return createNavigator },
      get createSightStanceSearch () { return createSightStanceSearch },
      get createUserBehaviors () { return createUserBehaviors },
      get currentGeneration () { return currentGeneration },
      get defenseEnabled () { return defenseEnabled },
      get defenseMovementAllowed () { return defenseMovementAllowed },
      get delay () { return delay },
      get depotBuilder () { return depotBuilder }, set depotBuilder (value) { depotBuilder = value },
      get depotPrebuild () { return depotPrebuild }, set depotPrebuild (value) { depotPrebuild = value },
      get depotStorage () { return depotStorage }, set depotStorage (value) { depotStorage = value },
      get disposed () { return disposed }, set disposed (value) { disposed = value },
      get disposing () { return disposing }, set disposing (value) { disposing = value },
      get evaluateThreats () { return evaluateThreats },
      get excavation () { return excavation }, set excavation (value) { excavation = value },
      get food () { return food },
      get foraging () { return foraging }, set foraging (value) { foraging = value },
      get fullStandingGeometry () { return fullStandingGeometry },
      get furnace () { return furnace },
      get generationCombat () { return generationCombat },
      get generationHut () { return generationHut },
      get generationInput () { return generationInput },
      get generationMovement () { return generationMovement },
      get generationPhysics () { return generationPhysics },
      get generationPillar () { return generationPillar }, set generationPillar (value) { generationPillar = value },
      get generationSafety () { return generationSafety },
      get generationShelter () { return generationShelter },
      get generationStream () { return generationStream },
      get host () { return host }, set host (value) { host = value },
      get idleSafetyRuntime () { return idleSafetyRuntime },
      get interactions () { return interactions },
      get inventory () { return inventory },
      get KITE_ANGLES () { return KITE_ANGLES },
      get KITE_LANDING_POLLS () { return KITE_LANDING_POLLS },
      get KITE_RADII () { return KITE_RADII },
      get knownSurfaceBody () { return knownSurfaceBody },
      get lightweightRawState () { return lightweightRawState },
      get lightweightUserState () { return lightweightUserState },
      get manualChestStorage () { return manualChestStorage }, set manualChestStorage (value) { manualChestStorage = value },
      get manualShulkerAbort () { return manualShulkerAbort }, set manualShulkerAbort (value) { manualShulkerAbort = value },
      get manualShulkerRecovery () { return manualShulkerRecovery }, set manualShulkerRecovery (value) { manualShulkerRecovery = value },
      get mining () { return mining },
      get motionActive () { return motionActive },
      get motionOrigin () { return motionOrigin }, set motionOrigin (value) { motionOrigin = value },
      get movement () { return movement }, set movement (value) { movement = value },
      get onUncertain () { return onUncertain },
      get pendingStops () { return pendingStops },
      get portableMovementOwner () { return portableMovementOwner }, set portableMovementOwner (value) { portableMovementOwner = value },
      get portableMovementSerial () { return portableMovementSerial }, set portableMovementSerial (value) { portableMovementSerial = value },
      get prospecting () { return prospecting },
      get quarryCancellationRevision () { return quarryCancellationRevision }, set quarryCancellationRevision (value) { quarryCancellationRevision = value },
      get quarryCanContinue () { return quarryCanContinue },
      get quarryCanSelectTarget () { return quarryCanSelectTarget },
      get quarryCombatArmed () { return quarryCombatArmed }, set quarryCombatArmed (value) { quarryCombatArmed = value },
      get quarryEgressAbort () { return quarryEgressAbort }, set quarryEgressAbort (value) { quarryEgressAbort = value },
      get quarryEgressTask () { return quarryEgressTask }, set quarryEgressTask (value) { quarryEgressTask = value },
      get quarryJob () { return quarryJob }, set quarryJob (value) { quarryJob = value },
      get quarryPillarTask () { return quarryPillarTask }, set quarryPillarTask (value) { quarryPillarTask = value },
      get quarryPlacementPreparation () { return quarryPlacementPreparation }, set quarryPlacementPreparation (value) { quarryPlacementPreparation = value },
      get quarryRetreatDepth () { return quarryRetreatDepth }, set quarryRetreatDepth (value) { quarryRetreatDepth = value },
      get raw () { return raw },
      get rawScope () { return rawScope },
      get recovery () { return recovery }, set recovery (value) { recovery = value },
      get rememberCurrentMeleeReach () { return rememberCurrentMeleeReach },
      get replaying () { return replaying }, set replaying (value) { replaying = value },
      get requestInventoryResyncWithReceipt () { return requestInventoryResyncWithReceipt },
      get require () { return require },
      get requireGeneration () { return requireGeneration },
      get resetHeld () { return resetHeld },
      get resourceMinHealth () { return resourceMinHealth },
      get startIdle () { return startIdle },
      get stopOrdinaryUserStream () { return stopOrdinaryUserStream },
      get surfaceReturn () { return surfaceReturn }, set surfaceReturn (value) { surfaceReturn = value },
      get surfaceReturnOwner () { return surfaceReturnOwner }, set surfaceReturnOwner (value) { surfaceReturnOwner = value },
      get threatReachability () { return threatReachability },
      get tickUserBehaviors () { return tickUserBehaviors },
      get tunneling () { return tunneling }, set tunneling (value) { tunneling = value },
      get userBehaviorError () { return userBehaviorError },
      get userBehaviorGenerationScope () { return userBehaviorGenerationScope }, set userBehaviorGenerationScope (value) { userBehaviorGenerationScope = value },
      get userBehaviorLease () { return userBehaviorLease }, set userBehaviorLease (value) { userBehaviorLease = value },
      get userBehaviors () { return userBehaviors }, set userBehaviors (value) { userBehaviors = value },
      get userBehaviorSleeping () { return userBehaviorSleeping }, set userBehaviorSleeping (value) { userBehaviorSleeping = value },
      get userBehaviorSnapshot () { return userBehaviorSnapshot },
      get userBehaviorTimer () { return userBehaviorTimer }, set userBehaviorTimer (value) { userBehaviorTimer = value },
      get userBehaviorWakePending () { return userBehaviorWakePending }, set userBehaviorWakePending (value) { userBehaviorWakePending = value },
      get UserCombatItem () { return UserCombatItem },
      get userScope () { return userScope },
      get walker () { return walker }, set walker (value) { walker = value },
      get working () { return working },
      get yieldPortableMovement () { return yieldPortableMovement }
    })
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
    // The server's own spawn-point record (a bed used on a long trip is confirmed by it).
    if (name === 'set_spawn_position') host.shared.lastSpawnSet = { type: packet.spawn_type ?? null, position: packet.player_position ?? packet.world_position ?? null, dimension: packet.dimension ?? null, at: Date.now() }
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
    if (!replaying && name === 'entity_event' && (packet.event_id === 'consume_totem' || packet.event_id === 65) && String(packet.runtime_entity_id) === String(raw().runtimeEntityId)) {
      host.shared.totemConsumedAt = Date.now()
      try { inventoryStore.forget('offhand', 0, 'totem_consumed') } catch {}
      try { host.log(`不死のトーテムが発動しました: オフハンドを未受信として扱い、体力による保護を戻します (HP ${raw().health ?? '?'})`) } catch {}
    }
    inventoryStore.apply(name, packet, { replaying })
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
      host.shared.travelLastDamageAt = Date.now()
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
    let previous={...initial.position};const G=r=>(host.shared.waterGuardWhy=r,false)
    return {...options,continueAfterReplay:options.continueAfterReplay??true,beforeInput:frame=>{
      const current=lightweightUserState();current.lifecycle={...current.lifecycle,deathId:movementKnownLife()};const p=frame?.packetPosition,n=frame?.predictedState
      if(disposed||disposing||movement!==controller||inputHistoryGeneration!==generation||portableMovementSerial!==serial||userBehaviorForceRevision!==force||controller.snapshot().phase!=='moving'||JSON.stringify(continuationScope(current))!==JSON.stringify(scope))return G('scope')
      if(current.emptyHandedPrep!==true){if(current.health<initial.health)return G('hurt');if(current.entityStats?.unknownPositions!==0)return G('unknown')}
      if(!p||!n?.position||!['x','y','z'].every(k=>Number.isFinite(p[k])&&Number.isFinite(n.position[k]))||Math.hypot(p.x-n.position.x,p.y-n.position.y-1.62,p.z-n.position.z)>1e-4||n.isInLava)return G('packet')
      const risk=evaluateThreats(current,current.entities,{observationRadius:32})
      // Empty-handed trip prep (2026-11-14): nothing to lose, so hostiles near
      // the water do not hold the bot (live 10:19: a drowned refused every swim).
      if (current.emptyHandedPrep === true) {}
      else if (combatAware) {
        if (!chunkTravelThreatsClear({ state: current, previous, next: p, risk, attackExposure: combatAttackExposure })) return G('threat')
      } else {
        if(risk.requiresObservation||risk.threats.length)return false
        for(const a of [...risk.outsideDanger,...risk.suppressedByTerrain]){
        if(!current.entities.some(e=>String(e.runtimeId)===a.runtimeId&&e.uniqueId!=null&&/^-?\d+$/.test(String(e.uniqueId))&&String(e.uniqueId)!=='0'&&e.entityType===a.name&&e.dimension===current.dimension&&e.positionKnown===true&&e.position&&['x','y','z'].every(k=>Number.isFinite(e.position[k]))))return false
        const q=a.position,dx=p.x-previous.x,dy=p.y-previous.y,dz=p.z-previous.z,den=dx*dx+dy*dy+dz*dz,t=den?Math.max(0,Math.min(1,((q.x-previous.x)*dx+(q.y-previous.y)*dy+(q.z-previous.z)*dz)/den)):0
        if(Math.hypot(previous.x+t*dx-q.x,previous.y+t*dy-q.y,previous.z+t*dz-q.z)<a.dangerRadius-1e-4)return false
        }
      }
      try{for(let x=Math.floor(n.position.x-.3+1e-6);x<=Math.floor(n.position.x+.3-1e-6);x++)for(let z=Math.floor(n.position.z-.3+1e-6);z<=Math.floor(n.position.z+.3-1e-6);z++)for(let y=Math.floor(n.position.y+1e-6);y<=Math.floor(n.position.y+1.8-1e-6);y++){
        const b=idlePhysics.blockAt({x,y,z});if(!b||b.known===false||['lava','flowing_lava','fire','soul_fire','magma','magma_block','cactus'].includes(String(b.name).replace(/^minecraft:/,''))||!Array.isArray(b.shapes))return G('body')
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
        // Long-trip walks use the chunk-move admission rule for water frames (live
        // 2026-11-14: any listed hostile, e.g. a drowned in the lake, rejected every
        // swim frame and the bot stayed in the water for hours).
        } else preparedPortableOptions = normalWaterMovementOptions(portableMovementOptions(target, options), { combatAware: !!travelRuntime.longTravel?.status?.().busy })
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
  // This part lives in runtime-operations.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const runtimeOperations = require('./runtime/runtime-operations').createRuntimeOperations({
    get activeBase () { return activeBase },
    get allActors () { return allActors },
    get armor () { return armor },
    get armorAutoAllowed () { return armorAutoAllowed },
    get armorTask () { return armorTask }, set armorTask (value) { armorTask = value },
    get armorWorkFree () { return armorWorkFree },
    get autonomy () { return autonomyRuntime.autonomy },
    get bowSightClearAt () { return bowSightClearAt },
    get cancelChunkMovement () { return cancelChunkMovement },
    get cancelQuarryRestore () { return cancelQuarryRestore },
    get chest () { return chest },
    get chestStatus () { return chestStatus },
    get chunkMoveHeld () { return chunkMoveHeld },
    get chunkTravel () { return chunkTravel }, set chunkTravel (value) { chunkTravel = value },
    get clearMovementDestination () { return clearMovementDestination },
    get clearNavigationDestination () { return clearNavigationDestination },
    get combat () { return combat }, set combat (value) { combat = value },
    get combatExposure () { return combatExposure },
    get confirmQuarryPosition () { return confirmQuarryPosition },
    get controlLocation () { return controlLocation },
    get crafting () { return crafting },
    get createPlainsLocator () { return createPlainsLocator },
    get createStoragePlacementAudit () { return createStoragePlacementAudit },
    get defenseEnabled () { return defenseEnabled },
    get depotMission () { return depotMission }, set depotMission (value) { depotMission = value },
    get depotPrebuild () { return depotPrebuild }, set depotPrebuild (value) { depotPrebuild = value },
    get disposed () { return disposed }, set disposed (value) { disposed = value },
    get disposing () { return disposing }, set disposing (value) { disposing = value },
    get emptyHandedPrep () { return emptyHandedPrep },
    get ensureChunkTravel () { return ensureChunkTravel },
    get ensureLoadoutReset () { return ensureLoadoutReset },
    get ensureLongTravel () { return ensureLongTravel },
    get ensureManualChestStorage () { return ensureManualChestStorage },
    get ensureQuarryJob () { return ensureQuarryJob },
    get equipManualArmor () { return equipManualArmor },
    get excavation () { return excavation }, set excavation (value) { excavation = value },
    get executeSurfaceReturn () { return executeSurfaceReturn },
    get findFlatArea () { return findFlatArea },
    get food () { return food },
    get foodKnownLife () { return foodKnownLife },
    get foraging () { return foraging }, set foraging (value) { foraging = value },
    get furnace () { return furnace },
    get getRegisteredQuarryHomeSite () { return getRegisteredQuarryHomeSite },
    get guardRoute () { return guardRoute }, set guardRoute (value) { guardRoute = value },
    get guardRouteProgress () { return guardRouteProgress }, set guardRouteProgress (value) { guardRouteProgress = value },
    get guardRouteSnapshot () { return guardRouteSnapshot },
    get host () { return host }, set host (value) { host = value },
    get hut () { return hut }, set hut (value) { hut = value },
    get idlePhysicsState () { return idlePhysicsState }, set idlePhysicsState (value) { idlePhysicsState = value },
    get idleSafety () { return idleSafety }, set idleSafety (value) { idleSafety = value },
    get inputHistory () { return inputHistory }, set inputHistory (value) { inputHistory = value },
    get interactions () { return interactions },
    get inventory () { return inventory },
    get inventoryInspection () { return inventoryInspection },
    get inventoryLifeBaseKey () { return inventoryLifeBaseKey },
    get inventoryStore () { return inventoryStore },
    get lightweightRawState () { return lightweightRawState },
    get loadManualShulkerRecovery () { return loadManualShulkerRecovery },
    get loadoutReset () { return loadoutReset }, set loadoutReset (value) { loadoutReset = value },
    get loadQuarryFile () { return loadQuarryFile },
    get loadShoreHistory () { return loadShoreHistory },
    get logicalWorkHeld () { return logicalWorkHeld },
    get longTravelLogAllowance () { return longTravelLogAllowance },
    get manualChestStorage () { return manualChestStorage }, set manualChestStorage (value) { manualChestStorage = value },
    get manualGroundAccessProof () { return manualGroundAccessProof },
    get manualRecoveryState () { return manualRecoveryState },
    get manualShulkerAbort () { return manualShulkerAbort }, set manualShulkerAbort (value) { manualShulkerAbort = value },
    get manualShulkerDocument () { return manualShulkerDocument }, set manualShulkerDocument (value) { manualShulkerDocument = value },
    get manualShulkerRecovery () { return manualShulkerRecovery }, set manualShulkerRecovery (value) { manualShulkerRecovery = value },
    get manualShulkerTask () { return manualShulkerTask }, set manualShulkerTask (value) { manualShulkerTask = value },
    get measureSnapshots () { return measureSnapshots },
    get mining () { return mining },
    get missionJournal () { return missionJournal },
    get missionReady () { return missionReady },
    get motionOrigin () { return motionOrigin }, set motionOrigin (value) { motionOrigin = value },
    get movement () { return movement }, set movement (value) { movement = value },
    get movementDestination () { return movementDestination },
    get nearestHostileDistance () { return nearestHostileDistance },
    get normalizeChunkArea () { return normalizeChunkArea },
    get ownedCall () { return ownedCall }, set ownedCall (value) { ownedCall = value },
    get plainsLocator () { return plainsLocator }, set plainsLocator (value) { plainsLocator = value },
    get planningWorld () { return planningWorld },
    get portableKeys () { return portableKeys },
    get portableMovementOptions () { return portableMovementOptions },
    get portablePolicyError () { return portablePolicyError },
    get profileCpu () { return profileCpu },
    get prospecting () { return prospecting },
    get publishWalker () { return publishWalker },
    get quarryJob () { return quarryJob }, set quarryJob (value) { quarryJob = value },
    get quarryPillar () { return quarryPillar }, set quarryPillar (value) { quarryPillar = value },
    get quarryPlacementPreparation () { return quarryPlacementPreparation }, set quarryPlacementPreparation (value) { quarryPlacementPreparation = value },
    get quarryPorts () { return quarryPorts }, set quarryPorts (value) { quarryPorts = value },
    get quarryPositionVerifier () { return quarryPositionVerifier }, set quarryPositionVerifier (value) { quarryPositionVerifier = value },
    get quarryRuntime () { return quarryRuntime },
    get quarrySnapshot () { return quarrySnapshot },
    get quarryState () { return quarryState },
    get raw () { return raw },
    get rawScope () { return rawScope },
    get readCurrentTunnelFloors () { return readCurrentTunnelFloors }, set readCurrentTunnelFloors (value) { readCurrentTunnelFloors = value },
    get receivedEquipmentView () { return receivedEquipmentView },
    get recovery () { return recovery }, set recovery (value) { recovery = value },
    get replaying () { return replaying }, set replaying (value) { replaying = value },
    get requestInventoryResyncWithReceipt () { return requestInventoryResyncWithReceipt },
    get requestQuarryTerrain () { return requestQuarryTerrain },
    get require () { return require },
    get requireIdle () { return requireIdle },
    get resetHeld () { return resetHeld },
    get resumeSafety () { return resumeSafety },
    get runManualShulkerRecovery () { return runManualShulkerRecovery },
    get runner () { return runner },
    get safetyDispatchEpoch () { return safetyDispatchEpoch }, set safetyDispatchEpoch (value) { safetyDispatchEpoch = value },
    get safetySnapshot () { return safetySnapshot },
    get selfEffectEvents () { return selfEffectEvents },
    get selfResistance () { return selfResistance },
    get selfSlowFalling () { return selfSlowFalling },
    get shelter () { return shelter }, set shelter (value) { shelter = value },
    get shoreMemory () { return shoreMemory },
    get startMotion () { return startMotion },
    get stopActions () { return stopActions },
    get stopIdleStream () { return stopIdleStream },
    get storagePlacementAudit () { return storagePlacementAudit }, set storagePlacementAudit (value) { storagePlacementAudit = value },
    get surfaceReturn () { return surfaceReturn }, set surfaceReturn (value) { surfaceReturn = value },
    get surfaceReturnOwner () { return surfaceReturnOwner }, set surfaceReturnOwner (value) { surfaceReturnOwner = value },
    get surveyShore () { return surveyShore },
    get testQuarryPillar () { return testQuarryPillar },
    get threatReachability () { return threatReachability },
    get tickUserBehaviors () { return tickUserBehaviors },
    get travelLeafEscape () { return travelLeafEscape },
    get travelPlaceTable () { return travelPlaceTable },
    get travelRuntime () { return travelRuntime },
    get travelSupplyBoxTake () { return travelSupplyBoxTake },
    get tunneling () { return tunneling }, set tunneling (value) { tunneling = value },
    get userBehaviorOwns () { return userBehaviorOwns },
    get userBehaviors () { return userBehaviors }, set userBehaviors (value) { userBehaviors = value },
    get userBehaviorSnapshot () { return userBehaviorSnapshot },
    get userBehaviorTickTask () { return userBehaviorTickTask }, set userBehaviorTickTask (value) { userBehaviorTickTask = value },
    get userBehaviorWakePending () { return userBehaviorWakePending }, set userBehaviorWakePending (value) { userBehaviorWakePending = value },
    get userScope () { return userScope },
    get verifiedInitialLifeReceipt () { return verifiedInitialLifeReceipt },
    get walker () { return walker }, set walker (value) { walker = value },
    get working () { return working },
    get yieldPortableMovement () { return yieldPortableMovement }
  })
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
    const proposal=planOwnedCampReturn({state,world:host.world,campMemo:camp,ownedChest:context.policy.memo().chest,previewMove:(target,options)=>runtimeOperations.operations.movement.preview(target,{...options,avoidance}),previewRoute})
    if(proposal.detour)await delay(0)
    if(!proposal.ready&&proposal.reason==='full_dry_origin_not_proven'&&!prepareOnly){
      // Half over an edge on dry land: step onto the nearest fully supported
      // cell center first, otherwise this re-observes forever.
      const physical=state.predicted?.physicsState??state.physicsState
      if(physical?.onGround===true&&!physical.isInWater&&!physical.isInLava){
        const recenter={partialRecenter:true,maxDistance:2,maxExpanded:64,maxTicks:40}
        for(const target of landEdgeRecenterTargets(host.world,{...state.position,y:state.position.y-1.62})){
          if(runtimeOperations.operations.movement.preview(target.position,{...recenter,avoidance})?.ready!==true)continue
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
      autonomyRuntime.autonomy.stop('Approach the actual owned crafting camp before empty-bag bootstrap');await autonomyRuntime.autonomy.tick()
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
      if (runtimeOperations.operations.movement.preview(target.position, { ...recenter, avoidance })?.ready !== true) continue
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
      const active = autonomyRuntime.autonomy.snapshot()
      if (!userBehaviorOwns() && !pendingStops.size && !active.running && !active.busy && !active.actionActive && Date.now() >= (host.shared.depotMiningRestartAt ?? 0)) {
        host.shared.depotMiningRestartAt = Date.now()+10000
        autonomyRuntime.autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...host.shared.autoOptions,progress:host.shared.autonomyProgress})
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
        const access=runtimeOperations.operations.interactions.previewOpenChest(memory.chest.position)
        if(access.ready===true){
          const opened=await runtimeOperations.operations.chest.open(memory.chest.position)
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
          const close=planPrebuildChestStance({state:lightweightUserState(),scope:context.scope,world:host.world,base:memory.base,target:result.position,previewPlaceAt:({state:projected,target,slot})=>{probeState=projected;return probe.previewPlace({position:target,slot})},previewMove:(target,options)=>runtimeOperations.operations.movement.preview(target,options)})
          if (close?.standpoint) return movePrebuildStance(close,context)
        }
        return {phase:'observing',code:access.reason ?? 'ACCESS_REPREVIEW'}
      }
      if (result.receipt?.operation === 'place' && result.receipt.blockName === 'minecraft:chest') context.policy.acceptChest(result.receipt)
      if (result.receipt?.operation === 'deposit_diamond') context.policy.acceptDeposit(result.receipt)
      if (chestStatus().contentsKnown) context.policy.observeStored(chest.snapshot())
      return result
    }
    if (intent.kind === 'work') return runDepotResource(intent, context)
    if (intent.kind === 'maintain') {
      if (intent.priority === 'inventory_capacity') {
        const memory = context.policy.memo(), state = observedState(), position = memory.chest?.position
        if (!position) return { phase: 'observing', code: 'OWN_CHEST_UNKNOWN' }
        const candidate = state.inventory.items.find(item => ['minecraft:andesite','minecraft:granite','minecraft:diorite','minecraft:raw_copper','minecraft:raw_gold'].includes(item.name) && item.count > 0) ?? state.inventory.items.find(item => item.name === 'minecraft:cobblestone' && item.count > 0 && state.inventory.items.filter(i => i.name === item.name).reduce((n,i) => n+i.count,0) > 64)
        if (!candidate) return { phase: 'observing', code: 'NO_VALIDATED_SURPLUS' }
        if (!chestStatus().contentsKnown || JSON.stringify(chestStatus().window?.position) !== JSON.stringify(position)) return runtimeOperations.operations.chest.open(position)
        const retained = candidate.name === 'minecraft:cobblestone' ? 64 : 0
        const total = state.inventory.items.filter(i => i.name === candidate.name).reduce((n,i) => n+i.count,0)
        return runtimeOperations.operations.chest.depositItem({sourceSlot:candidate.slot,count:Math.min(candidate.count,total-retained),expectedName:candidate.name})
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
    const idle = !disposed && !disposing && !userBehaviorOwns() && !pendingStops.size && !surfaceReturnOwner && !autonomyRuntime.autonomy.snapshot().actionActive && !motionActive() && !input?.stats().running && !idleSafety?.snapshot().busy && mining.snapshot().phase!=='mining' && !food.snapshot().busy && !inventory.snapshot().busy && craftStatus().pendingRequestId==null && !interactions.snapshot().pendingOperation && !depotBuilder?.snapshot().busy && !depotStorage?.snapshot().busy && !foraging?.snapshot().busy && !recovery?.snapshot().busy && !tunneling?.snapshot().busy && !excavation?.snapshot().busy && !guardRoute?.snapshot().busy && !chestStatus().busy && !furnace.snapshot().busy && !combat?.snapshot().busy && !combat?.snapshot().engaging
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
    const receipt=runtimeOperations.operations.movement.start(plan.standpoint,{allowWater:false,maxDistance:6,maxExpanded:300,maxTicks:100,avoidance:plan.avoidance,beforeInput,...(plan.moveOptions??{})})
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
    takeover:async({scope,signal})=>{if(signal.aborted || JSON.stringify(continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())return false;host.shared.depotReacquireWanted=false;autonomyRuntime.autonomy.stop('Prepare a real depot before valuable mining');await autonomyRuntime.autonomy.tick();return !signal.aborted && JSON.stringify(continuationScope(prebuildState()))===JSON.stringify(scope) && prebuildIdle()},
    dispatch:(intent,context)=>dispatchDepotIntent(intent,{...context,prebuild:true}),
    resumeLegacy:async({scope,signal})=>{if(signal.aborted || JSON.stringify(continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())throw Error('Prebuild release owner changed');host.shared.depotReacquireWanted=true;const s=autonomyRuntime.autonomy.snapshot();if(!s.running&&!s.busy&&!s.actionActive)autonomyRuntime.autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...host.shared.autoOptions,progress:host.shared.autonomyProgress})},onProgress:value=>{host.shared.depotPrebuildStatus=value}})
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
    const snapshot = createSnapshotReader()
    return !!(pendingStops.size || motionActive() || snapshot(mining).phase==='mining' || snapshot(mining).activeTarget || foraging?.snapshot().busy || craftStatus().pendingRequestId!=null || inventory.snapshot().busy || interactions.snapshot().pendingOperation || chestStatus().busy || snapshot(furnace).busy || snapshot(food).busy || excavation?.snapshot().busy || tunneling?.snapshot().busy || recovery?.snapshot().busy || surfaceReturn?.snapshot().busy || guardRoute?.snapshot().busy || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy || shelter?.snapshot().busy || hut?.snapshot().busy || snapshot(combat)?.busy || snapshot(combat)?.engaging || userBehaviorOwns())
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
    const { validateRecoveryDocument } = require('./loadout/manual-shulker-recovery')
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
    const fs = require('node:fs/promises'), { validateRecoveryDocument } = require('./loadout/manual-shulker-recovery')
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
    const { createManualShulkerRecovery } = require('./loadout/manual-shulker-recovery')
    const live = () => { if (!quarryPorts) throw new Error('SHULKER_RECOVERY_MOTION_NOT_READY'); return quarryPorts }
    const own = fn => (...args) => live().own(fn)(...args)
    manualShulkerRecovery = createManualShulkerRecovery({
      getState: manualRecoveryState,
      getGroundAccessProof: manualGroundAccessProof,
      getBlock: (x, y, z) => host.world.getBlock(x, y, z),
      crafting,
      chest: {
        open: own((...args) => { requireIdle(); return chest.open(...args) }),
        snapshot: () => chest.snapshot(), status: chestStatus, rawItem: slot => chest.rawItem(slot),
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
        const receipt = await own(slot => runtimeOperations.operations.inventory.equip(slot))(item.slot)
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

  // This part lives in quarry-runtime.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const quarryRuntime = require('./runtime/quarry-runtime').createQuarryRuntime({
    get __dirname () { return __dirname },
    get armor () { return armor },
    get armorTask () { return armorTask },
    get assertJobWorld () { return assertJobWorld },
    get autonomy () { return autonomyRuntime.autonomy },
    get canonicalWindowId () { return canonicalWindowId },
    get chest () { return chest },
    get chestStatus () { return chestStatus },
    get chunkMoveHeld () { return chunkMoveHeld },
    get combat () { return combat },
    get combatAttackExposure () { return combatAttackExposure },
    get continuationScope () { return continuationScope },
    get controlLocation () { return controlLocation },
    get crafting () { return crafting },
    get craftStatus () { return craftStatus },
    get createDepotStorageWork () { return createDepotStorageWork },
    get createQuarryEgressRuntime () { return createQuarryEgressRuntime },
    get createQuarryJob () { return createQuarryJob },
    get createQuarryPortableStorage () { return createQuarryPortableStorage },
    get createQuarryRuntimeAdapter () { return createQuarryRuntimeAdapter },
    get createQuarryStore () { return createQuarryStore },
    get createQuarrySupplies () { return createQuarrySupplies },
    get createQuarryTerrainRequester () { return createQuarryTerrainRequester },
    get createQuarryV22ChestWork () { return createQuarryV22ChestWork },
    get createServerPositionVerifier () { return createServerPositionVerifier },
    get createStoragePlacementAudit () { return createStoragePlacementAudit },
    get delay () { return delay },
    get discardWorkingPrediction () { return discardWorkingPrediction },
    get disposed () { return disposed },
    get disposing () { return disposing },
    get ensureLoadoutReset () { return ensureLoadoutReset },
    get getRegisteredQuarryHomeSite () { return getRegisteredQuarryHomeSite },
    get historicalEmptyPlacement () { return historicalEmptyPlacement },
    get historicalSourceRejection () { return historicalSourceRejection },
    get host () { return host },
    get idleSafety () { return idleSafety },
    get input () { return input },
    get inputHistory () { return inputHistory },
    get inputOwner () { return inputOwner }, set inputOwner (value) { inputOwner = value },
    get inputStream () { return inputStream },
    get interactions () { return interactions },
    get inventory () { return inventory },
    get inventoryInspection () { return inventoryInspection },
    get inventoryResyncDelay () { return inventoryResyncDelay },
    get inventoryResyncIdle () { return inventoryResyncIdle },
    get lightweightUserState () { return lightweightUserState },
    get manualArmorOwner () { return manualArmorOwner },
    get manualChestStorage () { return manualChestStorage },
    get mining () { return mining },
    get motionActive () { return motionActive },
    get observedScope () { return observedScope },
    get operations () { return runtimeOperations.operations },
    get pendingStops () { return pendingStops },
    get permitsExitAction () { return permitsExitAction },
    get planningWorld () { return planningWorld },
    get portableActionOwners () { return portableActionOwners },
    get portableCancellationScope () { return portableCancellationScope },
    get QUARRY_AUTO_RESUMABLE () { return QUARRY_AUTO_RESUMABLE },
    get quarryBehaviorRestore () { return quarryBehaviorRestore }, set quarryBehaviorRestore (value) { quarryBehaviorRestore = value },
    get quarryCancellationRevision () { return quarryCancellationRevision },
    get quarryCombatArmed () { return quarryCombatArmed }, set quarryCombatArmed (value) { quarryCombatArmed = value },
    get quarryEgressAbort () { return quarryEgressAbort }, set quarryEgressAbort (value) { quarryEgressAbort = value },
    get quarryEgressRuntime () { return quarryEgressRuntime }, set quarryEgressRuntime (value) { quarryEgressRuntime = value },
    get quarryEgressTask () { return quarryEgressTask }, set quarryEgressTask (value) { quarryEgressTask = value },
    get quarryJob () { return quarryJob }, set quarryJob (value) { quarryJob = value },
    get quarryNameOf () { return quarryNameOf },
    get quarryPillar () { return quarryPillar },
    get quarryPillarTask () { return quarryPillarTask },
    get quarryPlacementPreparation () { return quarryPlacementPreparation }, set quarryPlacementPreparation (value) { quarryPlacementPreparation = value },
    get quarryPortableStorage () { return quarryPortableStorage }, set quarryPortableStorage (value) { quarryPortableStorage = value },
    get quarryPorts () { return quarryPorts },
    get quarryPositionVerifier () { return quarryPositionVerifier }, set quarryPositionVerifier (value) { quarryPositionVerifier = value },
    get quarryRetreatDepth () { return quarryRetreatDepth },
    get quarrySelectTool () { return quarrySelectTool },
    get quarrySupplies () { return quarrySupplies }, set quarrySupplies (value) { quarrySupplies = value },
    get quarryTerrainRequester () { return quarryTerrainRequester }, set quarryTerrainRequester (value) { quarryTerrainRequester = value },
    get quarryV22Equipment () { return quarryV22Equipment },
    get raw () { return raw },
    get receivedEquipmentView () { return receivedEquipmentView },
    get recoverableQuarry () { return recoverableQuarry },
    get refreshInventoryWithRetry () { return refreshInventoryWithRetry },
    get requestInventoryResyncWithReceipt () { return requestInventoryResyncWithReceipt },
    get require () { return require },
    get requireIdle () { return requireIdle },
    get resetHeld () { return resetHeld },
    get resumeSafety () { return resumeSafety },
    get retryableRecoveryError () { return retryableRecoveryError },
    get sameWindowId () { return sameWindowId },
    get selectRecoveryCandidate () { return selectRecoveryCandidate },
    get startIdle () { return startIdle },
    get storagePlacementAudit () { return storagePlacementAudit }, set storagePlacementAudit (value) { storagePlacementAudit = value },
    get travelRuntime () { return travelRuntime },
    get userBehaviorLease () { return userBehaviorLease },
    get userBehaviorOwns () { return userBehaviorOwns },
    get userBehaviorSnapshot () { return userBehaviorSnapshot },
    get userScope () { return userScope },
    get working () { return working }
  })
  function quarryState (...args) { return quarryRuntime.quarryState(...args) }
  function confirmQuarryPosition (...args) { return quarryRuntime.confirmQuarryPosition(...args) }
  function quarrySnapshot (...args) { return quarryRuntime.quarrySnapshot(...args) }
  function quarryCanSelectTarget (...args) { return quarryRuntime.quarryCanSelectTarget(...args) }
  function quarryCanContinue (...args) { return quarryRuntime.quarryCanContinue(...args) }
  function requestQuarryTerrain (...args) { return quarryRuntime.requestQuarryTerrain(...args) }
  function ensureQuarryJob (...args) { return quarryRuntime.ensureQuarryJob(...args) }
  function testQuarryPillar (...args) { return quarryRuntime.testQuarryPillar(...args) }
  function cancelQuarryRestore (...args) { return quarryRuntime.cancelQuarryRestore(...args) }
  function loadQuarryFile (...args) { return quarryRuntime.loadQuarryFile(...args) }
  function maybeRestoreQuarryJob (...args) { return quarryRuntime.maybeRestoreQuarryJob(...args) }
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
  const inventoryStoreTimer = setInterval(() => { if (disposed || disposing) { clearInterval(inventoryStoreTimer); return } try { inventoryStoreResyncTick() } catch {} }, 1000)
  const worldRetentionTimer = setInterval(() => { if (disposed || disposing) { clearInterval(worldRetentionTimer); return } try { updateWorldRetention() } catch {} }, 5000)
  worldRetentionTimer.unref?.()
  const eventLoopStallWatch = createLoggedStallWatch({
    context: () => describeWork({ quarry: quarryJob?.status?.(), travel: travelRuntime.longTravel?.status?.(), behavior: userBehaviorSnapshot().activeKind }),
    log: line => host.log(line), root: require('node:path').join(__dirname, '..')
  })
  eventLoopStallWatch.start()

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
      const status = autonomyRuntime.autonomy.snapshot()
      // stop() releases running before the current tick finally drains.
      // The next normal behavior tick retries; never start over that owner.
      if (!disposed && !disposing && !pendingStops.size && !userBehaviorOwns() && !host.shared.respawnTerrain?.pending && host.shared.autoWanted && raw().phase === 'spawned' && !raw().spawnPending && host.shared.loadingScreenEnded && !status.running && !status.busy && !status.actionActive) autonomyRuntime.autonomy.start({ objective: 'diamond', diamondCount: 1, maxRunMs: 7200000, maxWaitTicks: 1200, ...host.shared.autoOptions, progress: host.shared.autonomyProgress })
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
        if (armorTask || manualArmorOwner || manualShulkerTask || quarryRuntime.quarryRestoreTask || autonomyRuntime.autonomy.snapshot().running || depotMission?.isBusy() || host.shared.rangedShotUncertain || jobPending(quietJob())) throw Object.assign(new Error('作業・収納・持ち替えの終了を確認してください。'), { code: 'STORAGE_NOT_IDLE' })
      },
      onAcquire: owner => {
        stopIdleStream()
        if (!owner.preview) {
          host.shared.autoWanted = false
          host.shared.quarryAutoResume = false
          host.shared.quarryRestoreDisabled = true
          autonomyRuntime.autonomy.stop('ラージチェストへ収納')
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
      commitEquipment: (kind, slot, item, requestId) => { inventoryStore.commit(kind, slot, item, 'server_item_stack_response') }
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
    const { reconcileMoveOrigin } = require('./movement/move-origin')
    return reconcileMoveOrigin({ state: quarryState(), confirm: (feet, options) => confirmQuarryPosition(feet, options), discardPrediction: discardWorkingPrediction,
      hasSupport: feet => idlePhysics ? idlePhysics.withWorld(host.world, { allowWater: true }).hasSupport(feet) : true, log: message => host.log(message) })
  }
  // Long-distance travel lives in long-travel-runtime.js. It reads and writes
  // these bindings of this closure through accessors, so each use sees the
  // current value exactly as the code did when it was written here.
  const travelRuntime = require('./runtime/long-travel-runtime').createLongTravelRuntime({
    get __dirname () { return __dirname },
    get actualLifeId () { return actualLifeId },
    get allActors () { return allActors },
    get armor () { return armor },
    get armorTask () { return armorTask },
    get armorThreatNear () { return armorThreatNear },
    get armorWorkFree () { return armorWorkFree },
    get autonomy () { return autonomyRuntime.autonomy },
    get cancelChunkMovement () { return cancelChunkMovement },
    get chunkMoveDepth () { return chunkMoveDepth }, set chunkMoveDepth (value) { chunkMoveDepth = value },
    get chunkMoveJobIdentity () { return chunkMoveJobIdentity },
    get chunkMoveLease () { return chunkMoveLease }, set chunkMoveLease (value) { chunkMoveLease = value },
    get chunkTravel () { return chunkTravel }, set chunkTravel (value) { chunkTravel = value },
    get controlLocation () { return controlLocation },
    get crafting () { return crafting },
    get createChunkTravel () { return createChunkTravel },
    get createNavigator () { return createNavigator },
    get depotMission () { return depotMission },
    get discardWorkingPrediction () { return discardWorkingPrediction },
    get disposed () { return disposed },
    get disposing () { return disposing },
    get ensureMovementLifeKnown () { return ensureMovementLifeKnown },
    get host () { return host },
    get idlePhysics () { return idlePhysics },
    get idlePhysicsState () { return idlePhysicsState }, set idlePhysicsState (value) { idlePhysicsState = value },
    get idleSafety () { return idleSafety },
    get interactions () { return interactions },
    get inventory () { return inventory },
    get inventoryStore () { return inventoryStore },
    get loadoutReset () { return loadoutReset },
    get longTravelLogAllowance () { return longTravelLogAllowance },
    get manualArmorOwner () { return manualArmorOwner },
    get manualChestStorage () { return manualChestStorage },
    get manualShulkerTask () { return manualShulkerTask },
    get motionOrigin () { return motionOrigin }, set motionOrigin (value) { motionOrigin = value },
    get movement () { return movement },
    get nearestHostileDistance () { return nearestHostileDistance },
    get operations () { return runtimeOperations.operations },
    get portableMovementSerial () { return portableMovementSerial },
    get quarryJob () { return quarryJob },
    get quarryRestoreTask () { return quarryRuntime.quarryRestoreTask },
    get quarryState () { return quarryState },
    get raw () { return raw },
    get reconcilePlanningOrigin () { return reconcilePlanningOrigin },
    get requestQuarryTerrain () { return requestQuarryTerrain },
    get require () { return require },
    get requireIdle () { return requireIdle },
    get resetHeld () { return resetHeld },
    get resumeSafety () { return resumeSafety },
    get startMotion () { return startMotion },
    get stopChunkMovement () { return stopChunkMovement },
    get stopIdleStream () { return stopIdleStream },
    get verifyChunkMoveLease () { return verifyChunkMoveLease },
    get working () { return working }
  })
  function travelBedOwns (...args) { return travelRuntime.travelBedOwns(...args) }
  function travelShulkerOwns (...args) { return travelRuntime.travelShulkerOwns(...args) }
  function ensureChunkTravel (...args) { return travelRuntime.ensureChunkTravel(...args) }
  function ensureLongTravel (...args) { return travelRuntime.ensureLongTravel(...args) }
  function travelLeafEscape (...args) { return travelRuntime.travelLeafEscape(...args) }
  function travelPlaceTable (...args) { return travelRuntime.travelPlaceTable(...args) }
  function travelSupplyBoxTake (...args) { return travelRuntime.travelSupplyBoxTake(...args) }
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
        if (mining.snapshot().phase === 'mining' || mining.snapshot().activeTarget || depotBuilder?.snapshot().busy || depotStorage?.snapshot().busy || armorTask || manualArmorOwner || manualShulkerTask || quarryRuntime.quarryRestoreTask || autonomyRuntime.autonomy.snapshot().running || depotMission?.isBusy() || host.shared.inventoryUncertain || host.shared.rangedShotUncertain || !host.shared.loadingScreenEnded) throw Object.assign(new Error('採掘・収納・持ち物操作の終了を確認してください。'), { code: 'RESET_NOT_IDLE' })
      },
      acquire: operationId => {
        if (resetHeld()) throw Object.assign(new Error('リセット処理中です。'), { code: 'RESET_BUSY' })
        requireIdle({ loadoutHandoff: true })
        loadoutLease = operationId
        host.shared.autoWanted = false; host.shared.quarryAutoResume = false; host.shared.quarryRestoreDisabled = true
        autonomyRuntime.autonomy.stop('初期アイテムリセット')
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
    operations: runtimeOperations.operations, snapshot: getSnapshot, applyPacket, onSpawn, onRespawn, stopActions, resumeRequested,
    canReload: () => {
      const snapshot = createSnapshotReader()
      return !quarryPlacementPreparation && !chunkMoveHeld() && !resetHeld() && !manualChestStorage?.isBusy() && !host.shared.quarrySurfaceStorageOwner && !quarryV22Equipment.status().busy && !quarryPackingBusy() && !manualShulkerTask && !manualArmorOwner && !quarryPortableStorage?.snapshot?.().busy && !quarrySupplies?.snapshot().busy && !quarryPillar?.snapshot().busy && !quarryPillarTask && !depotPrebuild?.snapshot().busy && !depotMission?.isBusy() && !userBehaviorOwns() && !userBehaviorTickTask && pendingStops.size === 0 && snapshot(mining).phase !== 'mining' && !idleSafety?.snapshot().busy && !['scheduled', 'in_flight'].includes(host.shared.safetyEmergency?.status) && !guardRoute?.snapshot().busy && !hut?.snapshot().busy && !shelter?.snapshot().busy && !snapshot(food).busy && !(foraging?.snapshot().busy || surfaceReturn?.snapshot().busy) && !recovery?.snapshot().busy && !tunneling?.snapshot().busy && !excavation?.snapshot().busy && !(snapshot(furnace).busy || chestStatus().busy) && !inventory.snapshot().busy && craftStatus().pendingRequestId == null && !interactions.snapshot().pendingOperation && !snapshot(combat)?.busy && !snapshot(combat)?.defending && !snapshot(combat)?.engaging
    },
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
      clearInterval(quarryRuntime.quarryRestoreTimer); clearInterval(worldRetentionTimer); eventLoopStallWatch.stop(); clearInterval(inventoryStoreTimer); quarryRuntime.quarryLoadSequence++
      publishWalker()
      autonomyRuntime.autonomy.stop(reason ?? '行動コードを更新します。')
      const cleanup = stopActions(reason ?? '行動コードを更新します。')
      // Stop ordinary inputs synchronously above, then wait for owned reset cleanup.
      await Promise.allSettled([manualShulkerTask, resetDrain, storageDrain, chunkMoveDrain])
      inputStream?.stop()
      inputOwner = 'none'
      await cleanup
      await Promise.allSettled([...pendingStops])
      await autonomyRuntime.autonomy.tick()
      await memoryFlush
      await depotFlush
      await depotPrebuild?.drain()
      await shoreMemory?.flush().catch(error => { host.shared.shoreMemoryError = String(error.message).slice(0, 160) })
      // Live 2026-11-14 13:30: a reload stopped the trip and the bot stood idle
      // until a creeper killed it. A trip running at reload resumes in the new code.
      try { const t = travelRuntime.longTravel?.status?.(); if (t?.busy && t.destination) host.shared.longTravelResume = { destination: { x: t.destination.x, z: t.destination.z }, at: Date.now() } } catch {}
      try { travelRuntime.longTravel?.cancel('RELOAD') } catch {}
      inputStream?.stop()
      disposed = true
    }
  }
}

module.exports = { createRuntime }
