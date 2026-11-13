'use strict'
const { supplyScope, stationWorldScope } = require('./supply-return')
const { placementTopVisible, planStationAccess } = require('./action-access')
const { traceBlockFace } = require('./aim')
const { createNavigator } = require('./navigation')
const copy = v => structuredClone(v), key = p => `${p.x},${p.y},${p.z}`
const { finitePoint: finite } = require('./vec3')
const integer = p => finite(p) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const name = b => String(b?.name ?? '').replace(/^minecraft:/, '')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const TERRAIN = new Set(['stone', 'deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const HAZARD = /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|berry_bush|dripstone|sand$|gravel|concrete_powder|anvil/
const empty = b => b?.known === true && AIR.has(name(b)) && !b.extra?.length
const solid = b => b?.known === true && TERRAIN.has(name(b)) && b.boundingBox === 'block' && !b.extra?.length
const point = p => ({ x: p.x, y: p.y, z: p.z })
const near = (state, feet) => Math.abs(state.position.y - 1.62 - feet.y) < 1e-4 && Math.hypot(state.position.x - feet.x, state.position.z - feet.z) <= 0.25
const count = (state, match) => (state.inventory?.items ?? []).reduce((sum, i) => sum + (match(i.name) && Number.isSafeInteger(i.count) && i.count > 0 ? i.count : 0), 0)
function portableKit (state) {
  const table = count(state, n => n === 'minecraft:crafting_table'), furnace = count(state, n => n === 'minecraft:furnace')
  const planks = count(state, n => /_planks$/.test(n)), sticks = count(state, n => n === 'minecraft:stick'), coal = count(state, n => ['minecraft:coal', 'minecraft:charcoal'].includes(n))
  const plankFuel = (state.inventory?.items ?? []).some(i => /_planks$/.test(i.name) && Number.isSafeInteger(i.count) && i.count >= 3)
  return { table, furnace, planks, sticks, coal, fuelReady: coal > 0 || plankFuel, ready: state.inventory?.known === true && !state.inventory.uncertain && table > 0 && furnace > 0 && sticks >= 2 && (coal > 0 || plankFuel) }
}
function reservedWorksiteCells (memo, state) {
  const site = memo?.site
  return site?.worldScope === stationWorldScope(state) && Array.isArray(site.reserved) && site.reserved.length === 4 && site.reserved.every(integer) ? site.reserved.map(point) : []
}
function read (world, p) { return world.getBlock(p.x, p.y, p.z) }
function footprintFree (site, world) {
  return site.reserved.every(p => solid(read(world, p))) && site.clearance.every(p => {
    const b = read(world, p)
    return empty(b) || solid(b) && !b.protected && b.natural !== false || key(p) === key(site.table) && name(b) === 'crafting_table' || key(p) === key(site.furnace) && ['furnace', 'lit_furnace'].includes(name(b))
  })
}
function useRays (state, site, world) {
  const blocks = []
  for (let x = site.originCell.x - 3; x <= site.originCell.x + 3; x++) for (let y = site.originCell.y - 1; y <= site.originCell.y + 3; y++) for (let z = site.originCell.z - 3; z <= site.originCell.z + 3; z++) blocks.push(read(world, { x, y, z }))
  const table = planStationAccess({ state, target: site.table, blocks, getBlock: p => read(world, p) })
  const center = { x: site.furnace.x + 0.5, y: site.furnace.y + 0.5, z: site.furnace.z + 0.5 }, eye = state.position
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z
  const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? dy > 0 ? 1 : 0 : Math.abs(dx) >= Math.abs(dz) ? dx > 0 ? 5 : 4 : dz > 0 ? 3 : 2
  const offsets = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]], axis = face < 2 ? 'y' : face < 4 ? 'z' : 'x'
  const hit = { x: center.x + offsets[face][0] * 0.5, y: center.y + offsets[face][1] * 0.5, z: center.z + offsets[face][2] * 0.5 }, fraction = 0.001 / Math.abs(hit[axis] - eye[axis])
  const inside = Object.fromEntries(['x', 'y', 'z'].map(k => [k, hit[k] + (hit[k] - eye[k]) * fraction]))
  try { return table.ready === true && traceBlockFace({ eye, target: site.furnace, point: inside, world, maxReach: 4.5 })?.face === face } catch { return false }
}
function nativeLeg (physics, world, initial, target, avoidance = []) {
  const local = physics.withWorld(world, { allowWater: false }), navigator = createNavigator({ world, physics: local }), route = navigator.plan(initial, target, { maxDistance: 4, maxExpanded: 200, avoidance })
  if (!route.ready) return null
  const stepper = navigator.createStepper(route, initial, { maxTicks: 80 })
  for (let n = 0; n < 80; n++) {
    const frame = stepper.next(), p = frame.predictedState
    if (p.isInWater || p.isInLava) return null
    if (frame.phase === 'awaiting_server_confirmation') return p.onGround && Math.abs(p.position.y - target.y) <= 0.05 && Math.hypot(p.position.x - target.x, p.position.z - target.z) <= 0.35 ? p : null
    if (frame.phase !== 'moving') return null
  }
  return null
}
function selectPortableWorksite ({ state, world, preservedFloors, physics, avoidance = [] }) {
  const scope = supplyScope(state), level = Math.round(state.position.y - 1.62), physical = state.predicted?.physicsState ?? state.physicsState
  if (!scope || !portableKit(state).ready || physical?.onGround !== true || physical.isInWater || physical.isInLava || Math.abs(state.position.y - 1.62 - level) > 1e-4 || !Array.isArray(preservedFloors) || !preservedFloors.length || preservedFloors.length > 1024 || !physics) return null
  const originCell = { x: Math.floor(state.position.x), y: level, z: Math.floor(state.position.z) }, corridor = { x: state.position.x, y: level, z: state.position.z }, forbidden = new Set()
  for (const p of preservedFloors) { if (!integer(p)) return null; for (let dy = 0; dy <= 3; dy++) forbidden.add(key({ ...p, y: p.y + dy })) }
  const escapeFloor = preservedFloors.find(p => Math.abs(p.x - originCell.x) + Math.abs(p.z - originCell.z) === 1 && Math.abs(p.y + 1 - level) <= 1)
  if (!escapeFloor) return null
  for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const furnace = { x: originCell.x + dx, y: level, z: originCell.z + dz }, table = { x: originCell.x + dx * 2, y: level, z: originCell.z + dz * 2 }
    const clearance = [furnace, { ...furnace, y: level + 1 }, table, { ...table, y: level + 1 }], reserved = [{ ...furnace, y: level - 1 }, { ...table, y: level - 1 }, { ...furnace, y: level + 2 }, { ...table, y: level + 2 }]
    if ([...clearance, ...reserved].some(p => forbidden.has(key(p))) || !reserved.every(p => solid(read(world, p)))) continue
    let valid = true
    for (const p of clearance) {
      const block = read(world, p)
      if (!(empty(block) || solid(block) && !block.protected && block.natural !== false)) { valid = false; break }
      for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const b = read(world, { x: p.x + x, y: p.y + y, z: p.z + z }); if (!b?.known || HAZARD.test(name(b)) || b.extra?.length) valid = false }
    }
    if (!valid) continue
    const site = { id: scope + ':' + key(furnace), scope, worldScope: stationWorldScope(state), originCell, corridor, furnace, table, clearance, reserved, returnTarget: { x: escapeFloor.x + 0.5, y: escapeFloor.y + 1, z: escapeFloor.z + 0.5 }, predictionOnly: true, serverConfirmed: false }
    // These projected blocks never leave this private planning closure. The
    // live World remains unchanged until the existing controllers receive ACKs.
    const removed = new Set(clearance.map(key)), projected = devices => ({ getBlock: (x, y, z) => {
      const p = { x, y, z }, raw = read(world, p)
      if (devices && [key(furnace), key(table)].includes(key(p))) return { ...read(world, reserved[0]), position: p }
      return removed.has(key(p)) ? { known: true, position: p, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] } : raw
    } })
    try {
      const clearWorld = projected(false), initial = physics.fromServer(state), far = nativeLeg(physics, clearWorld, initial, { x: table.x + 0.5, y: level, z: table.z + 0.5 }, avoidance)
      if (!far || !nativeLeg(physics, clearWorld, far, corridor, avoidance) || !nativeLeg(physics, projected(true), initial, site.returnTarget, avoidance)) continue
      if (!placementTopVisible({ state, target: table, getBlock: p => read(clearWorld, p) })) continue
      const deviceWorld = { getBlock: (x, y, z) => key({ x, y, z }) === key(table) ? { ...read(clearWorld, table), name: 'minecraft:crafting_table', boundingBox: 'block' } : key({ x, y, z }) === key(furnace) ? { ...read(clearWorld, furnace), name: 'minecraft:furnace', boundingBox: 'block' } : clearWorld.getBlock(x, y, z) }
      const rearOnly = { getBlock: (x, y, z) => key({ x, y, z }) === key(furnace) ? clearWorld.getBlock(x, y, z) : deviceWorld.getBlock(x, y, z) }
      if (!placementTopVisible({ state, target: furnace, getBlock: p => read(rearOnly, p) }) || !useRays(state, site, deviceWorld)) continue
      return site
    } catch { /* A failed Native/body/LOS proof cannot create a worksite. */ }
  }
  return null
}
function preparationTableTarget ({ state, world, preservedFloors, avoidance = [] }) {
  const y = Math.round(state.position.y - 1.62), forbidden = new Set()
  if (Math.abs(state.position.y - 1.62 - y) > 1e-4 || !Array.isArray(preservedFloors)) return null
  for (const p of preservedFloors) for (let dy = 0; dy <= 3; dy++) forbidden.add(key({ ...p, y: p.y + dy }))
  for (let x = Math.floor(state.position.x) - 3; x <= Math.floor(state.position.x) + 3; x++) for (let z = Math.floor(state.position.z) - 3; z <= Math.floor(state.position.z) + 3; z++) {
    const target = { x, y, z }, b = read(world, target), distance = Math.hypot(x + 0.5 - state.position.x, z + 0.5 - state.position.z)
    if (distance < 1.3 || distance > 3 || forbidden.has(key(target)) || !empty(b) || b.protected || b.natural === false || !solid(read(world, { x, y: y - 1, z })) || !empty(read(world, { x, y: y + 1, z }))) continue
    if ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => { const n = read(world, { x: x + dx, y: y + dy, z: z + dz }); return !n?.known || HAZARD.test(name(n)) || n.extra?.length })) continue
    if (avoidance.some(a => Math.hypot(x + 0.5 - a.position.x, y + 1.62 - a.position.y, z + 0.5 - a.position.z) < a.minDistance)) continue
    if (placementTopVisible({ state, target, getBlock: p => read(world, p) })) return target
  }
  return null
}
function portableFallbackStop ({ state, world, preservedFloors, physics, avoidance = [], inspected = [] }) {
  if (!Array.isArray(preservedFloors) || inspected.length >= 3 || !physics) return null
  const currentY = state.position.y - 1.62
  const choices = preservedFloors.map(p => ({ x: p.x + 0.5, y: p.y + 1, z: p.z + 0.5 })).filter(p => !inspected.includes(key({ x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) })) && Math.hypot(p.x - state.position.x, p.z - state.position.z) >= 0.35 && Math.hypot(p.x - state.position.x, p.z - state.position.z) <= 2.1 && Math.abs(p.y - currentY) <= 1.0001).sort((a, b) => b.y - a.y || Math.hypot(a.x - state.position.x, a.z - state.position.z) - Math.hypot(b.x - state.position.x, b.z - state.position.z))
  try { for (const target of choices) if (nativeLeg(physics, world, physics.fromServer(state), target, avoidance)) return target } catch { return null }
  return null
}
function nextPortableStep ({ state, memo, world }) {
  const site = memo?.site, wait = code => ({ type: 'wait', stage: 'portable_worksite', code, reason: '地下の作業場所と持ち物の受信を待ちます。' })
  if (!site || site.scope !== supplyScope(state) || !footprintFree(site, world)) return wait('portable_site_changed')
  const current = state.predicted?.physicsState ?? state.physicsState
  if (current?.onGround !== true || current.isInWater || current.isInLava) return wait('portable_standing_required')
  const decision = (type, extra) => ({ type, stage: 'portable_worksite', portableSiteId: site.id, requiresLivePreview: true, requiresReobservation: true, ...extra })
  const tablePresent = name(read(world, site.table)) === 'crafting_table', furnacePresent = ['furnace', 'lit_furnace'].includes(name(read(world, site.furnace)))
  const ack = kind => memo.receipts?.[kind]?.serverConfirmed === true && memo.receipts[kind].scope === site.scope
  if (tablePresent && !ack('table') || furnacePresent && !ack('furnace')) return wait('portable_placement_unconfirmed')
  if (tablePresent && furnacePresent && ack('table') && ack('furnace')) {
    if (memo.deployedProof?.scope === site.scope) return { deployed: true, site }
    return near(state, site.corridor) ? wait('portable_deployment_verification') : decision('move_to', { target: point(site.corridor), allowWater: false })
  }
  const a = { x: site.furnace.x + 0.5, y: site.furnace.y, z: site.furnace.z + 0.5 }, b = { x: site.table.x + 0.5, y: site.table.y, z: site.table.z + 0.5 }
  const clearA = empty(read(world, site.furnace)) && empty(read(world, { ...site.furnace, y: site.furnace.y + 1 })), clearB = empty(read(world, site.table)) && empty(read(world, { ...site.table, y: site.table.y + 1 }))
  if (!clearA && !furnacePresent) return near(state, site.corridor) ? decision('excavate_worksite_step', { target: point(site.furnace) }) : decision('move_to', { target: point(site.corridor), allowWater: false })
  if (!clearB && !tablePresent) return near(state, a) ? decision('excavate_worksite_step', { target: point(site.table) }) : decision('move_to', { target: a, allowWater: false })
  if (!near(state, site.corridor)) return decision('move_to', { target: point(site.corridor), allowWater: false })
  const item = tablePresent ? 'minecraft:furnace' : 'minecraft:crafting_table', held = state.inventory.items.find(i => i.name === item && i.count > 0)
  if (!held) return wait('portable_item_missing')
  return decision('place_worksite_block', { item, slot: held.slot, target: point(tablePresent ? site.furnace : site.table) })
}
function verifyPortableDeployment ({ state, memo, world, physics, avoidance = [] }) {
  const site = memo?.site
  if (!site || site.scope !== supplyScope(state) || !near(state, site.corridor) || !footprintFree(site, world) || name(read(world, site.table)) !== 'crafting_table' || !['furnace', 'lit_furnace'].includes(name(read(world, site.furnace)))) return false
  if (!['table', 'furnace'].every(kind => memo.receipts?.[kind]?.serverConfirmed === true && memo.receipts[kind].scope === site.scope)) return false
  try { return useRays(state, site, world) && !!nativeLeg(physics, world, physics.fromServer(state), site.returnTarget, avoidance) } catch { return false }
}
module.exports = { portableKit, reservedWorksiteCells, selectPortableWorksite, preparationTableTarget, portableFallbackStop, nextPortableStep, verifyPortableDeployment, portableSiteValid: footprintFree, useRays }
