'use strict'

const { selectVisibleBlockFace, traceBlockFace } = require('./aim')

const LOG = /^minecraft:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_log$/
const STONE = /^minecraft:(?:stone|cobblestone|deepslate|cobbled_deepslate)$/
const ORE = /^minecraft:(?:deepslate_)?(?:coal|iron|diamond)_ore$/
const same = (a, b) => a && b && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(a[axis]) && a[axis] === b[axis])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const ACCESS_PLANTS = new Set(['minecraft:leaf_litter', 'minecraft:vine'])
const ACCESS_LIMIT = 4
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone|sand$|gravel$|concrete_powder$|anvil$|scaffolding)/
const key = p => `${p.x},${p.y},${p.z}`
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
const OFFSETS = [{ x: 0, z: 0 }, { x: 0.25, z: 0 }, { x: -0.25, z: 0 }, { x: 0, z: 0.25 }, { x: 0, z: -0.25 }, { x: 0.2, z: 0.2 }, { x: 0.2, z: -0.2 }, { x: -0.2, z: 0.2 }, { x: -0.2, z: -0.2 }]

function treeAccessIdentity (state) {
  if (typeof state?.profile !== 'string' || state.realm?.id == null || typeof state.dimension !== 'string' || typeof state.connectionId !== 'string' || typeof state.startedAt !== 'string' || state.runtimeEntityId == null) return null
  return [state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId)]
}

function treeAccessScope (state, observedState = state) {
  const identity = treeAccessIdentity(state)
  const observedIdentity = treeAccessIdentity(observedState)
  const deathId = observedState?.lifecycle?.deathId
  // The internal runtime pose lacks the API lifecycle wrapper. Borrow only
  // the matching observation's life, never another session or a missing zero.
  if (!identity || !observedIdentity || JSON.stringify(identity) !== JSON.stringify(observedIdentity) || !Number.isSafeInteger(deathId) || deathId < 0 || state.lifecycle?.deathId != null && state.lifecycle.deathId !== deathId) return null
  return JSON.stringify([...identity, deathId])
}

function isDryAccessPlant (block) {
  return block?.known === true && ACCESS_PLANTS.has(block.name) && block.boundingBox === 'empty' && block.protected !== true && !block.protectionSource && block.natural !== false && !block.extra?.length
}

function safeAccessPlant (block, getBlock) {
  return isDryAccessPlant(block) && [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(([x, y, z]) => {
    const neighbour = getBlock({ x: block.position.x + x, y: block.position.y + y, z: block.position.z + z })
    return neighbour?.known === true && !HAZARD.test(neighbour.name ?? '') && !neighbour.extra?.some(layer => HAZARD.test(layer.name ?? ''))
  })
}

// This is an obstruction proof for a separate clearing action. It never makes
// vegetation transparent to the wood miner or reports that the tree is ready.
function treeRayPlants (from, target, getBlock) {
  const cells = new Map()
  const cell = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.floor(from[axis])]))
  const direction = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, target[axis] + 0.5 - from[axis]]))
  const step = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.sign(direction[axis])]))
  const delta = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, direction[axis] === 0 ? Infinity : Math.abs(1 / direction[axis])]))
  const crossing = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, direction[axis] === 0 ? Infinity : ((step[axis] > 0 ? cell[axis] + 1 : cell[axis]) - from[axis]) / direction[axis]]))
  function visit (point) {
    if (same(point, target)) return true
    const block = getBlock(point)
    if (block?.known !== true || block.extra?.length || block.protected === true || block.protectionSource) return false
    if (AIR.has(block.name)) return true
    if (!safeAccessPlant(block, getBlock)) return false
    cells.set(key(point), block)
    return cells.size <= ACCESS_LIMIT
  }
  for (let count = 0; count < 128; count++) {
    if (same(cell, target)) return [...cells.values()]
    if (!visit(cell)) return null
    const next = Math.min(crossing.x, crossing.y, crossing.z)
    if (!Number.isFinite(next) || next > 1) return null
    const axes = ['x', 'y', 'z'].filter(axis => Math.abs(crossing[axis] - next) < 1e-10)
    for (let mask = 1; mask < 1 << axes.length; mask++) {
      const touched = { ...cell }
      axes.forEach((axis, index) => { if (mask & 1 << index) touched[axis] += step[axis] })
      if (!visit(touched)) return null
    }
    for (const axis of axes) { cell[axis] += step[axis]; crossing[axis] += delta[axis] }
  }
  return null
}

