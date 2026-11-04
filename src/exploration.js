'use strict'

// Pure endpoint selection over received observations. A target is not a path:
// the runner must still ask the live movement planner before sending inputs.
const SUPPORT = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FALLING = new Set(['sand','red_sand','gravel'])
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone|sand$|gravel$|concrete_powder$|anvil$)/
const finite = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const pointKey = point => `${point.x},${point.y},${point.z}`
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const spatial = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const copy = value => structuredClone(value)
const MAX_TRANSIT_REVISITS = 4

function safeLayer (block) {
  return !block.extra?.some(extra => !AIR.has(nameOf(extra.name)))
}

function emptyBody (block) {
  return block?.known === true && !HAZARD.test(nameOf(block.name)) && safeLayer(block) && (AIR.has(nameOf(block.name)) || block.boundingBox === 'empty')
}

function knownStandpoints (state, observations = {}, { minDistance = 0, maxDistance = 12, maxHeightDelta = 3, limit = 400, readSupportBlock = null } = {}) {
  observations ??= {}
  if (!finite(state?.position) || !Number.isFinite(minDistance) || !Number.isFinite(maxDistance) || minDistance < 0 || maxDistance < minDistance || maxDistance > 12 || !Number.isFinite(maxHeightDelta) || maxHeightDelta < 0 || maxHeightDelta > 4 || !Number.isInteger(limit) || limit < 1 || limit > 2000) return []
  const suppliedBlocks = Array.isArray(observations.blocks) ? observations.blocks : observations.world?.blocks
  const blocks = Array.isArray(suppliedBlocks) ? suppliedBlocks : []
  const map = new Map(blocks.filter(block => finite(block.position) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(block.position[axis]))).map(block => [pointKey(block.position), block]))
  const fallingCache = new Map()
  const naturalFull = block => block?.known === true && block.boundingBox === 'block' && !block.protected && !block.protectionSource && block.natural !== false && block.playerPlaced !== true && !block.extra?.length && (!Array.isArray(block.shapes) || block.shapes.length === 1 && Array.isArray(block.shapes[0]) && block.shapes[0].length === 6 && block.shapes[0].every((value,index)=>Math.abs(value-[0,0,0,1,1,1][index])<=1e-9))
  const stableFalling = support => {
    if (typeof readSupportBlock !== 'function' || !FALLING.has(nameOf(support?.name)) || !finite(support?.position)) return false
    const key=pointKey(support.position);if(fallingCache.has(key))return fallingCache.get(key)
    let stable=false
    try {
      const actual=readSupportBlock({...support.position})
      if (!naturalFull(actual) || actual.name!==support.name || support.runtimeId!=null && actual.runtimeId!==support.runtimeId) {fallingCache.set(key,false);return false}
      for(let depth=1;depth<=8;depth++){
        const below=readSupportBlock({...support.position,y:support.position.y-depth}),name=nameOf(below?.name)
        if(!naturalFull(below))break
        if(FALLING.has(name))continue
        stable=SUPPORT.has(name);break
      }
    } catch { stable=false }
    fallingCache.set(key,stable);return stable
  }
  const feetY = state.position.y - 1.62
  const result = []
  for (const support of map.values()) {
    if (support.known !== true || !(SUPPORT.has(nameOf(support.name)) || stableFalling(support)) || support.boundingBox !== 'block' || !safeLayer(support) || support.protected === true && support.protectionSource !== 'tunnel_floor') continue
    const p = support.position
    const position = { x: p.x + 0.5, y: p.y + 1, z: p.z + 0.5 }
    const distance = horizontal(state.position, position)
    if (distance < minDistance - 1e-6 || distance > maxDistance + 1e-6 || Math.abs(position.y - feetY) > maxHeightDelta + 1e-4) continue
    if (!emptyBody(map.get(pointKey({ x: p.x, y: p.y + 1, z: p.z }))) || !emptyBody(map.get(pointKey({ x: p.x, y: p.y + 2, z: p.z })))) continue
    let unsafeNeighbour = false
    let frontierUnknown = 0
    let safeNeighbours = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbour = map.get(pointKey({ x: p.x + dx, y: p.y, z: p.z + dz }))
      const body = map.get(pointKey({ x: p.x + dx, y: p.y + 1, z: p.z + dz }))
      if (neighbour?.known && HAZARD.test(nameOf(neighbour.name)) && !stableFalling(neighbour) || body?.known && HAZARD.test(nameOf(body.name))) unsafeNeighbour = true
      if (neighbour?.known && (SUPPORT.has(nameOf(neighbour.name)) || stableFalling(neighbour)) && emptyBody(body)) safeNeighbours++
      for (const step of [1, 2]) {
        const probe = map.get(pointKey({ x: p.x + dx * step, y: p.y + 1, z: p.z + dz * step }))
        if (probe?.known !== true) frontierUnknown++
      }
    }
    if (unsafeNeighbour) continue
    result.push({ position, distance, heightDelta: position.y - feetY, frontierUnknown, safeNeighbours, support: support.name })
  }
  return result.sort((a, b) => b.distance - a.distance || Math.abs(a.heightDelta) - Math.abs(b.heightDelta) || a.position.x - b.position.x || a.position.z - b.position.z).slice(0, limit)
}

