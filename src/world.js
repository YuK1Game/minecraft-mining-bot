'use strict'

// Limited, read-only Bedrock runtime-palette decoding. Never substitute air for
// an unknown ID. Format references: PrismarineJS/prismarine-chunk's Bedrock
// SubChunk and PalettedStorage implementations; minecraft-data packet schemas.

function readRuntimeSection (buffer, start = 0, fallbackY = 0) {
  let offset = start
  const byte = () => {
    if (offset >= buffer.length) throw new Error('Truncated subchunk')
    return buffer[offset++]
  }
  const unsignedVarint = () => {
    let value = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      const next = byte()
      if (shift === 28 && (next & 0xf0)) throw new Error('Invalid 32-bit palette varint')
      value |= (next & 0x7f) << shift
      if (!(next & 0x80)) return value >>> 0
    }
    throw new Error('Invalid palette varint')
  }
  const signedVarint = () => {
    const value = unsignedVarint()
    return (value >>> 1) ^ -(value & 1)
  }
  const version = byte()
  if (version !== 8 && version !== 9) throw new Error(`Unsupported subchunk version ${version}`)
  const storageCount = byte()
  if (storageCount > 2) throw new Error('Unsupported storage layer count')
  let y = fallbackY
  if (version === 9) {
    y = byte()
    if (y > 127) y -= 256
  }
  const layers = []
  for (let layer = 0; layer < storageCount; layer++) {
    const header = byte()
    if (!(header & 1)) throw new Error('Persistent palettes are not supported')
    const bits = header >>> 1
    if (![0, 1, 2, 3, 4, 5, 6, 8, 16].includes(bits)) throw new Error(`Unsupported palette bit width ${bits}`)
    if (bits === 0) {
      layers.push({ bits, palette: [signedVarint()], words: null })
      continue
    }
    const perWord = Math.floor(32 / bits)
    const wordCount = Math.ceil(4096 / perWord)
    if (offset + wordCount * 4 > buffer.length) throw new Error('Truncated paletted blocks')
    const words = new Uint32Array(wordCount)
    for (let i = 0; i < wordCount; i++) words[i] = buffer.readUInt32LE(offset + i * 4)
    offset += wordCount * 4
    const paletteSize = signedVarint()
    if (paletteSize < 1 || paletteSize > 4096 || paletteSize > (1 << bits)) throw new Error('Invalid palette size')
    const palette = []
    for (let i = 0; i < paletteSize; i++) palette.push(signedVarint())
    layers.push({ bits, palette, words })
  }
  return { y, layers, offset }
}

function dimensionName (dimension) {
  return ['overworld', 'nether', 'end'][dimension] ?? dimension
}

