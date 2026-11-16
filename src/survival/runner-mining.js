'use strict'

// Moved out of runner.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runner.js.

function createRunnerMining (rt) {
  async function recenterMiningOrigin (decision, context, origin) {
    const physical = origin.predicted?.physicsState ?? origin.physicsState
    const y = origin.position.y - 1.62
    if (physical?.onGround !== true || physical.isInWater || physical.isInLava || Math.abs(y - Math.round(y)) > 1e-4) return null
    const expectedScope = rt.treeAccessScope(origin), target = rt.copy(decision.target)
    if (!expectedScope) throw new rt.RunnerError('Mining origin needs a known current life scope', 'STALE_SESSION')
    const entries = state => { const e = rt.threatEvaluationOf(state); return [...e.threats, ...e.outsideDanger, ...e.suppressedByTerrain] }
    const initial = entries(origin)
    const identity = state => new Map((rt.threatEntitiesOf(state) ?? []).map(actor => [String(actor.runtimeId ?? actor.runtimeEntityId ?? actor.id), actor]))
    const initialActors = identity(origin)
    const bound = new Map(initial.map(actor => [String(actor.runtimeId), { name: actor.name, uniqueId: String(initialActors.get(String(actor.runtimeId))?.uniqueId ?? ''), minimum: Math.min(actor.distance, actor.dangerRadius) }]))
    if (bound.size > 64 || initial.some(actor => !/^-?\d+$/.test(bound.get(String(actor.runtimeId)).uniqueId) || !rt.finite(actor.position) || !Number.isFinite(bound.get(String(actor.runtimeId)).minimum) || bound.get(String(actor.runtimeId)).minimum < 0 || bound.get(String(actor.runtimeId)).minimum > 64)) throw new rt.RunnerError('Mining recenter has no bounded actor-floor proof', 'NO_SAFE_ROUTE')
    const check = state => {
      rt.guard(state)
      if (rt.treeAccessScope(state) !== expectedScope || state.threatPolicy !== origin.threatPolicy) throw new rt.RunnerError('Mining origin changed life, session or policy', 'STALE_SESSION')
      if (state.health !== origin.health) throw new rt.RunnerError('Health changed while preparing the mining origin', 'TOOK_DAMAGE')
      const actors = identity(state), current = entries(state)
      if (current.length !== bound.size || current.some(actor => { const prior = bound.get(String(actor.runtimeId)); return !prior || prior.name !== actor.name || prior.uniqueId !== String(actors.get(String(actor.runtimeId))?.uniqueId ?? '') })) throw new rt.RunnerError('Mining recenter actor identities changed; observe again', 'THREAT_SET_CHANGED')
      for (const actor of current) if (rt.distance(state.position, actor.position) < bound.get(String(actor.runtimeId)).minimum - 1e-6) throw new rt.RunnerError('Mining recenter lost an actor distance floor', 'NEARBY_THREAT')
      return current
    }
    const center = { x: Math.floor(origin.position.x), y: Math.round(y), z: Math.floor(origin.position.z) }
    const page = await rt.request('GET', '/blocks?x=' + center.x + '&y=' + center.y + '&z=' + center.z + '&radius=3', undefined, { signal: context.signal })
    check(await rt.read(context.signal))
    const blocks = page?.blocks ?? [], map = new Map(blocks.filter(block => rt.finite(block.position)).map(block => [rt.positionKey(block.position), block]))
    const solid = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && (/^(?:minecraft:)(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_(?:planks|log))$/.test(block.name) || require('../common/standing-ground').isOreGround(block.name))
    let supportArea = 0
    for (let x = Math.floor(origin.position.x - 0.3 + 1e-6); x <= Math.floor(origin.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(origin.position.z - 0.3 + 1e-6); z <= Math.floor(origin.position.z + 0.3 - 1e-6); z++) {
      const floor = map.get(rt.positionKey({ x, y: center.y - 1, z }))
      if (floor?.known !== true || floor.extra?.length || !rt.AIR.has(floor.name) && !solid(floor)) throw new rt.RunnerError('The partial origin has unknown or unsupported floor cells', 'UNKNOWN_TERRAIN')
      if (solid(floor)) supportArea += (Math.min(origin.position.x + 0.3, x + 1) - Math.max(origin.position.x - 0.3, x)) * (Math.min(origin.position.z + 0.3, z + 1) - Math.max(origin.position.z - 0.3, z))
    }
    if (!(supportArea > 1e-6 && supportArea < 0.36 - 1e-6)) return null
    let resource = map.get(rt.positionKey(target))
    if (!resource) { const page = await rt.request('GET', '/blocks?x=' + target.x + '&y=' + target.y + '&z=' + target.z + '&radius=0', undefined, { signal: context.signal }); resource = page?.blocks?.find(block => rt.positionKey(block.position) === rt.positionKey(target)); check(await rt.read(context.signal)) }
    if (resource?.known !== true || rt.AIR.has(resource.name) || resource.protected || decision.block && resource.name !== decision.block) throw new rt.RunnerError('The original mining resource changed before recentering', 'RESOURCE_CHANGED')
    const open = block => block?.known === true && !block.extra?.length && (rt.AIR.has(block.name) || block.boundingBox === 'empty' && ['minecraft:short_grass', 'minecraft:fern', 'minecraft:leaf_litter', 'minecraft:torch'].includes(block.name))
    const candidates = blocks.filter(block => block.position.y === center.y - 1 && solid(block)).map(block => ({ x: block.position.x + 0.5, y: center.y, z: block.position.z + 0.5 })).filter(point => rt.horizontal(point, origin.position) >= 0.2 && rt.horizontal(point, origin.position) <= 1.2 && open(map.get(rt.positionKey({ x: Math.floor(point.x), y: center.y, z: Math.floor(point.z) }))) && open(map.get(rt.positionKey({ x: Math.floor(point.x), y: center.y + 1, z: Math.floor(point.z) })))).sort((a, b) => rt.horizontal(a, origin.position) - rt.horizontal(b, origin.position)).slice(0, 8)
    const routeSafe = (preview, state, goal) => {
      const actors = check(state), path = preview?.predictedTrace
      if (preview?.partialRecenter !== true || !Array.isArray(path) || path.length < 2 || path.length > 41 || path.some(point => !rt.finite(point) || Math.abs(point.y - center.y) > 1e-4) || rt.horizontal(path[0], state.position) > 1e-4 || rt.horizontal(path.at(-1), goal) > 0.35) return false
      for (const actor of actors) for (let index = 1; index < path.length; index++) {
        const a = { ...path[index - 1], y: path[index - 1].y + 1.62 }, b = { ...path[index], y: path[index].y + 1.62 }, vector = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
        const length = vector.x ** 2 + vector.y ** 2 + vector.z ** 2, projection = length ? ((actor.position.x - a.x) * vector.x + (actor.position.y - a.y) * vector.y + (actor.position.z - a.z) * vector.z) / length : 0, t = Math.max(0, Math.min(1, projection))
        if (rt.distance(actor.position, { x: a.x + vector.x * t, y: a.y + vector.y * t, z: a.z + vector.z * t }) < bound.get(String(actor.runtimeId)).minimum - 1e-6) return false
      }
      return true
    }
    for (const candidate of candidates) {
      const current = await rt.read(context.signal), actors = check(current)
      const policy = { partialRecenter: true, maxDistance: 2, maxExpanded: 64, avoidance: actors.map(actor => ({ id: String(actor.runtimeId), position: rt.copy(actor.position), minDistance: bound.get(String(actor.runtimeId)).minimum, padding: 0 })) }
      const options = { allowWater: false, sprint: false, ...policy }
      const preview = await rt.request('POST', '/move/preview', { target: candidate, options }, { signal: context.signal })
      const afterPreview = await rt.read(context.signal); check(afterPreview)
      if (!preview?.ready || !routeSafe(preview, afterPreview, candidate)) continue
      const moved = await rt.move({ type: 'move_to', target: candidate, resource: 'mining_origin', allowWater: false, sprint: false }, context, { movementPolicy: policy, validateState: check, validateRoute: routeSafe })
      if (moved.partial) throw new rt.RunnerError('Mining origin recenter did not prove a full landing', 'NO_SAFE_ROUTE')
      const after = await rt.read(context.signal); check(after)
      const landingCenter = { x: Math.floor(after.position.x), y: center.y, z: Math.floor(after.position.z) }
      const landing = await rt.request('GET', '/blocks?x=' + landingCenter.x + '&y=' + landingCenter.y + '&z=' + landingCenter.z + '&radius=3', undefined, { signal: context.signal })
      const landingMap = new Map((landing?.blocks ?? []).filter(block => rt.finite(block.position)).map(block => [rt.positionKey(block.position), block]))
      const supported = state => {
        const physical = state.predicted?.physicsState ?? state.physicsState
        if (physical?.onGround !== true || physical.isInWater || physical.isInLava || Math.abs(state.position.y - 1.62 - center.y) > 1e-4) return false
        for (let x = Math.floor(state.position.x - 0.3 + 1e-6); x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) if (!solid(landingMap.get(rt.positionKey({ x, y: center.y - 1, z }))) || !open(landingMap.get(rt.positionKey({ x, y: center.y, z }))) || !open(landingMap.get(rt.positionKey({ x, y: center.y + 1, z })))) return false
        return true
      }
      const landed = await rt.read(context.signal); check(landed)
      if (!supported(landed)) throw new rt.RunnerError('Mining recenter did not reach fresh known full dry support', 'SETTLE_NOT_CONFIRMED')
      const page = await rt.request('GET', '/blocks?x=' + target.x + '&y=' + target.y + '&z=' + target.z + '&radius=0', undefined, { signal: context.signal })
      const currentResource = page?.blocks?.find(block => rt.positionKey(block.position) === rt.positionKey(target))
      if (currentResource?.known !== true || currentResource.name !== resource.name || currentResource.runtimeId !== resource.runtimeId) throw new rt.RunnerError('The original resource changed during mining-origin recenter', 'RESOURCE_CHANGED')
      rt.report(context, { type: 'prepare_item_work', phase: 'origin_recentered', target: rt.copy(candidate), resourceTarget: target, serverConfirmed: false, resourceReady: false })
      const finalState = await rt.read(context.signal); check(finalState)
      if (!supported(finalState)) throw new rt.RunnerError('Mining landing support changed before the fresh preview', 'SETTLE_NOT_CONFIRMED')
      return finalState
    }
    throw new rt.RunnerError('No known full dry mining stance has a bounded recenter route', 'NO_SAFE_ROUTE')
  }

  async function mine (decision, context) {
    let state = await rt.groundedItemState(context)
    if (!rt.finite(decision.target) || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(decision.target[axis]))) throw new rt.RunnerError('Mining requires an integer block target')
    const target = rt.copy(decision.target)
    const type = decision.type ?? rt.active?.type
    const miningTarget = type === 'clear_access' ? { ...target, accessPreparation: 'tree_access', expectedName: decision.block } : target
    let preview = await rt.request('POST', '/mining/preview', { targets: [miningTarget] }, { signal: context.signal })
    if (!preview?.ready && ['gather_logs', 'mine_stone', 'mine_ore'].includes(type) && (preview?.errors ?? []).some(error => String(error).includes('通常の地面に静止していることを確認できません。'))) {
      const recentered = await recenterMiningOrigin(decision, context, state)
      if (recentered) { state = recentered; preview = await rt.request('POST', '/mining/preview', { targets: [miningTarget] }, { signal: context.signal }) }
    }
    if (!preview?.ready) throw new rt.RunnerError(preview?.errors?.join('\n') ?? 'Mining preview was not ready', 'PREVIEW_REJECTED')
    const actualBlock = preview.targets?.find(block => rt.finite(block.position) && rt.positionKey(block.position) === rt.positionKey(target))
    const actualName = actualBlock?.name
    if (type === 'gather_logs' && !rt.LOG.test(actualName ?? '') || type === 'mine_stone' && !rt.STONE.test(actualName ?? '') && !(decision.material === true && actualName === decision.block) || type === 'mine_ore' && (actualName !== decision.block || !/^minecraft:(?:deepslate_)?(?:coal|iron|diamond)_ore$/.test(actualName ?? '')) || type === 'clear_access' && (actualName !== decision.block || !['minecraft:leaf_litter', 'minecraft:vine'].includes(actualName))) throw new rt.RunnerError('The live target does not match the requested resource', 'RESOURCE_CHANGED')
    if (type === 'gather_dirt' && (!['minecraft:dirt', 'minecraft:grass_block'].includes(actualName) || actualName !== decision.block || actualBlock.protected || actualBlock.owned || actualBlock.natural === false || actualBlock.extra?.length)) throw new rt.RunnerError('The live soil target changed or became protected', 'RESOURCE_CHANGED')
    let finished = false
    try {
      await rt.request('POST', '/mining/start', { targets: [miningTarget] }, { signal: context.signal })
      await rt.waitFor(current => {
        if (['failed', 'stopped'].includes(current.mining?.phase)) throw new rt.RunnerError(current.mining.reason ?? 'Mining failed', 'MINING_STOPPED')
        return current.mining?.phase === 'completed'
      }, { signal: context.signal, baselineHealth: state.health })
      const block = await rt.request('GET', `/blocks?x=${target.x}&y=${target.y}&z=${target.z}&radius=0`, undefined, { signal: context.signal })
      if (!block?.blocks?.some(value => value.known && rt.AIR.has(value.name) && rt.positionKey(value.position) === rt.positionKey(target))) throw new rt.RunnerError('The target block did not become known air', 'BLOCK_NOT_CONFIRMED')
      finished = true
      return rt.result({ serverConfirmed: true, confirmedBy: 'server_block_update', blocksBroken: 1, collected: false, target })
    } finally { if (!finished) await rt.bestEffort('/mining/stop') }
  }
  return {
    mine
  }
}

module.exports = { createRunnerMining }
