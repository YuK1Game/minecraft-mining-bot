'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryStatus (rt) {
  function displayCounts (state) {
    if (rt.job.yTop == null || !rt.planner) return null
    const owner = rt.job; const source = rt.planner; const generation = rt.epoch
    const scope = rt.scopeOf(state); const life = rt.lifeOf(state)
    const localRevision = rt.countsRevision; let records = source.revision()
    const world = rt.adapter.worldRevision?.() ?? null
    const terrain = rt.adapter.observeTerrain?.()
    const isCurrent = () => rt.job === owner && rt.planner === source && rt.epoch === generation && rt.countsRevision === localRevision && source.revision() === records && (terrain ? terrain.current() : (rt.adapter.worldRevision?.() ?? null) === world) && rt.scopeOf(rt.adapter.getState()) === scope && rt.lifeOf(rt.adapter.getState()) === life
    const cache = rt.countsCache?.job === owner && rt.countsCache.planner === source && rt.countsCache.scope === scope && rt.countsCache.life === life ? rt.countsCache : null
    const fresh = cache && cache.records === records && cache.localRevision === localRevision && (cache.terrain ? cache.terrain.current() : cache.world === world && rt.now() - cache.at < 2000)
    if (!rt.countsWork && !fresh) {
      // Start outside the status request; even the first display never scans
      // a deep quarry synchronously. An obsolete scan cannot publish a value.
      const run = fn => { const result = terrain ? terrain.run(fn) : fn(); records = source.revision(); return result }
      const work = new Promise(resolve => setImmediate(resolve)).then(() => source.countsAsync(owner.yTop, isCurrent, { run, observeTerrain: terrain ? () => rt.adapter.observeTerrain() : undefined })).then(value => {
        if (value && isCurrent()) rt.countsCache = { job: owner, planner: source, scope, life, records, localRevision, terrain, world, at: rt.now(), value }
      }).catch(() => {}).finally(() => { if (rt.countsWork === work) rt.countsWork = null })
      rt.countsWork = work
    }
    return fresh ? cache.value : null
  }

  function status ({ detail = true } = {}) {
    if (!rt.job) return { state: 'IDLE', job: null }
    const s = rt.adapter.getState()
    const inv = rt.items(s)
    const counts = displayCounts(s)
    const finalCarried = detail && inv ? rt.keepPlan(inv, rt.inventoryPolicy()).deposits : null
    return rt.copy({
      jobId: rt.job.config.jobId, state: ['PAUSED', 'FINISHED'].includes(rt.job.state) && (rt.loopWorker || rt.stopTask || rt.pendingActions.size || rt.savesInFlight) ? 'STOPPING' : rt.job.state, draining: !!(rt.worker || rt.stopTask || rt.pendingActions.size || rt.savesInFlight), persistence: rt.copy(rt.job.persistence ?? null), world: rt.copy(rt.job.world), userRunIntent: rt.job.userRunIntent, result: rt.job.result, pauseReason: rt.job.pauseReason, pauseDetails: rt.job.pauseDetails ?? null,
      acceptedExceptions: rt.job.acceptedExceptionRecord ? { at: rt.job.acceptedExceptionRecord.at, by: rt.job.acceptedExceptionRecord.by, count: rt.job.acceptedExceptionRecord.count, byReason: rt.copy(rt.job.acceptedExceptionRecord.byReason), items: rt.job.acceptedExceptionRecord.items.slice(0, 200) } : null,
      lostCargoBoxes: (rt.job.lostCargoBoxes ?? []).slice(-32).map(r => ({ at: r.acceptedAt, by: r.acceptedBy, operationId: r.operationId, box: r.box, position: r.position, items: r.items ?? [] })),
      autoRetry: rt.autoResumeTimer && rt.autoRetryInfo && rt.job.state === 'PAUSED' ? { ...rt.autoRetryInfo, inSeconds: Math.max(0, Math.ceil((rt.autoRetryInfo.nextAt - rt.now()) / 1000)) } : null,
      chunks: rt.regions?.chunks ?? null, yTop: rt.job.yTop, yBottom: rt.regions?.yBottom ?? null, currentY: rt.job.lastDecision?.y ?? rt.job.cursorY,
      counts, deferred: detail ? rt.planner?.deferredList(30) ?? [] : undefined, deferredCount: rt.planner?.deferredCount() ?? 0, temporary: detail ? rt.planner?.temporaryList() ?? [] : undefined, seals: detail ? rt.planner?.sealList() ?? [] : undefined,
      freeSlots: inv ? rt.freeSlots(inv) : null, health: s?.health ?? null, food: rt.foodOf(s), held: s?.heldItem?.name ?? null,
      storagePolicy: detail ? { ...rt.storageSettings(), pending: rt.job.pendingStorageConfiguration ? { pickupMode: rt.job.pendingStorageConfiguration.pickupMode, depositWhen: rt.job.pendingStorageConfiguration.depositWhen } : null, finalStorageSkipped: rt.copy(rt.job.finalStorageSkipped ?? null), finalCarried: finalCarried ? { stacks: finalCarried.length, count: finalCarried.reduce((n, item) => n + item.count, 0), items: rt.copy(finalCarried) } : null } : undefined,
      passivePickup: detail ? rt.copy(rt.job.passivePickup ?? null) : undefined,
      ledger: rt.ledger.summary(), ledgerDetail: detail ? rt.ledger.export() : undefined, pendingDrops: rt.pendingDrops.length, unreachableItems: detail ? rt.job.unreachableItems ?? [] : undefined,
      combat: detail ? { ...rt.combatBridge.snapshot(), settle: rt.job.settle ?? null, recovery: rt.job.recovery ?? null, interruption: rt.job.interruption } : undefined,
      portableStorage: rt.job.portableStorage ? { operationId: rt.job.portableStorage.operationId, kind: rt.job.portableStorage.selection?.kind, stage: rt.job.portableStorage.checkpoint?.stage ?? 'intent', positions: rt.copy(rt.job.portableStorage.checkpoint?.positions ?? []), why: rt.job.portableStorage.why } : null,
      supplies: { enabled: !!rt.job.config.inventory.supplyBoxes?.length, bindings: detail ? rt.copy(rt.job.config.inventory.supplyBoxes ?? []) : undefined, needs: detail && inv ? rt.supplyNeeds(inv, { ...rt.job.config.inventory, tools: rt.job.config.tools,
        ...(rt.deferredExitSupplies() ? { deferExitSupplies: true, exitPreparing: rt.job.egressPreparation === true, exitDirtTarget: rt.exitDirtGoal() } : {}) }) : null, active: rt.job.supplyRestock ? { operationId: rt.job.supplyRestock.operationId, index: rt.job.supplyRestock.checkpoint?.index ?? null, phase: rt.job.supplyRestock.checkpoint?.phase ?? 'intent' } : null, lastResult: detail ? rt.copy(rt.job.lastSupplyResult ?? null) : undefined },
      egress: rt.egressStatus(inv),
      tools: detail ? { ...rt.copy(rt.job.config.tools), hardMinimumRemaining: 1, states: inv ? inv.map(i => rt.toolState(i, rt.job.config.tools)).filter(Boolean).map(t => ({ slot: t.item.slot, name: t.item.name, remaining: t.remaining ?? null, reserve: t.reserve ?? null, usable: t.usable, reason: t.reason ?? null })) : null } : undefined,
      terrainObservation: detail ? rt.copy(rt.job.terrainObservation ?? null) : undefined,
      fluidDrain: detail && rt.job.fluidDrain ? { source: rt.copy(rt.job.fluidDrain.source?.position ?? null), remaining: rt.job.fluidDrain.remaining, total: rt.job.fluidDrain.cells.length, deadline: rt.job.fluidDrain.deadline } : null,
      lastDecision: detail ? rt.job.lastDecision ?? null : undefined, lastAction: detail ? rt.job.actions.at(-1) ?? null : undefined, deaths: rt.job.deaths, planned: detail ? rt.job.planned : undefined, events: rt.events.slice(-15)
    })
  }
  return {
    status
  }
}

module.exports = { createQuarryStatus }
