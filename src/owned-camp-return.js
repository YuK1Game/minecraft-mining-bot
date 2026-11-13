'use strict'

const { isDeepStrictEqual: same } = require('node:util')
const { continuationScope } = require('./base-continuation')
const { evaluateThreats } = require('./threats')
const { campFloorMatches } = require('./worksite-camp')
const copy = value => structuredClone(value)
const { finitePoint: finite } = require('./vec3')
const integer = p => finite(p) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const worldKey = scope => JSON.stringify([scope.profile, scope.realmId, scope.dimension])
const fingerprint = b => b?.known === true ? { name: b.name, runtimeId: b.runtimeId ?? null, properties: copy(b.properties ?? {}) } : null
const { distance3: distance } = require('./vec3')
const OPEN = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:short_grass', 'minecraft:fern', 'minecraft:leaf_litter', 'minecraft:deadbush', 'minecraft:torch'])
const GROUND = /^minecraft:(?:stone|deepslate|cobblestone|cobbled_deepslate|grass_block|dirt|coarse_dirt|rooted_dirt|andesite|diorite|granite|tuff|calcite|moss_block|crafting_table|furnace|lit_furnace|[a-z_]+_planks)$/
const CAMP_GROUND = /^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|deepslate|andesite|diorite|granite|tuff|calcite|moss_block)$/
const fullGround = b => b?.known === true && b.boundingBox === 'block' && GROUND.test(b.name) && !b.extra?.length && (b.shapes == null || Array.isArray(b.shapes) && b.shapes.some(s => Array.isArray(s) && s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1))))
const segmentDistance = (p, a, b) => { const v = ['x', 'y', 'z'].map(k => b[k] - a[k]); const l = v.reduce((s, n) => s + n * n, 0); const t = l ? Math.max(0, Math.min(1, ['x', 'y', 'z'].reduce((s, k, i) => s + (p[k] - a[k]) * v[i], 0) / l)) : 0; return Math.hypot(...['x', 'y', 'z'].map((k, i) => p[k] - a[k] - t * v[i])) }