function planTreeAccess ({ state, observedState, tree, standpoint, getBlock, reach = 4.5 }) {
  const scope = treeAccessScope(state, observedState)
  if (!scope || !finite(standpoint) || typeof getBlock !== 'function' || !same(tree?.position, tree?.position) || tree.known !== true || !LOG.test(tree.name) || tree.protected === true || tree.protectionSource || tree.natural === false || tree.extra?.length) return null
  const eyes = OFFSETS.map(offset => ({ x: standpoint.x + offset.x, y: standpoint.y + 1.62, z: standpoint.z + offset.z }))
  const plants = new Map()
  for (const eye of eyes) {
    if (Math.hypot(eye.x - tree.position.x - 0.5, eye.y - tree.position.y - 0.5, eye.z - tree.position.z - 0.5) > reach - 0.2) return null
    const ray = treeRayPlants(eye, tree.position, getBlock)
    if (!ray) return null
    for (const plant of ray) plants.set(key(plant.position), plant)
    if (plants.size > ACCESS_LIMIT) return null
  }
  if (!plants.size) return null
  const world = { getBlock: (x, y, z) => getBlock({ x, y, z }) }
  const ordered = [...plants.values()].sort((a, b) => {
    const distance = p => Math.hypot(p.x + 0.5 - eyes[0].x, p.y + 0.5 - eyes[0].y, p.z + 0.5 - eyes[0].z)
    return distance(a.position) - distance(b.position) || a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z
  })
  // Clear the nearest obstruction only when every arrival-tolerance sample
  // can strictly aim at it. Subsequent plants require another observation.
  const plant = ordered[0]
  return eyes.every(eye => selectVisibleBlockFace({ eye, target: plant.position, world, maxReach: reach - 0.2 })) ? { kind: 'clear_tree_access', target: { ...plant.position }, block: plant.name, scope, maxPlants: ACCESS_LIMIT, blockers: ordered.map(block => ({ position: { ...block.position }, name: block.name })) } : null
}

// Robust approach stances intentionally use conservative geometry. Once there,
// the actual miner's live visible-face validation decides whether walking is
// still necessary. This changes no block, item, position or confidence value.
function useCurrentAccess (decision, preview) {
  if (decision?.type !== 'move_to' || !decision.resourceTarget || !preview?.ready) return decision
  const target = preview.targets?.find(value => same(value.position, decision.resourceTarget))
  if (!target || target.name !== decision.block) return decision
  const type = decision.resource === 'logs' && LOG.test(target.name) && decision.treeEvidence ? 'gather_logs' : decision.resource === 'stone' && STONE.test(target.name) ? 'mine_stone' : ['coal', 'iron', 'diamond'].includes(decision.resource) && ORE.test(target.name) ? 'mine_ore' : null
  if (!type) return decision
  return { ...decision, type, target: { ...decision.resourceTarget }, reason: '現在の位置から安全に掘れることを最新の地形で確認したため、採取を始めます。', accessSource: 'live_mining_preview' }
}

function stationVisibleFace ({ eye, target, world, maxReach = 4.5 }) {
  if (!finite(eye) || !same(target, target) || typeof world?.getBlock !== 'function') return null
  const block = world.getBlock(target.x, target.y, target.z)
  if (block?.known !== true || block.name !== 'minecraft:crafting_table' || block.extra?.some(layer => layer.known === false || !AIR.has(layer.name))) return null
  const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z
  const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
  const normal = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }][face]
  const point = { x: center.x + normal.x * 0.5, y: center.y + normal.y * 0.5, z: center.z + normal.z * 0.5 }
  const inside = { x: point.x - normal.x * 0.001, y: point.y - normal.y * 0.001, z: point.z - normal.z * 0.001 }
  try {
    const centered = traceBlockFace({ eye, target, point: inside, world, maxReach })
    const visible = centered?.face === face ? { face, point, hit: point } : selectVisibleBlockFace({ eye, target, world, maxReach })
    if (!visible) return null
    return { ...visible, clickPos: { x: Math.max(0, Math.min(1, visible.hit.x - target.x)), y: Math.max(0, Math.min(1, visible.hit.y - target.y)), z: Math.max(0, Math.min(1, visible.hit.z - target.z)) } }
  } catch { return null }
}