function rankExplorationTargets (state, observations = {}, { history = [], resource = null, attempt = 1, limit = 20, transitBudget = MAX_TRANSIT_REVISITS, readSupportBlock = null } = {}) {
  const origin = state?.position
  if (!finite(origin)) return []
  observations ??= {}
  const visited = (Array.isArray(history) ? history : []).filter(entry => finite(entry?.position))
  const nearHistory = (entry, point, radius) => Math.abs(entry.position.y - point.y) < 0.75 && horizontal(entry.position, point) < radius
  const blocked = point => visited.some(entry => ['blocked', 'attempt'].includes(entry.kind) && nearHistory(entry, point, 1.5))
  const visitsAt = point => visited.filter(entry => nearHistory(entry, point, 0.75)).reduce((sum, entry) => sum + (Number.isSafeInteger(entry.visitCount) && entry.visitCount > 0 ? entry.visitCount : ['visited', 'origin'].includes(entry.kind) ? 1 : 0), 0)
  const usedRevisits = visited.reduce((sum, entry) => sum + Math.max(0, (entry.visitCount ?? 1) - 1), 0)
  const remainingTransits = Math.min(Number.isSafeInteger(transitBudget) ? Math.max(0, transitBudget) : 0, Math.max(0, MAX_TRANSIT_REVISITS - usedRevisits))
  const maximum = Math.min(20, Number.isInteger(limit) && limit > 0 ? limit : 20)
  const latest = [...visited].reverse().find(entry => entry.kind === 'visited' && finite(entry.from))
  const yaw = state.predicted?.physicsState?.yaw ?? state.rotation?.yaw ?? 0
  let heading = latest ? { x: latest.position.x - latest.from.x, z: latest.position.z - latest.from.z } : { x: -Math.sin(yaw * Math.PI / 180), z: Math.cos(yaw * Math.PI / 180) }
  const length = Math.hypot(heading.x, heading.z) || 1
  heading = { x: heading.x / length, z: heading.z / length }
  if (!latest && Number.isSafeInteger(attempt) && attempt > 1) {
    // A failed action (or a reload with no local history) must not always
    // select the same sector. Successful travel instead retains its heading.
    const angle = (attempt - 1) * Math.PI * (3 - Math.sqrt(5))
    heading = { x: heading.x * Math.cos(angle) - heading.z * Math.sin(angle), z: heading.x * Math.sin(angle) + heading.z * Math.cos(angle) }
  }
  const center = observations.center ?? { x: Math.floor(origin.x), z: Math.floor(origin.z) }
  const radius = Number.isFinite(observations.radius) ? observations.radius : 12
  const primary = knownStandpoints(state, observations, { minDistance: 8, maxDistance: 11, maxHeightDelta: 3, limit: 1000, readSupportBlock })
    .filter(candidate => !visited.some(entry => nearHistory(entry, candidate.position, entry.kind === 'blocked' || entry.kind === 'attempt' ? 1.5 : 3)))
    .map(candidate => {
      const dx = candidate.position.x - origin.x
      const dz = candidate.position.z - origin.z
      const forward = (dx * heading.x + dz * heading.z) / candidate.distance
      const edge = Math.max(Math.abs(candidate.position.x - 0.5 - center.x), Math.abs(candidate.position.z - 0.5 - center.z))
      const edgeWeight = 1 / (1 + Math.abs(radius - edge))
      return { ...candidate, resource, attempt, score: edgeWeight * 4 + candidate.frontierUnknown * 0.1 + candidate.safeNeighbours * 0.08 + forward * 0.6 + candidate.distance * 0.025 - Math.abs(candidate.heightDelta) * 0.3 }
    })
    .sort((a, b) => b.score - a.score || a.position.x - b.position.x || a.position.z - b.position.z)
    .slice(0, maximum)
  if (primary.length) return primary

  // A high bank or exhausted outer ring can require a shorter land endpoint.
  // These remain endpoints only: navigation must prove the real path, and a
  // failed read-only preview is still recorded as blocked before another try.
  const intermediate = knownStandpoints(state, observations, { minDistance: 2, maxDistance: 6, maxHeightDelta: 3, limit: 1000, readSupportBlock })
  const onward = knownStandpoints(state, observations, { minDistance: 1, maxDistance: 12, maxHeightDelta: 4, limit: 2000, readSupportBlock })
  return intermediate.filter(candidate => !blocked(candidate.position)).flatMap(candidate => {
    const priorVisits = visitsAt(candidate.position)
    let next = null
    if (priorVisits > 0) {
      if (priorVisits >= 2 || remainingTransits <= 0) return []
      // Returning over known ground is useful only when it exposes a separate
      // unvisited onward endpoint. Pure A <-> B reversal cannot satisfy this.
      next = onward.find(point => {
        const leg = horizontal(point.position, candidate.position)
        return leg >= 2 && leg <= 6 && Math.abs(point.position.y - candidate.position.y) <= 3 &&
          (point.distance >= candidate.distance + 1 || point.position.y >= candidate.position.y + 1) &&
          !blocked(point.position) && visitsAt(point.position) === 0
      })
      if (!next) return []
    }
    const dx = candidate.position.x - origin.x
    const dz = candidate.position.z - origin.z
    const forward = (dx * heading.x + dz * heading.z) / candidate.distance
    const uphill = Math.max(0, candidate.heightDelta)
    const score = uphill * 1.2 + candidate.frontierUnknown * 0.15 + candidate.safeNeighbours * 0.1 + forward * 0.6 + candidate.distance * 0.05 - priorVisits * 2
    return [{ ...candidate, resource, attempt, score, mode: priorVisits ? 'transit' : 'intermediate', requiresLivePreview: true, priorVisits, ...(next ? { onward: { ...next.position } } : {}) }]
  }).sort((a, b) => b.score - a.score || a.position.x - b.position.x || a.position.z - b.position.z).slice(0, maximum)
}

