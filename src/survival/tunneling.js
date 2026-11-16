'use strict'

const { resourceMinHealth } = require('../safety/learning-health')

const { setTimeout: sleep } = require('node:timers/promises')
const { evaluateThreats } = require('../combat/threats')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLOOR = new Set(['crafting_table', 'furnace', 'lit_furnace', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'netherrack', 'blackstone', 'basalt', 'smooth_basalt', 'obsidian', 'crying_obsidian', 'bedrock', ...['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'emerald', 'diamond'].flatMap(name => [`${name}_ore`, `deepslate_${name}_ore`])])
const DIG = new Map([
  ...['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'moss_block'].map(name => [name, 0]),
  ...['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'netherrack', 'coal_ore', 'deepslate_coal_ore', 'nether_quartz_ore'].map(name => [name, 1]),
  ...['iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'lapis_ore', 'deepslate_lapis_ore'].map(name => [name, 2]),
  ...['gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore'].map(name => [name, 3])
])
const ORES = new Map(['coal', 'iron', 'diamond'].flatMap((resource, index) => [`${resource}_ore`, `deepslate_${resource}_ore`].map(name => [name, { resource, tier: index + 1 }])))
for (const name of ['stone', 'deepslate']) ORES.set(name, { resource: 'stone', tier: 1 })
// An ore this far below the feet may be approached by a partial route (see plan).
const DEEP = 8
const STONE_BOUNDS = { maxDistance: 6, maxVertical: 6, maxRouteSteps: 6, maxRouteDigBlocks: 16, maxExpanded: 3000 }
const TIERS = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|sweet_berry_bush|wither_rose|pointed_dripstone|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding)/
const FACES = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const CONTACT = 1e-4
const SKIN = 1e-3
const REFUSED_MS = 300000
const RISE_CHECK = 3
const RISE_PROBE = 400
const REFUSED_LIMIT = 24
// Block names repeat endlessly in a search: the stripped name and the hazard
// answer are remembered per name (a regex per block read was a fifth of a search).
const NAMES = new Map(), HAZARDS = new Map()
const nameOf = block => {
  const raw = typeof block === 'string' ? block : block?.name
  let name = NAMES.get(raw)
  if (name === undefined) { name = String(raw ?? '').replace(/^minecraft:/, ''); if (NAMES.size < 4096) NAMES.set(raw, name) }
  return name
}
const hazardName = name => {
  let hazard = HAZARDS.get(name)
  if (hazard === undefined) { hazard = HAZARD.test(name); if (HAZARDS.size < 4096) HAZARDS.set(name, hazard) }
  return hazard
}
const copy = value => structuredClone(value)
const { pointKey: key } = require('../common/vec3')
const { createOpenList } = require('../common/open-list')
const { createFailureMemo } = require('./tunnel-failure-memo')
const { cellKey } = require('../movement/plan-cache')
// Search-internal id of a cell (one number); preserved floors keep their "x,y,z" keys.
const { emptyDug } = require('./tunnel-dug')
const cid = point => cellKey(point.x, point.y, point.z)
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const { finitePoint: finite } = require('../common/vec3')
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
const layered = block => block.extra?.some(extra => !AIR.has(nameOf(extra)))
const clear = block => block.known === true && !hazardName(nameOf(block)) && !layered(block) && (AIR.has(nameOf(block)) || block.boundingBox === 'empty')
const floor = block => block.known === true && block.boundingBox === 'block' && FLOOR.has(nameOf(block)) && !hazardName(nameOf(block)) && !layered(block)
const { isLoose, settledLoose } = require('../common/standing-ground')
const looseFloor = block => block?.known === true && block.boundingBox === 'block' && isLoose(block.name) && !layered(block)
const center = cell => ({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 })
function segmentDistance (point, from, to) {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
  const ratio = length ? Math.max(0, Math.min(1, ((point.x - from.x) * delta.x + (point.y - from.y) * delta.y + (point.z - from.z) * delta.z) / length)) : 0
  return Math.hypot(point.x - from.x - delta.x * ratio, point.y - from.y - delta.y * ratio, point.z - from.z - delta.z * ratio)
}
const positionConfirmed = state => state.positionSource !== 'client_prediction' && (state.positionServerConfirmed === true || ['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource))

class TunnelingError extends Error {
  constructor (message, code, details = {}) { super(message); this.code = code; Object.assign(this, details) }
}

// Planning air exists only inside a candidate path after a known, diggable
// block has been scheduled. It never enters world/getState or a live packet.
function createTunneling ({ getState, world, excavation, movement, getMovement, mining, getPreservedFloors = () => [], onPreserveFloor = () => {}, onProgress = () => {}, registry, timeoutMs = 45000, batchTimeoutMs = 120000, pollMs = 100, clock = Date.now, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }) }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || typeof excavation?.execute !== 'function' || typeof excavation?.preview !== 'function' || typeof excavation?.stop !== 'function' || ['preview', 'start', 'stop'].some(method => typeof movement?.[method] !== 'function') || typeof getMovement !== 'function' || typeof mining?.preview !== 'function') throw new Error('Tunneling requires state, world and owned excavation/movement/mining callbacks')
  if (![timeoutMs, batchTimeoutMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs > 120000 || batchTimeoutMs > 300000 || pollMs > 1000) throw new Error('Invalid tunneling deadlines')
  if (typeof getPreservedFloors !== 'function' || typeof onPreserveFloor !== 'function') throw new Error('Tunneling floor preservation callbacks must be functions')
  registry ??= require('prismarine-registry')('bedrock_1.26.60')
  let active = null
  const preservedFloors = new Map()
  // Standing cells where the geometric line of sight held but the live mining
  // preview refused the ore. Planning must look for another cell, not repeat.
  const refused = { target: null, cells: new Map() }
  // No-route answers, reused until the received terrain changes (tunnel-failure-memo.js).
  const failures = createFailureMemo({ now: clock })
  function refusedCells (target) {
    if (refused.target !== key(target)) { refused.target = key(target); refused.cells.clear() }
    for (const [id, at] of refused.cells) if (clock() - at > REFUSED_MS) refused.cells.delete(id)
    return refused.cells
  }
  let status = { phase: 'idle', busy: false, steps: [], digBlocks: 0, target: null, position: null, positionSource: null, serverConfirmed: false, oreAccessible: false, collected: false, reason: null, cleanupErrors: [] }

  function toolOf (state, requiredTier) {
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
    const tool = state.inventory.items.find(item => item.slot === slot && item.count === 1)
    const name = nameOf(tool)
    if (!Number.isInteger(slot) || slot < 0 || slot > 8 || !tool || state.equipmentServerConfirmed === false || nameOf(state.heldItem) !== name || state.heldItem?.slot != null && state.heldItem.slot !== slot || !(TIERS[name] >= requiredTier)) throw new TunnelingError('A server-confirmed selected pickaxe of the required tier is needed', 'TOOL_REQUIRED')
    const maximum = registry.itemsByName?.[name]?.maxDurability
    // Bedrock 1.26.60 serializes tool wear as NBT Damage, not item metadata.
    // The host must normalize that server observation; metadata is never used.
    const used = tool.durabilityUsed ?? tool.damage ?? (Number.isSafeInteger(tool.durabilityRemaining) && Number.isSafeInteger(maximum) ? maximum - tool.durabilityRemaining : undefined)
    if (tool.durabilityKnown === false || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(used) || used < 0 || used > maximum) throw new TunnelingError('Normalized server NBT Damage is required; tool metadata is not durability', 'DURABILITY_UNKNOWN')
    if (used >= maximum) throw new TunnelingError('The selected tool is exhausted', 'TOOL_EXHAUSTED')
    return { slot, name: `minecraft:${name}`, tier: TIERS[name], used, maximum, remaining: maximum - used }
  }

  function stateOf (baseline, tier = 1) {
    const state = getState()
    if (state?.phase !== 'spawned' || state.dead || state.lifecycle?.dead || !finite(state.position)) throw new TunnelingError('A living spawned player and a known working position are required', 'NOT_READY')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new TunnelingError('Tunneling is survival-only', 'UNSUPPORTED_MODE')
    if (!Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new TunnelingError('Health is low or unknown', 'LOW_HEALTH')
    if (state.inventory?.known !== true || state.inventory.uncertain || !Array.isArray(state.inventory.items)) throw new TunnelingError('Server inventory is unknown or uncertain', 'INVENTORY_UNKNOWN')
    if (state.inventory.full || new Set(state.inventory.items.filter(item => item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot)).size >= 36) throw new TunnelingError('Inventory is full', 'INVENTORY_FULL')
    if (baseline) {
      if (['dimension', 'startedAt', 'connectionId'].some(field => baseline[field] != null && state[field] !== baseline[field])) throw new TunnelingError('The tunneling session changed', 'SESSION_CHANGED')
      if (state.health < baseline.health) throw new TunnelingError('The player took damage while tunneling', 'TOOK_DAMAGE')
    }
    const actors = [state.entities, state.hostiles, state.nearbyHostiles, state.threats].find(Array.isArray)
    const evaluation = evaluateThreats(state, actors, { observationRadius: 32 })
    if (evaluation.threats.length) throw new TunnelingError('A hostile actor is within the avoidance radius', 'NEARBY_THREAT')
    if (evaluation.requiresObservation) throw new TunnelingError('Actor positions require another observation', 'THREAT_OBSERVATION_UNKNOWN')
    // Current cover is not a promise about a future tunnel. Keep every known
    // hostile circle, including actors suppressed only at the present pose.
    const avoidance = [...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].map(actor => ({ id: actor.runtimeId, position: copy(actor.position), minDistance: actor.dangerRadius, padding: 0 }))
    if (avoidance.length > 64 || avoidance.some(circle => typeof circle.id !== 'string' || !circle.id.length || circle.id.length > 80 || !finite(circle.position) || ['x', 'y', 'z'].some(axis => Math.abs(circle.position[axis]) > 30000000) || !Number.isFinite(circle.minDistance) || circle.minDistance < 0 || circle.minDistance > 64) || new Set(avoidance.map(circle => circle.id)).size !== avoidance.length) throw new TunnelingError('Actor identities or avoidance circles require another observation', 'THREAT_OBSERVATION_UNKNOWN')
    return { state, tool: toolOf(state, tier), avoidance }
  }

  function stoneScope (state) {
    const life = state.lifecycle?.deathId ?? state.deathId
    if (state.isDead || state.spawnPending || typeof state.profile !== 'string' || !state.profile || !/^\d+$/.test(String(state.realm?.id ?? '')) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !/^\d+$/.test(String(state.runtimeEntityId ?? '')) || !['overworld', 'nether', 'end'].includes(state.dimension) || !Number.isSafeInteger(life) || life < 0) throw new TunnelingError('Stone access requires the current full living session scope', 'SCOPE_UNKNOWN')
    return JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId), life])
  }
  function stoneTargetFloor (ore, state, floors = null) {
    if (ore.resource !== 'stone') return
    floors ??= preserved()
    for (const point of footprintFloors(state)) floors.set(key(point), point)
    if (floors.has(key(ore.target))) throw new TunnelingError('The stone target is a current or preserved return floor', 'PRESERVED_FLOOR_TARGET')
  }

  function oreOf (decision) {
    if (!integer(decision?.target) || decision.target.y < -64 || decision.target.y > 319) throw new TunnelingError('The ore target needs an integer block coordinate', 'INVALID_TARGET')
    const block = world.getBlock(decision.target.x, decision.target.y, decision.target.z)
    if (block?.known !== true) throw new TunnelingError('The target ore has not been observed', 'RESOURCE_UNKNOWN')
    const name = nameOf(block)
    const info = ORES.get(name)
    const expected = decision.block ?? decision.targetOre?.name
    if (!info || info.resource === 'stone' && decision.resource !== 'stone' || expected != null && nameOf(expected) !== name || decision.resource != null && info.resource !== decision.resource || block.protected || block.natural === false || layered(block)) throw new TunnelingError('The target no longer matches the specified ore', 'RESOURCE_CHANGED')
    const tier = Math.max(info.tier, decision.requiredToolTier ?? info.tier)
    if (!Number.isSafeInteger(tier) || tier < 1 || tier > 5) throw new TunnelingError('Invalid tool tier', 'INVALID_TARGET')
    return { target: { ...decision.target }, name: block.name, resource: info.resource, tier }
  }

  // Received ground under the feet, gravel or sand on solid ground included (common/standing-ground.js).
  const ground = (block, x, y, z) => floor(block) || looseFloor(block) && settledLoose((bx, by, bz) => world.getBlock(bx, by, bz), x, y, z)
  function standing (state) {
    const level = Math.round(state.position.y - 1.62)
    const physics = state.predicted?.physicsState ?? state.predicted ?? state.physicsState
    if (Math.abs(state.position.y - 1.62 - level) > CONTACT || physics?.onGround === false || physics?.isInWater === true) return false
    // Positions are float32 (a step of 0.0005 near 5000): a body against a wall
    // reads up to that far inside the wall cell. The cell under the body centre
    // must be floor; an edge may overhang received clear air (the rim of a hole).
    const cx = Math.floor(state.position.x), cz = Math.floor(state.position.z)
    for (const dx of [-0.3 + SKIN, 0.3 - SKIN]) for (const dz of [-0.3 + SKIN, 0.3 - SKIN]) {
      const x = Math.floor(state.position.x + dx)
      const z = Math.floor(state.position.z + dz)
      const blocks = [level - 1, level, level + 1].map(y => world.getBlock(x, y, z))
      if (!blocks.every(block => block?.known === true) || !clear(blocks[1]) || !clear(blocks[2])) return false
      if (!(ground(blocks[0], x, level - 1, z) || (x !== cx || z !== cz) && clear(blocks[0]) && AIR.has(nameOf(blocks[0])))) return false
    }
    const under = world.getBlock(cx, level - 1, cz)
    return under?.known === true && ground(under, cx, level - 1, cz)
  }

  function footprintFloors (state) {
    const level = Math.round(state.position.y - 1.62)
    const points = new Map()
    for (const dx of [-0.3 + CONTACT, 0.3 - CONTACT]) for (const dz of [-0.3 + CONTACT, 0.3 - CONTACT]) {
      const point = { x: Math.floor(state.position.x + dx), y: level - 1, z: Math.floor(state.position.z + dz) }
      points.set(key(point), point)
    }
    return [...points.values()]
  }

  function preserved () {
    const external = getPreservedFloors()
    if (!Array.isArray(external) || external.some(point => !integer(point) || point.y < -64 || point.y > 319)) throw new TunnelingError('The preserved return-floor observations are invalid', 'PRESERVED_FLOORS_INVALID')
    const result = new Map([...preservedFloors, ...external.map(point => [key(point), { ...point }])])
    if (result.size > 1024) throw new TunnelingError('The preserved return-floor limit was reached', 'PRESERVED_FLOOR_LIMIT')
    return result
  }

  function preserveArrival (before, arrived) {
    // A preview may propose floors, but only a fresh, supported completed step
    // earns a retained floor. Keep the local copy even if persistence fails;
    // never evict an older return stair to make room for a new one.
    const points = new Map([...footprintFloors(before), ...footprintFloors(arrived)].map(point => [key(point), point]))
    const known = preserved()
    // Settled gravel or sand under the feet is a floor too (as in standing); a
    // footprint corner over received air at a hole rim holds nothing to keep.
    // (real Realm 2026-11-17 00:42 JST: on a gravel pile every completed step
    // failed here, 72 decisions with no block dug).
    const centres = new Set([before, arrived].map(state => key({ x: Math.floor(state.position.x), y: Math.round(state.position.y - 1.62) - 1, z: Math.floor(state.position.z) })))
    for (const [id, point] of points) {
      const block = world.getBlock(point.x, point.y, point.z)
      if (!centres.has(id) && block?.known === true && clear(block) && AIR.has(nameOf(block))) continue
      if (!ground(block, point.x, point.y, point.z)) throw new TunnelingError('A completed step lost its supporting return floor', 'PRESERVED_FLOOR_CHANGED')
      if (!known.has(id) && known.size >= 1024) throw new TunnelingError('The preserved return-floor limit was reached', 'PRESERVED_FLOOR_LIMIT')
      known.set(id, point)
      preservedFloors.set(id, point)
      onPreserveFloor({ ...point })
      // Recorded: the shared record holds it now, and may later let far floors
      // go (player-floor-prune.js); a local copy would keep them forever.
      if (getPreservedFloors().some(floor => floor && key(floor) === id)) preservedFloors.delete(id)
    }
  }

  function boundsOf (options = {}, resource) {
    const defaults = resource === 'stone' ? STONE_BOUNDS : { maxDistance: 128, maxVertical: 128, maxRouteSteps: 192, maxRouteDigBlocks: 512, maxExpanded: 3000 }
    const bounds = { ...defaults, ...Object.fromEntries(['maxDistance', 'maxVertical', 'maxRouteSteps', 'maxRouteDigBlocks', 'maxExpanded'].filter(key => options[key] != null).map(key => [key, options[key]])) }
    for (const [name, limit] of Object.entries(resource === 'stone' ? STONE_BOUNDS : { maxDistance: 256, maxVertical: 256, maxRouteSteps: 512, maxRouteDigBlocks: 1536, maxExpanded: 10000 })) if (!Number.isSafeInteger(bounds[name]) || bounds[name] < 1 || bounds[name] > limit) throw new TunnelingError('Invalid bounded tunneling search options', 'INVALID_BOUNDS')
    return bounds
  }

  function plan (decision, options = {}) {
    const ore = oreOf(decision)
    const { state, tool, avoidance } = stateOf(null, ore.tier)
    if (ore.resource === 'stone') stoneScope(state)
    const bounds = boundsOf(options, ore.resource)
    const level = Math.round(state.position.y - 1.62)
    const origin = { x: Math.floor(state.position.x), y: level, z: Math.floor(state.position.z) }
    if (!standing(state)) throw new TunnelingError('Settle on known land before tunneling', 'SETTLE_REQUIRED')
    const initialFloors = preserved()
    for (const point of footprintFloors(state)) initialFloors.set(key(point), point)
    stoneTargetFloor(ore, state, initialFloors)
    const baseFloors = new Set(initialFloors.keys())
    if (initialFloors.size > 1024) throw new TunnelingError('The preserved return-floor limit was reached', 'PRESERVED_FLOOR_LIMIT')
    if (Math.abs(origin.x - ore.target.x) + Math.abs(origin.z - ore.target.z) > bounds.maxDistance || Math.abs(origin.y - ore.target.y) > bounds.maxVertical) throw new TunnelingError('The ore lies outside the bounded tunneling area', 'DISTANCE_LIMIT')
    const cache = new Map()
    const unknown = new Map()
    const rejected = {}
    let searching = false, unknownTerrain = null
    function read (point, removed) {
      const id = cid(point)
      if (!cache.has(id)) cache.set(id, world.getBlock(point.x, point.y, point.z))
      const block = cache.get(id)
      // Inside the search the error is only counted: one shared object, no stack per unknown block.
      if (block?.known !== true) { unknown.set(id, { ...point }); throw searching ? (unknownTerrain ??= new TunnelingError('Unknown terrain', 'UNKNOWN_TERRAIN')) : new TunnelingError(`Unknown terrain at ${key(point)}`, 'UNKNOWN_TERRAIN') }
      return removed?.has(id) ? { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [], plannedClearance: true } : block
    }
    function supported (point, removed) {
      const below = read({ ...point, y: point.y - 1 }, removed)
      return floor(below) || looseFloor(below) && settledLoose((x, y, z) => read({ x, y, z }, removed), point.x, point.y - 1, point.z)
    }
    // Current body corners must be supported too; a nearby centre is no excuse
    // for starting a dig while the real working pose hangs over a ledge.
    for (const dx of [-0.3 + CONTACT, 0.3 - CONTACT]) for (const dz of [-0.3 + CONTACT, 0.3 - CONTACT]) {
      const cell = { x: Math.floor(state.position.x + dx), y: level, z: Math.floor(state.position.z + dz) }
      if (!supported(cell) || !clear(read(cell)) || !clear(read({ ...cell, y: level + 1 }))) throw new TunnelingError('The current body has no known safe standing footprint', 'SETTLE_REQUIRED')
    }
    const eyeOf = cell => ({ x: cell.x + 0.5, y: cell.y + 1.62, z: cell.z + 0.5 })
    // A circle the Bot already stands in only forbids getting closer than it
    // is now; moving within or out of it stays possible (live 2026-11-16
    // 00:01-00:08 JST: 17 non-threat circles, the start inside one, every
    // first step refused, 「expanded 1」 160 times in five minutes).
    const limits = avoidance.map(circle => { const now = Math.hypot(circle.position.x - state.position.x, circle.position.y - state.position.y, circle.position.z - state.position.z); return now < circle.minDistance ? Math.max(0, now - 0.25) : circle.minDistance })
    const allowedEye = eye => avoidance.every((circle, index) => Math.hypot(circle.position.x - eye.x, circle.position.y - eye.y, circle.position.z - eye.z) > limits[index])
    const skipped = refusedCells(ore.target)
    const allowedEdge = (from, to) => avoidance.every((circle, index) => segmentDistance(circle.position, from, to) >= limits[index] - CONTACT)
    function accessible (node) {
      const eye = { x: node.cell.x + 0.5, y: node.cell.y + 1.62, z: node.cell.z + 0.5 }
      if (!allowedEye(eye) || skipped.has(key(node.cell))) return false
      const target = { x: ore.target.x + 0.5, y: ore.target.y + 0.5, z: ore.target.z + 0.5 }
      const distance = Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z)
      if (distance > 4.25 || node.cell.x === ore.target.x && node.cell.z === ore.target.z && ore.target.y <= node.cell.y) return false
      for (const offset of FACES) { const neighbour = read({ x: ore.target.x + offset.x, y: ore.target.y + offset.y, z: ore.target.z + offset.z }, node.removed); if (hazardName(nameOf(neighbour)) || layered(neighbour)) return false }
      const samples = Math.ceil(distance / 0.08)
      for (let index = 0; index < samples; index++) {
        const ratio = index / samples
        const point = { x: Math.floor(eye.x + (target.x - eye.x) * ratio), y: Math.floor(eye.y + (target.y - eye.y) * ratio), z: Math.floor(eye.z + (target.z - eye.z) * ratio) }
        if (!same(point, ore.target)) {
          const block = read(point, node.removed)
          const transparentTorch = block.known === true && nameOf(block) === 'torch' && block.boundingBox === 'empty' && !block.extra?.length
          if (!AIR.has(nameOf(block)) && !transparentTorch) return false
        }
      }
      return true
    }
    function edge (node, next) {
      // Match Native navigation's eye-space circle and swept-segment policy.
      // The first connector starts at the actual working eye, not its cell.
      const from = node.parent ? eyeOf(node.cell) : state.position
      const to = eyeOf(next)
      if (!allowedEye(to) || !allowedEdge(from, to)) { rejected.AVOID = (rejected.AVOID ?? 0) + 1; return null }
      if (ore.resource === 'stone' && key({ ...next, y: next.y - 1 }) === key(ore.target)) return null
      if (!supported(next, node.removed)) return null
      const clearance = []
      for (let y = Math.max(node.cell.y, next.y) + 1; y >= next.y; y--) {
        const point = { x: next.x, y, z: next.z }
        const block = read(point, node.removed)
        if (same(point, ore.target) && !clear(block)) return null
        if (clear(block)) continue
        if (baseFloors.has(key(point)) || node.preservedFloors.has(key(point))) return null
        if (next.y > node.cell.y || !DIG.has(nameOf(block)) || DIG.get(nameOf(block)) > tool.tier || block.diggable === false || block.protected || block.natural === false || hazardName(nameOf(block)) || layered(block)) return null
        for (const offset of FACES) { const neighbour = read({ x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z }, node.removed); if (hazardName(nameOf(neighbour)) || layered(neighbour)) return null }
        clearance.push(point)
      }
      if (next.y > node.cell.y) for (const cell of [node.cell, next]) for (let y = Math.max(node.cell.y, next.y); y <= Math.max(node.cell.y, next.y) + 1; y++) if (!clear(read({ ...cell, y }, node.removed))) return null
      // A step that digs nothing shares its parent's set; one that digs links to it (tunnel-dug.js).
      const removed = node.removed.with(clearance.map(cid))
      if (removed.size > bounds.maxRouteDigBlocks) return null
      // Only the floors this path adds are copied; the preserved ones are shared
      // (copying hundreds of them per edge froze the Bot for seconds).
      const floorId = key({ ...next, y: next.y - 1 })
      const floors = baseFloors.has(floorId) || node.preservedFloors.has(floorId) ? node.preservedFloors : new Set(node.preservedFloors).add(floorId)
      if (baseFloors.size + floors.size > 1024) return null
      return { cell: next, removed, preservedFloors: floors, clearance, kind: clearance.length ? 'excavate' : 'move', target: center(next) }
    }
    const horizontal = cell => Math.abs(cell.x - ore.target.x) + Math.abs(cell.z - ore.target.z)
    const heuristic = cell => Math.max(Math.max(0, horizontal(cell) - 1), Math.abs(cell.y - (ore.target.y - 1)))
    const start = { cell: origin, removed: emptyDug(), preservedFloors: new Set(), g: 0, h: heuristic(origin), parent: null, step: null, depth: 0 }
    start.f = start.h * 2
    const records = new Map([[cid(origin), start]])
    // Best first by f, then h, then horizontal distance (common/open-list.js).
    const open = createOpenList({ records, before: (a, b) => a.f < b.f || a.f === b.f && (a.h < b.h || a.h === b.h && a.horizontal < b.horizontal) })
    const push = (id, record) => open.push(id, record, { f: record.f, h: record.h, horizontal: horizontal(record.cell) })
    push(cid(origin), start)
    const closed = new Set()
    let found = null, nearest = null
    let expanded = 0
    // A tunnel only digs level or down: rising needs open air already there.
    // When the ore lies well above and no open way up turned up early, the full
    // search would only fail at its limit (real Realm 2026-11-16 11:12-11:32
    // JST: coal 58 blocks up, the search ran to 3000 nodes every 8-10 s).
    const rising = ore.target.y >= origin.y + RISE_CHECK
    let highest = origin.y
    // Hostile circles move, and a world without a terrain version cannot say
    // when it changed: no reuse then.
    const terrain = world.revision?.()
    const memoKey = !avoidance.length && Number.isSafeInteger(terrain) ? JSON.stringify([terrain, ore.target, ore.resource, ore.tier, origin, tool.tier, bounds, initialFloors.size, skipped.size]) : null
    const known = failures.get(memoKey)
    if (known) throw new TunnelingError(known.message, 'NO_SAFE_ROUTE', { ...known.details, reused: true })
    const noRoute = reason => {
      // What the search saw goes into the stop text: the live log is the only
      // place to read it (2026-11-16 22:01-22:06 JST: a deep ore failed 142
      // times with no clue why, while the same terrain offline found a route).
      const counts = Object.entries(rejected).map(([code, count]) => `${code} ${count}`).join(', ')
      const message = `${reason} (expanded ${expanded}, nearest h ${nearest?.h ?? '-'} of ${start.h}, unknown ${unknown.size}, floors ${baseFloors.size}, avoid ${avoidance.length}${counts ? `, rejected ${counts}` : ''})`
      const details = { unknownFrontier: [...unknown.values()].slice(0, 32), expanded, rejected }
      failures.set(memoKey, { message, details })
      return new TunnelingError(message, 'NO_SAFE_ROUTE', details)
    }
    searching = true
    while (open.size && expanded < bounds.maxExpanded) {
      if (rising && expanded >= RISE_PROBE && highest <= origin.y) throw noRoute('The ore lies above and no known open way up was found')
      const id = open.pop()
      if (id === null) break
      const node = records.get(id)
      if (!nearest || node.h < nearest.h || node.h === nearest.h && node.g < nearest.g) nearest = node
      try { if (accessible(node)) { found = node; break } } catch (error) { rejected[error.code] = (rejected[error.code] ?? 0) + 1 }
      closed.add(id)
      expanded++
      if (node.depth >= bounds.maxRouteSteps) continue
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, 0, 1]) {
        const next = { x: node.cell.x + dx, y: node.cell.y + dy, z: node.cell.z + dz }
        const nextId = cid(next)
        if (closed.has(nextId) || next.y < Math.max(-63, Math.min(origin.y, ore.target.y) - 2) || Math.abs(next.y - origin.y) > bounds.maxVertical || Math.abs(next.x - origin.x) + Math.abs(next.z - origin.z) > bounds.maxDistance) continue
        try {
          const step = edge(node, next)
          if (!step) continue
          const g = node.g + 1 + step.clearance.length * 0.08 + (dy > 0 ? 0.25 : 0)
          if (records.has(nextId) && records.get(nextId).g <= g) continue
          const h = heuristic(next)
          const record = { cell: next, removed: step.removed, preservedFloors: step.preservedFloors, g, h, f: g + h * 2, depth: node.depth + 1, parent: node, step }
          records.set(nextId, record)
          push(nextId, record)
          if (next.y > highest) highest = next.y
        } catch (error) { rejected[error.code] = (rejected[error.code] ?? 0) + 1 }
      }
    }
    searching = false
    // Far below, a search that ran out of nodes, or out of known diggable
    // terrain, still takes the Bot part of the way down: the route to the node
    // nearest the ore, when it gains 4 or more; nearer, more terrain arrives
    // (real Realm 2026-11-16 21:36-21:42 JST: a diamond ore 70 blocks below the
    // surface, every plan ended at the limit with no step, 115 times in 5 min;
    // 21:47-21:51 JST: another, 「No complete route through known safe
    // diggable terrain」 58 times).
    const descent = !found && ore.target.y <= origin.y - DEEP && nearest && nearest !== start && start.h - nearest.h >= 4
    if (descent) found = nearest
    if (!found) throw noRoute(expanded >= bounds.maxExpanded ? 'The bounded tunneling search limit was reached' : 'No complete route through known safe diggable terrain')
    if (ore.resource === 'stone' && found.removed.size + 2 > tool.remaining) throw new TunnelingError('Insufficient known durability for the bounded stone approach and target', 'TOOL_WORN_OUT')
    const steps = []
    for (let node = found; node.parent; node = node.parent) steps.push({ kind: node.step.kind, targetCell: { ...node.cell }, target: node.step.target, blocksToMine: copy(node.step.clearance) })
    steps.reverse()
    return { ready: true, ...(descent ? { partialRoute: true, reason: 'No whole route yet; the route goes part of the way down toward the ore' } : {}), target: ore.target, resource: ore.resource, block: ore.name, requiredToolTier: ore.tier, origin: copy(state.position), approach: center(found.cell), steps, plannedDigBlocks: found.removed.size, tool, withinDurability: found.removed.size + 2 <= tool.remaining, expanded, unknownFrontier: [...unknown.values()].slice(0, 32), requiresLivePreview: true, oreAccessible: steps.length === 0, serverConfirmed: false, collected: false }
  }

  function preview (decision, options) {
    try { return plan(decision, options) } catch (error) { return { ready: false, code: error.code ?? 'PLAN_FAILED', reason: error.message, unknownFrontier: error.unknownFrontier ?? [], expanded: error.expanded ?? 0, steps: [], collected: false, serverConfirmed: false } }
  }
  function check (run) {
    if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new TunnelingError('Tunneling cancelled', 'ABORTED')
    if (clock() >= run.deadline) throw new TunnelingError('The tunneling batch timed out', 'TIMEOUT')
  }
  async function call (run, label, fn, timeout = timeoutMs) {
    check(run)
    let timer
    let watchdog
    let abort
    const cancellation = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new TunnelingError('Tunneling cancelled', 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new TunnelingError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(timeout, run.deadline - clock())))
      // Excavation owns its inner mining/movement calls. Keep observing outer
      // inventory/tool/session safety while that asynchronous child runs.
      watchdog = setInterval(() => { try { read(run); oreOf(run.decision) } catch (error) { reject(error) } }, pollMs)
    })
    try { return await Promise.race([Promise.resolve().then(() => { check(run); return fn() }), cancellation]) } finally { clearTimeout(timer); clearInterval(watchdog); run.signal.removeEventListener('abort', abort) }
  }
  function read (run) {
    check(run)
    const observed = stateOf(run.baseline, run.ore.tier)
    if (run.stoneScope != null && stoneScope(observed.state) !== run.stoneScope) throw new TunnelingError('The stone access full session or life changed', 'SESSION_CHANGED')
    if (observed.tool.slot !== run.tool.slot || observed.tool.name !== run.tool.name || observed.tool.used < run.tool.used) throw new TunnelingError('The selected tool changed during the batch', 'TOOL_CHANGED')
    observed.tool.remaining = observed.tool.maximum - Math.max(observed.tool.used, run.tool.used + status.digBlocks)
    if (run.stoneScope != null && observed.tool.remaining < 2) throw new TunnelingError('Insufficient known durability for the stone target and reserve', 'TOOL_WORN_OUT')
    return observed
  }
  function report (phase, details) { status.phase = phase; try { Promise.resolve(onProgress({ phase, ...copy(details) })).catch(() => {}) } catch { /* Progress reporting must not alter an operation. */ } }
  async function cleanup (run, reason) {
    if (run.cleanup) return run.cleanup
    run.cleanup = Promise.allSettled([() => excavation.stop(reason), () => movement.stop(reason)].map(stop => {
      let timer
      return Promise.race([Promise.resolve().then(stop), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Controller stop timed out')), 1000) })]).finally(() => clearTimeout(timer))
    })).then(results => { status.cleanupErrors = results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message ?? result.reason)) })
    return run.cleanup
  }
  async function accessibleNow (run) {
    const { state } = read(run)
    if (!standing(state)) throw new TunnelingError('Settle on known dry land before approaching ore', 'SETTLE_REQUIRED')
    oreOf(run.decision)
    stoneTargetFloor(run.ore, state)
    const result = await call(run, 'Ore mining preview', () => mining.preview([copy(run.ore.target)], { signal: run.signal }))
    read(run)
    if (result?.ready !== true) { run.liveReason = result?.errors?.join(' / ') || null; return false }
    const target = result.targets?.find(target => integer(target.position) && key(target.position) === key(run.ore.target))
    if (nameOf(target) !== nameOf(run.ore.name)) throw new TunnelingError('The live mining preview does not identify the expected ore', 'RESOURCE_CHANGED')
    return true
  }
  async function awaitArrival (run, step, before) {
    const deadline = Math.min(run.deadline, clock() + timeoutMs)
    while (clock() < deadline) {
      const { state } = read(run)
      const motion = await call(run, 'Movement state', () => getMovement())
      if (['failed', 'stopped'].includes(motion?.phase)) throw new TunnelingError(motion.reason ?? 'Movement stopped before arrival', 'MOVEMENT_FAILED')
      const feet = state.position.y - 1.62
      const physics = state.predicted?.physicsState ?? state.predicted ?? state.physicsState
      const near = Math.hypot(state.position.x - step.target.x, state.position.z - step.target.z) <= 0.4 && Math.abs(feet - step.target.y) <= CONTACT
      const fresh = state.positionUpdatedAt != null && state.positionUpdatedAt !== before.positionUpdatedAt
      if (near && fresh && physics?.onGround !== false && physics?.isInWater !== true && !['moving', 'settling', 'walking'].includes(motion?.phase)) {
        if (!standing(state)) throw new TunnelingError('The arrival has no known supported standing footprint', 'SETTLE_REQUIRED')
        return state
      }
      if (motion?.phase === 'replan_required') throw new TunnelingError('A server correction needs a new movement plan', 'REPLAN_REQUIRED')
      await call(run, 'Arrival wait', () => delay(pollMs, run.signal), pollMs + 1000)
    }
    throw new TunnelingError('No fresh grounded working arrival was observed', 'TIMEOUT')
  }
  function finish (run, accessible, reason) {
    const { state } = read(run)
    status.phase = accessible ? 'completed' : 'predicted'
    status.busy = false
    status.position = { ...state.position }
    status.positionSource = state.positionSource ?? 'unknown'
    status.serverConfirmed = positionConfirmed(state)
    status.oreAccessible = accessible
    status.reason = reason
    return { ok: true, ...snapshot(), partial: !accessible, collected: false }
  }
  async function execute (decision, options = {}) {
    if (active) throw new TunnelingError('Another tunneling batch is running', 'BUSY')
    const stone = decision?.resource === 'stone'
    if (stone) boundsOf(options, 'stone')
    const maxSteps = options.maxSteps ?? (stone ? 1 : 3)
    const maxDigBlocks = options.maxDigBlocks ?? (stone ? 3 : 9)
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > (stone ? 1 : 20) || !Number.isSafeInteger(maxDigBlocks) || maxDigBlocks < 0 || maxDigBlocks > (stone ? 3 : 64)) throw new TunnelingError('Invalid tunneling batch limits', 'INVALID_BOUNDS')
    const controller = new AbortController()
    const run = { controller, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, deadline: clock() + batchTimeoutMs, decision: copy(decision), options, ore: null, baseline: null, tool: null, cleanup: null }
    active = run
    status = { phase: 'planning', busy: true, steps: [], digBlocks: 0, target: copy(decision?.target ?? null), position: null, positionSource: null, serverConfirmed: false, oreAccessible: false, collected: false, reason: null, cleanupErrors: [] }
    let completed = false
    try {
      check(run)
      run.ore = oreOf(decision)
      const initial = stateOf(null, run.ore.tier)
      run.baseline = initial.state
      run.stoneScope = run.ore.resource === 'stone' ? stoneScope(initial.state) : null
      run.tool = initial.tool
      for (let index = 0; index < maxSteps; index++) {
        if (await accessibleNow(run)) { const result = finish(run, true, run.ore.resource === 'stone' ? 'The live mining preview can reach the unchanged stone; leave mining to mine_stone' : 'The live mining preview can reach the unchanged ore; leave mining to mine_ore'); completed = true; return result }
        let plan = preview(decision, options)
        if (plan.ready && !plan.steps.length) {
          // The live preview refused the ore from this cell: approach from another one.
          const { state } = read(run)
          const cells = refusedCells(run.ore.target)
          if (cells.size >= REFUSED_LIMIT) throw new TunnelingError(`The live mining preview refused the ore from every tried cell${run.liveReason ? `: ${run.liveReason}` : ''}`, 'MINING_PREVIEW_REJECTED')
          cells.set(key({ x: Math.floor(state.position.x), y: Math.round(state.position.y - 1.62), z: Math.floor(state.position.z) }), clock())
          plan = preview(decision, options)
          if (!plan.ready) throw new TunnelingError(`The geometric approach is not accepted by the live mining preview${run.liveReason ? `: ${run.liveReason}` : ''} (${plan.reason})`, 'MINING_PREVIEW_REJECTED', { unknownFrontier: plan.unknownFrontier })
        }
        if (!plan.ready) throw new TunnelingError(plan.reason, plan.code, { unknownFrontier: plan.unknownFrontier })
        const step = plan.steps[0]
        if (!step) throw new TunnelingError('The geometric approach is not accepted by the live mining preview', 'MINING_PREVIEW_REJECTED')
        const { state: before, tool } = read(run)
        if (status.digBlocks + step.blocksToMine.length > maxDigBlocks) {
          if (!status.steps.length) throw new TunnelingError('The first step exceeds the batch excavation budget', 'DIG_LIMIT')
          const result = finish(run, false, 'The batch excavation budget was reached; reobserve before continuing'); completed = true; return result
        }
        if (tool.remaining < step.blocksToMine.length + 2) throw new TunnelingError('Insufficient known durability to finish the next step and preserve the ore-mining tool', 'TOOL_WORN_OUT')
        report(step.kind === 'excavate' ? 'excavating' : 'moving', { target: step.target, blocksToMine: step.blocksToMine, resource: run.ore.resource })
        let result
        if (step.kind === 'excavate') {
          const live = await call(run, 'Excavation preview', () => excavation.preview({ target: copy(step.targetCell) }))
          const planned = new Set(step.blocksToMine.map(key))
          const floors = preserved()
          for (const point of footprintFloors(before)) floors.set(key(point), point)
          if (!live?.ready || !Array.isArray(live.blocksToMine) || live.blocksToMine.some(point => key(point) === key(run.ore.target) || !planned.has(key(point)) || floors.has(key(point)))) throw new TunnelingError(live?.reason ?? 'The adjacent excavation preview changed or would remove a return floor', 'EXCAVATION_PREVIEW_REJECTED')
          result = await call(run, 'Adjacent excavation', () => excavation.execute({ target: copy(step.targetCell) }, { signal: run.signal }))
          if (result?.ok !== true || result.phase !== 'completed') throw new TunnelingError('Adjacent excavation has not completed', 'EXCAVATION_UNCONFIRMED')
          for (const point of step.blocksToMine) { const block = world.getBlock(point.x, point.y, point.z); if (block?.known !== true || !AIR.has(nameOf(block)) || layered(block)) throw new TunnelingError('Excavation did not produce received air', 'BLOCK_NOT_CONFIRMED') }
          status.digBlocks += step.blocksToMine.length
        } else {
          const moveOptions = () => ({ allowWater: false, maxDistance: 2, signal: run.signal, avoidance: read(run).avoidance })
          const live = await call(run, 'Movement preview', () => movement.preview(copy(step.target), moveOptions()))
          if (!live?.ready) throw new TunnelingError(live?.reason ?? 'The known non-destructive movement path changed', 'MOVEMENT_PREVIEW_REJECTED')
          await call(run, 'Movement start', () => movement.start(copy(step.target), moveOptions()))
        }
        const arrived = await awaitArrival(run, step, before)
        preserveArrival(before, arrived)
        status.steps.push({ ...copy(step), position: copy(arrived.position), positionSource: arrived.positionSource ?? 'unknown', serverConfirmed: positionConfirmed(arrived), ...(step.kind === 'excavate' ? { confirmedBy: 'received_air_and_working_pose' } : {}) })
      }
      const accessible = await accessibleNow(run)
      const result = finish(run, accessible, accessible ? 'The unchanged ore is reachable by the live mining preview' : 'The bounded batch advanced through known terrain; reobserve before the next batch')
      completed = true
      return result
    } catch (error) {
      status.phase = run.signal.aborted ? 'stopped' : 'failed'
      status.reason = error.message
      status.code = error.code ?? 'EXECUTION_FAILED'
      if (!run.signal.aborted) controller.abort(error)
      throw error
    } finally {
      if (!completed) await cleanup(run, status.reason)
      status.busy = false
      if (active === run) active = null
    }
  }
  async function stop (reason = 'Tunneling stopped') {
    if (!active) return snapshot()
    active.controller.abort(new TunnelingError(reason, 'ABORTED'))
    status.phase = 'stopped'
    status.reason = reason
    await cleanup(active, reason)
    return snapshot()
  }
  function snapshot () { return copy(status) }
  plan = require('../common/work-spans').wrap('tunnel.plan', plan) // timed for the stall log
  return { preview, execute, stop, snapshot }
}

module.exports = { createTunneling, TunnelingError }