// Placement still clicks the ordinary floor-top center. A planner candidate
// must prove the exact ray from the same working eye as Interactions;
// a visible side face would place a different block and is never substituted.
function placementTopVisible ({ state, target, getBlock, maxReach = 4.5 }) {
  if (!finite(state?.position) || !same(target, target) || typeof getBlock !== 'function') return null
  const clicked = { x: target.x, y: target.y - 1, z: target.z }
  const point = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
  const eyes = [state.position]
  const world = { getBlock: (x, y, z) => getBlock({ x, y, z }) }
  for (const eye of eyes) {
    const height = eye.y - point.y
    if (height <= 0.001 || Math.hypot(eye.x - point.x, height, eye.z - point.z) > maxReach) return null
    // Extend the same center ray just inside the support for strict DDA, rather
    // than changing the actual click point or sampling through an obstruction.
    const fraction = 0.001 / height
    const inside = { x: point.x + (point.x - eye.x) * fraction, y: point.y - 0.001, z: point.z + (point.z - eye.z) * fraction }
    try { if (traceBlockFace({ eye, target: clicked, point: inside, world, maxReach })?.face !== 1) return null } catch { return null }
  }
  return { point, clicked, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, testedEyes: eyes.length }
}

// If every current click is blocked, propose a nearby received full stance.
// Movement and placement keep their separate live previews; this is no arrival
// or placement receipt, and it never treats foliage as a transparent ray.
function planPlacementAccess ({ state, targets = [], blocks = [], getBlock, maxDistance = 4 }) {
  if (!finite(state?.position) || !Array.isArray(targets) || !Array.isArray(blocks) || typeof getBlock !== 'function' || !Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 4) return null
  const support = block => block?.known === true && same(block.position, block.position) && block.boundingBox === 'block' && !block.extra?.length && /^(?:minecraft:)(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_planks)$/.test(block.name)
  const open = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || ['minecraft:short_grass', 'minecraft:fern', 'minecraft:leaf_litter', 'minecraft:torch'].includes(block.name) && block.boundingBox === 'empty')
  const standing = position => {
    for (let x = Math.floor(position.x - 0.3 + 1e-6); x <= Math.floor(position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(position.z - 0.3 + 1e-6); z <= Math.floor(position.z + 0.3 - 1e-6); z++) if (!support(getBlock({ x, y: position.y - 1, z })) || !open(getBlock({ x, y: position.y, z })) || !open(getBlock({ x, y: position.y + 1, z }))) return false
    return true
  }
  const feet = { ...state.position, y: state.position.y - 1.62 }
  const cost = p => Math.hypot(p.x - feet.x, p.z - feet.z) + Math.abs(p.y - feet.y) * 2
  const stances = blocks.filter(support).map(block => ({ x: block.position.x + 0.5, y: block.position.y + 1, z: block.position.z + 0.5 })).filter(p => Math.hypot(p.x - feet.x, p.y - feet.y, p.z - feet.z) <= maxDistance && Math.hypot(p.x - feet.x, p.y - feet.y, p.z - feet.z) > 0.4 && standing(p)).sort((a, b) => cost(a) - cost(b) || a.x - b.x || a.y - b.y || a.z - b.z)
  for (const standpoint of stances) for (const target of targets) {
    const block = getBlock(target)
    if (!same(target, target) || block?.known !== true || !AIR.has(block.name) || block.extra?.length || block.protected === true || block.protectionSource || block.natural === false || Math.hypot(standpoint.x - target.x - 0.5, standpoint.z - target.z - 0.5) < 1.55) continue
    const views = OFFSETS.map(offset => ({ x: standpoint.x + offset.x, y: standpoint.y + 1.62, z: standpoint.z + offset.z }))
    if (!views.every(position => standing({ ...position, y: standpoint.y }) && placementTopVisible({ state: { position }, target, getBlock, maxReach: 4.3 }))) continue
    return { target: { ...target }, standpoint, testedPoints: views.length, positionTolerance: 0.25 }
  }
  return null
}

