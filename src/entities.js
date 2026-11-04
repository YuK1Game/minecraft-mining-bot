'use strict'

const { performance } = require('node:perf_hooks')

// An explicit potential-hostile list, never inferred from usernames, numeric
// actor IDs or another edition's registry. Some listed mobs can be neutral in
// particular conditions; keeping their type visible allows conservative avoidance.
const HOSTILES = new Set([
  'zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned',
  'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'silverfish', 'endermite', 'blaze', 'ghast',
  'guardian', 'elder_guardian', 'phantom', 'pillager', 'vindicator', 'evocation_illager',
  'ravager', 'vex', 'piglin_brute', 'hoglin', 'zoglin', 'warden', 'breeze', 'creaking',
  'wither', 'ender_dragon'
].map(name => `minecraft:${name}`))
const MOBS = new Set([...HOSTILES, ...[
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule', 'llama',
  'trader_llama', 'camel', 'goat', 'mooshroom', 'cat', 'ocelot', 'wolf', 'fox',
  'polar_bear', 'panda', 'bee', 'bat', 'parrot', 'allay', 'axolotl', 'dolphin',
  'turtle', 'squid', 'glow_squid', 'cod', 'salmon', 'tropicalfish', 'pufferfish',
  'villager', 'villager_v2', 'wandering_trader', 'iron_golem', 'snow_golem',
  'enderman', 'piglin', 'zombie_pigman', 'strider', 'frog', 'tadpole', 'sniffer', 'armadillo'
].map(name => `minecraft:${name}`)])

function normalizeId (value, signed = false) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !signed && value < 0) return null
    return String(value)
  }
  if (typeof value === 'bigint') return !signed && value < 0n ? null : String(value)
  if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null
  try { return String(BigInt(value)) } catch { return null }
}
function dimensionName (value) { return ['overworld', 'nether', 'end'][value] ?? value ?? null }
function entityName (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return null
  return value.includes(':') ? value : `minecraft:${value}`
}
function validPosition (value) { return value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) }

