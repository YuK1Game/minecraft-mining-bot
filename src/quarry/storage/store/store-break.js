'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.

async function breakContainer (rt, stage) {
      stage.guard()
      if (!stage.cp.expectedContents || !Array.isArray(stage.cp.recoveryBaseline) || stage.cp.placed.length !== 1) throw rt.failure('STORAGE_RECOVERY_UNOBSERVED')
      const owned = stage.cp.placed[0], expected = rt.unpack(stage.cp.expectedContents); stage.expected = expected; stage.owned = owned
      if (!rt.air(owned.position)) {
        if (!rt.placedCurrent(stage.cp, owned)) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
        const current = stage.guard()
        if (rt.freeSlots(current.items) < 1) throw rt.failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        if (!rt.miningFloorOk(rt.read({ x: stage.cp.stand.x, y: stage.cp.stand.y - 1, z: stage.cp.stand.z }))) {
          const box = owned.position, candidates = []
          for (const [dx, dz] of [[0, 2], [0, -2], [2, 0], [-2, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]]) candidates.push({ x: box.x + dx, y: box.y, z: box.z + dz })
          const next = candidates.find(p => !rt.samePoint(p, box) && rt.standBody(p) && rt.standBody({ ...p, y: p.y + 1 }) && rt.support(p) && rt.miningFloorOk(rt.read({ x: p.x, y: p.y - 1, z: p.z })) && stage.canPlace(p) === true && Math.hypot(box.x + 0.5 - (p.x + 0.5), box.y + 0.5 - (p.y + 1.62), box.z + 0.5 - (p.z + 0.5)) <= 4.5)
          if (!next) throw rt.failure('STORAGE_RECOVERY_STAND_UNSAFE')
          const previousStand = stage.cp.stand
          stage.cp.stand = rt.copy(next); stage.cp.recoveryStandMoved = { from: rt.copy(previousStand), to: rt.copy(next), at: rt.now() }
          try { await stage.save() } catch (error) { stage.cp.stand = previousStand; delete stage.cp.recoveryStandMoved; throw error }
        }
        if (!rt.standBody(stage.cp.stand) || !rt.standBody({ ...stage.cp.stand, y: stage.cp.stand.y + 1 }) || !rt.support(stage.cp.stand) || stage.canPlace(stage.cp.stand) !== true) throw rt.failure('STORAGE_STAND_UNCONFIRMED')
        if (Math.hypot(current.state.position.x - stage.cp.stand.x - 0.5, current.state.position.y - 1.62 - stage.cp.stand.y, current.state.position.z - stage.cp.stand.z - 0.5) > 0.7) await stage.moveToCell(stage.cp.stand)
        stage.close()
        stage.requirePickupRoom('before_break')
        await stage.perform('mining', async owner => {
          stage.requirePickupRoom('before_break_dispatch')
          const oldBaseline = stage.cp.pickupEntityBaseline
          stage.cp.pickupEntityBaseline = { scope: rt.copy(stage.cp.scope), capturedAt: rt.now(), runtimeIds: stage.pickupEntityIds() }
          try { await stage.save() } catch (error) { if (oldBaseline === undefined) delete stage.cp.pickupEntityBaseline; else stage.cp.pickupEntityBaseline = oldBaseline; throw error }
          stage.guard(); if (owner) rt.runActionOwned(owner, () => {})
          if (!rt.isDeepStrictEqual(stage.pickupEntityIds(), stage.cp.pickupEntityBaseline.runtimeIds)) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_CHANGED')
          stage.requirePickupRoom('before_break_dispatch')
          let requiredTool = null
          if (stage.request.inventoryPolicy?.depositWhen === 'four_layers') {
            const policy = stage.request.inventoryPolicy?.toolPolicy ?? {}
            const pick = rt.selectTool({ kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier: 1, drops: [], maxDrop: 1 }, stage.guard().items, policy)
            if (!pick.ok || pick.kind !== 'pickaxe') throw rt.failure('SHULKER_PICKAXE_UNAVAILABLE')
            await stage.perform('equip', () => rt.equip(pick.slot, { signal: stage.signal }))
            const held = stage.guard().state.heldItem
            const actual = rt.toolState(held, policy)
            if (held?.name !== pick.name || actual?.kind !== 'pickaxe' || actual.usable !== true) throw rt.failure('SHULKER_PICKAXE_UNCONFIRMED')
            requiredTool = { kind: 'pickaxe', tier: 1, reserve: actual.reserve }
          }
          stage.requirePickupRoom('before_break_dispatch')
          await rt.mine({ ...rt.copy(owned.position), accessPreparation: 'owned_shulker', ownershipKey: stage.cp.operationId, expectedName: owned.name, expectedRuntimeId: owned.runtimeId, ...(requiredTool ? { requiredTool } : {}) }, { signal: stage.signal })
          await stage.wait(() => {
            if (rt.air(owned.position)) return true
            const progress = rt.getMining()
            if (['failed', 'stopped'].includes(progress?.phase)) {
              const target = progress.remaining?.length === 1 ? progress.remaining[0] : null
              throw Object.assign(rt.failure('STORAGE_BREAK_FAILED', progress.reason), { details: {
                kind: 'owned_shulker_mining_stop', operationId: stage.cp.operationId, scope: rt.copy(stage.cp.scope),
                mining: { phase: progress.phase, reason: typeof progress.reason === 'string' ? progress.reason.slice(0, 200) : null, operation: progress.operation ?? null, completedCount: Array.isArray(progress.completed) ? progress.completed.length : null, remainingCount: Array.isArray(progress.remaining) ? progress.remaining.length : null, target: target ? { x: target.x, y: target.y, z: target.z, accessPreparation: target.accessPreparation, ownershipKey: target.ownershipKey, expectedName: target.expectedName, expectedRuntimeId: target.expectedRuntimeId } : null }
              } })
            }
            return false
          }, 20000, 'STORAGE_BREAK_TIMEOUT')
        })
      }
      if (!rt.air(owned.position)) throw rt.failure('STORAGE_BREAK_UNCONFIRMED')
      stage.cp.stage = 'awaiting_recovery'; stage.cp.intent = null; await stage.save()
}

module.exports = { breakContainer }
