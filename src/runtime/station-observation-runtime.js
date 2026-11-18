'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createStationObservationRuntime (rt) {
  async function observeStationSupplies (observed, options) {
    const state = observed.state, life = rt.host.shared.deathRespawn?.deathId
    const current = () => ({ ...rt.working(), entities: rt.host.entities.snapshot({ kind: 'all' }), lifecycle: { deathId: Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) ? rt.host.shared.deathRespawn.deathId : null } })
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !rt.supplyScope(state) || !Number.isSafeInteger(life) || rt.supplyScope(state) !== rt.supplyScope(current())) return observed
    rt.host.shared.stationCatalog = rt.updateStationCatalog({ state, blocks: observed.blocks, catalog: rt.host.shared.stationCatalog })
    const stationPages = rt.readStationPages({ state, stations: rt.host.shared.stations, catalog: rt.host.shared.stationCatalog, world: rt.planningWorld })
    const enriched = { ...observed, stationPages }
    if (!rt.tableMaterialShortfall(state) || !stationPages.craftingTable) return enriched
    const requested = rt.nextDiamondAction(state, enriched, { diamondCount: options?.goal?.diamond ?? 1 })
    if (requested.supplyReturnRequested !== true) return enriched
    let supplyReturn = rt.planSupplyReturn({ state, floors: rt.readCurrentTunnelFloors(), floorScope: { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension }, stationPage: stationPages.craftingTable, world: rt.planningWorld })
    if (supplyReturn.ready) {
      await new Promise(resolve => setImmediate(resolve))
      const fresh = current()
      if (fresh.phase !== 'spawned' || fresh.dead || fresh.isDead || fresh.spawnPending || rt.supplyScope(fresh) !== supplyReturn.scope || fresh.health < state.health || Math.hypot(fresh.position.x - state.position.x, fresh.position.y - state.position.y, fresh.position.z - state.position.z) > 0.1 || !rt.idlePhysics) supplyReturn = { ...supplyReturn, ready: false, reason: 'supply_origin_changed' }
      else {
        const threats = rt.evaluateThreats(fresh, fresh.entities, { observationRadius: 32 })
        if (threats.requiresObservation || threats.threats.length || threats.outsideDanger.length > 64 || (rt.host.entities.stats?.().unknownPositions ?? 0) > threats.unknownPositions.length) supplyReturn = { ...supplyReturn, ready: false, reason: 'supply_threat_observation' }
        else {
          const avoidance = threats.outsideDanger.map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerRadius, padding: 0.5 }))
          try {
            const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.idlePhysics.withWorld(rt.planningWorld, { allowWater: false }) })
            const preview = navigator.plan(navigator.physics.fromServer(fresh), supplyReturn.target, { maxDistance: 12, maxExpanded: 500, avoidance })
            const prefixOnly = preview.ready && preview.waypoints.length <= 2 && preview.waypoints.every(step => supplyReturn.waypoints.some(point => Math.hypot(step.position.x - point.x, step.position.y - point.y, step.position.z - point.z) < 1e-4))
            supplyReturn = { ...supplyReturn, ready: !!prefixOnly, ...(prefixOnly ? {} : { reason: preview.reason ?? 'return_prefix_not_native' }), nativePreview: { ready: !!prefixOnly, waypoints: preview.waypoints, predictionOnly: true, serverConfirmed: false } }
          } catch (error) { supplyReturn = { ...supplyReturn, ready: false, reason: 'return_native_preview_failed' } }
        }
      }
    }
    return { ...enriched, supplyReturn }
  }
  return {
    observeStationSupplies
  }
}

module.exports = { createStationObservationRuntime }
