'use strict'

const { resourceMinHealth } = require('./learning-health')

const { nextBootstrapAction, inventoryCounts } = require('./planner')
const { planStationAccess, placementTopVisible, planPlacementAccess } = require('./action-access')
const { traceBlockFace } = require('./aim')
const { supplyScope, tableMaterialShortfall, currentStationPage } = require('./supply-return')
const { portableKit } = require('./portable-worksite')

const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar'])
const FUEL_WOODS = new Set([...WOODS, 'bamboo'])
const TIERS = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }
const STONE_ITEMS = new Set(['cobblestone', 'cobbled_deepslate'])
const RAW_IRON = new Set(['raw_iron', 'iron_ore', 'deepslate_iron_ore'])
const ORES = { coal: new Set(['coal_ore', 'deepslate_coal_ore']), iron: new Set(['iron_ore', 'deepslate_iron_ore']), diamond: new Set(['diamond_ore', 'deepslate_diamond_ore']) }
const AIR = new Set(['air', 'cave_air', 'void_air'])
const SUPPORT = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|scaffolding)/
const ADJACENT = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const BUSY = new Set(['running', 'queued', 'mining', 'moving', 'walking', 'crafting', 'placing', 'opening', 'collecting', 'requesting', 'awaiting_server_confirmation'])
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const fullName = value => `minecraft:${nameOf(value)}`
const amount = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const key = point => `${point.x},${point.y},${point.z}`
const copyPoint = point => ({ x: point.x, y: point.y, z: point.z })
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const isLog = name => name.endsWith('_log') && WOODS.has(name.slice(0, -4))
const isWoodFuel = name => name.endsWith('_planks') && FUEL_WOODS.has(name.slice(0, -7))
const isFuel = name => ['coal', 'charcoal'].includes(name) || isWoodFuel(name)
const distance = (eye, point) => Math.hypot(point.x + 0.5 - eye.x, point.y + 0.5 - eye.y, point.z + 0.5 - eye.z)
const entityId = item => item.entityId ?? item.runtimeEntityId ?? item.runtimeId ?? item.id
const resourceScope = state => state && typeof state.profile === 'string' && state.realm?.id != null && typeof state.dimension === 'string' && typeof state.connectionId === 'string'
  ? JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, String(state.runtimeEntityId ?? '')]) : null
const MIN_BULK_DURABILITY = 5

function bulkToolState (item) {
  if (item.durabilityKnown === true) {
    const maximum = item.maxDurability
    const used = item.durabilityUsed
    const remaining = item.durabilityRemaining ?? (Number.isSafeInteger(maximum) && Number.isSafeInteger(used) ? maximum - used : undefined)
    if (!Number.isSafeInteger(remaining) || remaining < 0 || maximum != null && (!Number.isSafeInteger(maximum) || maximum < remaining || maximum < 1) || used != null && (!Number.isSafeInteger(used) || used < 0 || maximum != null && used + remaining !== maximum)) return 'unknown'
    return remaining >= MIN_BULK_DURABILITY ? 'usable' : 'worn'
  }
  // Old pure-planner fixtures predate server NBT descriptions. Preserve their
  // planning contract, but never infer "new" from metadata, a name or damage=0.
  if (item.durabilityKnown == null && [item.durabilityRemaining, item.durabilityUsed, item.maxDurability, item.damage].every(value => value == null)) return 'legacy'
  return 'unknown'
}