function planStationAccess ({ state, observedState = state, target, blocks = [], getBlock, expectedScope = null, maxDistance = 12 }) {
  const scope = treeAccessScope(state, observedState)
  const invalid = reason => ({ ready: false, reason, scope })
  if (!finite(state?.position) || !same(target, target) || !Array.isArray(blocks)) return invalid('invalid_station_access')
  if (expectedScope != null && scope !== expectedScope || ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].some(field => state[field] != null && observedState?.[field] != null && String(state[field]) !== String(observedState[field])) || state.lifecycle?.deathId != null && observedState?.lifecycle?.deathId != null && state.lifecycle.deathId !== observedState.lifecycle.deathId) return invalid('station_scope_changed')
  const map = new Map(blocks.filter(block => same(block?.position, block?.position)).map(block => [key(block.position), block]))
  const read = getBlock ?? (position => map.get(key(position)))
  const table = read(target)
  if (table?.known !== true || table.name !== 'minecraft:crafting_table' || table.protected === true || table.usable === false || table.extra?.length) return invalid('station_not_known')
  const world = { getBlock: (x, y, z) => read({ x, y, z }) }
  const support = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && /^(?:minecraft:)(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|crafting_table|furnace|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_(?:planks|log))$/.test(block.name)
  const open = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || ['minecraft:short_grass', 'minecraft:fern', 'minecraft:leaf_litter', 'minecraft:torch'].includes(block.name) && block.boundingBox === 'empty')
  const standing = position => {
    const y = Math.round(position.y)
    if (Math.abs(position.y - y) > 1e-4) return false
    for (let x = Math.floor(position.x - 0.3 + 1e-6); x <= Math.floor(position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(position.z - 0.3 + 1e-6); z <= Math.floor(position.z + 0.3 - 1e-6); z++) if (!support(read({ x, y: y - 1, z })) || !open(read({ x, y, z })) || !open(read({ x, y: y + 1, z }))) return false
    return true
  }
  const currentFeet = { ...state.position, y: state.position.y - 1.62 }
  const currentFace = stationVisibleFace({ eye: state.position, target, world })
  if (standing(currentFeet) && currentFace) return { ready: true, target: { ...target }, face: currentFace, scope }
  const candidates = blocks.filter(support).map(block => ({ x: block.position.x + 0.5, y: block.position.y + 1, z: block.position.z + 0.5 })).filter(position => Math.hypot(position.x - currentFeet.x, position.z - currentFeet.z) <= maxDistance && Math.hypot(position.x - currentFeet.x, position.y - currentFeet.y, position.z - currentFeet.z) > 0.4 && Math.hypot(position.x - target.x - 0.5, position.y + 1.62 - target.y - 0.5, position.z - target.z - 0.5) <= 4.1 && standing(position)).sort((a, b) => Math.hypot(a.x - currentFeet.x, a.z - currentFeet.z) + Math.abs(a.y - currentFeet.y) * 2 - Math.hypot(b.x - currentFeet.x, b.z - currentFeet.z) - Math.abs(b.y - currentFeet.y) * 2)
  for (const position of candidates) {
    const views = OFFSETS.map(offset => ({ x: position.x + offset.x, y: position.y + 1.62, z: position.z + offset.z }))
    if (!views.every(eye => stationVisibleFace({ eye, target, world, maxReach: 4.3 }))) continue
    return { ready: false, reason: 'station_approach_required', target: { ...target }, standpoint: { ...position }, scope, testedPoints: views.length }
  }
  return invalid('no_known_station_stance')
}

module.exports = { useCurrentAccess, treeAccessScope, isDryAccessPlant, safeAccessPlant, planTreeAccess, planStationAccess, stationVisibleFace, placementTopVisible, planPlacementAccess, ACCESS_LIMIT }
