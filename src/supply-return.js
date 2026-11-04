'use strict'

const { resourceMinHealth } = require('./learning-health')
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const integer = p => finite(p) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const key = p => `${p.x},${p.y},${p.z}`
const name = b => String(b?.name ?? '').replace(/^minecraft:/, '')
const copy = v => structuredClone(v)
const SUPPORT = new Set(['stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const AIR = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'fern', 'leaf_litter', 'torch'])
const clear = b => b?.known === true && !b.extra?.length && AIR.has(name(b)) && (['air', 'cave_air', 'void_air'].includes(name(b)) || b.boundingBox === 'empty')

function supplyScope (state) {
  if (typeof state?.profile !== 'string' || !state.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || !['overworld', 'nether', 'end'].includes(state.dimension) || !/^\d+$/.test(String(state.runtimeEntityId ?? '')) || !Number.isSafeInteger(state.lifecycle?.deathId) || state.lifecycle.deathId < 0) return null
  return JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId), state.lifecycle.deathId])
}
function tableMaterialShortfall (state) {
  const items = state.inventory?.items ?? []
  const count = pattern => items.reduce((sum, i) => sum + (pattern.test(String(i.name)) && Number.isSafeInteger(i.count) && i.count > 0 ? i.count : 0), 0)
  return state.inventory?.known === true && !state.inventory.uncertain && count(/(?:^|:)crafting_table$/) === 0 && count(/_planks$/) < 4 && count(/_log$/) === 0
}
function currentStationPage (state, page, kind = 'table', now = Date.now()) {
  const scope = supplyScope(state), expected = kind === 'table' ? ['crafting_table'] : ['furnace', 'lit_furnace']
  if (!scope || !Array.isArray(page?.blocks) || page.blocks.length < 1 || page.blocks.length > 343 || page?.scope !== scope || !Number.isFinite(page.readAt) || page.readAt > now || now - page.readAt > 10000 || !integer(page.position) || page.block?.known !== true || !integer(page.block.position) || key(page.position) !== key(page.block.position) || !expected.includes(name(page.block)) || page.block.protected || page.block.protectionSource || page.block.usable === false || page.block.extra?.length || page.source !== 'current_world_read') return null
  return page
}
const stationWorldScope = state => typeof state?.profile === 'string' && state.profile && state.realm?.id != null && ['overworld', 'nether', 'end'].includes(state.dimension) ? JSON.stringify([state.profile, String(state.realm.id), state.dimension]) : null
function updateStationCatalog ({ state, blocks, catalog, now = Date.now() }) {
  const scope = stationWorldScope(state)
  if (!scope || !supplyScope(state) || !Array.isArray(blocks)) return catalog ?? { version: 1, scopes: {} }
  const scopes = catalog?.version === 1 && catalog.scopes && !Array.isArray(catalog.scopes) ? { ...catalog.scopes } : {}
  const entries = new Map()
  for (const item of Array.isArray(scopes[scope]?.entries) ? scopes[scope].entries.slice(0, 16) : []) if (['craftingTable', 'furnace'].includes(item.kind) && integer(item.position)) entries.set(item.kind + ':' + key(item.position), copy(item))
  for (const block of blocks) {
    const kind = name(block) === 'crafting_table' ? 'craftingTable' : ['furnace', 'lit_furnace'].includes(name(block)) ? 'furnace' : null
    if (!kind || block?.known !== true || !integer(block.position)) continue
    entries.set(kind + ':' + key(block.position), { kind, position: copy(block.position), seenAt: now, source: 'observed_received_block' })
  }
  const selected = []
  for (const kind of ['craftingTable', 'furnace']) selected.push(...[...entries.values()].filter(item => item.kind === kind).sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0)).slice(0, 8))
  scopes[scope] = { entries: selected, readAt: now }
  const keep = Object.entries(scopes).sort(([a, x], [b, y]) => Number(b === scope) - Number(a === scope) || (y.readAt ?? 0) - (x.readAt ?? 0)).slice(0, 4)
  return { version: 1, scopes: Object.fromEntries(keep) }
}
function readStationPages ({ state, stations, catalog, world, now = Date.now() }) {
  const scope = supplyScope(state), pages = {}
  if (!scope || !finite(state.position) || typeof world?.getBlock !== 'function') return pages
  for (const [kind, record] of [['craftingTable', stations?.craftingTable ?? stations?.table], ['furnace', stations?.furnace]]) {
    const expected = kind === 'craftingTable' ? ['crafting_table'] : ['furnace', 'lit_furnace']
    const history = catalog?.version === 1 ? catalog.scopes?.[stationWorldScope(state)]?.entries : []
    const positions = new Map()
    if (record?.known === true && integer(record.position)) positions.set(key(record.position), record.position)
    for (const item of Array.isArray(history) ? history.slice(0, 16) : []) if (item.kind === kind && integer(item.position)) positions.set(key(item.position), item.position)
    const observed = [...positions.values()].map(position => ({ position, block: world.getBlock(position.x, position.y, position.z) }))
    const valid = observed.filter(item => item.block?.known === true && expected.includes(name(item.block)) && !item.block.protected && !item.block.protectionSource && item.block.usable !== false && !item.block.extra?.length)
    valid.sort((a, b) => Math.hypot(a.position.x + 0.5 - state.position.x, a.position.y + 0.5 - state.position.y, a.position.z + 0.5 - state.position.z) - Math.hypot(b.position.x + 0.5 - state.position.x, b.position.y + 0.5 - state.position.y, b.position.z + 0.5 - state.position.z))
    // Keep an own-placement AIR/unknown diagnostic if there is no current
    // candidate; currentStationPage still refuses it as a station identity.
    const selected = valid[0] ?? observed.find(item => record?.known === true && integer(record.position) && key(item.position) === key(record.position))
    if (!selected) continue
    const position = copy(selected.position), blocks = []
    for (let x = position.x - 3; x <= position.x + 3; x++) for (let y = position.y - 3; y <= position.y + 3; y++) for (let z = position.z - 3; z <= position.z + 3; z++) blocks.push(copy(world.getBlock(x, y, z)))
    pages[kind] = { position, block: copy(world.getBlock(position.x, position.y, position.z)), blocks, scope, readAt: now, source: 'current_world_read', usable: false, serverConfirmed: false }
  }
  return pages
}

