'use strict'

// Reuse World's live request builder, including its announced-column,
// received-section and five-second pending suppression. This module only
// dispatches bounded read requests; it never marks terrain as received.
const { normalizeChunks, chunkBounds } = require('./quarry-region')
const copy = value => structuredClone(value)
const DIMENSIONS = ['overworld', 'nether', 'end']
const WORLD_BOUNDS = { overworld: [-64, 319], nether: [0, 127], end: [0, 255] }
const dimensionName = value => DIMENSIONS[value] ?? value
const failure = reason => Object.assign(new Error(reason), { code: reason })
const scopeOf = s => JSON.stringify([s.profile ?? null, String(s.realm?.id ?? ''), s.connectionId ?? null, s.startedAt ?? null, dimensionName(s.dimension), String(s.runtimeEntityId ?? ''), s.lifecycle?.deathId ?? null])

function buildQuarryTerrainPlan ({ config, yTop, yBottom, dimension = config?.dimension } = {}, { maxPackets = 32 } = {}) {
  const name = dimensionName(dimension)
  if (!WORLD_BOUNDS[name] || config?.dimension != null && dimensionName(config.dimension) !== name) throw failure('TERRAIN_DIMENSION_MISMATCH')
  if (!Number.isSafeInteger(maxPackets) || maxPackets < 1 || maxPackets > 64) throw failure('TERRAIN_PACKET_LIMIT_INVALID')
  const target = config?.target
  if (Array.isArray(target?.chunks) && target.chunks.length > 64) throw failure('TERRAIN_TARGET_TOO_LARGE')
  if (target?.rect) {
    const r = target.rect
    if (![r.x1, r.x2, r.z1, r.z2].every(Number.isSafeInteger) || (Math.abs(r.x2 - r.x1) + 1) * (Math.abs(r.z2 - r.z1) + 1) > 64) throw failure('TERRAIN_TARGET_TOO_LARGE')
  }
  const chunks = normalizeChunks(target)
  for (const c of chunks) {
    const b = chunkBounds(c)
    if (b.xMin < -30000000 || b.xMax > 30000000 || b.zMin < -30000000 || b.zMax > 30000000) throw failure('TERRAIN_OUTSIDE_WORLD_BORDER')
  }
  const native = WORLD_BOUNDS[name]
  const configuredMin = config.worldMinY ?? native[0], configuredMax = config.worldMaxY ?? native[1]
  if (![configuredMin, configuredMax].every(Number.isSafeInteger) || configuredMin > configuredMax) throw failure('TERRAIN_WORLD_BOUNDS_INVALID')
  const worldMinY = Math.max(native[0], configuredMin), worldMaxY = Math.min(native[1], configuredMax)
  const bottom = yBottom ?? config.yBottom
  const actualBottom = bottom === 'world_min' || bottom == null ? worldMinY : bottom
  const actualTop = yTop ?? config.yTop
  if (![actualBottom, actualTop].every(Number.isSafeInteger) || actualBottom < worldMinY || actualTop > worldMaxY || actualBottom > actualTop) throw failure('TERRAIN_HEIGHT_RANGE_INVALID')
  const yMin = Math.max(worldMinY, actualBottom - 1), yMax = Math.min(worldMaxY, actualTop + 18)
  const sectionMin = Math.floor(yMin / 16), sectionMax = Math.floor(yMax / 16)
  const probes = []
  for (let sectionY = sectionMin; sectionY <= sectionMax; sectionY++) for (const chunk of chunks) {
    probes.push({ position: { x: chunk.x * 16 + 8, y: sectionY * 16 + 8, z: chunk.z * 16 + 8 }, origin: { x: chunk.x, y: sectionY, z: chunk.z } })
  }
  if (probes.length > maxPackets) throw failure('TERRAIN_TARGET_TOO_LARGE')
  return { dimension: DIMENSIONS.indexOf(name), dimensionName: name, chunks, yMin, yMax, sectionMin, sectionMax, probes }
}

