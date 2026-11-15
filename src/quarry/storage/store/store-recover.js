'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function recoverContainer (rt, stage) {
      const oldIds = new Set(stage.cp.recoveryBaseline.map(item => item.stackId)), beforeCount = stage.cp.recoveryBaseline.reduce((n, item) => n + item.count, 0)
      const recovered = () => {
        const current = rt.observe(stage.cp), boxes = current.items.filter(item => rt.isShulkerBox(item.name))
        if (boxes.reduce((n, item) => n + item.count, 0) !== beforeCount + 1) return null
        const candidates = boxes.filter(item => item.name === stage.owned.name && item.count === 1 && !oldIds.has(item.stackId) && rt.compareShulkerContents(item.raw, stage.expected, { resolveName: id => rt.crafting.itemNameOf?.(id) }).matches === true)
        return candidates.length === 1 ? candidates[0] : null
      }
      const pickupVolume = (feet, item) => Math.abs(feet.x - item.x) <= 0.6 && Math.abs(feet.y - item.y) <= 0.5 && Math.abs(feet.z - item.z) <= 0.6
      const baseline = stage.cp.pickupEntityBaseline
      const hasEntityBaseline = baseline && rt.isDeepStrictEqual(baseline.scope, stage.cp.scope) && Number.isFinite(baseline.capturedAt) && baseline.capturedAt <= rt.now() && Array.isArray(baseline.runtimeIds) && baseline.runtimeIds.length <= 512 && baseline.runtimeIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(baseline.runtimeIds).size === baseline.runtimeIds.length
      const oldEntityIds = new Set(hasEntityBaseline ? baseline.runtimeIds : [])
      let boundItem = stage.cp.pickupItemBinding ?? stage.cp.pickupFallback ?? null
      const uniqueDrop = () => {
        if (!hasEntityBaseline) return null
        const entities = rt.getEntities()
        if (!Array.isArray(entities)) return null
        const matching = []
        for (const entity of entities) {
          if (entity.kind !== 'item' || entity.alive === false) continue
          const name = rt.fullName(rt.crafting.itemNameOf?.(entity.networkId) ?? entity.name)
          if (entity.dimension !== stage.cp.scope.dimension || entity.scope != null && !rt.isDeepStrictEqual(entity.scope, stage.cp.scope) || entity.connectionId != null && entity.connectionId !== stage.cp.scope.connectionId || entity.positionKnown !== true || !rt.finite(entity.position)) { if (name === stage.owned.name) return null; continue }
          if (Math.hypot(entity.position.x - stage.owned.position.x - 0.5, entity.position.y - stage.owned.position.y, entity.position.z - stage.owned.position.z - 0.5) > 2.5) continue
          if (!name) return null
          if (name === stage.owned.name) {
            if (entity.count !== 1 || entity.runtimeId == null || entity.uniqueId == null) return null
            if (oldEntityIds.has(String(entity.runtimeId))) continue
            matching.push(entity)
          }
        }
        if (matching.length !== 1) return null
        const item = matching[0]
        if (boundItem && (!rt.isDeepStrictEqual(boundItem.scope, stage.cp.scope) || String(item.runtimeId) !== boundItem.entityRuntimeId || String(item.uniqueId) !== boundItem.entityUniqueId)) return null
        boundItem ??= { entityRuntimeId: String(item.runtimeId), entityUniqueId: String(item.uniqueId), scope: rt.copy(stage.cp.scope) }
        return item
      }
      const pickupPath = async stand => {
        const state = stage.guard().state, origin = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
        const owner = { jobId: stage.cp.jobId, operationId: stage.cp.operationId, scope: rt.copy(stage.cp.scope) }
        const safe = p => rt.point(p) && rt.air(p) && rt.air({ ...p, y: p.y + 1 }) && rt.support(p) && stage.pickupArea({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 2, 1) && (!rt.travel || rt.travel(p, owner) === true && rt.travel({ ...p, y: p.y + 1 }, owner) === true)
        if (!safe(origin) || !safe(stand)) return null
        let path
        if (rt.getPath) path = await rt.getPath(rt.copy(origin), rt.copy(stand), rt.copy(owner))
        else {
          // Legacy ports still need a received short path; this is an admission
          // proof only. Execution uses the same existing moveToCell port.
          const queue = [[origin]], seen = new Set([rt.key(origin)])
          while (queue.length) {
            const candidate = queue.shift(), last = candidate.at(-1)
            if (rt.samePoint(last, stand)) { path = candidate; break }
            if (candidate.length >= 8) continue
            for (const [dx, dz] of rt.DIRECTIONS) for (const dy of [0, 1, -1]) {
              const n = { x: last.x + dx, y: last.y + dy, z: last.z + dz }
              if (seen.has(rt.key(n)) || !safe(n) || dy === 1 && !rt.air({ ...last, y: last.y + 2 }) || dy === -1 && !rt.air({ ...n, y: n.y + 2 })) continue
              seen.add(rt.key(n)); queue.push([...candidate, n])
            }
          }
        }
        stage.guard()
        if (!Array.isArray(path) || !path.length || path.length > 8 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), stand) || path.some((p, index) => !safe(p) || index > 0 && (Math.abs(p.x - path[index - 1].x) + Math.abs(p.z - path[index - 1].z) !== 1 || Math.abs(p.y - path[index - 1].y) > 1))) return null
        return path
      }
      const fallbackStands = item => {
        const s = stage.guard().state
        const owner = { jobId: stage.cp.jobId, operationId: stage.cp.operationId, scope: stage.cp.scope }, stands = []
        for (let y = Math.ceil(item.position.y - 0.5); y <= Math.floor(item.position.y + 0.5); y++) for (let x = Math.floor(item.position.x) - 1; x <= Math.floor(item.position.x) + 1; x++) for (let z = Math.floor(item.position.z) - 1; z <= Math.floor(item.position.z) + 1; z++) {
          const stand = { x, y, z }, feet = { x: x + 0.5, y, z: z + 0.5 }
          if (!rt.point(stand) || !pickupVolume(feet, item.position) || !stage.pickupArea(feet, 2, 1) || !rt.air(stand) || !rt.air({ ...stand, y: y + 1 }) || !rt.support(stand) || rt.travel && (rt.travel(stand, owner) !== true || rt.travel({ ...stand, y: y + 1 }, owner) !== true)) continue
          stands.push(stand)
        }
        stands.sort((a, b) => Math.hypot(a.x + 0.5 - item.position.x, a.z + 0.5 - item.position.z) - Math.hypot(b.x + 0.5 - item.position.x, b.z + 0.5 - item.position.z) || Math.hypot(a.x + 0.5 - s.position.x, a.z + 0.5 - s.position.z) - Math.hypot(b.x + 0.5 - s.position.x, b.z + 0.5 - s.position.z))
        return stands
      }
      let box = recovered()
      if (!box) {
        const pickupOwner = rt.captureActionOwner?.('movement', { jobId: stage.cp.jobId, operationId: stage.cp.operationId }) ?? null
        const requirePickupOwner = () => { stage.guard(); if (pickupOwner) rt.runActionOwned(pickupOwner, () => {}) }
        const moveForPickup = async (stand, path, drop) => {
          requirePickupOwner(); stage.requirePickupRoom('before_pickup_move', drop)
          const beforeMove = () => {
            requirePickupOwner()
            const current = stage.requirePickupRoom('pickup_move_dispatch', drop), p = current.state.position
            const origin = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62 + 0.001), z: Math.floor(p.z) }, owner = { jobId: stage.cp.jobId, operationId: stage.cp.operationId, scope: rt.copy(stage.cp.scope) }
            const safe = cell => rt.point(cell) && rt.air(cell) && rt.air({ ...cell, y: cell.y + 1 }) && rt.support(cell) && stage.pickupArea({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 2, 1) && (!rt.travel || rt.travel(cell, owner) === true && rt.travel({ ...cell, y: cell.y + 1 }, owner) === true)
            if (!Array.isArray(path) || !path.length || path.length > 8 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), stand) || path.some((cell, index) => !safe(cell) || index > 0 && (Math.abs(cell.x - path[index - 1].x) + Math.abs(cell.z - path[index - 1].z) !== 1 || Math.abs(cell.y - path[index - 1].y) > 1))) throw rt.failure('STORAGE_PICKUP_ROUTE_UNCONFIRMED')
          }
          await stage.moveToCell(stand, path, beforeMove)
          requirePickupOwner()
        }
        if (stage.cp.pickupCenterVisited !== undefined && stage.cp.pickupCenterVisited !== true || stage.cp.pickupSafetyStands !== undefined && (!Array.isArray(stage.cp.pickupSafetyStands) || stage.cp.pickupSafetyStands.length > 2 || stage.cp.pickupSafetyStands.some(p => !rt.point(p)))) throw rt.failure('STORAGE_PICKUP_LIMIT')
        if (hasEntityBaseline && !stage.cp.pickupCenterVisited && !stage.cp.pickupFallback) {
          const path = await pickupPath(stage.owned.position)
          requirePickupOwner()
          if (path) {
            const previous = { center: stage.cp.pickupCenterVisited, binding: stage.cp.pickupItemBinding }, drop = uniqueDrop()
            stage.cp.pickupCenterVisited = true
            if (drop) stage.cp.pickupItemBinding = rt.copy(boundItem)
            try { await stage.save() } catch (error) {
              if (previous.center === undefined) delete stage.cp.pickupCenterVisited; else stage.cp.pickupCenterVisited = previous.center
              if (previous.binding === undefined) delete stage.cp.pickupItemBinding; else stage.cp.pickupItemBinding = previous.binding
              throw error
            }
            requirePickupOwner()
            const latest = uniqueDrop(); box = recovered()
            if (!box) {
              if (drop && !latest) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(stage.owned.position, path, latest)
            }
          }
        }
        const deadline = rt.now() + 10000
        const visits = stage.cp.pickupSafetyVisits === undefined ? stage.cp.pickupFallback ? 1 : 0 : stage.cp.pickupSafetyVisits
        if (!Number.isSafeInteger(visits) || visits < 0 || visits > 2) throw rt.failure('STORAGE_PICKUP_LIMIT')
        const visited = new Set((stage.cp.pickupSafetyStands ?? []).map(rt.key))
        while (!box && rt.now() < deadline) {
          requirePickupOwner(); box = recovered()
          if (box) break
          const item = uniqueDrop()
          if (hasEntityBaseline && item && (stage.cp.pickupSafetyVisits ?? visits) < 2) {
            for (const stand of fallbackStands(item)) {
              if (visited.has(rt.key(stand))) continue
              const path = await pickupPath(stand)
              requirePickupOwner()
              if (!path || rt.now() >= deadline) continue
              const latest = uniqueDrop(), feet = { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }
              if (!latest || String(latest.runtimeId) !== String(item.runtimeId) || String(latest.uniqueId) !== String(item.uniqueId) || !pickupVolume(feet, latest.position)) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              stage.requirePickupRoom('before_actual_item_visit', latest)
              const old = { visits: stage.cp.pickupSafetyVisits, stands: stage.cp.pickupSafetyStands, fallback: stage.cp.pickupFallback, binding: stage.cp.pickupItemBinding }
              stage.cp.pickupSafetyVisits = (stage.cp.pickupSafetyVisits ?? visits) + 1
              stage.cp.pickupSafetyStands = [...(stage.cp.pickupSafetyStands ?? []), rt.copy(stand)]
              stage.cp.pickupItemBinding = rt.copy(boundItem)
              stage.cp.pickupFallback = { entityRuntimeId: String(latest.runtimeId), entityUniqueId: String(latest.uniqueId), observedPosition: rt.copy(latest.position), stand: rt.copy(stand), scope: rt.copy(stage.cp.scope), at: rt.now() }
              try { await stage.save() } catch (error) {
                for (const [field, value] of [['pickupSafetyVisits', old.visits], ['pickupSafetyStands', old.stands], ['pickupFallback', old.fallback], ['pickupItemBinding', old.binding]]) { if (value === undefined) delete stage.cp[field]; else stage.cp[field] = value }
                throw error
              }
              requirePickupOwner()
              const still = uniqueDrop()
              if (!still || String(still.runtimeId) !== String(latest.runtimeId) || String(still.uniqueId) !== String(latest.uniqueId) || !pickupVolume(feet, still.position)) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(stand, path, still)
              visited.add(rt.key(stand)); box = recovered()
              break
            }
          }
          if (!box) await rt.sleep(50)
        }
        if (!box) throw rt.failure('STORAGE_RECOVERY_UNCONFIRMED')
      }
      stage.cp.recovered = { name: box.name, slot: box.slot, stackId: box.stackId, key: rt.carriedContainerKey(box), identity: rt.carriedContainerIdentity(box), confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents' }
      stage.cp.stage = 'completed'; await stage.save(); stage.guard()
      return { value: stage.result(stage.cp.full ? 'full' : 'completed') }
}

module.exports = { recoverContainer }