function createWorld ({ version = '1.26.60', registry, maxSections = 512 } = {}) {
  if (!registry) registry = require('prismarine-registry')(`bedrock_${version}`)
  let revision = 0
  // Only packets that change received terrain bump it; derived caches (terrain
  // evidence, reachability cells) would otherwise reset on every entity move.
  const WORLD_PACKETS = new Set(['start_game', 'change_dimension', 'respawn', 'level_chunk', 'subchunk', 'update_block', 'update_subchunk_blocks', 'update_block_synced', 'block_entity_data'])
  const sections = new Map()
  const columns = new Set()
  const pending = new Map()
  // Survey history is separate from pending so failed/expired outer requests
  // cannot monopolize a batch or delay the normal nearby movement requests.
  const surveyHistory = new Map()
  const counters = { levelChunks: 0, subchunks: 0, subchunkSuccesses: 0, subchunkFailures: 0, blockUpdates: 0, decodeErrors: 0, skippedCached: 0 }
  let dimension = 'overworld'
  let initialized = false
  let mappingIssue = null
  let lastError = null
  let airRuntimeId = null
  const key = (x, y, z) => `${x},${y},${z}`
  function remember (x, y, z, section) {
    const id = key(x, y, z)
    sections.delete(id)
    sections.set(id, { ...section, updates: section.updates ?? new Map() })
    if (section.complete) surveyHistory.delete(id)
    while (sections.size > maxSections) sections.delete(sections.keys().next().value)
  }
  function subchunkResult (id, success) {
    if (success) { counters.subchunkSuccesses++; return }
    counters.subchunkFailures++
    const attempt = surveyHistory.get(id)
    if (!attempt) return
    attempt.failures = Math.min(attempt.failures + 1, 4)
    attempt.retryAfter = Date.now() + Math.min(30000, 5000 * 2 ** (attempt.failures - 1))
  }
  function resolve (runtimeId) {
    const entry = registry.blocksByRuntimeId?.[runtimeId] ?? registry.blocksByRuntimeId?.[runtimeId | 0]
    if (!entry) return null
    const blockState = registry.blockStates?.[entry.stateId]
    if (!blockState) return null
    return {
      name: blockState.name.startsWith('minecraft:') ? blockState.name : `minecraft:${blockState.name}`,
      runtimeId: runtimeId >>> 0,
      properties: Object.fromEntries(Object.entries(blockState.states ?? {}).map(([name, value]) => [name, value?.value ?? value])),
      boundingBox: entry.boundingBox ?? null,
      hardness: entry.hardness ?? null,
      diggable: entry.diggable ?? false
    }
  }
  function findAir () {
    for (const [runtimeId, entry] of Object.entries(registry.blocksByRuntimeId ?? {})) {
      if (entry.name === 'air' || entry.name === 'minecraft:air') return Number(runtimeId)
    }
    return null
  }
  function fail (error) {
    counters.decodeErrors++
    lastError = String(error.message).slice(0, 160)
  }
  function clearColumn (x, z) {
    for (const id of sections.keys()) {
      const [sx, , sz] = id.split(',').map(Number)
      if (sx === x && sz === z) sections.delete(id)
    }
    for (const id of pending.keys()) {
      const [sx, , sz] = id.split(',').map(Number)
      if (sx === x && sz === z) pending.delete(id)
    }
  }
  function updateBlock (packet) {
    const position = packet.position
    if (!position || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]))) return
    if (packet.layer !== 0 && packet.layer !== 1) return
    const x = Math.floor(position.x / 16)
    const y = Math.floor(position.y / 16)
    const z = Math.floor(position.z / 16)
    const id = key(x, y, z)
    let section = sections.get(id)
    if (!section) {
      remember(x, y, z, { complete: false, layers: [] })
      section = sections.get(id)
    }
    const index = ((position.x & 15) << 8) | ((position.z & 15) << 4) | (position.y & 15)
    if (!section.updates.has(index)) section.updates.set(index, new Map())
    section.updates.get(index).set(packet.layer, packet.block_runtime_id)
    counters.blockUpdates++
  }
  function applyPacket (name, packet) {
    // Any applied world packet may change received blocks; derived caches key
    // on this revision so they never outlive a block change.
    if (WORLD_PACKETS.has(name)) revision++
    if (name === 'start_game') {
      sections.clear()
      columns.clear()
      pending.clear()
      surveyHistory.clear()
      dimension = dimensionName(packet.dimension)
      initialized = false
      mappingIssue = null
      // A custom sequential palette may shift every vanilla runtime ID. The
      // registry does not merge these entries, so even apparently vanilla IDs
      // must remain unknown in this configuration.
      if (!packet.block_network_ids_are_hashes && packet.block_properties?.length) {
        mappingIssue = 'custom_sequential_palette_unsupported'
        return
      }
      // Newer versions send the item registry separately. Only block mappings
      // are used here, so an empty item list is intentional.
      registry.handleStartGame({ ...packet, itemstates: packet.itemstates ?? [] })
      initialized = true
      airRuntimeId = findAir()
      return
    }
    if (name === 'change_dimension') {
      sections.clear()
      columns.clear()
      pending.clear()
      surveyHistory.clear()
      dimension = dimensionName(packet.dimension)
      return
    }
    if (!initialized) return
    if (packet.dimension != null && dimensionName(packet.dimension) !== dimension) return
    if (name === 'level_chunk') {
      counters.levelChunks++
      clearColumn(packet.x, packet.z)
      columns.add(`${packet.x},${packet.z}`)
      while (columns.size > maxSections) columns.delete(columns.values().next().value)
      if (packet.cache_enabled) { counters.skippedCached++; return }
      // -1/-2 are unsigned varint sentinels on newer protocol definitions.
      const count = packet.sub_chunk_count
      if (count < 0 || count >= 0xfffffffe) return
      if (!Number.isInteger(count) || count > 64) { fail(new Error('Invalid subchunk count')); return }
      let offset = 0
      const parsed = []
      try {
        for (let index = 0; index < count; index++) {
          const section = readRuntimeSection(packet.payload, offset, (dimension === 'overworld' ? -4 : 0) + index)
          parsed.push(section)
          offset = section.offset
        }
        for (const section of parsed) remember(packet.x, section.y, packet.z, { complete: true, layers: section.layers })
      } catch (error) { fail(error) }
    } else if (name === 'subchunk') {
      for (const entry of packet.entries ?? []) {
        const x = packet.origin.x + entry.dx
        const y = packet.origin.y + entry.dy
        const z = packet.origin.z + entry.dz
        const id = key(x, y, z)
        sections.delete(id)
        pending.delete(id)
        counters.subchunks++
        if (entry.result === 'success_all_air') {
          if (airRuntimeId !== null) remember(x, y, z, { complete: true, layers: [{ bits: 0, palette: [airRuntimeId], words: null }] })
          subchunkResult(id, airRuntimeId !== null)
          continue
        }
        if (entry.result !== 'success') { subchunkResult(id, false); continue }
        if (packet.cache_enabled) { counters.skippedCached++; subchunkResult(id, false); continue }
        try {
          const section = readRuntimeSection(entry.payload, 0, y)
          if (section.y !== y) throw new Error('Subchunk Y coordinate mismatch')
          remember(x, y, z, { complete: true, layers: section.layers })
          subchunkResult(id, true)
        } catch (error) { fail(error); subchunkResult(id, false) }
      }
    } else if (name === 'update_block') {
      updateBlock(packet)
    } else if (name === 'update_subchunk_blocks') {
      for (const entry of packet.blocks ?? []) updateBlock({ ...entry, block_runtime_id: entry.runtime_id, layer: 0 })
      for (const entry of packet.extra ?? []) updateBlock({ ...entry, block_runtime_id: entry.runtime_id, layer: 1 })
    }
  }
  function getBlock (x, y, z) {
    const position = { x, y, z }
    const unknown = (reason, runtimeId = null) => ({ known: false, position, name: null, runtimeId, properties: null, reason })
    if (![x, y, z].every(Number.isSafeInteger)) return unknown('invalid_position')
    if (!initialized) return unknown(mappingIssue ?? 'world_not_initialized')
    const section = sections.get(key(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)))
    if (!section?.complete) return unknown('subchunk_not_received')
    const index = ((x & 15) << 8) | ((z & 15) << 4) | (y & 15)
    const updates = section.updates.get(index)
    const layers = []
    for (let layer = 0; layer < Math.max(2, section.layers.length); layer++) {
      let runtimeId = updates?.get(layer)
      const storage = section.layers[layer]
      if (runtimeId === undefined) {
        if (!storage) runtimeId = airRuntimeId
        else if (storage.bits === 0) runtimeId = storage.palette[0]
        else {
          const perWord = Math.floor(32 / storage.bits)
          const paletteIndex = (storage.words[Math.floor(index / perWord)] >>> ((index % perWord) * storage.bits)) & ((1 << storage.bits) - 1)
          runtimeId = storage.palette[paletteIndex]
        }
      }
      if (runtimeId == null) return unknown('unknown_palette_entry')
      const block = resolve(runtimeId)
      if (!block) return unknown('unknown_runtime_id', runtimeId >>> 0)
      layers.push(block)
    }
    return { known: true, position, ...layers[0], extra: layers.slice(1).filter(block => block.name !== 'minecraft:air') }
  }
  function getArea (center, radius = 1) {
    if (!center || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(center[axis]))) throw new Error('center must contain integer block coordinates')
    if (!Number.isInteger(radius) || radius < 0 || radius > 3) throw new Error('radius must be an integer between 0 and 3')
    const blocks = []
    for (let x = center.x - radius; x <= center.x + radius; x++) {
      for (let y = center.y - radius; y <= center.y + radius; y++) {
        for (let z = center.z - radius; z <= center.z + radius; z++) blocks.push(getBlock(x, y, z))
      }
    }
    return blocks
  }
  // Produces a read-only network request, but never sends it. Call after spawn
  // and after level_chunk headers arrive; only announced columns are requested.
  // Repeated calls suppress in-flight sections for five seconds.
  function buildSubchunkRequest (position, { horizontalRadius = 1, verticalRadius = 1 } = {}) {
    if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) return null
    if (![0, 1].includes(horizontalRadius) || ![0, 1, 2].includes(verticalRadius)) throw new Error('Invalid subchunk request radius')
    const dimensionId = ['overworld', 'nether', 'end'].indexOf(dimension)
    if (!initialized || dimensionId < 0) return null
    const origin = { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) }
    const bounds = dimension === 'overworld' ? [-4, 19] : dimension === 'nether' ? [0, 7] : [0, 15]
    const requests = []
    const now = Date.now()
    for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
      for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
        const x = origin.x + dx
        const z = origin.z + dz
        if (!columns.has(`${x},${z}`)) continue
        for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
          const y = origin.y + dy
          if (y < bounds[0] || y > bounds[1]) continue
          const id = key(x, y, z)
          if (sections.get(id)?.complete || (pending.has(id) && now - pending.get(id) < 5000)) continue
          // Current minecraft-data uses vec3i8 {x,y,z}, not {dx,dy,dz}.
          requests.push({ x: dx, y: dy, z: dz })
          pending.set(id, now)
        }
      }
    }
    return requests.length ? { dimension: dimensionId, origin, requests } : null
  }

  // Survey farther announced columns in small batches. The normal movement
  // request above is deliberately unchanged. This function returns at most
  // one packet per call; the caller schedules later calls between input ticks.
  // Only the two possible sections around the observed surface/body height
  // are requested, without inferring terrain in any unreceived column.
  function buildSurfaceSurveyRequests (position, { horizontalRadius = 4, maxRequestsPerBatch = 12 } = {}) {
    if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis])) || Math.abs(position.x) > 30000000 || Math.abs(position.z) > 30000000 || position.y < -64 || position.y > 322) return []
    if (!Number.isInteger(horizontalRadius) || horizontalRadius < 2 || horizontalRadius > 4 || !Number.isInteger(maxRequestsPerBatch) || maxRequestsPerBatch < 1 || maxRequestsPerBatch > 12) throw new Error('Invalid surface survey request bounds')
    const dimensionId = ['overworld', 'nether', 'end'].indexOf(dimension)
    if (!initialized || dimensionId < 0) return []
    const origin = { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) }
    const bounds = dimension === 'overworld' ? [-4, 19] : dimension === 'nether' ? [0, 7] : [0, 15]
    const surfaceY = Math.ceil(position.y - 1.62)
    const levels = [...new Set([Math.floor((surfaceY - 1) / 16), Math.floor((surfaceY + 2) / 16)])].filter(y => y >= bounds[0] && y <= bounds[1])
    const candidates = []
    for (let ring = 2; ring <= horizontalRadius; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring || !columns.has(`${origin.x + dx},${origin.z + dz}`)) continue
        const distance = Math.hypot((origin.x + dx) * 16 + 8 - position.x, (origin.z + dz) * 16 + 8 - position.z)
        candidates.push({ ring, dx, dz, distance })
      }
    }
    candidates.sort((a, b) => a.ring - b.ring || a.distance - b.distance || a.dx - b.dx || a.dz - b.dz)
    const eligible = []; const now = Date.now()
    for (const candidate of candidates) for (const y of levels) {
      const id = key(origin.x + candidate.dx, y, origin.z + candidate.dz)
      if (sections.get(id)?.complete || pending.has(id) && now - pending.get(id) < 5000) continue
      const attempt = surveyHistory.get(id)
      if (attempt && now < attempt.retryAfter) continue
      eligible.push({ ...candidate, y, id, attemptedAt: attempt?.attemptedAt ?? -Infinity, order: eligible.length })
    }
    // Try unobserved sections first, then the oldest attempt. This also gives
    // farther columns a turn when a server never answers the nearest batch.
    eligible.sort((a, b) => a.attemptedAt === b.attemptedAt ? a.order - b.order : a.attemptedAt - b.attemptedAt)
    const requests = []
    for (const candidate of eligible.slice(0, maxRequestsPerBatch)) {
      const { id, y } = candidate
      requests.push({ x: candidate.dx, y: y - origin.y, z: candidate.dz })
      pending.set(id, now)
      const attempt = surveyHistory.get(id)
      surveyHistory.delete(id)
      surveyHistory.set(id, { attemptedAt: now, failures: attempt?.failures ?? 0, retryAfter: 0 })
      while (surveyHistory.size > maxSections) surveyHistory.delete(surveyHistory.keys().next().value)
    }
    return requests.length ? [{ dimension: dimensionId, origin, requests }] : []
  }
  return {
    applyPacket, getBlock, getArea, buildSubchunkRequest, buildSurfaceSurveyRequests, revision: () => revision,
    stats: () => ({ version, dimension, initialized, mappingIssue, loadedSections: [...sections.values()].filter(section => section.complete).length, cachedSections: sections.size, announcedColumns: columns.size, ...counters, lastError })
  }
}

module.exports = { createWorld, readRuntimeSection }