function createQuarryTerrainRequester ({ client, getState, world, intervalMs = 200, maxPackets = 32, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof world?.buildSubchunkRequest !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') throw new Error('Terrain requests require live client, state and World request builder')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 1000 || !Number.isSafeInteger(maxPackets) || maxPackets < 1 || maxPackets > 64) throw new Error('Invalid terrain request bounds')
  let busy = false
  let last = null
  async function request (options, { signal } = {}) {
    if (busy) return { requested: false, serverConfirmed: false, reason: 'TERRAIN_REQUEST_BUSY', requests: [], packets: 0, sectionRequests: 0 }
    busy = true
    const requests = []
    let plan = null, originScope = null, lastSentAt = null, probesVisited = 0
    const result = (reason = null) => ({ requested: requests.length > 0, serverConfirmed: false, ...(reason ? { reason } : {}), dispatchCompleted: reason === null, packets: requests.length, sectionRequests: requests.reduce((n, p) => n + p.requests.length, 0), requests: copy(requests), probesVisited, ...(plan ? { sectionRange: { min: plan.sectionMin, max: plan.sectionMax }, blockRange: { min: plan.yMin, max: plan.yMax }, dimension: plan.dimensionName, scope: originScope } : {}) })
    const check = () => {
      if (signal?.aborted) throw failure('TERRAIN_REQUEST_ABORTED')
      const s = getState(), life = s.lifecycle?.deathId
      if (s.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || s.spawnPending || !(s.health > 0)) throw failure('TERRAIN_NOT_ALIVE')
      if (typeof s.profile !== 'string' || !s.profile || s.realm?.id == null || typeof s.connectionId !== 'string' || !s.connectionId || typeof s.startedAt !== 'string' || !s.startedAt || !/^[1-9]\d*$/.test(String(s.runtimeEntityId ?? '')) || !Number.isSafeInteger(life) || life < 0 || !WORLD_BOUNDS[dimensionName(s.dimension)]) throw failure('TERRAIN_SCOPE_UNKNOWN')
      const current = scopeOf(s)
      if (originScope === null) originScope = current
      else if (current !== originScope) throw failure('TERRAIN_SCOPE_CHANGED')
      return s
    }
    try {
      const s = check()
      plan = buildQuarryTerrainPlan({ ...options, dimension: s.dimension }, { maxPackets })
      for (const probe of plan.probes) {
        check()
        if (lastSentAt != null && now() - lastSentAt < intervalMs) { await sleep(intervalMs - Math.max(0, now() - lastSentAt)); check() }
        // World uses vec3i8 offsets {x,y,z}, not the response's {dx,dy,dz}.
        const candidate = world.buildSubchunkRequest(probe.position, { horizontalRadius: 1, verticalRadius: 0 })
        probesVisited++
        if (!candidate) continue
        if (candidate.dimension !== plan.dimension || !candidate.origin || ['x', 'y', 'z'].some(k => candidate.origin[k] !== probe.origin[k]) || !Array.isArray(candidate.requests) || candidate.requests.length > 9) throw failure('TERRAIN_BUILDER_PACKET_INVALID')
        const seen = new Set(), offsets = []
        for (const offset of candidate.requests) {
          if (!Number.isInteger(offset.x) || !Number.isInteger(offset.y) || !Number.isInteger(offset.z) || Math.abs(offset.x) > 1 || offset.y !== 0 || Math.abs(offset.z) > 1) throw failure('TERRAIN_BUILDER_OFFSET_INVALID')
          const id = `${offset.x},${offset.y},${offset.z}`
          if (seen.has(id)) throw failure('TERRAIN_BUILDER_OFFSET_INVALID')
          seen.add(id)
          const b = chunkBounds({ x: candidate.origin.x + offset.x, z: candidate.origin.z + offset.z })
          if (b.xMin < -30000000 || b.xMax > 30000000 || b.zMin < -30000000 || b.zMax > 30000000) continue
          offsets.push({ x: offset.x, y: 0, z: offset.z })
        }
        if (!offsets.length) continue
        check()
        const packet = { dimension: plan.dimension, origin: copy(probe.origin), requests: offsets }
        client.queue('subchunk_request', packet)
        lastSentAt = now()
        requests.push({ ...copy(packet), queuedAt: lastSentAt })
      }
      last = result(); return copy(last)
    } catch (error) { last = result(error.code ?? error.message); return copy(last) } finally { busy = false }
  }
  return { request, snapshot: () => ({ busy, lastResult: copy(last) }) }
}

module.exports = { buildQuarryTerrainPlan, createQuarryTerrainRequester }