function rankRetreatTargets (state, observations = {}, threats = [], { limit = 20 } = {}) {
  const enemies = threats.filter(threat => threat.hostile !== false && threat.alive !== false && finite(threat.position))
  if (!finite(state?.position) || !enemies.length) return []
  const currentNearest = Math.min(...enemies.map(enemy => spatial(state.position, enemy.position)))
  return knownStandpoints(state, observations, { minDistance: 3, maxDistance: 6, maxHeightDelta: 3, limit: 1000 })
    .map(candidate => {
      const eye = { ...candidate.position, y: candidate.position.y + 1.62 }
      const nearest = Math.min(...enemies.map(enemy => spatial(eye, enemy.position)))
      return { ...candidate, nearestThreatDistance: nearest, threatDistanceGain: nearest - currentNearest, score: (nearest - currentNearest) * 3 + candidate.safeNeighbours * 0.1 - Math.abs(candidate.heightDelta) * 0.2 }
    })
    .filter(candidate => candidate.threatDistanceGain >= 0.5)
    .sort((a, b) => b.score - a.score || b.distance - a.distance || a.position.x - b.position.x || a.position.z - b.position.z)
    .slice(0, Math.min(20, Number.isInteger(limit) && limit > 0 ? limit : 20))
}

function createExploration ({ historyLimit = 80, historyTtlMs = 600000, clock = Date.now, readSupportBlock = null } = {}) {
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 500 || !Number.isFinite(historyTtlMs) || historyTtlMs < 1000 || typeof clock !== 'function' || readSupportBlock !== null && typeof readSupportBlock !== 'function') throw new Error('Invalid exploration history limits')
  let scope = null
  let history = []
  let transitRevisits = 0
  function updateScope (state) {
    const next = `${state.realm?.id ?? state.realm?.name ?? 'realm'}:${state.dimension ?? 'dimension'}:${state.profile ?? 'profile'}`
    if (scope !== next) { scope = next; history = []; transitRevisits = 0 }
    const time = clock()
    history = history.filter(entry => time - entry.at <= historyTtlMs)
  }
  function remember (state, position, details = {}) {
    if (!finite(position)) throw new Error('Exploration history requires a finite standpoint')
    updateScope(state)
    const kind = ['origin', 'attempt', 'blocked', 'visited'].includes(details.kind) ? details.kind : 'attempt'
    const existing = history.find(entry => Math.floor(entry.position.x) === Math.floor(position.x) && Math.floor(entry.position.z) === Math.floor(position.z) && Math.abs(entry.position.y - position.y) < 0.5)
    const previousVisits = existing?.visitCount ?? (existing && ['visited', 'origin'].includes(existing.kind) ? 1 : 0)
    if (existing) {
      if (existing.kind === 'visited' && kind === 'origin') { existing.at = clock(); return }
      history = history.filter(entry => entry !== existing)
    }
    if (kind === 'visited' && previousVisits > 0) transitRevisits++
    const visitCount = kind === 'visited' ? previousVisits + 1 : kind === 'origin' ? Math.max(1, previousVisits) : previousVisits
    history.push({ position: { x: position.x, y: position.y, z: position.z }, kind, visitCount, at: clock(), resource: details.resource ?? null, outcome: details.outcome ?? null, serverConfirmed: details.serverConfirmed === true, ...(finite(details.from) ? { from: { x: details.from.x, y: details.from.y, z: details.from.z } } : {}) })
    while (history.length > historyLimit) history.shift()
  }
  function candidates (state, observations, options = {}) {
    updateScope(state)
    return rankExplorationTargets(state, observations, { ...options, history, transitBudget: Math.max(0, MAX_TRANSIT_REVISITS - transitRevisits), readSupportBlock:readSupportBlock ? position=>readSupportBlock(position,state) : null })
  }
  return { candidates, remember, snapshot: () => ({ scope, history: copy(history), limit: historyLimit, historyTtlMs, transitRevisits, maxTransitRevisits: MAX_TRANSIT_REVISITS }) }
}

module.exports = { knownStandpoints, rankExplorationTargets, rankRetreatTargets, createExploration }