// Pure proposals for ONE existing ordinary move. This does not revalidate a
// distant worksite for use, publish AIR, create a visited prefix, or reach it.
function planOwnedCampReturn ({ state, world, campMemo, ownedChest = null, previewMove, previewRoute = null } = {}) {
  const no = reason => ({ ready: false, reason, predictionOnly: true, serverConfirmed: false })
  const scope = continuationScope(state), m = campMemo, physics = state?.predicted?.physicsState ?? state?.physicsState
  if (!scope || !['survival', 0].includes(state.gameMode) || state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || state.entityStats?.unknownPositions !== 0 || !Array.isArray(state.entities) || typeof world?.getBlock !== 'function' || typeof previewMove !== 'function') return no('current_scope_or_inventory_unknown')
  const at = p => world.getBlock(p.x, p.y, p.z)
  if (m?.version !== 1 || m.kind !== 'worksite_camp' || m.worldScope !== worldKey(scope) || m.pending || !integer(m.tableCell) || !integer(m.storageCell) || m.tableCell.y !== m.storageCell.y || Math.abs(m.tableCell.x - m.storageCell.x) + Math.abs(m.tableCell.z - m.storageCell.z) !== 1 || !Array.isArray(m.floorFingerprints) || m.floorFingerprints.length !== 2) return no('owned_camp_memo_unknown')
  const r = m.table
  if (!r || r.operation !== 'place' || r.blockName !== 'minecraft:crafting_table' || !same(r.position, m.tableCell) || r.serverConfirmed !== true || r.inventoryConfirmed !== true || r.confirmedBy !== 'server_block_and_inventory' || r.beforeCount - r.afterCount !== 1 || !r.scope || worldKey(r.scope) !== m.worldScope || !same(r.fingerprint, fingerprint(at(m.tableCell))) || at(m.tableCell)?.name !== 'minecraft:crafting_table' || at(m.tableCell)?.extra?.length) return no('owned_table_not_current')
  if ([m.tableCell, m.storageCell].some((p, i) => { const b = at({ ...p, y: p.y - 1 }); return !campFloorMatches(m.floorFingerprints[i], b) || !fullGround(b) })) return no('camp_floor_fingerprint_changed')
  if (ownedChest && (!same(ownedChest.position, m.storageCell) || !ownedChest.placementScope || worldKey(ownedChest.placementScope) !== m.worldScope || !same(ownedChest.fingerprint, fingerprint(at(m.storageCell))) || at(m.storageCell)?.name !== 'minecraft:chest' || at(m.storageCell)?.extra?.length)) return no('owned_chest_not_current')
  const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
  if (evaluation.requiresObservation || evaluation.threats.length) return no('danger_or_actor_unknown')
  const circles = [...evaluation.outsideDanger, ...evaluation.suppressedByTerrain]
  if (circles.some(a => !state.entities.some(e => String(e.runtimeId) === a.runtimeId && e.uniqueId != null && e.entityType === a.name && e.dimension === state.dimension && e.positionKnown === true && finite(e.position)))) return no('actor_identity_or_scope_unknown')
  const solid = fullGround
  const open = b => b?.known === true && OPEN.has(b.name) && !b.extra?.length && (b.name.endsWith(':air') || b.name.endsWith('_air') || b.boundingBox === 'empty')
  const standing = p => {
    if (!finite(p) || Math.abs(p.y - Math.round(p.y)) > 1e-4) return false
    for (const dx of [-.2999, .2999]) for (const dz of [-.2999, .2999]) { const c = { x: Math.floor(p.x + dx), y: Math.round(p.y), z: Math.floor(p.z + dz) }; if (!solid(at({ ...c, y: c.y - 1 })) || !open(at(c)) || !open(at({ ...c, y: c.y + 1 }))) return false }
    return !state.entities.some(e => e.alive !== false && e.kind !== 'item' && String(e.runtimeId) !== scope.runtimeEntityId && (!finite(e.position) || e.positionKnown !== true || Math.hypot(e.position.x - p.x, e.position.z - p.z) < 1 && Math.abs(e.position.y - p.y) < 3))
  }
  const feet = { ...state.position, y: state.position.y - 1.62 }, camp = { x: m.tableCell.x + .5, y: m.tableCell.y, z: m.tableCell.z + .5 }
  if (physics?.onGround !== true || physics.isInWater || physics.isInLava || !standing(feet)) return no('full_dry_origin_not_proven')
  const initialDistance = distance(feet, camp)
  if (initialDistance <= 7.5) return no('within_camp_revalidation_range')
  const candidates = []
  for (let x = Math.floor(feet.x) - 6; x <= Math.floor(feet.x) + 6; x++) for (let z = Math.floor(feet.z) - 6; z <= Math.floor(feet.z) + 6; z++) for (let dy = -2; dy <= 2; dy++) {
    const target = { x: x + .5, y: Math.round(feet.y) + dy, z: z + .5 }, leg = distance(feet, target), remaining = distance(target, camp)
    if (leg <= .4 || leg > 6 || remaining >= initialDistance - .25 || !standing(target)) continue
    candidates.push({ target, leg, remaining })
  }
  candidates.sort((a, b) => a.remaining - b.remaining || a.leg - b.leg)
  const options = { allowWater: false, maxDistance: 6, maxExpanded: 300 }
  let previews = 0
  for (const c of candidates.slice(0, 4)) {
    let route; try { previews++; route = previewMove(copy(c.target), copy(options)) } catch { continue }
    if (route?.then || route?.ready !== true || !Array.isArray(route.waypoints) || route.waypoints.length < 1 || route.waypoints.length > 32) continue
    const points = [feet, ...route.waypoints.map(w => w.position)]
    if (points.some(p => !finite(p)) || distance(points.at(-1), c.target) > .4 || points.slice(1).some((p, i) => circles.some(a => segmentDistance(a.position, { ...points[i], y: points[i].y + 1.62 }, { ...p, y: p.y + 1.62 }) < a.dangerRadius - 1e-4))) continue
    return { ready: true, scope: copy(scope), campId: m.id, target: copy(c.target), options, initialDistance, targetDistance: c.remaining, previews, predictionOnly: true, serverConfirmed: false, reachedCamp: false, requiresReobservation: true, decision: { type: 'move_to', stage: 'return_to_owned_camp', resource: 'owned_camp', target: copy(c.target), allowWater: false, reason: 'Approach the currently revalidated owned camp through one bounded known ordinary route; reobserve before station use.' } }
  }
  // A full READ-ONLY route may prove that the first safe step moves away from
  // camp. Discard it after selecting one short prefix; never execute it whole.
  if (typeof previewRoute === 'function') {
    const goals = []
    for (let x = m.tableCell.x - 3; x <= m.tableCell.x + 3; x++) for (let z = m.tableCell.z - 3; z <= m.tableCell.z + 3; z++) {
      if (x === m.tableCell.x && z === m.tableCell.z || x === m.storageCell.x && z === m.storageCell.z) continue
      const target = { x: x + .5, y: m.tableCell.y, z: z + .5 }, floor = at({ x, y: m.tableCell.y - 1, z })
      if (distance(target, camp) <= 3 && distance(feet, target) <= 48 && standing(target) && CAMP_GROUND.test(floor.name) && !floor.protected && !floor.protectionSource && floor.natural !== false) goals.push(target)
    }
    goals.sort((a, b) => distance(feet, a) - distance(feet, b) || distance(a, camp) - distance(b, camp) || a.x - b.x || a.z - b.z)
    const goal = goals[0]
    if (!goal) return { ...no('no_known_camp_route_goal'), previews }
    const began = performance.now()
    let full
    try { previews++; full = previewRoute(copy(goal), { allowWater: false, maxDistance: 48, maxExpanded: 1500 }) } catch { return { ...no('full_camp_route_declined'), previews } }
    const fullPreviewMs = performance.now() - began
    const points = [feet, ...(Array.isArray(full?.waypoints) ? full.waypoints.map(w => w.position) : [])]
    if (full?.then || full?.ready !== true || points.length < 2 || points.length > 257 || full.directFlat || full.directSurface || full.boundedJump || full.originRecenter || full.partialRecenter || full.partialDrop || full.controlledDrop || full.waypoints.some(w => !['walk', 'jump'].includes(w.action) || w.medium !== 'land') || points.some(p => !finite(p)) || distance(points.at(-1), goal) > .4 || points.slice(1).some((p, i) => !standing(p) || circles.some(a => segmentDistance(a.position, { ...points[i], y: points[i].y + 1.62 }, { ...p, y: p.y + 1.62 }) < a.dangerRadius - 1e-4))) return { ...no('full_camp_route_unproven'), previews, fullPreviewMs }
    let target = null, pathLength = 0
    for (let i = 1; i < points.length; i++) {
      const nextLength = pathLength + distance(points[i - 1], points[i])
      if (nextLength > 4.5 || distance(feet, points[i]) > 6) break
      pathLength = nextLength; target = points[i]
    }
    if (!target || distance(feet, target) <= .4) return { ...no('full_camp_route_has_no_short_prefix'), previews, fullPreviewMs }
    let short
    try { previews++; short = previewMove(copy(target), copy(options)) } catch { return { ...no('camp_detour_prefix_declined'), previews, fullPreviewMs } }
    const prefix = [feet, ...(Array.isArray(short?.waypoints) ? short.waypoints.map(w => w.position) : [])]
    const shortPathLength = prefix.every(finite) ? prefix.slice(1).reduce((sum, p, i) => sum + distance(prefix[i], p), 0) : Infinity
    if (short?.then || short?.ready !== true || prefix.length < 2 || prefix.length > 33 || prefix.some(p => !finite(p)) || shortPathLength > 4.5 || distance(prefix.at(-1), target) > .4 || prefix.slice(1).some((p, i) => !standing(p) || circles.some(a => segmentDistance(a.position, { ...prefix[i], y: prefix[i].y + 1.62 }, { ...p, y: p.y + 1.62 }) < a.dangerRadius - 1e-4))) return { ...no('camp_detour_prefix_unproven'), previews, fullPreviewMs }
    return { ready: true, scope: copy(scope), campId: m.id, target: copy(target), options, initialDistance, targetDistance: distance(target, camp), previews, detour: true, fullPreviewMs, prefixPathLength: pathLength, predictionOnly: true, serverConfirmed: false, reachedCamp: false, requiresReobservation: true, decision: { type: 'move_to', stage: 'return_to_owned_camp', resource: 'owned_camp', target: copy(target), allowWater: false, requiresLivePreview: true, reason: 'Follow a short revalidated prefix of a fully known ordinary route toward the owned camp; temporary direct-distance increase is not arrival.' } }
  }
  return { ...no('no_known_progressive_camp_route'), previews }
}
module.exports = { planOwnedCampReturn }
