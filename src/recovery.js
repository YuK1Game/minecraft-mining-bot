'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { createPhysics } = require('./physics')
const { createNavigator } = require('./navigation')
const { evaluateThreats } = require('./threats')
const { knownSurfaceBody } = require('./low-health-water')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const SUPPORT = new Set(['stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'bedrock', 'moss_block'])
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|sweet_berry_bush|wither_rose|pointed_dripstone|gravel|concrete_powder|anvil)/
const CONTACT = 1e-4
// Second, still bounded search budget for a swim to a land shore.
const WIDE_SHORE_BUDGET = 1500
const { finitePoint: finite } = require('./vec3')
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const copy = value => structuredClone(value)
const { pointKey: key } = require('./vec3')
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const cleanLayers = block => !(block.extra ?? []).some(extra => !AIR.has(nameOf(extra)))
const support = block => block?.known === true && SUPPORT.has(nameOf(block)) && block.boundingBox === 'block' && cleanLayers(block)
const confirmed = state => state.positionSource !== 'client_prediction' && (state.positionServerConfirmed === true || ['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource))

class RecoveryError extends Error {
  constructor (message, code) { super(message); this.code = code }
}

// Feet within this horizontal distance of a landing cell take the land step.
const SURFACE_LANDING_REACH = 1.6
const WATER_NAMES = new Set(['water', 'flowing_water'])
const plainEmpty = block => block?.known === true && cleanLayers(block) && (AIR.has(nameOf(block)) || block.boundingBox === 'empty')

// 2D breadth-first search on the water-surface plane (feet at surfaceY). A
// swim cell has water just below the surface and clear body/head cells; a
// landing cell is a 4-neighbour of a swim cell with full support either at
// the surface (flat) or one block up (a climbable step), with clear headroom.
// Returns the nearest landing by swim steps, and the swim path to it.
function surfaceShoreRoute (world, feet, surfaceY, { radius = 32, maxNodes = 4096, isEmpty = plainEmpty, isSupport = support, allowStep = true } = {}) {
  const read = (x, y, z) => world.getBlock(x, y, z)
  const swim = (x, z) => { const below = read(x, surfaceY - 1, z); return below?.known === true && WATER_NAMES.has(nameOf(below)) && isEmpty(read(x, surfaceY, z)) && isEmpty(read(x, surfaceY + 1, z)) }
  const landing = (x, z) => {
    if (isSupport(read(x, surfaceY - 1, z)) && isEmpty(read(x, surfaceY, z)) && isEmpty(read(x, surfaceY + 1, z))) return { y: surfaceY, step: 0, support: read(x, surfaceY - 1, z).name }
    if (allowStep && isSupport(read(x, surfaceY, z)) && isEmpty(read(x, surfaceY + 1, z)) && isEmpty(read(x, surfaceY + 2, z))) return { y: surfaceY + 1, step: 1, support: read(x, surfaceY, z).name }
    return null
  }
  const sx = Math.floor(feet.x), sz = Math.floor(feet.z), start = `${sx},${sz}`
  const parents = new Map([[start, null]]), queue = [[sx, sz]]
  let truncated = false
  for (let i = 0; i < queue.length; i++) {
    if (parents.size >= maxNodes) { truncated = true; break }
    const [x, z] = queue[i]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, id = `${nx},${nz}`
      if (parents.has(id) || Math.hypot(nx - sx, nz - sz) > radius) continue
      const land = landing(nx, nz)
      if (land) {
        const path = []
        for (let cur = `${x},${z}`; cur !== null; cur = parents.get(cur)) { const [px, pz] = cur.split(',').map(Number); path.push({ x: px + 0.5, z: pz + 0.5 }) }
        path.reverse()
        return { found: true, landing: { position: { x: nx + 0.5, y: land.y, z: nz + 0.5 }, step: land.step, support: land.support }, path, summary: { swimCells: path.length, explored: parents.size, step: land.step } }
      }
      if (!swim(nx, nz)) continue
      parents.set(id, `${x},${z}`); queue.push([nx, nz])
    }
  }
  return { found: false, truncated, path: [], summary: { explored: parents.size, truncated } }
}

// A surface-water escape, using the existing ordinary movement owner. Health
// recovery, food use, combat, deep diving and resource work are separate tasks.
function createRecovery ({ getState, world, movement, getMovement = movement?.snapshot, getAvoidance = () => [], getShoreDirection = () => null, getDestination = () => null, flatShoreOnly = false, onProgress = () => {}, version = '1.26.60', physics, timeoutMs = 20000, phaseTimeoutMs = 6000, pollMs = 100, clock = Date.now, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }) }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || ['preview', 'start', 'stop'].some(method => typeof movement?.[method] !== 'function') || typeof getMovement !== 'function' || typeof getAvoidance !== 'function' || typeof getShoreDirection !== 'function' || typeof getDestination !== 'function' || typeof flatShoreOnly !== 'boolean') throw new Error('Recovery needs state, world, owned movement and validated destination callbacks')
  if (![timeoutMs, phaseTimeoutMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs > 60000 || phaseTimeoutMs > 15000 || pollMs > 1000) throw new Error('Invalid bounded recovery deadlines')
  physics ??= createPhysics({ world, version, allowWater: true })
  const empty = block => {
    if (block?.known !== true || !cleanLayers(block) || !(AIR.has(nameOf(block)) || block.boundingBox === 'empty')) return false
    if (!HAZARD.test(nameOf(block))) return true
    if (nameOf(block) !== 'firefly_bush' || block.boundingBox !== 'empty' || block.extra?.length || !finite(block.position)) return false
    try { const native = physics.blockAt(block.position); return native.name === 'firefly_bush' && native.shapes.length === 0 } catch { return false }
  }
  let mixedNavigator = null
  let active = null
  let status = { phase: 'idle', busy: false, attempts: 0, replans: 0, candidatesChecked: 0, target: null, position: null, positionSource: null, serverConfirmed: false, escaped: false, reason: null }

  function read (run) {
    if (run?.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new RecoveryError('Recovery cancelled', 'ABORTED')
    if (run && clock() >= run.deadline) throw new RecoveryError('The recovery time limit was reached', 'TIMEOUT')
    const state = getState()
    if (state?.dead || state?.isDead || state?.lifecycle?.dead || state?.health === 0) throw new RecoveryError('The player died; respawn is required', 'DEAD')
    if (state?.phase !== 'spawned' || !finite(state.position) || !Number.isFinite(state.health) || state.health <= 0) throw new RecoveryError('A living player with a known working position and health is required', 'NOT_READY')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new RecoveryError('Recovery uses ordinary survival movement', 'UNSUPPORTED_MODE')
    if (run?.playerScope != null && mixedScopeOf(state) !== run.playerScope) throw new RecoveryError('The recovery player scope or life changed', 'SESSION_CHANGED')
    // Recheck on every planning and movement observation. The runtime
    // callback rejects an immediate or unknown threat before resource recovery
    // can own movement; it also supplies actor circles to each live route.
    const avoidance = getAvoidance(state)
    if (!Array.isArray(avoidance)) throw new RecoveryError('Recovery threat observations are incomplete', 'STALE_OBSERVATION')
    if (run && ['dimension', 'connectionId', 'startedAt'].some(field => run.origin[field] != null && state[field] !== run.origin[field])) throw new RecoveryError('The recovery session changed', 'SESSION_CHANGED')
    if (run?.mixedScope != null && mixedScopeOf(state) !== run.mixedScope) throw new RecoveryError('The mixed shoreline player scope changed', 'SESSION_CHANGED')
    if (run && horizontal(state.position, run.origin.position) > run.maxTravel) throw new RecoveryError('Recovery exceeded its bounded travel area', 'DISTANCE_LIMIT')
    if (run && run.intentKey !== undefined) { const destination = destinationOf(state); if ((destination ? key(destination) : null) !== run.intentKey) throw new RecoveryError('Navigation destination changed during water recovery', 'DESTINATION_CHANGED') }
    return { ...state, recoveryAvoidance: avoidance }
  }
  function destinationOf (state) {
    const requested = getDestination(copy(state)), destination = requested?.position ?? requested
    if (destination == null) return null
    if (!finite(destination) || Math.abs(destination.x) > 30000000 || Math.abs(destination.z) > 30000000 || destination.y < -64 || destination.y > 320) throw new RecoveryError('Navigation destination is invalid', 'INVALID_DESTINATION')
    return copy(destination)
  }
  function dryDestination (destination) {
    if (Math.abs(destination.y - Math.round(destination.y)) > CONTACT) return false
    const x = Math.floor(destination.x), y = Math.round(destination.y), z = Math.floor(destination.z)
    return support(world.getBlock(x, y - 1, z)) && empty(world.getBlock(x, y, z)) && empty(world.getBlock(x, y + 1, z))
  }
  function surfaceDestination (destination, surfaceY) {
    if (Math.abs(destination.y - surfaceY) > CONTACT) return false
    try {
      for (const dx of [-0.28, 0.28]) for (const dz of [-0.28, 0.28]) {
        const p = { x: destination.x + dx, y: surfaceY, z: destination.z + dz }, water = physics.waterSurface(p), block = world.getBlock(Math.floor(p.x), surfaceY - 1, Math.floor(p.z))
        if (water?.surfaceY !== surfaceY || block?.known !== true || !['water', 'flowing_water'].includes(nameOf(block)) || !cleanLayers(block) || !empty(world.getBlock(Math.floor(p.x), surfaceY, Math.floor(p.z))) || !empty(world.getBlock(Math.floor(p.x), surfaceY + 1, Math.floor(p.z)))) return false
      }
      return true
    } catch { return false }
  }
  function destinationRouteRequired (destination) { return Object.assign(new RecoveryError('The explicit three-dimensional destination requires a separate validated route; surface arrival is not claimed', 'DESTINATION_ROUTE_REQUIRED'), { destination: copy(destination) }) }
  function dryPose (state) {
    const predicted = state.predicted?.physicsState ?? state.predicted ?? state.physicsState
    const feet = state.position.y - 1.62
    const y = Math.round(feet)
    if (Math.abs(feet - y) > CONTACT || predicted?.onGround === false || predicted?.isInWater === true) return false
    for (const dx of [-0.3 + CONTACT, 0.3 - CONTACT]) for (const dz of [-0.3 + CONTACT, 0.3 - CONTACT]) {
      const x = Math.floor(state.position.x + dx)
      const z = Math.floor(state.position.z + dz)
      if (!support(world.getBlock(x, y - 1, z)) || !empty(world.getBlock(x, y, z)) || !empty(world.getBlock(x, y + 1, z))) return false
    }
    return true
  }
  function mixedScopeOf (state) {
    const life = state.lifecycle?.deathId ?? state.deathId
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !['overworld', 'nether', 'end'].includes(state.dimension) || !/^\d+$/.test(String(state.runtimeEntityId)) || !Number.isSafeInteger(life) || life < 0) throw new RecoveryError('The mixed shoreline player scope is unknown', 'SCOPE_UNKNOWN')
    return JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId), life])
  }
  function unitSupport (x, y, z) {
    const raw = world.getBlock(x, y, z)
    if (!support(raw)) return false
    const shapes = physics.blockAt({ x, y, z }).shapes
    return shapes.length === 1 && shapes[0].every((value, index) => Math.abs(value - (index < 3 ? 0 : 1)) <= 1e-6)
  }
  function mixedFootprint (state) {
    const physical = state.predicted?.physicsState ?? state.physicsState, feet = { ...state.position, y: state.position.y - 1.62 }, y = Math.round(feet.y)
    if (physical?.onGround !== true || physical.isInWater || physical.isInLava || !finite(physical.velocity) || Math.abs(feet.y - y) > CONTACT) return null
    let land = false, water = false
    for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) {
      const floor = world.getBlock(x, y - 1, z), body = world.getBlock(x, y, z), head = world.getBlock(x, y + 1, z)
      if (![floor, body, head].every(block => block?.known === true)) throw new RecoveryError('The mixed shoreline footprint is unknown', 'UNKNOWN_TERRAIN')
      if (!empty(body) || !empty(head) || !cleanLayers(floor)) return null
      if (unitSupport(x, y - 1, z)) land = true
      else if (['water', 'flowing_water'].includes(nameOf(floor))) {
        const surface = physics.waterSurface({ x: x + 0.5, y, z: z + 0.5 })
        if (!surface || surface.surfaceY !== y) return null
        water = true
      } else if (!AIR.has(nameOf(floor))) return null
    }
    return land && water && physics.hasSupport(feet) ? { feet, surfaceY: y } : null
  }
  function mixedAvoidance (state) {
    const actors = [state.entities, state.hostiles, state.nearbyHostiles, state.threats].find(Array.isArray)
    const evaluated = evaluateThreats(state, actors, { observationRadius: 32 })
    if (evaluated.requiresObservation || state.entityStats?.unknownPositions > evaluated.unknownPositions.length) throw new RecoveryError('Mixed shoreline actor observations are incomplete', 'STALE_OBSERVATION')
    if (evaluated.threats.length) throw new RecoveryError('A current hostile interrupts mixed shoreline recentering', 'NEARBY_THREAT')
    const provided = state.recoveryAvoidance ?? []
    if (new Set(provided.map(circle => circle.id)).size !== provided.length) throw new RecoveryError('Mixed shoreline actor identities are ambiguous', 'STALE_OBSERVATION')
    const circles = new Map(provided.map(circle => [circle.id, copy(circle)]))
    for (const actor of [...evaluated.outsideDanger, ...evaluated.suppressedByTerrain]) {
      if (!actor.runtimeId || !finite(actor.position) || !Number.isFinite(actor.dangerRadius)) throw new RecoveryError('Mixed shoreline actor identity is unknown', 'STALE_OBSERVATION')
      const previous = circles.get(actor.runtimeId)
      circles.set(actor.runtimeId, { id: actor.runtimeId, position: copy(actor.position), minDistance: Math.max(previous?.minDistance ?? 0, actor.dangerRadius), padding: previous?.padding ?? 0 })
    }
    return [...circles.values()]
  }
  function mixedMoveOptions (state, run) {
    if (!mixedFootprint(state)) throw new RecoveryError('The mixed shoreline origin changed before movement', 'STALE_POSE')
    const result = { allowWater: true, emergency: true, partialRecenter: true, shoreRecenter: true, sprint: false, maxDistance: 2, maxExpanded: 64, maxTicks: 40, avoidance: mixedAvoidance(state), ...(run ? { signal: run.signal, beforeInput: frame => {
      const current = read(run), from = current.position, next = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
      return mixedAvoidance(current).every(circle => {
        const dx = next.x - from.x, dy = next.y - from.y, dz = next.z - from.z, length = dx * dx + dy * dy + dz * dz
        const ratio = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * dx + (circle.position.y - from.y) * dy + (circle.position.z - from.z) * dz) / length)) : 0
        const padded = circle.minDistance + (circle.padding ?? 0), originDistance = Math.hypot(circle.position.x - from.x, circle.position.y - from.y, circle.position.z - from.z)
        const required = originDistance < padded - CONTACT ? circle.minDistance : padded
        return Math.hypot(circle.position.x - from.x - dx * ratio, circle.position.y - from.y - dy * ratio, circle.position.z - from.z - dz * ratio) >= required - CONTACT
      })
    } } : {}) }
    return result
  }
  function recoveryMoveOptions (candidate, current, run) {
    if (candidate.shoreRecenter) return mixedMoveOptions(current, run)
    const options = { allowWater: true, emergency: true, ...(candidate.medium === 'water' ? { directSurface: true, exactGoal: true } : {}), maxDistance: 12, maxExpanded: candidate.searchBudget ?? 500, avoidance: copy(current.recoveryAvoidance), signal: run.signal }
    if (current.threatPolicy === 'online_learning') options.beforeInput = frame => {
      const fresh = read(run), from = fresh.position, feet = frame.predictedState?.position, next = frame.packetPosition
      if (fresh.threatPolicy !== 'online_learning' || !finite(feet) || !finite(next) || Math.hypot(next.x - feet.x, next.y - feet.y - 1.62, next.z - feet.z) > 1e-6) return false
      if (candidate.medium === 'water' && !knownSurfaceBody(physics, feet, candidate.position.y)) return false
      return fresh.recoveryAvoidance.every(circle => {
        if (typeof circle.id !== 'string' || !circle.id || !finite(circle.position) || !Number.isFinite(circle.minDistance) || !Number.isFinite(circle.padding ?? 0)) return false
        const dx = next.x - from.x, dy = next.y - from.y, dz = next.z - from.z, length = dx * dx + dy * dy + dz * dz
        const ratio = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * dx + (circle.position.y - from.y) * dy + (circle.position.z - from.z) * dz) / length)) : 0
        return Math.hypot(circle.position.x - from.x - dx * ratio, circle.position.y - from.y - dy * ratio, circle.position.z - from.z - dz * ratio) >= circle.minDistance + (circle.padding ?? 0) - CONTACT
      })
    }
    return options
  }
  function optionsOf (options = {}) {
    const bounds = { radius: options.radius ?? 8, shoreRadius: options.shoreRadius ?? 32, waypointDistance: options.waypointDistance ?? 4, maxAttempts: options.maxAttempts ?? 4, maxCandidates: options.maxCandidates ?? 20, maxTravel: options.maxTravel ?? 12 }
    for (const [name, maximum] of Object.entries({ radius: 12, shoreRadius: 32, waypointDistance: 10, maxAttempts: 8, maxCandidates: 40, maxTravel: 16 })) if (!Number.isSafeInteger(bounds[name]) || bounds[name] < 1 || bounds[name] > maximum) throw new RecoveryError('Invalid recovery limits', 'INVALID_BOUNDS')
    const flat = options.flatShoreOnly ?? flatShoreOnly
    if (typeof flat !== 'boolean') throw new RecoveryError('flatShoreOnly must be boolean', 'INVALID_BOUNDS')
    return { ...bounds, flatShoreOnly: flat }
  }
  // Every sampled body corner on the straight surface segment stays in the same
  // known water surface with clear air above.
  function surfaceLineSafe (feet, target, surfaceY) {
    const samples = Math.max(1, Math.ceil(horizontal(feet, target) / 0.4))
    try {
      for (let index = 0; index <= samples; index++) {
        const ratio = index / samples
        const position = { x: feet.x + (target.x - feet.x) * ratio, y: surfaceY, z: feet.z + (target.z - feet.z) * ratio }
        for (const dx of [-0.28, 0.28]) for (const dz of [-0.28, 0.28]) {
          const corner = { x: position.x + dx, y: position.y, z: position.z + dz }
          const water = physics.waterSurface(corner)
          if (!water || water.surfaceY !== surfaceY || !empty(world.getBlock(Math.floor(corner.x), surfaceY, Math.floor(corner.z))) || !empty(world.getBlock(Math.floor(corner.x), surfaceY + 1, Math.floor(corner.z)))) return false
        }
      }
    } catch { return false }
    return true
  }
  function * candidateSteps (state, options) {
    const feet = { ...state.position, y: state.position.y - 1.62 }
    const mixed = mixedFootprint(state)
    if (mixed) {
      const scope = mixedScopeOf(state), destination = destinationOf(state), moveOptions = mixedMoveOptions(state), points = []
      const y = mixed.surfaceY
      for (let x = Math.floor(feet.x) - 2; x <= Math.floor(feet.x) + 2; x++) for (let z = Math.floor(feet.z) - 2; z <= Math.floor(feet.z) + 2; z++) {
        const position = { x: x + 0.5, y, z: z + 0.5 }, distance = horizontal(feet, position)
        if (distance < 0.2 || distance > 1.2 || !unitSupport(x, y - 1, z) || !empty(world.getBlock(x, y, z)) || !empty(world.getBlock(x, y + 1, z))) continue
        points.push({ position, distance, score: distance, medium: 'land', support: world.getBlock(x, y - 1, z).name, shoreRecenter: true, intermediateShore: true, reachedDestination: false })
      }
      points.sort((a, b) => a.distance - b.distance || a.position.x - b.position.x || a.position.z - b.position.z)
      for (const candidate of points.slice(0, options.maxCandidates)) {
        yield
        mixedNavigator ??= createNavigator({ world, physics, allowWater: true })
        const native = mixedNavigator.plan(physics.fromServer(state), candidate.position, moveOptions)
        if (native.ready) return { surfaceY: y, unknown: 0, points: [candidate], mixedOrigin: true, mixedScope: scope, ...(destination ? { destination: copy(destination) } : {}) }
      }
      return { surfaceY: y, unknown: 0, points: [], mixedOrigin: true, mixedScope: scope, ...(destination ? { destination: copy(destination) } : {}) }
    }
    let surface
    try { surface = physics.waterSurface(feet) } catch (error) {
      if (/Unknown|incomplete|not received/i.test(error.message)) throw new RecoveryError(error.message, 'UNKNOWN_TERRAIN')
      if (/lava/i.test(error.message)) throw new RecoveryError(error.message, 'UNSAFE_LAVA')
      throw error
    }
    if (!surface) throw new RecoveryError('Only known surface water with clear headroom supports this escape', 'SURFACE_WATER_REQUIRED')
    const points = []
    const centerX = Math.floor(feet.x)
    const centerZ = Math.floor(feet.z)
    let unknown = 0
    let columns = 0
    const destination = destinationOf(state)
    if (destination && destination.y < surface.surfaceY - CONTACT) throw destinationRouteRequired(destination)
    const landDestination = destination && dryDestination(destination)
    if (destination && horizontal(feet, destination) <= 0.4 && !landDestination) {
      if (surfaceDestination(destination, surface.surfaceY) && Math.abs(feet.y - destination.y) <= 0.8) return { surfaceY: surface.surfaceY, unknown, points: [], atDestination: true, destination: copy(destination) }
      throw destinationRouteRequired(destination)
    }
    if (destination && horizontal(feet, destination) <= options.radius && landDestination) {
      points.push({ position: copy(destination), distance: horizontal(feet, destination), medium: 'land', destination: true, score: -1 })
    }
    // An explicit land destination may require first stepping onto a local
    // flat bank. This preserves the intent; reaching the bank is not arrival.
    const searchRadius = destination ? options.radius : options.shoreRadius
    const flatBank = options.flatShoreOnly || destination !== null
    const searchShore = !destination || landDestination || destination.y > surface.surfaceY + CONTACT
    if (searchShore) for (let x = centerX - searchRadius; x <= centerX + searchRadius; x++) for (let z = centerZ - searchRadius; z <= centerZ + searchRadius; z++) {
      if (++columns % 64 === 0) yield
      const firstY = flatBank ? surface.surfaceY - 1 : surface.surfaceY - 3
      const lastY = flatBank ? surface.surfaceY - 1 : surface.surfaceY + 1
      for (let floorY = firstY; floorY <= lastY; floorY++) {
        const position = { x: x + 0.5, y: floorY + 1, z: z + 0.5 }
        const distance = horizontal(feet, position)
        if (distance > searchRadius || distance < 0.2) continue
        const remainingDestinationDistance = destination ? horizontal(position, destination) : null
        if (destination && (horizontal(feet, destination) - remainingDestinationDistance <= 0.01 || points.some(point => key(point.position) === key(position)))) continue
        const floor = world.getBlock(x, floorY, z)
        const body = world.getBlock(x, floorY + 1, z)
        const head = world.getBlock(x, floorY + 2, z)
        if (![floor, body, head].every(block => block?.known === true)) { unknown++; continue }
        if (!support(floor) || !empty(body) || !empty(head)) continue
        if (flatBank && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const b = world.getBlock(x + dx, floorY, z + dz); return b?.known === true && ['water', 'flowing_water'].includes(nameOf(b)) })) continue
        let lava = false
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [floorY, floorY + 1]) if (/lava/.test(nameOf(world.getBlock(x + dx, y, z + dz)))) lava = true
        if (!lava) points.push({ position, distance, support: floor.name, medium: 'land', score: distance + Math.abs(position.y - surface.surfaceY) * 0.8, ...(destination ? { intermediateShore: true, reachedDestination: false, remainingDestinationDistance } : {}) })
      }
    }
    points.sort((a, b) => a.score - b.score || a.position.x - b.position.x || a.position.z - b.position.z)
    // Light path first: a 2D search on the water-surface plane to the nearest
    // landing cell. Only an adjacent landing gets a (short) native preview;
    // otherwise the next move is a cheap direct-surface swim along the path.
    // The 3D candidates below stay as the fallback when this finds nothing.
    const surfacePoints = []
    let surfaceSummary = null
    if (!destination) {
      yield
      // A flat-shore policy keeps landing feet exactly at sea level (no step).
      const route = surfaceShoreRoute(world, feet, surface.surfaceY, { radius: options.shoreRadius, isEmpty: empty, allowStep: !options.flatShoreOnly })
      if (route.found) surfaceSummary = route.summary
      if (route.found) {
        const landing = { position: copy(route.landing.position), distance: horizontal(feet, route.landing.position), support: route.landing.support, medium: 'land', score: -50, surfaceRoute: true, step: route.landing.step }
        const avoided = (state.recoveryAvoidance ?? []).some(circle => Math.hypot(landing.position.x - circle.position.x, landing.position.y + 1.62 - circle.position.y, landing.position.z - circle.position.z) < circle.minDistance - CONTACT)
        if (!avoided) {
          const submerged = feet.y < surface.surfaceY - 1
          if (!submerged && landing.distance <= SURFACE_LANDING_REACH) surfacePoints.push(landing)
          const reach = Math.min(options.radius, 4.5)
          const relays = []
          if (submerged) relays.push({ position: { x: Math.floor(feet.x) + 0.5, y: surface.surfaceY, z: Math.floor(feet.z) + 0.5 }, distance: 0, medium: 'water', ascend: true, shoreTarget: copy(landing.position), score: -100 })
          for (let index = route.path.length - 1; index >= 0; index--) {
            const position = { ...route.path[index], y: surface.surfaceY }, distance = horizontal(feet, position)
            if (distance < 2 || distance > reach) continue
            if (surfaceLineSafe(feet, position, surface.surfaceY)) { relays.push({ position, distance, medium: 'water', shoreTarget: copy(landing.position), shoreDistance: route.path.length - 1 - index, progressTowardShore: index, surfaceRoute: true, score: -index }); break }
            yield
          }
          if (!surfacePoints.length) surfacePoints.push(...relays)
        }
      }
    }
    const local = points.filter(point => point.distance <= options.radius && (point.medium !== 'land' || (state.recoveryAvoidance ?? []).every(circle => Math.hypot(point.position.x - circle.position.x, point.position.y + 1.62 - circle.position.y, point.position.z - circle.position.z) >= circle.minDistance - CONTACT))).slice(0, options.maxCandidates)
    // 2D surface candidates first; the 3D local candidates remain the fallback.
    const fallback = local.filter(point => !surfacePoints.some(s => key(s.position) === key(point.position)))
    if (surfacePoints.length) return { surfaceY: surface.surfaceY, unknown, points: [...surfacePoints, ...fallback].slice(0, Math.max(options.maxCandidates, surfacePoints.length)), surfaceRoute: surfaceSummary, ...(surfacePoints[0].medium === 'water' ? { distantShore: copy(surfacePoints[0].shoreTarget) } : {}) }
    if (local.length) return { surfaceY: surface.surfaceY, unknown, points: local, ...(destination ? { destination: copy(destination) } : {}) }
    // A distant observed bank is a direction, not permission to cross unknown
    // ocean. Each batch ends at one fully known, locally previewed water point.
    const shores = destination ? [{ position: copy(destination), distance: horizontal(feet, destination), directionOnly: true, destination: true }] : points.slice(0, 8)
    let rememberedDirection = null
    if (!shores.length) {
      const receipt = getShoreDirection(copy(state))
      if (receipt != null && (!options.flatShoreOnly || Math.abs(receipt.position?.y - surface.surfaceY) <= CONTACT)) {
        const position = receipt.position
        if (receipt.observationOnly !== true || receipt.requiresWorldValidation !== true || !finite(position) || Math.abs(position.x) > 30000000 || Math.abs(position.z) > 30000000 || position.y < -64 || position.y > 320) throw new RecoveryError('A remembered shore must be a valid direction-only observation', 'INVALID_SHORE_DIRECTION')
        rememberedDirection = copy(position)
        shores.push({ position: copy(position), distance: horizontal(feet, position), directionOnly: true })
      }
    }
    if (!shores.length) return { surfaceY: surface.surfaceY, unknown, points: [] }
    const relays = []
    // Stay inside the direct surface planner's proven range so a correction
    // does not restart an axis-first grid route toward a diagonal shore.
    const reach = Math.min(options.radius, 4.5)
    if (destination && horizontal(feet, destination) >= 0.2 && horizontal(feet, destination) <= reach) relays.push({ position: { x: destination.x, y: surface.surfaceY, z: destination.z }, distance: horizontal(feet, destination), medium: 'water', shoreTarget: copy(destination), shoreDistance: 0, progressTowardShore: horizontal(feet, destination), directionOnly: true, destination: true, score: -100 })
    const extent = Math.ceil(reach)
    for (let x = centerX - extent; x <= centerX + extent; x++) for (let z = centerZ - extent; z <= centerZ + extent; z++) {
      const position = { x: x + 0.5, y: surface.surfaceY, z: z + 0.5 }
      const distance = horizontal(feet, position)
      if (distance < 2 || distance > reach) continue
      const nearest = shores.map(shore => ({ shore, remaining: horizontal(position, shore.position) })).sort((a, b) => a.remaining - b.remaining)[0]
      const gain = nearest.shore.distance - nearest.remaining
      if (gain < 1.5) continue
      relays.push({ position, distance, medium: 'water', shoreTarget: copy(nearest.shore.position), shoreDistance: nearest.remaining, progressTowardShore: gain, ...(nearest.shore.directionOnly ? { directionOnly: true, requiresWorldValidation: true } : {}), score: Math.abs(distance - Math.min(options.waypointDistance, reach)) * 2 + nearest.remaining * 0.2 })
    }
    relays.sort((a, b) => a.score - b.score || a.position.x - b.position.x || a.position.z - b.position.z)
    const known = []
    for (const relay of relays.slice(0, options.maxCandidates * 3)) {
      yield
      if (surfaceLineSafe(feet, relay.position, surface.surfaceY)) known.push(relay)
      if (known.length >= options.maxCandidates) break
    }
    return { surfaceY: surface.surfaceY, unknown, points: known, distantShore: rememberedDirection || destination ? null : copy(shores[0].position), ...(rememberedDirection ? { rememberedDirection } : {}), ...(destination ? { destination: copy(destination) } : {}) }
  }
  function candidates (state, options) {
    const search = candidateSteps(state, options)
    let next
    do { next = search.next() } while (!next.done)
    return next.value
  }
  async function candidatesAsync (state, options, run) {
    const search = candidateSteps(state, options)
    let next = search.next(), yielded = 0
    while (!next.done) {
      if (run?.signal.aborted) throw run.signal.reason
      if (run && clock() >= run.deadline) throw new RecoveryError('The recovery time limit was reached', 'TIMEOUT')
      await delay(1, run?.signal)
      if (++yielded % 8 === 0) read(run)
      next = search.next()
    }
    return next.value
  }
  function previewResult (found) {
    if (found.atDestination) return { ready: false, atDestination: true, destination: found.destination, candidates: [], code: 'DESTINATION_REACHED', serverConfirmed: false }
    return { ready: found.points.length > 0, candidates: found.points, surfaceY: found.surfaceY, unknown: found.unknown, distantShore: found.distantShore ?? null, rememberedDirection: found.rememberedDirection ?? null, destination: found.destination ?? null, directionOnly: !!found.rememberedDirection || !!found.destination, mode: found.mixedOrigin ? 'shore_recenter' : found.destination ? 'destination' : found.points[0]?.medium === 'water' ? 'water_waypoint' : 'shore', code: found.points.length ? null : 'NO_SAFE_SHORE', reason: found.points.length ? found.mixedOrigin ? 'A known mixed shoreline footprint can recenter onto full dry support; original destination remains unconfirmed' : found.destination ? 'Known local water movement advances toward the active destination' : found.rememberedDirection ? 'A known local water waypoint advances toward a remembered shore direction; the landmark terrain still needs observation' : found.points[0].medium === 'water' ? 'A known water waypoint advances toward a distant observed shore; it does not complete recovery' : 'Known supported shore candidates require live movement previews' : 'No known supported shore was found', emergency: true, requiresLivePreview: true, serverConfirmed: false }
  }
  function preview (options = {}) {
    try {
      const limits = optionsOf(options)
      const state = read()
      if (dryPose(state)) return { ready: true, alreadyAshore: true, candidates: [], position: copy(state.position), serverConfirmed: confirmed(state) }
      const found = candidates(state, limits)
      return previewResult(found)
    } catch (error) { return { ready: false, code: error.code ?? 'PREVIEW_FAILED', reason: error.message, ...(error.code === 'DESTINATION_ROUTE_REQUIRED' ? { requiresDedicatedRoute: true, destination: error.destination } : {}), candidates: [], serverConfirmed: false } }
  }
  async function previewAsync (options = {}) {
    try {
      const limits = optionsOf(options), state = read()
      if (dryPose(state)) return { ready: true, alreadyAshore: true, candidates: [], position: copy(state.position), serverConfirmed: confirmed(state) }
      const found = await candidatesAsync(state, limits)
      const latest = read()
      if (found.mixedOrigin && mixedScopeOf(latest) !== found.mixedScope) throw new RecoveryError('The mixed shoreline player scope changed during preview', 'SESSION_CHANGED')
      if (['dimension', 'connectionId', 'startedAt'].some(field => state[field] != null && state[field] !== latest[field]) || horizontal(state.position, latest.position) > 0.5) throw new RecoveryError('The recovery preview origin changed', 'STALE_POSE')
      const destination = destinationOf(latest)
      if ((destination ? key(destination) : null) !== (found.destination ? key(found.destination) : null)) throw new RecoveryError('Navigation destination changed during cooperative preview', 'DESTINATION_CHANGED')
      return previewResult(found)
    } catch (error) { return { ready: false, code: error.code ?? 'PREVIEW_FAILED', reason: error.message, ...(error.code === 'DESTINATION_ROUTE_REQUIRED' ? { requiresDedicatedRoute: true, destination: error.destination } : {}), candidates: [], serverConfirmed: false } }
  }
  async function call (run, label, fn, milliseconds = phaseTimeoutMs) {
    if (run.signal.aborted) throw run.signal.reason
    if (clock() >= run.deadline) throw new RecoveryError('The recovery time limit was reached', 'TIMEOUT')
    let timer
    let abort
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new RecoveryError('Recovery cancelled', 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new RecoveryError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(milliseconds, run.deadline - clock())))
    })
    try { return await Promise.race([Promise.resolve().then(() => fn(read(run))), cancelled]) } finally { clearTimeout(timer); run.signal.removeEventListener('abort', abort) }
  }
  function report (phase, details = {}) { status.phase = phase; try { Promise.resolve(onProgress({ phase, ...copy(details) })).catch(() => {}) } catch { /* Reporting cannot change ownership. */ } }
  async function halt (run, reason) {
    let timer
    try { await Promise.race([Promise.resolve().then(() => movement.stop(reason)), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new RecoveryError('Movement did not stop before its deadline', 'STOP_TIMEOUT')), 1000) })]) } finally { clearTimeout(timer) }
  }
  async function cleanup (run, reason) { run.cleanup ??= halt(run, reason).catch(error => { status.cleanupError = error.message }); await run.cleanup }
  function finish (state, reason) {
    status.phase = status.intermediateShore ? 'predicted' : 'completed'
    status.busy = false
    status.position = copy(state.position)
    status.positionSource = state.positionSource ?? 'unknown'
    status.serverConfirmed = status.intermediateShore ? false : confirmed(state)
    if (status.intermediateShore) status.positionServerConfirmed = confirmed(state)
    status.escaped = status.mixedFootprintRecenter !== true
    status.reason = reason
    return { ok: true, ...snapshot(), ...(status.intermediateShore ? { partial: true, requiresObservation: true, reachedDestination: false, reachedWaypoint: true, collected: false } : {}), health: state.health, healed: false }
  }
  function finishWaypoint (state, chosen) {
    status.phase = 'predicted'
    status.busy = false
    status.position = copy(state.position)
    status.positionSource = state.positionSource ?? 'unknown'
    status.serverConfirmed = confirmed(state)
    status.escaped = false
    status.mode = 'water_waypoint'
    status.shoreTarget = copy(chosen.shoreTarget)
    status.directionOnly = chosen.directionOnly === true
    status.reason = chosen.directionOnly ? 'A known surface-water waypoint was reached toward a remembered direction; no landmark arrival is claimed' : 'A known surface-water waypoint was reached; observe again and continue toward the shore'
    return { ok: true, ...snapshot(), partial: true, reachedWaypoint: true, health: state.health, healed: false, collected: false }
  }
  function finishDestination (state, destination) {
    status.phase = 'predicted'; status.busy = false; status.position = copy(state.position); status.positionSource = state.positionSource ?? 'unknown'; status.serverConfirmed = confirmed(state); status.escaped = false; status.mode = 'destination'; status.destination = copy(destination); status.reason = 'The known surface destination is already reached; dry-shore arrival is not claimed'
    return { ok: true, ...snapshot(), partial: true, atDestination: true, reachedDestination: true, reachedWaypoint: false, health: state.health, healed: false, collected: false }
  }
  async function execute (options = {}, context = {}) {
    if (active) throw new RecoveryError('Recovery is already running', 'BUSY')
    const limits = optionsOf(options)
    const origin = read()
    const controller = new AbortController()
    const external = context.signal ?? options.signal
    const run = { controller, signal: external ? AbortSignal.any([external, controller.signal]) : controller.signal, origin, playerScope: origin.threatPolicy === 'online_learning' ? mixedScopeOf(origin) : null, deadline: clock() + timeoutMs, maxTravel: limits.maxTravel, cleanup: null }
    active = run
    status = { phase: 'planning', busy: true, attempts: 0, replans: 0, candidatesChecked: 0, target: null, position: null, positionSource: null, serverConfirmed: false, escaped: false, reason: null }
    const failed = new Set()
    let relayTarget = null
    let completed = false
    try {
      while (status.attempts < limits.maxAttempts) {
        const state = read(run)
        if (dryPose(state)) {
          if (status.attempts > 0 && (state.positionUpdatedAt == null || state.positionUpdatedAt === origin.positionUpdatedAt)) throw new RecoveryError('The dry working pose has no fresh movement observation', 'STALE_POSE')
          completed = true; return finish(state, 'A supported dry working pose is observed; keep resource work paused until health permits')
        }
        const found = await candidatesAsync(state, limits, run)
        if (run.intentKey === undefined) run.intentKey = found.destination ? key(found.destination) : null
        if (found.atDestination) {
          const latest = read(run), feet = { ...latest.position, y: latest.position.y - 1.62 }
          if (horizontal(feet, found.destination) <= 0.4 && Math.abs(feet.y - found.destination.y) <= 0.8 && surfaceDestination(found.destination, found.surfaceY)) { completed = true; return finishDestination(latest, found.destination) }
          throw new RecoveryError('Surface destination arrival is not a fresh matching pose', 'STALE_POSE')
        }
        if (found.mixedOrigin) { run.mixedScope ??= mixedScopeOf(origin); if (found.mixedScope !== run.mixedScope) throw new RecoveryError('The mixed shoreline player scope changed during planning', 'SESSION_CHANGED') }
        if (relayTarget) found.points = [relayTarget, ...found.points.filter(candidate => key(candidate.position) !== key(relayTarget.position))]
        let chosen = null
        for (const candidate of found.points) {
          if (failed.has(key(candidate.position)) || horizontal(candidate.position, origin.position) > limits.maxTravel) continue
          status.candidatesChecked++
          let live = await call(run, 'Shore movement preview', current => movement.preview(copy(candidate.position), recoveryMoveOptions(candidate, current, run)))
          // A swim to a land shore expands many more water nodes than a walk;
          // a search-limit miss is not "no route". Retry once with a larger,
          // still bounded budget and keep it for the matching start.
          if (!live?.ready && !candidate.shoreRecenter && candidate.medium === 'land' && candidate.searchBudget == null && /search limit/i.test(String(live?.reason ?? ''))) {
            await call(run, 'Shore candidate observation yield', () => delay(1, run.signal), 1001)
            candidate.searchBudget = WIDE_SHORE_BUDGET
            live = await call(run, 'Shore movement preview', current => movement.preview(copy(candidate.position), recoveryMoveOptions(candidate, current, run)))
          }
          if (live?.ready && (candidate.medium !== 'water' || live.directSurface === true)) { chosen = candidate; break }
          // Failed candidate searches must yield to ordinary input/network
          // ticks rather than form a long synchronous preview chain.
          await call(run, 'Shore candidate observation yield', () => delay(1, run.signal), 1001)
        }
        if (!chosen) { if (found.destination && Math.abs(found.destination.y - found.surfaceY) > CONTACT) throw destinationRouteRequired(found.destination); throw new RecoveryError('No safe known shore route is accepted by the live movement preview', 'NO_SAFE_SHORE') }
        relayTarget = chosen.medium === 'water' ? chosen : null
        // Give the continuously running neutral sender one real timer pulse
        // before the final fresh state read and movement preparation.
        await delay(50, run.signal)
        status.attempts++
        status.target = copy(chosen.position)
        status.mode = chosen.shoreRecenter ? 'shore_recenter' : chosen.medium === 'water' ? 'water_waypoint' : 'shore'
        status.mixedFootprintRecenter = chosen.shoreRecenter === true
        status.intermediateShore = chosen.intermediateShore === true
        if (found.destination) status.destination = copy(found.destination)
        status.shoreTarget = chosen.shoreTarget ? copy(chosen.shoreTarget) : null
        status.directionOnly = chosen.directionOnly === true
        report('escaping', { target: chosen.position, attempt: status.attempts, health: state.health })
        let baseline
        await call(run, 'Shore movement start', current => { baseline = current; return movement.start(copy(chosen.position), recoveryMoveOptions(chosen, current, run)) })
        const phaseDeadline = Math.min(run.deadline, clock() + phaseTimeoutMs)
        let retry = false
        while (clock() < phaseDeadline) {
          const observation = await call(run, 'Recovery movement state', async current => ({ state: current, motion: await getMovement() }))
          const latest = observation.state, motion = observation.motion
          const fresh = latest.positionUpdatedAt != null && latest.positionUpdatedAt !== baseline.positionUpdatedAt
          if (!fresh && horizontal(latest.position, baseline.position) >= 0.15 && ['awaiting_server_confirmation', 'completed', 'replan_required'].includes(motion?.phase)) throw new RecoveryError('Movement coordinates changed without a fresh working observation', 'STALE_POSE')
          if (fresh && dryPose(latest) && !['moving', 'settling', 'walking'].includes(motion?.phase)) { completed = true; return finish(latest, 'Emergency movement reached supported dry ground; server position confidence is retained separately') }
          if (chosen.medium === 'water' && fresh && ['awaiting_server_confirmation', 'completed', 'replan_required'].includes(motion?.phase) && horizontal(latest.position, chosen.position) <= 0.4 && Math.abs(latest.position.y - 1.62 - chosen.position.y) <= 0.8) {
            const water = physics.waterSurface({ ...latest.position, y: latest.position.y - 1.62 })
            if (water?.surfaceY === chosen.position.y && horizontal(latest.position, origin.position) >= 1.5) { completed = true; return finishWaypoint(latest, chosen) }
          }
          const damaged = latest.health < baseline.health
          if (damaged || ['replan_required', 'failed', 'stopped', 'awaiting_server_confirmation', 'completed'].includes(motion?.phase)) {
            if (/Unknown|incomplete|not received|unreceived/i.test(motion?.reason ?? '')) throw new RecoveryError('The escape route became unknown', 'UNKNOWN_TERRAIN')
            if (/lava/i.test(motion?.reason ?? '')) throw new RecoveryError('The escape route encountered lava', 'UNSAFE_LAVA')
            await halt(run, damaged ? 'Damage interrupted recovery; replan from the newest pose' : 'Replan recovery from the newest working pose')
            status.replans++
            if (horizontal(latest.position, baseline.position) < 0.15 && !damaged) failed.add(key(chosen.position))
            retry = true
            break
          }
          await call(run, 'Recovery observation wait', () => delay(pollMs, run.signal), pollMs + 1000)
        }
        if (!retry) throw new RecoveryError('A fresh supported shore arrival was not observed', 'TIMEOUT')
        report('replanning', { attempts: status.attempts, replans: status.replans })
      }
      throw new RecoveryError('The bounded recovery attempt limit was reached', 'ATTEMPT_LIMIT')
    } catch (error) {
      status.phase = run.signal.aborted ? 'stopped' : 'failed'
      status.reason = error.message
      status.code = error.code ?? 'RECOVERY_FAILED'
      if (!run.signal.aborted) controller.abort(error)
      throw error
    } finally {
      if (!completed) await cleanup(run, status.reason)
      status.busy = false
      if (active === run) active = null
    }
  }
  async function stop (reason = 'Recovery stopped') {
    const run = active
    if (!run) return snapshot()
    run.controller.abort(new RecoveryError(reason, 'ABORTED'))
    status.phase = 'stopped'
    status.reason = reason
    await cleanup(run, reason)
    return snapshot()
  }
  function snapshot () { return copy(status) }
  return { preview, previewAsync, execute, stop, snapshot }
}

