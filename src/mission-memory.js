'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const SCHEMA_VERSION = 1
const queues = new Map()
const STAGES = new Set(['idle', 'planning', 'build', 'leave', 'digging', 'dug', 'moving', 'arrived', 'collecting_soil', 'closing_entrance', 'door_confirmed', 'partial', 'closed_refuge', 'left_shelter', 'outside', 'failed', 'stopped'])
const BLOCKS = new Set(['dirt', 'grass_block', 'air', 'cave_air', 'void_air', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'moss_block'].map(name => `minecraft:${name}`))
const PLACEMENT_PROOFS = new Set(['received_dirt_and_inventory_decrease', 'received_dirt_and_inventory_after_resume'])
const key = point => `${point.x},${point.y},${point.z}`
const clone = value => JSON.parse(JSON.stringify(value))
class MissionMemoryError extends Error {
  constructor (message, code) { super(message); this.code = code }
}
function requireValue (condition, code, message) { if (!condition) throw new MissionMemoryError(message, code) }
function point (value, integer = true) {
  requireValue(value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 30000000 && (!integer || Number.isSafeInteger(value[axis]))), 'INVALID_GEOMETRY', 'Invalid shelter coordinate')
  return { x: value.x, y: value.y, z: value.z }
}
function realm (value) {
  requireValue((typeof value === 'string' && /^\d{1,20}$/.test(value)) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'bigint' && value > 0n, 'INVALID_SCOPE', 'A known Realm ID is required')
  const result = BigInt(value)
  requireValue(result > 0n && result <= (1n << 64n) - 1n, 'INVALID_SCOPE', 'Invalid Realm ID')
  return String(result)
}
function dimension (value) {
  const result = typeof value === 'number' ? ['overworld', 'nether', 'end'][value] : value
  requireValue(['overworld', 'nether', 'end'].includes(result), 'INVALID_SCOPE', 'A known dimension is required')
  return result
}
function scopeOf ({ realmId, profile, dimension: dim } = {}) {
  requireValue(typeof profile === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile), 'INVALID_SCOPE', 'A configured bot profile is required')
  return { realmId: realm(realmId), profile, dimension: dimension(dim) }
}
function requestId (value) {
  if (value == null) return {}
  requireValue(Number.isInteger(value) && value < 0 && value >= -2147483648, 'INVALID_RECEIPT', 'Invalid historical server request ID')
  return { requestId: value }
}
function descriptor (value, expected) {
  const position = point(value?.position)
  requireValue(!expected || key(position) === key(expected), 'INVALID_GEOMETRY', 'Shelter cell does not match its site')
  const result = { position }
  for (const field of ['name', 'expectedBlock', 'observedName']) if (value[field] != null) {
    requireValue(BLOCKS.has(value[field]), 'INVALID_BLOCK', 'Unsupported historical shelter block')
    result[field] = value[field]
  }
  if (value.runtimeId != null) { requireValue(Number.isSafeInteger(value.runtimeId) && value.runtimeId >= 0 && value.runtimeId <= 0xffffffff, 'INVALID_BLOCK', 'Invalid historical block runtime ID'); result.runtimeId = value.runtimeId }
  for (const field of ['known', 'alreadyClear', 'needsMining', 'needsPlacement', 'preserve']) if (typeof value[field] === 'boolean') result[field] = value[field]
  return result
}
function descriptors (values, expected) {
  requireValue(Array.isArray(values) && values.length === expected.length, 'INVALID_GEOMETRY', 'Incomplete shelter geometry')
  const allowed = new Set(expected.map(key)); const seen = new Set()
  return values.map(value => {
    const result = descriptor(value)
    requireValue(allowed.has(key(result.position)) && !seen.has(key(result.position)), 'INVALID_GEOMETRY', 'Unexpected or duplicate shelter cell')
    seen.add(key(result.position)); return result
  })
}
function sanitizeSite (site) {
  requireValue(site && site.type === 'soil_hill_shelter', 'INVALID_SITE', 'A soil-hill shelter site is required')
  const outside = point(site.outsideFootCell)
  const forward = site.forward
  requireValue(forward && Number.isInteger(forward.x) && Number.isInteger(forward.z) && Math.abs(forward.x) + Math.abs(forward.z) === 1, 'INVALID_GEOMETRY', 'Invalid shelter direction')
  const d = { x: forward.x, z: forward.z }; const side = { x: -d.z, z: d.x }
  const cell = (depth, lateral = 0, height = 0) => ({ x: outside.x + d.x * depth + side.x * lateral, y: outside.y + height, z: outside.z + d.z * depth + side.z * lateral })
  const center = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
  const samePoint = (input, expected, integers = true) => { const p = point(input, integers); requireValue(key(p) === key(expected), 'INVALID_GEOMETRY', 'Shelter endpoint changed'); return p }
  const entry = samePoint(site.entry, cell(1)); const inner = samePoint(site.inner, cell(2))
  const id = `soil-hill:${key(outside)}:${d.x},${d.z}`
  requireValue(site.id === id && Array.isArray(site.initialSteps) && site.initialSteps.length === 2, 'INVALID_SITE', 'Shelter identity or passage is invalid')
  const steps = site.initialSteps.map((step, index) => {
    const foot = index ? inner : entry
    requireValue(Array.isArray(step.clearance) && step.clearance.length === 2, 'INVALID_GEOMETRY', 'Shelter needs head and foot clearance')
    return { index, target: samePoint(step.target, center(foot), false), footCell: { ...foot }, clearance: step.clearance.map((value, order) => descriptor(value, { ...foot, y: foot.y + 1 - order })), requiresReceivedAir: true }
  })
  const feet = [2, 3].flatMap(depth => [-1, 0, 1].map(lateral => cell(depth, lateral)))
  const body = feet.flatMap(p => [{ ...p, y: p.y + 1 }, p])
  const floors = [...new Map([entry, inner, ...feet].map(p => { const floor = { ...p, y: p.y - 1 }; return [key(floor), floor] })).values()]
  const roofs = floors.map(p => ({ ...p, y: outside.y + 2 }))
  const walls = [0, 1].flatMap(y => [cell(1, -1, y), cell(1, 1, y), ...[2, 3].flatMap(depth => [-2, 2].map(lateral => cell(depth, lateral, y))), ...[-1, 0, 1].map(lateral => cell(4, lateral, y))])
  const minimumFloor = [entry, inner].map(p => ({ ...p, y: p.y - 1 }))
  const minimumRoof = [entry, inner].map(p => ({ ...p, y: p.y + 2 }))
  const minimumWalls = [0, 1].flatMap(height => [cell(1, -1, height), cell(1, 1, height), cell(2, -1, height), cell(2, 1, height), cell(3, 0, height)])
  const minimumBody = [{ ...inner, y: inner.y + 1 }, inner]
  requireValue(site.finalInterior?.width === 3 && site.finalInterior.depth === 2 && site.finalInterior.height === 2, 'INVALID_GEOMETRY', 'Unsupported shelter room dimensions')
  requireValue(Array.isArray(site.finalInterior.footCells) && site.finalInterior.footCells.length === 6 && new Set(site.finalInterior.footCells.map(p => key(point(p)))).size === 6 && site.finalInterior.footCells.every(p => feet.some(allowed => key(p) === key(allowed))), 'INVALID_GEOMETRY', 'Invalid shelter room footprint')
  // Future expansion observations may legitimately be unknown or stone (even
  // unsafe beyond an intact refuge wall). Store their geometry only, never a
  // claim that this larger room was cleared or enclosed.
  const geometryOnly = (values, expected) => {
    requireValue(Array.isArray(values), 'INVALID_GEOMETRY', 'Missing shelter geometry')
    return descriptors(values.map(value => ({ position: point(value?.position) })), expected)
  }
  const futureBody = geometryOnly(site.finalInterior.bodyCells, body)
  let innerDescriptors = steps[1].clearance
  if (site.minimumInterior != null) {
    const minimum = site.minimumInterior
    requireValue(minimum.width === 1 && minimum.depth === 1 && minimum.height === 2 && Array.isArray(minimum.footCells) && minimum.footCells.length === 1 && key(point(minimum.footCells[0])) === key(inner), 'INVALID_GEOMETRY', 'Invalid minimum refuge dimensions')
    innerDescriptors = descriptors(minimum.bodyCells, minimumBody)
  }
  const rawPreserved = []
  for (const [field, minimum, legacy] of [['floor', minimumFloor, floors], ['roof', minimumRoof, roofs], ['walls', minimumWalls, walls]]) {
    const values = site.preserved?.[field]
    requireValue(Array.isArray(values) && [minimum.length, legacy.length].includes(values.length), 'INVALID_GEOMETRY', 'Incomplete minimum shelter boundary')
    geometryOnly(values, values.length === minimum.length ? minimum : legacy)
    rawPreserved.push(...values)
  }
  const historical = new Map([...site.finalInterior.bodyCells, ...rawPreserved].map(value => [key(value.position), value]))
  const keepMinimum = expected => expected.map(position => {
    const value = historical.get(key(position))
    requireValue(value, 'INVALID_GEOMETRY', 'Historical minimum boundary is missing')
    return descriptor(value, position)
  })
  const doors = descriptors(site.doorCells, [entry, { ...entry, y: entry.y + 1 }]).sort((a, b) => a.position.y - b.position.y)
  requireValue(doors.every(item => item.name === 'minecraft:dirt' && item.expectedBlock === 'minecraft:dirt'), 'INVALID_GEOMETRY', 'Only the planned dirt door can be restored')
  return {
    ready: site.ready === true, type: site.type, id, contractVersion: 2, requiresWorldValidation: true,
    outsideFootCell: outside, outsideStandpoint: samePoint(site.outsideStandpoint, center(outside), false), forward: d,
    entry, inner, innerStandpoint: samePoint(site.innerStandpoint, center(inner), false),
    initialSteps: steps, initialExcavation: steps.flatMap(step => step.clearance), doorCells: doors,
    minimumInterior: { width: 1, depth: 1, height: 2, footCells: [inner], bodyCells: innerDescriptors, standpoints: [center(inner)] },
    finalInterior: { width: 3, depth: 2, height: 2, footCells: feet, bodyCells: futureBody, standpoints: feet.map(center) },
    preserved: { floor: keepMinimum(minimumFloor), roof: keepMinimum(minimumRoof), walls: keepMinimum(minimumWalls) },
    ...(site.expansion == null ? {} : { expansion: geometryOnly(site.expansion, body.filter(p => !(p.x === inner.x && p.z === inner.z))) })
  }
}
function sanitizeHutSite (site) {
  requireValue(site?.type === 'soil_hut', 'INVALID_SITE', 'A soil hut site is required')
  requireValue(site.contractVersion == null || site.contractVersion === 1, 'UNKNOWN_SITE_VERSION', 'Unsupported hut geometry version')
  const c = point(site.center); const forward = site.forward
  requireValue(forward && Number.isInteger(forward.x) && Number.isInteger(forward.z) && Math.abs(forward.x) + Math.abs(forward.z) === 1, 'INVALID_GEOMETRY', 'Invalid hut direction')
  const d = { x: forward.x, z: forward.z }; const side = { x: -d.z, z: d.x }
  const cell = (depth, lateral = 0, height = 0) => ({ x: c.x + d.x * depth + side.x * lateral, y: c.y + height, z: c.z + d.z * depth + side.z * lateral })
  const centered = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
  const same = (value, expected, integers = true) => { const result = point(value, integers); requireValue(key(result) === key(expected), 'INVALID_GEOMETRY', 'Hut coordinate differs from its template'); return result }
  const list = (values, expected) => {
    requireValue(Array.isArray(values) && values.length === expected.length, 'INVALID_GEOMETRY', 'Incomplete hut cells')
    const allowed = new Set(expected.map(key)); const seen = new Set()
    for (const value of values) { const p = point(value); requireValue(allowed.has(key(p)) && !seen.has(key(p)), 'INVALID_GEOMETRY', 'Unexpected or duplicate hut cell'); seen.add(key(p)) }
    return expected.map(p => ({ ...p }))
  }
  const footprint = [-1, 0, 1].flatMap(depth => [-1, 0, 1].map(lateral => cell(depth, lateral)))
  const columns = [...[-1, 0, 1].map(lateral => cell(1, lateral)), cell(0, -1), cell(0, 1), cell(-1, 1), cell(-1, -1)]
  const walls = columns.flatMap(p => [p, { ...p, y: p.y + 1 }])
  const temporary = [cell(0), cell(0, 0, 1)]; const roof = cell(0, 0, 2); const doors = [cell(-1), cell(-1, 0, 1)]
  const permanent = [...walls, roof, ...doors]; const all = [...permanent, ...temporary]
  const outsideCell = cell(-2); const outside = centered(outsideCell); const inside = centered(c)
  const climbOutside = centered(cell(-2, -1)); const stair = centered(cell(-1, -1, 1)); const elevated = centered(cell(0, -1, 2)); const deferred = cell(-1, -1, 1)
  const id = `soil-hut:${key(c)}:${d.x},${d.z}`
  requireValue(site.id === id, 'INVALID_SITE', 'Hut identity differs from its geometry')
  same(site.outsideFootCell, outsideCell); same(site.outsideStandpoint, outside, false); same(site.insideStandpoint, inside, false)
  if (site.innerStandpoint != null) same(site.innerStandpoint, inside, false)
  list(site.footprint, footprint); list(site.wallCells ?? site.walls, walls)
  if (site.walls != null) list(site.walls, walls)
  list(site.temporaryPillar, temporary); same(site.roof, roof); list(site.doorCells, doors)
  if (site.tempCells != null) list(site.tempCells, temporary)
  if (site.buildCells != null) list(site.buildCells, permanent)
  if (site.ownedBuildCells != null) list(site.ownedBuildCells, all)
  if (site.staircase != null) { same(site.staircase.deferredUpper, deferred); same(site.staircase.outsideStandpoint, climbOutside, false); same(site.staircase.lowerStandpoint, stair, false); same(site.staircase.elevatedStandpoint, elevated, false) }
  const floor = descriptors(site.preserved?.floor, footprint.map(p => ({ ...p, y: p.y - 1 }))).map(value => ({ ...value, preserve: true, needsMining: false }))
  const ground = []
  for (let depth = -2; depth <= 2; depth++) for (let lateral = -2; lateral <= 2; lateral++) if (Math.abs(depth) === 2 || Math.abs(lateral) === 2 || depth === -1 && lateral === 0) ground.push(centered(cell(depth, lateral)))
  const expected = []
  const placement = (position, stage, kind = 'wall', allowedStances = ground) => expected.push({ type: 'place', position, stage, kind, allowedStances })
  const move = (target, stage) => expected.push({ type: 'move', target, stage })
  for (const [index, column] of columns.entries()) {
    const stage = index < 3 ? 'far_wall' : index < 5 ? 'side_walls' : 'front_corners'
    placement(column, stage)
    if (index !== 6) placement({ ...column, y: column.y + 1 }, stage)
  }
  placement(temporary[0], 'temporary_pillar', 'temporary_pillar')
  move(climbOutside, 'approach_stair'); move(stair, 'climb_one_block'); move(elevated, 'climb_wall')
  placement(temporary[1], 'temporary_pillar', 'temporary_pillar', [elevated]); placement(roof, 'roof', 'roof', [elevated])
  move(stair, 'descend_one_block'); move(climbOutside, 'descend_to_ground')
  placement(deferred, 'finish_front_corner')
  for (const position of [temporary[1], temporary[0]]) expected.push({ type: 'mine', position, stage: 'remove_temporary_pillar', kind: 'temporary_pillar', allowedStances: ground })
  move(outside, 'approach_entrance'); move(centered(cell(-1)), 'enter_doorway'); move(inside, 'enter_hut')
  expected.push({ type: 'wait_material', stage: 'recover_temporary_pillar' })
  for (const position of doors) placement(position, 'close_entrance', 'door', [inside])
  requireValue(Array.isArray(site.steps) && site.steps.length === 30 && expected.length === 30, 'INVALID_GEOMETRY', 'A hut needs its fixed thirty-step timeline')
  const steps = site.steps.map((input, index) => {
    const template = expected[index]
    requireValue(input?.type === template.type && input.stage === template.stage && (input.index == null || input.index === index), 'INVALID_GEOMETRY', 'Hut construction order changed')
    const step = { index, type: template.type, stage: template.stage, requiresLivePreview: true }
    if (template.type === 'move') return { ...step, target: same(input.target, template.target, false), requireGrounded: true }
    requireValue(input.item === 'minecraft:dirt', 'INVALID_GEOMETRY', 'Hut work can only use the planned dirt')
    if (template.type === 'wait_material') { requireValue(input.count === 2, 'INVALID_GEOMETRY', 'Hut recovery must wait for two real dirt'); return { ...step, item: 'minecraft:dirt', count: 2, requireServerInventory: true, requiresActualRecovery: true } }
    requireValue(input.kind === template.kind, 'INVALID_GEOMETRY', 'Hut action ownership changed')
    const position = same(input.position, template.position)
    const allowed = new Set(template.allowedStances.map(key)); const seen = new Set()
    requireValue(Array.isArray(input.standpoints) && input.standpoints.length >= 1 && input.standpoints.length <= 16, 'INVALID_GEOMETRY', 'Invalid bounded hut stance list')
    const standpoints = input.standpoints.map(value => { const p = point(value, false); requireValue(allowed.has(key(p)) && !seen.has(key(p)), 'INVALID_GEOMETRY', 'Hut stance escaped its construction template'); seen.add(key(p)); return p })
    if (template.type === 'mine') return { ...step, kind: template.kind, position, item: 'minecraft:dirt', standpoints, ownReceiptRequired: true, requireReceivedAir: true }
    requireValue(input.count === 1 && input.face === 1 && input.clickPos?.x === 0.5 && input.clickPos?.y === 1 && input.clickPos?.z === 0.5, 'INVALID_GEOMETRY', 'Hut placement must use one dirt on a real top face')
    return { ...step, kind: template.kind, position, item: 'minecraft:dirt', count: 1, support: same(input.support, { ...position, y: position.y - 1 }), face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, point: same(input.point, { x: position.x + 0.5, y: position.y, z: position.z + 0.5 }, false), standpoints, requireServerBlockAndInventory: true }
  })
  return {
    ready: site.ready === true, type: 'soil_hut', contractVersion: 1, id, center: c, forward: d,
    outsideFootCell: outsideCell, outsideStandpoint: outside, insideStandpoint: inside, innerStandpoint: inside,
    footprint, preserved: { floor }, walls, wallCells: walls.map(p => ({ ...p })), temporaryPillar: temporary, tempCells: temporary.map(p => ({ ...p })), roof, doorCells: doors,
    buildCells: permanent, ownedBuildCells: all, staircase: { deferredUpper: deferred, outsideStandpoint: climbOutside, lowerStandpoint: stair, elevatedStandpoint: elevated, requiresOneBlockJumps: true }, steps,
    materials: { name: 'minecraft:dirt', initialRequired: 17, walls: 14, roof: 1, temporaryPillar: 2, recoveredForDoor: 2, door: 2, totalPlacements: 19, finalPlaced: 17, requireActualInventory: true },
    materialBudget: { initial: 17, maximumBeforeRecovery: 17, requiredRecovery: 2, final: 17, item: 'minecraft:dirt', requireServerInventory: true },
    requiresLivePreview: true, requiresWorldValidation: true
  }
}
function sanitizeHutMemo (input, scope) {
  requireValue(input.kind == null || input.kind === 'soil_hut', 'INVALID_MEMO', 'Hut memo kind changed')
  const site = sanitizeHutSite(input.site)
  const permanentKeys = new Set(site.buildCells.map(key)); const temporaryKeys = new Set(site.temporaryPillar.map(key)); const doorKeys = new Set(site.doorCells.map(key)); const allKeys = new Set(site.ownedBuildCells.map(key)); const seen = new Set()
  requireValue(Array.isArray(input.placements) && input.placements.length <= 19, 'INVALID_RECEIPT', 'Invalid hut receipt list')
  const placements = input.placements.map(value => {
    const position = point(value.position)
    requireValue(allKeys.has(key(position)) && !seen.has(key(position)) && value.item === 'minecraft:dirt' && value.count === 1, 'INVALID_RECEIPT', 'Invalid hut dirt placement receipt')
    seen.add(key(position))
    const confirmed = value.serverConfirmed === true
    requireValue(!confirmed || PLACEMENT_PROOFS.has(value.confirmedBy), 'INVALID_RECEIPT', 'A confirmed hut receipt needs its original source')
    requireValue(value.removed !== true || temporaryKeys.has(key(position)) || doorKeys.has(key(position)), 'INVALID_RECEIPT', 'A permanent hut wall or roof cannot be removed')
    return { position, item: 'minecraft:dirt', count: 1, serverConfirmed: confirmed, ...(confirmed ? { confirmedBy: value.confirmedBy } : {}), ...(typeof value.removed === 'boolean' ? { removed: value.removed } : {}), ...requestId(value.requestId) }
  })
  requireValue(Number.isSafeInteger(input.stepIndex) && input.stepIndex >= 0 && input.stepIndex <= 30 && Number.isSafeInteger(input.totalActions) && input.totalActions >= 0 && input.totalActions <= 512, 'INVALID_MEMO', 'Invalid hut progress counters')
  let reclaimBaseline = null
  if (input.reclaimBaseline != null) { requireValue(Number.isSafeInteger(input.reclaimBaseline) && input.reclaimBaseline >= 0 && input.reclaimBaseline <= 2304, 'INVALID_MEMO', 'Invalid historical dirt recovery baseline'); reclaimBaseline = input.reclaimBaseline }
  const recoveredTemporaryDirt = input.recoveredTemporaryDirt === true
  const temporaryReceipts = placements.filter(value => temporaryKeys.has(key(value.position)))
  requireValue(!recoveredTemporaryDirt || reclaimBaseline !== null && (temporaryReceipts.length === 0 || temporaryReceipts.length === 2 && temporaryReceipts.every(value => value.serverConfirmed && value.removed === true)), 'INVALID_RECEIPT', 'Claimed hut recovery lacks its historical proof')
  let pendingPlacement = null
  if (input.pendingPlacement != null) {
    const value = input.pendingPlacement; const position = point(value.position)
    requireValue(allKeys.has(key(position)) && value.item === 'minecraft:dirt' && Number.isSafeInteger(value.beforeDirt) && value.beforeDirt >= 1 && value.beforeDirt <= 2304, 'INVALID_PENDING', 'Invalid unconfirmed hut placement')
    pendingPlacement = { position, item: 'minecraft:dirt', beforeDirt: value.beforeDirt, serverConfirmed: false, requiresReconciliation: true, ...requestId(value.requestId) }
  }
  const verifiedPermanent = [...permanentKeys].every(id => placements.some(value => key(value.position) === id && value.serverConfirmed))
  const historicalCompletion = verifiedPermanent && input.stepIndex === 30 && recoveredTemporaryDirt
  const established = input.established === true && historicalCompletion && !pendingPlacement
  // An old connection's before-count cannot establish a new pickup. A partial
  // recovery must be reconciled rather than crediting unrelated carried dirt.
  const recoveryUncertain = !recoveredTemporaryDirt && (reclaimBaseline !== null || input.requiresRecoveryReconciliation === true)
  return { version: 1, kind: 'soil_hut', scope: { realmId: scope.realmId, dimension: scope.dimension }, site, placements, stepIndex: input.stepIndex, totalActions: input.totalActions, established, previouslyEstablished: historicalCompletion && (input.established === true || input.previouslyEstablished === true), recoveredTemporaryDirt, reclaimBaseline: recoveryUncertain ? null : reclaimBaseline, ...(recoveryUncertain ? { requiresRecoveryReconciliation: true } : {}), pendingPlacement, requiresWorldValidation: true }
}
function sanitizeMemo (input, scope) {
  requireValue(input && input.version === 1, 'UNKNOWN_MEMO_VERSION', 'Unsupported shelter memo version')
  requireValue(input.scope && realm(input.scope.realmId) === scope.realmId && dimension(input.scope.dimension) === scope.dimension, 'SCOPE_MISMATCH', 'Shelter memo scope differs from the active world')
  requireValue((input.scope.profile == null || input.scope.profile === scope.profile) && (input.ownerProfile == null || input.ownerProfile === scope.profile), 'SCOPE_MISMATCH', 'Shelter memo profile differs from the active bot')
  if (input.site?.type === 'soil_hut') return sanitizeHutMemo(input, scope)
  const site = sanitizeSite(input.site)
  const doorKeys = new Set(site.doorCells.map(item => key(item.position)))
  const digKeys = new Set([...site.initialExcavation, ...site.finalInterior.bodyCells].map(item => key(item.position)))
  requireValue(Array.isArray(input.placements) && input.placements.length <= 2 && Array.isArray(input.cleared) && input.cleared.length <= 14, 'INVALID_RECEIPT', 'Shelter receipt arrays are invalid')
  const seenDoors = new Set()
  const placements = input.placements.map(value => {
    const position = point(value.position)
    requireValue(doorKeys.has(key(position)) && !seenDoors.has(key(position)) && value.item === 'minecraft:dirt' && value.count === 1, 'INVALID_RECEIPT', 'Invalid doorway receipt')
    seenDoors.add(key(position))
    const confirmed = value.serverConfirmed === true
    requireValue(!confirmed || PLACEMENT_PROOFS.has(value.confirmedBy), 'INVALID_RECEIPT', 'A verified doorway needs its original confirmation source')
    return { position, item: 'minecraft:dirt', count: 1, serverConfirmed: confirmed, ...(confirmed ? { confirmedBy: value.confirmedBy } : {}), ...requestId(value.requestId) }
  })
  const cleared = input.cleared.map(value => {
    const position = point(value.position)
    requireValue(digKeys.has(key(position)) && ['minecraft:dirt', 'minecraft:grass_block'].includes(value.originalName) && value.confirmedBy === 'received_air', 'INVALID_RECEIPT', 'Invalid soil clearance receipt')
    return { position, originalName: value.originalName, confirmedBy: 'received_air', ...requestId(value.requestId) }
  })
  let pendingPlacement = null
  if (input.pendingPlacement != null) {
    const value = input.pendingPlacement; const position = point(value.position)
    requireValue(doorKeys.has(key(position)) && value.item === 'minecraft:dirt' && Number.isSafeInteger(value.beforeDirt) && value.beforeDirt >= 1 && value.beforeDirt <= 2304, 'INVALID_PENDING', 'Invalid unconfirmed doorway operation')
    pendingPlacement = { position, item: 'minecraft:dirt', beforeDirt: value.beforeDirt, serverConfirmed: false, requiresReconciliation: true, ...requestId(value.requestId) }
  }
  requireValue(Number.isSafeInteger(input.totalActions) && input.totalActions >= 0 && input.totalActions <= 512, 'INVALID_MEMO', 'Invalid shelter action counter')
  const verified = placements.length === 2 && placements.every(item => item.serverConfirmed)
  const established = input.established === true && verified && !pendingPlacement
  return {
    version: 1, scope: { realmId: scope.realmId, dimension: scope.dimension }, site, cleared, placements,
    established, previouslyEstablished: verified && (input.established === true || input.previouslyEstablished === true),
    totalActions: input.totalActions, ...(STAGES.has(input.stage) ? { stage: input.stage } : {}),
    pendingPlacement, requiresWorldValidation: true
  }
}

