'use strict'

const { performance } = require('node:perf_hooks')
const { isDeepStrictEqual } = require('node:util')

// Only ordinary walking zombies are covered. Drowned may carry a trident;
// spiders climb, endermen teleport, and other profiles need separate models.
const TYPES = new Set(['minecraft:zombie', 'minecraft:husk', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2'])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const CUBES = /^(?:minecraft:)(?:stone|granite|diorite|andesite|deepslate|cobbled_deepslate|tuff|calcite|bedrock|cobblestone|mossy_cobblestone|dirt|grass_block|coarse_dirt|rooted_dirt|netherrack|end_stone|obsidian|crying_obsidian|blackstone|basalt|smooth_basalt|[a-z_]+_ore|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood)$/
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const copy = value => structuredClone(value)
const stamp = value => Number.isSafeInteger(value) && value >= 0
const id = value => typeof value === 'string' && /^-?\d+$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'bigint' ? String(value) : null

function binding (target, state) {
  const life = state?.lifecycle?.deathId ?? state?.deathId
  if (!state?.profile || state.realm?.id == null || !state.dimension || !state.connectionId || !state.startedAt || id(state.runtimeEntityId) == null || !stamp(life) || !finite(state.position) || !stamp(state.worldRevision) || !target || !finite(target.position) || id(target.runtimeId) == null || id(target.uniqueId) == null) return null
  return {
    scope: { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), life },
    actor: { runtimeId: String(target.runtimeId), uniqueId: String(target.uniqueId), entityType: target.entityType, position: copy(target.position) },
    botPosition: copy(state.position), worldRevision: state.worldRevision
  }
}

function isCurrentBlockedGroundProof (proof, target, state, now = Date.now()) {
  const expected = binding(target, state)
  return !!expected && TYPES.has(target.entityType) && target.kind === 'mob' && target.hostile === true && target.alive === true && target.positionKnown === true && target.primed !== true && target.dimension === state.dimension &&
    Math.hypot(target.position.x - state.position.x, target.position.y - state.position.y + 1.62, target.position.z - state.position.z) > 3 &&
    proof?.kind === 'closed_known_dry_air_component_v1' && proof.status === 'BLOCKED' && proof.routeToBot === false && proof.unknownTouched === false && proof.boundaryTouched === false && proof.truncated === false &&
    Number.isFinite(proof.observedAt) && Number.isFinite(now) && now >= proof.observedAt && now - proof.observedAt <= 250 &&
    ['scope', 'actor', 'botPosition', 'worldRevision'].every(key => isDeepStrictEqual(proof[key], expected[key]))
}

// Search a superset of all ordinary walking/jumping paths: 26-neighbour AIR
// connectivity, with no floor, body-height or jump-height requirement. Even
// impossible flight and corner cutting refuse an exemption. Only a completely
// closed received component proves no access; open bounds/unknown stay UNKNOWN.
function proveGroundAccess ({ target, state, getBlock, getWorldRevision, now = Date.now, clock = () => performance.now(), maxNodes = 2048, maxCells = 12000, maxMs = 6, radius = 16, vertical = 16 } = {}) {
  const observedAt = now(), bound = binding(target, state)
  const result = { kind: 'closed_known_dry_air_component_v1', status: 'UNKNOWN', routeToBot: null, reason: 'SCOPE_OR_POSITION_UNKNOWN', observedAt, ...(bound ?? {}), unknownTouched: false, boundaryTouched: false, truncated: false, visitedNodes: 0, checkedCells: 0 }
  if (!bound) return result
  if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0)) return { ...result, reason: 'BOT_NOT_ALIVE' }
  if (!TYPES.has(target.entityType) || target.kind !== 'mob' || target.hostile !== true || target.alive !== true || target.positionKnown !== true || target.dimension !== state.dimension || target.primed === true) return { ...result, reason: 'ACTOR_NOT_SUPPORTED' }
  const feet = { ...state.position, y: state.position.y - 1.62 }
  if (Math.hypot(target.position.x - feet.x, target.position.y - feet.y, target.position.z - feet.z) <= 3) return { ...result, reason: 'IMMEDIATE_RANGE' }
  if (typeof getBlock !== 'function' || typeof getWorldRevision !== 'function' || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 4096 || !Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 24000 || !(maxMs > 0 && maxMs <= 15) || !Number.isInteger(radius) || radius < 1 || radius > 24 || !Number.isInteger(vertical) || vertical < 1 || vertical > 24) return { ...result, reason: 'INVALID_SEARCH_LIMITS' }
  const start = { x: Math.floor(target.position.x), y: Math.floor(target.position.y), z: Math.floor(target.position.z) }
  const cache = new Map(), seen = new Set(), queue = []
  const began = clock()
  const unknown = reason => { result.unknownTouched = true; result.reason = reason; return 'unknown' }
  const at = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cache.has(key)) return cache.get(key)
    if (cache.size >= maxCells) { result.truncated = true; result.reason = 'CELL_LIMIT'; return 'unknown' }
    let b
    try { b = getBlock(x, y, z) } catch { return unknown('TERRAIN_READ_FAILED') }
    let kind
    if (b?.known !== true) kind = unknown('TERRAIN_UNKNOWN')
    else if (b.extra?.length || /water|lava|bubble|sand$|gravel$|concrete_powder|fire|magma|cactus|campfire|powder_snow|dripstone|scaffolding/.test(b.name ?? '')) kind = unknown('NON_DRY_OR_DYNAMIC_TERRAIN')
    else if (AIR.has(b.name) && b.boundingBox === 'empty') kind = 'air'
    else if (b.boundingBox === 'block' && CUBES.test(b.name) && (!b.shapes || b.shapes.length === 1 && isDeepStrictEqual(b.shapes[0], [0, 0, 0, 1, 1, 1]))) kind = 'solid'
    else kind = unknown('UNMODELED_BLOCK_SHAPE')
    cache.set(key, kind); result.checkedCells = cache.size
    return kind
  }
  const add = p => {
    const key = `${p.x},${p.y},${p.z}`
    if (seen.has(key)) return
    if (Math.hypot(p.x - start.x, p.z - start.z) > radius || Math.abs(p.y - start.y) > vertical) { result.boundaryTouched = true; return }
    if (seen.size >= maxNodes) { result.truncated = true; result.reason = 'NODE_LIMIT'; return }
    seen.add(key); queue.push(p)
  }
  const finish = (status, reason) => {
    result.visitedNodes = seen.size
    let revision
    try { revision = getWorldRevision() } catch {}
    if (revision !== bound.worldRevision) return { ...result, status: 'UNKNOWN', routeToBot: null, reason: 'WORLD_REVISION_CHANGED' }
    return { ...result, status, routeToBot: status === 'BLOCKED' ? false : status === 'REACHABLE' ? true : null, reason }
  }
  let initialRevision
  try { initialRevision = getWorldRevision() } catch {}
  if (initialRevision !== bound.worldRevision) return finish('UNKNOWN', 'WORLD_REVISION_CHANGED')
  if (at(start.x, start.y, start.z) !== 'air') return finish('UNKNOWN', 'ACTOR_CELL_UNCONFIRMED')
  add(start)
  for (let i = 0; i < queue.length; i++) {
    if (result.truncated) return finish('UNKNOWN', result.reason)
    if (!Number.isFinite(clock()) || clock() - began > maxMs) { result.truncated = true; return finish('UNKNOWN', 'TIME_LIMIT') }
    const p = queue[i]
    if (Math.hypot(p.x + 0.5 - feet.x, p.y - feet.y, p.z + 0.5 - feet.z) <= 3) return finish('REACHABLE', 'GROUND_ACCESS_FOUND')
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      if (!dx && !dy && !dz) continue
      const next = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
      if (at(next.x, next.y, next.z) === 'air') add(next)
    }
  }
  if (result.truncated) return finish('UNKNOWN', result.reason)
  if (result.unknownTouched) return finish('UNKNOWN', result.reason)
  if (result.boundaryTouched) return finish('UNKNOWN', 'OPEN_SEARCH_BOUNDARY')
  return finish('BLOCKED', 'CLOSED_KNOWN_DRY_COMPONENT')
}

module.exports = { proveGroundAccess, isCurrentBlockedGroundProof }