// Explicit online-learning risk policy. This planner sends no packets and
// never upgrades a native prediction into an observed landing or a safe route.
const SHORE_AIR = new Set(['air', 'cave_air', 'void_air'])
const SHORE_WATER = new Set(['water', 'flowing_water'])
const shoreDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const shoreEye = feet => ({ ...feet, y: feet.y + 1.62 })
const shoreScope = state => ({ profile: state.profile, realmId: String(state.realm?.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), deathId: state.lifecycle?.deathId ?? state.deathId })
const shoreSegment = (p, a, b) => {
  const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * delta.x + (p.y - a.y) * delta.y + (p.z - a.z) * delta.z) / length)) : 0
  return shoreDistance(p, { x: a.x + delta.x * t, y: a.y + delta.y * t, z: a.z + delta.z * t })
}
function freezeShore (value) { if (value && typeof value === 'object') { Object.values(value).forEach(freezeShore); Object.freeze(value) }; return value }

async function learningShore (input, selectedTarget = null) {
  const { world, destination = null, validate = () => input.state, signal, now = Date.now, yieldControl = () => new Promise(resolve => setImmediate(resolve)) } = input
  const originHealth = input.state?.health
  const diagnostic = { candidates: 0, previews: 0, rejected: [], riskAccepted: false }
  const fail = (message, code) => { throw new RecoveryError(message, code) }
  const cube = block => block.shapes.length === 1 && block.shapes[0].every((v, i) => Math.abs(v - [0, 0, 0, 1, 1, 1][i]) <= 1e-9)
  const id = value => { try { return value == null || !/^-?\d+$/.test(String(value)) ? null : String(BigInt(value)) } catch { return null } }
  let physics, navigator, origin, originScope, surfaceY, seed, bindings, state
  const start = now()
  const expired = () => { if (signal?.aborted) fail('Learning shore planning aborted', 'ABORTED'); if (now() - start > 1800) fail('Learning shore planning deadline exceeded', 'TIMEOUT') }
  function living (s) {
    if (s?.threatPolicy !== 'online_learning' || s.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || s.spawnPending || !Number.isFinite(s.health) || !(s.health > 0 && s.health <= 20) || !['survival', 0].includes(s.gameMode) || !finite(s.position)) fail('Explicit living online-learning state required', 'NOT_READY')
    if (!s.profile || s.realm?.id == null || !s.connectionId || !s.startedAt || !['overworld', 'nether', 'end'].includes(s.dimension) || id(s.runtimeEntityId) === null || !Number.isSafeInteger(s.lifecycle?.deathId ?? s.deathId)) fail('Current life and world scope required', 'SCOPE_UNKNOWN')
    if (s.inventory?.known !== true || s.inventory.uncertain || !Number.isFinite(s.breath?.current) || !(s.breath.current > 0 && s.breath.current <= s.breath.maximum && Number.isFinite(s.breath.maximum)) || !Array.isArray(s.entities)) fail('Known inventory, breath and actor observations required', 'OBSERVATION_UNKNOWN')
    const physical = s.predicted?.physicsState ?? s.physicsState
    if (!physical || !finite(physical.velocity) || physical.isInLava) fail('Actual working physics metadata required', 'PHYSICS_UNKNOWN')
  }
  function body (p) {
    if (!finite(p) || p.y < surfaceY - 1.6 || p.y > surfaceY + 1.5 || p.y + 1.62 < surfaceY + 0.02) return false
    for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++) for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) {
      const head = physics.blockAt({ x, y: Math.floor(p.y + 1.62), z })
      if (!SHORE_AIR.has(head.name) || head.shapes.length) return false
      for (let y = Math.floor(p.y + 1e-6); y <= Math.floor(p.y + 1.8 - 1e-6); y++) {
        const block = physics.blockAt({ x, y, z })
        if (block.shapes.length || !SHORE_AIR.has(block.name) && !SHORE_WATER.has(block.name) || SHORE_WATER.has(block.name) && (!Number.isInteger(block.metadata) || block.metadata < 0 || block.metadata >= 8)) return false
      }
    }
    return true
  }
  function dry (p) {
    if (!body(p) || Math.abs(p.y - surfaceY) > CONTACT) return false
    for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++) for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) {
      const floor = physics.blockAt({ x, y: surfaceY - 1, z })
      if (!SUPPORT.has(floor.name) || !cube(floor)) return false
      if (['sand', 'red_sand'].includes(floor.name)) {
        let stable = false
        for (let depth = 1; depth <= 8; depth++) { const below = physics.blockAt({ x, y: surfaceY - 1 - depth, z }); if (!SUPPORT.has(below.name) || !cube(below)) return false; if (!['sand', 'red_sand'].includes(below.name)) { stable = true; break } }
        if (!stable) return false
      }
      for (let y = surfaceY; y <= surfaceY + 1; y++) if (!SHORE_AIR.has(physics.blockAt({ x, y, z }).name)) return false
    }
    return true
  }
  function canonical (s) {
    const observed = require('./threats').evaluateThreats(s, s.entities, { observationRadius: 32, now })
    if (observed.requiresObservation || s.entityStats?.unknownPositions > observed.unknownPositions.length) fail('Canonical actor positions are incomplete', 'ACTOR_UNKNOWN')
    const current = new Set(observed.threats.map(a => a.runtimeId))
    const actors = [...observed.threats, ...observed.outsideDanger, ...observed.suppressedByTerrain]
    if (actors.length > 64) fail('Canonical actor limit exceeded', 'ACTOR_LIMIT')
    const seen = new Set(), unique = new Set()
    return actors.map(a => {
      const e = s.entities.find(e => id(e.runtimeId) === a.runtimeId), uid = id(e?.uniqueId)
      if (!e || uid === null || seen.has(a.runtimeId) || unique.has(uid) || e.dimension !== s.dimension || e.positionKnown !== true || !finite(e.position) || e.entityType !== a.name) fail('Canonical actor identity or dimension is unknown', 'ACTOR_UNKNOWN')
      if (a.category === 'boss' || ['minecraft:warden', 'minecraft:wither', 'minecraft:ender_dragon'].includes(a.name) || a.name === 'minecraft:creeper' && (e.primed || e.ignited || e.exploding || e.charged || e.isCharged || e.primed !== false && ['creeper_prime_fuse', 32].includes(e.lastEvent?.event))) fail('Boss or primed/charged creeper is outside this risk policy', 'ACTOR_UNSUPPORTED')
      seen.add(a.runtimeId); unique.add(uid)
      const hard = a.name === 'minecraft:creeper' ? 5.5 : ['ranged', 'ranged_possible'].includes(a.category) ? 4 : 3.5
      return { id: a.runtimeId, uniqueId: uid, name: a.name, dimension: e.dimension, position: copy(e.position), dangerRadius: a.dangerRadius, initialDistance: shoreDistance(s.position, e.position), hardMinimum: hard, currentThreat: current.has(a.runtimeId) }
    })
  }
  function refreshBindings (s) {
    const fresh = canonical(s)
    if (fresh.length !== bindings.length) fail('Canonical actor set changed', 'ACTORS_CHANGED')
    return bindings.map(old => {
      const next = fresh.find(a => a.id === old.id)
      if (!next || next.uniqueId !== old.uniqueId || next.name !== old.name || next.dimension !== old.dimension || next.dangerRadius !== old.dangerRadius) fail('Actor UID, type, dimension or policy changed', 'ACTORS_CHANGED')
      return { ...old, position: next.position }
    })
  }
  async function fresh () {
    expired(); await yieldControl(); expired()
    const s = await validate(); living(s)
    if (JSON.stringify(shoreScope(s)) !== JSON.stringify(originScope)) fail('Current life or scope changed', 'SESSION_CHANGED')
    if (s.health < originHealth) fail('Observed damage interrupted planning', 'DAMAGE')
    if (horizontal(s.position, origin) > 0.35) fail('Planning origin moved horizontally', 'ORIGIN_CHANGED')
    const feet = { ...s.position, y: s.position.y - 1.62 }
    if (!body(feet)) fail('Current body or head is no longer known clear', 'BODY_UNKNOWN')
    state = s; bindings = refreshBindings(s)
    return s
  }
  const segmentAllowed = (from, to) => horizontal(origin, to) <= 1.5 && body(to) && bindings.every(a => shoreSegment(a.position, shoreEye(from), shoreEye(to)) >= a.minDistance - 1e-4)
  const pathAllowed = trace => trace.every((p, index) => segmentAllowed(trace[Math.max(0, index - 1)].position, p.position))
  async function prove (target) {
    await fresh()
    const initial = physics.fromServer(state)
    const proofOriginUpdatedAt = state.positionUpdatedAt ?? null
    if (horizontal(initial.position, target) > 1.25 || Math.abs(target.y - surfaceY) > CONTACT || !dry(target)) return null
    if (destination && horizontal(target, destination) >= horizontal(initial.position, destination) - 0.02) return null
    const circles = bindings.map(a => ({ id: a.id, position: copy(a.position), minDistance: a.minDistance, padding: 0 }))
    const options = { allowWater: true, emergency: true, exactGoal: true, maxDistance: 2, maxExpanded: 500, maxTicks: 40, sprint: false, avoidance: circles }
    diagnostic.previews++
    const route = navigator.plan(initial, target, options)
    if (!route.ready) { diagnostic.rejected.push({ target: copy(target), reason: route.reason }); return null }
    const stepper = navigator.createStepper(route, initial, { maxTicks: 40, sprint: false })
    const trace = [{ position: copy(initial.position), velocity: copy(initial.velocity), controls: {}, phase: 'origin', onGround: initial.onGround, isInWater: initial.isInWater }]
    let terminal = null
    for (let tick = 0; tick < 40; tick++) {
      if (tick && tick % 8 === 0) await fresh()
      const frame = stepper.next(), p = frame.predictedState
      trace.push({ position: copy(p.position), velocity: copy(p.velocity), controls: copy(frame.controls), phase: frame.phase, onGround: p.onGround, isInWater: p.isInWater })
      if (p.isInLava || !segmentAllowed(trace.at(-2).position, p.position)) return null
      if (frame.phase === 'awaiting_server_confirmation') { terminal = p; break }
      if (frame.phase !== 'moving') return null
    }
    if (!terminal || terminal.onGround !== true || terminal.isInWater || !dry(terminal.position) || horizontal(terminal.position, target) > 0.35) return null
    const executionTicks = trace.length - 1
    for (let tick = 0; tick < 8; tick++) { terminal = physics.step(terminal, {}); trace.push({ position: copy(terminal.position), velocity: copy(terminal.velocity), controls: {}, phase: 'neutral_coast', onGround: terminal.onGround, isInWater: terminal.isInWater }); if (terminal.isInLava || terminal.isInWater || !terminal.onGround || !dry(terminal.position) || !segmentAllowed(trace.at(-2).position, terminal.position)) return null }
    await fresh()
    if (!pathAllowed(trace)) return null
    return freezeShore({ ready: true, target: copy(target), options: { ...options, avoidance: bindings.map(a => ({ id: a.id, position: copy(a.position), minDistance: a.minDistance, padding: 0 })) }, trace, circles: bindings.map(a => ({ id: a.id, position: copy(a.position), minDistance: a.minDistance, padding: 0 })), originScope: copy(originScope), actorBindings: copy(bindings), originPosition: copy(initial.position), originUpdatedAt: proofOriginUpdatedAt, surfaceY, executionTicks, neutralCoastTicks: 8, predictionOnly: true, serverConfirmed: false, riskAccepted: true, risk: 'Explicit online learning accepts limited approach to active ordinary foes; projectile avoidance and safe arrival are not claimed', diagnostic: { ...diagnostic, riskAccepted: true } })
  }
  try {
    if (typeof world?.getBlock !== 'function' || typeof validate !== 'function' || typeof yieldControl !== 'function' || typeof now !== 'function') fail('Known world and fresh-state callbacks required', 'INVALID_INPUT')
    state = input.state; living(state); originScope = shoreScope(state)
    physics = input.physics ?? input.navigator?.physics ?? createPhysics({ world, version: '1.26.60', allowWater: true })
    navigator = input.navigator ?? require('./navigation').createNavigator({ world, version: '1.26.60', allowWater: true, physics })
    if (navigator.physics !== physics || physics.capabilities?.version !== '1.26.60' || physics.capabilities.water === 'disabled') fail('The actual water-enabled native navigator is required', 'NATIVE_REQUIRED')
    seed = physics.fromServer(state); origin = copy(seed.position)
    surfaceY = physics.waterSurface(origin)?.surfaceY
    if (!Number.isInteger(surfaceY) || !body(origin)) fail('Known water surface with the actual head above it required', 'SURFACE_REQUIRED')
    let wet = false
    for (let y = Math.floor(origin.y); y <= Math.floor(origin.y + 1.8); y++) if (SHORE_WATER.has(physics.blockAt({ ...origin, y }).name)) wet = true
    if (!wet) fail('The received working body is not in water', 'WATER_REQUIRED')
    if (destination !== null && (!finite(destination) || destination.y < -64 || destination.y > 320)) fail('Explicit destination must be a valid 3D point', 'INVALID_DESTINATION')
    const observed = canonical(state)
    bindings = input.actorBindings ? copy(input.actorBindings) : observed.map(a => ({ ...a, minDistance: a.currentThreat ? Math.max(a.hardMinimum, a.initialDistance - 1.25) : a.dangerRadius }))
    if (input.originScope && JSON.stringify(input.originScope) !== JSON.stringify(originScope)) fail('Pinned plan scope changed', 'SESSION_CHANGED')
    bindings = refreshBindings(state)
    if (bindings.some(a => !(Number.isFinite(a.initialDistance) && Number.isFinite(a.minDistance) && Number.isFinite(a.hardMinimum)) || a.minDistance < a.hardMinimum || a.currentThreat && a.minDistance < a.initialDistance - 1.25 || !a.currentThreat && a.minDistance < a.dangerRadius || shoreDistance(state.position, a.position) < a.hardMinimum)) fail('Origin or pinned actor floor is outside the bounded risk policy', 'ACTOR_TOO_CLOSE')
    if (selectedTarget) { const result = await prove(selectedTarget); return result ?? freezeShore({ ready: false, code: 'NO_PROVEN_SHORE', diagnostic }) }
    const candidates = [], seen = new Set()
    for (let x = Math.floor(origin.x) - 2; x <= Math.floor(origin.x) + 2; x++) for (let z = Math.floor(origin.z) - 2; z <= Math.floor(origin.z) + 2; z++) {
      const points = [{ x: Math.max(x + 0.3001, Math.min(x + 0.6999, origin.x)), y: surfaceY, z: Math.max(z + 0.3001, Math.min(z + 0.6999, origin.z)) }, { x: x + 0.5, y: surfaceY, z: z + 0.5 }, { x: origin.x + x - Math.floor(origin.x), y: surfaceY, z: origin.z + z - Math.floor(origin.z) }]
      for (const p of points) { const k = key(p); if (seen.has(k) || horizontal(origin, p) < 0.2 || horizontal(origin, p) > 1.25) continue; seen.add(k); try { if (dry(p) && (!destination || horizontal(p, destination) < horizontal(origin, destination) - 0.02)) candidates.push(p) } catch {} }
    }
    candidates.sort((a, b) => horizontal(origin, a) - horizontal(origin, b) || a.x - b.x || a.z - b.z)
    diagnostic.candidates = candidates.length
    for (const p of candidates.slice(0, 12)) { const result = await prove(p); if (result) return result }
    return freezeShore({ ready: false, code: 'NO_PROVEN_SHORE', diagnostic })
  } catch (error) { return freezeShore({ ready: false, code: error.code ?? 'SHORE_PROOF_FAILED', reason: error.message, diagnostic }) }
}

async function planLearningShore (input) { return learningShore(input) }
async function proveLearningShoreRoute (input) { return learningShore(input, input.target) }

module.exports = { createRecovery, RecoveryError, planLearningShore, proveLearningShoreRoute, surfaceShoreRoute }