function createMissionMemory ({ workspaceRoot = path.resolve(__dirname, '..'), filePath, maxBytes = 128 * 1024 } = {}) {
  const root = path.resolve(workspaceRoot)
  const directory = path.join(root, '.local')
  const filename = path.join(directory, 'mission-memory.json')
  requireValue(!root.split(/[\\/]/).some(part => part.toLowerCase() === '.auth') && (filePath == null || path.resolve(filePath) === filename), 'INVALID_PATH', 'Mission memory must remain in the workspace .local/mission-memory.json')
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 1024 * 1024, 'INVALID_LIMIT', 'Invalid mission memory size limit')
  const queueKey = process.platform === 'win32' ? filename.toLowerCase() : filename
  let pendingWrites = 0
  let lastSave = null; let lastLoad = null; let lastError = null
  const errorCode = error => error instanceof MissionMemoryError ? error.code : String(error?.code ?? 'IO_ERROR')
  async function safeDirectory (create) {
    const parent = await fs.lstat(root)
    requireValue(parent.isDirectory() && !parent.isSymbolicLink(), 'UNSAFE_DIRECTORY', 'Workspace must be an ordinary directory')
    let current
    try { current = await fs.lstat(directory) } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error
      try { await fs.mkdir(directory) } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError }
      current = await fs.lstat(directory)
    }
    requireValue(current.isDirectory() && !current.isSymbolicLink(), 'UNSAFE_DIRECTORY', 'Mission memory directory cannot be a link')
  }
  async function atomicWrite (serialized) {
    await safeDirectory(true)
    try { const existing = await fs.lstat(filename); requireValue(existing.isFile() && !existing.isSymbolicLink(), 'UNSAFE_FILE', 'Mission memory cannot replace a link or directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const temporary = path.join(directory, `mission-memory.${process.pid}.${randomUUID()}.tmp`)
    requireValue(path.dirname(path.resolve(temporary)) === directory, 'INVALID_PATH', 'Temporary file escaped its memory directory')
    let handle
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close(); handle = null
      // Same-directory rename replaces the complete file atomically. Never
      // unlink the previous mission to work around a Windows sharing violation.
      await fs.rename(temporary, filename)
    } finally {
      if (handle) await handle.close().catch(() => {})
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  async function save (input) {
    let serialized
    try {
      const scope = scopeOf(input)
      const shelterMemo = sanitizeMemo(input.shelterMemo, scope)
      serialized = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, realmId: scope.realmId, profile: scope.profile, shelterMemo }, null, 2)}\n`
      requireValue(Buffer.byteLength(serialized, 'utf8') <= maxBytes, 'OVERSIZE', 'Mission memory exceeds its size limit')
    } catch (error) { lastError = errorCode(error); throw error }
    pendingWrites++
    const previous = queues.get(queueKey) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(() => atomicWrite(serialized))
    queues.set(queueKey, work)
    try {
      await work
      lastSave = { bytes: Buffer.byteLength(serialized, 'utf8'), atomic: true }; lastError = null
      return { saved: true, path: filename, ...lastSave, requiresWorldValidation: true }
    } catch (error) { lastError = errorCode(error); throw error }
    finally { pendingWrites--; if (queues.get(queueKey) === work) queues.delete(queueKey) }
  }
  async function load (requested) {
    let handle
    try {
      const scope = scopeOf(requested)
      await (queues.get(queueKey) ?? Promise.resolve()).catch(() => {})
      await safeDirectory(false)
      const info = await fs.lstat(filename)
      requireValue(info.isFile() && !info.isSymbolicLink(), 'UNSAFE_FILE', 'Mission memory must be an ordinary file')
      requireValue(info.size <= maxBytes, 'OVERSIZE', 'Mission memory exceeds its size limit')
      handle = await fs.open(filename, 'r')
      const buffer = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead }
      requireValue(length <= maxBytes, 'OVERSIZE', 'Mission memory grew beyond its size limit')
      let parsed
      try { parsed = JSON.parse(buffer.toString('utf8', 0, length)) } catch { throw new MissionMemoryError('Mission memory contains invalid JSON', 'BAD_JSON') }
      requireValue(parsed?.schemaVersion === SCHEMA_VERSION, 'UNKNOWN_SCHEMA_VERSION', 'Unsupported mission memory schema')
      requireValue(realm(parsed.realmId) === scope.realmId && parsed.profile === scope.profile, 'SCOPE_MISMATCH', 'Mission memory belongs to another Realm or profile')
      const shelterMemo = sanitizeMemo(parsed.shelterMemo, scope)
      lastLoad = { status: 'loaded', requiresWorldValidation: true }; lastError = null
      return { ...lastLoad, shelterMemo }
    } catch (error) {
      const code = errorCode(error)
      const status = code === 'ENOENT' ? 'missing' : 'rejected'
      lastLoad = { status, code, requiresWorldValidation: true }; lastError = status === 'missing' ? null : code
      return { ...lastLoad, shelterMemo: null }
    } finally { if (handle) await handle.close().catch(() => {}) }
  }
  return { save, load, flush: () => queues.get(queueKey) ?? Promise.resolve(), snapshot: () => ({ path: filename, pendingWrites, lastSave: lastSave && { ...lastSave }, lastLoad: lastLoad && { ...lastLoad }, lastError }) }
}

module.exports = { createMissionMemory, MissionMemoryError }