// Decisions only: every expense, placement, dig and furnace transfer must be
// revalidated and confirmed by the connection-owned executor. Subgoal completion
// never substitutes for observing actual diamonds in the server inventory.
function nextDiamondAction (state, observations = {}, options = {}) {
  state = state ?? {}
  const goalCount = Number.isSafeInteger(options.diamondCount) && options.diamondCount > 0 ? options.diamondCount : 1
  const reserveIron = options.reserveResource === 'iron'
  const reserveCount = options.reserveCount
  const goal = reserveIron ? { iron: reserveCount } : { diamond: goalCount }
  const items = Array.isArray(state.inventory?.items) ? state.inventory.items : []
  const count = predicate => items.reduce((sum, item) => sum + (predicate(nameOf(item.name)) ? amount(item.count) : 0), 0)
  const counts = { ...inventoryCounts(items), diamond: count(name => name === 'diamond'), ironIngots: count(name => name === 'iron_ingot'), rawIron: count(name => RAW_IRON.has(name)), coal: count(name => name === 'coal'), charcoal: count(name => name === 'charcoal') }
  const progress = observations.progress ?? {}
  const result = (type, stage, reason, data = {}) => ({ type, stage, reason, goal: { ...goal }, counts: { ...counts }, ...data })
  const has = (name, aliases = []) => {
    for (const source of [observations.capabilities, state.capabilities]) for (const alias of [name, ...aliases]) {
      if (source && Object.hasOwn(source, alias)) return source[alias] === true || source[alias]?.available === true
    }
    return name === 'craft' && observations.crafting?.available === true
  }
  const requireAction = (capability, action, aliases = []) => has(capability, aliases) ? action : result('capability_required', action.stage, `次の工程には未実装の機能が必要です: ${capability}`, { capability, proposedAction: action })
  const wrap = (action, subgoal) => ({ ...action, goal: { ...goal }, counts: { ...counts }, ...(action.type === 'mine_stone' ? { requiresKnownDurability: true } : {}), ...(subgoal ? { subgoal } : {}) })
  const wait = (stage, code, reason, data = {}) => result('wait', stage, reason, { code, ...data })

  if (options.reserveResource != null && (!reserveIron || !Number.isSafeInteger(reserveCount) || reserveCount < 1 || reserveCount > 4096)) return wait('iron_reserve', 'invalid_reserve_goal', 'A bounded explicit iron reserve count is required.')
  if (state.phase !== 'spawned') return wait('observation', 'not_spawned', 'ワールドへの参加を待ちます。')
  if (state.dead === true || state.isDead === true || state.health === 0) return requireAction('respawn', result('respawn', 'safety', '死亡を確認したため、素材集めより復帰を優先します。'))
  if (!state.inventory?.known || state.inventory?.uncertain === true) return wait('observation', 'inventory_unknown', 'サーバーで確定した持ち物の一覧を待ちます。')
  if (reserveIron && Number.isFinite(state.health) && state.health > 0 && counts.ironIngots + counts.rawIron >= reserveCount) return result('complete', 'iron_reserve', 'The requested iron reserve is present in actual inventory.', { resource: 'iron', confirmedBy: 'server_inventory' })
  if (!reserveIron && Number.isFinite(state.health) && state.health > 0 && counts.diamond >= goalCount) return result('complete', 'diamond', '目標数のダイヤモンドを実際の持ち物で確認しました。', { confirmedBy: 'server_inventory' })
  if (!Number.isFinite(state.health)) return wait('observation', 'health_unknown', '体力の観測を待ちます。')
  if (state.health <= resourceMinHealth(state, options.minHealth ?? 6)) return result('stop', 'safety', '体力が少ないため作業を停止します。', { code: 'low_health' })
  if (state.gameMode !== 'survival' && state.gameMode !== 0) return result('stop', 'safety', 'この計画はサバイバル用です。', { code: 'unsupported_game_mode' })
  if (!finite(state.position)) return wait('observation', 'position_unknown', '現在の位置をサーバーから取得するまで待ちます。')
  if (state.version && state.world?.version && state.version !== state.world.version) return result('stop', 'safety', '接続と地形データの版が一致しません。', { code: 'world_version_mismatch' })
  if (state.world?.initialized === false || state.world?.loadedSections === 0 || observations.worldLoaded === false) return wait('observation', 'world_not_loaded', '周囲の地形の読み込みを待ちます。')
  const occupied = new Set(items.filter(item => amount(item.count) && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot))
  if (state.inventory.full || occupied.size >= 36) return result('stop', 'safety', '持ち物が満杯のため作業を停止します。', { code: 'inventory_full' })
  const pending = task => task?.busy === true || task?.pendingOperation != null || task?.pendingRequestId != null
  const finishedMotion = task => task?.phase === 'awaiting_server_confirmation' && task.running !== true && !pending(task)
  const otherTasks = [state.task, state.mining, state.crafting, state.interactions, state.furnace, observations.task, observations.crafting, observations.furnace]
  const motions = [state.walking, state.movement]
  if (otherTasks.some(task => pending(task) || BUSY.has(task?.phase)) || motions.some(task => pending(task) || task?.running === true || !finishedMotion(task) && (BUSY.has(task?.phase) || task?.phase === 'settling'))) return wait('task', 'task_in_progress', '進行中の処理のサーバー結果を待ちます。')
  // Navigation's prediction remains labelled unconfirmed after its input has
  // ended. Hide only that inactive task marker from the shared resource planner;
  // retain the host's labelled position and every inventory/block requirement.
  const motionState = finishedMotion(state.walking) ? { ...state, walking: null } : state

  const blocks = Array.isArray(observations.blocks) ? observations.blocks : []
  const known = blocks.filter(block => block?.known === true && integer(block.position))
  const blockMap = new Map(known.map(block => [key(block.position), block]))
  const latestBlocks = new Map(blocks.filter(block => integer(block?.position)).map(block => [key(block.position), block]))
  const excluded = (resource, point) => (progress.excludedResources ?? []).some(entry => {
    if (typeof entry === 'string') return entry === key(point) || entry === `${resource}:${key(point)}`
    if (entry?.scope != null && entry.scope !== resourceScope(state)) return false
    const target = entry?.position ?? entry?.target ?? entry
    return integer(target) && (entry.resource == null || entry.resource === resource) && key(target) === key(point)
  })
  const excludedDrops = new Set((progress.excludedDropIds ?? []).map(String))
  const allTools = items.filter(item => amount(item.count) && TIERS[nameOf(item.name)])
  const tools = allTools.filter(item => ['usable', 'legacy'].includes(bulkToolState(item))).sort((a, b) => Number(bulkToolState(b) === 'usable') - Number(bulkToolState(a) === 'usable') || TIERS[nameOf(b.name)] - TIERS[nameOf(a.name)] || (b.durabilityRemaining ?? 0) - (a.durabilityRemaining ?? 0) || (a.slot ?? 99) - (b.slot ?? 99))
  const eligibleTools = new Set(tools)
  const wornTools = allTools.filter(item => bulkToolState(item) === 'worn')
  const unknownTools = allTools.filter(item => bulkToolState(item) === 'unknown')
  const heldSlot = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot ?? state.heldItem?.slot
  const heldTool = allTools.find(item => item.slot === heldSlot)
  const resourceState = { ...motionState, inventory: { ...state.inventory, items: items.filter(item => !TIERS[nameOf(item.name)] || eligibleTools.has(item)) }, heldItem: state.heldItem && TIERS[nameOf(state.heldItem.name)] && !eligibleTools.has(heldTool) ? null : state.heldItem }
  const pick = tier => tools.find(item => TIERS[nameOf(item.name)] >= tier)
  function equip (tool, stage) {
    if (state.equipmentServerConfirmed !== false && nameOf(state.heldItem?.name) === nameOf(tool.name) && heldSlot === tool.slot) return null
    return requireAction('equip', result('equip', stage, '必要な採掘段階のツルハシを選びます。', { item: fullName(tool.name), slot: tool.slot, requiredToolTier: TIERS[nameOf(tool.name)], requiresServerInventory: true, requiresKnownDurability: true }), ['equipment', 'inventory_operations'])
  }
  function drops (names, resource, needed) {
    const available = (observations.drops ?? []).filter(item => item.known === true && names.has(nameOf(item.name)) && amount(item.count) && finite(item.position) && !excludedDrops.has(String(entityId(item))) && item.protected !== true).sort((a, b) => Math.hypot(a.position.x - state.position.x, a.position.y - state.position.y, a.position.z - state.position.z) - Math.hypot(b.position.x - state.position.x, b.position.y - state.position.y, b.position.z - state.position.z))
    if (!available.length) return null
    return requireAction('collect_drops', result('collect_drops', resource, '必要な資材が既に落ちているため、先に回収を試みます。', { resource, count: needed, targets: available.slice(0, Math.min(8, needed)).map(item => ({ entityId: entityId(item), name: fullName(item.name), count: item.count, position: { ...item.position } })) }), ['pickup', 'collection'])
  }
  const diamondDrop = reserveIron ? null : drops(new Set(['diamond']), 'diamond', goalCount - counts.diamond)
  if (diamondDrop) return diamondDrop

  function baseSubstep (requiredStone, label) {
    if (counts.stone >= requiredStone) return null
    const pickup = drops(STONE_ITEMS, 'stone', requiredStone - counts.stone)
    if (pickup) return wrap(pickup, { name: label, stone: requiredStone })
    if (!tools.length && unknownTools.length && !wornTools.length) return wait('tool', 'tool_durability_unknown', 'ツルハシの実際の残り耐久が不明なため、道具のサーバー情報を待ちます。', { requiresKnownDurability: true })
    const action = nextBootstrapAction(resourceState, observations, { ...options, stoneCount: requiredStone })
    if (action.type === 'complete') return wait('observation', 'subgoal_changed', '下位工程の持ち物を再確認します。')
    return wrap(action, { name: label, stone: requiredStone })
  }
  const readBlock = point => latestBlocks.get(key(point))
  const stationCache = new Map()
  function furnaceAccess (target, stationBlocks = blocks, readStation = readBlock) {
    const world = { getBlock: (x, y, z) => readStation({ x, y, z }) }
    // The furnace opener clicks its dominant face CENTER, unlike the table
    // opener's visible-corner fallback. Prove that exact unchanged click ray.
    const visible = (eye, maxReach = 4.5) => {
      const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
      const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z
      const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
      const normal = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }][face]
      const axis = face < 2 ? 'y' : face < 4 ? 'z' : 'x'
      const point = { x: center.x + normal.x * 0.5, y: center.y + normal.y * 0.5, z: center.z + normal.z * 0.5 }
      const fraction = 0.001 / Math.abs(point[axis] - eye[axis])
      const inside = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, point[axis] + (point[axis] - eye[axis]) * fraction]))
      try { return traceBlockFace({ eye, target, point: inside, world, maxReach })?.face === face } catch { return false }
    }
    const support = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && (SUPPORT.has(nameOf(block.name)) || ['crafting_table', 'furnace', 'lit_furnace'].includes(nameOf(block.name)) || [...WOODS].some(wood => [wood + '_log', wood + '_planks'].includes(nameOf(block.name))))
    const open = block => block?.known === true && !block.extra?.length && (AIR.has(nameOf(block.name)) || ['short_grass', 'fern', 'leaf_litter', 'torch'].includes(nameOf(block.name)) && block.boundingBox === 'empty')
    const standing = p => {
      if (Math.abs(p.y - Math.round(p.y)) > 1e-4) return false
      const y = Math.round(p.y)
      for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++) for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) if (!support(readStation({ x, y: y - 1, z })) || !open(readStation({ x, y, z })) || !open(readStation({ x, y: y + 1, z }))) return false
      return true
    }
    const feet = { ...state.position, y: state.position.y - 1.62 }
    if (standing(feet) && visible(state.position)) return { ready: true }
    const cost = p => Math.hypot(p.x - feet.x, p.z - feet.z) + Math.abs(p.y - feet.y) * 2
    const stances = stationBlocks.filter(support).map(block => ({ x: block.position.x + 0.5, y: block.position.y + 1, z: block.position.z + 0.5 })).filter(p => Math.hypot(p.x - feet.x, p.y - feet.y, p.z - feet.z) > 0.4 && distance({ ...p, y: p.y + 1.62 }, target) <= 4.1 && standing(p)).sort((a, b) => cost(a) - cost(b))
    const offsets = [{ x: 0, z: 0 }, { x: 0.25, z: 0 }, { x: -0.25, z: 0 }, { x: 0, z: 0.25 }, { x: 0, z: -0.25 }, { x: 0.2, z: 0.2 }, { x: 0.2, z: -0.2 }, { x: -0.2, z: 0.2 }, { x: -0.2, z: -0.2 }]
    for (const standpoint of stances) if (offsets.every(offset => { const feet = { x: standpoint.x + offset.x, y: standpoint.y, z: standpoint.z + offset.z }; return standing(feet) && visible({ ...feet, y: feet.y + 1.62 }, 4.3) })) return { ready: false, standpoint, testedPoints: offsets.length }
    return { ready: false, reason: 'no_known_station_stance' }
  }
  function station (kind) {
    if (stationCache.has(kind)) return stationCache.get(kind)
    const names = kind === 'table' ? new Set(['crafting_table']) : new Set(['furnace', 'lit_furnace'])
    const records = kind === 'table' ? [observations.craftingTable, observations.stations?.craftingTable, observations.stations?.table] : [observations.furnace, observations.stations?.furnace]
    const furnace = observations.furnace ?? {}
    const page = currentStationPage(state, observations.stationPages?.[kind === 'table' ? 'craftingTable' : 'furnace'], kind)
    const stationBlocks = page ? [...blocks, ...page.blocks] : blocks
    const stationMap = new Map(stationBlocks.filter(block => integer(block?.position)).map(block => [key(block.position), block]))
    const readStation = point => stationMap.get(key(point))
    const current = point => { const block = integer(point) ? readStation(point) : null; return block?.known === true && names.has(nameOf(block.name)) && block.protected !== true && !block.protectionSource && block.usable !== false && !block.extra?.length ? block : null }
    // A remembered location/window is history until a current received block
    // proves its identity. Do not delete the record or invent another station.
    const candidates = [...(page ? [page.block] : []), ...records.filter(record => record?.known === true && record.protected !== true && record.usable !== false && integer(record.position)).map(record => current(record.position)), ...(kind === 'furnace' ? [current(furnace.window?.coordinates)] : []), ...known.map(block => current(block.position))].filter(Boolean)
    const knownContents = place => kind === 'furnace' && furnace.window && ['furnace', 2].includes(furnace.window.type) && integer(furnace.window.coordinates) && key(furnace.window.coordinates) === key(place.position) && furnace.contentsKnown === true && furnace.inventoryUncertain !== true
    const openWindow = place => knownContents(place) && furnace.needsOpen !== true
    const activeWork = place => kind === 'furnace' && (nameOf(place.name) === 'lit_furnace' || knownContents(place) && (furnace.slots ?? []).some(slot => slot?.known === true && slot.count > 0 && ['raw_iron', 'iron_ore', 'deepslate_iron_ore', 'iron_ingot'].includes(nameOf(slot.name))))
    const seen = new Set()
    for (const block of candidates.sort((a, b) => Number(activeWork(b)) - Number(activeWork(a)) || distance(state.position, a.position) - distance(state.position, b.position))) {
      if (seen.has(key(block.position))) continue
      seen.add(key(block.position))
      const access = openWindow(block) ? { ready: true, source: 'known_same_open_furnace' } : kind === 'table' ? planStationAccess({ state, observedState: observations.state ?? state, target: block.position, blocks: stationBlocks, getBlock: readStation }) : furnaceAccess(block.position, stationBlocks, readStation)
      if (!access.ready && !access.standpoint && !activeWork(block) && !(kind === 'table' && page && key(page.position) === key(block.position))) continue
      const found = { ...block, position: { ...block.position }, access }
      stationCache.set(kind, found); return found
    }
    stationCache.set(kind, null); return null
  }
  function approachStation (place, kind) {
    if (place.access?.ready) return null
    if (place.access?.standpoint) return requireAction('move', result('move_to', kind, '作業場所の操作面を確認できる既知の足場へ近づきます。', { target: { ...place.access.standpoint }, stationTarget: { ...place.position }, resource: kind, allowWater: false, requiresReobservation: true, requiresLivePreview: true }), ['movement', 'walking'])
    return wait(kind, 'station_access_unproven', '作業中のかまどを別のものと取り違えず、操作できる足場と視線を再確認します。', { target: { ...place.position }, requiresLivePreview: true })
  }
  function craft (output, times, stage) {
    const proposal = result('craft', stage, `${nameOf(output)}を受信済みのレシピで作ります。`, { output: fullName(output), times, requiresLivePreview: true })
    if (!has('craft', ['crafting'])) return requireAction('craft', proposal, ['crafting'])
    const previews = observations.crafting?.previews
    const values = Array.isArray(previews) ? previews : previews && typeof previews === 'object' ? Object.entries(previews).map(([name, preview]) => ({ ...preview, _name: name })) : []
    const preview = values.find(value => nameOf(value.output?.name ?? value.output ?? value._name) === nameOf(output) && (value.times == null || value.times === times))
    if (!preview) return result('preview_craft', stage, '最新の材料とレシピでクラフト可能か確認します。', { output: fullName(output), times })
    if (preview.ready !== true) {
      if (preview.needsCraftingTable) {
        const table = station('table')
        if (!table) return wait(stage, 'crafting_table_missing', '利用できる作業台の観測を待ちます。')
        return approachStation(table, 'crafting_table') ?? requireAction('use_table', result('open_crafting_table', stage, '設置した作業台を開きます。', { target: { ...table.position } }), ['interaction', 'interactions'])
      }
      return wait(stage, 'craft_preview_not_ready', '材料またはレシピの事前確認が成立していません。', { output: fullName(output), times, errors: [...(preview.errors ?? [])] })
    }
    return { ...proposal, recipeNetworkId: preview.recipeNetworkId, expectedOutputCount: preview.output?.count }
  }
  function gatherWood (needed) {
    return wait('materials', 'wood_harvest_disabled', '手持ちの木材が不足しています。木の採取や探索は行いません。', { missingMaterials: { logs: needed }, woodCollectionDisabled: true })
  }
  function planks (needed, stage) {
    if (counts.planks >= needed) return null
    const logs = items.filter(item => isLog(nameOf(item.name)) && amount(item.count)).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
    if (!logs.length) return gatherWood(Math.ceil((needed - counts.planks) / 4))
    return craft(`${nameOf(logs[0].name).slice(0, -4)}_planks`, Math.min(logs[0].count, 16, Math.ceil((needed - counts.planks) / 4)), stage)
  }
  function sticks (needed, stage) {
    if (counts.sticks >= needed) return null
    const batches = Math.ceil((needed - counts.sticks) / 4)
    return planks(batches * 2, stage) ?? craft('stick', batches, stage)
  }
  function placement (kind, inventoryItem) {
    const supplied = observations.placements?.[kind] ?? (kind === 'crafting_table' ? observations.tablePlacement : observations.furnacePlacement)
    const feet = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
    const geometry = input => {
      const point = input?.position
      const block = integer(point) ? readBlock(point) : null
      if (block?.known !== true || !integer(point) || !AIR.has(nameOf(block.name)) || point.y !== feet.y || block.protected || block.protectionSource || block.natural === false || block.extra?.length || distance(state.position, point) > 4) return false
      if (Math.hypot(point.x + 0.5 - state.position.x, point.z + 0.5 - state.position.z) < 1.3) return false
      const below = readBlock({ ...point, y: point.y - 1 })
      return below?.known === true && SUPPORT.has(nameOf(below.name)) && below.boundingBox !== 'empty' && !below.extra?.length && ADJACENT.every(offset => { const neighbour = readBlock({ x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z }); return neighbour?.known === true && !HAZARD.test(nameOf(neighbour.name)) && !neighbour.extra?.length })
    }
    const suppliedBlock = supplied?.ready === true && integer(supplied.position) ? readBlock(supplied.position) : null
    const candidates = known.filter(geometry).sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position))
    const visible = block => placementTopVisible({ state, target: block.position, getBlock: readBlock })
    const target = geometry(suppliedBlock) && visible(suppliedBlock) ? suppliedBlock.position : candidates.find(visible)?.position
    if (!target) {
      const access = planPlacementAccess({ state, targets: candidates.map(block => block.position), blocks, getBlock: readBlock })
      if (access) return requireAction('move', result('move_to', kind, '作業用ブロックの設置面を確認できる既知の足場へ近づきます。', { target: { ...access.standpoint }, placementTarget: { ...access.target }, placementPurpose: kind, requiresReobservation: true, resource: kind, allowWater: false, stance: { positionTolerance: access.positionTolerance, testedPoints: access.testedPoints }, requiresLivePreview: true }), ['movement', 'walking'])
      return requireAction('scan_blocks', result('scan_blocks', kind, '作業用ブロックを置ける場所を追加で調べます。', { resource: kind, center: feet, rejectUnknown: true }), ['scan', 'world_scan'])
    }
    return requireAction(kind === 'furnace' ? 'place_furnace' : 'place_block', result(kind === 'furnace' ? 'place_furnace' : 'place_crafting_table', kind, '持っている作業用ブロックを確認済みの地面へ設置します。', { item: fullName(kind), slot: inventoryItem.slot, target: { ...target }, requiresLivePreview: true }), kind === 'furnace' ? [] : ['place_crafting_table', 'placement'])
  }
  function table () {
    const placed = station('table')
    if (placed && (placed.access.ready || placed.access.standpoint)) return approachStation(placed, 'crafting_table')
    const held = items.find(item => nameOf(item.name) === 'crafting_table' && amount(item.count))
    if (held) return placement('crafting_table', held)
    if (placed && tableMaterialShortfall(state) && state.position.y - 1.62 < placed.position.y - 2 - 1e-4 && !(observations.supplyReturn?.localSupplyFallback === true && observations.supplyReturn.scope === supplyScope(state) && observations.supplyReturn.reason === 'at_supply_exit' && observations.supplyReturn.source === 'current_scoped_preserved_tunnel_floor_graph')) {
      const back = observations.supplyReturn
      if (back?.ready === true && back.scope === supplyScope(state) && integer(back.stationTarget) && key(back.stationTarget) === key(placed.position) && Array.isArray(back.waypoints) && back.waypoints.length > 0 && back.waypoints.length <= 2 && back.waypoints.every(point => finite(point) && Math.abs(point.y - Math.round(point.y)) < 1e-4) && finite(back.target) && key(back.target) === key(back.waypoints.at(-1)) && back.nativePreview?.ready === true && back.source === 'current_scoped_preserved_tunnel_floor_graph') return requireAction('move', result('move_to', 'crafting_table', '資材を補うため、既知の坑道を短い区間ずつ戻ります。', { target: copyPoint(back.target), stationTarget: copyPoint(placed.position), supplyReturn: true, resource: 'crafting_table', allowWater: false, requiresReobservation: true, requiresLivePreview: true, predictionOnly: true, serverConfirmed: false }), ['movement', 'walking'])
      return result('scan_blocks', 'crafting_table', '資材を補う帰路の床と空間を再確認します。', { code: back?.reason ?? 'supply_return_observation_required', supplyReturnRequested: true, stationTarget: copyPoint(placed.position), resource: 'crafting_table', rejectUnknown: true, requiresReobservation: true })
    }
    return planks(4, 'crafting_table') ?? craft('crafting_table', 1, 'crafting_table')
  }
  function ore (resource, needed, requiredTier) {
    const pickup = drops(resource === 'iron' ? RAW_IRON : new Set([resource]), resource, needed)
    if (pickup) return pickup
    const inputs = [...(Array.isArray(observations.ores?.[resource]) ? observations.ores[resource] : []), ...known.filter(block => ORES[resource].has(nameOf(block.name)))]
    const targets = []
    const seen = new Set()
    for (const input of inputs) {
      const point = input.position ?? input
      // Current block observations override remembered ore metadata, including
      // a now-empty, protected or explicitly unknown cell after a prior dig.
      const observed = integer(point) ? latestBlocks.get(key(point)) ?? (input.name ? input : null) : null
      if (!integer(point) || observed?.known !== true || !ORES[resource].has(nameOf(observed.name)) || observed.protected || observed.natural === false || excluded(resource, point) || seen.has(key(point))) continue
      seen.add(key(point))
      targets.push({ ...observed, position: { ...point }, requiresTunnel: input.requiresTunnel === true })
    }
    targets.sort((a, b) => distance(state.position, a.position) - distance(state.position, b.position))
    if (!targets.length) {
      const scope = resourceScope(state)
      const emptyScan = scope && (progress.emptyProspects ?? []).some(receipt => receipt?.scope === scope && receipt.resource === resource && integer(receipt.position) && Number.isSafeInteger(receipt.known) && receipt.known > 0 && Number.isSafeInteger(receipt.unknown) && receipt.unknown >= 0 && Math.floor(receipt.position.x / 16) === Math.floor(state.position.x / 16) && Math.floor(receipt.position.z / 16) === Math.floor(state.position.z / 16))
      const knownExcludedOre = inputs.some(input => {
        const point = input.position ?? input
        const observed = integer(point) ? latestBlocks.get(key(point)) ?? (input.name ? input : null) : null
        const scopedExclusion = scope && (progress.excludedResources ?? []).some(entry => entry?.scope === scope && entry.resource === resource && integer(entry.position) && key(entry.position) === key(point))
        return observed?.known === true && ORES[resource].has(nameOf(observed.name)) && scopedExclusion
      })
      if (emptyScan || knownExcludedOre) return requireAction('explore', result('explore', resource, '現在地で必要な鉱石を確認できなかったため、既知の安全な足場を通って別の場所を調べます。', { resource, count: needed, requiredToolTier: requiredTier, rejectUnknown: true, allowWater: false, requiresKnownTerrain: true, requiresLivePreview: true, attempt: amount(progress.explorationAttempts) + 1 }), ['movement_exploration'])
      return requireAction('prospect', result('prospect', resource, '必要な鉱石を未取得の場所にあると決めつけず、確認できる地形を調べます。', { resource, count: needed, requiredToolTier: requiredTier, rejectUnknown: true }))
    }
    const byPosition = new Map(targets.map(target => [key(target.position), target]))
    // Reuse the tested full-cube resource geometry. This classification view
    // changes no material counts or live world. The dispatched action below
    // always names the actually observed ore, never the adapter's stone label.
    const geometry = blocks.map(block => byPosition.has(key(block.position ?? {})) ? { ...block, name: 'minecraft:stone' } : ['stone', 'deepslate'].includes(nameOf(block.name)) ? { ...block, name: 'minecraft:dirt' } : block)
    for (const target of targets) if (!geometry.some(block => integer(block.position) && key(block.position) === key(target.position))) geometry.push({ ...target, name: 'minecraft:stone' })
    const sub = nextBootstrapAction(resourceState, { ...observations, blocks: geometry }, { ...options, stoneCount: counts.stone + 1 })
    const action = sub.type === 'capability_required' ? sub.proposedAction : sub
    const selected = action?.type === 'mine_stone' ? byPosition.get(key(action.target)) : action?.type === 'move_to' ? byPosition.get(key(action.resourceTarget)) : null
    if (selected && !selected.requiresTunnel) {
      if (action.type === 'mine_stone') return requireAction('mine_ore', result('mine_ore', resource, '現在の工具で正規に採取できる鉱石を掘ります。', { target: { ...selected.position }, resourceTarget: { ...selected.position }, block: selected.name, resource, count: needed, requiredToolTier: requiredTier, requiresLivePreview: true, requiresKnownDurability: true }))
      return requireAction('move', result('move_to', resource, '鉱石に安全に手が届く観測済みの足場へ近づきます。', { target: { ...action.target }, resourceTarget: { ...selected.position }, block: selected.name, resource, requiredToolTier: requiredTier, stance: action.stance, requiresLivePreview: true, requiresKnownDurability: true }), ['movement', 'walking'])
    }
    const target = selected ?? targets[0]
    return requireAction('tunnel', result('tunnel', resource, '確認済みの鉱石へ、隣接する地形を検証しながら掘り進む必要があります。', { target: { ...target.position }, resourceTarget: { ...target.position }, targetOre: { name: target.name, position: { ...target.position } }, resource, requiredToolTier: requiredTier, rejectUnknown: true, requiresLivePreview: true, requiresKnownDurability: true }))
  }

  if (reserveIron) {
    const reserveTool = pick(2)
    if (reserveTool) return equip(reserveTool, 'iron_reserve') ?? ore('iron', reserveCount - counts.ironIngots - counts.rawIron, 2)
  }

  const ironTool = pick(3)
  if (ironTool) return equip(ironTool, 'diamond') ?? ore('diamond', goalCount - counts.diamond, 3)

  if (counts.ironIngots >= 3) {
    const materials = sticks(2, 'iron_pickaxe')
    if (materials) return materials
    const stationAction = table()
    if (stationAction) return stationAction
    return craft('iron_pickaxe', 1, 'iron_pickaxe')
  }

  const stoneTool = pick(2)
  if (!stoneTool) {
    const stone = baseSubstep(3, 'wood_pickaxe_and_cobblestone_3')
    if (stone) return stone
    const materials = sticks(2, 'stone_pickaxe')
    if (materials) return materials
    const stationAction = table()
    if (stationAction) return stationAction
    return craft('stone_pickaxe', 1, 'stone_pickaxe')
  }
  const selectStone = equip(stoneTool, 'iron_preparation')
  if (selectStone) return selectStone

  const portable = observations.portableWorksite
  const priorIronFurnace = observations.furnace
  const activeIronWork = priorIronFurnace?.contentsKnown === true && !priorIronFurnace.inventoryUncertain && (priorIronFurnace.slots ?? []).some(slot => slot.known === true && slot.count > 0 && (RAW_IRON.has(nameOf(slot.name)) || nameOf(slot.name) === 'iron_ingot')) && !!station('furnace')
  if (!activeIronWork && portable?.enabled === true && portable.scope === supplyScope(state) && portable.deployed !== true && counts.ironIngots < 3) {
    const kit = portableKit(state)
    if (counts.rawIron >= 3 && (kit.ready || portable.site) && portable.useExisting !== true) {
      if (portable.step) return { ...portable.step, goal: { ...goal }, counts: { ...counts } }
      return wait('portable_worksite', 'portable_site_required', '帰路を塞がない地下の作業場所を確認します。')
    }
    if (counts.rawIron < 3) {
      if (kit.furnace < 1) {
        const stone = baseSubstep(8, 'portable_furnace')
        if (stone) return stone
        const knownTable = station('table')
        if (kit.table > 0 && !knownTable?.access?.ready && !knownTable?.access?.standpoint) {
          if (portable.preparationTarget) return result('place_crafting_table', 'portable_station_kit', '帰路を塞がない確認済みの場所に準備用の作業台を置き、携帯用は後で作り直します。', { target: copyPoint(portable.preparationTarget), requiresLivePreview: true })
          if (portable.preparationStep) return { ...portable.preparationStep, goal: { ...goal }, counts: { ...counts } }
          return result('capability_required', 'portable_station_kit', '作業台を置ける既知の準備場所を確認します。', { capability: 'known_safe_workbench_placement' })
        }
        const access = table()
        if (access) return access
        return craft('furnace', 1, 'portable_station_kit')
      }
      const boards = (kit.table ? 0 : 4) + (kit.coal ? 0 : 3) + (kit.sticks >= 2 ? 0 : 2)
      const material = planks(boards, 'portable_station_kit')
      if (material) return material
      if (kit.sticks < 2) return craft('stick', 1, 'portable_station_kit')
      if (kit.table < 1) return craft('crafting_table', 1, 'portable_station_kit')
      if (!kit.fuelReady) return gatherWood(1)
      // Reserved devices are carried, never sent to the generic passage picker.
      return ore('iron', 3 - counts.rawIron, 2)
    }
  }
  const furnace = observations.furnace ?? {}
  const placedFurnace = station('furnace')
  if (!placedFurnace) {
    const held = items.find(item => nameOf(item.name) === 'furnace' && amount(item.count))
    if (held) return placement('furnace', held)
    const stone = baseSubstep(8, 'cobblestone_for_furnace')
    if (stone) return stone
    const stationAction = table()
    if (stationAction) return stationAction
    return craft('furnace', 1, 'furnace')
  }
  const slot = role => furnace.slots?.find(value => value.role === role)
  const input = slot('furnace_ingredient') ?? furnace.slots?.find(value => value.slot === 0)
  const fuel = slot('furnace_fuel') ?? furnace.slots?.find(value => value.slot === 1)
  const output = slot('furnace_output') ?? furnace.slots?.find(value => value.slot === 2)
  const sameFurnace = integer(furnace.window?.coordinates) && key(furnace.window.coordinates) === key(placedFurnace.position)
  const contentsKnown = sameFurnace && furnace.contentsKnown === true && !furnace.inventoryUncertain && [input, fuel, output].every(value => value?.known === true && Number.isSafeInteger(value.count) && value.count >= 0)
  const rawInside = contentsKnown && RAW_IRON.has(nameOf(input.name)) ? input.count : 0
  const ironOutput = contentsKnown && nameOf(output.name) === 'iron_ingot' ? output.count : 0
  const remainingIron = Math.max(0, 3 - counts.ironIngots - rawInside - ironOutput)
  const burning = contentsKnown && (furnace.burning === true || furnace.progress?.burnTicksRemaining > 0) || nameOf(blockMap.get(key(placedFurnace.position))?.name) === 'lit_furnace'
  const fuelPresent = contentsKnown && fuel.count > 0
  // Reserve the two planks needed to make sticks if the pickaxe sticks are
  // missing. One plank per remaining ingot is a deliberately conservative
  // fuel budget; actual furnace output remains the only completion evidence.
  const plankReserve = counts.sticks >= 2 ? 0 : 2
  const plankFuelCount = Math.max(1, 3 - counts.ironIngots - ironOutput)
  const fuelHeld = items.find(value => ['coal', 'charcoal'].includes(nameOf(value.name)) && amount(value.count)) ?? items.find(value => isWoodFuel(nameOf(value.name)) && amount(value.count) >= plankFuelCount && counts.planks - plankFuelCount >= plankReserve)
  const fuelCount = fuelHeld && isWoodFuel(nameOf(fuelHeld.name)) ? plankFuelCount : 1
  const fuelExhausted = contentsKnown && !burning && !fuelPresent && furnace.progress?.burnTicksRemaining === 0
  const last = furnace.lastTransfer
  const deposited = !contentsKnown && last?.phase === 'completed' && last.serverConfirmed === true && (last.operation === 'input' && RAW_IRON.has(nameOf(last.item)) || last.operation === 'fuel' && isFuel(nameOf(last.item)))
  const conflict = contentsKnown && (output.count > 0 && !ironOutput || input.count > 0 && !RAW_IRON.has(nameOf(input.name)))
  // Obtain the missing ingredients where the player is working. A distant
  // station must not pull the bot to the surface between every tunnel step.
  // A confirmed prior deposit only requests inspection; it never creates an
  // ingot or substitutes for observing the actual furnace contents again.
  if (!conflict && !ironOutput) {
    if (!fuelHeld && !fuelPresent && !burning && (rawInside === 0 || fuelExhausted) && (!deposited || last.operation === 'input')) return ore('coal', 1, 2)
    if (!deposited && counts.rawIron < remainingIron) return ore('iron', remainingIron - counts.rawIron, 2)
  }
  const furnaceApproach = approachStation(placedFurnace, 'furnace')
  if (furnaceApproach) return furnaceApproach
  const opened = furnace.window && ['furnace', 2].includes(furnace.window.type) && integer(furnace.window.coordinates) && key(furnace.window.coordinates) === key(placedFurnace.position)
  if (!opened || furnace.needsOpen) return requireAction('open_furnace', result('open_furnace', 'smelting', '確認済みのかまどを開いて中身を取得します。', { target: { ...placedFurnace.position }, requiresLivePreview: true }))
  if (furnace.inventoryUncertain || !furnace.contentsKnown) return wait('smelting', 'furnace_contents_unknown', 'かまどの中身をサーバーから取得するまで待ちます。')
  if (![input, fuel, output].every(value => value?.known === true && Number.isSafeInteger(value.count) && value.count >= 0)) return wait('smelting', 'furnace_slots_unknown', 'かまどの入力・燃料・結果スロットの確定情報を待ちます。')
  if (output.count && nameOf(output.name) === 'iron_ingot') return requireAction('take_furnace_output', result('take_furnace_output', 'iron_ingots', '精錬された鉄を実際の持ち物へ回収します。', { count: Math.min(output.count, 3 - counts.ironIngots), expectedName: 'minecraft:iron_ingot' }), ['furnace'])
  if (output.count || input.count && !RAW_IRON.has(nameOf(input.name))) return requireAction('manage_furnace_contents', result('manage_furnace_contents', 'smelting', '別の材料が入っているため、上書きせず内容を整理する機能が必要です。', { target: { ...placedFurnace.position }, input: { name: input.name, count: input.count }, output: { name: output.name, count: output.count } }))
  if (!fuelHeld && !fuelPresent && !burning && (rawInside === 0 || fuelExhausted)) return ore('coal', 1, 2)
  if (counts.rawIron < remainingIron) return ore('iron', remainingIron - counts.rawIron, 2)
  if (!rawInside && counts.rawIron > 0) {
    const rawItem = items.find(value => RAW_IRON.has(nameOf(value.name)) && amount(value.count))
    return requireAction('put_furnace_input', result('put_furnace_input', 'smelting', '必要な量の鉄原料をかまどへ入れます。', { slot: rawItem.slot, sourceSlot: rawItem.slot, count: Math.min(rawItem.count, 3 - counts.ironIngots) }), ['furnace'])
  }
  if (!fuelPresent && !burning && fuelHeld) return requireAction('put_furnace_fuel', result('put_furnace_fuel', 'smelting', '鉄の精錬用の燃料を入れます。', { slot: fuelHeld.slot, sourceSlot: fuelHeld.slot, count: fuelCount }), ['furnace'])
  // Missing progress metadata is not proof of either a completed smelt or an
  // empty fuel supply. Wait for the actual output slot rather than inventing it.
  return wait('smelting', 'furnace_cooking', 'サーバーの結果スロットに鉄インゴットが現れるまで待ちます。', { expectedName: 'minecraft:iron_ingot', remaining: 3 - counts.ironIngots })
}

module.exports = { nextDiamondAction }
