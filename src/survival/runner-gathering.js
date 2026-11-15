'use strict'

// Moved out of runner.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runner.js.

function createRunnerGathering (rt) {
  async function gatherDirt (decision, context) {
    const count = decision.count ?? 2
    const excluded = decision.excludedPositions ?? []
    const integer = point => rt.finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
    if (!Number.isSafeInteger(count) || count < 1 || count > 2 || !Array.isArray(excluded) || excluded.length > 512 || excluded.some(value => !integer(value?.position ?? value))) throw new rt.RunnerError('Dirt gathering requires one or two items and bounded exclusion cells', 'INVALID_SOIL_REQUEST')
    if (decision.site != null && (typeof decision.site !== 'object' || Array.isArray(decision.site))) throw new rt.RunnerError('Dirt gathering requires a valid base geometry', 'INVALID_SOIL_REQUEST')
    const initial = await rt.groundedItemState(context)
    const baseline = rt.itemCount(initial, 'minecraft:dirt')
    const scope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.startedAt ?? null])
    const check = state => {
      rt.guard(state)
      if (scope(state) !== scope(initial)) throw new rt.RunnerError('Dirt gathering changed session or world', 'STALE_SESSION')
      if (state.health < initial.health) throw new rt.RunnerError('Bot took damage while gathering dirt', 'TOOK_DAMAGE')
      if (state.inventory?.known !== true || state.inventory.uncertain) throw new rt.RunnerError('Dirt gathering requires confirmed inventory', 'INVENTORY_UNKNOWN')
      return rt.itemCount(state, 'minecraft:dirt') - baseline
    }
    check(initial)
    let blocksBroken = 0; let mines = 0; let gained = 0
    const tried = new Set()
    const options = state => ({ excludedPositions: excluded, sites: [decision.site, state.hut?.memo?.site, state.shelter?.memo?.site] })
    for (let attempt = 0; attempt < 8 && mines < 2 && gained < count; attempt++) {
      let observations = await rt.observe({ signal: context.signal, fresh: true, radius: 6 })
      let state = observations.state ?? await rt.read(context.signal)
      gained = check(state)
      if (gained >= count) {
        if (!blocksBroken) return rt.result({ resource: 'dirt', requestedCount: count, count: gained, collected: false, complete: true, blocksBroken: 0, serverConfirmed: true, confirmedBy: 'server_inventory', requiresObservation: true })
        break
      }
      const candidate = rt.soilCandidates(state, observations, options(state)).find(value => !tried.has(rt.positionKey(value.position)))
      if (!candidate) break
      tried.add(rt.positionKey(candidate.position))
      const center = { x: candidate.position.x + 0.5, y: candidate.position.y + 0.5, z: candidate.position.z + 0.5 }
      if (rt.distance(state.position, center) > 4.5) {
        const approach = rt.knownStandpoints(state, observations, { maxDistance: 6, maxHeightDelta: 1, limit: 200 }).filter(value => rt.distance({ ...value.position, y: value.position.y + 1.62 }, center) <= 4.5 && rt.positionKey({ x: Math.floor(value.position.x), y: value.position.y - 1, z: Math.floor(value.position.z) }) !== rt.positionKey(candidate.position)).sort((a, b) => rt.horizontal(a.position, state.position) - rt.horizontal(b.position, state.position))[0]
        if (!approach) continue
        try { const moved = await rt.move({ target: approach.position, allowWater: false, resource: 'dirt' }, { ...context, observations }); if (moved.partial) return { ...moved, resource: 'dirt', requestedCount: count, blocksBroken, collected: false, complete: false } } catch (error) { if (error.code === 'NO_SAFE_ROUTE' && !error.movementAttempted) continue; throw error }
      }
      observations = await rt.observe({ signal: context.signal, fresh: true, radius: 6 })
      state = observations.state ?? await rt.read(context.signal)
      check(state)
      const fresh = rt.soilCandidates(state, observations, options(state)).find(value => rt.positionKey(value.position) === rt.positionKey(candidate.position) && value.name === candidate.name)
      if (!fresh || rt.distance(state.position, center) > 4.5) continue
      const preview = await rt.request('POST', '/mining/preview', { targets: [candidate.position] }, { signal: context.signal })
      if (!preview?.ready) continue
      const dirtBefore = rt.itemCount(state, 'minecraft:dirt')
      mines++
      await rt.mine({ type: 'gather_dirt', target: candidate.position, block: candidate.name }, context)
      blocksBroken++
      observations = await rt.observe({ signal: context.signal, fresh: true, radius: 6 })
      state = observations.state ?? await rt.read(context.signal)
      gained = check(state)
      if (rt.itemCount(state, 'minecraft:dirt') <= dirtBefore) {
        const targets = (observations.drops ?? state.droppedItems ?? []).filter(item => item.known !== false && item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 && (item.entityId ?? item.runtimeId ?? item.runtimeEntityId ?? item.id) != null && rt.finite(item.position) && rt.distance(item.position, center) <= 2.5).slice(0, 8)
        if (!targets.length) throw new rt.RunnerError('Mined soil produced no received dirt drop or inventory increase', 'PICKUP_NOT_CONFIRMED')
        await collect({ count: 1, targets }, { ...context, observations })
        gained = check(await rt.read(context.signal))
      }
      rt.report(context, { type: 'gather_dirt', phase: 'observed_inventory', count: gained, blocksBroken, serverConfirmed: true })
    }
    if (!blocksBroken || gained <= 0) throw new rt.RunnerError('No unprotected natural soil could be safely mined and collected', 'NO_SAFE_SOIL')
    const final = await rt.observe({ signal: context.signal, fresh: true, radius: 6 })
    gained = check(final.state ?? await rt.read(context.signal))
    if (gained <= 0) throw new rt.RunnerError('Dirt inventory gain is no longer confirmed', 'PICKUP_NOT_CONFIRMED')
    return rt.result({ resource: 'dirt', requestedCount: count, count: gained, collected: true, complete: gained >= count, blocksBroken, serverConfirmed: true, confirmedBy: 'server_inventory_and_block_update', requiresObservation: true })
  }

  async function prepareTreeAccess (decision, context) {
    const initial = await rt.read(context.signal)
    rt.guard(initial)
    const prep = decision.accessPreparation
    const scope = rt.treeAccessScope(initial)
    const integer = point => rt.finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
    if (decision.resource !== 'logs' || !rt.LOG.test(decision.block ?? '') || !integer(decision.resourceTarget) || !rt.finite(decision.target) || decision.treeEvidence?.detection !== 'connected_logs' || prep?.kind !== 'clear_tree_access' || !integer(prep.target) || prep.maxPlants !== rt.ACCESS_LIMIT || typeof prep.scope !== 'string' || !['minecraft:leaf_litter', 'minecraft:vine'].includes(prep.block)) throw new rt.RunnerError('Invalid natural-tree access preparation', 'INVALID_ACCESS_PREPARATION')
    if (typeof scope !== 'string' || prep.scope !== scope) throw new rt.RunnerError('Natural-tree access preparation changed life or connection; observe again', 'STALE_OBSERVATION')
    const receiptKey = `${scope}:${rt.positionKey(decision.resourceTarget)}`
    const receipt = rt.accessPreparations.get(receiptKey) ?? { attempts: 0, cleared: [] }
    if (receipt.attempts >= rt.ACCESS_LIMIT) throw new rt.RunnerError('Natural-tree access preparation reached its four-action limit', 'ACCESS_PREPARATION_LIMIT')

    function validateObservation (observations, { requirePlant = true, atStand = false } = {}) {
      const state = observations?.state
      rt.guard(state ?? {})
      if (rt.treeAccessScope(state) !== scope || state.health < initial.health) throw new rt.RunnerError('Tree access changed life, connection or health', 'STALE_OBSERVATION')
      if (atStand && (rt.horizontal(state.position, decision.target) > 0.4 || Math.abs(state.position.y - decision.target.y - 1.62) > 0.15)) throw new rt.RunnerError('Tree access did not reach its validated stance', 'ACCESS_STANCE_NOT_REACHED')
      const blocks = (observations.blocks ?? []).filter(block => integer(block.position))
      const map = new Map(blocks.map(block => [rt.positionKey(block.position), block]))
      const getBlock = point => map.get(rt.positionKey(point))
      const natural = rt.naturalLogCandidates(blocks.filter(block => block.known === true && rt.LOG.test(block.name ?? '')), getBlock)
      const tree = natural.find(block => rt.positionKey(block.position) === rt.positionKey(decision.resourceTarget) && block.name === decision.block)
      if (!tree || tree.extra?.length) throw new rt.RunnerError('The intended natural tree changed before access preparation', 'RESOURCE_CHANGED')
      const plant = getBlock(prep.target)
      if (!requirePlant) return { state, tree, plant }
      if (plant?.known === true && rt.AIR.has(plant.name) && !plant.extra?.length) return { state, tree, plant, alreadyClear: true }
      if (plant?.name !== prep.block || !rt.isDryAccessPlant(plant) || !rt.safeAccessPlant(plant, getBlock)) throw new rt.RunnerError('The intended dry access plant changed', 'RESOURCE_CHANGED')
      const checked = rt.planTreeAccess({ state, tree, standpoint: decision.target, getBlock })
      if (!checked || checked.block !== prep.block || rt.positionKey(checked.target) !== rt.positionKey(prep.target)) throw new rt.RunnerError('The obstruction or nearest reachable access plant changed', 'ACCESS_PLAN_CHANGED')
      return { state, tree, plant }
    }

    let observations = await rt.observe({ signal: context.signal, fresh: true })
    let checked = validateObservation(observations)
    if (checked.alreadyClear) return rt.result({ outcome: 'already_clear', serverConfirmed: true, confirmedBy: 'received_air', blocksBroken: 0, collected: false, resourceReady: false, requiresObservation: true })
    receipt.attempts++
    rt.accessPreparations.set(receiptKey, receipt)
    while (rt.accessPreparations.size > 32) rt.accessPreparations.delete(rt.accessPreparations.keys().next().value)
    if (rt.horizontal(checked.state.position, decision.target) > 0.35 || Math.abs(checked.state.position.y - decision.target.y - 1.62) > 0.15) {
      const moved = await rt.move({ type: 'move_to', target: decision.target, allowWater: false }, { ...context, observations })
      if (moved.partial) return { ...moved, kind: 'clear_tree_access', accessPrepared: false, resourceReady: false }
    }
    observations = await rt.observe({ signal: context.signal, fresh: true })
    checked = validateObservation(observations, { atStand: true })
    if (checked.alreadyClear) return rt.result({ outcome: 'already_clear', serverConfirmed: true, confirmedBy: 'received_air', blocksBroken: 0, collected: false, resourceReady: false, requiresObservation: true })
    const mined = await rt.mine({ type: 'clear_access', target: prep.target, block: prep.block }, context)
    const after = await rt.observe({ signal: context.signal, fresh: true })
    const final = validateObservation(after, { requirePlant: false, atStand: true })
    if (final.plant?.known !== true || !rt.AIR.has(final.plant.name) || final.plant.extra?.length) throw new rt.RunnerError('The cleared access plant is no longer known air', 'BLOCK_NOT_CONFIRMED')
    receipt.cleared.push(rt.positionKey(prep.target))
    rt.report(context, { type: 'clear_tree_access', phase: 'completed', target: prep.target, resourceTarget: decision.resourceTarget, confirmedBy: 'server_block_update' })
    return { ...mined, kind: 'clear_tree_access', accessPrepared: true, clearedPlant: { position: rt.copy(prep.target), name: prep.block }, resourceTarget: rt.copy(decision.resourceTarget), resourceReady: false, collected: false, requiresObservation: true }
  }

  async function collect (decision, context) {
    const bound = Array.isArray(decision.targets) ? decision.targets.filter(target => target.collectionScope != null || target.starterGear != null) : []
    if (bound.length && (bound.length !== 1 || decision.targets.length !== 1 || decision.count !== 1)) throw new rt.RunnerError('Bound starter gear uses one identified target and one actual item', 'INVALID_GEAR_TARGET')
    let boundInitial = null, boundGain = 0, boundOrigin = null
    const bindingError = (target, code, reason) => { const error = new rt.RunnerError(reason, code); error.targetEntityId = String(target.entityId); return error }
    const validateBound = bound.length ? state => {
      const target = bound[0]
      if (!rt.sameStarterGearScope(target.collectionScope, state)) throw bindingError(target, 'STALE_SESSION', 'Starter gear collection changed actual life or player session')
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventory.serverConfirmed === false || state.inventory.source === 'client_prediction') throw bindingError(target, 'INVENTORY_UNKNOWN', 'Starter gear pickup requires actual known inventory')
      const count = rt.itemCount(state, [rt.nameOf(target.name)])
      if (boundInitial === null) { boundInitial = count; boundOrigin = rt.copy(state.position) }
      boundGain = Math.max(boundGain, count - boundInitial)
      // Scope stays mandatory. Actual inventory gain may precede the natural
      // removal packet, so a missing target cannot erase this received gain.
      if (boundGain > 0) return
      const observed = rt.validateStarterGearTarget(state, target)
      if (!observed.ready) throw bindingError(target, observed.code, observed.reason)
      if (rt.distance(boundOrigin, observed.drop.position) > 12 || rt.distance(boundOrigin, state.position) > 12) throw bindingError(target, 'DROP_TARGET_CHANGED', 'Starter gear left its original local pickup area')
    } : null
    const before = await rt.groundedItemState(context, validateBound)
    if (before.inventory?.known !== true || before.inventory.uncertain === true) throw new rt.RunnerError('Known inventory is required before collecting', 'INVENTORY_UNKNOWN')
    const targets = (decision.targets ?? []).filter(target => rt.finite(target.position) && target.name).slice(0, 8)
    if (!targets.length) throw new rt.RunnerError('No known drop targets are available')
    const names = new Set(targets.map(target => rt.nameOf(target.name)))
    const initial = bound.length ? boundInitial : rt.itemCount(before, [...names])
    let gained = bound.length ? boundGain : 0
    if (bound.length && gained > 0) return rt.result({ serverConfirmed: true, confirmedBy: 'server_inventory', count: gained })
    function updateGained (state) {
      validateBound?.(state)
      if (state.inventory?.known !== true || state.inventory.uncertain === true) return false
      const current = rt.itemCount(state, [...names]) - initial
      const increased = current > gained
      gained = Math.max(gained, current)
      return increased
    }
    async function waitForPickup (limit) {
      try {
        const observed = await rt.waitFor(state => { validateBound?.(state); return state.inventory?.known === true && state.inventory.uncertain !== true && rt.itemCount(state, [...names]) > initial + gained }, { signal: context.signal, baselineHealth: before.health, limit: Math.min(rt.timeoutMs, limit) })
        updateGained(observed.state)
        return true
      } catch (error) {
        if (error.code !== 'UNCONFIRMED_TIMEOUT') throw error
        return false
      }
    }
    for (const target of targets) {
      rt.checkAbort(context.signal)
      let current = await rt.read(context.signal)
      rt.guard(current)
      if (current.health < before.health) throw new rt.RunnerError('Bot took damage while collecting', 'TOOK_DAMAGE')
      if (updateGained(current)) { if (gained >= (decision.count ?? 1)) break; continue }
      const observations = context.observations ?? rt.getLastObservation()
      const itemPosition = state => {
        if (bound.length) { const observed = rt.validateStarterGearTarget(state, target); if (!observed.ready) throw bindingError(target, observed.code, observed.reason); return observed.drop.position }
        const id = target.entityId ?? target.runtimeEntityId ?? target.runtimeId ?? target.id
        const observed = id == null || !Array.isArray(state.droppedItems) ? null : state.droppedItems.find(item => String(item.entityId ?? item.runtimeEntityId ?? item.runtimeId ?? item.id) === String(id) && rt.nameOf(item.name) === rt.nameOf(target.name) && rt.finite(item.position))
        return observed?.position ?? target.position
      }
      // The broad pickup neighbourhood permits a short packet/delay grace,
      // never an assumption that a 1.2-block separation will collect an item.
      if (rt.pickupWithinBody(current.position, itemPosition(current)) && rt.pickupLineClear(current.position, itemPosition(current), observations) !== false && await waitForPickup(250)) {
        if (gained >= (decision.count ?? 1)) break
        continue
      }
      const tried = new Set()
      let approaches = 0
      let routeAttempts = 0
      for (let round = 0; round < 3; round++) {
        current = await rt.read(context.signal)
        rt.guard(current)
        if (current.health < before.health) throw new rt.RunnerError('Bot took damage while collecting', 'TOOK_DAMAGE')
        if (updateGained(current)) break
        const item = itemPosition(current)
        const candidates = rt.pickupStandpoints(current, item, observations).filter(candidate => {
          const identity = `${Math.round(candidate.position.x * 20)},${candidate.position.y},${Math.round(candidate.position.z * 20)}`
          return !tried.has(identity) && rt.horizontal(current.position, candidate.position) >= 0.12 && candidate.pickupDistance <= Math.max(0.5, rt.horizontal(current.position, item) - 0.05)
        })
        let approached = false
        for (const candidate of candidates) {
          if (routeAttempts >= 12) break
          const identity = `${Math.round(candidate.position.x * 20)},${candidate.position.y},${Math.round(candidate.position.z * 20)}`
          tried.add(identity)
          routeAttempts++
          try {
            rt.report(context, { type: 'collect_drops', phase: 'approaching', entityId: target.entityId ?? target.runtimeId, attempt: approaches + 1, target: rt.copy(candidate.position), pickupDistance: candidate.pickupDistance })
            const moved = await rt.move({ target: candidate.position, resource: 'drop' }, context, bound.length ? { validateState: validateBound } : {})
            if (bound.length) { gained = Math.max(gained, boundGain); if (gained >= decision.count) { approached = true; break } }
            if (moved.partial) return { ...moved, resource: 'drop', collected: false, complete: false }
            approaches++
            approached = true
            break
          } catch (error) {
            if (target.entityId != null) error.targetEntityId = String(target.entityId)
            if (error.code !== 'NO_SAFE_ROUTE' || error.movementAttempted) throw error
          }
        }
        if (!approached) {
          // An already close item still needs inventory evidence, but an empty
          // route set cannot invent a movement or force an unsafe collision.
          if (approaches > 0 || rt.horizontal(current.position, item) <= 0.5 && rt.pickupWithinBody(current.position, item) && rt.pickupLineClear(current.position, item, observations) !== false) {
            await waitForPickup(1000)
            break
          }
          const error = new rt.RunnerError('No known safe body-range stance can reach this drop', 'NO_SAFE_ROUTE')
          if (target.entityId != null) error.targetEntityId = String(target.entityId)
          throw error
        }
        if (bound.length && gained >= decision.count || await waitForPickup(1200)) break
      }
      if (gained >= (decision.count ?? 1)) break
    }
    if (gained <= 0) throw new rt.RunnerError('Drop disappearance or movement did not produce an inventory increase', 'PICKUP_NOT_CONFIRMED')
    return rt.result({ serverConfirmed: true, confirmedBy: 'server_inventory', count: gained })
  }
  return {
    prepareTreeAccess,
    gatherDirt,
    collect
  }
}

module.exports = { createRunnerGathering }
