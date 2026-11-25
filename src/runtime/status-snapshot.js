'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createStatusSnapshot (rt) {
  function getDashboardSnapshot (state) {
    return {
      inventoryDetails: rt.inventoryInspection.snapshot(state),
      inventoryConfidence: { known: !rt.host.shared.inventoryUncertain, unresolved: rt.host.shared.inventoryUncertain ?? null },
      vitals: structuredClone(rt.host.shared.vitals ?? {}),
      userBehaviors: rt.userBehaviorSnapshot(),
      quarry: rt.quarrySnapshot({ detail: false })
    }
  }
  function getSnapshot () {
    rt.publishWalker()
    const state = rt.observedState()
    const prospect = rt.prospecting.snapshot()
    const observedOres = prospect.phase === 'idle' ? rt.host.shared.prospecting ?? prospect : prospect
    return { ownedCampBootstrap: structuredClone(rt.host.shared.ownedCampBootstrap ?? null), workHold: rt.host.shared.legacyWorkHoldLease ? {leaseId:rt.host.shared.legacyWorkHoldLease.id,scope:rt.host.shared.legacyWorkHoldLease.scope,expiresAt:rt.host.shared.legacyWorkHoldLease.expiresAt} : null, recentDamageRetreat: structuredClone(rt.host.shared.recentDamageRetreatDiagnostic ?? null), survivalWorkClearance: state.survivalWorkClearance === true, spawnRangedClearance: state.spawnRangedClearance === true, depotPrebuild: rt.depotPrebuild?.snapshot() ?? null, depotMission: rt.depotMission?.snapshot() ?? null, surfaceReturn: rt.surfaceReturn?.snapshot() ?? null, inventoryResync: structuredClone(rt.host.shared.inventoryResync?.lastRequest ?? null), movementCalibration: structuredClone(rt.movementCalibration), learningShoreEscape: structuredClone(rt.host.shared.learningShoreEscape ?? null), startupPriority: structuredClone(rt.host.shared.startupPriority ?? null), userBehaviors: rt.userBehaviorSnapshot(), lowHealthWater: rt.host.shared.lowHealthWaterDiagnostic ? { ...structuredClone(rt.host.shared.lowHealthWaterDiagnostic), timing: structuredClone(rt.host.shared.lowHealthWaterTiming ?? null) } : null, clearance: structuredClone(rt.host.shared.clearanceDiagnostic ?? null), safety: rt.safetySnapshot(), guardRoute: rt.guardRouteSnapshot(), boundedJumpSearch: structuredClone(rt.boundedJumpSearch), queuedPrediction: rt.inputHistory?.snapshot() ?? null, queuedWireClock: structuredClone(rt.actualWireClock.snapshot()), missionMemory: rt.missionJournal.snapshot(), hut: rt.hut?.snapshot() ?? null, shelter: rt.activeBase()?.snapshot() ?? null, shelterKind: rt.activeBase() === rt.hut ? "hut" : "soil_hill", ...rt.require('./runtime/start-info')(rt.host.meta.startGame), worldClocks: structuredClone(rt.host.shared.worldClocks ?? {}), lastServerMotion: structuredClone(rt.host.shared.lastServerMotion ?? null), lastServerCorrection: structuredClone(rt.host.shared.lastServerCorrection ?? null), worldTime: structuredClone(rt.host.shared.worldTime ?? null), threatPolicy: state.threatPolicy, playerPlay: state.playerPlay, foraging: rt.foraging?.snapshot() ?? null, food: rt.food.snapshot(), vitals: structuredClone(rt.host.shared.vitals ?? {}), recovery: rt.recovery?.snapshot() ?? null, excavation: rt.excavation?.snapshot() ?? null, quarry: rt.quarrySnapshot(), tunneling: rt.tunneling?.snapshot() ?? null, heldItem: state.heldItem, runtimeVersion: rt.RUNTIME_VERSION, inventory: state.inventory, inventoryDetails: rt.inventoryInspection.snapshot(state), inventoryStore: rt.inventoryStore.snapshot(), inventoryConfidence: { known: !rt.host.shared.inventoryUncertain, unresolved: rt.host.shared.inventoryUncertain ?? null }, stations: structuredClone(rt.host.shared.stations ?? {}), stationCatalog: structuredClone(rt.host.shared.stationCatalog ?? null), portableWorksite: structuredClone(rt.host.shared.portableWorksiteMemo ?? null), prospecting: observedOres, furnace: rt.furnace.snapshot(), chest: rt.chest.snapshot(), entities: state.entities, hostiles: state.hostiles, input: rt.input?.stats() ?? null, mining: rt.mining.snapshot(), walking: rt.walker?.snapshot() ?? null, movement: rt.movement ? { ...rt.movement.snapshot(), runtimeHandoff: structuredClone(rt.host.shared.movementHandoffTiming ?? null) } : null, crafting: rt.crafting.snapshot(), inventoryActions: rt.inventory.snapshot(), interactions: rt.interactions.snapshot(), combat: rt.combat?.snapshot() ?? null, agent: rt.autonomyRuntime.autonomy.snapshot(), idle: { owner: rt.inputOwner, enabled: rt.idleTimer !== null, error: rt.host.shared.idleError ?? null, lastFailure: structuredClone(rt.host.shared.lastInputFailure ?? null) } }
  }
  return {
    getSnapshot, getDashboardSnapshot
  }
}

module.exports = { createStatusSnapshot }
