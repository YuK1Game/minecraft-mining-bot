'use strict'

const { isDeepStrictEqual: same } = require('node:util')
const { continuationScope } = require('./base-continuation')
const { evaluateThreats } = require('./threats')
const { isSupportedFood } = require('./food')
const copy = value => structuredClone(value)
const { pointKey: key } = require('./vec3')
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const worldKey = s => s && JSON.stringify([s.profile, String(s.realmId ?? s.realm?.id), s.dimension])
const fingerprint = b => b?.known === true ? { name: b.name, runtimeId: b.runtimeId ?? null, properties: copy(b.properties ?? {}) } : null
const count = (s, match) => s.inventory.items.reduce((n, i) => n + (Number.isSafeInteger(i.count) && i.count > 0 && match(i.name) ? i.count : 0), 0)
const summary = result => result && typeof result === 'object' ? Object.fromEntries(['phase', 'kind', 'code', 'reason', 'operation', 'serverConfirmed', 'inventoryConfirmed', 'containerConfirmed'].filter(k => ['string', 'number', 'boolean'].includes(typeof result[k])).map(k => [k, typeof result[k] === 'string' ? result[k].slice(0, 500) : result[k]])) : null

// Only the already validated base's known floor cells are considered. The
// actual placement preview is authoritative; no general access preference or
// interaction reach changes, and no projected pose is published to the host.
function planPrebuildChestStance ({ state, scope, world, base, target, previewPlaceAt, previewMove }) {
  if (!same(continuationScope(state), scope) || !integer(target) || !same(base?.storageCell, target) || !Array.isArray(base?.floorCells) || base.floorCells.length > 128 || !base.floorCells.every(integer) || typeof previewPlaceAt !== 'function' || typeof previewMove !== 'function') return null
  const at = p => world.getBlock(p.x, p.y, p.z), cell = at(target)
  if (cell?.known !== true || cell.extra?.length || !['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(cell.name)) return null
  const evaluated = evaluateThreats(state, state.entities ?? state.hostiles, { observationRadius: 32 })
  if (evaluated.requiresObservation || evaluated.threats.length || state.entityStats?.unknownPositions > evaluated.unknownPositions.length) return null
  const avoidance = [...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].map(a => ({ id: a.runtimeId, position: { ...a.position }, minDistance: a.dangerRadius, padding: 0 }))
  const support = b => b?.known === true && b.boundingBox === 'block' && !b.extra?.length && /^minecraft:(?:stone|grass_block|dirt|cobblestone|deepslate|cobbled_deepslate|andesite|granite|diorite|tuff|calcite|[a-z_]+_planks)$/.test(b.name)
  const empty = b => b?.known === true && !b.extra?.length && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(b.name)
  const feet = { ...state.position, y: state.position.y - 1.62 }
  const candidates = base.floorCells.map(p => ({ x: p.x + .5, y: p.y + 1, z: p.z + .5 })).sort((a, b) => Math.hypot(a.x - feet.x, a.y - feet.y, a.z - feet.z) - Math.hypot(b.x - feet.x, b.y - feet.y, b.z - feet.z))
  for (const p of candidates) {
    const distance = Math.hypot(p.x - feet.x, p.y - feet.y, p.z - feet.z)
    if (distance <= .4 || distance > 6 || p.x + .3 > target.x && p.x - .3 < target.x + 1 && p.z + .3 > target.z && p.z - .3 < target.z + 1 && p.y < target.y + 1 && p.y + 1.8 > target.y) continue
    let standing = true
    for (const dx of [-.2999, .2999]) for (const dz of [-.2999, .2999]) { const x = Math.floor(p.x + dx), z = Math.floor(p.z + dz); if (!support(at({ x, y: p.y - 1, z })) || !empty(at({ x, y: p.y, z })) || !empty(at({ x, y: p.y + 1, z }))) standing = false }
    if (!standing || (state.entities ?? []).some(e => e.alive !== false && e.kind !== 'item' && String(e.runtimeId) !== String(state.runtimeEntityId) && (e.positionKnown !== true || !e.position || Math.hypot(e.position.x - p.x, e.position.z - p.z) < 1 && Math.abs(e.position.y - p.y) < 3))) continue
    const projected = { ...state, position: { ...p, y: p.y + 1.62 }, predicted: null, physicsState: null, positionSource: 'planning_projection' }
    try { if (previewPlaceAt({ state: projected, target, slot: state.rawServerSelectedSlot ?? state.rawSelectedSlot }).ready === true && previewMove(p, { allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance }).ready === true) return { standpoint: p, scope: copy(scope), avoidance, predictionOnly: true, serverConfirmed: false } } catch {}
  }
  return null
}

function realToolKit (state, getRawItem, materials) {
  if (state?.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || !Array.isArray(state.inventory.items) || typeof getRawItem !== 'function') return false
  const tool = type => state.inventory.items.some(item => {
    if (!new RegExp('^minecraft:(?:' + materials + ')_' + type + '$').test(item.name ?? '') || item.count !== 1 || item.durabilityKnown !== true || !Number.isFinite(item.durabilityRemaining) || !(item.durabilityRemaining > 0) || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) return false
    const raw = getRawItem(item.slot), networkId = item.networkId ?? item.network_id
    // Host DTOs may omit stackId. The actual raw positive ID remains required;
    // normalized network/count/metadata must agree and an optional ID must match.
    return Number.isSafeInteger(networkId) && networkId > 0 && raw?.network_id === networkId && raw.count === item.count && raw.has_stack_id === true && Number.isSafeInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647 && (item.metadata == null || item.metadata === raw.metadata) && (!Object.hasOwn(item, 'stackId') || item.stackId === raw.stack_id)
  })
  return tool('sword') && tool('pickaxe')
}
function realStoneKit (state, getRawItem) { return realToolKit(state, getRawItem, 'stone|iron|diamond|netherite') }
function realStarterKit (state, getRawItem) { return realToolKit(state, getRawItem, 'wooden|stone|iron|diamond|netherite') }

function remainingDirt (memo, scope, world) {
  if (!memo) return 24
  if (memo.kind !== 'fresh_surface_depot' || memo.version !== 1 || memo.worldScope !== worldKey(scope) || memo.pending != null || !Array.isArray(memo.placements) || memo.placements.length > 24 || !Array.isArray(memo.removals) || memo.removals.length > 4) return null
  const seen = new Set()
  for (const r of memo.placements) {
    if (!integer(r.position) || seen.has(key(r.position)) || r.serverConfirmed !== true || r.confirmedBy !== 'server_block_and_inventory' || r.count !== 1 || r.beforeCount - r.afterCount !== 1 || worldKey(r.scope) !== worldKey(scope)) return null
    seen.add(key(r.position))
    const removed = memo.removals.find(q => key(q.position) === key(r.position)), b = world.getBlock(r.position.x, r.position.y, r.position.z)
    if (removed) {
      if (r.item !== 'minecraft:dirt' || removed.serverConfirmed !== true || removed.confirmedBy !== 'received_air_and_completed_owned_mining' || worldKey(removed.scope) !== worldKey(scope) || b?.known !== true || !['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:chest'].includes(b.name)) return null
    } else if (!same(fingerprint(b), r.fingerprint)) return null
  }
  return Math.max(0, 24 - seen.size)
}

function createDepotPrebuild ({ getState, getRawItem, world, getSurface, getBuilder, getStorage, isIdle, takeover, dispatch, resumeLegacy, onProgress = () => {} }) {
  if ([getState, getRawItem, getSurface, getBuilder, getStorage, isIdle, takeover, dispatch, resumeLegacy, onProgress].some(fn => typeof fn !== 'function') || typeof world?.getBlock !== 'function') throw Error('Prebuild needs current scoped state and existing owned controllers')
  let task = null, controller = null, activeScope = null, baseScope = null, chestScope = null, doneScope = null, lastBuilderCode = null
  let status = { phase: 'idle', busy: false, deposited: 0, serverConfirmed: false }
  const snapshot = () => copy(status)
  const publish = value => { status = { ...status, ...value }; try { onProgress(snapshot()) } catch {} }
  function state () {
    const s = getState(), scope = continuationScope(s)
    if (!scope || s.inventory?.known !== true || s.inventory.uncertain || s.inventoryConfidence?.known === false || !Array.isArray(s.inventory.items)) return null
    return { s, scope }
  }
  function ownChest (memo, scope) {
    const chest = memo?.chest
    return memo?.world === worldKey(scope) && chest && integer(chest.position) && worldKey(chest.placementScope) === worldKey(scope) && same(fingerprint(world.getBlock(chest.position.x, chest.position.y, chest.position.z)), chest.fingerprint)
  }
  function plan (context) {
    const current = state()
    if (!current) return null
    const { s, scope } = current, scopeId = JSON.stringify(scope), memo = context.policy.memo()
    if (context.scope != null && !same(context.scope, scope)) return { kind: 'yield', reason: 'scope_changed' }
    if (memo.deposited > 0) return null
    if (count(s, n => n === 'minecraft:diamond') > 0) return null
    if (doneScope === scopeId && ownChest(memo, scope)) return null
    if (!realStarterKit(s, getRawItem)) return null
    const threats = evaluateThreats(s, s.entities ?? s.hostiles, { observationRadius: 32 })
    if (threats.requiresObservation || threats.threats.length || s.entityStats?.unknownPositions > threats.unknownPositions.length) return { kind: 'yield', reason: 'survival' }
    const hunger = s.food?.hunger
    if (s.health <= 8 || Number.isFinite(hunger) && hunger <= 6) return { kind: 'maintain', priority: 'food_health' }
    if (activeScope !== scopeId && (!(s.health >= 9) || !Number.isFinite(hunger) || hunger < 10)) return null
    // Eating an owned stack is bounded; this phase never dispatches a remote
    // hunt merely to raise a nonurgent hunger value from17 to18.
    if (Number.isFinite(hunger) && hunger < 18 && count(s, n => isSupportedFood(n, s)) > 0) return { kind: 'prebuild_eat_owned' }
    const surface = getSurface(), feet = { ...s.position, y: s.position.y - 1.62 }
    if (!same(surface?.scope, scope) || !surface.position || Math.abs(feet.y - surface.position.y) > 2 || Math.hypot(feet.x - surface.position.x, feet.z - surface.position.z) > 16) return { kind: 'return_surface' }
    const builder = getBuilder() ?? {}, remaining = remainingDirt(builder.memo, scope, world)
    if (remaining == null) return { kind: 'establish_base' }
    const dirt = count(s, n => n === 'minecraft:dirt')
    if (baseScope !== scopeId && dirt < remaining) return { kind: 'prebuild_gather_dirt', count: Math.min(2, remaining - dirt), excludedPositions: copy(builder.protectedCells ?? []), maxDistance: 12 }
    const heldChest = count(s, n => n === 'minecraft:chest') > 0, heldTable = count(s, n => n === 'minecraft:crafting_table') > 0
    const planks = count(s, n => /^minecraft:[a-z_]+_planks$/.test(n)), logs = count(s, n => /^minecraft:[a-z_]+_(?:log|stem|wood|hyphae)$/.test(n)), needed = heldChest || ownChest(memo, scope) ? 0 : heldTable ? 8 : 12
    if (planks + logs * 4 < needed) return { kind: 'work', resource: 'logs', targetCount: logs + Math.ceil((needed - planks - logs * 4) / 4), prebuildMaxDistance: 12 }
    if (baseScope !== scopeId) return lastBuilderCode === 'NO_KNOWN_FLAT_SITE' && !builder.memo ? { kind: 'prebuild_explore', maxDistance: 12 } : { kind: 'establish_base' }
    if (!ownChest(memo, scope)) { chestScope = null; return { kind: 'ensure_chest' } }
    const storage = getStorage(), window = storage?.window
    if (same(window?.scope, scope) && same(window?.position, memo.chest.position) && storage.contentsKnown === true && Array.isArray(storage.slots) && storage.slots.length === 27 && storage.slots.every(i => i.known === true)) chestScope = scopeId
    if (chestScope !== scopeId) return { kind: 'observe_storage', position: copy(memo.chest.position) }
    return s.crafting?.openContainer ? { kind: 'prebuild_close' } : { kind: 'prebuild_complete' }
  }
  function step (context) {
    if (task) return task
    controller = new AbortController()
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
    task = (async () => {
      if (signal.aborted) throw signal.reason ?? Error('Prebuild cancelled')
      let intent = plan(context)
      if (!intent) return { handled: false }
      if (intent.kind === 'yield' || isIdle() !== true) return { handled: true, result: { phase: 'yielding', owner: intent.reason ?? 'existing_action' } }
      const before = state(), scopeId = JSON.stringify(before.scope)
      if (!await takeover({ scope: before.scope, signal })) return { handled: true, result: { phase: 'yielding', owner: 'legacy_drain' } }
      const fresh = state()
      if (signal.aborted || !fresh || !same(fresh.scope, before.scope) || fresh.s.health < before.s.health) throw Error('Prebuild takeover scope, life or health changed')
      if (isIdle() !== true) return { handled: true, result: { phase: 'yielding', owner: 'fresh_owner' } }
      if (activeScope !== scopeId) { activeScope = scopeId; baseScope = null; chestScope = null; doneScope = null; lastBuilderCode = null }
      intent = plan(context)
      if (!intent || intent.kind === 'yield') return { handled: true, result: { phase: 'yielding', owner: 'fresh_state' } }
      publish({ busy: true, phase: intent.kind, scope: before.scope })
      if (intent.kind === 'prebuild_complete') {
        await resumeLegacy({ scope: fresh.scope, signal })
        const resumed = state()
        if (signal.aborted || !resumed || !same(resumed.scope, fresh.scope) || resumed.s.health < fresh.s.health) throw Error('Prebuild release crossed scope, life or health')
        doneScope = scopeId
        return { handled: true, result: { phase: 'prebuilt', baseReady: true, chestReady: true, deposited: 0, serverConfirmed: false } }
      }
      const result = await dispatch({ ...intent, scope: fresh.scope, prebuild: true }, { ...context, signal, prebuild: true })
      const after = state()
      if (signal.aborted || !after || !same(after.scope, fresh.scope) || after.s.health < fresh.s.health) throw Error('Prebuild primitive crossed scope, life or damage boundary')
      if (result?.baseProof) { context.policy.acceptBase(result.baseProof); baseScope = scopeId }
      if (result?.receipt?.operation === 'place' && result.receipt.blockName === 'minecraft:chest') context.policy.acceptChest(result.receipt)
      if (intent.kind === 'establish_base') lastBuilderCode = result?.code ?? null
      if (intent.kind === 'prebuild_explore') lastBuilderCode = null
      publish({ lastResult: summary(result), deposited: 0 })
      return { handled: true, result }
    })().finally(() => { publish({ busy: false }); task = null; controller = null })
    return task
  }
  return { step, snapshot, cancel: reason => controller?.abort(Error(reason ?? 'Prebuild cancelled')), drain: () => task ?? Promise.resolve(snapshot()) }
}

module.exports = { createDepotPrebuild, realStoneKit, realStarterKit, remainingDirt, planPrebuildChestStance }
