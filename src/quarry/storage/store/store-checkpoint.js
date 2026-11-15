'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.

async function openCheckpoint (rt, stage) {
      if (stage.signal?.aborted) throw rt.failure('STORAGE_ABORTED')
      const pendingPlacement = stage.request?.checkpoint?.kind === 'shulker' && stage.request.checkpoint.intent?.type === 'place'
      const initial = pendingPlacement ? rt.placementContext(stage.request.checkpoint) : stage.guard(), selection = stage.request?.selection
      const supplyWork = stage.request?.purpose === 'supply'; stage.supplyWork = supplyWork
      const capacityBatch = stage.request?.purpose === 'capacity_batch'; stage.capacityBatch = capacityBatch
      if (supplyWork && (selection?.kind !== 'shulker' || typeof rt.workWithContainer !== 'function')) throw rt.failure('STORAGE_SUPPLY_UNSUPPORTED')
      if (capacityBatch && (selection?.kind !== 'shulker' || typeof stage.capacityWork !== 'function' || typeof rt.refreshInventory !== 'function')) throw rt.failure('STORAGE_CAPACITY_UNSUPPORTED')
      if (rt.shulkerOnly && selection?.kind !== 'shulker') throw rt.failure('SHULKER_ONLY_STORAGE')
      if (!stage.request?.jobId || typeof stage.request.operationId !== 'string' || !stage.request.operationId.length || stage.request.operationId.length > 200 || !['shulker', 'double_chest', 'single_chest'].includes(selection?.kind) || !Array.isArray(selection.sources)) throw rt.failure('STORAGE_REQUEST_INVALID')
      stage.cp = stage.request.checkpoint ? rt.copy(stage.request.checkpoint) : null
      if (stage.cp) {
        if ((stage.cp.purpose === 'supply') !== supplyWork) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if ((stage.cp.purpose === 'capacity_batch') !== capacityBatch) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (!!stage.cp.markerEnabled !== (capacityBatch && stage.request.capacityBatch?.markerDirt === true)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (stage.cp.version !== 1 || stage.cp.jobId !== stage.request.jobId || stage.cp.operationId !== stage.request.operationId || stage.cp.kind !== selection.kind || stage.cp.selectionKey !== selection.key || !Array.isArray(stage.cp.positions) || stage.cp.positions.length !== (stage.cp.kind === 'double_chest' ? 2 : 1) || !stage.cp.positions.every(rt.point) || !rt.point(stage.cp.stand) || !Array.isArray(stage.cp.placed) || !Array.isArray(stage.cp.plan) || !Array.isArray(stage.cp.sourceIdentities) || !Array.isArray(stage.cp.deposited)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (new Set(stage.cp.positions.map(rt.key)).size !== stage.cp.positions.length || stage.cp.placed.some(p => !stage.cp.positions.some(position => rt.samePoint(p.position, position)) || p.confirmedBy !== 'server_block_and_inventory' || !Number.isInteger(p.runtimeId) || (stage.cp.kind === 'shulker' ? !rt.isShulkerBlock(p.name) : p.name !== 'minecraft:chest')) || new Set(stage.cp.placed.map(p => rt.key(p.position))).size !== stage.cp.placed.length || stage.cp.plan.some(p => typeof p.name !== 'string' || typeof p.identity !== 'string' || !Number.isSafeInteger(p.count) || p.count < 1 || !Number.isSafeInteger(p.transferred) || p.transferred < 0 || p.transferred > p.count)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (stage.cp.plan.some(p => p.capacityMarker && (!stage.cp.markerEnabled || p.name !== 'minecraft:dirt' || p.count !== 1))) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (stage.cp.kind === 'double_chest' && (stage.cp.positions[0].y !== stage.cp.positions[1].y || Math.abs(stage.cp.positions[0].x - stage.cp.positions[1].x) + Math.abs(stage.cp.positions[0].z - stage.cp.positions[1].z) !== 1)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (pendingPlacement) rt.placementContext(stage.cp); else rt.observe(stage.cp)
        // Continuing a held relief box: plan the current deposits once.
        if (stage.cp.relief === true && stage.cp.stage === 'placed' && !stage.cp.plan.length && !stage.cp.deposited.length && stage.request.holdAfterPlacement !== true && Array.isArray(stage.request.deposits) && stage.request.deposits.length) {
          const now0 = rt.observe(stage.cp)
          stage.cp.plan = stage.request.deposits.map(deposit => {
            const item = now0.items.find(item => item.slot === deposit.slot && item.name === rt.fullName(deposit.name))
            if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
            return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
          })
          await stage.save()
        }
      } else {
        const sourceIdentities = selection.sources.map(source => {
          if (!Number.isSafeInteger(source.count) || source.count < 1) throw rt.failure('STORAGE_SOURCE_COUNT')
          const item = initial.items.find(item => item.slot === source.slot && item.name === rt.fullName(source.name) && item.count >= source.count && (source.stackId == null || item.stackId === source.stackId))
          if (!item || selection.kind === 'shulker' && !rt.isShulkerBlock(item.name) || selection.kind !== 'shulker' && item.name !== 'minecraft:chest') throw rt.failure('STORAGE_SOURCE_CHANGED')
          return { name: item.name, count: source.count, identity: rt.pack(rt.rawIdentity(item.raw)) }
        })
        if (sourceIdentities.reduce((n, item) => n + item.count, 0) !== (selection.kind === 'double_chest' ? 2 : 1)) throw rt.failure('STORAGE_SOURCE_COUNT')
        const plan = (stage.request.deposits ?? []).map(deposit => {
          const item = initial.items.find(item => item.slot === deposit.slot && item.name === rt.fullName(deposit.name))
          if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
          return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
        })
        // A relief box (live 2026-11-12 23:55) is placed with nothing to deposit
        // and held; its deposits are planned when it is continued.
        const relief = stage.request.holdAfterPlacement === true && selection.kind === 'shulker' && !supplyWork && !capacityBatch
        if (!plan.length && !supplyWork && !capacityBatch && !relief) throw rt.failure('STORAGE_NO_DEPOSITS')
        if (supplyWork && plan.length) throw rt.failure('STORAGE_SUPPLY_DEPOSITS_FORBIDDEN')
        if (capacityBatch && plan.length) throw rt.failure('STORAGE_CAPACITY_DEPOSITS_FORBIDDEN')
        stage.cp = { version: 1, operationId: stage.request.operationId, jobId: stage.request.jobId, scope: initial.scope, kind: selection.kind, selectionKey: selection.key, stage: 'planned', ...rt.planSite(initial.state, selection.kind, stage.canPlace, Array.isArray(stage.request.avoidPositions) ? stage.request.avoidPositions.filter(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))) : []), sourceIdentities, plan, placed: [], deposited: [], intent: null, full: false, ...(relief ? { relief: true } : {}), ...(supplyWork ? { purpose: 'supply', supplyCheckpoint: null } : {}), ...(capacityBatch ? { purpose: 'capacity_batch', capacityCheckpoint: null, capacityResult: null } : {}) }
        if (selection.kind === 'shulker') {
          const source = selection.sources[0], item = initial.items.find(item => item.slot === source.slot && item.name === source.name && item.count === 1 && (source.stackId == null || item.stackId === source.stackId))
          if (!item) throw rt.failure('STORAGE_SOURCE_CHANGED')
          stage.cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: rt.pack(item.raw), selectionKey: stage.cp.selectionKey }
        }
        stage.cp.markerEnabled = capacityBatch && stage.request.capacityBatch?.markerDirt === true
        stage.run.checkpoint = stage.cp; await stage.save()
      }
      if (stage.cp.markerEnabled == null) stage.cp.markerEnabled = capacityBatch && stage.request.capacityBatch?.markerDirt === true
      stage.run.checkpoint = stage.cp
}

module.exports = { openCheckpoint }