function createEntities ({ limit = 512, selfRuntimeId = null, clock = () => new Date().toISOString(), now = () => performance.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 65536) throw new Error('Entity cache limit must be an integer between 1 and 65536')
  const entities = new Map()
  const uniqueIds = new Map()
  const removed = new Map()
  const names = new Map()
  // Recent received positions per actor (monotonic ms), for motion estimates
  // such as bow lead. Kept off the snapshot so observed actor records stay as-is.
  const tracks = new Map()
  let ownRuntimeId = normalizeId(selfRuntimeId)
  let ownUniqueId = null
  let dimension = null
  let ignoredUpdates = 0
  let sequence = 0

  function forget (id) {
    const entity = entities.get(id)
    if (!entity) return
    entities.delete(id)
    tracks.delete(id)
    if (entity.uniqueId !== null && uniqueIds.get(entity.uniqueId) === id) uniqueIds.delete(entity.uniqueId)
  }
  function clear () { entities.clear(); uniqueIds.clear(); removed.clear(); tracks.clear(); sequence = 0 }
  function touch (entity) {
    entity.updatedAt = clock()
    entities.delete(entity.runtimeId)
    entities.set(entity.runtimeId, entity)
  }
  function setPosition (entity, position, source, partial = false) {
    if (!partial) entity.coordinates = { x: null, y: null, z: null }
    let received = false
    for (const axis of ['x', 'y', 'z']) {
      if (partial && position?.[axis] == null) continue
      received = true
      entity.coordinates[axis] = Number.isFinite(position?.[axis]) ? position[axis] : null
    }
    if (received) {
      entity.positionSource = source
      entity.positionUpdatedAt = clock()
    }
    entity.position = validPosition(entity.coordinates) ? { ...entity.coordinates } : null
    if (received && entity.position && entity.runtimeId != null) track(entity.runtimeId, entity.position)
  }
  function track (id, position) {
    const t = now()
    if (!Number.isFinite(t)) return
    const samples = tracks.get(id) ?? []
    const last = samples.at(-1)
    // Several axis-partial deltas in one tick collapse into one sample.
    if (last && t - last.t < 5) samples[samples.length - 1] = { t: last.t, position: { ...position } }
    else samples.push({ t, position: { ...position } })
    while (samples.length > 8) samples.shift()
    tracks.set(id, samples)
  }
  // Estimated actor velocity in blocks per 50ms tick from received positions.
  // Bedrock stops sending deltas for a resting actor, so a quiet actor is
  // reported as stationary. Teleport-sized jumps are not treated as motion.
  function motion (runtimeValue, { windowMs = 500, quietMs = 300, maxSpeed = 1.5 } = {}) {
    const id = normalizeId(runtimeValue)
    const samples = id === null ? null : tracks.get(id)
    if (!samples?.length) return null
    const t = now(); const latest = samples.at(-1)
    if (!Number.isFinite(t)) return null
    const ageMs = t - latest.t
    if (ageMs > quietMs || samples.length < 2) return { velocity: { x: 0, y: 0, z: 0 }, ageMs, samples: samples.length, stationary: true }
    const oldest = samples.find(s => latest.t - s.t <= windowMs && latest.t - s.t >= 40)
    if (!oldest) return { velocity: { x: 0, y: 0, z: 0 }, ageMs, samples: samples.length, stationary: true }
    const ticks = (latest.t - oldest.t) / 50
    const velocity = { x: (latest.position.x - oldest.position.x) / ticks, y: (latest.position.y - oldest.position.y) / ticks, z: (latest.position.z - oldest.position.z) / ticks }
    if (!(Math.hypot(velocity.x, velocity.y, velocity.z) <= maxSpeed)) return { velocity: { x: 0, y: 0, z: 0 }, ageMs, samples: samples.length, stationary: true, discarded: 'teleport' }
    return { velocity, ageMs, samples: samples.length, stationary: false }
  }
  function applyCreeperMetadata (entity, metadata, tick = null) {
    if (entity.entityType !== 'minecraft:creeper' || !Array.isArray(metadata)) return
    let incoming = null
    try { if (tick != null && BigInt(tick) > 0n) incoming = BigInt(tick) } catch { return }
    if (incoming !== null && entity.metadataTick != null && incoming < BigInt(entity.metadataTick)) return
    if (incoming !== null) entity.metadataTick = String(incoming)
    const order = (entity.metadataOrder ?? 0) + 1
    entity.metadataOrder = order
    let relevant = false
    for (const entry of metadata) {
      if ((entry?.key === 'flags' || entry?.key === 0) && entry.value && typeof entry.value === 'object') {
        const flags = entry.value
        if (typeof flags.ignited === 'boolean') { entity.ignited = flags.ignited; entity.ignitionOrder = order; relevant = true }
        if (flags.powered === true || flags.charged === true) entity.charged = true
        else if (flags.powered === false && flags.charged === false) entity.charged = false
      } else if ((entry?.key === 'fuse_length' || entry?.key === 55) && Number.isSafeInteger(entry.value) && entry.value >= -1 && entry.value <= 32767) {
        entity.fuseLength = entry.value; entity.fuseOrder = order; relevant = true
      }
    }
    // Bedrock can leave a positive fuse value after sending an unlit flag.
    // A later unlit observation supersedes the old counter, but a later
    // positive counter after spawn may reveal a fuse before the flag arrives.
    // A zero counter remains dangerous unless an explicit unlit flag exists.
    const positiveFuse = Number.isInteger(entity.fuseLength) && entity.fuseLength > 0 && (entity.ignited !== false || (entity.fuseOrder ?? 0) >= (entity.ignitionOrder ?? 0))
    if (relevant) entity.primed = entity.ignited === true || positiveFuse || entity.fuseLength === 0 && entity.ignited !== false
  }
  function remember (packet, kind, type, runtimeValue, uniqueValue) {
    const runtimeId = normalizeId(runtimeValue)
    const uniqueId = normalizeId(uniqueValue, true)
    if (runtimeId === null) { ignoredUpdates++; return }
    removed.delete(runtimeId)
    if (uniqueId !== null) for (const [id, entry] of removed) if (entry.uniqueId === uniqueId) removed.delete(id)
    if (runtimeId === ownRuntimeId || uniqueId !== null && uniqueId === ownUniqueId) return
    if (uniqueId !== null && uniqueIds.has(uniqueId)) forget(uniqueIds.get(uniqueId))
    forget(runtimeId)
    const entity = {
      runtimeId, uniqueId, kind, entityType: type, dimension, ordinal: ++sequence,
      hostile: kind !== 'player' && HOSTILES.has(type),
      hostility: kind === 'player' || kind === 'item' ? 'not_hostile' : HOSTILES.has(type) ? 'hostile' : 'unclassified',
      username: kind === 'player' && typeof packet.username === 'string' ? packet.username : null,
      networkId: kind === 'item' ? packet.item?.network_id ?? null : null,
      count: kind === 'item' ? packet.item?.count ?? null : null,
      position: null, coordinates: { x: null, y: null, z: null },
      positionSource: null, positionUpdatedAt: null, alive: true,
      lastEvent: null, hurtAt: null, updatedAt: clock()
    }
    setPosition(entity, packet.position, kind === 'item' ? 'add_item_entity' : kind === 'player' ? 'add_player' : 'add_entity')
    applyCreeperMetadata(entity, packet.metadata)
    entities.set(runtimeId, entity)
    if (uniqueId !== null) uniqueIds.set(uniqueId, runtimeId)
    while (entities.size > limit) forget(entities.keys().next().value)
  }
  function movement (runtimeValue, position, source, partial = false) {
    const id = normalizeId(runtimeValue)
    const entity = id === null ? null : entities.get(id)
    if (!entity) { ignoredUpdates++; return }
    setPosition(entity, position, source, partial)
    touch(entity)
  }
  // Bumped by everything that can change the tracked entities, so readers can
  // reuse a snapshot until it changes.
  let version = 0
  function applyPacket (name, packet) {
    version++
    if (name === 'start_game') {
      clear(); names.clear()
      ownRuntimeId = normalizeId(packet.runtime_entity_id)
      ownUniqueId = normalizeId(packet.entity_id, true)
      dimension = dimensionName(packet.dimension)
      ignoredUpdates = 0
    } else if (name === 'change_dimension') {
      clear()
      dimension = dimensionName(packet.dimension)
    }
    if (name === 'start_game' || name === 'item_registry') {
      for (const item of packet.itemstates ?? []) names.set(item.runtime_id, item.name)
    }
    if (name === 'add_item_entity') {
      remember(packet, 'item', 'minecraft:item', packet.runtime_entity_id, packet.entity_id_self)
    } else if (name === 'add_player') {
      remember(packet, 'player', 'minecraft:player', packet.runtime_id, packet.unique_id)
    } else if (name === 'add_entity') {
      const type = entityName(packet.entity_type)
      const kind = type === 'minecraft:player' ? 'player' : MOBS.has(type) ? 'mob' : 'entity'
      remember(packet, kind, type, packet.runtime_id, packet.unique_id)
    } else if (name === 'move_entity') {
      movement(packet.runtime_entity_id, packet.position, name)
    } else if (name === 'move_entity_delta') {
      // Since Bedrock 1.16.100 these optional coordinates are absolute, not deltas.
      movement(packet.runtime_entity_id, packet, name, true)
    } else if (name === 'set_entity_data') {
      const entity = entities.get(normalizeId(packet.runtime_entity_id))
      if (!entity) { ignoredUpdates++; return { dangerChanged: false } }
      const before = entity.entityType === 'minecraft:creeper' ? [entity.primed, entity.charged] : null
      applyCreeperMetadata(entity, packet.metadata, packet.tick)
      touch(entity)
      return { dangerChanged: !!before && (before[0] !== entity.primed || before[1] !== entity.charged) }
    } else if (name === 'move_player') {
      const entity = entities.get(normalizeId(packet.runtime_id))
      if (entity?.kind === 'player') movement(packet.runtime_id, packet.position, name)
      else ignoredUpdates++
    } else if (name === 'remove_entity') {
      const uniqueId = normalizeId(packet.entity_id_self, true)
      const id = uniqueId === null ? undefined : uniqueIds.get(uniqueId)
      if (id !== undefined) {
        const entity = entities.get(id)
        if (entity) {
          removed.set(id, { runtimeId: id, uniqueId: entity.uniqueId, entityType: entity.entityType, position: entity.position ? { ...entity.position } : null, removedAt: clock() })
          while (removed.size > limit) removed.delete(removed.keys().next().value)
        }
        forget(id)
      }
    } else if (name === 'take_item_entity') {
      const id = normalizeId(packet.runtime_entity_id)
      if (entities.get(id)?.kind === 'item') forget(id)
    } else if (name === 'entity_event') {
      const entity = entities.get(normalizeId(packet.runtime_entity_id))
      if (!entity) { ignoredUpdates++; return }
      const event = packet.event_id
      entity.lastEvent = { event, data: Number.isSafeInteger(packet.data) ? packet.data : null, time: clock() }
      if (entity.entityType === 'minecraft:creeper' && (event === 'creeper_prime_fuse' || event === 32)) entity.primed = true
      if (event === 'death_animation' || event === 3) entity.alive = false
      if (event === 'respawn' || event === 18) entity.alive = true
      if (event === 'hurt_animation' || event === 2) entity.hurtAt = clock()
      touch(entity)
    }
  }
  function matchesKind (entity, kind) {
    if (kind === 'all') return true
    if (kind === 'hostile') return entity.hostile && entity.alive
    return entity.kind === kind
  }
  function validateKind (kind) {
    if (!['item', 'mob', 'player', 'entity', 'all', 'hostile'].includes(kind)) throw new Error('Unknown entity filter')
  }
  function observe (entity) {
    const { coordinates, ordinal, ...observed } = entity
    return structuredClone({ ...observed, positionKnown: entity.position !== null, name: entity.kind === 'item' ? names.get(entity.networkId) ?? null : entity.entityType })
  }
  function get (runtimeId) {
    const entity = entities.get(normalizeId(runtimeId))
    return entity ? observe(entity) : null
  }
  function snapshot ({ kind = 'item', includeUnknown = kind !== 'item' } = {}) {
    validateKind(kind)
    return [...entities.values()]
      .filter(entity => matchesKind(entity, kind) && (includeUnknown || entity.position !== null))
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(observe)
  }
  function nearby (position, { radius = 12, kind = 'hostile' } = {}) {
    if (!validPosition(position) || !Number.isFinite(radius) || radius < 0 || radius > 256) throw new Error('Nearby query needs a finite position and radius between 0 and 256')
    validateKind(kind)
    const nearby = []
    for (const entity of entities.values()) {
      if (!matchesKind(entity, kind) || entity.position === null) continue
      const distance = Math.hypot(entity.position.x - position.x, entity.position.y - position.y, entity.position.z - position.z)
      if (distance <= radius) nearby.push({ ...observe(entity), distance, horizontalDistance: Math.hypot(entity.position.x - position.x, entity.position.z - position.z) })
    }
    return nearby.sort((a, b) => a.distance - b.distance || a.runtimeId.localeCompare(b.runtimeId))
  }
  function setSelfRuntimeId (value) {
    version++
    const id = normalizeId(value)
    if (value != null && id === null) throw new Error('Invalid self runtime ID')
    ownRuntimeId = id
    if (id !== null) forget(id)
  }
  return { applyPacket, snapshot, get, version: () => version, motion, snapshotRemoved: () => structuredClone([...removed.values()]), nearby, setSelfRuntimeId, stats: () => ({ dimension, selfRuntimeId: ownRuntimeId, size: entities.size, limit, unknownPositions: [...entities.values()].filter(entity => !entity.position).length, liveHostiles: [...entities.values()].filter(entity => entity.hostile && entity.alive).length, ignoredUpdates }) }
}

module.exports = { createEntities }