// A connected graph of preserved floor receipts is a planning constraint,
// never a chronological visited prefix or proof that the player has returned.
function planSupplyReturn ({ state, floors, floorScope, stationPage, world, now = Date.now() }) {
  const scope = supplyScope(state), result = reason => ({ ready: false, reason, scope, predictionOnly: true, serverConfirmed: false })
  if (!scope || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || !finite(state.position) || !['survival', 0].includes(state.gameMode) || !tableMaterialShortfall(state)) return result('not_needed_or_not_alive')
  const page = currentStationPage(state, stationPage, 'table', now)
  if (!page) return result('station_not_current')
  if (!floorScope || floorScope.profile !== state.profile || String(floorScope.realmId) !== String(state.realm.id) || floorScope.dimension !== state.dimension || !Array.isArray(floors) || !floors.length || floors.length > 1024 || typeof world?.getBlock !== 'function') return result('floor_scope_unknown')
  const physical = state.predicted?.physicsState ?? state.physicsState, feetY = state.position.y - 1.62, feet = Math.round(feetY), worksiteY = page.position.y - 2
  if (Math.abs(feetY - feet) > 1e-4 || physical?.onGround !== true || physical.isInWater || physical.isInLava) return result('standing_not_proven')
  if (feet >= worksiteY) return result('at_worksite')
  const nodes = new Map()
  for (const point of floors) {
    if (!integer(point) || point.y < -65 || point.y > 318 || Math.abs(point.x) > 30000000 || Math.abs(point.z) > 30000000) return result('invalid_floor_record')
    const b = world.getBlock(point.x, point.y, point.z)
    // protected:tunnel_floor is allowed support; this helper never digs it.
    if (b?.known !== true || b.boundingBox !== 'block' || !SUPPORT.has(name(b)) || b.extra?.length || !clear(world.getBlock(point.x, point.y + 1, point.z)) || !clear(world.getBlock(point.x, point.y + 2, point.z))) continue
    nodes.set(key(point), { x: point.x + 0.5, y: point.y + 1, z: point.z + 0.5 })
  }
  const origin = { x: Math.floor(state.position.x), y: feet - 1, z: Math.floor(state.position.z) }, originKey = key(origin)
  if (!nodes.has(originKey)) return result('current_floor_not_preserved')
  const queue = [originKey], parents = new Map([[originKey, null]])
  let goal = null, highest = originKey
  for (let index = 0; index < queue.length && index < 1024; index++) {
    const id = queue[index], p = nodes.get(id)
    if (p.y > nodes.get(highest).y) highest = id
    if (p.y >= worksiteY) { goal = id; break }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [1, 0, -1]) {
      const next = key({ x: p.x - 0.5 + dx, y: p.y - 1 + dy, z: p.z - 0.5 + dz })
      if (nodes.has(next) && !parents.has(next)) { parents.set(next, id); queue.push(next) }
    }
  }
  goal ??= highest
  if (nodes.get(goal).y <= feet || goal === originKey) {
    const lowerConnected = queue.some(id => nodes.get(id).y < feet)
    return lowerConnected ? { ...result('at_supply_exit'), localSupplyFallback: true, stationTarget: copy(page.position), endpoint: copy(nodes.get(originKey)), source: 'current_scoped_preserved_tunnel_floor_graph' } : result('return_route_incomplete')
  }
  const path = []
  for (let id = goal; parents.get(id) !== null; id = parents.get(id)) path.push(copy(nodes.get(id)))
  path.reverse()
  const waypoints = path.slice(0, 2)
  return { ready: true, kind: 'table_supply_return', scope, origin: copy(state.position), stationTarget: copy(page.position), target: copy(waypoints.at(-1)), waypoints, worksiteY, entryRouteKnown: nodes.get(goal).y >= worksiteY, source: 'current_scoped_preserved_tunnel_floor_graph', requiresLivePreview: true, requiresReobservation: true, predictionOnly: true, serverConfirmed: false }
}

module.exports = { supplyScope, tableMaterialShortfall, currentStationPage, stationWorldScope, updateStationCatalog, readStationPages, planSupplyReturn }
